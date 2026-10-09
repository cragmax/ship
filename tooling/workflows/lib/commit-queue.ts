/**
 * The `ship` workflow's commit queue: one promise chain per epic, so the epic's landings run one
 * at a time, plus the pure mappings from a landing's and a teardown's envelope to the scheduler
 * events an issue attempt ends with (ADR-0045 decision 6).
 *
 * **The settle rule** (the scheduler's consumer protocol, step 7): every attempt's slice is torn
 * down before its final events are fed. A halt — from the landing or from a teardown that found
 * a link target shrunk — feeds `epic-halt` for the entry, then `blocked` for the halting issue
 * itself, so the issue settles as halted and the entry can drain ({@link settleEvents}).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import type { SchedulerEvent } from '../../lib/run-scheduler.types.js';

import { envelopeProblem, type LandOutput, type TeardownOutput } from './tool-calls.js';

/**
 * A serial queue: each task starts once every earlier task has settled.
 * One per epic serialises its landings; the drive's run-wide one doubles as
 * the run's repo lock, serialising the epic ends' network-bearing steps
 * (`epic-end.ts`).
 */
export interface CommitQueue {
  /**
   * Queue a task.
   *
   * @param task - The work; its rejection never stalls the queue.
   * @returns Resolves or rejects as the task does.
   */
  readonly enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

/** The scheduler's `epic-halt` event. */
export type EpicHaltEvent = Extract<SchedulerEvent, { readonly kind: 'epic-halt' }>;

/**
 * An entry's halt state: `halting` once a landing or teardown calls for a
 * halt, `halted` once the scheduler is fed its one `epic-halt`.
 */
export type HaltState = 'running' | 'halting' | 'halted';

/** An attempt's settle events, and its entry's halt state after them. */
export interface Settled {
  /** The events, in feeding order. */
  readonly events: SchedulerEvent[];
  /** The entry's halt state once they are fed. */
  readonly entry: HaltState;
}

/** Which issue an event concerns, and its entry's `epic` key. */
export interface EventSubject {
  /** The issue. */
  readonly issue: number;
  /** Its entry's `epic` key; `null` for an explicit list. */
  readonly epic: number | null;
}

/** Create an empty commit queue. */
export function createCommitQueue(): CommitQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue: <T>(task: () => Promise<T>): Promise<T> => {
      const run = tail.then(() => task());
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/** What a landing did to the batch. */
export type LandingClass = 'committed' | 'conflict' | 'blocked' | 'halt';

/**
 * Classify a landing; `land` is `null` when the runner returned none.
 *
 * @returns `committed` for an `ok` carrying its commit; with the batch
 *   verified clean, `conflict` for a conflict and `blocked` for a refused
 *   `slice-not-single-commit` or a failed `commit` or `build` step that
 *   rolled back; otherwise `halt` — no output, a batch not verified clean,
 *   or any other outcome (`batch-dirty`, `main-worktree`,
 *   `unregistered-worktree`, `self-hosted`, `staged-mismatch`,
 *   `not-run-batch`; a failed `cherry-pick`, `rollback`, `preconditions` or
 *   `internal`).
 */
export function classifyLanding(land: LandOutput | null): LandingClass {
  if (land?.status === 'ok' && typeof land.commit === 'string') return 'committed';
  if (land?.batchClean !== true) return 'halt';
  if (land.status === 'conflict') return 'conflict';
  if (land.status === 'refused' && land.reason === 'slice-not-single-commit') return 'blocked';
  const step = land.errors?.[0]?.step;
  const rolledBackStep = step === 'commit' || step === 'build';
  if (land.status === 'failed' && land.rolledBack === true && rolledBackStep) return 'blocked';
  return 'halt';
}

/**
 * The event a landing ends its attempt with, by {@link classifyLanding}.
 *
 * @returns `committed`, `harvest-conflict`, `blocked` (naming the landing)
 *   or `epic-halt` (naming it) for the class.
 */
export function landingEvent(land: LandOutput | null, at: EventSubject): SchedulerEvent {
  const reason = envelopeProblem('land', land);
  switch (classifyLanding(land)) {
    case 'committed':
      return { kind: 'committed', issue: at.issue };
    case 'conflict':
      return { kind: 'harvest-conflict', issue: at.issue };
    case 'blocked':
      return { kind: 'blocked', issue: at.issue, reason };
    case 'halt':
      return { kind: 'epic-halt', epic: at.epic, reason };
  }
}

/**
 * The halt a teardown calls for; `teardown` is `null` when none ran or the runner returned none.
 *
 * @returns `epic-halt` for a refused `source-shrank` (a link was followed into
 *   its target); `null` otherwise.
 */
export function teardownEvent(
  teardown: TeardownOutput | null,
  epic: number | null,
): EpicHaltEvent | null {
  if (teardown?.status !== 'refused' || teardown.reason !== 'source-shrank') return null;
  return { kind: 'epic-halt', epic, reason: envelopeProblem('teardown', teardown) };
}

/**
 * What a teardown left behind, for the run report.
 *
 * @returns `null` for an `ok` teardown; otherwise one line naming the outcome.
 */
export function teardownResidue(teardown: TeardownOutput | null): string | null {
  return teardown?.status === 'ok' ? null : envelopeProblem('teardown', teardown);
}

/**
 * The events that settle an issue attempt, in feeding order — the file
 * header's settle rule.
 *
 * @param primary - What ended the attempt: the landing's event, or the
 *   chain's own (`blocked`, `agent-died`, `label-removed`, or `epic-halt`
 *   when it stopped for its halting entry).
 * @param halt - The halt the attempt called for — `primary` itself when it is
 *   an `epic-halt`; `null` for none.
 * @returns With a halt, `[epic-halt, blocked]` — `[blocked]` alone in an entry
 *   already halted — and the entry `halted`; for a `committed` in an entry
 *   already halted, which the scheduler refuses, `[blocked]`; otherwise
 *   `[primary]` and the entry's state unchanged.
 */
export function settleEvents(
  primary: SchedulerEvent,
  halt: EpicHaltEvent | null,
  at: EventSubject & { readonly entry: HaltState },
): Settled {
  if (halt !== null) {
    const blocked: SchedulerEvent = { kind: 'blocked', issue: at.issue, reason: halt.reason };
    return { events: at.entry === 'halted' ? [blocked] : [halt, blocked], entry: 'halted' };
  }
  if (at.entry === 'halted' && primary.kind === 'committed') {
    const blocked: SchedulerEvent = {
      kind: 'blocked',
      issue: at.issue,
      reason: 'landed after its epic halted',
    };
    return { events: [blocked], entry: 'halted' };
  }
  return { events: [primary], entry: at.entry };
}
