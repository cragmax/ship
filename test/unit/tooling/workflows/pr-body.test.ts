import { describe, expect, it } from 'vitest';

import type {
  ProbeRecord,
  PrWriterOutput,
  SliceWork,
  TddEvidence,
} from '../../../../tooling/workflows/lib/agent-calls.js';
import {
  commitMessage,
  prTitle,
  renderPrBody,
  type LandedIssue,
  type PrBodyInput,
  type ScheduleBlocker,
} from '../../../../tooling/workflows/lib/pr-body.js';

const OK = { exitCode: 0, envelopePath: 'e.json', status: 'ok', errors: [] } as const;

const TRACER: TddEvidence = {
  kind: 'tracer',
  test: 'test/unit/x.test.ts › rejects a stale lease',
  pseudocode: 'lease(stale)\n  → rejects',
  red: 'AssertionError: expected [Function] to throw',
  green: '✓ test/unit/x.test.ts › rejects a stale lease',
  reason: '',
};

const NONE: TddEvidence = {
  kind: 'none',
  test: '',
  pseudocode: '',
  red: '',
  green: '',
  reason: 'docs only',
};

const work = (fields: {
  subject: string;
  closes: 'fixes' | 'see';
  leaseLines?: string[];
  probes?: SliceWork['tdd']['probes'];
  planProbes?: SliceWork['tdd']['probes'];
  diffReview?: SliceWork['diffReview'];
  review?: SliceWork['review'];
  testReview?: SliceWork['testReview'];
  evidence?: TddEvidence;
}): SliceWork => ({
  card: {
    verdict: 'plan',
    planPath: 'p.md',
    summary: 'plan the thing',
    tier: 'server',
    commit: { type: 'feat', scope: 'tools', subject: fields.subject },
    closes: fields.closes,
    evidence: '',
    probes: fields.planProbes ?? [],
  },
  tdd: {
    verdict: 'GREEN',
    sha: 's',
    files: ['src/a.ts'],
    leaseLines: fields.leaseLines ?? [],
    probes: fields.probes ?? [],
    evidence: fields.evidence ?? TRACER,
  },
  diffReview: fields.diffReview ?? { rules: 2, plan: 1, findingsPath: 'd.md' },
  review: fields.review ?? {
    verdict: 'fixed',
    sha: 's2',
    summary: 'renamed a helper',
    leaseLines: [],
  },
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
      { claim: 'Folia ticks x', verdict: 'confirmed', followUp: '', seconds: 42 },
      {
        claim: 'Paper drops y',
        verdict: 'cap-hit',
        followUp: 'probe y offline; closes #13 maybe',
        seconds: 900,
      },
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

const REVIEWER_LEASE = 'with-lease: waited 0.5s for paper@localhost:25702, held 12.5s';

const fixedReview = (leaseLines: string[]): SliceWork['review'] => ({
  verdict: 'fixed',
  sha: 's2',
  summary: 'renamed a helper',
  leaseLines,
});

const PLAN_FALSIFIED: ProbeRecord = {
  claim: 'taskkill /T reaches every hook descendant',
  verdict: 'falsified',
  followUp: '',
  seconds: 664,
};

const PLAN_CAPPED: ProbeRecord = {
  claim: 'git grep -P runs on Windows',
  verdict: 'cap-hit',
  followUp: 'probe grep -P offline',
  seconds: 300,
};

const TDD_CONFIRMED: ProbeRecord = {
  claim: 'Folia ticks x',
  verdict: 'confirmed',
  followUp: '',
  seconds: 42,
};

const WRITER: PrWriterOutput = {
  summary: 'Adds the x tool, then wires y through it.',
  door: 'two-way',
  doorNote: '',
  blastRadius: 'tooling',
  ramifications: '',
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
  sync: {
    verdict: 'merged',
    commit: 'm1',
    upstream: 'o0',
    message: 'merged origin/master as m1',
    conflicts: [],
    version: null,
  },
  bump: { ...OK, kind: 'minor', from: '2.42.0', to: '2.43.0', commit: 'b1' },
  masterCheck: {
    passed: true,
    local: { launch: 'l0', synced: null, current: 'l1', move: 'forward' },
    remote: { launch: 'o0', synced: 'o0', current: 'o0', move: 'equal' },
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
  writer: WRITER,
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
      '## Evidence',
      '## Merge Danger',
      '**Door:** two-way',
      '**Blast Radius:** tooling',
      '## Issues',
      '<details><summary>Run report</summary>',
      '## Landed issues',
      '## Epic end',
      '</details>',
      '### feat(tools): add the x tool',
      '- Issue: #7, landed as c7',
      '- Issue: #8, landed as c8',
      '- Plan: plan the thing (tier: server)',
      '- Review: fixed — renamed a helper',
      '- Test review: hardened, 1 surviving mutants — pinned the bound',
      '- Test review: skipped — trivial surface',
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; folia@localhost:25576 waited 0s, held 30.25s',
      '- Lease timings: none',
      '- Probes: no probe needed',
      '  - tdd: Folia ticks x: confirmed in 42s',
      '- Master sync: merged at m1',
      '- Version bump: minor, 2.42.0 → 2.43.0',
      '- Report dir: `C:/runs/epic-1025/reports`',
      '- see #10 — not landed: skipped',
      '- Epic: see #1025',
      '- fixes #7 — add the x tool',
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
      '- Master check: passed — local forward, l0 → l1; origin equal at o0, checked against synced o0',
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

    const fold = text.slice(text.indexOf('<details>'), text.indexOf('</details>'));

    expect(text).toContain('fixes (see #9) already');
    expect(text).not.toMatch(closes(9));
    expect(text).toMatch(closes(7));
    expect(fold).toContain('fixes (see #9) already');
    expect(text.split('\n')).toContain('- fixes #7 — add the x tool');
    expect(fold).not.toMatch(closes(7));
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

  it.each<[string, string[], string[], SliceWork['testReview'], string]>([
    [
      'all three roles, the review between',
      [TDD_LEASE],
      [REVIEWER_LEASE],
      reviewed([REVIEW_LEASE]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; review: paper@localhost:25702 waited 0.5s, held 12.5s; test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    [
      'a reviewer that leased nothing',
      [TDD_LEASE],
      [],
      reviewed([REVIEW_LEASE]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    [
      'the review alone',
      [],
      [REVIEWER_LEASE],
      reviewed([]),
      '- Lease timings: review: paper@localhost:25702 waited 0.5s, held 12.5s',
    ],
    [
      'a review before a skipped test review',
      [TDD_LEASE],
      [REVIEWER_LEASE],
      null,
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; review: paper@localhost:25702 waited 0.5s, held 12.5s',
    ],
  ])('renders the review’s lease timings for %s', (_name, tdd, review, testReview, line) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({
            subject: 'lease x',
            closes: 'fixes',
            leaseLines: tdd,
            review: fixedReview(review),
            testReview,
          }),
        },
      ],
    }).split('\n');

    expect(lines.filter((l) => l.startsWith('- Lease timings: '))).toEqual([line]);
  });

  it('records a capped probe with its follow-up', () => {
    expect(body).toContain(
      '  - tdd: Paper drops y: cap-hit in 15m 00s; follow-up: probe y offline;',
    );
  });

  it.each<[string, ProbeRecord[], ProbeRecord[], string[]]>([
    [
      'the plan’s alone',
      [PLAN_FALSIFIED],
      [],
      ['- Probes:', '  - plan: taskkill /T reaches every hook descendant: falsified in 11m 04s'],
    ],
    [
      'the plan’s before the tdd’s',
      [PLAN_FALSIFIED, PLAN_CAPPED],
      [TDD_CONFIRMED],
      [
        '- Probes:',
        '  - plan: taskkill /T reaches every hook descendant: falsified in 11m 04s',
        '  - plan: git grep -P runs on Windows: cap-hit in 5m 00s; follow-up: probe grep -P offline',
        '  - tdd: Folia ticks x: confirmed in 42s',
      ],
    ],
    [
      'the tdd’s alone',
      [],
      [TDD_CONFIRMED],
      ['- Probes:', '  - tdd: Folia ticks x: confirmed in 42s'],
    ],
    ['neither', [], [], ['- Probes: no probe needed']],
  ])('renders the probe lines of %s', (_name, planProbes, probes, expected) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({ subject: 'probe x', closes: 'fixes', planProbes, probes }),
        },
      ],
    }).split('\n');
    const at = lines.findIndex((l) => l.startsWith('- Probes'));

    expect(lines.slice(at, at + expected.length + 1)).toEqual([...expected, '']);
  });

  it.each<[number, string]>([
    [59, '59s'],
    [60, '1m 00s'],
    [119, '1m 59s'],
    [664, '11m 04s'],
  ])('renders a probe of %s seconds as %s', (seconds, text) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({
            subject: 'probe x',
            closes: 'fixes',
            probes: [{ ...TDD_CONFIRMED, seconds }],
          }),
        },
      ],
    }).split('\n');

    expect(lines).toContain(`  - tdd: Folia ticks x: confirmed in ${text}`);
  });

  it.each<[number, number, string]>([
    [3, 0, '- Diff review: 3 rules, 0 plan findings'],
    [0, 5, '- Diff review: 0 rules, 5 plan findings'],
  ])(
    'renders a diff review of %s rules and %s plan findings between the plan and the review',
    (rules, plan, line) => {
      const lines = renderPrBody({
        ...INPUT,
        landed: [
          {
            issue: 11,
            commit: 'c11',
            ...work({
              subject: 'review x',
              closes: 'fixes',
              diffReview: { rules, plan, findingsPath: 'd.md' },
            }),
          },
        ],
      }).split('\n');
      const at = lines.indexOf('- Plan: plan the thing (tier: server)');

      expect(lines.slice(at, at + 3)).toEqual([
        '- Plan: plan the thing (tier: server)',
        line,
        '- Review: fixed — renamed a helper',
      ]);
    },
  );

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

const landedWith = (evidence: TddEvidence): PrBodyInput => ({
  ...INPUT,
  landed: [{ issue: 11, commit: 'c11', ...work({ subject: 'x', closes: 'fixes', evidence }) }],
});

// From the Evidence heading through the Merge Danger heading after it.
const evidenceLines = (input: PrBodyInput): string[] => {
  const lines = renderPrBody(input).split('\n');
  return lines.slice(lines.indexOf('## Evidence'), lines.indexOf('## Merge Danger') + 1);
};

describe('renderPrBody — evidence', () => {
  it('renders a complete tracer as its test, its pseudocode fenced, then Before and After', () => {
    expect(evidenceLines(landedWith(TRACER))).toEqual([
      '## Evidence',
      '',
      '- **#11** `test/unit/x.test.ts › rejects a stale lease`',
      '  ```text',
      '  lease(stale)',
      '    → rejects',
      '  ```',
      '  **Before:** AssertionError: expected [Function] to throw',
      '  **After:** ✓ test/unit/x.test.ts › rejects a stale lease',
      '',
      '## Merge Danger',
    ]);
  });

  it('renders one bullet per landed issue, from its own evidence, in landing order', () => {
    const landed = [SEVEN, { ...EIGHT, tdd: { ...EIGHT.tdd, evidence: NONE } }];

    expect(
      renderPrBody({ ...INPUT, landed })
        .split('\n')
        .filter((l) => l.startsWith('- **#')),
    ).toEqual([
      '- **#7** `test/unit/x.test.ts › rejects a stale lease`',
      '- **#8** no red-green — docs only',
    ]);
  });

  it('renders a none as no red-green and its reason', () => {
    expect(evidenceLines(landedWith(NONE))).toEqual([
      '## Evidence',
      '',
      '- **#11** no red-green — docs only',
      '',
      '## Merge Danger',
    ]);
  });

  it('ignores a tracer’s reason', () => {
    expect(evidenceLines(landedWith({ ...TRACER, reason: 'docs only' }))).toEqual([
      '## Evidence',
      '',
      '- **#11** `test/unit/x.test.ts › rejects a stale lease`',
      '  ```text',
      '  lease(stale)',
      '    → rejects',
      '  ```',
      '  **Before:** AssertionError: expected [Function] to throw',
      '  **After:** ✓ test/unit/x.test.ts › rejects a stale lease',
      '',
      '## Merge Danger',
    ]);
  });

  it('ignores a none’s test, pseudocode, red and green', () => {
    expect(evidenceLines(landedWith({ ...TRACER, kind: 'none', reason: 'docs only' }))).toEqual([
      '## Evidence',
      '',
      '- **#11** no red-green — docs only',
      '',
      '## Merge Danger',
    ]);
  });

  it.each<[string, TddEvidence]>([
    ['an empty test', { ...TRACER, test: '' }],
    ['a blank test', { ...TRACER, test: '  ' }],
    ['an empty red', { ...TRACER, red: '' }],
    ['a whitespace-only red', { ...TRACER, red: '\n  \n' }],
    ['an empty green', { ...TRACER, green: '' }],
    ['a whitespace-only green', { ...TRACER, green: ' \n\t' }],
  ])('renders a tracer with %s as evidence incomplete', (_name, evidence) => {
    expect(evidenceLines(landedWith(evidence))).toEqual([
      '## Evidence',
      '',
      '- **#11** evidence incomplete',
      '',
      '## Merge Danger',
    ]);
  });

  it.each<[string, TddEvidence]>([
    ['an empty reason', { ...NONE, reason: '' }],
    ['a blank reason', { ...NONE, reason: ' \n ' }],
  ])('renders a none with %s as no reason given', (_name, evidence) => {
    expect(evidenceLines(landedWith(evidence))).toEqual([
      '## Evidence',
      '',
      '- **#11** no red-green — no reason given',
      '',
      '## Merge Danger',
    ]);
  });

  it.each([
    ['empty', ''],
    ['blank', ' \n'],
  ])('renders a tracer with %s pseudocode without a fence', (_name, pseudocode) => {
    expect(evidenceLines(landedWith({ ...TRACER, pseudocode }))).toEqual([
      '## Evidence',
      '',
      '- **#11** `test/unit/x.test.ts › rejects a stale lease`',
      '  **Before:** AssertionError: expected [Function] to throw',
      '  **After:** ✓ test/unit/x.test.ts › rejects a stale lease',
      '',
      '## Merge Danger',
    ]);
  });

  it('drops the pseudocode’s trailing blank lines from its fence', () => {
    expect(
      evidenceLines(landedWith({ ...TRACER, pseudocode: 'lease(stale)\n  → rejects\n\n  \n' })),
    ).toEqual([
      '## Evidence',
      '',
      '- **#11** `test/unit/x.test.ts › rejects a stale lease`',
      '  ```text',
      '  lease(stale)',
      '    → rejects',
      '  ```',
      '  **Before:** AssertionError: expected [Function] to throw',
      '  **After:** ✓ test/unit/x.test.ts › rejects a stale lease',
      '',
      '## Merge Danger',
    ]);
  });

  it('splits a CRLF pseudocode into its lines, leaving no carriage return', () => {
    expect(
      evidenceLines(landedWith({ ...TRACER, pseudocode: 'lease(stale)\r\n  → rejects\r\n' })),
    ).toEqual([
      '## Evidence',
      '',
      '- **#11** `test/unit/x.test.ts › rejects a stale lease`',
      '  ```text',
      '  lease(stale)',
      '    → rejects',
      '  ```',
      '  **Before:** AssertionError: expected [Function] to throw',
      '  **After:** ✓ test/unit/x.test.ts › rejects a stale lease',
      '',
      '## Merge Danger',
    ]);
  });

  it.each<[string, number]>([
    ['f(x)', 3],
    ['f(`x`)', 3],
    ['a `` b', 3],
    ['print ```js', 4],
    ['x\n`````\ny', 6],
  ])('fences the pseudocode %j in %i backticks', (pseudocode, length) => {
    const fence = '`'.repeat(length);
    const lines = renderPrBody(landedWith({ ...TRACER, pseudocode })).split('\n');
    const bullet = lines.findIndex((l) => l.startsWith('- **#11** '));
    const before = lines.findIndex((l) => l.startsWith('  **Before:** '));

    expect(lines[bullet + 1]).toBe(`  ${fence}text`);
    expect(lines[before - 1]).toBe(`  ${fence}`);
  });

  // A single-backtick span closes at the name's first backtick; this repo's test names often carry one.
  it.each<[string, string]>([
    ['x › shadows `bot`', '- **#11** `` x › shadows `bot` ``'],
    ['x › a `` b', '- **#11** ``` x › a `` b ```'],
    ['`bot` first', '- **#11** `` `bot` first ``'],
  ])('spans the test %j in a backtick run its own cannot close', (test, line) => {
    expect(renderPrBody(landedWith({ ...TRACER, test })).split('\n')).toContain(line);
  });

  it.each<[string, TddEvidence, string]>([
    [
      'red',
      { ...TRACER, red: 'AssertionError: expected 1\r\n    to be 2\n' },
      '  **Before:** AssertionError: expected 1 to be 2',
    ],
    ['green', { ...TRACER, green: '\n ✓ adds x\n\n  (1 test)' }, '  **After:** ✓ adds x (1 test)'],
    [
      'none reason',
      { ...NONE, reason: 'docs only\n  no code' },
      '- **#11** no red-green — docs only no code',
    ],
  ])('collapses a multi-line %s to one line', (_name, evidence, line) => {
    expect(renderPrBody(landedWith(evidence)).split('\n')).toContain(line);
  });

  it('defuses a closing keyword the tdd’s evidence carries', () => {
    const body = renderPrBody(
      landedWith({ ...TRACER, red: 'AssertionError: fixes #9 not applied' }),
    );

    expect(body.split('\n')).toContain('  **Before:** AssertionError: fixes (see #9) not applied');
    expect(body).not.toMatch(closes(9));
  });
});

describe('renderPrBody — issues list', () => {
  it('cites the epic, then each landed issue by its subject, then each unlanded one', () => {
    const lines = renderPrBody(INPUT).split('\n');
    const at = lines.indexOf('## Issues');

    expect(lines.slice(at, at + 8)).toEqual([
      '## Issues',
      '',
      '- Epic: see #1025',
      '- fixes #7 — add the x tool',
      '- see #8 — wire y — fixes (see #12) in passing (its acceptance needs a human)',
      '- see #9 — not landed: blocked: planner stale: resolved (see #9) by abc123',
      '- see #10 — not landed: skipped',
      '',
    ]);
  });

  it('names an explicit list instead of an epic', () => {
    const body = renderPrBody({ ...INPUT, epic: null });
    const lines = body.split('\n');

    expect(lines[lines.indexOf('## Issues') + 2]).toBe('- An explicit issue list');
    expect(body).not.toContain('#1025');
  });
});

// A closing keyword before any #N, as GitHub reads one.
const ANY_CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]*#\d+/i;

const OPENER = '<details><summary>Run report</summary>';

describe('renderPrBody — the fold', () => {
  const body = renderPrBody(INPUT);
  const lines = body.split('\n');

  it('leads with the Summary, the Evidence, the Merge Danger and the Issues list, folding the run report after them', () => {
    const at = [
      '## Summary',
      '## Evidence',
      '## Merge Danger',
      '## Issues',
      OPENER,
      '## Landed issues',
      '## Epic end',
      '## Critic',
      '## Overlap edges',
      '## Schedule',
      '## Lease timings',
      '## Retro findings',
      '</details>',
    ].map((line) => lines.indexOf(line));
    const open = lines.indexOf(OPENER);
    const close = lines.indexOf('</details>');
    const sections = lines.flatMap((l, i) =>
      l.startsWith('### ') || l.startsWith('- Issue: ') ? [i] : [],
    );

    expect(lines[0]).toBe('## Summary');
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(lines[open - 1]).toBe('');
    expect(lines.slice(open + 1, open + 3)).toEqual(['', '## Landed issues']);
    expect(body.endsWith('\n\n</details>\n')).toBe(true);
    expect(sections).toHaveLength(4);
    expect(sections.every((i) => i > open && i < close)).toBe(true);
    expect(lines).not.toContain('## Not landed');
    expect(lines.filter((l) => l.startsWith('Unattended run on'))).toEqual([]);
  });

  it('writes no closing keyword inside the fold', () => {
    const fold = body.slice(body.indexOf('<details>'), body.indexOf('</details>'));

    expect(fold).not.toMatch(ANY_CLOSING);
    expect(fold.split('\n')).toContain('- Issue: #7, landed as c7');
    expect(fold.split('\n')).toContain('- Issue: #8, landed as c8');
  });
});

// From the first line through the Evidence heading.
const summaryOf = (writer: PrWriterOutput | null): string[] => {
  const lines = renderPrBody({ ...INPUT, writer }).split('\n');
  return lines.slice(0, lines.indexOf('## Evidence') + 1);
};

// From the Merge Danger heading through the Issues heading after it.
const dangerOf = (writer: PrWriterOutput | null): string[] => {
  const lines = renderPrBody({ ...INPUT, writer }).split('\n');
  return lines.slice(lines.indexOf('## Merge Danger'), lines.indexOf('## Issues') + 1);
};

describe('renderPrBody — the PR writer’s sections', () => {
  it('leads with the PR writer’s summary', () => {
    expect(summaryOf(WRITER)).toEqual([
      '## Summary',
      '',
      'Adds the x tool, then wires y through it.',
      '',
      '## Evidence',
    ]);
  });

  it('renders a multi-line summary line for line, dropping its blank lines at either end', () => {
    expect(
      summaryOf({ ...WRITER, summary: '\n  \nAdds x.\r\n\r\n```text\n  x()\n```\n \n' }),
    ).toEqual(['## Summary', '', 'Adds x.', '', '```text', '  x()', '```', '', '## Evidence']);
  });

  it('keeps the indentation of the summary’s first non-blank line', () => {
    expect(summaryOf({ ...WRITER, summary: '\n    npx x\nRuns x.\n' })).toEqual([
      '## Summary',
      '',
      '    npx x',
      'Runs x.',
      '',
      '## Evidence',
    ]);
  });

  it('drops CRLF blank lines at the start of the summary', () => {
    expect(summaryOf({ ...WRITER, summary: '\r\n \r\nAdds x.' })).toEqual([
      '## Summary',
      '',
      'Adds x.',
      '',
      '## Evidence',
    ]);
  });

  it.each([
    ['empty', ''],
    ['blank', ' \n\t'],
  ])('renders a %s summary as None.', (_name, summary) => {
    expect(summaryOf({ ...WRITER, summary })).toEqual([
      '## Summary',
      '',
      'None.',
      '',
      '## Evidence',
    ]);
  });

  const NEITHER = [
    '## Merge Danger',
    '',
    '**Door:** two-way',
    '',
    '**Blast Radius:** tooling',
    '',
    '## Issues',
  ];

  it.each<[string, PrWriterOutput, string[]]>([
    [
      'a door note and ramifications',
      {
        ...WRITER,
        door: 'one-way',
        doorNote: 'Drops the v1 envelope.',
        ramifications: 'Old run reports stop parsing.',
      },
      [
        '## Merge Danger',
        '',
        '**Door:** one-way',
        '',
        'Drops the v1 envelope.',
        '',
        '**Blast Radius:** tooling',
        '',
        'Old run reports stop parsing.',
        '',
        '## Issues',
      ],
    ],
    [
      'a door note alone',
      { ...WRITER, doorNote: 'Drops the v1 envelope.' },
      [
        '## Merge Danger',
        '',
        '**Door:** two-way',
        '',
        'Drops the v1 envelope.',
        '',
        '**Blast Radius:** tooling',
        '',
        '## Issues',
      ],
    ],
    [
      'ramifications alone',
      { ...WRITER, ramifications: 'Old run reports stop parsing.' },
      [
        '## Merge Danger',
        '',
        '**Door:** two-way',
        '',
        '**Blast Radius:** tooling',
        '',
        'Old run reports stop parsing.',
        '',
        '## Issues',
      ],
    ],
    ['neither', WRITER, NEITHER],
    [
      'blank ones and a padded blast radius',
      { ...WRITER, doorNote: ' \n', ramifications: '\n\t', blastRadius: ' tooling\n' },
      NEITHER,
    ],
    [
      'a multi-line door note',
      { ...WRITER, doorNote: 'Drops the v1 envelope.\r\nNo reader is left.\n' },
      [
        '## Merge Danger',
        '',
        '**Door:** two-way',
        '',
        'Drops the v1 envelope.',
        'No reader is left.',
        '',
        '**Blast Radius:** tooling',
        '',
        '## Issues',
      ],
    ],
  ])('renders the merge danger of %s', (_name, writer, expected) => {
    expect(dangerOf(writer)).toEqual(expected);
  });

  it('falls back in both sections when the PR writer returned nothing', () => {
    expect(summaryOf(null)).toEqual([
      '## Summary',
      '',
      'Summary unavailable — the PR writer returned nothing',
      '',
      '## Evidence',
    ]);
    expect(dangerOf(null)).toEqual([
      '## Merge Danger',
      '',
      'Unavailable — the PR writer returned nothing',
      '',
      '## Issues',
    ]);
  });

  it('leaves the run report unfolded when the PR writer returned nothing', () => {
    const w = renderPrBody({ ...INPUT, writer: null });
    const lines = w.split('\n');
    const at = lines.indexOf('## Landed issues');

    expect(lines.filter((l) => l.includes('details'))).toEqual([]);
    expect(lines.slice(at - 2, at + 1)).toEqual([
      '- see #10 — not landed: skipped',
      '',
      '## Landed issues',
    ]);
    expect(
      w.endsWith('\n- slow paper lease (genuine): reports/tdd-7.md — warm a second paper\n'),
    ).toBe(true);
  });

  it.each<'summary' | 'doorNote' | 'ramifications'>(['summary', 'doorNote', 'ramifications'])(
    'defuses a closing keyword in the PR writer’s %s',
    (field) => {
      const body = renderPrBody({
        ...INPUT,
        writer: { ...WRITER, [field]: 'Also fixes #9 in passing.' },
      });

      expect(body.split('\n')).toContain('Also fixes (see #9) in passing.');
      expect(body).not.toMatch(closes(9));
      expect(body).toMatch(closes(7));
    },
  );
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
