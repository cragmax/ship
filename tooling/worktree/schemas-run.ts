/**
 * Envelope schemas of the worktree CLI's run-branch commands — the commands
 * that cut, check and land an unattended run (ADR-0045): `cut-batch`,
 * `cut-slice`, `preflight` and `land` — of its epic-end commands:
 * `sync-master`, `bump`, `check-master` and `publish` — of `pr-review`,
 * with the findings file it writes, and of `pr-comment`. The canonical home
 * of their shapes; `types-run.ts` exports each as its `z.infer`. The base
 * fields, path spelling and integer rule are `schemas.ts`'s. A field that
 * names something the command creates or measures stays `null` until it
 * exists.
 */

import { z } from 'zod';

import { ResultBaseSchema } from './schemas.js';

/** How `cut-batch --attach` found the run branch's batch. */
export const AttachInfoSchema = z.object({
  /** The batch worktree was added now; `false` when it was already there and reused. */
  created: z.boolean(),
  /** The local branch was fast-forwarded to `origin`'s before the checkout. */
  fastForwarded: z.boolean(),
  /** The branch's open PR. */
  pr: z.int(),
});

/**
 * Envelope of `cut-batch <main> (--epic E | --issues N,… | --attach ship/<slug>)`;
 * `worktree` is the main checkout.
 */
export const CutBatchResultSchema = ResultBaseSchema.extend({
  /** The feature branch created or attached (`ship/<slug>`), short form. */
  branch: z.string().nullable(),
  /** The `master` commit the branch was cut at; with `--attach`, the branch's tip (the batch's `HEAD`). */
  base: z.string().nullable(),
  /** The run root. */
  runRoot: z.string().nullable(),
  /** The batch worktree. */
  batch: z.string().nullable(),
  /** The run's report directory. */
  reportDir: z.string().nullable(),
  /** How `--attach` found the batch; `null` for `--epic` / `--issues`, or before it is known. */
  attach: AttachInfoSchema.nullable(),
});

/** Envelope of `cut-slice <batch> --issue N --attempt K`; `worktree` is the batch. */
export const CutSliceResultSchema = ResultBaseSchema.extend({
  /** The slice branch created (`slice/<slug>/<N>-<K>`), short form. */
  branch: z.string().nullable(),
  /** The batch `HEAD` the slice was cut at. */
  base: z.string().nullable(),
  /** The slice worktree. */
  slice: z.string().nullable(),
});

/** A pre-flight check that can fail. */
export const PreflightCheckSchema = z.enum([
  'master-ahead',
  'master-behind',
  'gh-auth',
  'warm-unreachable',
]);

/** One failed pre-flight check. */
export const PreflightProblemSchema = z.object({
  /** Which check. */
  check: PreflightCheckSchema,
  /** What it found, naming the count or the member. */
  message: z.string(),
});

/** Envelope of `preflight <main>`; `worktree` is the main checkout. */
export const PreflightResultSchema = ResultBaseSchema.extend({
  /** Local `master` commits not on `origin/master`, after the fetch. */
  ahead: z.int().nullable(),
  /** `origin/master` commits not on local `master`, after the fetch. */
  behind: z.int().nullable(),
  /**
   * The main checkout as the run starts from it, and the launch shas of
   * local `master` and of `origin`'s as `git ls-remote` reports it: the
   * baseline of the epic end's master check.
   */
  snapshot: z
    .object({
      head: z.string(),
      dirty: z.boolean(),
      master: z.object({
        /** Local `refs/heads/master`. */
        local: z.string(),
        /** `origin`'s `refs/heads/master`, read live with `git ls-remote`, never the tracking ref. */
        remote: z.string(),
      }),
    })
    .nullable(),
  /**
   * Every failed check found before the command ended; when no step failed,
   * non-empty exactly when `reason` is `preflight-failed`.
   */
  problems: z.array(PreflightProblemSchema),
});

/** Envelope of `land <batch> <slice-sha> …`; `worktree` is the batch. */
export const LandResultSchema = ResultBaseSchema.extend({
  /** The slice commit's full sha; `null` until it resolves. */
  sha: z.string().nullable(),
  /** The new batch commit's sha; `null` unless the commit landed. */
  commit: z.string().nullable(),
  /** The harvest's `files`: every path the slice commit changes, both endpoints of a rename, sorted. */
  files: z.array(z.string()),
  /** The harvest's `conflicts`: paths that would not apply. */
  conflicts: z.array(z.string()),
  /** Whether a started harvest was reset and the batch verified clean afterwards. */
  rolledBack: z.boolean(),
  /**
   * Re-verified as the command exits: the batch's status is empty and no
   * merge, cherry-pick or revert is in progress. `false` when it cannot be
   * checked.
   */
  batchClean: z.boolean(),
});

/**
 * How `sync-master` treats a conflicted path: `lockfile` is regenerated,
 * `doc-index` goes to a resolver, `package` — a `package.json` conflict
 * confined to the top-level version line — is resolved by the version rule,
 * `code` refuses the merge.
 */
export const ConflictKindSchema = z.enum(['lockfile', 'doc-index', 'package', 'code']);

/** One path the `origin/master` merge conflicts on. */
export const ConflictPathSchema = z.object({
  /** Repository-relative, as git spells it. */
  path: z.string(),
  kind: ConflictKindSchema,
  /**
   * First-parent subjects of the `origin/master` commits since the
   * merge-base that touched it, newest first, capped at `sync-master.ts`'s
   * `LANDED_BY_LIMIT`: a PR landed by merge commit shows as
   * `Merge pull request #N …`.
   */
  landedBy: z.array(z.string()),
});

/** A `package.json` version at the merge-base and on each side. */
export const VersionTripleSchema = z.object({
  /** At the merge-base of the batch and `origin/master`. */
  base: z.string(),
  /** On the batch's `HEAD`. */
  ours: z.string(),
  /** On `origin/master`. */
  theirs: z.string(),
});

/** The `package.json` versions a merge saw, and the one it ends on. */
export const VersionLineSchema = VersionTripleSchema.extend({
  /** The version the version rule gives the merge (`package-version.ts` `targetVersion`). */
  result: z.string(),
});

/** Envelope of `sync-master <batch> [--continue]`; `worktree` is the batch. */
export const SyncMasterResultSchema = ResultBaseSchema.extend({
  /**
   * `up-to-date`: `origin/master` was already merged; `merged`: the merge
   * commit landed; `needs-resolution` (status `conflict`): doc-index paths
   * await a resolver, the merge kept in progress. `null` otherwise.
   */
  outcome: z.enum(['up-to-date', 'merged', 'needs-resolution']).nullable(),
  /** The merge commit; `null` unless `outcome` is `merged`. */
  commit: z.string().nullable(),
  /**
   * The `origin/master` sha the batch now contains — merged by this call or
   * found already merged: read from `origin/master` after the fetch (start
   * mode), or from `MERGE_HEAD` before a stopped merge's commit (`--continue`,
   * and start mode's own finish). The high-water mark the epic end's master
   * check measures `origin` against (#1095). `null` unless `outcome` is
   * `up-to-date` or `merged`.
   */
  upstream: z.string().nullable(),
  /** Every path the merge conflicts on, classified; start mode only. */
  conflicts: z.array(ConflictPathSchema),
  /**
   * The versions the merge saw; start mode only, once the merge-base is
   * known. `null` when any of the three `package.json` copies is missing or
   * has no top-level version line.
   */
  version: VersionLineSchema.nullable(),
  /** The paths still unmerged for a resolver, repository-relative, sorted; empty once merged. */
  pending: z.array(z.string()),
  /** Which batch refreshes ran on the merged tree. */
  refreshed: z.object({ ci: z.boolean(), build: z.boolean() }),
  /** The log files the merge and commit output went to, in the order written. */
  logs: z.array(z.string()),
});

/** Envelope of `bump <batch>`; `worktree` is the batch. */
export const BumpResultSchema = ResultBaseSchema.extend({
  /** `minor` when any subject is a `feat`, else `patch`. */
  kind: z.enum(['minor', 'patch']).nullable(),
  /** The version before the bump. */
  from: z.string().nullable(),
  /** The version after it. */
  to: z.string().nullable(),
  /** The bump commit; `null` unless it landed. */
  commit: z.string().nullable(),
  /** The file the commit's output (its hooks' included) went to. */
  log: z.string().nullable(),
});

/** A pull request `publish` opened, or found open with `--push-only`. */
export const OpenedPrSchema = z.object({ number: z.int(), url: z.string() });

/**
 * Envelope of `publish <batch> (--title T --body-file F | --push-only) --log L`;
 * `worktree` is the batch.
 */
export const PublishResultSchema = ResultBaseSchema.extend({
  /** Whether the push to `origin` ran and succeeded; `--push-only` skips a level branch's. */
  pushed: z.boolean(),
  /**
   * The PR opened; `null` unless `gh pr create` succeeded and printed its
   * URL. With `--push-only`: the open PR, once its mergeable state was read.
   */
  pr: OpenedPrSchema.nullable(),
  /**
   * The raw `gh pr view --json mergeable` value (`MERGEABLE`, `CONFLICTING`,
   * `UNKNOWN`, …) in `--push-only` mode, the last read; `null` in create
   * mode or before it was read.
   */
  mergeable: z.string().nullable(),
});

/** One `master` ref at the launch and now. */
export const MasterMoveSchema = z.object({
  /** The launch sha, as given. */
  launch: z.string(),
  /**
   * `origin`'s high-water sha, as given (`--synced`): the `origin/master` the
   * epic end's `sync-master` merged or found merged (#1095). `null` for local
   * `master`, and for `origin` when `--synced` was not given; either is then
   * judged against its launch sha only.
   */
  synced: z.string().nullable(),
  /** The current sha; `null` when the ref is deleted. */
  current: z.string().nullable(),
  /**
   * Judged against `launch`, then — when `synced` is set and that passed —
   * against `synced`; the reference is the last sha judged. `equal`: the
   * current sha is it; `forward`: it is an ancestor of the current one;
   * `rewound`: it is not (rewound or rewritten); `deleted`: the ref is gone;
   * `undecidable`: a sha is missing locally even after a fetch.
   */
  move: z.enum(['equal', 'forward', 'rewound', 'deleted', 'undecidable']),
});

/**
 * Envelope of `check-master <main> --local SHA --remote SHA [--synced SHA]`;
 * `worktree` is the main checkout.
 */
export const CheckMasterResultSchema = ResultBaseSchema.extend({
  /** Local `refs/heads/master`; `null` until checked. */
  local: MasterMoveSchema.nullable(),
  /** `origin`'s `refs/heads/master`, read with `git ls-remote`; `null` until checked. */
  remote: MasterMoveSchema.nullable(),
});

/** The `/code-review` effort level `pr-review` runs at. */
export const PrReviewLevelSchema = z.enum(['xhigh', 'max']);

/**
 * How `pr-review` ended: `reviewed`, the one `ok` outcome, or the outcome of
 * the phase that failed (`pr-review.ts` maps each) — `cap` when the session
 * ran past its cap and its process tree was killed.
 */
export const PrReviewOutcomeSchema = z.enum([
  'reviewed',
  'setup-failed',
  'launch-failed',
  'cap',
  'exit-nonzero',
  'unparseable',
  'write-failed',
]);

/** One finding of a review, as the findings file carries it. */
export const ReviewFindingSchema = z.object({
  /** Repository-relative, as the reviewer named it. */
  file: z.string(),
  line: z.int().nonnegative(),
  summary: z.string(),
  failure_scenario: z.string(),
  /** The `ReportFindings` verdict (`CONFIRMED`, `PLAUSIBLE`, …), as given; `null` without a matching entry. */
  verdict: z.string().nullable(),
  /** The `ReportFindings` category, as given; `null` without a matching entry. */
  category: z.string().nullable(),
});

/** The findings file `pr-review` writes: `<report-dir>/pr-review-<N>-findings.json`. */
export const ReviewFindingsFileSchema = z.object({
  pr: z.int(),
  level: PrReviewLevelSchema,
  model: z.string(),
  /** The PR's base commit the review diffed from. */
  base: z.string(),
  /** The PR's head commit the review diffed to, and the clone's checkout. */
  head: z.string(),
  /** A top-level `ReportFindings` call was read from the stream. */
  reportFindings: z.boolean(),
  /** In the order the findings block lists them. */
  findings: z.array(ReviewFindingSchema),
});

/**
 * Envelope of `pr-review <checkout> --pr N --level (xhigh|max) --model M --report-dir DIR`;
 * `worktree` is the checkout. A failure's reason is `errors[0].message`.
 */
export const PrReviewResultSchema = ResultBaseSchema.extend({
  pr: z.int(),
  level: PrReviewLevelSchema,
  model: z.string(),
  outcome: PrReviewOutcomeSchema,
  /** The PR's base commit as `gh` named it; `null` before it answered. */
  base: z.string().nullable(),
  /** The PR's head commit as `gh` named it; `null` before it answered. */
  head: z.string().nullable(),
  /** The throwaway clone, `<temp root>/clone`; `null` before the temp root exists. */
  clone: z.string().nullable(),
  /** `false` only when a temp root was made and still exists after cleanup. */
  cloneRemoved: z.boolean(),
  /**
   * The session's exit code; `null` when it never started, ended by a
   * signal, or was killed at the cap.
   */
  exitCode: z.int().nullable(),
  /** Wallclock from the command's start to after its cleanup. */
  durationMs: z.int().nonnegative(),
  /** How many findings the review wrote; `null` unless `reviewed`. */
  findingCount: z.int().nonnegative().nullable(),
  /** The findings file; `null` unless `reviewed`. */
  findingsFile: z.string().nullable(),
  /** The `/code-review` result text, verbatim; `null` unless `reviewed`. */
  resultFile: z.string().nullable(),
  /** `pr-review-<N>-plain.md`, the plain render of the findings; `null` unless `reviewed`. */
  plainFile: z.string().nullable(),
});

/**
 * How `pr-comment` ended: `posted`, the one `ok` outcome, or the step that
 * stopped it — `unreadable` (read), `too-long` (size), `missing-findings`
 * (check), `post-failed` (post).
 */
export const PrCommentOutcomeSchema = z.enum([
  'posted',
  'unreadable',
  'too-long',
  'missing-findings',
  'post-failed',
]);

/**
 * Envelope of `pr-comment <checkout> --pr N --body-file F`; `worktree` is the
 * checkout. A failure's reason is `errors[0].message`.
 */
export const PrCommentResultSchema = ResultBaseSchema.extend({
  pr: z.int(),
  /** The comment file, as given; never removed. */
  file: z.string(),
  outcome: PrCommentOutcomeSchema,
  /** The file's length in UTF-16 code units; `null` when it could not be read. */
  chars: z.int().nonnegative().nullable(),
  /** The comment URL `gh` printed; `null` unless posted, or when it printed none. */
  url: z.string().nullable(),
});
