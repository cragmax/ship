import { describe, expect, it } from 'vitest';

import { runShip } from '../../../src/workflow/ship.js';

import {
  fakeHooks,
  GATE_OK,
  inTurn,
  LAND_BATCH_DIRTY,
  LAND_CONFLICT,
  LAND_OK,
  labels,
  readyVerdict,
  TDD_BLOCKED,
  when,
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

/**
 * The gate and issue-readiness answers of an explicit list.
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
  issueReadiness: {
    issues: issues.map((issue) => readyVerdict(issue)),
  },
});

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

  it('retries in a fresh slice after each land conflict, with no requeue cap', async () => {
    const run = fakeHooks({ 'runner:land': inTurn(LAND_CONFLICT, LAND_CONFLICT, LAND_OK) });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^runner:cut-slice:\d/.test(l))).toEqual([
      'runner:cut-slice:7-1',
      'runner:cut-slice:7-2',
      'runner:cut-slice:7-3',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [{ issue: 7, outcome: 'landed' }],
    });
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
    // Issue 3's tdd is held until epic 1 has halted, so its later stages run under that halt.
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

  it('stops a halting entry’s attempt at the stage boundary before its spec review', async () => {
    // Issue 8's tdd is held until issue 7's landing has halted the entry,
    // so 8's next stage boundary sees the halt.
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

    expect(labels(run)).toContain('specReview:7-1');
    expect(
      labels(run).filter((l) => /^(tdd|specReview|testReview|standardsReview):8-1$/.test(l)),
    ).toEqual(['tdd:8-1']);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'halted', cite: 'see' },
        { issue: 8, outcome: 'halted', cite: 'see', reason: 'its epic halted' },
      ],
    });
  });

  const UP_TO_CUT = ['runner:check:8-1', 'runner:cut-slice:8-1'];
  const UP_TO_TDD = [...UP_TO_CUT, 'runner:provision:8-1', 'tdd:8-1'];
  // The default reviews: a fixed spec review, re-read from the slice base and from the tdd's
  // commit; a clean test review; a fixed standards one, re-read likewise.
  const REREAD = ['runner:changed-files:8-1', 'runner:changed-files:8-1'];
  const UP_TO_SPEC_REVIEW = [...UP_TO_TDD, 'specReview:8-1', ...REREAD];
  it.each<[string, string[]]>([
    ['runner:check:8-1', ['runner:check:8-1']],
    ['runner:cut-slice:8-1', [...UP_TO_CUT, 'runner:teardown:8-1']],
    ['runner:provision:8-1', [...UP_TO_CUT, 'runner:provision:8-1', 'runner:teardown:8-1']],
    ['tdd:8-1', [...UP_TO_TDD, 'runner:teardown:8-1']],
    ['specReview:8-1', [...UP_TO_SPEC_REVIEW, 'runner:teardown:8-1']],
    ['testReview:8-1', [...UP_TO_SPEC_REVIEW, 'testReview:8-1', 'runner:teardown:8-1']],
    [
      'standardsReview:8-1',
      [
        ...UP_TO_SPEC_REVIEW,
        'testReview:8-1',
        'standardsReview:8-1',
        ...REREAD,
        'runner:teardown:8-1',
      ],
    ],
  ])('stops a halting entry’s attempt at the stage boundary after its %s', async (stage, calls) => {
    const hold = holdable(new RegExp(`^${stage}$`));
    const run = fakeHooks(
      { ...list([7, 8]), 'runner:land': LAND_BATCH_DIRTY },
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'issues 7 8');
    await idle();
    expect(hold.held()).toEqual([stage]);
    expect(run.timeline).toContain('log fed epic-halt the issue list');
    hold.releaseAll();
    const report = await done;

    expect(labels(run).filter((l) => l.endsWith(':8-1'))).toEqual(calls);
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
      'tdd:8-1': TDD_BLOCKED,
    });

    const report = await runShip(run.hooks, 'issues 7 8 9');

    expect(report.epics[0]?.schedule).toEqual([
      {
        issue: 7,
        blockers: [],
        attempts: 2,
        startedAt: 'cut 7-2',
        committedAt: 'land 7-2',
        size: { files: 2, lines: 40 },
        deaths: [],
      },
      {
        issue: 8,
        blockers: [],
        attempts: 1,
        startedAt: 'cut 8-1',
        committedAt: null,
        size: null,
        deaths: [],
      },
      {
        issue: 9,
        blockers: [{ issue: 8, source: 'declared' }],
        attempts: 0,
        startedAt: null,
        committedAt: null,
        size: null,
        deaths: [],
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
      ['ship/src/cli/worktree.ts', 'cut-batch', '.', '--epic', '1'],
      ['ship/src/cli/worktree.ts', 'cut-batch', '.', '--epic', '2'],
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

  /**
   * Launch `epics 1 2`, one issue each, holding every call `match` accepts, and let it run to a
   * standstill.
   *
   * @param match - The labels to hold.
   * @returns The hold, the fake run, and the launch's promise.
   */
  async function launchTwoEpicsHolding(match: RegExp) {
    const hold = holdable(match);
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1] },
        { epic: 2, issues: [3] },
      ]),
      { gate: hold.gate },
    );
    const done = runShip(run.hooks, 'epics 1 2');
    await idle();

    return { hold, run, done };
  }

  /**
   * Release the first held call and let the run reach its next standstill.
   *
   * @param hold - The run's hold.
   */
  async function releaseFirst(hold: ReturnType<typeof holdable>): Promise<void> {
    const [first = ''] = hold.held();
    hold.release(first);
    await idle();
  }

  it('merges master into one epic at a time', async () => {
    const { hold, run, done } = await launchTwoEpicsHolding(/^runner:sync-master:/);

    expect(labels(run).filter((l) => /^runner:teardown:\d/.test(l))).toHaveLength(2);
    expect(labels(run).filter((l) => l.startsWith('runner:sync-master'))).toHaveLength(1);
    await releaseFirst(hold);
    expect(labels(run).filter((l) => l.startsWith('runner:sync-master'))).toHaveLength(2);
    hold.releaseAll();
    await done;
  });

  it.each([
    ['publishes', 'runner:publish:'],
    ['reads the main checkout at the epic end', 'runner:preflight:epic-'],
    ['checks master', 'runner:check-master:epic-'],
  ])('%s for one epic at a time', async (_name, prefix) => {
    const { hold, run, done } = await launchTwoEpicsHolding(new RegExp(`^${prefix}`));

    expect(labels(run).filter((l) => l.startsWith(prefix))).toHaveLength(1);
    await releaseFirst(hold);
    expect(labels(run).filter((l) => l.startsWith(prefix))).toHaveLength(2);
    hold.releaseAll();
    await done;
  });
});
