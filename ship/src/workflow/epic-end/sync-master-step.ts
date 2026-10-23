/**
 * The epic end's merge step (Ship ADR-0001 decision 12) — the one workflow home
 * of the `origin/master` merge, which the `resync` workflow reuses, passing
 * `{ batch, reportDir, tag: 'resync' }`.
 *
 * A code conflict or any failure stops the epic before its bump and push;
 * the caller reads {@link SyncStepResult.verdict}.
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { ConflictPath, VersionLine } from '../../cli/envelope/types-run.js';

import type { WorkflowHooks } from '../runtime.types.js';
import { envelopeProblem, runPlace, runTool, type SyncMasterOutput } from '../calls/tool-calls.js';

/** How the merge step ended. `code-conflict` and `failed` stop the epic. */
export type SyncVerdict = 'up-to-date' | 'merged' | 'code-conflict' | 'failed';

/** The merge step's result. */
export interface SyncStepResult {
  /** How it ended. */
  readonly verdict: SyncVerdict;
  /** The merge commit; `null` unless `merged`. */
  readonly commit: string | null;
  /**
   * `sync-master`'s `upstream`: the `origin/master` sha the batch contains
   * after the step; `null` unless `up-to-date` or `merged`.
   */
  readonly upstream: string | null;
  /** One line on what happened. */
  readonly message: string;
  /**
   * `sync-master`'s classified conflicts — what landed each code conflict included; `[]` when it
   * named none.
   */
  readonly conflicts: readonly ConflictPath[];
  /** The versions its merge saw and ended on; `null` when it named none. */
  readonly version: VersionLine | null;
}

/** How the step ended, before `sync-master`'s findings are added. */
type SyncOutcome = Pick<SyncStepResult, 'verdict' | 'commit' | 'upstream' | 'message'>;

/** Where the step runs. */
interface SyncStepContext {
  /** The batch worktree. */
  readonly batch: string;
  /** The run's report directory. */
  readonly reportDir: string;
  /** What tells the entry's calls from other entries' (`epic-1025`, `list`, `resync`). */
  readonly tag: string;
}

/**
 * Merge `origin/master` into the batch.
 *
 * @param hooks - The workflow hooks.
 * @param ctx - The batch and its report directory.
 * @returns Resolves to the step's result, carrying `sync-master`'s `conflicts`
 *   and `version` on every path; never rejects on a tool's outcome.
 */
export async function syncMasterStep(
  hooks: WorkflowHooks,
  ctx: SyncStepContext,
): Promise<SyncStepResult> {
  const out = await runTool(hooks, 'sync-master', [ctx.batch], runPlace(ctx, ctx.tag));

  return { ...syncVerdict(out), conflicts: out?.conflicts ?? [], version: out?.version ?? null };
}

/**
 * A `sync-master` output's verdict. A merge whose output named no `upstream` carries `null`: the
 * master check then fails, not the sync.
 */
function syncVerdict(out: SyncMasterOutput | null): SyncOutcome {
  if (out?.status === 'ok' && out.outcome === 'up-to-date') {
    return {
      verdict: 'up-to-date',
      commit: null,
      upstream: out.upstream ?? null,
      message: 'origin/master already merged',
    };
  }

  if (out?.status === 'ok' && out.outcome === 'merged' && typeof out.commit === 'string') {
    return {
      verdict: 'merged',
      commit: out.commit,
      upstream: out.upstream ?? null,
      message: `merged origin/master as ${out.commit}`,
    };
  }

  const message = envelopeProblem('sync-master', out);

  if (out?.status === 'refused' && out.reason === 'code-conflict') {
    return { verdict: 'code-conflict', commit: null, upstream: null, message };
  }

  return { verdict: 'failed', commit: null, upstream: null, message };
}
