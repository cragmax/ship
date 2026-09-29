import { describe, expect, it } from 'vitest';

import type { SliceWork } from '../../../../tooling/workflows/lib/agent-calls.js';
import {
  commitMessage,
  prTitle,
  renderPrBody,
  type LandedIssue,
  type PrBodyInput,
} from '../../../../tooling/workflows/lib/pr-body.js';
import type { ServerTierOutput } from '../../../../tooling/workflows/lib/tool-calls.js';

const OK = { exitCode: 0, envelopePath: 'e.json', status: 'ok', errors: [] } as const;

const work = (fields: {
  subject: string;
  closes: 'fixes' | 'see';
  leaseLines?: string[];
  probes?: SliceWork['tdd']['probes'];
  testReview?: SliceWork['testReview'];
}): SliceWork => ({
  card: {
    verdict: 'plan',
    planPath: 'p.md',
    summary: 'plan the thing',
    tier: 'server',
    commit: { type: 'feat', scope: 'tools', subject: fields.subject },
    closes: fields.closes,
    evidence: '',
  },
  tdd: {
    verdict: 'GREEN',
    sha: 's',
    files: ['src/a.ts'],
    leaseLines: fields.leaseLines ?? [],
    probes: fields.probes ?? [],
  },
  review: { verdict: 'fixed', sha: 's2', summary: 'renamed a helper' },
  testReview:
    fields.testReview === undefined
      ? { verdict: 'hardened', sha: 's3', survivors: 1, summary: 'pinned the bound' }
      : fields.testReview,
});

const SEVEN: LandedIssue = {
  issue: 7,
  commit: 'c7',
  ...work({
    subject: 'add the x tool',
    closes: 'fixes',
    leaseLines: [
      'noise before',
      'with-lease: waited 1.5s for paper@localhost:25575, held 42s',
      'with-lease: waited 0s for folia@localhost:25576, held 30.25s',
    ],
  }),
};

const EIGHT: LandedIssue = {
  issue: 8,
  commit: 'c8',
  ...work({
    subject: 'wire y — fixes #12 in passing',
    closes: 'see',
    probes: [
      { claim: 'Folia ticks x', verdict: 'confirmed', followUp: '' },
      { claim: 'Paper drops y', verdict: 'cap-hit', followUp: 'probe y offline; closes #13 maybe' },
    ],
    testReview: null,
  }),
};

const FOLIA_RED: ServerTierOutput = {
  ...OK,
  status: 'failed',
  engine: 'folia',
  errors: [{ step: 'tests', message: '2 tests failed' }],
  tests: { passed: 10, failed: 2, skipped: 0 },
  lease: null,
};

const INPUT: PrBodyInput = {
  epic: 1025,
  branch: 'ship/epic-1025',
  reportDir: 'C:/runs/epic-1025/reports',
  landed: [SEVEN, EIGHT],
  unlanded: [
    { issue: 9, outcome: 'blocked', reason: 'planner stale: resolved #9 by abc123' },
    { issue: 10, outcome: 'skipped' },
  ],
  serverTier: [
    {
      engine: 'paper',
      out: {
        ...OK,
        engine: 'paper',
        tests: { passed: 12, failed: 0, skipped: 1 },
        lease: { type: 'paper', endpoint: 'localhost:25575', waitedSeconds: 2, heldSeconds: 90 },
      },
    },
    { engine: 'folia', out: FOLIA_RED },
  ],
  sync: { verdict: 'merged', commit: 'm1', message: 'merged origin/master as m1' },
  bump: { ...OK, kind: 'minor', from: '2.42.0', to: '2.43.0', commit: 'b1' },
};

/**
 * A closing keyword before `#<issue>`, as GitHub reads one.
 *
 * @param issue - The issue.
 * @returns The pattern.
 */
const closes = (issue: number): RegExp =>
  new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\\s:]*#${String(issue)}\\b`, 'i');

describe('commitMessage', () => {
  it('writes the subject line, fixes #N and the model-neutral trailer', () => {
    expect(
      commitMessage(7, {
        commit: { type: 'feat', scope: 'tools', subject: 'add x' },
        closes: 'fixes',
      }),
    ).toBe('feat(tools): add x\n\nfixes #7\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  });

  it('cites see #N for an issue whose acceptance needs a human', () => {
    expect(
      commitMessage(7, { commit: { type: 'fix', scope: 'engine', subject: 'y' }, closes: 'see' }),
    ).toBe('fix(engine): y\n\nsee #7\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  });

  it('defuses a closing keyword the planner put in the subject', () => {
    const message = commitMessage(7, {
      commit: { type: 'fix', scope: 'engine', subject: 'Fixes: #3 crash, resolved#4' },
      closes: 'fixes',
    });

    expect(message).not.toMatch(closes(3));
    expect(message).not.toMatch(closes(4));
    expect(message).toMatch(closes(7));
  });
});

describe('prTitle', () => {
  it('takes the one landed issue’s subject line', () => {
    expect(prTitle({ branch: 'ship/7', landed: [SEVEN] })).toBe('feat(tools): add the x tool');
  });

  it('counts the issues when several landed', () => {
    expect(prTitle({ branch: 'ship/epic-1025', landed: [SEVEN, EIGHT] })).toBe(
      'ship/epic-1025: 2 issues',
    );
  });
});

describe('renderPrBody', () => {
  const body = renderPrBody(INPUT);

  it('closes only the landed issue whose card says fixes', () => {
    expect(body).toMatch(closes(7));
    for (const issue of [8, 9, 10, 12, 13, 1025]) expect(body).not.toMatch(closes(issue));
  });

  it('cites every other issue and the epic see #N', () => {
    for (const issue of [8, 9, 10, 1025]) expect(body).toContain(`see #${String(issue)}`);
  });

  it('has every required section', () => {
    for (const line of [
      '## Summary',
      'Unattended run on `ship/epic-1025` — see #1025.',
      '## Issues',
      '## Not landed',
      '## Epic end',
      '### feat(tools): add the x tool',
      '- Issue: fixes #7, landed as c7',
      '- Issue: see #8 (its acceptance needs a human), landed as c8',
      '- Plan: plan the thing (tier: server)',
      '- Review: fixed — renamed a helper',
      '- Test review: hardened, 1 surviving mutants — pinned the bound',
      '- Test review: skipped — trivial surface',
      '- Lease timings: paper@localhost:25575 waited 1.5s, held 42s; folia@localhost:25576 waited 0s, held 30.25s',
      '- Lease timings: none',
      '- Probes: no probe needed',
      '  - Folia ticks x: confirmed',
      '- Server tier, paper: 12 passed, 0 failed, 1 skipped; lease paper@localhost:25575 waited 2s, held 90s',
      '- Server tier, folia: 10 passed, 2 failed, 0 skipped — failed: 2 tests failed; lease none',
      '- Master sync: merged at m1',
      '- Version bump: minor, 2.42.0 → 2.43.0',
      '- Report dir: `C:/runs/epic-1025/reports`',
      '- see #10 — skipped',
    ]) {
      expect(body.split('\n')).toContain(line);
    }
  });

  it('records a capped probe with its follow-up', () => {
    expect(body).toContain('  - Paper drops y: cap-hit; follow-up: probe y offline;');
  });

  it('defuses a closing reference in the tier, a tool error and every reference form', () => {
    const tricky = renderPrBody({
      ...INPUT,
      landed: [
        {
          ...SEVEN,
          card: {
            ...SEVEN.card,
            tier: 'unit, fixes #21',
            summary:
              'resolves cragmax/paper-harness#22, closes https://github.com/cragmax/paper-harness/issues/23',
          },
        },
      ],
      serverTier: [
        {
          engine: 'folia',
          out: { ...FOLIA_RED, errors: [{ step: 'tests', message: 'fixed #24 then broke' }] },
        },
      ],
    });

    expect(tricky).toMatch(closes(7));
    for (const issue of [21, 24]) expect(tricky).not.toMatch(closes(issue));
    expect(tricky).not.toMatch(/resolves[\s:]*cragmax\/paper-harness#22/i);
    expect(tricky).not.toMatch(
      /closes[\s:]*https:\/\/github\.com\/cragmax\/paper-harness\/issues\/23/i,
    );
    expect(tricky).toContain('(tier: unit, fixes (see #21))');
    expect(tricky).toContain('failed: fixed (see #24) then broke');
  });
});

describe('prTitle and commitMessage scrub the whole subject line', () => {
  it('defuses a closing reference the planner put in the scope', () => {
    const commit = { type: 'fix', scope: 'closes #5', subject: 'y' };

    expect(
      prTitle({ branch: 'ship/7', landed: [{ ...SEVEN, card: { ...SEVEN.card, commit } }] }),
    ).toBe('fix(closes (see #5)): y');
    expect(commitMessage(7, { commit, closes: 'fixes' })).not.toMatch(closes(5));
  });
});
