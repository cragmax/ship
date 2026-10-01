// Executes a fresh in-memory render of the current sources (renderWorkflow over WORKFLOWS): resync.test.ts drives the TS sources, so a defect only the render carries passes it. The committed file's freshness is gate:codegen's.
import { resolve } from 'node:path';
import vm from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

import { renderWorkflow } from '../../../../tooling/lib/workflow-render.js';
import { WORKFLOWS } from '../../../../tooling/render-workflows.js';
import { RESYNC_META } from '../../../../tooling/workflows/resync.meta.js';
import { runResync } from '../../../../tooling/workflows/resync.js';

import type { FakeRun } from './_fake-hooks.js';
import { BRANCH, DOC_INDEX_CONFLICT, resyncHooks } from './_fake-resync.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const META_HEAD = 'export const meta = ';

let resyncJs = '';
beforeAll(async () => {
  const spec = WORKFLOWS.find((w) => w.name === 'resync');
  if (spec === undefined) throw new Error('no resync row in WORKFLOWS');
  resyncJs = await renderWorkflow(spec, ROOT);
});

/**
 * Run a rendered `resync.js` over a fake run's hooks, as the runtime
 * wraps it: `export` dropped, an async function body, hooks and `args` as
 * globals.
 *
 * @param js - The rendered workflow.
 * @param run - The fake run whose hooks become the globals.
 * @param args - The launch arguments.
 * @returns The workflow's result.
 */
function runRendered(js: string, run: FakeRun, args: string): Promise<unknown> {
  const script = `(async function () {\n${js.replace(/^export /, '')}\n})()`;
  // eslint-disable-next-line sonarjs/code-eval -- runs a fresh render of the repo's own sources, never user input
  return vm.runInContext(script, vm.createContext({ ...run.hooks, args })) as Promise<unknown>;
}

describe('resync.js — a fresh render of the current sources', () => {
  it('opens with a meta literal that evaluates to RESYNC_META', () => {
    const end = resyncJs.indexOf('\n};\n');

    expect(resyncJs.startsWith(META_HEAD)).toBe(true);
    // eslint-disable-next-line sonarjs/code-eval -- evaluates the render's meta literal alone
    const meta: unknown = vm.runInNewContext(`(${resyncJs.slice(META_HEAD.length, end + 2)})`);
    expect(meta).toEqual(RESYNC_META);
  });

  it('runs the resolution path with the same report, calls, timeline and phases as the source', async () => {
    const source = resyncHooks(DOC_INDEX_CONFLICT);
    const rendered = resyncHooks(DOC_INDEX_CONFLICT);

    const expected = await runResync(source.hooks, BRANCH);
    const report = await runRendered(resyncJs, rendered, BRANCH);

    expect(report).toEqual(expected);
    expect(report).toMatchObject({ status: 'done', sync: { verdict: 'resolved' } });
    expect(rendered.calls).toEqual(source.calls);
    expect(rendered.timeline).toEqual(source.timeline);
    expect(rendered.phases).toEqual(source.phases);
  });
});
