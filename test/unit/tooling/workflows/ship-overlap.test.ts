import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import { fakeHooks, GATE_OK, type FakeRun } from './_fake-hooks.js';
import { epicRun } from './_fake-parallel.js';

/** The gate and scout answers of an explicit list of 7 and 8, no declared edge. */
const SEVEN_EIGHT = {
  'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }], edges: [] },
  scout: {
    issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
    overlaps: [],
  },
};

const REASON = 'both edit tooling/x.ts';

/**
 * An estimator answer naming the given pairs.
 *
 * @param pairs - Each pair's endpoints and confidence.
 * @returns The answer.
 */
const estimate = (
  ...pairs: readonly { a: number; b: number; confidence: 'likely' | 'unsure' }[]
): unknown => ({
  issues: [],
  pairs: pairs.map((p) => ({ ...p, shared: ['tooling/x.ts'], reason: REASON })),
  areaMap: 'read',
});

const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

describe('runShip — the overlap estimate', () => {
  it('asks no estimator for a one-issue run', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(labels(run)).not.toContain('overlapEstimator');
    expect(report).toMatchObject({
      status: 'preflight-ok',
      overlap: { added: [], sequenced: [], areaMap: 'read' },
    });
  });

  it('merges a likely pair into the graph as an edge and records it with its reason', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      overlapEstimator: estimate({ a: 8, b: 7, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8 --preflight-only');

    expect(report).toMatchObject({
      status: 'preflight-ok',
      graph: { runSet: [{ epic: null, issues: [7, 8] }], edges: [{ blocker: 7, dependent: 8 }] },
      overlap: {
        added: [{ blocker: 7, dependent: 8, confidence: 'likely', reason: REASON }],
        sequenced: [],
        areaMap: 'read',
      },
    });
  });

  it('starts the dependent of an overlap edge only once its blocker committed', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      overlapEstimator: estimate({ a: 7, b: 8, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(run.timeline.indexOf('log fed committed #7')).toBeGreaterThan(-1);
    expect(run.timeline.indexOf('log start #8 attempt 1')).toBeGreaterThan(
      run.timeline.indexOf('log fed committed #7'),
    );
    expect(report).toMatchObject({ status: 'done', epics: [{ outcome: 'pr' }] });
  });

  it('names an overlap blocker’s source and confidence on its PR body schedule line', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      overlapEstimator: estimate({ a: 8, b: 7, confidence: 'likely' }),
    });

    await runShip(run.hooks, 'issues 7 8');

    const scheduleLines = (run.calls.find((c) => c.label === 'runner:publish:list')?.prompt ?? '')
      .split('\n')
      .filter((l) => /^- #\d+: blockers /.test(l));
    expect(scheduleLines).toEqual([
      '- #7: blockers none; started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1; size 2 files, 40 lines',
      '- #8: blockers #7 (overlap, likely); started 2026-09-29T10:00:00.000Z; committed 2026-09-29T10:20:00.000Z; attempts 1; size 2 files, 40 lines',
    ]);
  });

  it('carries each blocker’s source and confidence in the run report’s schedule', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      overlapEstimator: estimate({ a: 7, b: 8, confidence: 'unsure' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([
      [],
      [{ issue: 7, source: 'overlap', confidence: 'unsure' }],
    ]);
  });

  it('lists an issue’s declared and overlap blockers ascending, each with its source', async () => {
    const run = fakeHooks({
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8, 9] }],
        edges: [{ blocker: 8, dependent: 9 }],
      },
      scout: {
        issues: [7, 8, 9].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
      overlapEstimator: estimate({ a: 7, b: 9, confidence: 'likely' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8 9');

    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([
      [],
      [],
      [
        { issue: 7, source: 'overlap', confidence: 'likely' },
        { issue: 8, source: 'declared' },
      ],
    ]);
  });

  it('reads an edge both declared and estimated as declared', async () => {
    // The estimator names a pair the declared 7 → 8 already orders.
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8] }],
        edges: [{ blocker: 7, dependent: 8 }],
      },
      overlapEstimator: estimate({ a: 7, b: 8, confidence: 'unsure' }),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report.overlap).toEqual({ added: [], sequenced: [{ a: 7, b: 8 }], areaMap: 'read' });
    expect(report.epics[0]?.schedule.map((s) => s.blockers)).toEqual([
      [],
      [{ issue: 7, source: 'declared' }],
    ]);
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
      overlapEstimator: estimate(
        { a: 1, b: 4, confidence: 'likely' },
        { a: 2, b: 3, confidence: 'unsure' },
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

    const never = { attempts: 0, startedAt: null, committedAt: null, size: null };
    expect(report.epics.map((e) => e.schedule)).toEqual([
      [
        { issue: 1, blockers: [], ...never },
        { issue: 4, blockers: [{ issue: 1, source: 'overlap', confidence: 'likely' }], ...never },
      ],
      [
        { issue: 2, blockers: [{ issue: 1, source: 'declared' }], ...never },
        { issue: 3, blockers: [{ issue: 2, source: 'overlap', confidence: 'unsure' }], ...never },
      ],
    ]);
  });

  it('refuses an unsure pair across epics, naming both issues, and cuts nothing', async () => {
    const run = fakeHooks({
      ...epicRun([
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3] },
      ]),
      overlapEstimator: estimate({ a: 1, b: 3, confidence: 'unsure' }),
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

  it('reports each epic’s own overlap edges in its PR body', async () => {
    const run = fakeHooks({
      ...epicRun([
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3, 4] },
      ]),
      overlapEstimator: estimate(
        { a: 1, b: 2, confidence: 'likely' },
        { a: 3, b: 4, confidence: 'unsure' },
      ),
    });

    await runShip(run.hooks, 'epics 1 2');

    const edgeLines = (label: string): string[] =>
      (run.calls.find((c) => c.label === label)?.prompt ?? '')
        .split('\n')
        .filter((l) => /^- #\d+ → #\d+ /.test(l));
    expect(edgeLines('runner:publish:epic-1')).toEqual([`- #1 → #2 (likely): ${REASON}`]);
    expect(edgeLines('runner:publish:epic-2')).toEqual([`- #3 → #4 (unsure): ${REASON}`]);
  });

  it.each([
    ['an estimator that returned nothing', null, 'the overlap estimator returned nothing'],
    [
      'a pair of one issue',
      estimate({ a: 7, b: 7, confidence: 'likely' }),
      'run overlap: pair {#7, #7} pairs an issue with itself',
    ],
  ])('refuses %s as overlap-estimate-failed', async (_name, answer, message) => {
    const run = fakeHooks({ ...SEVEN_EIGHT, overlapEstimator: answer });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report).toEqual({
      status: 'refused',
      refusals: [{ kind: 'overlap-estimate-failed', message }],
      dropped: [],
      epics: [],
    });
  });

  it('refuses a pair naming an issue outside the run as overlap-estimate-failed', async () => {
    const run = fakeHooks(
      { ...SEVEN_EIGHT, overlapEstimator: estimate({ a: 7, b: 99, confidence: 'likely' }) },
      { offSchema: true },
    );

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report).toEqual({
      status: 'refused',
      refusals: [
        {
          kind: 'overlap-estimate-failed',
          message: 'run overlap: pair {#7, #99} names #99, which is outside the run set',
        },
      ],
      dropped: [],
      epics: [],
    });
  });

  it('shows the estimator the run set and the declared edges, and lets a pair name only run issues', async () => {
    const run = fakeHooks({
      ...SEVEN_EIGHT,
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8, 9] }],
        edges: [{ blocker: 7, dependent: 9 }],
      },
      scout: {
        issues: [7, 8, 9].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
    });

    await runShip(run.hooks, 'issues 7 8 9 --preflight-only');

    const call = run.calls.find((c) => c.label === 'overlapEstimator');
    expect(call?.prompt.split('\n')).toEqual([
      'Run set (JSON): [{"epic":null,"issues":[7,8,9]}]',
      'Declared edges (JSON): [{"blocker":7,"dependent":9}]',
    ]);
    const pair = (call?.schema?.['properties'] as Record<string, { items: unknown }>)['pairs']
      ?.items as { properties: Record<string, unknown> };
    expect(pair.properties['a']).toEqual({ type: 'integer', enum: [7, 8, 9] });
    expect(pair.properties['b']).toEqual({ type: 'integer', enum: [7, 8, 9] });
  });
});
