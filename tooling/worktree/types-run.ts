/**
 * Envelopes of the worktree CLI's run-branch commands — the commands that
 * cut, check and land an unattended run (ADR-0045): `cut-batch`,
 * `cut-slice`, `preflight` and `land` — and of its epic-end commands:
 * `sync-master`, `bump`, `publish` and `server-tier`. The status semantics,
 * path spelling and error classes are `types.ts`'s. A field that names
 * something the command creates or measures stays `null` until it exists.
 */

import type { LeaseTiming } from '../lib/lease-timings.js';

import type { ResultBase } from './types.js';

/** Envelope of `cut-batch <main> (--epic E | --issues N,…)`; `worktree` is the main checkout. */
export interface CutBatchResult extends ResultBase {
  /** The feature branch created (`ship/<slug>`), short form. */
  branch: string | null;
  /** The `master` commit the branch was cut at. */
  base: string | null;
  /** The run root. */
  runRoot: string | null;
  /** The batch worktree. */
  batch: string | null;
  /** The run's report directory. */
  reportDir: string | null;
}

/** Envelope of `cut-slice <batch> --issue N --attempt K`; `worktree` is the batch. */
export interface CutSliceResult extends ResultBase {
  /** The slice branch created (`slice/<slug>/<N>-<K>`), short form. */
  branch: string | null;
  /** The batch `HEAD` the slice was cut at. */
  base: string | null;
  /** The slice worktree. */
  slice: string | null;
}

/** A pre-flight check that can fail. */
export type PreflightCheck = 'master-ahead' | 'master-behind' | 'gh-auth' | 'warm-unreachable';

/** One failed pre-flight check. */
export interface PreflightProblem {
  /** Which check. */
  readonly check: PreflightCheck;
  /** What it found, naming the count or the member. */
  readonly message: string;
}

/** Envelope of `preflight <main>`; `worktree` is the main checkout. */
export interface PreflightResult extends ResultBase {
  /** Local `master` commits not on `origin/master`, after the fetch. */
  ahead: number | null;
  /** `origin/master` commits not on local `master`, after the fetch. */
  behind: number | null;
  /** The main checkout as the run starts from it. */
  snapshot: { readonly head: string; readonly dirty: boolean } | null;
  /**
   * Every failed check found before the command ended; when no step failed,
   * non-empty exactly when `reason` is `preflight-failed`.
   */
  problems: PreflightProblem[];
}

/** Envelope of `land <batch> <slice-sha> …`; `worktree` is the batch. */
export interface LandResult extends ResultBase {
  /** The slice commit's full sha; `null` until it resolves. */
  sha: string | null;
  /** The new batch commit's sha; `null` unless the commit landed. */
  commit: string | null;
  /** The harvest's `files`: every path the slice commit changes, both endpoints of a rename, sorted. */
  files: string[];
  /** The harvest's `conflicts`: paths that would not apply. */
  conflicts: string[];
  /** Whether a started harvest was reset and the batch verified clean afterwards. */
  rolledBack: boolean;
  /**
   * Re-verified as the command exits: the batch's status is empty and no
   * merge, cherry-pick or revert is in progress. `false` when it cannot be
   * checked.
   */
  batchClean: boolean;
}

/**
 * How `sync-master` treats a conflicted path: `lockfile` is regenerated,
 * `doc-index` goes to a resolver, `code` refuses the merge.
 */
export type ConflictKind = 'lockfile' | 'doc-index' | 'code';

/** One path the `origin/master` merge conflicts on. */
export interface ConflictPath {
  /** Repository-relative, as git spells it. */
  readonly path: string;
  readonly kind: ConflictKind;
  /**
   * Subjects of the `origin/master` commits since the merge-base that touched
   * it, newest first, capped at `sync-master.ts`'s `LANDED_BY_LIMIT`.
   */
  readonly landedBy: readonly string[];
}

/** Envelope of `sync-master <batch> [--continue]`; `worktree` is the batch. */
export interface SyncMasterResult extends ResultBase {
  /**
   * `up-to-date`: `origin/master` was already merged; `merged`: the merge
   * commit landed; `needs-resolution` (status `conflict`): doc-index paths
   * await a resolver, the merge kept in progress. `null` otherwise.
   */
  outcome: 'up-to-date' | 'merged' | 'needs-resolution' | null;
  /** The merge commit; `null` unless `outcome` is `merged`. */
  commit: string | null;
  /** Every path the merge conflicts on, classified; start mode only. */
  conflicts: ConflictPath[];
  /** The paths still unmerged for a resolver, repository-relative, sorted; empty once merged. */
  pending: string[];
  /** Which batch refreshes ran on the merged tree. */
  refreshed: { ci: boolean; build: boolean };
  /** The log files the merge and commit output went to, in the order written. */
  logs: string[];
}

/** Envelope of `bump <batch>`; `worktree` is the batch. */
export interface BumpResult extends ResultBase {
  /** `minor` when any subject is a `feat`, else `patch`. */
  kind: 'minor' | 'patch' | null;
  /** The version before the bump. */
  from: string | null;
  /** The version after it. */
  to: string | null;
  /** The bump commit; `null` unless it landed. */
  commit: string | null;
  /** The file the commit's output (its hooks' included) went to. */
  log: string | null;
}

/** A pull request `publish` opened. */
export interface OpenedPr {
  readonly number: number;
  readonly url: string;
}

/** Envelope of `publish <batch> --title T --body-file F --log L`; `worktree` is the batch. */
export interface PublishResult extends ResultBase {
  /** Whether the push to `origin` succeeded. */
  pushed: boolean;
  /** The PR opened; `null` unless `gh pr create` succeeded and printed its URL. */
  pr: OpenedPr | null;
}

/** A server-tier run's test counts, from vitest's JSON report. */
export interface TierCounts {
  readonly passed: number;
  readonly failed: number;
  /** Skipped and todo tests together. */
  readonly skipped: number;
}

/** Envelope of `server-tier <batch> --engine E --registry R --log L`; `worktree` is the batch. */
export interface ServerTierResult extends ResultBase {
  /** The engine the run leased. */
  engine: 'paper' | 'folia';
  /** The version leased: the registry entry of the engine's warm member. */
  version: string | null;
  /** The `server`-tier files run, repository-relative, sorted. */
  files: string[];
  /** Vitest's JSON report, beside the log. */
  report: string | null;
  /** The counts; also on a red run (`failed`, step `tests`) when the report was written. */
  tests: TierCounts | null;
  /** The lease's timings; `null` when the output carries no lease line. */
  lease: LeaseTiming | null;
}
