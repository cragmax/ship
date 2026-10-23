/**
 * The run scheduler's vocabulary: its input, events, actions, state
 * and transition. Type-only — erased at build, so it adds nothing to the
 * render closure (see `run-scheduler.ts`). The graph shapes are imported from
 * `run-set.ts` and never re-declared here.
 */

import type { RunEdge, RunGraph, RunSet } from '../run-set.js';

/**
 * Where a scheduler edge came from: `declared`, a `blocked_by` the run gate found; `overlap`, an
 * edge pre-flight's overlap estimate added.
 */
export type EdgeSource = 'declared' | 'overlap';

/** A scheduler edge with its source. */
export interface SchedulerEdge extends RunEdge {
  /** Where the edge came from. */
  readonly source: EdgeSource;
}

/**
 * What `createScheduler` takes: the gate's run graph, each edge with an optional source (absent
 * reads `declared`), plus the authoring cap.
 */
export type SchedulerInput = Omit<RunGraph, 'edges'> & {
  /** The edges; see {@link RunGraph.edges}. */
  readonly edges: readonly (RunEdge & { readonly source?: EdgeSource })[];
  /**
   * The most issues in `authoring` at once; an integer, 1 or more. The cap bounds `authoring`
   * only: `slot-free`, settlement, requeue and retry release a slot, and `landing` (authored,
   * waiting in the commit queue) holds none and is uncapped.
   */
  readonly maxSlices: number;
};

/**
 * Something the workflow observed about one issue — or, for `epic-halt`,
 * one entry — fed to `advance`. Which phases accept which kind: {@link IssuePhase}.
 */
export type SchedulerEvent =
  | {
      /** The issue's commit landed. */
      readonly kind: 'committed';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /**
       * The issue cannot land; it settles without landing (see {@link ReleasedEdge}). No action
       * comes back for it: record the issue as `see #N` when feeding it.
       */
      readonly kind: 'blocked';
      /** The issue. */
      readonly issue: number;
      /** Why, for the workflow's own record; the scheduler does not read it. */
      readonly reason: string;
    }
  | {
      /** The harvest conflicted; the slice is discarded and the issue restarts. */
      readonly kind: 'harvest-conflict';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /**
       * The issue left the run (label removed, or closed); it settles without landing (see
       * {@link ReleasedEdge}). No action comes back for it: record the issue as `see #N` when
       * feeding it.
       */
      readonly kind: 'label-removed';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /** The issue's agent died; the first death retries, the second blocks. */
      readonly kind: 'agent-died';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /**
       * Authoring finished; the issue waits to land and releases its slot. Optional: a workflow
       * that never sends it bounds everything in flight, not only authoring.
       */
      readonly kind: 'slot-free';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /**
       * A landing left the entry's batch unverified (the landing → halt mapping is the commit
       * queue's `settleEvents`): stop the entry — no more starts or landings, and no epic end; its
       * in-flight issues keep their phase and slot. Keyed by entry, not issue. After feeding it,
       * feed `blocked` for the halting issue and for each other in-flight issue of the entry,
       * each slice torn down before its `blocked` is fed.
       */
      readonly kind: 'epic-halt';
      /** The entry's `epic` key (`null` for an explicit list). */
      readonly epic: number | null;
      /** Why, for the workflow's own record; the scheduler does not read it. */
      readonly reason: string;
    };

/** The events keyed by issue: every kind but `epic-halt`. */
export type IssueEvent = Exclude<SchedulerEvent, { readonly kind: 'epic-halt' }>;

/** Why a dependent was skipped: the issue that went bad, and how. */
export interface SkipCause {
  /** The issue that went bad; the skipped issue depends on it along declared edges. */
  readonly root: number;
  /** How the root went bad. */
  readonly trigger: 'blocked' | 'label-removed' | 'retry-exhausted';
}

/**
 * An overlap edge whose head settled without landing, so its tail no longer waits for it. An issue
 * that settles without landing (`blocked`, `label-removed`, a second `agent-died`) skips every
 * still-waiting issue it reaches along declared edges, and releases each overlap edge out of
 * itself or a dependent it skipped whose tail is still waiting: an issue that lands nothing touches
 * nothing.
 */
export interface ReleasedEdge {
  /** The edge's head: the issue that landed nothing. */
  readonly blocker: number;
  /** The edge's tail, which no longer waits for the head. */
  readonly dependent: number;
  /** How the head settled: its own trigger, or `skipped` when a declared blocker of it went bad. */
  readonly trigger: SkipCause['trigger'] | 'skipped';
}

/** Something the workflow must do, returned by a transition. */
export type SchedulerAction =
  | {
      /**
       * Cut a slice from the epic head, re-check readiness with `ship/src/cli/run-gate.ts check` —
       * feed a not-ready result (a missing label, a closed issue) as `label-removed` — then
       * author the issue.
       */
      readonly kind: 'start';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /**
       * Never run the issue: a blocker along declared edges went bad. Record the issue as `see #N`.
       */
      readonly kind: 'skip';
      /** The issue. */
      readonly issue: number;
      /** The blocker that went bad. */
      readonly cause: SkipCause;
    }
  | ({
      /** Record the released overlap edge in the run report. */
      readonly kind: 'release';
    } & ReleasedEdge)
  | {
      /** Discard the issue's slice after a harvest conflict; a later `start` restarts it. */
      readonly kind: 'requeue';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /** Discard the issue's slice after its agent died; a later `start` restarts it. */
      readonly kind: 'retry';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /**
       * The issue is blocked: its agent died a second time. Tear its slice down and record the
       * issue as `see #N`.
       */
      readonly kind: 'block';
      /** The issue. */
      readonly issue: number;
      /** The agent died again after the issue's one retry was spent. */
      readonly reason: 'retry-exhausted';
    }
  | {
      /** Every issue of the entry has settled: run the epic end. */
      readonly kind: 'epic-done';
      /** The entry's `epic` key (`null` for an explicit list). */
      readonly epic: number | null;
    }
  | {
      /**
       * Every issue of the halted entry has settled: skip the epic end — no PR — and record the
       * entry's unlanded issues as `see #N`.
       */
      readonly kind: 'epic-halted';
      /** The entry's `epic` key (`null` for an explicit list). */
      readonly epic: number | null;
    };

/**
 * Where one issue is in its lifecycle. `waiting` → `ready` once every edge in is committed or
 * released; `ready` → `authoring` on a free slot (`start`); `authoring` → `landing` on
 * `slot-free`. From `authoring` / `landing`: `committed` → `committed`; `blocked` → `blocked`,
 * settling without landing ({@link ReleasedEdge}); `harvest-conflict` (`requeue`) or a first
 * `agent-died` (`retry`) → the ready-queue front; a second `agent-died` → `blocked` (`block`,
 * likewise). `label-removed` takes `waiting` / `ready` / `authoring` / `landing` → `removed`,
 * likewise. `waiting` → `skipped` (`skip`) when a blocker along declared edges is blocked or
 * removed. An entry's `epic-halt` takes its `waiting` / `ready` issues → `halted`; in a halted
 * entry an in-flight issue's `blocked`, `harvest-conflict` or `agent-died` settles it `halted` (no
 * retry, requeue or skips), `committed` throws, and `slot-free` / `label-removed` behave as in
 * any entry. The last five phases are terminal (settled) and accept no event; `ACCEPTED_PHASES`
 * in `run-scheduler.ts` is the code home of which phase accepts which event.
 */
export type IssuePhase =
  | 'waiting'
  | 'ready'
  | 'authoring'
  | 'landing'
  | 'committed'
  | 'blocked'
  | 'removed'
  | 'skipped'
  | 'halted';

/**
 * The scheduler's state: readonly plain data (records and arrays only), so it
 * is JSON-serialisable and deep-freezable. Opaque to consumers, who only pass
 * it back into `advance`.
 */
export interface SchedulerState {
  /** The authoring cap. */
  readonly maxSlices: number;
  /** A copy of the input run set (entry order and issue order are the input order). */
  readonly runSet: RunSet;
  /** The deduplicated edges, each with its source. */
  readonly edges: readonly SchedulerEdge[];
  /** Every issue, in input order (entry index, then position in the entry). */
  readonly order: readonly number[];
  /** Each issue's phase. */
  readonly phase: Readonly<Record<number, IssuePhase>>;
  /** Issues whose one retry is spent. */
  readonly retried: Readonly<Record<number, true>>;
  /**
   * The ready queue, head first: FIFO by when an issue became ready, ties by input order (entry
   * index, then position); a restarted issue goes to the front. After every transition the queue
   * is empty or the `authoring` count equals `maxSlices`.
   */
  readonly ready: readonly number[];
  /**
   * Per entry (by index): whether its end action was emitted — `epic-done`,
   * or `epic-halted` for a halted entry.
   */
  readonly epicDone: readonly boolean[];
  /** Per entry (by index): whether it was fed `epic-halt`. */
  readonly halted: readonly boolean[];
}

/** One step's result: the next state and the actions to execute, in order. */
export interface Transition {
  /** The next state. */
  readonly state: SchedulerState;
  /**
   * The actions, in execution order: the direct response (`requeue` / `retry` / `block`), then
   * `skip`s ascending by issue, then `release`s ascending by (`blocker`, `dependent`), then
   * `start`s in queue order, then `epic-done` / `epic-halted` in input order. Each entry gets
   * exactly one end action, in the transition where its last issue settles (for a halt with
   * nothing in flight, the halt's own transition).
   */
  readonly actions: readonly SchedulerAction[];
}
