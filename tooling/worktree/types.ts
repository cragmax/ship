/**
 * Result envelope of the worktree CLI (`tooling/worktree.ts`): the single
 * JSON object every command prints on one stdout line, plus the error
 * classes a step throws to end its command early. The envelopes of the
 * run-branch commands (`cut-batch`, `cut-slice`, `preflight`, `land`) are
 * in `types-run.ts`.
 *
 * Status semantics (the envelope's `status`):
 *
 * - `ok` — every step ran and every check held.
 * - `refused` — a safety guard fired before, or instead of, mutating the
 *   thing it protects; `reason` names the guard. Thrown as {@link Refusal}.
 * - `failed` — a step failed; `errors[0].step` names it. Thrown as
 *   {@link StepFailure}; any other throw is step `internal`, and a bad
 *   command line is step `usage`.
 * - `conflict` — `harvest` and `land` only: the change cannot apply to the
 *   batch's current head; the batch is back at a verified-clean `HEAD`.
 *   Thrown as {@link Conflict}.
 *
 * Every filesystem path in an envelope is absolute with forward slashes;
 * the path lists of `harvest`, `land`, `staged-guard` and `live-runs`
 * (`files`, `conflicts`, `expected`, `staged`, `missing`, `unexpected`,
 * `landed`) are repository-relative, as git spells them.
 */

/** The envelope's outcome. */
export type CommandStatus = 'ok' | 'failed' | 'refused' | 'conflict';

/** Which safety guard produced a `refused` envelope. */
export type RefusalReason =
  | 'self-hosted'
  | 'main-worktree'
  | 'report-dir-inside-worktree'
  | 'links-remain'
  | 'source-shrank'
  /** Teardown: another registered worktree lies inside the target; the message names each. */
  | 'nested-worktree'
  /** Harvest: the batch has uncommitted changes, or a merge, cherry-pick or revert in progress. */
  | 'batch-dirty'
  /** Harvest: the target is missing, outside any repository, or only a subdirectory of a worktree. */
  | 'unregistered-worktree'
  /** Staged-guard: the staged set differs from the expected list; the envelope names both sides. */
  | 'staged-mismatch'
  /** Land: the slice is not exactly one commit on top of its cut. */
  | 'slice-not-single-commit'
  /** Cut-batch, preflight: the target is not the repository's main worktree. */
  | 'not-main-worktree'
  /** Cut-slice, land: the target is a linked worktree, but not on a `ship/` run branch. */
  | 'not-run-batch'
  /** Cut-batch, cut-slice: the branch to create exists already. */
  | 'branch-exists'
  /** Cut-batch, cut-slice: the directory to create exists already. */
  | 'path-exists'
  /** Preflight: a check failed; the envelope's `problems` names each. */
  | 'preflight-failed';

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
  /**
   * The slice-specific part of a lease run's environment; `null` unless `ok`.
   * Not the whole of it: `PH_POOL_REGISTRY` comes from the batch's
   * `provision-batch` `env` — without it a lease run reads the full registry,
   * cold servers included.
   */
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
  /** Environment lease runs in the batch and its slices need; `null` unless `ok`. */
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

/** Envelope of `harvest <batch> <slice-sha>`; `worktree` is the batch. */
export interface HarvestResult extends ResultBase {
  /** The slice commit's full sha; `null` until it resolves. */
  sha: string | null;
  /**
   * Every path the slice commit changes, both endpoints of a rename, in
   * code-unit order — the list a caller hands `staged-guard` next.
   */
  files: string[];
  /**
   * Paths that would not apply; non-empty only on a conflict — `status`
   * `conflict`, or `failed` when the rollback after it failed.
   */
  conflicts: string[];
  /** Whether a started pick was reset and the batch verified clean afterwards. */
  rolledBack: boolean;
}

/** Envelope of `staged-guard <worktree> <file>…`; every list is sorted. */
export interface StagedGuardResult extends ResultBase {
  /** The expected paths, normalised and deduplicated. */
  expected: string[];
  /** The paths staged in the worktree, a rename as both endpoints. */
  staged: string[];
  /** Expected but not staged. */
  missing: string[];
  /** Staged but not expected. */
  unexpected: string[];
}

/** A run branch's pull request as `gh` reports it. */
export interface PrInfo {
  /**
   * `none`: `gh` found no PR for the branch; `unknown`: `gh` could not be
   * asked or answered unreadably — never read as `none`.
   */
  readonly state: 'open' | 'merged' | 'closed' | 'none' | 'unknown';
  /** The PR number; `null` for `none` and `unknown`. */
  readonly number: number | null;
}

/** One live unattended run: a registered worktree on a run branch. */
export interface LiveRun {
  /** The worktree root as git lists it. */
  readonly path: string;
  /** The short branch name, e.g. `ship/epic-1025`. */
  readonly branch: string;
  /** Commits on the branch not on the base branch. */
  readonly ahead: number;
  /** `git merge-base` of the base branch and the run branch. */
  readonly mergeBase: string;
  /** Paths the run changed since the merge-base, both endpoints of a rename, sorted. */
  readonly landed: string[];
  /** Uncommitted changes in the worktree; `null` when its directory is missing. */
  readonly dirty: boolean | null;
  /** The branch's pull request. */
  readonly pr: PrInfo;
  /** The PR is merged or closed — the run is over and awaits cleanup. */
  readonly spent: boolean;
  /** Registered worktrees (any branch) strictly inside this one. */
  readonly nested: string[];
}

/** Envelope of `live-runs <main>`; `worktree` is the main checkout. */
export interface LiveRunsResult extends ResultBase {
  /** Every live run, sorted by branch. */
  runs: LiveRun[];
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
 * The status a {@link StepFailure} maps to.
 *
 * @param err - The failure.
 * @returns `conflict`, `refused` or `failed` by the failure's class.
 */
function statusOf(err: StepFailure): CommandStatus {
  if (err instanceof Conflict) return 'conflict';
  return err instanceof Refusal ? 'refused' : 'failed';
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
