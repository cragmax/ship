import { describe, expect, it } from 'vitest';

import { runShip } from '../../../src/workflow/ship.js';

import {
  fakeHooks,
  GATE_OK,
  liveRuns,
  readyVerdict,
  TDD_BLOCKED,
  type FakeRun,
} from './_fake-hooks.js';
import { epicRun } from './_fake-parallel.js';

/** The gate and issue-readiness answers of an explicit list of 7 and 8, no declared edge. */
const SEVEN_EIGHT = {
  'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }], edges: [] },
  issueReadiness: {
    issues: [7, 8].map((issue) => readyVerdict(issue)),
  },
};

const REASON = 'both edit tooling/x.ts';

/**
 * An issue-overlap answer naming the given pairs.
 *
 * @param pairs - Each pair's endpoints, confidence and shared paths (default `tooling/x.ts`).
 * @returns The answer.
 */
const estimate = (
  ...pairs: readonly {
    a: number;
    b: number;
    confidence: 'likely' | 'unsure';
    shared?: readonly string[];
  }[]
): unknown => ({
  issues: [],
  pairs: pairs.map(({ shared = ['tooling/x.ts'], ...p }) => ({ ...p, shared, reason: REASON })),
  liveOverlaps: [],
  areaMap: 'read',
});

const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

/** A call's prompt lines; fails the test when there is no such call. */
const promptLines = (run: FakeRun, label: string): string[] => {
  const call = run.calls.find((c) => c.label === label);
  expect(call, `a ${label} call`).toBeDefined();

  return call?.prompt.split('\n') ?? [];
};

describe('runShip — the overlap estimate', () => {
  it('asks no issue-overlap for a one-issue run with no live run', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(labels(run)).not.toContain('issueOverlap');
    expect(report).toMatchObject({
      status: 'preflight-ok',
      overlap: { added: [], sequenced: [], areaMap: 'read' },
    });
  });

  it('merges a likely pair into the graph as an edge and records it with its reason', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 8, b: 7, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8 --preflight-only');

    expect(report).toMatchObject({
      status: 'preflight-ok',
      graph: { runSet: [{ epic: null, issues: [7, 8] }], edges: [{ blocker: 7, dependent: 8 }] },
      overlap: {
        added: [{ blocker: 7, dependent: 8, reason: REASON }],
        sequenced: [],
        areaMap: 'read',
      },
    });
  });

  it('adds no edge for a pair whose only shared path is eslint-suppressions.json', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({
        a: 7,
        b: 8,
        confidence: 'likely',
        shared: ['eslint-suppressions.json'],
      }),
    });

    const report = await runShip(run.hooks, 'issues 7 8 --preflight-only');

    expect(report).toMatchObject({
      status: 'preflight-ok',
      graph: { runSet: [{ epic: null, issues: [7, 8] }], edges: [] },
      overlap: { added: [], sequenced: [], areaMap: 'read' },
    });
  });

  it.each([
    ['eslint-suppressions.json and a code file', ['eslint-suppressions.json', 'tooling/x.ts']],
    ['no path', []],
  ])('keeps the edge of a pair sharing %s', async (_name, shared) => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely', shared }),
    });

    const report = await runShip(run.hooks, 'issues 7 8 --preflight-only');

    expect(report.overlap).toEqual({
      added: [{ blocker: 7, dependent: 8, reason: REASON }],
      sequenced: [],
      unsure: [],
      areaMap: 'read',
    });
  });

  it('starts the dependent of an overlap edge only once its blocker committed', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(run.timeline.indexOf('log fed committed #7')).toBeGreaterThan(-1);
    expect(run.timeline.indexOf('log start #8 attempt 1')).toBeGreaterThan(
      run.timeline.indexOf('log fed committed #7'),
    );
    expect(report).toMatchObject({ status: 'done', epics: [{ outcome: 'pr' }] });
  });

  it('names an overlap blocker’s source on its PR body schedule line', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 8, b: 7, confidence: 'likely' }),
    });

    await runShip(run.hooks, 'issues 7 8');

    const scheduleLines = promptLines(run, 'runner:publish:list').filter((l) =>
      /^- #\d+: blockers /.test(l),
    );

    expect(scheduleLines).toEqual([
      '- #7: blockers none; started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1; size 2 files, 40 lines',
      '- #8: blockers #7 (overlap); started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1; size 2 files, 40 lines',
    ]);
  });

  it('adds no edge for an unsure pair within an epic: both issues start before either commits', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'unsure' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    const at = (line: string): number => run.timeline.indexOf(line);
    const firstCommit = Math.min(at('log fed committed #7'), at('log fed committed #8'));
    expect(at('log start #7 attempt 1')).toBeGreaterThan(-1);
    expect(at('log start #8 attempt 1')).toBeGreaterThan(-1);
    expect(firstCommit).toBeGreaterThan(-1);
    expect(at('log start #7 attempt 1')).toBeLessThan(firstCommit);
    expect(at('log start #8 attempt 1')).toBeLessThan(firstCommit);
    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([[], []]);
  });

  it('records each unsure pair within an epic, in issue-overlap’s order, with its shared paths and reason', async () => {
    // The unsure pairs come unsorted (9-8 before 8-7), so a sorted record fails.
    const run = fakeHooks({
      'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8, 9] }], edges: [] },
      issueReadiness: { issues: [7, 8, 9].map((issue) => readyVerdict(issue)) },
      issueOverlap: {
        issues: [],
        pairs: [
          { a: 7, b: 9, confidence: 'likely', shared: ['tooling/x.ts'], reason: REASON },
          {
            a: 9,
            b: 8,
            confidence: 'unsure',
            shared: ['src/a.ts', 'src/b.ts'],
            reason: 'both in the engine area',
          },
          {
            a: 8,
            b: 7,
            confidence: 'unsure',
            shared: ['src/c.ts'],
            reason: 'both touch the run report',
          },
        ],
        liveOverlaps: [],
        areaMap: 'read',
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8 9 --preflight-only');

    expect(report.overlap).toEqual({
      added: [{ blocker: 7, dependent: 9, reason: REASON }],
      sequenced: [],
      unsure: [
        { a: 9, b: 8, shared: ['src/a.ts', 'src/b.ts'], reason: 'both in the engine area' },
        { a: 8, b: 7, shared: ['src/c.ts'], reason: 'both touch the run report' },
      ],
      areaMap: 'read',
    });
  });

  it('lists an unsure pair within the list in the PR body’s run report, reported, not ordered', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({
        a: 7,
        b: 8,
        confidence: 'unsure',
        shared: ['src/a.ts', 'src/b.ts'],
      }),
    });

    await runShip(run.hooks, 'issues 7 8');

    const lines = promptLines(run, 'runner:publish:list');
    const at = lines.indexOf('## Unsure overlap pairs');
    expect(lines.slice(at, at + 4)).toEqual([
      '## Unsure overlap pairs',
      '',
      `- #7 and #8, reported, not ordered; shared \`src/a.ts\`, \`src/b.ts\`: ${REASON}`,
      '',
    ]);
  });

  it('lists an issue’s declared and overlap blockers ascending, each with its source', async () => {
    const run = fakeHooks({
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8, 9] }],
        edges: [{ blocker: 8, dependent: 9 }],
      },
      issueReadiness: {
        issues: [7, 8, 9].map((issue) => readyVerdict(issue)),
      },
      issueOverlap: estimate({ a: 7, b: 9, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8 9');

    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([
      [],
      [],
      [
        { issue: 7, source: 'overlap' },
        { issue: 8, source: 'declared' },
      ],
    ]);
  });

  it('reads an edge both declared and estimated as declared', async () => {
    // issue-overlap names a pair the declared 7 → 8 already orders.
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8] }],
        edges: [{ blocker: 7, dependent: 8 }],
      },
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report.overlap).toEqual({
      added: [],
      sequenced: [{ a: 7, b: 8 }],
      unsure: [],
      areaMap: 'read',
    });
    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([
      [],
      [{ issue: 7, source: 'declared' }],
    ]);
  });

  it.each([
    [
      'the declared edges already order',
      [{ blocker: 7, dependent: 8 }],
      estimate({ a: 8, b: 7, confidence: 'unsure' }),
      { added: [], sequenced: [{ a: 7, b: 8 }], unsure: [], areaMap: 'read' },
    ],
    [
      'a likely pair also names',
      [],
      estimate({ a: 7, b: 8, confidence: 'likely' }, { a: 8, b: 7, confidence: 'unsure' }),
      {
        added: [{ blocker: 7, dependent: 8, reason: REASON }],
        sequenced: [],
        unsure: [],
        areaMap: 'read',
      },
    ],
  ])('records no unsure pair that %s', async (_name, edges, issueOverlap, overlap) => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }], edges },
      issueOverlap,
    });

    const report = await runShip(run.hooks, 'issues 7 8 --preflight-only');

    expect(report.overlap).toEqual(overlap);
  });

  it('reports each blocker’s source for a failed cut’s never-started issues, stopped and dropped alike', async () => {
    // Epic 1's failed cut drops 2 and 3 through the declared 1 → 2, so both
    // of ship.ts's never-started paths render.
    const run = fakeHooks({
      ...epicRun(
        [
          { epic: 1, issues: [1, 4] },
          { epic: 2, issues: [2, 3] },
        ],
        [{ blocker: 1, dependent: 2 }],
      ),
      issueOverlap: estimate(
        { a: 1, b: 4, confidence: 'likely' },
        { a: 2, b: 3, confidence: 'likely' },
      ),
      'runner:cut-batch:epic-1': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'worktree', message: 'worktree add failed' }],
        worktree: 'C:/src/main',
        branch: null,
        base: null,
        batch: null,
        reportDir: null,
        attach: null,
      },
    });

    const report = await runShip(run.hooks, 'epics 1 2');

    const never = { attempts: 0, startedAt: null, committedAt: null, size: null, deaths: [] };
    expect(report.epics.map((e) => e.schedule)).toEqual([
      [
        { issue: 1, blockers: [], ...never },
        { issue: 4, blockers: [{ issue: 1, source: 'overlap' }], ...never },
      ],
      [
        { issue: 2, blockers: [{ issue: 1, source: 'declared' }], ...never },
        { issue: 3, blockers: [{ issue: 2, source: 'overlap' }], ...never },
      ],
    ]);
  });

  it('refuses an unsure pair across epics, naming both issues, and cuts nothing', async () => {
    const run = fakeHooks({
      ...epicRun([
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3] },
      ]),
      issueOverlap: estimate({ a: 1, b: 3, confidence: 'unsure' }),
    });

    const report = await runShip(run.hooks, 'epics 1 2');

    expect(report).toEqual({
      status: 'refused',
      refusals: [
        {
          kind: 'overlap-cross-epic',
          issue: 1,
          message: expect.stringMatching(/#1 \(epic #1\) and #3 \(epic #2\).*unsure/),
        },
      ],
      dropped: [],
      epics: [],
    });
    expect(labels(run).filter((l) => l.startsWith('runner:cut-batch'))).toEqual([]);
  });

  it('refuses no launch for a cross-epic pair whose only shared path is eslint-suppressions.json', async () => {
    const run = fakeHooks({
      ...epicRun([
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3] },
      ]),
      issueOverlap: estimate({
        a: 1,
        b: 3,
        confidence: 'unsure',
        shared: ['eslint-suppressions.json'],
      }),
    });

    const report = await runShip(run.hooks, 'epics 1 2 --preflight-only');

    expect(report).toMatchObject({
      status: 'preflight-ok',
      overlap: { added: [], sequenced: [] },
    });
  });

  it('reports each epic’s own overlap edges in its PR body', async () => {
    const run = fakeHooks({
      ...epicRun([
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3, 4] },
      ]),
      issueOverlap: estimate(
        { a: 1, b: 2, confidence: 'likely' },
        { a: 3, b: 4, confidence: 'likely' },
      ),
    });

    await runShip(run.hooks, 'epics 1 2');

    const edgeLines = (label: string): string[] =>
      promptLines(run, label).filter((l) => /^- #\d+ → #\d+/.test(l));

    expect(edgeLines('runner:publish:epic-1')).toEqual([`- #1 → #2: ${REASON}`]);
    expect(edgeLines('runner:publish:epic-2')).toEqual([`- #3 → #4: ${REASON}`]);
  });

  it.each([
    ['an issue-overlap that returned nothing', null, 'issue-overlap returned nothing'],
    [
      'a pair of one issue',
      estimate({ a: 7, b: 7, confidence: 'likely' }),
      'run overlap: pair {#7, #7} pairs an issue with itself',
    ],
    [
      'an unsure pair of one issue',
      estimate({ a: 7, b: 7, confidence: 'unsure' }),
      'run overlap: pair {#7, #7} pairs an issue with itself',
    ],
  ])('refuses %s as overlap-estimate-failed', async (_name, answer, message) => {
    const run = fakeHooks({ ...SEVEN_EIGHT, issueOverlap: answer });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report).toEqual({
      status: 'refused',
      refusals: [{ kind: 'overlap-estimate-failed', message }],
      dropped: [],
      epics: [],
    });
  });

  // The unsure case names two outside issues, so neither sits in an entry.
  it.each([
    ['a pair', 7, 'likely', 'run overlap: pair {#7, #99} names #99, which is outside the run set'],
    [
      'an unsure pair',
      98,
      'unsure',
      'run overlap: pair {#98, #99} names #98, which is outside the run set',
    ],
  ] as const)(
    'refuses %s naming an issue outside the run as overlap-estimate-failed',
    async (_name, a, confidence, message) => {
      const run = fakeHooks(
        { ...SEVEN_EIGHT, issueOverlap: estimate({ a, b: 99, confidence }) },
        { offSchema: true },
      );

      const report = await runShip(run.hooks, 'issues 7 8');

      expect(report).toEqual({
        status: 'refused',
        refusals: [{ kind: 'overlap-estimate-failed', message }],
        dropped: [],
        epics: [],
      });
    },
  );

  it('shows issue-overlap the run set, the declared edges and the live runs, and lets a pair or a live overlap name only run issues', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8, 9] }],
        edges: [{ blocker: 7, dependent: 9 }],
      },
      issueReadiness: {
        issues: [7, 8, 9].map((issue) => readyVerdict(issue)),
      },
    });

    await runShip(run.hooks, 'issues 7 8 9 --preflight-only');

    const call = run.calls.find((c) => c.label === 'issueOverlap');
    expect(call?.prompt.split('\n')).toEqual([
      'Checkout: C:/src/main',
      'Run set (JSON): [{"epic":null,"issues":[7,8,9]}]',
      'Declared edges (JSON): [{"blocker":7,"dependent":9}]',
      'Live runs (JSON): []',
    ]);
    const items = (key: string): Record<string, unknown> =>
      (
        (call?.schema?.['properties'] as Record<string, { items: unknown }>)[key]?.items as {
          properties: Record<string, unknown>;
        }
      ).properties;

    expect(items('pairs')['a']).toEqual({ type: 'integer', enum: [7, 8, 9] });
    expect(items('pairs')['b']).toEqual({ type: 'integer', enum: [7, 8, 9] });
    expect(items('liveOverlaps')['issue']).toEqual({ type: 'integer', enum: [7, 8, 9] });
  });
});

describe('runShip — an overlap edge whose head lands nothing', () => {
  it('starts and lands the tail of an overlap edge whose head blocked with no commit', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely' }),
      'tdd:7-1': TDD_BLOCKED,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(labels(run)).toContain('tdd:8-1');
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see' },
        { issue: 8, outcome: 'landed', commit: 'landed1' },
      ],
    });
  });

  it.each([
    [
      'retry-exhausted',
      { 'tdd:7-1': null, 'tdd:7-2': null },
      { outcome: 'blocked', reason: 'tdd died on the retry too: returned nothing' },
    ],
    [
      'label-removed',
      {
        'runner:check:7-1': {
          exitCode: 1,
          envelopePath: 'e.json',
          issue: 7,
          ready: false,
          failures: [],
        },
      },
      { outcome: 'removed', reason: 'no longer open and ready-for-agent' },
    ],
  ])('starts and lands the tail when the head ends %s', async (_trigger, head, headReport) => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely' }),
      ...head,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [
        { issue: 7, cite: 'see', ...headReport },
        { issue: 8, outcome: 'landed', commit: 'landed1' },
      ],
    });
  });

  it('lists the released edge with its head, tail and trigger in the run report’s schedule', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely' }),
      'tdd:7-1': TDD_BLOCKED,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([
      [],
      [{ issue: 7, source: 'overlap', released: 'blocked' }],
    ]);
    const scheduleLines = promptLines(run, 'runner:publish:list').filter((l) =>
      /^- #\d+: blockers /.test(l),
    );

    expect(scheduleLines).toEqual([
      '- #7: blockers none; started 2026-09-29T10:00:00.000Z; committed never; attempts 1; size none',
      '- #8: blockers #7 (overlap, released: blocked); started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1; size 2 files, 40 lines',
    ]);
  });

  it('still skips a declared dependent of the blocked head, and its own declared dependent', async () => {
    // 7 → 8 overlap; 7 → 9 and 9 → 10 declared.
    const run = fakeHooks({
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8, 9, 10] }],
        edges: [
          { blocker: 7, dependent: 9 },
          { blocker: 9, dependent: 10 },
        ],
      },
      issueReadiness: { issues: [7, 8, 9, 10].map((issue) => readyVerdict(issue)) },
      issueOverlap: estimate({ a: 7, b: 8, confidence: 'likely' }),
      'tdd:7-1': TDD_BLOCKED,
    });

    const report = await runShip(run.hooks, 'issues 7 8 9 10');

    expect(report.epics[0]?.issues).toEqual([
      expect.objectContaining({ issue: 7, outcome: 'blocked' }),
      expect.objectContaining({ issue: 8, outcome: 'landed' }),
      { issue: 9, outcome: 'skipped', cite: 'see', reason: 'blocker #7 blocked' },
      { issue: 10, outcome: 'skipped', cite: 'see', reason: 'blocker #7 blocked' },
    ]);
  });
});

/** An unspent live run whose PR is open, having changed `src/a.ts`. */
const LIVE_RUN = {
  branch: 'ship/epic-9',
  landed: ['src/a.ts'],
  pr: { state: 'open', number: 4 },
  spent: false,
};

describe('runShip — live-run overlap', () => {
  it('refuses a one-issue run issue-overlap finds touching a live run’s file, even in exclude mode', async () => {
    const run = fakeHooks({
      ...liveRuns(LIVE_RUN),
      issueOverlap: {
        issues: [],
        pairs: [],
        liveOverlaps: [
          { issue: 7, branch: 'ship/epic-9', files: ['src/a.ts'], reason: 'both edit src/a.ts' },
        ],
        areaMap: 'read',
      },
    });

    const report = await runShip(run.hooks, 'issues 7 --exclude --preflight-only');

    expect(report.refusals).toEqual([
      { kind: 'overlap', issue: 7, message: 'ship/epic-9: both edit src/a.ts' },
    ]);
    const call = run.calls.find((c) => c.label === 'issueOverlap');
    expect(call).toMatchObject({ agentType: 'issue-overlap', model: 'opus', effort: 'medium' });
    expect(call?.prompt.split('\n')).toEqual([
      'Checkout: C:/src/main',
      'Run set (JSON): [{"epic":null,"issues":[7]}]',
      'Declared edges (JSON): []',
      'Live runs (JSON): [{"branch":"ship/epic-9","landed":["src/a.ts"]}]',
    ]);
    expect(run.calls.find((c) => c.label === 'issueReadiness')?.prompt).not.toContain('Live runs');
  });
});
