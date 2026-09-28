/**
 * The run scheduler's vocabulary (#1032): its input, events, actions, state
 * and transition. Type-only — erased at build, so it adds nothing to the
 * render closure (see `run-scheduler.ts`). The graph shapes are imported from
 * `run-set.ts` and never re-declared here.
 */

import type { RunEdge, RunGraph, RunSet } from './run-set.js';

/** What `createScheduler` takes: the gate's run graph plus the authoring cap. */
export type SchedulerInput = RunGraph & {
  /** The most issues in `authoring` at once; an integer, 1 or more. `landing` is uncapped. */
  readonly maxSlices: number;
};

/**
 * Something the workflow observed about one issue, fed to `advance`. Which
 * phases accept which kind is the lifecycle table in `run-scheduler.ts`.
 */
export type SchedulerEvent =
  | {
      /** The issue's commit landed. */
      readonly kind: 'committed';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /** The issue cannot land; its dependents are skipped. */
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
      /** The issue left the run (label removed, or closed); its dependents are skipped. */
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
      /** Authoring finished; the issue waits to land and releases its slot. */
      readonly kind: 'slot-free';
      /** The issue. */
      readonly issue: number;
    };

/** Why a dependent was skipped: the issue that went bad, and how. */
export interface SkipCause {
  /** The issue that went bad; the skipped issue depends on it transitively. */
  readonly root: number;
  /** How the root went bad. */
  readonly trigger: 'blocked' | 'label-removed' | 'retry-exhausted';
}

/** Something the workflow must do, returned by a transition. */
export type SchedulerAction =
  | {
      /** Cut a slice from the epic head, plan and author the issue. */
      readonly kind: 'start';
      /** The issue. */
      readonly issue: number;
    }
  | {
      /** Never run the issue: a transitive blocker went bad. */
      readonly kind: 'skip';
      /** The issue. */
      readonly issue: number;
      /** The blocker that went bad. */
      readonly cause: SkipCause;
    }
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
      /** The issue is blocked: its agent died a second time. */
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
    };

/** Where one issue is in its lifecycle. The last four are terminal (settled). */
export type IssuePhase =
  | 'waiting'
  | 'ready'
  | 'authoring'
  | 'landing'
  | 'committed'
  | 'blocked'
  | 'removed'
  | 'skipped';

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
  /** The deduplicated edges. */
  readonly edges: readonly RunEdge[];
  /** Every issue, in input order (entry index, then position in the entry). */
  readonly order: readonly number[];
  /** Each issue's direct blockers. */
  readonly blockers: Readonly<Record<number, readonly number[]>>;
  /** Each issue's phase. */
  readonly phase: Readonly<Record<number, IssuePhase>>;
  /** Issues whose one retry is spent. */
  readonly retried: Readonly<Record<number, true>>;
  /** The ready queue, head first. */
  readonly ready: readonly number[];
  /** Per entry (by index): whether its `epic-done` was emitted. */
  readonly epicDone: readonly boolean[];
}

/** One step's result: the next state and the actions to execute, in order. */
export interface Transition {
  /** The next state. */
  readonly state: SchedulerState;
  /** The actions, in execution order (the fixed order is stated in `run-scheduler.ts`). */
  readonly actions: readonly SchedulerAction[];
}
