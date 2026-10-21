/**
 * The zod source of each worktree tool's output schema: the envelope fields the saved workflows
 * consume, `.pick`ed from the envelope schemas in `ship/src/cli/envelope/`, so a renamed or
 * dropped envelope field breaks the pick at compile time. Every consumed field is
 * required — a runner answer that lacks one fails its schema, and the workflow reads a missing
 * answer as a failure — except `reason`, which the envelope carries only when `refused`; `at`,
 * optional on an in-process envelope, is required where consumed, since the CLI stamps every
 * envelope it prints.
 *
 * Emitted, never rendered: `ship/src/build/emit-workflow-schemas.ts` writes it as JSON Schema into
 * `ship/src/workflow/schemas.generated.ts`, which the render inlines. No file in a render
 * closure may value-import this one.
 */

import { z } from 'zod';

import {
  LiveRunSchema,
  LiveRunsResultSchema,
  PrInfoSchema,
  ProvisionBatchResultSchema,
  ProvisionResultSchema,
  RetireRunResultSchema,
  StepErrorSchema,
  TeardownResultSchema,
} from '../cli/envelope/schemas.js';
import {
  AppendPrBodyResultSchema,
  BumpResultSchema,
  ChangedFilesResultSchema,
  CheckMasterResultSchema,
  CutBatchResultSchema,
  CutSliceResultSchema,
  LandResultSchema,
  PostIssueCommentResultSchema,
  PostPrCommentResultSchema,
  PreflightResultSchema,
  PublishResultSchema,
  SyncMasterResultSchema,
} from '../cli/envelope/schemas-run.js';
import type { WorktreeToolName } from '../workflow/calls/tool-calls.js';

/** The keys every row picks: the status fields. */
const STATUS = { status: true, reason: true, errors: true } as const;

/** The `errors` a row carries: each error's step and message. */
const ERRORS = z.array(StepErrorSchema.pick({ step: true, message: true }));

/** One live run as `live-runs`' row carries it, its PR narrowed. */
const LIVE_RUN = LiveRunSchema.pick({
  branch: true,
  landed: true,
  pr: true,
  spent: true,
  path: true,
  dirty: true,
  nested: true,
  spentUnverified: true,
}).extend({ pr: PrInfoSchema.pick({ state: true, number: true }) });

/** Each worktree tool's consumed envelope fields. */
export const TOOL_ENVELOPES = {
  preflight: PreflightResultSchema.pick({
    ...STATUS,
    worktree: true,
    snapshot: true,
    problems: true,
  }).extend({ errors: ERRORS }),
  'live-runs': LiveRunsResultSchema.pick({ ...STATUS, worktree: true, runs: true }).extend({
    errors: ERRORS,
    runs: z.array(LIVE_RUN),
  }),
  'cut-batch': CutBatchResultSchema.pick({
    ...STATUS,
    branch: true,
    base: true,
    batch: true,
    reportDir: true,
    attach: true,
  }).extend({ errors: ERRORS }),
  'provision-batch': ProvisionBatchResultSchema.pick({
    ...STATUS,
    registry: true,
    env: true,
  }).extend({ errors: ERRORS }),
  'cut-slice': CutSliceResultSchema.pick({
    ...STATUS,
    branch: true,
    base: true,
    slice: true,
    at: true,
  })
    .required({ at: true })
    .extend({ errors: ERRORS }),
  provision: ProvisionResultSchema.pick({ ...STATUS, env: true }).extend({ errors: ERRORS }),
  land: LandResultSchema.pick({
    ...STATUS,
    commit: true,
    files: true,
    lines: true,
    conflicts: true,
    rolledBack: true,
    batchClean: true,
    at: true,
  })
    .required({ at: true })
    .extend({ errors: ERRORS }),
  teardown: TeardownResultSchema.pick({
    ...STATUS,
    removed: true,
    registered: true,
    kept: true,
  }).extend({ errors: ERRORS }),
  'retire-run': RetireRunResultSchema.pick(STATUS).extend({ errors: ERRORS }),
  'sync-master': SyncMasterResultSchema.pick({
    ...STATUS,
    outcome: true,
    commit: true,
    upstream: true,
    conflicts: true,
    version: true,
  }).extend({ errors: ERRORS }),
  bump: BumpResultSchema.pick({ ...STATUS, kind: true, from: true, to: true, commit: true }).extend(
    { errors: ERRORS },
  ),
  publish: PublishResultSchema.pick({ ...STATUS, pushed: true, pr: true, mergeable: true }).extend({
    errors: ERRORS,
  }),
  'check-master': CheckMasterResultSchema.pick({ ...STATUS, local: true, remote: true }).extend({
    errors: ERRORS,
  }),
  'append-pr-body': AppendPrBodyResultSchema.pick({ ...STATUS }).extend({ errors: ERRORS }),
  'post-pr-comment': PostPrCommentResultSchema.pick({ ...STATUS, url: true }).extend({
    errors: ERRORS,
  }),
  'changed-files': ChangedFilesResultSchema.pick({ ...STATUS, files: true }).extend({
    errors: ERRORS,
  }),
  'post-issue-comment': PostIssueCommentResultSchema.pick({ ...STATUS, url: true }).extend({
    errors: ERRORS,
  }),
} satisfies Record<WorktreeToolName, z.ZodObject>;
