/**
 * Result envelope of the worktree CLI (`tooling/worktree.ts`): the single
 * JSON object every command prints on one stdout line, plus the two error
 * classes a step throws to end its command early.
 *
 * Status semantics (the envelope's `status`):
 *
 * - `ok` — every step ran and every check held.
 * - `refused` — a safety guard fired before, or instead of, mutating the
 *   thing it protects; `reason` names the guard. Thrown as {@link Refusal}.
 * - `failed` — a step failed; `errors[0].step` names it. Thrown as
 *   {@link StepFailure}; any other throw is step `internal`, and a bad
 *   command line is step `usage`.
 *
 * Every path in an envelope is absolute with forward slashes.
 */

/** The envelope's outcome. */
export type CommandStatus = 'ok' | 'failed' | 'refused';

/** Which safety guard produced a `refused` envelope. */
export type RefusalReason =
  | 'self-hosted'
  | 'main-worktree'
  | 'report-dir-inside-worktree'
  | 'links-remain'
  | 'source-shrank'
  /** Teardown: another registered worktree lies inside the target; the message names each. */
  | 'nested-worktree';

/** One entry of the envelope's `errors` list. */
export interface StepError {
  /** The step that failed or refused (`usage`, `preconditions`, `build`, …). */
  readonly step: string;
  /** One-line human-readable cause. */
  readonly message: string;
  /** Captured child-output tail or other supporting detail. */
  readonly detail?: string;
}

/** Fields every command's envelope carries. */
export interface ResultBase {
  /** The subcommand as given on the command line. */
  command: string;
  status: CommandStatus;
  /** The worktree the command targeted; `null` only for a usage error without one. */
  worktree: string | null;
  /** Empty when `status` is `ok`; otherwise the failing or refusing step. */
  errors: StepError[];
  /** Present only when `status` is `refused`. */
  reason?: RefusalReason;
}

/** A directory link and the absolute directory it points at. */
export interface LinkRecord {
  readonly path: string;
  readonly target: string;
}

/** Envelope of `provision <slice> --batch <batch> [--server]`. */
export interface ProvisionResult extends ResultBase {
  /** The batch worktree the slice was provisioned against. */
  batch: string;
  /** Links in place for the slice after the command (created or reused). */
  junctions: LinkRecord[];
  /** The slice's built `dist`; `null` when no build produced it or it was rolled back. */
  dist: string | null;
  /** Vitest config files this call wrote that are still in place. */
  vitestConfigs: string[];
  /** Environment a lease run in the slice needs; `null` unless `ok`. */
  env: { PH_PROJECT_DIR: string } | null;
  /** Paths this call created and removed again after a failure. */
  rolledBack: string[];
}

/** One member of the fixed warm pool set. */
export interface WarmMember {
  readonly type: 'paper' | 'folia';
  readonly host: string;
  /** RCON port — the member's identity within the host. */
  readonly rconPort: number;
}

/** Envelope of `provision-batch <batch> --report-dir <dir>`. */
export interface ProvisionBatchResult extends ResultBase {
  /** The batch's installed `node_modules`, or `null` when not installed. */
  nodeModules: string | null;
  /** The batch's built `dist`, or `null` when not built. */
  dist: string | null;
  /** The batch's self-install workspace, or `null` when not created. */
  workspace: string | null;
  /** The trimmed pool registry written for the batch, or `null`. */
  registry: string | null;
  /** The warm members the trimmed registry holds. */
  warm: WarmMember[];
  /** Environment the batch's lease runs need; `null` unless `ok`. */
  env: { PH_PROJECT_DIR: string; PH_POOL_REGISTRY: string } | null;
}

/** A link target's entry count before and after teardown's unlink step. */
export interface SourceCount {
  /** The link target. */
  readonly path: string;
  /** Count at teardown start; `null` when the target was missing (not gated). */
  readonly before: number | null;
  /**
   * Latest count; `null` before the first recount, or when the target is no
   * longer a real directory (gated as a shrink).
   */
  after: number | null;
}

/** Envelope of `teardown <worktree>`. */
export interface TeardownResult extends ResultBase {
  /** Links removed from the worktree. */
  unlinked: LinkRecord[];
  /**
   * Each distinct link target outside the worktree, with its counts; a target
   * that exists as a non-directory (a file, or another link) is not recorded.
   */
  sources: SourceCount[];
  /** Whether the worktree directory was removed. */
  removed: boolean;
  /** Whether git still lists the worktree after the command. */
  registered: boolean;
}

/**
 * A step failed; the command stops and reports `failed`.
 */
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
 * Record a caught throw on an envelope, mapped to a status as the file
 * header describes.
 *
 * @param result - The envelope being built; mutated.
 * @param err - The caught value.
 */
export function recordFailure(result: ResultBase, err: unknown): void {
  if (err instanceof StepFailure) {
    result.status = err instanceof Refusal ? 'refused' : 'failed';
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
