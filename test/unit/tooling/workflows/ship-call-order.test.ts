// regression: a resumed run replayed live once two issues' calls interleave by settle timing
import { describe, expect, it } from 'vitest';

import { runShip, type ShipReport } from '../../../../tooling/workflows/ship.js';

import { fakeHooks, GATE_OK, readyVerdict, type FakeRun } from './_fake-hooks.js';
import { settleInOrder, type SettleOrder } from './_fake-parallel.js';

// No declared edge and no overlap pair (the default issue-overlap answers none),
// so only the cap keeps issue 8 from starting while issue 7 is in flight.
const TWO_INDEPENDENT = {
  'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
  issueReadiness: {
    issues: [7, 8].map((issue) => readyVerdict(issue)),
  },
};

/**
 * A fake run's call labels, in call order.
 *
 * @param run - The fake run.
 * @returns The labels.
 */
const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

/**
 * Ship `args` over {@link TWO_INDEPENDENT}, its answers settled at once or
 * one per standstill in `order`.
 */
async function shipUnder(
  order: SettleOrder | 'at once',
  args: string,
): Promise<{ run: FakeRun; report: ShipReport }> {
  if (order === 'at once') {
    const run = fakeHooks(TWO_INDEPENDENT);
    return { run, report: await runShip(run.hooks, args) };
  }
  const pump = settleInOrder(order);
  const run = fakeHooks(TWO_INDEPENDENT, { gate: pump.gate });
  return { run, report: await pump.drain(runShip(run.hooks, args)) };
}

describe('runShip — call order under different settle timings', () => {
  it('makes the same agent() calls in the same order through the epic end at --max-slices 1, however its answers settle', async () => {
    const args = 'issues 7 8 --max-slices 1';
    const atOnce = await shipUnder('at once', args);
    const oldest = await shipUnder('oldest', args);
    const newest = await shipUnder('newest', args);

    expect(oldest.report).toMatchObject({
      status: 'done',
      epics: [
        {
          outcome: 'pr',
          issues: [
            { issue: 7, outcome: 'landed' },
            { issue: 8, outcome: 'landed' },
          ],
        },
      ],
    });
    expect(labels(oldest.run)).toEqual(
      expect.arrayContaining([
        'epicReview:list',
        'retro:list',
        'prWriter:list',
        'runner:publish:list',
      ]),
    );
    expect(newest.run.calls).toEqual(oldest.run.calls);
    expect(oldest.run.calls).toEqual(atOnce.run.calls);
    expect(newest.report).toEqual(oldest.report);
  });

  it('interleaves the same calls differently by settle order with two independent issues in flight at --max-slices 2', async () => {
    const args = 'issues 7 8 --max-slices 2';
    const oldest = await shipUnder('oldest', args);
    const newest = await shipUnder('newest', args);

    const bothLanded = {
      status: 'done',
      epics: [
        {
          issues: [
            { issue: 7, outcome: 'landed' },
            { issue: 8, outcome: 'landed' },
          ],
        },
      ],
    };
    expect(oldest.report).toMatchObject(bothLanded);
    expect(newest.report).toMatchObject(bothLanded);
    expect(labels(newest.run)).not.toEqual(labels(oldest.run));
    const sorted = (run: FakeRun): string[] => labels(run).sort((a, b) => a.localeCompare(b));
    expect(sorted(newest.run)).toEqual(sorted(oldest.run));
  });
});
