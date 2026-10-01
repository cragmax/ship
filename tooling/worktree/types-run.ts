/**
 * Envelope types of the worktree CLI's run-branch commands — the commands
 * that cut, check and land an unattended run (ADR-0045): `cut-batch`,
 * `cut-slice`, `preflight` and `land` — and of its epic-end commands:
 * `sync-master`, `bump`, `check-master` and `publish`. Each is the
 * `z.infer` of its schema in `schemas-run.ts`, the canonical home of the
 * shapes and their field docs. The status semantics and error classes are
 * `types.ts`'s.
 */

import type { z } from 'zod';

import type {
  AttachInfoSchema,
  BumpResultSchema,
  CheckMasterResultSchema,
  ConflictKindSchema,
  ConflictPathSchema,
  CutBatchResultSchema,
  CutSliceResultSchema,
  LandResultSchema,
  MasterMoveSchema,
  OpenedPrSchema,
  PreflightCheckSchema,
  PreflightProblemSchema,
  PreflightResultSchema,
  PublishResultSchema,
  SyncMasterResultSchema,
  VersionLineSchema,
} from './schemas-run.js';

/** How `cut-batch --attach` found the run branch's batch. */
export type AttachInfo = z.infer<typeof AttachInfoSchema>;

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

/** Envelope of `land <batch> <slice-sha> …`. */
export type LandResult = z.infer<typeof LandResultSchema>;

/** How `sync-master` treats a conflicted path. */
export type ConflictKind = z.infer<typeof ConflictKindSchema>;

/** One path the `origin/master` merge conflicts on. */
export type ConflictPath = z.infer<typeof ConflictPathSchema>;

/** The `package.json` versions a merge saw, and the one it ends on. */
export type VersionLine = z.infer<typeof VersionLineSchema>;

/** Envelope of `sync-master <batch> [--continue]`. */
export type SyncMasterResult = z.infer<typeof SyncMasterResultSchema>;

/** Envelope of `bump <batch>`. */
export type BumpResult = z.infer<typeof BumpResultSchema>;

/** A pull request `publish` opened, or found open with `--push-only`. */
export type OpenedPr = z.infer<typeof OpenedPrSchema>;

/** Envelope of `publish <batch> (--title T --body-file F | --push-only) --log L`. */
export type PublishResult = z.infer<typeof PublishResultSchema>;

/** One `master` ref at the launch and now. */
export type MasterMove = z.infer<typeof MasterMoveSchema>;

/** Envelope of `check-master <main> --local SHA --remote SHA`. */
export type CheckMasterResult = z.infer<typeof CheckMasterResultSchema>;
