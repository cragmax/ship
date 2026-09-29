// Executes the committed render: resync.test.ts drives the TS sources, so a defect only the render carries passes it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { RESYNC_META } from '../../../../tooling/workflows/resync.meta.js';
import { runResync } from '../../../../tooling/workflows/resync.js';

import type { FakeRun } from './_fake-hooks.js';
import { BRANCH, DOC_INDEX_CONFLICT, resyncHooks } from './_fake-resync.js';

const RESYNC_JS = readFileSync(
  resolve(import.meta.dirname, '../../../../.claude/workflows/resync.js'),
  'utf8',
).replaceAll('\r\n', '\n');

const META_HEAD = 'export const meta = ';

/**
 * Run the committed `resync.js` over a fake run's hooks, as the runtime
 * wraps it: `export` dropped, an async function body, hooks and `args` as
 * globals.
 *
 * @param run - The fake run whose hooks become the globals.
 * @param args - The launch arguments.
 * @returns The workflow's result.
 */
function runRendered(run: FakeRun, args: string): Promise<unknown> {
  const script = `(async function () {\n${RESYNC_JS.replace(/^export /, '')}\n})()`;
  // eslint-disable-next-line sonarjs/code-eval -- runs the committed render, never user input
  return vm.runInContext(script, vm.createContext({ ...run.hooks, args })) as Promise<unknown>;
}

describe('resync.js — the committed render', () => {
  it('opens with a meta literal that evaluates to RESYNC_META', () => {
    const end = RESYNC_JS.indexOf('\n};\n');

    expect(RESYNC_JS.startsWith(META_HEAD)).toBe(true);
    // eslint-disable-next-line sonarjs/code-eval -- evaluates the committed render's literal alone
    const meta: unknown = vm.runInNewContext(`(${RESYNC_JS.slice(META_HEAD.length, end + 2)})`);
    expect(meta).toEqual(RESYNC_META);
  });

  it('runs the resolution path with the same report, calls, timeline and phases as the source', async () => {
    const source = resyncHooks(DOC_INDEX_CONFLICT);
    const rendered = resyncHooks(DOC_INDEX_CONFLICT);

    const expected = await runResync(source.hooks, BRANCH);
    const report = await runRendered(rendered, BRANCH);

    expect(report).toEqual(expected);
    expect(report).toMatchObject({ status: 'done', sync: { verdict: 'resolved' } });
    expect(rendered.calls).toEqual(source.calls);
    expect(rendered.timeline).toEqual(source.timeline);
    expect(rendered.phases).toEqual(source.phases);
    expect(rendered.violations).toEqual([]);
  });
});
