/**
 * Envelopes of the worktree CLI's run-branch commands — the commands that
 * cut, check and land an unattended run (ADR-0045): `cut-batch`,
 * `cut-slice`, `preflight` and `land` — and of its epic-end commands:
 * `sync-master`, `bump`, `publish` and `server-tier`. The status semantics,
 * path spelling and error classes are `types.ts`'s. A field that names
 * something the command creates or measures stays `null` until it exists.
 */

import type { LeaseTiming } from '../lib/lease-timings.js';

import type { VersionTriple } from './package-version.js';
import type { ResultBase } from './types.js';

/** How `cut-batch --attach` found the run branch's batch. */
export interface AttachInfo {
  /** The batch worktree was added now; `false` when it was already there and reused. */
  readonly created: boolean;
  /** The local branch was fast-forwarded to `origin`'s before the checkout. */
  readonly fastForwarded: boolean;
  /** The branch's open PR. */
  readonly pr: number;
}

/**
 * Envelope of `cut-batch <main> (--epic E | --issues N,… | --attach ship/<slug>)`;
 * `worktree` is the main checkout.
 */
export interface CutBatchResult extends ResultBase {
  /** The feature branch created or attached (`ship/<slug>`), short form. */
  branch: string | null;
  /** The `master` commit the branch was cut at; with `--attach`, the branch's tip (the batch's `HEAD`). */
  base: string | null;
  /** The run root. */
  runRoot: string | null;
  /** The batch worktree. */
  batch: string | null;
  /** The run's report directory. */
  reportDir: string | null;
  /** How `--attach` found the batch; `null` for `--epic` / `--issues`, or before it is known. */
  attach: AttachInfo | null;
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
 * `doc-index` goes to a resolver, `package` — a `package.json` conflict
 * confined to the top-level version line — is resolved by the version rule,
 * `code` refuses the merge.
 */
export type ConflictKind = 'lockfile' | 'doc-index' | 'package' | 'code';

/** One path the `origin/master` merge conflicts on. */
export interface ConflictPath {
  /** Repository-relative, as git spells it. */
  readonly path: string;
  readonly kind: ConflictKind;
  /**
   * First-parent subjects of the `origin/master` commits since the
   * merge-base that touched it, newest first, capped at `sync-master.ts`'s
   * `LANDED_BY_LIMIT`: a PR landed by merge commit shows as
   * `Merge pull request #N …`.
   */
  readonly landedBy: readonly string[];
}

/** The `package.json` versions a merge saw, and the one it ends on. */
export interface VersionLine extends VersionTriple {
  /** The version the version rule gives the merge (`package-version.ts` `targetVersion`). */
  readonly result: string;
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
  /**
   * The versions the merge saw; start mode only, once the merge-base is
   * known. `null` when any of the three `package.json` copies is missing or
   * has no top-level version line.
   */
  version: VersionLine | null;
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

/** A pull request `publish` opened, or found open with `--push-only`. */
export interface OpenedPr {
  readonly number: number;
  readonly url: string;
}

/**
 * Envelope of `publish <batch> (--title T --body-file F | --push-only) --log L`;
 * `worktree` is the batch.
 */
export interface PublishResult extends ResultBase {
  /** Whether the push to `origin` ran and succeeded; `--push-only` skips a level branch's. */
  pushed: boolean;
  /**
   * The PR opened; `null` unless `gh pr create` succeeded and printed its
   * URL. With `--push-only`: the open PR, once its mergeable state was read.
   */
  pr: OpenedPr | null;
  /**
   * The raw `gh pr view --json mergeable` value (`MERGEABLE`, `CONFLICTING`,
   * `UNKNOWN`, …) in `--push-only` mode, the last read; `null` in create
   * mode or before it was read.
   */
  mergeable: string | null;
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
