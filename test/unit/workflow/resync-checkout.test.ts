// regression: resync's runner calls named no checkout, so a session `cd` mid-run moved the
// directory every later call resolved `node_modules/@cragmax/ship/dist/cli/worktree.js` against
import { describe, expect, it } from 'vitest';

import { runResync } from '../../../src/workflow/resync.js';

import { checkoutLines, liveRuns, MAIN } from './_fake-hooks.js';
import { attachOk, BRANCH, MERGED, resyncHooks } from './_fake-resync.js';

describe('runResync — every call after live-runs runs from the main checkout', () => {
  it('gives every runner call after live-runs a Checkout line naming its worktree, the spent-run cleanup included, and live-runs none', async () => {
    const live = liveRuns({})['runner:live-runs'];
    const run = resyncHooks({
      'runner:live-runs': { ...live, worktree: MAIN },
      'runner:cut-batch': attachOk(true),
      ...MERGED,
    });

    const report = await runResync(run.hooks, BRANCH);

    expect(report).toMatchObject({ status: 'done', cleanup: { retired: ['ship/old-0'] } });
    const [first, ...later] = checkoutLines(run);
    expect(first).toEqual({ label: 'runner:live-runs:resync', checkout: [] });
    expect(later).toEqual([
      { label: 'runner:teardown:spent-1', checkout: [`Checkout: ${MAIN}`] },
      { label: 'runner:retire-run:spent-1', checkout: [`Checkout: ${MAIN}`] },
      { label: 'runner:cut-batch:resync', checkout: [`Checkout: ${MAIN}`] },
      { label: 'runner:provision-batch:resync', checkout: [`Checkout: ${MAIN}`] },
      { label: 'runner:sync-master:resync', checkout: [`Checkout: ${MAIN}`] },
      { label: 'runner:publish:resync', checkout: [`Checkout: ${MAIN}`] },
    ]);
  });

  it.each([
    [
      'names no checkout',
      { ...liveRuns({})['runner:live-runs'], worktree: null },
      'live-runs named no main checkout',
    ],
    ['returns nothing', null, 'the runner returned nothing for live-runs'],
  ])('stops after live-runs when it %s, running nothing else', async (_name, answer, message) => {
    const run = resyncHooks({ 'runner:live-runs': answer });

    const report = await runResync(run.hooks, BRANCH);

    expect(report).toMatchObject({ status: 'stopped', message });
    expect(run.calls.map((c) => c.label)).toEqual(['runner:live-runs:resync']);
  });
});
