import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  fakeHooks,
  GATE_OK,
  inTurn,
  LAND_OK,
  PLAN_CARD,
  TDD_GREEN,
  type FakeRun,
  type RecordedCall,
} from './_fake-hooks.js';
import { epicRun, holdable, idle } from './_fake-parallel.js';

const CUT_OK = {
  exitCode: 0,
  envelopePath: 'e.json',
  status: 'ok',
  errors: [],
  branch: 'slice/x',
  base: 'cut1',
  slice: 'C:/src/ph-runs/7/slice',
};

const LAND_CONFLICT = {
  ...LAND_OK,
  status: 'conflict',
  commit: null,
  conflicts: ['tooling/x.ts'],
  rolledBack: true,
  errors: [{ step: 'cherry-pick', message: 'tooling/x.ts would not apply' }],
};

const LAND_BATCH_DIRTY = {
  ...LAND_OK,
  status: 'refused',
  reason: 'batch-dirty',
  commit: null,
  batchClean: false,
  errors: [{ step: 'preconditions', message: 'the batch has uncommitted changes' }],
};

/**
 * The gate and scout answers of an explicit list.
 *
 * @param issues - The list.
 * @param edges - Its declared edges.
 * @returns The answers.
 */
const list = (
  issues: readonly number[],
  edges: readonly { blocker: number; dependent: number }[] = [],
): Record<string, unknown> => ({
  'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues }], edges },
  scout: {
    issues: issues.map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
    overlaps: [],
  },
});

const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

/**
 * Where an entry sits on the timeline.
 *
 * @param run - The fake run.
 * @param entry - `call <label>` or `log <message>`.
 * @returns Its first index; fails the test when absent.
 */
const when = (run: FakeRun, entry: string): number => {
  const at = run.timeline.indexOf(entry);
  expect(at, `${entry} on the timeline`).toBeGreaterThan(-1);
  return at;
};

/**
 * A planner call's `Previous attempt:` line.
 *
 * @param run - The fake run.
 * @param label - The planner call's label.
 * @returns The line; `undefined` when the call or the line is absent.
 */
const previousAttempt = (run: FakeRun, label: string): string | undefined =>
  run.calls
    .find((c) => c.label === label)
    ?.prompt.split('\n')
    .find((l) => l.startsWith('Previous attempt:'));

describe('runShip — issues in flight at once', () => {
  it('authors three independent issues concurrently under the cap', async () => {
    const hold = holdable(/^tdd:/);
    const run = fakeHooks(list([7, 8, 9]), { gate: hold.gate });

    const done = runShip(run.hooks, 'issues 7 8 9 --max-slices 4');
    await idle();

    expect(labels(run).filter((l) => l.startsWith('tdd:'))).toEqual([
      'tdd:7-1',
      'tdd:8-1',
      'tdd:9-1',
    ]);
    hold.releaseAll();
    await expect(done).resolves.toMatchObject({ status: 'done' });
  });

  it('starts a dependent only after its blocker committed', async () => {
    const run = fakeHooks(list([7, 8], [{ blocker: 7, dependent: 8 }]));

    await runShip(run.hooks, 'issues 7 8');

    expect(when(run, 'log start #8 attempt 1')).toBeGreaterThan(when(run, 'log fed committed #7'));
  });

  it('holds a slot from start until the issue settles, the commit-queue wait included', async () => {
    const hold = holdable(/^runner:land:/);
    const run = fakeHooks(list([7, 8, 9]), { gate: hold.gate });

    const done = runShip(run.hooks, 'issues 7 8 9 --max-slices 2');
    await idle();

    expect(hold.held()).toEqual(['runner:land:7-1']);
    expect(labels(run)).not.toContain('runner:check:9-1');
    hold.releaseAll();
    await done;
    expect(labels(run)).toContain('runner:check:9-1');
  });

  it('lands one issue at a time per epic, and epics side by side', async () => {
    const hold = holdable(/^runner:land:/);
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3] },
      ]),
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'epics 1 2');
    await idle();

    const epicOne = hold.held().filter((l) => /^runner:land:[12]-1$/.test(l));
    expect(epicOne).toHaveLength(1);
    expect(hold.held()).toContain('runner:land:3-1');
    const [first = ''] = epicOne;
    hold.release(first);
    await idle();
    const other = first === 'runner:land:1-1' ? 'runner:land:2-1' : 'runner:land:1-1';
    expect(labels(run)).toContain(other);
    hold.releaseAll();
    await done;
  });

  it('re-plans after each land conflict with the conflicting files, with no requeue cap', async () => {
    const run = fakeHooks({ 'runner:land': inTurn(LAND_CONFLICT, LAND_CONFLICT, LAND_OK) });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:cut-slice'))).toEqual([
      'runner:cut-slice:7-1',
      'runner:cut-slice:7-2',
      'runner:cut-slice:7-3',
    ]);
    expect(previousAttempt(run, 'planner:7-1')).toBeUndefined();
    for (const label of ['planner:7-2', 'planner:7-3']) {
      expect(previousAttempt(run, label)).toBe(
        'Previous attempt: harvest conflict on tooling/x.ts; re-plan against the current batch head',
      );
    }
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [{ issue: 7, outcome: 'landed' }],
    });
  });

  it('gives a retry after a died agent no conflict context from an earlier conflict', async () => {
    const run = fakeHooks({
      'runner:land': inTurn(LAND_CONFLICT, LAND_OK),
      tdd: inTurn(TDD_GREEN, null, TDD_GREEN),
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('tdd:'))).toEqual([
      'tdd:7-1',
      'tdd:7-2',
      'tdd:7-3',
    ]);
    expect(previousAttempt(run, 'planner:7-2')).toBe(
      'Previous attempt: harvest conflict on tooling/x.ts; re-plan against the current batch head',
    );
    expect(previousAttempt(run, 'planner:7-3')).toBeUndefined();
    expect(report.epics[0]).toMatchObject({ issues: [{ issue: 7, outcome: 'landed' }] });
  });

  it('keeps feeding one epic while another epic’s end is pending', async () => {
    const hold = holdable(/^(runner:bump:epic-1|tdd:3-1)$/);
    const run = fakeHooks(
      epicRun(
        [
          { epic: 1, issues: [1] },
          { epic: 2, issues: [3, 4] },
        ],
        [{ blocker: 3, dependent: 4 }],
      ),
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'epics 1 2');
    await idle();

    expect(labels(run)).toContain('runner:bump:epic-1');
    expect(run.timeline).not.toContain('log fed committed #3');
    hold.release('tdd:3-1');
    await idle();
    expect(hold.held()).toEqual(['runner:bump:epic-1']);
    expect(when(run, 'log start #4 attempt 1')).toBeGreaterThan(when(run, 'log fed committed #3'));
    hold.releaseAll();
    const report = await done;
    expect(report.epics).toMatchObject([
      { epic: 1, outcome: 'pr' },
      {
        epic: 2,
        outcome: 'pr',
        issues: [
          { issue: 3, outcome: 'landed' },
          { issue: 4, outcome: 'landed' },
        ],
      },
    ]);
  });

  it('halts only the epic whose landing left its batch unverified', async () => {
    // #3's tdd is held until epic 1 has halted, so #3's later stages run under that halt.
    const hold = holdable(/^tdd:3-1$/);
    const run = fakeHooks(
      {
        ...epicRun([
          { epic: 1, issues: [1] },
          { epic: 2, issues: [3] },
        ]),
        'runner:land:1-1': LAND_BATCH_DIRTY,
      },
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'epics 1 2');
    await idle();
    expect(run.timeline).toContain('log fed epic-halt epic #1');
    hold.releaseAll();
    const report = await done;

    expect(report.epics).toMatchObject([
      { epic: 1, outcome: 'halted', issues: [{ issue: 1, outcome: 'halted', cite: 'see' }] },
      { epic: 2, outcome: 'pr', pr: 200, issues: [{ issue: 3, outcome: 'landed' }] },
    ]);
  });

  it('stops a halting entry’s attempt at the stage boundary before its diff review', async () => {
    // #8's tdd is held until #7's landing has halted the entry, so #8's next stage boundary sees the halt.
    const hold = holdable(/^tdd:8-1$/);
    const run = fakeHooks(
      { ...list([7, 8]), 'runner:land': LAND_BATCH_DIRTY },
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'issues 7 8');
    await idle();
    expect(hold.held()).toEqual(['tdd:8-1']);
    expect(run.timeline).toContain('log fed epic-halt the issue list');
    hold.releaseAll();
    const report = await done;

    expect(labels(run)).toContain('diffReview:7-1');
    expect(labels(run).filter((l) => /^(tdd|diffReview|reviewer):8-1$/.test(l))).toEqual([
      'tdd:8-1',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'halted', cite: 'see' },
        { issue: 8, outcome: 'halted', cite: 'see', reason: 'its epic halted' },
      ],
    });
  });

  it('reports each issue’s schedule: blockers, attempts, and the final attempt’s cut and land instants', async () => {
    const cutAt = (call: RecordedCall): unknown => ({
      ...CUT_OK,
      at: `cut ${call.label.slice('runner:cut-slice:'.length)}`,
    });
    const run = fakeHooks({
      ...list([7, 8, 9], [{ blocker: 8, dependent: 9 }]),
      'runner:cut-slice': cutAt,
      'runner:land:7-1': LAND_CONFLICT,
      'runner:land:7-2': { ...LAND_OK, at: 'land 7-2' },
      'planner:8-1': { ...PLAN_CARD, verdict: 'stale', evidence: 'done at abc123' },
    });

    const report = await runShip(run.hooks, 'issues 7 8 9');

    expect(report.epics[0]?.schedule).toEqual([
      { issue: 7, blockers: [], attempts: 2, startedAt: 'cut 7-2', committedAt: 'land 7-2' },
      { issue: 8, blockers: [], attempts: 1, startedAt: 'cut 8-1', committedAt: null },
      {
        issue: 9,
        blockers: [{ issue: 8, source: 'declared' }],
        attempts: 0,
        startedAt: null,
        committedAt: null,
      },
    ]);
  });

  it('drops a not-ready issue and skips its dependent, landing the independent one', async () => {
    const run = fakeHooks({
      ...list([7, 8, 9], [{ blocker: 8, dependent: 9 }]),
      'runner:check:8-1': { exitCode: 1, envelopePath: 'e.json', ready: false, failures: [] },
    });

    const report = await runShip(run.hooks, 'issues 7 8 9');

    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [
        { issue: 7, outcome: 'landed' },
        { issue: 8, outcome: 'removed', cite: 'see' },
        { issue: 9, outcome: 'skipped', cite: 'see' },
      ],
    });
  });
});

describe('runShip — epics side by side', () => {
  it('cuts, publishes and reports each epic on its own batch and PR', async () => {
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1] },
        { epic: 2, issues: [3] },
      ]),
    );

    const report = await runShip(run.hooks, 'epics 1 2');

    const argvOf = (prefix: string): string[][] =>
      run.calls.filter((c) => c.label.startsWith(prefix)).map((c) => [...c.argv]);
    expect(argvOf('runner:cut-batch')).toEqual([
      ['tooling/worktree.ts', 'cut-batch', '.', '--epic', '1'],
      ['tooling/worktree.ts', 'cut-batch', '.', '--epic', '2'],
    ]);
    expect(argvOf('runner:publish').map((a) => a[2])).toEqual(
      expect.arrayContaining(['C:/src/ph-runs/epic-1/batch', 'C:/src/ph-runs/epic-2/batch']),
    );
    expect(argvOf('runner:publish')).toHaveLength(2);
    expect(report.epics).toMatchObject([
      { epic: 1, branch: 'ship/epic-1', outcome: 'pr', pr: 100 },
      { epic: 2, branch: 'ship/epic-2', outcome: 'pr', pr: 200 },
    ]);
  });

  it('merges master into one epic at a time', async () => {
    const hold = holdable(/^runner:sync-master:/);
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1] },
        { epic: 2, issues: [3] },
      ]),
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'epics 1 2');
    await idle();

    expect(labels(run).filter((l) => l.startsWith('runner:teardown:'))).toHaveLength(2);
    expect(labels(run).filter((l) => l.startsWith('runner:sync-master'))).toHaveLength(1);
    const [first = ''] = hold.held();
    hold.release(first);
    await idle();
    expect(labels(run).filter((l) => l.startsWith('runner:sync-master'))).toHaveLength(2);
    hold.releaseAll();
    await done;
  });

  it.each([
    ['publishes', 'runner:publish:'],
    ['reads the main checkout at the epic end', 'runner:preflight:epic-'],
    ['checks master', 'runner:check-master:epic-'],
  ])('%s for one epic at a time', async (_name, prefix) => {
    const hold = holdable(new RegExp(`^${prefix}`));
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1] },
        { epic: 2, issues: [3] },
      ]),
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'epics 1 2');
    await idle();

    expect(labels(run).filter((l) => l.startsWith(prefix))).toHaveLength(1);
    const [first = ''] = hold.held();
    hold.release(first);
    await idle();
    expect(labels(run).filter((l) => l.startsWith(prefix))).toHaveLength(2);
    hold.releaseAll();
    await done;
  });
});
