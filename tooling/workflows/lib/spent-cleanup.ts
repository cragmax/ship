/**
 * The saved workflows' spent-run cleanup, run by `/ship`'s launch and `/resync`'s pre-flight: tear
 * down each live run whose PR is over and whose tip is in that PR's head (`live-runs`' `spent`),
 * guarded — only a batch known clean, with no worktree nested inside it — then, after an `ok`
 * teardown, retire the run (`retire-run`).
 *
 * - **Unknown is not none**: a `live-runs` that failed, or answered without its runs, blocks the
 *   cleanup — no teardown at all — and the caller goes on.
 * - **Unverified is not spent**: a run whose PR head cannot be checked (`spentUnverified`) is
 *   skipped and reported, never torn down.
 * - **A shrunk link target stops the caller** (teardown's `source-shrank` refusal): something
 *   outside the batch lost files. Other teardown failures are residue; the next run is still tried.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level effect.
 */

import type { WorkflowHooks } from './hooks.types.js';
import {
  envelopeProblem,
  preCutPlace,
  runTool,
  type LiveRunOutput,
  type LiveRunsOutput,
} from './tool-calls.js';

/** A spent run left standing, and why. */
export interface SkippedRun {
  /** The run's worktree. */
  readonly path: string;
  /** Why it was not torn down. */
  readonly why: string;
}

/** What the cleanup did. */
export interface CleanupReport {
  /** The worktrees torn down, in `live-runs` order. */
  readonly tornDown: string[];
  /** The run branches retired, in `live-runs` order. */
  readonly retired: string[];
  /** The spent (or unverified) runs left standing. */
  readonly skipped: SkippedRun[];
  /** What each failed teardown or non-`ok` retire-run left behind, one line each. */
  readonly residue: string[];
  /** Why no run was looked at; `null` when `live-runs` answered. */
  blocked: string | null;
  /** Why the caller must stop; `null` unless a teardown refused `source-shrank`. */
  stop: string | null;
}

/**
 * Tear down the spent runs `live-runs` reported.
 *
 * @param hooks - The workflow hooks.
 * @param live - `live-runs`' output; `null` when the runner returned none.
 * @param main - The main checkout its calls run from; `undefined` where no pre-flight named it.
 * @returns Resolves to the report; never rejects on a tool's outcome.
 */
export async function cleanupSpent(
  hooks: WorkflowHooks,
  live: LiveRunsOutput | null,
  main?: string,
): Promise<CleanupReport> {
  const report: CleanupReport = {
    tornDown: [],
    retired: [],
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
    await cleanupRun(hooks, run, report, main);
    if (report.stop !== null) break;
  }
  return report;
}

/**
 * Clean up one run: leave a live one, skip a spent one it must leave, tear
 * the rest down.
 *
 * @param report - The report; records what happened.
 */
async function cleanupRun(
  hooks: WorkflowHooks,
  run: LiveRunOutput,
  report: CleanupReport,
  main: string | undefined,
): Promise<void> {
  const target = spentTarget(run);
  if (target === null) return;
  if ('why' in target) report.skipped.push(target);
  else await tearDownSpent(hooks, { path: target.path, branch: run.branch, main }, report);
}

/**
 * Tear one spent run down, then retire its `branch`, recording each outcome on `report`: the path
 * in `tornDown` and the branch in `retired`, a `residue` line (a failed teardown or a non-`ok`
 * retire-run), or `stop` for a `source-shrank` refusal.
 */
async function tearDownSpent(
  hooks: WorkflowHooks,
  spent: { readonly path: string; readonly branch: string; readonly main: string | undefined },
  report: CleanupReport,
): Promise<void> {
  const { path, branch } = spent;
  const place = preCutPlace(
    spent.main,
    `spent-${String(report.tornDown.length + report.residue.length + 1)}`,
  );
  const out = await runTool(hooks, 'teardown', [path], place);
  if (out?.status === 'ok') {
    report.tornDown.push(path);
    const retired = await runTool(hooks, 'retire-run', ['.', '--branch', branch], place);
    if (retired?.status === 'ok') report.retired.push(branch);
    else report.residue.push(`${branch}: ${envelopeProblem('retire-run', retired)}`);
  } else if (out?.status === 'refused' && out.reason === 'source-shrank') {
    report.stop = envelopeProblem('teardown', out);
  } else {
    report.residue.push(`${path}: ${envelopeProblem('teardown', out)}`);
  }
}

/**
 * What the cleanup does with one run; it leaves a spent run that is unverified, dirty or of unknown
 * dirtiness, or has nested worktrees. Reads `path` and `nested` unguarded: the `live-runs` row
 * schema requires both, and the runner's answer is held to it.
 */
function spentTarget(run: LiveRunOutput): { readonly path: string } | SkippedRun | null {
  if (run.spentUnverified) {
    return { path: run.path, why: 'its PR is over, but the PR head could not be checked' };
  }
  if (!run.spent) return null;
  if (run.dirty !== false) {
    return {
      path: run.path,
      why: run.dirty === true ? 'uncommitted changes' : 'dirtiness unknown',
    };
  }
  if (run.nested.length > 0) {
    return { path: run.path, why: `nested worktrees: ${run.nested.join(', ')}` };
  }
  return { path: run.path };
}
