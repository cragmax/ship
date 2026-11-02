// Executes a fresh in-memory render of the current sources (renderWorkflow over WORKFLOWS):
// ship.test.ts drives the TS sources, so a defect only the render carries passes it.
// The committed file's freshness is gate:codegen's.
import vm from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

import { SHIP_META } from '../../../src/workflow/ship.meta.js';
import { runShip } from '../../../src/workflow/ship.js';

import { fakeHooks, GATE_OK, LAND_OK, liveRuns, TDD_GREEN } from './_fake-hooks.js';
import { renderFresh, runRendered } from './_render.js';

const META_HEAD = 'export const meta = ';

let shipJs = '';
beforeAll(async () => {
  shipJs = await renderFresh('ship');
});

describe('ship.js — a fresh render of the current sources', () => {
  it('opens with a meta literal that evaluates to SHIP_META', () => {
    const end = shipJs.indexOf('\n};\n');

    expect(shipJs.startsWith(META_HEAD)).toBe(true);
    // eslint-disable-next-line sonarjs/code-eval -- evaluates the render's meta literal alone
    const meta: unknown = vm.runInNewContext(`(${shipJs.slice(META_HEAD.length, end + 2)})`);
    expect(meta).toEqual(SHIP_META);
  });

  it('runs --preflight-only to preflight-ok with the same calls, timeline and phases as the source', async () => {
    const both = await runBoth('issues 7 --preflight-only');

    expect(both.report).toMatchObject({
      status: 'preflight-ok',
      graph: { runSet: GATE_OK.runSet, edges: GATE_OK.edges },
      epics: [],
    });
    expectSameRun(both);
  });

  it('runs one issue from launch to a published PR with the same calls, timeline and phases as the source', async () => {
    const both = await runBoth('issues 7');

    expect(both.report).toMatchObject({
      status: 'done',
      epics: [
        {
          outcome: 'pr',
          pr: 42,
          issues: [{ issue: 7, outcome: 'landed', commit: LAND_OK.commit }],
        },
      ],
    });
    expect(both.rendered.phases).toEqual(['Pre-flight', 'Issues', 'Epic end']);
    expectSameRun(both);
  });

  it('reviews the tests of a slice changing only Ship, unproven, as the source does', async () => {
    const files = ['ship/src/core/run-set.ts', 'ship/test/unit/core/run-set.test.ts'];
    const both = await runBoth('issues 7', { tdd: { ...TDD_GREEN, files } });

    const sliceCalls = both.rendered.calls
      .map((c) => c.label)
      .filter((l) => /^(runner:comment-only|testReview):7-1/.test(l));

    expect(sliceCalls).toEqual(['testReview:7-1']);
    expectSameRun(both);
  });

  it('tears a spent run down at launch with the same calls, timeline and phases as the source', async () => {
    const both = await runBoth('issues 7', liveRuns({}));

    expect(both.report).toMatchObject({
      status: 'done',
      cleanup: { tornDown: ['C:/src/ph-runs/old-0/batch'] },
    });
    expectSameRun(both);
  });
});

/**
 * Drive the TS source and the render through one launch, each over its own fake hooks.
 *
 * @param responses - Per-label answers over the fakes' defaults, given to both runs.
 * @returns Both fake runs, the source's report and the render's.
 */
async function runBoth(args: string, responses: Readonly<Record<string, unknown>> = {}) {
  const source = fakeHooks(responses);
  const rendered = fakeHooks(responses);
  const expected = await runShip(source.hooks, args);
  const report = await runRendered(shipJs, rendered, args);

  return { source, rendered, expected, report };
}

/** Assert the render ran exactly as the source did. */
function expectSameRun(both: Awaited<ReturnType<typeof runBoth>>): void {
  expect(both.report).toEqual(both.expected);
  expect(both.rendered.calls).toEqual(both.source.calls);
  expect(both.rendered.timeline).toEqual(both.source.timeline);
  expect(both.rendered.phases).toEqual(both.source.phases);
}
