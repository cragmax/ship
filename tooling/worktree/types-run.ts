/**
 * Envelopes of the worktree CLI's run-branch commands — the commands that
 * cut, check and land an unattended run (ADR-0045): `cut-batch`,
 * `cut-slice`, `preflight` and `land`. The status semantics, path spelling
 * and error classes are `types.ts`'s. A field that names something the
 * command creates or measures stays `null` until it exists.
 */

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
