// Executes the committed render: ship.test.ts drives the TS sources, so a defect only the render carries passes it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { SHIP_META } from '../../../../tooling/workflows/ship.meta.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import { fakeHooks, GATE_OK, LAND_OK, type FakeRun } from './_fake-hooks.js';

const SHIP_JS = readFileSync(
  resolve(import.meta.dirname, '../../../../.claude/workflows/ship.js'),
  'utf8',
).replaceAll('\r\n', '\n');

const META_HEAD = 'export const meta = ';

/**
 * Run the committed `ship.js` over a fake run's hooks.
 *
 * @param run - The fake run whose hooks become the globals.
 * @param args - The launch arguments, bound as the `args` global.
 * @returns The workflow's result.
 */
function runRendered(run: FakeRun, args: string): Promise<unknown> {
  // The runtime's wrapper (observed #1035): the file, `export` dropped, as an async function body; hooks + `args` as globals.
  const script = `(async function () {\n${SHIP_JS.replace(/^export /, '')}\n})()`;
  // eslint-disable-next-line sonarjs/code-eval -- runs the committed render, never user input
  return vm.runInContext(script, vm.createContext({ ...run.hooks, args })) as Promise<unknown>;
}

/**
 * Drive the TS source and the render through one launch, each over its own fake hooks.
 *
 * @param args - The launch arguments.
 * @returns Both fake runs, the source's report and the render's.
 */
async function runBoth(args: string) {
  const source = fakeHooks();
  const rendered = fakeHooks();
  const expected = await runShip(source.hooks, args);
  const report = await runRendered(rendered, args);
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
  expect(both.rendered.violations).toEqual([]);
}

describe('ship.js — the committed render', () => {
  it('opens with a meta literal that evaluates to SHIP_META', () => {
    const end = SHIP_JS.indexOf('\n};\n');

    expect(SHIP_JS.startsWith(META_HEAD)).toBe(true);
    // eslint-disable-next-line sonarjs/code-eval -- evaluates the committed render's literal alone
    const meta: unknown = vm.runInNewContext(`(${SHIP_JS.slice(META_HEAD.length, end + 2)})`);
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
});
