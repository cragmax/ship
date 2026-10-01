import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import { fakeHooks, masterMoved, PREFLIGHT_OK, type FakeRun } from './_fake-hooks.js';

/**
 * The recorded labels, in call order.
 *
 * @param run - The fake run.
 * @returns Each call's label.
 */
const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

/**
 * The publish calls a run made.
 *
 * @param run - The fake run.
 * @returns Their labels.
 */
const publishes = (run: FakeRun): string[] =>
  labels(run).filter((l) => l.startsWith('runner:publish'));

describe('runShip — the master check', () => {
  it('stops before the push when local master was rewound, naming the ref and both shas', async () => {
    const run = fakeHooks(
      masterMoved({ move: 'rewound', current: 'older1' }, { move: 'equal', current: 'origin0' }),
    );

    const report = await runShip(run.hooks, 'issues 7');

    expect(publishes(run)).toEqual([]);
    expect(run.calls.find((c) => c.label === 'runner:check-master:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'check-master',
      'C:/src/main',
      '--local',
      'local0',
      '--remote',
      'origin0',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message:
        'master check failed: local master rewound: launch local0, now older1 — restore it from local0',
      mainUntouched: true,
      masterCheck: {
        passed: false,
        local: { launch: 'local0', current: 'older1', move: 'rewound' },
        remote: { launch: 'origin0', current: 'origin0', move: 'equal' },
        failure: 'local master rewound: launch local0, now older1 — restore it from local0',
      },
    });
  });

  it("stops before the push when origin's master was deleted", async () => {
    const run = fakeHooks(
      masterMoved({ move: 'equal', current: 'local0' }, { move: 'deleted', current: null }),
    );

    const report = await runShip(run.hooks, 'issues 7');

    expect(publishes(run)).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message:
        'master check failed: origin master deleted: launch origin0, now deleted — restore it from origin0',
    });
  });

  it('stops naming both refs, local then origin, when both failed', async () => {
    const run = fakeHooks(
      masterMoved({ move: 'rewound', current: 'older1' }, { move: 'deleted', current: null }),
    );

    const report = await runShip(run.hooks, 'issues 7');

    expect(publishes(run)).toEqual([]);
    expect(report.epics[0]?.message).toBe(
      'master check failed: local master rewound: launch local0, now older1 — restore it from local0; origin master deleted: launch origin0, now deleted — restore it from origin0',
    );
  });

  it('opens the PR when both refs moved forward, reporting the check and the main checkout in its body', async () => {
    const run = fakeHooks(
      masterMoved({ move: 'forward', current: 'local1' }, { move: 'forward', current: 'origin1' }),
    );

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      pr: 42,
      mainUntouched: true,
      masterCheck: {
        passed: true,
        local: { launch: 'local0', current: 'local1', move: 'forward' },
        remote: { launch: 'origin0', current: 'origin1', move: 'forward' },
      },
    });
    const body = run.calls.find((c) => c.label === 'runner:publish:list')?.prompt.split('\n');
    expect(body).toContain(
      '- Master check: passed — local forward, local0 → local1; origin forward, origin0 → origin1',
    );
    expect(body).toContain('- Main checkout: untouched since pre-flight');
  });

  it('stops when the check cannot decide ancestry', async () => {
    const run = fakeHooks(
      masterMoved(
        { move: 'equal', current: 'local0' },
        { move: 'undecidable', current: 'origin9' },
      ),
    );

    const report = await runShip(run.hooks, 'issues 7');

    expect(publishes(run)).toEqual([]);
    expect(report.epics[0]?.message).toBe(
      'master check failed: origin master undecidable: launch origin0, now origin9 — restore it from origin0',
    );
  });

  it.each([
    [
      'a failed check',
      {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'fetch', message: 'git fetch -q origin exited 128' }],
        local: null,
        remote: null,
      },
      'check-master failed: git fetch -q origin exited 128',
    ],
    ['a runner that returned nothing', null, 'the runner returned nothing for check-master'],
    [
      // Its moves alone would pass: only an `ok` status does.
      'a refusal whose moves both read equal',
      {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'master-not-forward',
        errors: [{ step: 'check', message: 'master is not forward of its launch' }],
        local: { launch: 'local0', current: 'local0', move: 'equal' },
        remote: { launch: 'origin0', current: 'origin0', move: 'equal' },
      },
      'check-master refused (master-not-forward): master is not forward of its launch',
    ],
    [
      'an ok check naming a forward move with no current sha',
      {
        exitCode: 0,
        envelopePath: 'e.json',
        status: 'ok',
        errors: [],
        local: { launch: 'local0', current: null, move: 'forward' },
        remote: { launch: 'origin0', current: 'origin0', move: 'equal' },
      },
      'check-master ok: no error named',
    ],
  ])('stops when check-master gives no usable verdict: %s', async (_name, answer, failure) => {
    const run = fakeHooks({ 'runner:check-master': answer });

    const report = await runShip(run.hooks, 'issues 7');

    expect(publishes(run)).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      message: `master check failed: ${failure}`,
      masterCheck: { passed: false, failure },
    });
  });

  it('stops without a check when pre-flight left no launch snapshot', async () => {
    // One answer serves both pre-flight reads: the launch and the epic end's.
    const run = fakeHooks({ 'runner:preflight': { ...PREFLIGHT_OK, snapshot: null } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:check-master'))).toEqual([]);
    expect(publishes(run)).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'master check failed: no launch snapshot of master to check against',
      mainUntouched: null,
      masterCheck: {
        passed: false,
        local: null,
        remote: null,
        failure: 'no launch snapshot of master to check against',
      },
    });
  });

  it('reports a master check that threw as stopped, the main checkout read once before it', async () => {
    const run = fakeHooks({
      'runner:check-master': () => {
        throw new Error('runner crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(publishes(run)).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'the epic end threw: runner crashed',
      mainUntouched: true,
    });
    expect(report.epics[0]).not.toHaveProperty('masterCheck');
    expect(labels(run).filter((l) => l === 'runner:preflight:list')).toHaveLength(1);
  });

  it('still compares the main checkout after an epic end stopped before the check', async () => {
    const run = fakeHooks({
      'runner:sync-master': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'code-conflict',
        errors: [{ step: 'merge', message: 'src/a.ts conflicts' }],
        outcome: null,
        commit: null,
        conflicts: [],
        version: null,
        pending: [],
      },
      'runner:preflight:list': {
        ...PREFLIGHT_OK,
        snapshot: { ...PREFLIGHT_OK.snapshot, dirty: true },
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:check-master'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({ outcome: 'stopped', mainUntouched: false });
    expect(report.epics[0]).not.toHaveProperty('masterCheck');
  });
});
