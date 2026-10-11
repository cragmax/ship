// Executes a fresh in-memory render of the current sources (renderWorkflow over WORKFLOWS):
// ship.test.ts drives the TS sources, so a defect only the render carries passes it.
// The committed file's freshness is gate:codegen's.
import { resolve } from 'node:path';
import vm from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

import { renderWorkflow } from '../../../../tooling/lib/workflow-render.js';
import { WORKFLOWS } from '../../../../tooling/render-workflows.js';
import { SHIP_META } from '../../../../tooling/workflows/ship.meta.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import { fakeHooks, GATE_OK, LAND_OK, liveRuns, type FakeRun } from './_fake-hooks.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const META_HEAD = 'export const meta = ';

let shipJs = '';
beforeAll(async () => {
  const spec = WORKFLOWS.find((w) => w.name === 'ship');
  if (spec === undefined) throw new Error('no ship row in WORKFLOWS');
  shipJs = await renderWorkflow(spec, ROOT);
});

/** Run a rendered `ship.js` over a fake run's hooks. */
function runRendered(js: string, run: FakeRun, args: string): Promise<unknown> {
  // The runtime's wrapper (observed #1035): the file, `export` dropped, as an async function
  // body; hooks + `args` as globals.
  const script = `(async function () {\n${js.replace(/^export /, '')}\n})()`;
  // eslint-disable-next-line sonarjs/code-eval -- runs a fresh render of the repo's own sources, never user input
  return vm.runInContext(script, vm.createContext({ ...run.hooks, args })) as Promise<unknown>;
}

/**
 * Drive the TS source and the render through one launch, each over its own fake hooks.
 *
 * @param args - The launch arguments.
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

/**
 * Assert the render ran exactly as the source did.
 *
 * @param both - What {@link runBoth} resolved to.
 */
function expectSameRun(both: Awaited<ReturnType<typeof runBoth>>): void {
  expect(both.report).toEqual(both.expected);
  expect(both.rendered.calls).toEqual(both.source.calls);
  expect(both.rendered.timeline).toEqual(both.source.timeline);
  expect(both.rendered.phases).toEqual(both.source.phases);
}

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

  it('tears a spent run down at launch with the same calls, timeline and phases as the source', async () => {
    const both = await runBoth('issues 7', liveRuns({}));

    expect(both.report).toMatchObject({
      status: 'done',
      cleanup: { tornDown: ['C:/src/ph-runs/old-0/batch'] },
    });
    expectSameRun(both);
  });
});
