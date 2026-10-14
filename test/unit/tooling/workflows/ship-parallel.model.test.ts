// Drives the real runShip over generated run graphs, every agent() answer released by
// fc.scheduler(), and checks the invariants on the timeline.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SchedulerInput } from '../../../../tooling/lib/run-scheduler.types.js';
import type { ShipReport } from '../../../../tooling/workflows/ship.js';
import { runShip } from '../../../../tooling/workflows/ship.js';
import { arbInput } from '../_run-scheduler-model.js';

import {
  fakeHooks,
  GATE_OK,
  LAND_OK,
  TDD_GREEN,
  type FakeRun,
  type RecordedCall,
} from './_fake-hooks.js';

/** How one of an issue's first two attempts goes; every later attempt lands. */
type Outcome = 'ok' | 'conflict' | 'die';

const LAND_CONFLICT = {
  ...LAND_OK,
  status: 'conflict',
  commit: null,
  conflicts: ['tooling/x.ts'],
  rolledBack: true,
  errors: [{ step: 'cherry-pick', message: 'tooling/x.ts would not apply' }],
};

/** The most issues `arbInput` generates: three entries of six. */
const MAX_ISSUES = 18;

/** The events that end one attempt of an issue, as the run log names them. */
const ATTEMPT_ENDS = ['committed', 'blocked', 'harvest-conflict', 'agent-died', 'label-removed'];

/**
 * An issue and attempt from a `<stage>:<issue>-<attempt>` label.
 *
 * @param label - The label.
 * @returns Both numbers; `null` for a label without them.
 */
function attemptOf(label: string): { issue: number; attempt: number } | null {
  const match = /:(\d+)-(\d+)$/.exec(label);
  return match === null ? null : { issue: Number(match[1]), attempt: Number(match[2]) };
}

/**
 * The fake answers of one generated run.
 *
 * @param input - The run graph and cap.
 * @param script - Per issue (by run-set position), its first two attempts' outcomes.
 * @returns The answers.
 */
function answers(input: SchedulerInput, script: readonly (readonly Outcome[])[]) {
  const order = input.runSet.flatMap((e) => e.issues);
  const outcome = (label: string): Outcome => {
    const at = attemptOf(label);
    if (at === null || at.attempt > 2) return 'ok';
    return script[order.indexOf(at.issue)]?.[at.attempt - 1] ?? 'ok';
  };
  return {
    'runner:run-gate': { ...GATE_OK, runSet: input.runSet, edges: input.edges },
    scout: {
      issues: order.map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
    },
    tdd: (call: RecordedCall) => (outcome(call.label) === 'die' ? null : TDD_GREEN),
    'runner:land': (call: RecordedCall) =>
      outcome(call.label) === 'conflict' ? LAND_CONFLICT : LAND_OK,
  };
}

/**
 * A gate releasing every answer through the scheduler, tracking each
 * entry's outstanding issue landings.
 *
 * @param violations - Where a second outstanding landing is recorded.
 */
function scheduledGate(s: fc.Scheduler, input: SchedulerInput, violations: string[]) {
  const outstanding = input.runSet.map(() => 0);
  return (call: RecordedCall, answer: unknown): Promise<unknown> => {
    const at = call.label.startsWith('runner:land:') ? attemptOf(call.label) : null;
    const entry = at === null ? -1 : input.runSet.findIndex((e) => e.issues.includes(at.issue));
    if (entry < 0) return s.schedule(Promise.resolve(answer), call.label);
    if ((outstanding[entry] ?? 0) > 0) violations.push(`(iii) ${call.label} while another lands`);
    outstanding[entry] = (outstanding[entry] ?? 0) + 1;
    return s.schedule(Promise.resolve(answer), call.label).then((v) => {
      outstanding[entry] = (outstanding[entry] ?? 1) - 1;
      return v;
    });
  };
}

/**
 * Every timeline and report invariant a run broke.
 *
 * @returns One line per broken invariant.
 */
function brokenInvariants(run: FakeRun, input: SchedulerInput, report: ShipReport): string[] {
  const broken: string[] = [];
  const inFlight = new Set<number>();
  for (const line of run.timeline.filter((l) => l.startsWith('log '))) {
    const start = /^log start #(\d+) attempt/.exec(line);
    const fed = /^log fed (\S+) #(\d+)$/.exec(line);
    if (start !== null) inFlight.add(Number(start[1]));
    if (fed !== null && ATTEMPT_ENDS.includes(fed[1] ?? '')) inFlight.delete(Number(fed[2]));
    if (inFlight.size > input.maxSlices)
      broken.push(`(i) ${String(inFlight.size)} in flight at ${line}`);
  }
  for (const e of input.edges) {
    const started = run.timeline.indexOf(`log start #${String(e.dependent)} attempt 1`);
    const committed = run.timeline.indexOf(`log fed committed #${String(e.blocker)}`);
    if (started > -1 && (committed < 0 || started < committed)) {
      broken.push(`(ii) #${String(e.dependent)} started before #${String(e.blocker)} committed`);
    }
  }
  input.runSet.forEach((entry, i) => {
    const tag = entry.epic === null ? 'list' : `epic-${String(entry.epic)}`;
    const retros = run.calls.filter((c) => c.label === `retro:${tag}`).length;
    if (retros !== 1) broken.push(`(iv) ${String(retros)} retro calls for ${tag}`);
    const issues = report.epics[i]?.issues.map((r) => r.issue) ?? [];
    if (JSON.stringify(issues) !== JSON.stringify(entry.issues)) {
      broken.push(`(v) entry ${tag} reports ${JSON.stringify(issues)}`);
    }
  });
  return broken;
}

describe('runShip — concurrent model', () => {
  it('keeps the cap, the dependency order, one landing per epic and one retro per entry under any interleaving', async () => {
    const outcome = fc.constantFrom<Outcome>('ok', 'ok', 'conflict', 'die');
    const script = fc.array(fc.array(outcome, { minLength: 2, maxLength: 2 }), {
      minLength: MAX_ISSUES,
      maxLength: MAX_ISSUES,
    });
    await fc.assert(
      fc.asyncProperty(arbInput(), script, fc.scheduler(), async (input, outcomes, s) => {
        const violations: string[] = [];
        const run = fakeHooks(answers(input, outcomes), {
          gate: scheduledGate(s, input, violations),
        });

        const report = await s.waitFor(
          runShip(run.hooks, `epics 1 --max-slices ${String(input.maxSlices)}`),
        );

        expect(report.status).toBe('done');
        expect([...violations, ...brokenInvariants(run, input, report)]).toEqual([]);
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
