import { describe, expect, it } from 'vitest';

import type {
  ProbeRecord,
  PrWriterOutput,
  SliceWork,
  TddEvidence,
} from '../../../src/workflow/calls/agent-calls.js';
import {
  commitMessage,
  fitPrBody,
  prTitle,
  renderAttachedReport,
  renderAttachedSection,
  renderBlockedComment,
  renderPrBody,
  type AttachedSectionInput,
  type LandedIssue,
  type PrBodyInput,
  type ScheduleBlocker,
  type SliceSize,
} from '../../../src/workflow/pr/pr-body.js';

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
  specReview?: SliceWork['specReview'];
  testReview?: SliceWork['testReview'];
  standardsReview?: SliceWork['standardsReview'];
  evidence?: TddEvidence;
  recorded?: SliceWork['tdd']['recorded'];
}): SliceWork => ({
  tdd: {
    verdict: 'GREEN',
    sha: 's',
    files: ['src/a.ts'],
    greenTests: [],
    leaseLines: fields.leaseLines ?? [],
    probes: fields.probes ?? [],
    evidence: fields.evidence ?? TRACER,
    recorded: fields.recorded ?? [],
    commit: { type: 'feat', scope: 'tools', subject: fields.subject },
    closes: fields.closes,
  },
  specReview: fields.specReview ?? {
    verdict: 'fixed',
    sha: 's1s',
    summary: 'covered criterion 3',
    leaseLines: [],
  },
  testReview: fields.testReview ?? {
    verdict: 'clean',
    sha: 's1s',
    summary: 'every claim killed',
    leaseLines: [],
  },
  standardsReview: fields.standardsReview ?? {
    verdict: 'fixed',
    sha: 's2',
    summary: 'renamed a helper',
    leaseLines: [],
  },
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

const specReviewed = (leaseLines: string[]): SliceWork['specReview'] => ({
  verdict: 'fixed',
  sha: 's1s',
  summary: 'covered criterion 3',
  leaseLines,
});

const STANDARDS_LEASE = 'with-lease: waited 0.5s for paper@localhost:25702, held 12.5s';
const TEST_LEASE = 'with-lease: waited 2.5s for folia@localhost:25712, held 33.0s';

const fixedReview = (leaseLines: string[]): SliceWork['standardsReview'] => ({
  verdict: 'fixed',
  sha: 's2',
  summary: 'renamed a helper',
  leaseLines,
});

const FALSIFIED: ProbeRecord = {
  claim: 'taskkill /T reaches every hook descendant',
  verdict: 'falsified',
  followUp: '',
  seconds: 664,
};

const CONFIRMED: ProbeRecord = {
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
    { issue: 9, outcome: 'blocked', reason: 'tdd BLOCKED: resolved #9 by abc123' },
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
  masterCheck: {
    passed: true,
    local: { launch: 'l0', synced: null, current: 'l1', move: 'forward' },
    remote: { launch: 'o0', synced: 'o0', current: 'o0', move: 'equal' },
  },
  mainUntouched: true,
  pushed: { kind: 'resolved', paths: ['src/a.ts', 'tooling/x.ts'] },
  epicReview: {
    verdict: 'accepted-with-open-items',
    profiled: false,
    answer: {
      verdict: 'accepted-with-open-items',
      summary: 'every criterion met, one duplication open',
      criteria: [
        { issue: 7, criterion: 'adds x', state: 'met', evidence: 'tooling/x.ts:1' },
        { issue: 8, criterion: 'wires y', state: 'met', evidence: 'tooling/y.ts:2' },
      ],
      findings: [
        {
          view: 'duplication',
          severity: 'judgement',
          summary: 'two x helpers',
          source: 'tooling/x.ts:3',
        },
      ],
      unchecked: [],
    },
  },
  overlap: {
    added: [{ blocker: 7, dependent: 8, reason: 'both edit tooling/x.ts' }],
    sequenced: [],
    unsure: [],
    areaMap: 'read',
  },
  schedule: [
    {
      issue: 7,
      blockers: [],
      attempts: 1,
      startedAt: '2026-09-29T10:00:00.000Z',
      committedAt: '2026-09-29T10:20:00.000Z',
      size: { files: 2, lines: 40 },
      deaths: [],
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
      size: null,
      deaths: [],
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

/** A closing keyword before `#<issue>`, as GitHub reads one. */
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

  it('defuses a closing keyword the tdd put in the subject', () => {
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

  it('closes only the landed issue whose tdd says fixes', () => {
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
      '- Spec review: fixed — covered criterion 3',
      '- Standards review: fixed — renamed a helper',
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; folia@localhost:25576 waited 0s, held 30.25s',
      '- Lease timings: none',
      '- Probes: no probe needed',
      '  - Folia ticks x: confirmed in 42s',
      '- Master sync: merged at m1',
      '- Report dir: `C:/runs/epic-1025/reports`',
      '- see #10 — not landed: skipped',
      '- Epic: see #1025',
      '- fixes #7 — add the x tool',
    ]) {
      expect(body.split('\n')).toContain(line);
    }
  });

  it('reports the master sync, the master check, the main checkout and the report dir as the whole epic end, no version line', () => {
    const lines = body.split('\n');

    expect(
      lines.slice(lines.indexOf('## Epic end') + 1, lines.indexOf('## Overlap edges')),
    ).toEqual([
      '',
      '- Master sync: merged at m1',
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

  it('reports the overlap edges, schedule, lease timings and retro after the epic end, in that order', () => {
    const lines = body.split('\n');
    const sections = [
      '## Epic end',
      '## Overlap edges',
      '## Schedule',
      '## Lease timings',
      '## Retro findings',
    ].map((heading) => lines.indexOf(heading));

    expect(sections.every((at) => at > -1)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);

    for (const line of [
      '- #7 → #8: both edit tooling/x.ts',
      '- #7: blockers none; started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1; size 2 files, 40 lines',
      '- #9: blockers #7 (declared), #8 (declared); started never; committed never; attempts 0; size none',
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
    ['none', [], '- #9: blockers none; started never; committed never; attempts 0; size none'],
    [
      'one declared',
      [{ issue: 7, source: 'declared' }],
      '- #9: blockers #7 (declared); started never; committed never; attempts 0; size none',
    ],
    [
      'one overlap',
      [{ issue: 7, source: 'overlap' }],
      '- #9: blockers #7 (overlap); started never; committed never; attempts 0; size none',
    ],
    [
      'mixed, the overlap one released',
      [
        { issue: 7, source: 'declared' },
        { issue: 8, source: 'overlap', released: 'blocked' },
      ],
      '- #9: blockers #7 (declared), #8 (overlap, released: blocked); started never; committed never; attempts 0; size none',
    ],
  ])('renders a schedule line whose blockers are %s', (_name, blockers, line) => {
    const lines = renderPrBody({
      ...INPUT,
      schedule: [
        {
          issue: 9,
          blockers,
          attempts: 0,
          startedAt: null,
          committedAt: null,
          size: null,
          deaths: [],
        },
      ],
    }).split('\n');

    expect(lines[lines.indexOf('## Schedule') + 2]).toBe(line);
  });

  // Hand-written: the landed slice's size, at the line's end.
  it.each<[string, SliceSize | null, string]>([
    ['landed', { files: 23, lines: 912 }, 'size 23 files, 912 lines'],
    ['not landed', null, 'size none'],
  ])('ends a schedule line with the slice’s size when it %s', (_name, size, tail) => {
    const lines = renderPrBody({
      ...INPUT,
      schedule: [
        {
          issue: 9,
          blockers: [],
          attempts: 1,
          startedAt: '2026-09-29T10:00:00.000Z',
          committedAt: size === null ? null : '2026-09-29T10:20:00.000Z',
          size,
          deaths: [],
        },
      ],
    }).split('\n');

    expect(lines[lines.indexOf('## Schedule') + 2]?.endsWith(`; attempts 1; ${tail}`)).toBe(true);
  });

  it('ends a schedule line with each of the issue’s deaths', () => {
    const lines = renderPrBody({
      ...INPUT,
      schedule: [
        {
          issue: 9,
          blockers: [],
          attempts: 2,
          startedAt: '2026-09-29T10:00:00.000Z',
          committedAt: null,
          size: null,
          deaths: [
            { attempt: 1, stage: 'spec-review', cause: 'returned nothing' },
            { attempt: 2, stage: 'tdd', cause: 'answered no object: API Error: 529' },
          ],
        },
      ],
    }).split('\n');

    expect(lines[lines.indexOf('## Schedule') + 2]).toBe(
      '- #9: blockers none; started 2026-09-29T10:00:00.000Z; committed never; attempts 2; size none; died attempt 1 at spec-review (returned nothing), attempt 2 at tdd (answered no object: API Error: 529)',
    );
  });

  it('renders None. for an empty section', () => {
    const lines = renderPrBody({
      ...INPUT,
      overlap: { added: [], sequenced: [], unsure: [], areaMap: 'read' },
      schedule: [],
      retro: [],
    }).split('\n');

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

  it.each<[string, string[], SliceWork['specReview'], string]>([
    [
      'the tdd alone',
      [TDD_LEASE],
      specReviewed([]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s',
    ],
    [
      'the spec review alone',
      [],
      specReviewed([REVIEW_LEASE]),
      '- Lease timings: spec-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    [
      'both roles, tdd first',
      [TDD_LEASE],
      specReviewed([REVIEW_LEASE]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; spec-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    ['neither role', [], specReviewed([]), '- Lease timings: none'],
    [
      'a tdd with only a wait line',
      [WAIT_LINE],
      specReviewed([REVIEW_LEASE]),
      '- Lease timings: spec-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
  ])('renders the lease timings of %s', (_name, tdd, specReview, line) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({ subject: 'lease x', closes: 'fixes', leaseLines: tdd, specReview }),
        },
      ],
    }).split('\n');

    expect(lines.filter((l) => l.startsWith('- Lease timings: '))).toEqual([line]);
  });

  it.each<[string, string[], string[], SliceWork['specReview'], string]>([
    [
      'all three roles, the standards review last',
      [TDD_LEASE],
      [STANDARDS_LEASE],
      specReviewed([REVIEW_LEASE]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; spec-review: folia@localhost:25711 waited 1.2s, held 40.3s; standards-review: paper@localhost:25702 waited 0.5s, held 12.5s',
    ],
    [
      'a standards review that leased nothing',
      [TDD_LEASE],
      [],
      specReviewed([REVIEW_LEASE]),
      '- Lease timings: tdd: paper@localhost:25701 waited 38.9s, held 27s; spec-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ],
    [
      'the standards review alone',
      [],
      [STANDARDS_LEASE],
      specReviewed([]),
      '- Lease timings: standards-review: paper@localhost:25702 waited 0.5s, held 12.5s',
    ],
  ])(
    'renders the standards review’s lease timings for %s',
    (_name, tdd, review, specReview, line) => {
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
              standardsReview: fixedReview(review),
              specReview,
            }),
          },
        ],
      }).split('\n');

      expect(lines.filter((l) => l.startsWith('- Lease timings: '))).toEqual([line]);
    },
  );

  it('records a capped probe with its follow-up', () => {
    expect(body).toContain('  - Paper drops y: cap-hit in 15m 00s; follow-up: probe y offline;');
  });

  it.each<[string, ProbeRecord[], string[]]>([
    ['one', [CONFIRMED], ['- Probes:', '  - Folia ticks x: confirmed in 42s']],
    [
      'several, in the tdd’s order',
      [FALSIFIED, CONFIRMED],
      [
        '- Probes:',
        '  - taskkill /T reaches every hook descendant: falsified in 11m 04s',
        '  - Folia ticks x: confirmed in 42s',
      ],
    ],
    ['none', [], ['- Probes: no probe needed']],
  ])('renders the probe lines of %s', (_name, probes, expected) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({ subject: 'probe x', closes: 'fixes', probes }),
        },
      ],
    }).split('\n');
    const at = lines.findIndex((l) => l.startsWith('- Probes'));

    expect(lines.slice(at, at + expected.length + 1)).toEqual([...expected, '']);
  });

  it('renders a landed issue with no plan line', () => {
    expect(body).not.toMatch(/^- Plan: /m);
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
            probes: [{ ...CONFIRMED, seconds }],
          }),
        },
      ],
    }).split('\n');

    expect(lines).toContain(`  - Folia ticks x: confirmed in ${text}`);
  });

  it('renders the spec review, then the test review, then the standards review, right after the issue line', () => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({
            subject: 'review x',
            closes: 'fixes',
            specReview: { verdict: 'clean', sha: 's1', summary: 'all met', leaseLines: [] },
          }),
        },
      ],
    }).split('\n');
    const at = lines.indexOf('- Issue: #11, landed as c11');

    expect(lines.slice(at, at + 4)).toEqual([
      '- Issue: #11, landed as c11',
      '- Spec review: clean — all met',
      '- Test review: clean — every claim killed',
      '- Standards review: fixed — renamed a helper',
    ]);
  });

  it.each<[string, SliceWork['testReview'], string]>([
    ['a fixed one', fixedReview([]), '- Test review: fixed — renamed a helper'],
    [
      'one skipped on a trivial surface',
      'trivial surface',
      '- Test review: skipped — trivial surface',
    ],
    ['one skipped as comment-only', 'comment-only', '- Test review: skipped — comment-only'],
  ])('renders the test review line of %s', (_name, testReview, line) => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({ subject: 'review x', closes: 'fixes', testReview }),
        },
      ],
    }).split('\n');

    expect(lines.filter((l) => l.startsWith('- Test review: '))).toEqual([line]);
  });

  it('renders the test review’s lease timings between the spec and the standards review’s', () => {
    const lines = renderPrBody({
      ...INPUT,
      landed: [
        {
          issue: 11,
          commit: 'c11',
          ...work({
            subject: 'lease x',
            closes: 'fixes',
            specReview: specReviewed([REVIEW_LEASE]),
            testReview: fixedReview([TEST_LEASE]),
            standardsReview: fixedReview([STANDARDS_LEASE]),
          }),
        },
      ],
    }).split('\n');

    expect(lines.filter((l) => l.startsWith('- Lease timings: '))).toEqual([
      '- Lease timings: spec-review: folia@localhost:25711 waited 1.2s, held 40.3s; test-review: folia@localhost:25712 waited 2.5s, held 33s; standards-review: paper@localhost:25702 waited 0.5s, held 12.5s',
    ]);
  });

  it('defuses a closing reference in a review summary, an epic review finding and every reference form', () => {
    const tricky = renderPrBody({
      ...INPUT,
      landed: [
        {
          ...SEVEN,
          standardsReview: { ...SEVEN.standardsReview, summary: 'renamed, fixes #21' },
        },
        {
          ...EIGHT,
          specReview: {
            ...EIGHT.specReview,
            summary:
              'resolves cragmax/paper-harness#22, closes https://github.com/cragmax/paper-harness/issues/23',
          },
        },
      ],
      epicReview: {
        ...INPUT.epicReview,
        notRun: 'fixed #24 then broke',
      },
    });

    expect(tricky).toMatch(closes(7));
    for (const issue of [21, 24]) expect(tricky).not.toMatch(closes(issue));
    expect(tricky).not.toMatch(/resolves[\s:]*cragmax\/paper-harness#22/i);
    expect(tricky).not.toMatch(
      /closes[\s:]*https:\/\/github\.com\/cragmax\/paper-harness\/issues\/23/i,
    );
    expect(tricky).toContain('renamed, fixes (see #21)');
    expect(tricky.split('\n')).toContain('- Not run: fixed (see #24) then broke');
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

  // A single-backtick span closes at the name's first backtick,
  // and this repo's test names often carry one.
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
      '- see #9 — not landed: blocked: tdd BLOCKED: resolved (see #9) by abc123',
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

  it('leads with the Epic review, the Summary, the Evidence, the Merge Danger, the Tests at push and the Issues list, folding the run report after them', () => {
    const at = [
      '## Epic review',
      '## Summary',
      '## Evidence',
      '## Merge Danger',
      '## Tests at push',
      '## Issues',
      OPENER,
      '## Landed issues',
      '## Epic end',
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

    expect(lines[0]).toBe('## Epic review');
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

  // A null writer leaves the run report unfolded, out of the fold-only check's reach.
  it.each<[string, PrWriterOutput | null]>([
    ['folded', WRITER],
    ['left unfolded', null],
  ])('writes a closing keyword only in the Issues list, the run report %s', (_name, writer) => {
    const lines = renderPrBody({ ...INPUT, writer }).split('\n');

    expect(lines.filter((l) => ANY_CLOSING.test(l))).toEqual(['- fixes #7 — add the x tool']);
  });
});

// From the first line through the Evidence heading.
const summaryOf = (writer: PrWriterOutput | null): string[] => {
  const lines = renderPrBody({ ...INPUT, writer }).split('\n');

  return lines.slice(lines.indexOf('## Summary'), lines.indexOf('## Evidence') + 1);
};

// From the Merge Danger heading through the Tests at push heading after it.
const dangerOf = (writer: PrWriterOutput | null): string[] => {
  const lines = renderPrBody({ ...INPUT, writer }).split('\n');

  return lines.slice(lines.indexOf('## Merge Danger'), lines.indexOf('## Tests at push') + 1);
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
    '## Tests at push',
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
        '## Tests at push',
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
        '## Tests at push',
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
        '## Tests at push',
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
        '## Tests at push',
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
      '## Tests at push',
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

/** A body's section from its heading up to the blank line ending it, none when absent. */
const sectionOf = (body: string, heading: string): string[] => {
  const lines = body.split('\n');
  const at = lines.indexOf(heading);

  return at === -1 ? [] : lines.slice(at, lines.indexOf('', at + 2));
};

describe('renderPrBody — recorded', () => {
  it('lists each recorded value under its issue, leaving an issue that recorded none out', () => {
    const body = renderPrBody({
      ...INPUT,
      landed: [
        { ...SEVEN, tdd: { ...SEVEN.tdd, recorded: ['a', 'b'] } },
        { ...EIGHT, tdd: { ...EIGHT.tdd, recorded: [] } },
      ],
    });

    expect(sectionOf(body, '## Recorded')).toEqual([
      '## Recorded',
      '',
      '- #7',
      '  - `a`',
      '  - `b`',
    ]);
  });

  it('renders no Recorded section when no landed issue recorded anything', () => {
    expect(renderPrBody(INPUT).split('\n')).not.toContain('## Recorded');
  });

  it('drops blank entries, and an issue whose entries are all blank', () => {
    const body = renderPrBody({
      ...INPUT,
      landed: [
        { ...SEVEN, tdd: { ...SEVEN.tdd, recorded: ['', '  \n  '] } },
        { ...EIGHT, tdd: { ...EIGHT.tdd, recorded: [] } },
      ],
    });

    expect(sectionOf(body, '## Recorded')).toEqual([]);
  });

  it('renders an entry on one line in a code span, its closing keyword defused', () => {
    const body = renderPrBody({
      ...INPUT,
      landed: [
        {
          ...SEVEN,
          tdd: {
            ...SEVEN.tdd,
            recorded: ['**42** files in `src/` @cragmax; fixes #12\nper top-level dir'],
          },
        },
        EIGHT,
      ],
    });

    expect(sectionOf(body, '## Recorded')).toEqual([
      '## Recorded',
      '',
      '- #7',
      '  - `` **42** files in `src/` @cragmax; fixes (see #12) per top-level dir ``',
    ]);
    expect(body).not.toMatch(closes(12));
  });
});

describe('prTitle and commitMessage scrub the whole subject line', () => {
  it('defuses a closing reference the tdd put in the scope', () => {
    const commit = { type: 'fix', scope: 'closes #5', subject: 'y' };

    expect(
      prTitle({ branch: 'ship/7', landed: [{ ...SEVEN, tdd: { ...SEVEN.tdd, commit } }] }),
    ).toBe('fix(closes (see #5)): y');
    expect(commitMessage(7, { commit, closes: 'fixes' })).not.toMatch(closes(5));
  });
});

const ISSUES = Array.from({ length: 29 }, (_, i) => i + 1);

const cliqueInput = (reason: (blocker: number, dependent: number) => string): PrBodyInput => ({
  ...INPUT,
  landed: ISSUES.map((issue) => ({
    issue,
    commit: `c${String(issue)}`,
    ...work({ subject: `trim the comments of area ${String(issue)}`, closes: 'fixes' }),
  })),
  unlanded: [],
  overlap: {
    added: ISSUES.flatMap((blocker) =>
      ISSUES.filter((dependent) => dependent > blocker).map((dependent) => ({
        blocker,
        dependent,
        reason: reason(blocker, dependent),
      })),
    ),
    sequenced: [],
    unsure: [],
    areaMap: 'read',
  },
  schedule: ISSUES.map((issue) => ({
    issue,
    blockers: ISSUES.filter((b) => b < issue).map((b) => ({
      issue: b,
      source: 'overlap' as const,
    })),
    attempts: 1,
    startedAt: '2026-09-29T10:00:00.000Z',
    committedAt: '2026-09-29T10:20:00.000Z',
    size: { files: 2, lines: 40 },
    deaths: [],
  })),
});

const pointer = (file: string): string =>
  `Moved to a PR comment: the body was over GitHub's 65536-character limit. Also in \`${INPUT.reportDir}/${file}\`.`;

describe('fitPrBody', () => {
  // Distinct, padded reasons, so no grouping of the 406 edges can shrink the section.
  // Retro evidence with an unlanded and a landed closing keyword: the moved text is neutralised.
  const BIG: PrBodyInput = {
    ...cliqueInput((b, d) =>
      `both edit tooling/area-${String(b)}-${String(d)}.ts`.padEnd(120, '.'),
    ),
    retro: [{ title: 'gate', evidence: 'fixed #99; fixes #1', kind: 'genuine', suggestion: 's' }],
  };

  it('fits a 29-issue fully overlapping run within the limit, moving the bulky sections and losing nothing', () => {
    const whole = renderPrBody(BIG);
    expect(whole.length).toBeGreaterThan(65_536);

    const fitted = fitPrBody(BIG);

    expect(fitted.body.length).toBeLessThanOrEqual(65_536);
    expect(fitted.comments.map((c) => c.file)).toEqual([
      'pr-comment-overlap-edges.md',
      'pr-comment-schedule.md',
      'pr-comment-retro-findings.md',
    ]);
    const headings = ['## Overlap edges', '## Schedule', '## Retro findings'];
    fitted.comments.forEach((c, i) => {
      expect(c.text.length).toBeLessThanOrEqual(65_536);
      expect(whole).toContain(c.text);
      expect(c.text.split('\n')[0]).toBe(headings[i]);
    });
    expect(fitted.comments[2]?.text).toContain('- gate (genuine): fixed (see #99); fixes #1 — s');
    expect(fitted.body.split('\n')).toEqual(
      expect.arrayContaining([
        pointer('pr-comment-overlap-edges.md'),
        pointer('pr-comment-schedule.md'),
        pointer('pr-comment-retro-findings.md'),
      ]),
    );
    const kept = new Set(
      [fitted.body, ...fitted.comments.map((c) => c.text)].join('\n').split('\n'),
    );

    expect(whole.split('\n').filter((line) => !kept.has(line))).toEqual([]);
  });

  it('returns a body the move cannot fit as it is, the sections still moved', () => {
    const reason = 'r'.repeat(70_000);

    const fitted = fitPrBody({ ...INPUT, unlanded: [{ issue: 9, outcome: 'blocked', reason }] });

    expect(fitted.body.length).toBeGreaterThan(65_536);
    expect(fitted.body).toContain(reason);
    expect(fitted.comments.map((c) => c.file)).toEqual([
      'pr-comment-overlap-edges.md',
      'pr-comment-schedule.md',
      'pr-comment-retro-findings.md',
    ]);
  });

  it('moves nothing from a body within the limit', () => {
    expect(fitPrBody(INPUT)).toEqual({ body: renderPrBody(INPUT), comments: [] });
  });

  it('moves nothing from a body of exactly the limit, and moves from one character over', () => {
    const padded = (n: number): PrBodyInput => ({
      ...INPUT,
      retro: [{ title: 'pad', evidence: 'e'.repeat(n), kind: 'genuine', suggestion: 's' }],
    });
    const fill = 65_536 - renderPrBody(padded(0)).length;
    expect(renderPrBody(padded(fill))).toHaveLength(65_536);

    expect(fitPrBody(padded(fill)).comments).toEqual([]);
    expect(fitPrBody(padded(fill + 1)).comments.map((c) => c.file)).toEqual([
      'pr-comment-overlap-edges.md',
      'pr-comment-schedule.md',
      'pr-comment-retro-findings.md',
    ]);
  });

  it('moves the unsure overlap pairs section after the overlap edges', () => {
    const input = { ...BIG, overlap: { ...BIG.overlap, unsure: UNSURE } };

    const fitted = fitPrBody(input);

    expect(fitted.comments.map((c) => c.file)).toEqual([
      'pr-comment-overlap-edges.md',
      'pr-comment-unsure-overlap-pairs.md',
      'pr-comment-schedule.md',
      'pr-comment-retro-findings.md',
    ]);
    expect(fitted.comments[1]?.text).toBe(
      [
        '## Unsure overlap pairs',
        '',
        '- #9 and #8, reported, not ordered; shared `src/a.ts`, `src/b.ts`: both in the engine area',
        '- #8 and #7, reported, not ordered: both touch the run report',
        '',
      ].join('\n'),
    );
    const lines = fitted.body.split('\n');
    const at = lines.indexOf('## Unsure overlap pairs');
    expect(lines.slice(at, at + 3)).toEqual([
      '## Unsure overlap pairs',
      '',
      pointer('pr-comment-unsure-overlap-pairs.md'),
    ]);
  });

  it('keeps an empty movable section in the body', () => {
    const fitted = fitPrBody({
      ...BIG,
      overlap: { ...BIG.overlap, added: [] },
      retro: [{ title: 'big', evidence: 'e'.repeat(70_000), kind: 'genuine', suggestion: 's' }],
    });

    expect(fitted.comments.map((c) => c.file)).toEqual([
      'pr-comment-schedule.md',
      'pr-comment-retro-findings.md',
    ]);
    const lines = fitted.body.split('\n');
    const at = lines.indexOf('## Overlap edges');
    expect(lines.slice(at, at + 3)).toEqual(['## Overlap edges', '', 'None.']);
  });
});

describe('renderPrBody — tests at push', () => {
  /** The body's `## Tests at push` section, heading to the blank line after its one line. */
  const testsAtPush = (input: PrBodyInput): string[] => {
    const lines = renderPrBody(input).split('\n');
    const at = lines.indexOf('## Tests at push');

    return lines.slice(at, at + 4);
  };

  it('says the full tiers ran at push, naming each Platform-wide path the push changes', () => {
    const pushed = {
      kind: 'resolved',
      paths: ['package.json', 'ph-plugin/src/Main.java', 'src/a.ts', 'test/helpers/x.ts'],
    } as const;

    expect(testsAtPush({ ...INPUT, pushed })).toEqual([
      '## Tests at push',
      '',
      'The full standalone and server tiers ran at push: the Platform-wide paths `package.json`, `ph-plugin/src/Main.java`, `test/helpers/x.ts` changed.',
      '',
    ]);
  });

  it('says targeted tests only, the full server tier left to the nightly, when no Platform-wide path changed', () => {
    expect(testsAtPush(INPUT)).toEqual([
      '## Tests at push',
      '',
      'Targeted tests only at push: no Platform-wide path changed; the full server tier runs in the next nightly after merge.',
      '',
    ]);
  });

  it('says the full standalone tier ran, the server tier left to the nightly, past 300 changed files', () => {
    const paths = Array.from({ length: 301 }, (_, i) => `src/f${String(i)}.ts`);

    expect(testsAtPush({ ...INPUT, pushed: { kind: 'resolved', paths } })).toEqual([
      '## Tests at push',
      '',
      'The full standalone tier ran at push: 301 files changed, past the 300 `vitest related` takes; the full server tier runs in the next nightly after merge.',
      '',
    ]);
  });

  it('says targeted tests only at exactly 300 changed files', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `src/f${String(i)}.ts`);

    expect(testsAtPush({ ...INPUT, pushed: { kind: 'resolved', paths } })[2]).toBe(
      'Targeted tests only at push: no Platform-wide path changed; the full server tier runs in the next nightly after merge.',
    );
  });

  it('says it is not known, naming the failed read, when the pushed range was not read', () => {
    const pushed = { kind: 'unresolved', why: 'changed-files failed: bad revision' } as const;

    expect(testsAtPush({ ...INPUT, pushed })).toEqual([
      '## Tests at push',
      '',
      'Not known: the pushed range could not be read (changed-files failed: bad revision).',
      '',
    ]);
  });
});

describe('renderPrBody — overlap edges', () => {
  const overlapSection = (input: PrBodyInput): string[] => {
    const lines = renderPrBody(input).split('\n');
    const from = lines.indexOf('## Overlap edges') + 1;
    const to = lines.findIndex((line, i) => i > from && line.startsWith('## '));

    return lines.slice(from, to).filter((line) => line !== '');
  };

  it('groups a blocker’s edges sharing a reason into one line, so a 29-issue clique fits', () => {
    const clique = cliqueInput(() => 'both trim comments');

    const lines = overlapSection(clique);

    expect(lines).toHaveLength(28);
    expect(lines[0]).toBe(
      '- #1 → #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26, #27, #28, #29: both trim comments',
    );
    expect(lines[27]).toBe('- #28 → #29: both trim comments');
    expect(fitPrBody(clique).comments).toEqual([]);
  });

  it('groups by blocker and reason, in edge order', () => {
    const edge = (blocker: number, dependent: number, reason: string) => ({
      blocker,
      dependent,
      reason,
    });

    const lines = overlapSection({
      ...INPUT,
      overlap: {
        ...INPUT.overlap,
        added: [edge(7, 8, 'a'), edge(7, 9, 'b'), edge(7, 10, 'a'), edge(8, 9, 'a')],
      },
    });

    expect(lines).toEqual(['- #7 → #8, #10: a', '- #7 → #9: b', '- #8 → #9: a']);
  });
});

const UNSURE: PrBodyInput['overlap']['unsure'] = [
  { a: 9, b: 8, shared: ['src/a.ts', 'src/b.ts'], reason: 'both in the engine area' },
  { a: 8, b: 7, shared: [], reason: 'both touch the run report' },
];

describe('renderPrBody — unsure overlap pairs', () => {
  it('lists each unsure pair between the overlap edges and the schedule, in record order', () => {
    const lines = renderPrBody({ ...INPUT, overlap: { ...INPUT.overlap, unsure: UNSURE } }).split(
      '\n',
    );
    const at = lines.indexOf('## Unsure overlap pairs');

    expect(lines.slice(at, at + 5)).toEqual([
      '## Unsure overlap pairs',
      '',
      '- #9 and #8, reported, not ordered; shared `src/a.ts`, `src/b.ts`: both in the engine area',
      '- #8 and #7, reported, not ordered: both touch the run report',
      '',
    ]);
    expect(lines.indexOf('## Overlap edges')).toBeLessThan(at);
    expect(lines.indexOf('## Schedule')).toBe(at + 5);
  });

  it('leaves the section out when no pair is unsure', () => {
    expect(renderPrBody(INPUT).split('\n')).not.toContain('## Unsure overlap pairs');
  });

  it('keeps a multi-line reason on its pair’s one bullet', () => {
    const unsure = [
      { a: 8, b: 7, shared: [], reason: 'both touch the run report\n- and preflight' },
    ];

    const lines = renderPrBody({ ...INPUT, overlap: { ...INPUT.overlap, unsure } }).split('\n');

    const at = lines.indexOf('## Unsure overlap pairs');
    expect(lines.slice(at, at + 4)).toEqual([
      '## Unsure overlap pairs',
      '',
      '- #8 and #7, reported, not ordered: both touch the run report - and preflight',
      '',
    ]);
  });
});

describe('renderAttachedSection', () => {
  // INPUT's writer is spread in and ignored: an attached run has none.
  const SECTION_INPUT: AttachedSectionInput = {
    ...INPUT,
    epic: null,
    epicReview: { ...INPUT.epicReview, profiled: true },
    run: 2,
    reportComment: 'https://github.com/o/r/pull/9#issuecomment-1',
  };

  it('heads the section with the run, then its epic review, its Evidence, its Issues and a link to its run report', () => {
    const text = renderAttachedSection(SECTION_INPUT);
    const lines = text.split('\n');
    const main = renderPrBody(INPUT).split('\n');

    expect(lines.slice(0, 5)).toEqual([
      '## Attached run 2',
      '',
      '### Epic review',
      '',
      '**Verdict:** accepted-with-open-items (profiled)',
    ]);
    const evidence = lines.indexOf('### Evidence');
    expect(lines[evidence + 2]).toBe('- **#7** `test/unit/x.test.ts › rejects a stale lease`');
    expect(
      lines.slice(lines.indexOf('### Evidence') + 2, lines.indexOf('### Tests at push') - 1),
    ).toEqual(main.slice(main.indexOf('## Evidence') + 2, main.indexOf('## Merge Danger') - 1));
    expect(lines.slice(lines.indexOf('### Issues'))).toEqual([
      '### Issues',
      '',
      '- fixes #7 — add the x tool',
      '- see #8 — wire y — fixes (see #12) in passing (its acceptance needs a human)',
      '- see #9 — not landed: blocked: tdd BLOCKED: resolved (see #9) by abc123',
      '- see #10 — not landed: skipped',
      '',
      'Run report: [PR comment](https://github.com/o/r/pull/9#issuecomment-1)',
      '',
    ]);
    expect(lines.filter((l) => l.includes('details'))).toEqual([]);
    expect(lines).not.toContain('## Landed issues');
    expect(lines).not.toContain('## Summary');
    expect(lines).not.toContain('## Merge Danger');
    expect(lines).not.toContain('- An explicit issue list');
  });

  it('says what pre-push ran on this run’s push under ### Tests at push, between its Evidence and its Issues', () => {
    const lines = renderAttachedSection({
      ...SECTION_INPUT,
      pushed: { kind: 'resolved', paths: ['src/rcon/client.ts', 'tooling/x.ts'] },
    }).split('\n');

    expect(lines.slice(lines.indexOf('### Issues') - 4, lines.indexOf('### Issues'))).toEqual([
      '### Tests at push',
      '',
      'The full standalone and server tiers ran at push: the Platform-wide paths `src/rcon/client.ts` changed.',
      '',
    ]);
  });

  it('lists this run’s recorded values under ### Recorded between its Issues and the run-report line', () => {
    const lines = renderAttachedSection({
      ...SECTION_INPUT,
      landed: [{ ...SEVEN, tdd: { ...SEVEN.tdd, recorded: ['a'] } }],
      unlanded: [],
    }).split('\n');

    expect(lines.slice(lines.indexOf('### Issues'))).toEqual([
      '### Issues',
      '',
      '- fixes #7 — add the x tool',
      '',
      '### Recorded',
      '',
      '- #7',
      '  - `a`',
      '',
      'Run report: [PR comment](https://github.com/o/r/pull/9#issuecomment-1)',
      '',
    ]);
  });

  it('names the report dir when the run report was not posted', () => {
    const text = renderAttachedSection({ ...SECTION_INPUT, reportComment: null });

    expect(
      text.endsWith('\nRun report: not posted to this PR; it is in `C:/runs/epic-1025/reports`.\n'),
    ).toBe(true);
    expect(text).not.toContain('details');
  });

  it('closes only this run’s landed fixes issues, defusing every other keyword in the section', () => {
    const text = renderAttachedSection({
      ...SECTION_INPUT,
      reportComment: null,
      landed: [
        SEVEN,
        {
          ...EIGHT,
          tdd: {
            ...EIGHT.tdd,
            evidence: { ...TRACER, red: 'AssertionError: fixes #3 not applied' },
          },
        },
      ],
    });

    expect(text.split('\n').filter((l) => ANY_CLOSING.test(l))).toEqual([
      '- fixes #7 — add the x tool',
    ]);
    // Issue 3 stands for an earlier run's landed issue.
    expect(text).toContain('  **Before:** AssertionError: fixes (see #3) not applied');
  });
});

describe('renderAttachedReport', () => {
  const REPORT_INPUT = { ...INPUT, epic: null, run: 2 };

  it('is the run report folded under the attached run’s summary', () => {
    const text = renderAttachedReport(REPORT_INPUT);
    const lines = text.split('\n');
    const unfolded = renderPrBody({ ...INPUT, writer: null }).split('\n');

    expect(lines[0]).toBe('<details><summary>Run report — attached run 2</summary>');
    expect(lines[1]).toBe('');
    expect(lines.slice(2, lines.indexOf('</details>'))).toEqual(
      unfolded.slice(unfolded.indexOf('## Landed issues')),
    );
    expect(text.endsWith('\n\n</details>\n')).toBe(true);
    expect(lines.filter((l) => l.includes('details'))).toHaveLength(2);
  });

  it('lists the unsure overlap pairs', () => {
    const text = renderAttachedReport({
      ...REPORT_INPUT,
      overlap: { ...INPUT.overlap, unsure: UNSURE },
    });

    expect(text.split('\n')).toContain(
      '- #8 and #7, reported, not ordered: both touch the run report',
    );
  });

  it('defuses every closing keyword, this run’s landed fixes issue included', () => {
    const text = renderAttachedReport({
      ...REPORT_INPUT,
      retro: [
        {
          title: 'fixes #7 already',
          evidence: 'closes #8',
          kind: 'first-time',
          suggestion: 'fixes #3 too',
        },
      ],
    });

    expect(text.split('\n').filter((l) => ANY_CLOSING.test(l))).toEqual([]);
    expect(text).toContain('fixes (see #7) already');
    expect(text).toContain('closes (see #8)');
    expect(text).toContain('fixes (see #3) too');
  });
});

describe('renderBlockedComment', () => {
  const BLOCKED = {
    issue: 7,
    reason: 'tdd BLOCKED: the issue names a missing symbol',
    branch: 'ship/epic-9',
    reportDir: 'C:/r/reports',
  };

  it('quotes that the run changed nothing, states the reason, then names the PR and the report dir', () => {
    expect(renderBlockedComment({ ...BLOCKED, pr: 12 }).split('\n')).toEqual([
      '> *Posted by an unattended `/ship` run. It changed nothing on this issue; the labels stand.*',
      '',
      '**Not landed: blocked.** tdd BLOCKED: the issue names a missing symbol',
      '',
      'Run: PR #12. Report dir: `C:/r/reports`.',
      '',
    ]);
  });

  it('names the branch and no pull request when the run opened none', () => {
    expect(renderBlockedComment(BLOCKED)).toContain(
      'Run: branch `ship/epic-9`, no pull request. Report dir: `C:/r/reports`.',
    );
  });

  it('names only the kept tdd report when the attempt kept no patch', () => {
    const kept = { patch: null, report: 'C:/main/reports/kept/slice-7-1/tdd-7-1.md' };

    expect(renderBlockedComment({ ...BLOCKED, pr: 12, kept })).toContain(
      'Run: PR #12. Kept: tdd report `C:/main/reports/kept/slice-7-1/tdd-7-1.md`.',
    );
  });

  it('says no reason was recorded when the report carries none', () => {
    const noReason = { issue: BLOCKED.issue, branch: BLOCKED.branch, reportDir: BLOCKED.reportDir };

    expect(renderBlockedComment(noReason)).toContain('**Not landed: blocked.** no reason recorded');
  });

  it('defuses a closing keyword in the reason, so the comment closes nothing', () => {
    const text = renderBlockedComment({
      ...BLOCKED,
      reason: 'tdd BLOCKED: fixes #8 would be undone',
    });

    expect(text.split('\n').filter((l) => ANY_CLOSING.test(l))).toEqual([]);
    expect(text).toContain('fixes (see #8) would be undone');
  });
});
