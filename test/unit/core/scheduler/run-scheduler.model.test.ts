/**
 * Property model for the run scheduler. The harness is `_run-scheduler-model.ts`.
 * The same property runs against the real scheduler (must hold) and against each mutant (must
 * fail with its paired invariant), so a later checker "simplification" cannot silently disarm one.
 * `requeued-restarted` has no twin: a withheld restart `start` with a free slot trips
 * `work-conserving` first, and with no free slot it is no violation.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

import { advance, createScheduler } from '../../../../src/core/scheduler/run-scheduler.js';
import type {
  SchedulerState,
  Transition,
} from '../../../../src/core/scheduler/run-scheduler.types.js';

import {
  arbChoices,
  arbInput,
  arbPlantedCycle,
  InvariantViolation,
  MUTANTS,
  runModel,
} from './_run-scheduler-model.js';

describe('run scheduler model — the real scheduler upholds every invariant', () => {
  it('holds over arbitrary run graphs and event scripts', () => {
    expect(() => {
      fc.assert(
        fc.property(arbInput(), arbChoices(), (input, choices) => {
          runModel(input, choices);
        }),
        { numRuns: 200 },
      );
    }).not.toThrow();
  });

  it('rejects every planted cycle, naming each member of the ring', () => {
    fc.assert(
      fc.property(arbPlantedCycle(), ({ input, ring }) => {
        let message = '';

        try {
          createScheduler(input);
        } catch (err) {
          message = (err as Error).message;
        }

        expect(message).toMatch(/^run scheduler: dependency cycle among /);
        for (const member of ring) expect(message).toMatch(new RegExp(`#${member}(?!\\d)`));
      }),
      { numRuns: 200 },
    );
  });

  it('replays a recorded event script to identical transitions', () => {
    fc.assert(
      fc.property(arbInput(), arbChoices(), (input, choices) => {
        const trace = runModel(input, choices);
        const replayed = [createScheduler(input)];

        for (const event of trace.events) {
          replayed.push(advance(lastState(replayed), event));
        }

        expect(replayed).toEqual(trace.transitions);
      }),
      { numRuns: 100 },
    );
  });

  it('resumes from a JSON round-tripped mid-run state with identical actions', () => {
    fc.assert(
      fc.property(arbInput(), arbChoices(), fc.nat(), (input, choices, cut) => {
        const trace = runModel(input, choices);
        const k = cut % (trace.events.length + 1);
        const at = trace.transitions[k];
        if (at === undefined) throw new Error('unreachable');
        let state = JSON.parse(JSON.stringify(at.state)) as SchedulerState;
        const resumed: (readonly unknown[])[] = [];

        for (const event of trace.events.slice(k)) {
          const t = advance(state, event);
          resumed.push(t.actions);
          state = t.state;
        }

        expect(resumed).toEqual(trace.transitions.slice(k + 1).map((t) => t.actions));
      }),
      { numRuns: 100 },
    );
  });

  it('runs with every clock and randomness source stubbed to throw', () => {
    // Sample first: fast-check itself may seed from the clock.
    const samples = fc.sample(fc.tuple(arbInput(), arbChoices()), 50);

    const banned = (): never => {
      throw new Error('clock or randomness used');
    };

    const BannedDate = Object.assign(
      function BannedDate(): never {
        return banned();
      },
      { now: banned },
    );

    vi.spyOn(Math, 'random').mockImplementation(banned);
    vi.spyOn(performance, 'now').mockImplementation(banned);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(banned);
    vi.spyOn(crypto, 'randomUUID').mockImplementation(banned);
    vi.stubGlobal('Date', BannedDate);
    let completed = 0;
    let failure: unknown;

    try {
      for (const [input, choices] of samples) {
        runModel(input, choices);
        completed += 1;
      }
    } catch (err) {
      failure = err;
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    expect(failure).toBeUndefined();
    expect(completed).toBe(50);
  });
});

describe('run scheduler model — teeth: each mutant trips its paired invariant', () => {
  it.each(MUTANTS.map((m) => [m.name, m] as const))('%s', (_name, mutant) => {
    const details = fc.check(
      fc.property(arbInput(), arbChoices(), (input, choices) => {
        runModel(input, choices, mutant.machine);
      }),
      { numRuns: 500 },
    );

    expect(details.failed).toBe(true);
    expect(details.errorInstance).toBeInstanceOf(InvariantViolation);
    expect((details.errorInstance as InvariantViolation).invariant).toBe(mutant.trips);
  });
});

function lastState(transitions: readonly Transition[]): SchedulerState {
  const last = transitions[transitions.length - 1];
  if (last === undefined) throw new Error('unreachable');

  return last.state;
}
