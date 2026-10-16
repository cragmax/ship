/**
 * The epic end's merge step (ADR-0045 decision 6) — the one workflow home
 * of the `origin/master` merge, which the `resync` workflow reuses, passing
 * `{ batch, reportDir, tag: 'resync' }`: `sync-master`; on
 * `needs-resolution`, the doc-index resolver (it edits the pending paths
 * and never stages); then `sync-master --continue`, which stages by name
 * itself.
 *
 * A code conflict or any failure stops the epic before its bump and push;
 * the caller reads {@link SyncStepResult.verdict}. A resolver that returns
 * nothing, or does not resolve, leaves the merge in progress in the batch
 * for the maintainer — `--continue` is never run over unresolved paths.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { ConflictPath, VersionLine } from '../../worktree/types-run.js';

import { AGENT_CALLS } from './agent-calls.js';
import type { WorkflowHooks } from './hooks.types.js';
import { envelopeProblem, runPlace, runTool, type SyncMasterOutput } from './tool-calls.js';

/** How the merge step ended. `code-conflict` and `failed` stop the epic. */
export type SyncVerdict = 'up-to-date' | 'merged' | 'resolved' | 'code-conflict' | 'failed';

/** The merge step's result. */
export interface SyncStepResult {
  /** How it ended. */
  readonly verdict: SyncVerdict;
  /** The merge commit; `null` unless `merged` or `resolved`. */
  readonly commit: string | null;
  /**
   * `sync-master`'s `upstream`: the `origin/master` sha the batch contains
   * after the step; `null` unless `up-to-date`, `merged` or `resolved`.
   */
  readonly upstream: string | null;
  /** One line on what happened. */
  readonly message: string;
  /**
   * The start's classified conflicts — what landed each code conflict included; `[]` when it named
   * none.
   */
  readonly conflicts: readonly ConflictPath[];
  /** The versions the start's merge saw and ended on; `null` when it named none. */
  readonly version: VersionLine | null;
}

/** How the step ended, before the start's findings are added. */
type SyncOutcome = Pick<SyncStepResult, 'verdict' | 'commit' | 'upstream' | 'message'>;

/** Where the step runs. */
export interface SyncStepContext {
  /** The batch worktree. */
  readonly batch: string;
  /** The run's report directory. */
  readonly reportDir: string;
  /** What tells the entry's calls from other entries' (`epic-1025`, `list`, `resync`). */
  readonly tag: string;
}

/**
 * Merge `origin/master` into the batch, resolving doc-index conflicts.
 *
 * @param hooks - The workflow hooks.
 * @param ctx - The batch and its report directory.
 * @returns Resolves to the step's result, carrying the start's `conflicts`
 *   and `version` on every path; never rejects on a tool's outcome.
 */
export async function syncMasterStep(
  hooks: WorkflowHooks,
  ctx: SyncStepContext,
): Promise<SyncStepResult> {
  const start = await runTool(hooks, 'sync-master', [ctx.batch], runPlace(ctx, ctx.tag));
  const found = { conflicts: start?.conflicts ?? [], version: start?.version ?? null };
  if (start?.status === 'conflict' && start.outcome === 'needs-resolution') {
    return { ...(await resolveAndContinue(hooks, ctx, start.pending ?? [])), ...found };
  }
  return { ...syncVerdict(start, 'merged'), ...found };
}

/**
 * Run the resolver over the pending doc indexes, then finish the merge.
 *
 * @returns Resolves to `resolved`, or `failed` naming what stopped it.
 */
async function resolveAndContinue(
  hooks: WorkflowHooks,
  ctx: SyncStepContext,
  pending: readonly string[],
): Promise<SyncOutcome> {
  if (pending.length === 0) {
    return syncFailure(
      `sync-master needs resolution but named no path; merge left in ${ctx.batch}`,
    );
  }
  const values = { batch: ctx.batch, pending, reportPath: `${ctx.reportDir}/resolve.md` };
  const answer = await AGENT_CALLS.resolver(hooks, values, ctx.tag);
  if (answer?.verdict !== 'resolved') {
    const said = answer === null ? 'returned nothing' : `said ${answer.summary}`;
    return syncFailure(`the resolver ${said}; merge left in progress in ${ctx.batch}`);
  }
  const done = await runTool(
    hooks,
    'sync-master',
    [ctx.batch, '--continue'],
    runPlace(ctx, `${ctx.tag}-continue`),
  );
  return syncVerdict(done, 'resolved');
}

/**
 * A `sync-master` output's verdict. A merge whose output named no `upstream` carries `null`: the
 * master check then fails, not the sync.
 */
function syncVerdict(out: SyncMasterOutput | null, merged: 'merged' | 'resolved'): SyncOutcome {
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
      verdict: merged,
      commit: out.commit,
      upstream: out.upstream ?? null,
      message: `merged origin/master as ${out.commit}`,
    };
  }
  const message = envelopeProblem('sync-master', out);
  if (out?.status === 'refused' && out.reason === 'code-conflict') {
    return { verdict: 'code-conflict', commit: null, upstream: null, message };
  }
  return syncFailure(message);
}

/**
 * A `failed` outcome.
 *
 * @param message - What stopped the step.
 * @returns The outcome.
 */
function syncFailure(message: string): SyncOutcome {
  return { verdict: 'failed', commit: null, upstream: null, message };
}
