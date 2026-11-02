/**
 * The `resync` workflow's entry: bring an open run branch level with
 * `origin/master`, after another PR merged into `master`, through the epic end's own merge step
 * (`epic-end/sync-master-step.ts`) and a lefthook-gated, never-forced push, never a rebase, never
 * GitHub's server-side "Update branch". Rendered by `ship/src/build/render-workflows.ts` and
 * installed as `.claude/workflows/resync.js`: edit this source and run `npm run fix`, never the
 * installed file.
 *
 * The attach refuses a branch holding commits of its own `origin` lacks (`unpublished-commits`:
 * a stopped attached run's fixes, recovered first), so nothing merges or pushes. An unpushed merge
 * of its own still goes through. An `up-to-date` merge still reaches the push, so a rerun pushes a
 * merge an earlier resync made but never pushed.
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import type { WorkflowHooks } from './runtime.types.js';
import { parseResyncArgs } from './resync-args.js';
import { cleanupSpent, type CleanupReport } from './spent-cleanup.js';
import { RESYNC_PHASE_TITLES } from './stages.js';
import { syncMasterStep, type SyncStepResult } from './epic-end/sync-master-step.js';
import { withCheckout } from './calls/prompts.js';
import { envelopeProblem, preCutPlace, runPlace, runTool } from './calls/tool-calls.js';

/** What the workflow returns. */
interface ResyncReport {
  /**
   * `refused`: the arguments were refused, nothing ran; `stopped`: a step
   * ended the run ({@link ResyncReport.message}); `done`: the branch was
   * merged (or already level) and pushed (or already pushed).
   */
  readonly status: 'refused' | 'stopped' | 'done';
  /** The run branch, empty when refused. */
  readonly branch: string;
  /** One line on how the run ended. */
  readonly message: string;
  /** The branch's open PR, once known. */
  readonly pr: number | null;
  /** The merge step's result, `null` before it ran. */
  readonly sync: SyncStepResult | null;
  /** Whether the push ran and succeeded. */
  readonly pushed: boolean;
  /** The PR's raw mergeable state after the push, `null` before it was read. */
  readonly mergeable: string | null;
  /** What the spent-run cleanup did. */
  readonly cleanup: CleanupReport;
}

/** The mergeable state that confirms the PR merges clean. */
const RESYNC_MERGEABLE = 'MERGEABLE';

/** The run branch's batch, attached. */
interface ResyncBatch {
  readonly batch: string;
  readonly reportDir: string;
  readonly pr: number;
}

/** Run the `resync` workflow. */
export async function runResync(hooks: WorkflowHooks, rawArgs: unknown): Promise<ResyncReport> {
  const args = parseResyncArgs(rawArgs);
  const base = { pr: null, sync: null, pushed: false, mergeable: null, cleanup: noCleanup() };

  if (args.refusal !== undefined) {
    return { ...base, status: 'refused', branch: '', message: args.refusal };
  }

  const { branch } = args;
  hooks.phase(RESYNC_PHASE_TITLES.preflight);
  const live = await runTool(hooks, 'live-runs', ['.'], preCutPlace('resync'));

  if (typeof live?.worktree !== 'string') {
    const message =
      live === null ? envelopeProblem('live-runs', live) : 'live-runs named no main checkout';

    return { ...base, branch, status: 'stopped', message };
  }

  const bound = withCheckout(hooks, live.worktree);
  const cleanup = await cleanupSpent(bound, live);
  const report = { ...base, branch, cleanup };
  if (cleanup.stop !== null) return { ...report, status: 'stopped', message: cleanup.stop };
  const attached = await attachStep(bound, branch);
  if ('stop' in attached) return { ...report, status: 'stopped', message: attached.stop };
  const withPr = { ...report, pr: attached.pr };
  hooks.phase(RESYNC_PHASE_TITLES.merge);
  const sync = await syncMasterStep(bound, { ...attached, tag: 'resync' });

  if (sync.verdict === 'code-conflict' || sync.verdict === 'failed') {
    return {
      ...withPr,
      sync,
      status: 'stopped',
      message: `master sync ${sync.verdict}: ${sync.message}`,
    };
  }

  hooks.phase(RESYNC_PHASE_TITLES.push);

  return pushStep(bound, attached, { ...withPr, sync });
}

/** Attach the branch's batch, provisioning it when it was checked out anew. */
async function attachStep(
  hooks: WorkflowHooks,
  branch: string,
): Promise<ResyncBatch | { readonly stop: string }> {
  const cut = await runTool(hooks, 'cut-batch', ['.', '--attach', branch], preCutPlace('resync'));
  const { batch, reportDir, attach } = cut ?? {};

  if (
    cut?.status !== 'ok' ||
    typeof batch !== 'string' ||
    typeof reportDir !== 'string' ||
    attach === undefined ||
    attach === null
  ) {
    return { stop: envelopeProblem('cut-batch', cut) };
  }

  if (attach.created) {
    const argv = [batch, '--report-dir', reportDir];
    const prov = await runTool(hooks, 'provision-batch', argv, runPlace({ reportDir }, 'resync'));
    if (prov?.status !== 'ok') return { stop: envelopeProblem('provision-batch', prov) };
  }

  return { batch, reportDir, pr: attach.pr };
}

/** Push the merged branch and read its PR's mergeable state. */
async function pushStep(
  hooks: WorkflowHooks,
  attached: ResyncBatch,
  report: Omit<ResyncReport, 'status' | 'message'>,
): Promise<ResyncReport> {
  const argv = [attached.batch, '--push-only', '--log', `${attached.reportDir}/resync-push.log`];
  const out = await runTool(hooks, 'publish', argv, runPlace(attached, 'resync'));

  if (out?.status !== 'ok') {
    return { ...report, status: 'stopped', message: envelopeProblem('publish', out) };
  }

  const pushed = out.pushed === true;
  const mergeable = out.mergeable ?? null;
  const pr = out.pr?.number ?? report.pr;
  const state =
    mergeable === RESYNC_MERGEABLE ? 'confirmed' : `unconfirmed (${mergeable ?? 'unread'})`;
  const message = `${pushed ? 'pushed' : 'nothing to push'}; PR #${String(pr)} mergeable ${state}`;

  return { ...report, status: 'done', message, pr, pushed, mergeable };
}

function noCleanup(): CleanupReport {
  return { tornDown: [], retired: [], skipped: [], residue: [], blocked: null, stop: null };
}
