// Executes a fresh in-memory render of the current sources (renderWorkflow over WORKFLOWS):
// resync.test.ts drives the TS sources, so a defect only the render carries passes it.
// The committed file's freshness is gate:codegen's.
import vm from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

import { RESYNC_META } from '../../../src/workflow/resync.meta.js';
import { runResync } from '../../../src/workflow/resync.js';

import { BRANCH, MERGED, resyncHooks } from './_fake-resync.js';
import { renderFresh, runRendered } from './_render.js';

const META_HEAD = 'export const meta = ';

let resyncJs = '';
beforeAll(async () => {
  resyncJs = await renderFresh('resync');
});

describe('resync.js — a fresh render of the current sources', () => {
  it('opens with a meta literal that evaluates to RESYNC_META', () => {
    const end = resyncJs.indexOf('\n};\n');

    expect(resyncJs.startsWith(META_HEAD)).toBe(true);
    // eslint-disable-next-line sonarjs/code-eval -- evaluates the render's meta literal alone
    const meta: unknown = vm.runInNewContext(`(${resyncJs.slice(META_HEAD.length, end + 2)})`);
    expect(meta).toEqual(RESYNC_META);
  });

  it('runs the merge path with the same report, calls, timeline and phases as the source', async () => {
    const source = resyncHooks(MERGED);
    const rendered = resyncHooks(MERGED);

    const expected = await runResync(source.hooks, BRANCH);
    const report = await runRendered(resyncJs, rendered, BRANCH);

    expect(report).toEqual(expected);
    expect(report).toMatchObject({ status: 'done', sync: { verdict: 'merged' } });
    expect(rendered.calls).toEqual(source.calls);
    expect(rendered.timeline).toEqual(source.timeline);
    expect(rendered.phases).toEqual(source.phases);
  });
});
