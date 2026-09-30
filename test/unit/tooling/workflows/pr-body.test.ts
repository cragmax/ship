import { describe, expect, it } from 'vitest';

import type { SliceWork } from '../../../../tooling/workflows/lib/agent-calls.js';
import {
  commitMessage,
  prTitle,
  renderPrBody,
  type LandedIssue,
  type PrBodyInput,
  type ScheduleBlocker,
} from '../../../../tooling/workflows/lib/pr-body.js';

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
      ? {
          verdict: 'hardened',
          sha: 's3',
          survivors: 1,
          summary: 'pinned the bound',
          leaseLines: [],
        }
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

const ELEVEN: LandedIssue = {
  issue: 11,
  commit: 'c11',
  ...work({
    subject: 'wait on a held lease',
    closes: 'fixes',
    leaseLines: [
      'with-lease: waiting for paper@localhost:25701 — held by epic-911/slice-913-1 (pid 1234, since 2026-09-30T18:23:58.961Z, alive): npx vitest run a.test.ts',
      'with-lease: waited 38.9s for paper@localhost:25701, held 27.0s, waited on epic-911/slice-913-1 (pid 1234)',
    ],
  }),
};

const TDD_LEASE = 'with-lease: waited 38.9s for paper@localhost:25701, held 27.0s';
const REVIEW_LEASE = 'with-lease: waited 1.2s for folia@localhost:25711, held 40.3s';
// A wait line is no release line: a role holding only one had no lease to show.
const WAIT_LINE = 'with-lease: waiting for paper@localhost:25701 — held by an unknown holder';

const reviewed = (leaseLines: string[]): SliceWork['testReview'] => ({
  verdict: 'hardened',
  sha: 's3',
  survivors: 1,
  summary: 'pinned the bound',
  leaseLines,
});

const INPUT: PrBodyInput = {
  epic: 1025,
  branch: 'ship/epic-1025',
  reportDir: 'C:/runs/epic-1025/reports',
  landed: [SEVEN, EIGHT],
  unlanded: [
    { issue: 9, outcome: 'blocked', reason: 'planner stale: resolved #9 by abc123' },
    { issue: 10, outcome: 'skipped' },
  ],
  sync: {
    verdict: 'merged',
    commit: 'm1',
    message: 'merged origin/master as m1',
    conflicts: [],
    version: null,
  },
  bump: { ...OK, kind: 'minor', from: '2.42.0', to: '2.43.0', commit: 'b1' },
  masterCheck: {
    passed: true,
    local: { launch: 'l0', current: 'l1', move: 'forward' },
    remote: { launch: 'o0', current: 'o0', move: 'equal' },
  },
  mainUntouched: true,
  critic: {
    outcome: 'landed',
    commit: 'k1',
    findings: [
      { lens: 'duplication', summary: 'two x helpers', applied: true },
      { lens: 'test-gaps', summary: 'no cross-slice test', applied: false },
    ],
  },
  overlap: {
    added: [{ blocker: 7, dependent: 8, confidence: 'likely', reason: 'both edit tooling/x.ts' }],
    sequenced: [],
    areaMap: 'read',
  },
  schedule: [
    {
      issue: 7,
      blockers: [],
      attempts: 1,
      startedAt: '2026-09-29T10:00:00.000Z',
      committedAt: '2026-09-29T10:20:00.000Z',
    },
    {
      issue: 9,
      blockers: [
        { issue: 7, source: 'declared' },
        { issue: 8, source: 'declared' },
      ],
      attempts: 0,
      startedAt: null,
      committedAt: null,
    },
  ],
  leases: {
    engines: [
      { type: 'paper', leases: 2, waitedSeconds: 2, waitedMaxSeconds: 1.5, heldSeconds: 102 },
      { type: 'folia', leases: 0, waitedSeconds: 0, waitedMaxSeconds: 0, heldSeconds: 0 },
    ],
    issues: [{ issue: 7, waitedSeconds: 1.5, heldSeconds: 42 }],
    unparsed: [{ issue: 8, line: 'with-lease: waited ?s' }],
  },
  retro: [
    {
      title: 'slow paper lease',
      evidence: 'reports/tdd-7.md',
      kind: 'genuine',
      suggestion: 'warm a second paper',
    },
  ],
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
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; folia@localhost:25576 waited 0s, held 30.25s',
      '- Lease timings: none',
      '- Probes: no probe needed',
      '  - Folia ticks x: confirmed',
      '- Master sync: merged at m1',
      '- Version bump: minor, 2.42.0 → 2.43.0',
      '- Report dir: `C:/runs/epic-1025/reports`',
      '- see #10 — skipped',
    ]) {
      expect(body.split('\n')).toContain(line);
    }
  });

  it('reports the master sync, the bump, the master check, the main checkout and the report dir as the whole epic end', () => {
    const lines = body.split('\n');

    expect(lines.slice(lines.indexOf('## Epic end') + 1, lines.indexOf('## Critic'))).toEqual([
      '',
      '- Master sync: merged at m1',
      '- Version bump: minor, 2.42.0 → 2.43.0',
      '- Master check: passed — local forward, l0 → l1; origin equal at o0',
      '- Main checkout: untouched since pre-flight',
      '- Report dir: `C:/runs/epic-1025/reports`',
      '',
    ]);
  });

  it.each([
    ['touched', false, '- Main checkout: touched since pre-flight (HEAD or dirtiness changed)'],
    ['not compared', null, '- Main checkout: not compared (a snapshot could not be read)'],
  ])('reports a main checkout that is %s', (_name, mainUntouched, line) => {
    expect(renderPrBody({ ...INPUT, mainUntouched }).split('\n')).toContain(line);
  });

  it('reports the critic, overlap edges, schedule, lease timings and retro after the epic end, in that order', () => {
    const lines = body.split('\n');
    const sections = [
      '## Epic end',
      '## Critic',
      '## Overlap edges',
      '## Schedule',
      '## Lease timings',
      '## Retro findings',
    ].map((heading) => lines.indexOf(heading));

    expect(sections.every((at) => at > -1)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
    for (const line of [
      '- Outcome: landed as k1',
      '- [duplication] two x helpers (applied)',
      '- [test-gaps] no cross-slice test (not applied)',
      '- #7 → #8 (likely): both edit tooling/x.ts',
      '- #7: blockers none; started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1',
      '- #9: blockers #7 (declared), #8 (declared); started never; committed never; attempts 0',
      '- paper: 2 leases, waited 2.0s total (max 1.5s), held 102.0s total',
      '- folia: 0 leases, waited 0.0s total (max 0.0s), held 0.0s total',
      '- #7: waited 1.5s, held 42.0s',
      '- unparsed (#8): with-lease: waited ?s',
      '- slow paper lease (genuine): reports/tdd-7.md — warm a second paper',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it.each<[string, readonly ScheduleBlocker[], string]>([
    ['none', [], '- #9: blockers none; started never; committed never; attempts 0'],
    [
      'one declared',
      [{ issue: 7, source: 'declared' }],
      '- #9: blockers #7 (declared); started never; committed never; attempts 0',
    ],
    [
      'one overlap, likely',
      [{ issue: 7, source: 'overlap', confidence: 'likely' }],
      '- #9: blockers #7 (overlap, likely); started never; committed never; attempts 0',
    ],
    [
      'mixed',
      [
        { issue: 7, source: 'declared' },
        { issue: 8, source: 'overlap', confidence: 'unsure' },
      ],
      '- #9: blockers #7 (declared), #8 (overlap, unsure); started never; committed never; attempts 0',
    ],
  ])('renders a schedule line whose blockers are %s', (_name, blockers, line) => {
    const lines = renderPrBody({
      ...INPUT,
      schedule: [{ issue: 9, blockers, attempts: 0, startedAt: null, committedAt: null }],
    }).split('\n');

    expect(lines[lines.indexOf('## Schedule') + 2]).toBe(line);
  });

  it('renders None. for an empty section and the critic’s other outcomes', () => {
    const lines = renderPrBody({
      ...INPUT,
      critic: { outcome: 'skipped', findings: [] },
      overlap: { added: [], sequenced: [], areaMap: 'read' },
      schedule: [],
      retro: [],
    }).split('\n');

    expect(lines).toContain('- Outcome: skipped — one issue landed');
    for (const heading of ['## Overlap edges', '## Schedule', '## Retro findings']) {
      expect(lines[lines.indexOf(heading) + 2]).toBe('None.');
    }
    expect(
      renderPrBody({ ...INPUT, retro: null })
        .split('\n')
        .includes('- The retro returned nothing.'),
    ).toBe(true);
  });

  it('defuses a closing keyword a retro finding carries, keeping the landed fixes', () => {
    const text = renderPrBody({
      ...INPUT,
      retro: [{ title: 'fixes #9 already', evidence: 'e', kind: 'first-time', suggestion: 's' }],
    });

    expect(text).toContain('fixes (see #9) already');
    expect(text).not.toMatch(closes(9));
    expect(text).toMatch(closes(7));
  });

  it('names the holder a lease waited on in its lease timings', () => {
    expect(renderPrBody({ ...INPUT, landed: [ELEVEN] }).split('\n')).toContain(
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s on epic-911/slice-913-1 (pid 1234), held 27s',
    );
  });

  it.each<[string, string[], SliceWork['testReview'], string]>([
    [
      'the tdd alone',
      [TDD_LEASE],
      reviewed([]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s',
    ],
    [
      'the test review alone',
      [],
      reviewed([REVIEW_LEASE]),
      '- Lease timings: test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    [
      'both roles, tdd first',
      [TDD_LEASE],
      reviewed([REVIEW_LEASE]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    ['neither role', [], reviewed([]), '- Lease timings: none'],
    [
      'a skipped test review',
      [TDD_LEASE],
      null,
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s',
    ],
    [
      'a tdd with only a wait line',
      [WAIT_LINE],
      reviewed([REVIEW_LEASE]),
      '- Lease timings: test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
  ])('renders the lease timings of %s', (_name, tdd, testReview, line) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({ subject: 'lease x', closes: 'fixes', leaseLines: tdd, testReview }),
        },
      ],
    }).split('\n');

    expect(lines.filter((l) => l.startsWith('- Lease timings: '))).toEqual([line]);
  });

  it('records a capped probe with its follow-up', () => {
    expect(body).toContain('  - Paper drops y: cap-hit; follow-up: probe y offline;');
  });

  it('defuses a closing reference in the tier, a critic reason and every reference form', () => {
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
      critic: { outcome: 'dropped', reason: 'land failed: fixed #24 then broke', findings: [] },
    });

    expect(tricky).toMatch(closes(7));
    for (const issue of [21, 24]) expect(tricky).not.toMatch(closes(issue));
    expect(tricky).not.toMatch(/resolves[\s:]*cragmax\/paper-harness#22/i);
    expect(tricky).not.toMatch(
      /closes[\s:]*https:\/\/github\.com\/cragmax\/paper-harness\/issues\/23/i,
    );
    expect(tricky).toContain('(tier: unit, fixes (see #21))');
    expect(tricky.split('\n')).toContain(
      '- Outcome: changes dropped — land failed: fixed (see #24) then broke',
    );
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
