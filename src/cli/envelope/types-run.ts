/**
 * Envelope types of the worktree CLI's run-branch commands (the commands
 * that cut, check and land an unattended run: `cut-batch`,
 * `cut-slice`, `preflight`, and `land`), of its epic-end commands:
 * `sync-master`, `check-master`, `publish`, `append-pr-body` and
 * `post-pr-comment`, and of `changed-files`, the slice chain's re-read.
 * Each is the `z.infer` of its schema in `schemas-run.ts`, the canonical
 * home of the shapes and their field docs. The status semantics and error
 * classes are `types.ts`'s.
 */

import type { z } from 'zod';

import type {
  AppendPrBodyResultSchema,
  ChangedFilesResultSchema,
  CheckMasterResultSchema,
  ConflictKindSchema,
  ConflictPathSchema,
  CutBatchResultSchema,
  CutSliceResultSchema,
  HookAttemptSchema,
  LandResultSchema,
  MasterMoveSchema,
  OpenedPrSchema,
  PostIssueCommentResultSchema,
  PostPrCommentResultSchema,
  PreflightCheckSchema,
  PreflightProblemSchema,
  PreflightResultSchema,
  PublishResultSchema,
  SyncMasterResultSchema,
  VersionLineSchema,
} from './schemas-run.js';

/** Envelope of `cut-batch <main> (--epic E | --issues N,… | --attach ship/<slug>)`. */
export type CutBatchResult = z.infer<typeof CutBatchResultSchema>;

/** Envelope of `cut-slice <batch> --issue N --attempt K`. */
export type CutSliceResult = z.infer<typeof CutSliceResultSchema>;

/** A pre-flight check that can fail. */
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;

/** One failed pre-flight check. */
export type PreflightProblem = z.infer<typeof PreflightProblemSchema>;

/** Envelope of `preflight <main>`. */
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

/** One run of a hook-running git command. */
export type HookAttempt = z.infer<typeof HookAttemptSchema>;

/** Envelope of `land <batch> <slice-sha> …`. */
export type LandResult = z.infer<typeof LandResultSchema>;

/** How `sync-master` treats a conflicted path. */
export type ConflictKind = z.infer<typeof ConflictKindSchema>;

/** One path the `origin/master` merge conflicts on. */
export type ConflictPath = z.infer<typeof ConflictPathSchema>;

/** The `package.json` versions a merge saw, and the one it ends on. */
export type VersionLine = z.infer<typeof VersionLineSchema>;

/** Envelope of `sync-master <batch>`. */
export type SyncMasterResult = z.infer<typeof SyncMasterResultSchema>;

/** A pull request `publish` opened, or found open with `--push-only`. */
export type OpenedPr = z.infer<typeof OpenedPrSchema>;

/** Envelope of `publish <batch> (--title T --body-file F [--draft] | --push-only) --log L`. */
export type PublishResult = z.infer<typeof PublishResultSchema>;

/** Envelope of `append-pr-body <batch> --pr N --section-file F`. */
export type AppendPrBodyResult = z.infer<typeof AppendPrBodyResultSchema>;

/** Envelope of `post-pr-comment <batch> --pr N --comment-file F`. */
export type PostPrCommentResult = z.infer<typeof PostPrCommentResultSchema>;

/** Envelope of `post-issue-comment <main> --issue N --comment-file F`. */
export type PostIssueCommentResult = z.infer<typeof PostIssueCommentResultSchema>;

/** One `master` ref at the launch and now. */
export type MasterMove = z.infer<typeof MasterMoveSchema>;

/** Envelope of `check-master <main> --local SHA --remote SHA --synced SHA`. */
export type CheckMasterResult = z.infer<typeof CheckMasterResultSchema>;

/** Envelope of `changed-files <worktree> <sha> --base <base>`. */
export type ChangedFilesResult = z.infer<typeof ChangedFilesResultSchema>;
