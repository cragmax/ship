/**
 * Result envelope types of the worktree CLI (`../worktree.ts`) — the single JSON object every
 * command prints on one stdout line — plus the error classes a step throws to end its command
 * early. Each type is the `z.infer` of its schema in `schemas.ts`, the canonical home of shapes,
 * field docs and path spelling; the run-branch and epic-end envelopes are in `types-run.ts`.
 *
 * Status (the envelope's `status`): `ok` — every step ran and every check held. `refused` — a
 * safety guard fired before, or instead of, mutating the thing it protects; `reason` names the
 * guard ({@link Refusal}). `failed` — a step failed; `errors[0].step` names it
 * ({@link StepFailure}); any other throw is step `internal`, a bad command line step `usage`, and
 * an envelope that fails its schema step `envelope` (`schemas.ts` `guardEnvelope`). `conflict` —
 * `harvest` and `land`: the change cannot apply to the batch's current head, the batch back at a
 * verified-clean `HEAD` ({@link Conflict}).
 */

import type { z } from 'zod';

import type {
  CommandStatusSchema,
  CommitResultSchema,
  HarvestResultSchema,
  LinkRecordSchema,
  LiveRunSchema,
  LiveRunsResultSchema,
  PrInfoSchema,
  ProvisionBatchResultSchema,
  ProvisionResultSchema,
  RefusalReasonSchema,
  ResultBaseSchema,
  RetireRunResultSchema,
  StagedGuardResultSchema,
  TeardownResultSchema,
  TsserverRestartSchema,
  TsserverSkipReasonSchema,
  WarmMemberSchema,
} from './schemas.js';

/** The envelope's outcome. */
type CommandStatus = z.infer<typeof CommandStatusSchema>;

/** Which safety guard produced a `refused` envelope. */
type RefusalReason = z.infer<typeof RefusalReasonSchema>;

/** Fields every command's envelope carries. */
export type ResultBase = z.infer<typeof ResultBaseSchema>;

/** A directory link and the absolute directory it points at. */
export type LinkRecord = z.infer<typeof LinkRecordSchema>;

/** Envelope of `provision <slice> --batch <batch> [--server]`. */
export type ProvisionResult = z.infer<typeof ProvisionResultSchema>;

/** One member of the fixed warm pool set. */
export type WarmMember = z.infer<typeof WarmMemberSchema>;

/** Envelope of `provision-batch <batch> --report-dir <dir>`. */
export type ProvisionBatchResult = z.infer<typeof ProvisionBatchResultSchema>;

/** Envelope of `teardown <worktree>`. */
export type TeardownResult = z.infer<typeof TeardownResultSchema>;

/** What `teardown`'s restart of its session's tsserver did. */
export type TsserverRestart = z.infer<typeof TsserverRestartSchema>;

/** Why `teardown` skipped the restart. */
export type TsserverSkipReason = z.infer<typeof TsserverSkipReasonSchema>;

/** Envelope of `retire-run <main> --branch ship/<slug>`. */
export type RetireRunResult = z.infer<typeof RetireRunResultSchema>;

/** Envelope of `harvest <batch> <slice-sha>`; `worktree` is the batch. */
export type HarvestResult = z.infer<typeof HarvestResultSchema>;

/** Envelope of `staged-guard <worktree> <file>…`; every list is sorted. */
export type StagedGuardResult = z.infer<typeof StagedGuardResultSchema>;

/** Envelope of `commit --message-file <f> -- <path>…`. */
export type CommitResult = z.infer<typeof CommitResultSchema>;

/** A run branch's pull request as `gh` reports it. */
export type PrInfo = z.infer<typeof PrInfoSchema>;

/** One live unattended run: a registered worktree on a run branch. */
export type LiveRun = z.infer<typeof LiveRunSchema>;

/** Envelope of `live-runs <main>`; `worktree` is the main checkout. */
export type LiveRunsResult = z.infer<typeof LiveRunsResultSchema>;

/** A step failed; the command stops and reports `failed`. */
export class StepFailure extends Error {
  override readonly name: string = 'StepFailure';
  /** The failing step, reported as `errors[0].step`. */
  readonly step: string;
  /** Reported as `errors[0].detail`. */
  readonly detail: string | undefined;

  /**
   * Create a step failure.
   *
   * @param step - The failing step's name.
   * @param message - One-line cause.
   * @param detail - Optional child-output tail.
   */
  constructor(step: string, message: string, detail?: string) {
    super(message);
    this.step = step;
    this.detail = detail;
  }
}

/**
 * A safety guard fired; the command stops and reports `refused` with
 * {@link Refusal.reason}.
 */
export class Refusal extends StepFailure {
  override readonly name: string = 'Refusal';
  /** The guard that fired. */
  readonly reason: RefusalReason;

  /**
   * Create a refusal.
   *
   * @param reason - The guard that fired.
   * @param step - The step the guard belongs to.
   * @param message - One-line cause.
   * @param detail - Optional supporting detail.
   */
  constructor(reason: RefusalReason, step: string, message: string, detail?: string) {
    super(step, message, detail);
    this.reason = reason;
  }
}

/**
 * A change would not apply to the batch; the command reports `conflict`
 * with {@link Conflict.files}.
 */
export class Conflict extends StepFailure {
  override readonly name: string = 'Conflict';
  /** The paths that would not apply. */
  readonly files: readonly string[];

  /**
   * Create a conflict.
   *
   * @param step - The step that detected it.
   * @param message - One-line cause.
   * @param files - The paths that would not apply.
   * @param detail - Optional child-output tail.
   */
  constructor(step: string, message: string, files: readonly string[], detail?: string) {
    super(step, message, detail);
    this.files = files;
  }
}

/**
 * Record a caught throw on an envelope, mapped to a status as the file
 * header describes.
 *
 * @param result - The envelope being built; mutated.
 * @param err - The caught value.
 */
export function recordFailure(result: ResultBase, err: unknown): void {
  if (err instanceof StepFailure) {
    result.status = statusOf(err);
    if (err instanceof Refusal) result.reason = err.reason;
    result.errors.push({
      step: err.step,
      message: err.message,
      ...(err.detail !== undefined && { detail: err.detail }),
    });

    return;
  }

  result.status = 'failed';
  result.errors.push({
    step: 'internal',
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * The status a {@link StepFailure} maps to.
 *
 * @param err - The failure.
 * @returns `conflict`, `refused` or `failed` by the failure's class.
 */
function statusOf(err: StepFailure): CommandStatus {
  if (err instanceof Conflict) return 'conflict';

  return err instanceof Refusal ? 'refused' : 'failed';
}
