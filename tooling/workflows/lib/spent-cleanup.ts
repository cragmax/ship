/**
 * The `resync` workflow's spent-run cleanup: tear down each live run whose
 * PR is over and whose tip is in that PR's head (`live-runs`' `spent`),
 * guarded — only a batch known clean, with no worktree nested inside it.
 *
 * - **Unknown is not none**: a `live-runs` that failed, or answered without
 *   its runs, blocks the cleanup — no teardown at all — and the resync goes
 *   on to its merge.
 * - **Unverified is not spent**: a run whose PR head cannot be checked
 *   (`spentUnverified`) is skipped and reported, never torn down.
 * - **A shrunk link target stops the resync** (teardown's `source-shrank`
 *   refusal): something outside the batch lost files. Any other teardown
 *   failure is residue, and the next spent run is still tried.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { WorkflowHooks } from './hooks.types.js';
import {
  envelopeProblem,
  PRE_CUT,
  runTool,
  type LiveRunOutput,
  type LiveRunsOutput,
} from './tool-calls.js';

/** A spent run left standing, and why. */
export interface SkippedRun {
  /** The run's worktree; its branch when `live-runs` named no path. */
  readonly path: string;
  /** Why it was not torn down. */
  readonly why: string;
}

/** What the cleanup did. */
export interface CleanupReport {
  /** The worktrees torn down, in `live-runs` order. */
  readonly tornDown: string[];
  /** The spent (or unverified) runs left standing. */
  readonly skipped: SkippedRun[];
  /** What each failed teardown left behind, one line each. */
  readonly residue: string[];
  /** Why no run was looked at; `null` when `live-runs` answered. */
  blocked: string | null;
  /** Why the resync must stop; `null` unless a teardown refused `source-shrank`. */
  stop: string | null;
}

/**
 * Tear down the spent runs `live-runs` reported.
 *
 * @param hooks - The workflow hooks.
 * @param live - `live-runs`' output; `null` when the runner returned none.
 * @returns Resolves to the report; never rejects on a tool's outcome.
 */
export async function cleanupSpent(
  hooks: WorkflowHooks,
  live: LiveRunsOutput | null,
): Promise<CleanupReport> {
  const report: CleanupReport = {
    tornDown: [],
    skipped: [],
    residue: [],
    blocked: null,
    stop: null,
  };
  if (live?.status !== 'ok' || live.runs === undefined) {
    report.blocked = envelopeProblem('live-runs', live);
    return report;
  }
  for (const run of live.runs) {
    await cleanupRun(hooks, run, report);
    if (report.stop !== null) break;
  }
  return report;
}

/**
 * Clean up one run: leave a live one, skip a spent one it must leave, tear
 * the rest down.
 *
 * @param hooks - The workflow hooks.
 * @param run - The run, as `live-runs` reported it.
 * @param report - The report; records what happened.
 */
async function cleanupRun(
  hooks: WorkflowHooks,
  run: LiveRunOutput,
  report: CleanupReport,
): Promise<void> {
  const target = spentTarget(run);
  if (target === null) return;
  if ('why' in target) report.skipped.push(target);
  else await tearDownSpent(hooks, target.path, report);
}

/**
 * Tear one spent run down, recording the outcome.
 *
 * @param hooks - The workflow hooks.
 * @param path - The run's worktree.
 * @param report - The report; gains the path in `tornDown`, a `residue`
 *   line, or `stop` for a `source-shrank` refusal.
 */
async function tearDownSpent(
  hooks: WorkflowHooks,
  path: string,
  report: CleanupReport,
): Promise<void> {
  const tag = `spent-${String(report.tornDown.length + report.residue.length + 1)}`;
  const out = await runTool(hooks, 'teardown', [path], { ...PRE_CUT, tag });
  if (out?.status === 'ok') {
    report.tornDown.push(path);
  } else if (out?.status === 'refused' && out.reason === 'source-shrank') {
    report.stop = envelopeProblem('teardown', out);
  } else {
    report.residue.push(`${path}: ${envelopeProblem('teardown', out)}`);
  }
}

/**
 * What the cleanup does with one run.
 *
 * @param run - The run, as `live-runs` reported it.
 * @returns `null` for a live run; a {@link SkippedRun} for a spent run it
 *   must leave (unverified, dirty or of unknown dirtiness, with nested
 *   worktrees, or without a path); otherwise the path to tear down.
 */
function spentTarget(run: LiveRunOutput): { readonly path: string } | SkippedRun | null {
  const path = run.path ?? run.branch;
  if (run.spentUnverified === true) {
    return { path, why: 'its PR is over, but the PR head could not be checked' };
  }
  if (!run.spent) return null;
  if (typeof run.path !== 'string') return { path, why: 'live-runs named no path' };
  if (run.dirty !== false) {
    return { path, why: run.dirty === true ? 'uncommitted changes' : 'dirtiness unknown' };
  }
  if (!Array.isArray(run.nested) || run.nested.length > 0) {
    return { path, why: `nested worktrees: ${(run.nested ?? ['unknown']).join(', ')}` };
  }
  return { path: run.path };
}
