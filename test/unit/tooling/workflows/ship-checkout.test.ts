// regression: a session `cd` mid-run moved every later agent's start directory, so a runner
// resolved `tooling/worktree.ts` against a report dir and the epic end halted
import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  DOC_INDEX_CONFLICT,
  fakeHooks,
  liveRuns,
  OK,
  PREFLIGHT_OK,
  REPORT_DIR,
  TDD_BLOCKED,
  type FakeRun,
} from './_fake-hooks.js';

/** The main checkout pre-flight names: distinct from every other path the fakes answer. */
const MAIN = 'D:/checkouts/main';

/** Pre-flight and the cut both name {@link MAIN}, as the CLI does for one checkout. */
const AT_MAIN = {
  'runner:preflight': { ...PREFLIGHT_OK, worktree: MAIN },
  'runner:cut-batch': {
    ...OK,
    worktree: MAIN,
    branch: 'ship/7',
    base: 'master0',
    batch: BATCH,
    reportDir: REPORT_DIR,
    attach: null,
  },
};

/** Each runner call's label and its prompt's `Checkout:` lines. */
function checkouts(run: FakeRun): { label: string; checkout: string[] }[] {
  return run.calls
    .filter((c) => c.agentType === 'runner')
    .map((c) => ({
      label: c.label,
      checkout: c.prompt.split('\n').filter((l) => l.startsWith('Checkout:')),
    }));
}

/** Asserts the preflight call has no Checkout line and every later one names {@link MAIN}. */
function laterLabelsAtMain(run: FakeRun): string[] {
  const [first, ...later] = checkouts(run);
  expect(first).toEqual({ label: 'runner:preflight', checkout: [] });
  for (const call of later)
    expect(call).toEqual({ label: call.label, checkout: [`Checkout: ${MAIN}`] });
  return later.map((c) => c.label);
}

describe('runShip — every runner after pre-flight runs from the main checkout', () => {
  it('gives every runner call after preflight a Checkout line naming its worktree, the cleanup and the epic end included, and the preflight call none', async () => {
    const run = fakeHooks({ ...AT_MAIN, ...liveRuns({}), ...DOC_INDEX_CONFLICT });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report).toMatchObject({ status: 'done', epics: [{ outcome: 'pr' }] });
    expect(laterLabelsAtMain(run)).toEqual(
      expect.arrayContaining([
        'runner:run-gate',
        'runner:live-runs',
        'runner:teardown:spent-1',
        'runner:retire-run:spent-1',
        'runner:cut-batch:list',
        'runner:provision-batch:list',
        'runner:check:7-1',
        'runner:cut-slice:7-1',
        'runner:land:7-1',
        'runner:sync-master:list',
        'runner:sync-master:list-continue',
        'runner:bump:list',
        'runner:preflight:list',
        'runner:check-master:list',
        'runner:publish:list',
      ]),
    );
  });

  it('gives the blocked-issue comment, teardown and retire-run of a nothing-landed entry the Checkout line', async () => {
    const run = fakeHooks({ ...AT_MAIN, tdd: TDD_BLOCKED });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({ outcome: 'nothing-landed', residue: [] });
    expect(laterLabelsAtMain(run)).toEqual(
      expect.arrayContaining([
        'runner:post-issue-comment:7',
        'runner:teardown:list',
        'runner:retire-run:list',
      ]),
    );
  });

  it('gives an attached run’s push, report comment and section append the Checkout line', async () => {
    const run = fakeHooks({
      ...AT_MAIN,
      'runner:cut-batch': {
        ...AT_MAIN['runner:cut-batch'],
        branch: 'ship/epic-9',
        attach: { created: false, fastForwarded: false, pr: 9, run: 2, registry: 'C:/r.json' },
      },
      'runner:publish': {
        ...OK,
        pushed: true,
        pr: { number: 9, url: 'https://x/pull/9' },
        mergeable: 'MERGEABLE',
      },
    });

    const report = await runShip(run.hooks, 'issues 7 --attach ship/epic-9');

    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 9 });
    expect(laterLabelsAtMain(run)).toEqual(
      expect.arrayContaining([
        'runner:publish:list',
        'runner:post-pr-comment:list',
        'runner:append-pr-body:list',
      ]),
    );
  });
});
