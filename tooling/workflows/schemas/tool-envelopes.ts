/**
 * The zod source of each worktree tool's output schema (#1047): the fields
 * of the command's envelope the saved workflows consume, `.pick`ed from the
 * envelope schemas in `tooling/worktree/schemas*.ts`, so a renamed or
 * dropped envelope field breaks the pick at compile time. Every consumed
 * field is required: a runner answer that lacks one fails its schema, and
 * the workflow reads a missing answer as a failure. The one exception is
 * `reason`, which the envelope carries only when `refused`; `at`, optional
 * on an in-process envelope, is required where it is consumed, since the
 * CLI stamps every envelope it prints.
 *
 * Every row carries `status`, `reason` and `errors` (each error's `step`
 * and `message`) besides its own fields.
 *
 * Emitted, never rendered: `tooling/emit-workflow-schemas.ts` writes it as
 * JSON Schema into `tooling/workflows/lib/schemas.generated.ts`, which the
 * render inlines. No file in a render closure may value-import this one.
 */

import { z } from 'zod';

import {
  LiveRunSchema,
  LiveRunsResultSchema,
  PrInfoSchema,
  ProvisionBatchResultSchema,
  ProvisionResultSchema,
  StepErrorSchema,
  TeardownResultSchema,
} from '../../worktree/schemas.js';
import {
  AppendPrBodyResultSchema,
  BumpResultSchema,
  CheckMasterResultSchema,
  CutBatchResultSchema,
  CutSliceResultSchema,
  LandResultSchema,
  PreflightResultSchema,
  PublishResultSchema,
  SyncMasterResultSchema,
} from '../../worktree/schemas-run.js';
import type { WorktreeToolName } from '../lib/tool-calls.js';

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
  'live-runs': LiveRunsResultSchema.pick({ ...STATUS, runs: true }).extend({
    errors: ERRORS,
    runs: z.array(LIVE_RUN),
  }),
  'cut-batch': CutBatchResultSchema.pick({
    ...STATUS,
    worktree: true,
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
    conflicts: true,
    rolledBack: true,
    batchClean: true,
    at: true,
  })
    .required({ at: true })
    .extend({ errors: ERRORS }),
  teardown: TeardownResultSchema.pick({ ...STATUS, removed: true, registered: true }).extend({
    errors: ERRORS,
  }),
  'sync-master': SyncMasterResultSchema.pick({
    ...STATUS,
    outcome: true,
    commit: true,
    upstream: true,
    conflicts: true,
    version: true,
    pending: true,
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
} satisfies Record<WorktreeToolName, z.ZodObject>;
