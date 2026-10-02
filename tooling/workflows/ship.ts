/**
 * The `ship` workflow's entry (ADR-0045): ships epics or explicit issue
 * lists unattended, one pull request per epic. Rendered into
 * `.claude/workflows/ship.js` by `tooling/render-workflows.ts` — edit this
 * source and run `npm run fix`, never the rendered file.
 *
 * {@link runShip} parses the launch arguments and runs the pre-flight
 * phase; any refusal ends the run before anything is cut, and a
 * `preflightOnly` launch stops after a clean pre-flight with the graph it
 * would schedule. A full run then tears down the spent runs pre-flight's
 * `live-runs` reported (`lib/spent-cleanup.ts`) before cutting anything: a
 * `source-shrank` teardown refuses the launch with nothing cut, and any
 * other failed teardown is residue in the report's `cleanup`. It then cuts
 * and provisions each entry's batch worktree (an entry whose cut fails is
 * reported `stopped`, its issues and their dependents dropped from the
 * graph and cited `see`), drives the scheduler over the rest
 * (`lib/drive.ts`), and returns the run report.
 *
 * **PR review**: once `drive` has returned, each PR the drive opened is
 * reviewed and gets one comment (`lib/pr-review-phase.ts` owns the phase's
 * contract).
 *
 * The epic end never tears down its own batch: while its PR is open, that
 * worktree is how `live-runs` — and so the next launch's collision check —
 * sees the run.
 *
 * **Resume** (`resumeFromRunId`) is safe only for a single-entry run at
 * `maxSlices: 1` (why: `lib/drive.ts` § Concurrency). Any other run is
 * recovered by hand once cut. ADR-0045 decision 10 holds the boundary and
 * the procedure.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { RunGraph, RunSetEntry } from '../lib/run-set.js';

import { parseShipArgs } from './lib/args.js';
import { drive, neverStarted, type DriveInput, type DriveResult } from './lib/drive.js';
import type { EpicReport, IssueReport } from './lib/epic-end.js';
import type { WorkflowHooks } from './lib/hooks.types.js';
import {
  dropWithDependents,
  runPreflight,
  type DroppedIssue,
  type OverlapRecord,
  type ShipRefusal,
} from './lib/preflight.js';
import type { EntrySetup } from './lib/slice-chain.js';
import { cleanupSpent, type CleanupReport } from './lib/spent-cleanup.js';
import {
  reviewTargets,
  runPrReviews,
  type PrReviewReport,
  type ReviewTarget,
} from './lib/pr-review-phase.js';
import { PHASE_TITLES } from './lib/stages.js';
import { envelopeProblem, PRE_CUT, runPlace, runTool } from './lib/tool-calls.js';

/** What the workflow returns. */
export interface ShipReport {
  /**
   * `refused`: nothing was cut; `preflight-ok`: a `preflightOnly` launch
   * passed; `done`: a full run ended, each entry's result in `epics`.
   */
  readonly status: 'refused' | 'preflight-ok' | 'done';
  /** Every refusal; present only when `refused`. */
  readonly refusals?: readonly ShipRefusal[];
  /** Every issue exclude mode dropped. */
  readonly dropped: readonly DroppedIssue[];
  /** The graph the run would schedule, overlap edges merged; present only when `preflight-ok`. */
  readonly graph?: RunGraph;
  /** The overlap edges pre-flight added; present unless `refused`. */
  readonly overlap?: OverlapRecord;
  /** Each entry's result, in run-set order; empty unless `done`. */
  readonly epics: readonly EpicReport[];
  /**
   * What the spent-run cleanup did; present once it ran: `done`, or
   * `refused` by its `source-shrank` stop.
   */
  readonly cleanup?: CleanupReport;
  /**
   * Each opened PR's review — or its docs-only skip — its curator's part and
   * its one comment (`null` when skipped), in review (publish) order;
   * present only when `done`, and `[]` under
   * `--pr-review off` or when no entry opened a PR.
   */
  readonly prReviews?: readonly PrReviewReport[];
}

/** An entry's cut: its setup, or the report of a cut that failed and the issues it loses. */
type EntryCut =
  | { readonly setup: EntrySetup }
  | { readonly stopped: EpicReport; readonly issues: readonly number[] };

/**
 * Run the `ship` workflow.
 *
 * @param hooks - The workflow hooks.
 * @param rawArgs - `args` as the runtime passed it.
 * @returns Resolves to the run report.
 */
export async function runShip(hooks: WorkflowHooks, rawArgs: unknown): Promise<ShipReport> {
  const parsed = parseShipArgs(rawArgs);
  if (parsed.refusal !== undefined) return refusedReport([parsed.refusal], []);
  hooks.phase(PHASE_TITLES.preflight);
  const pre = await runPreflight(hooks, parsed.args);
  if (pre.refusals.length > 0 || pre.graph === null || pre.overlap === null) {
    return refusedReport(pre.refusals, pre.dropped);
  }
  const { graph, overlap } = pre;
  if (parsed.args.preflightOnly) {
    return { status: 'preflight-ok', dropped: pre.dropped, graph, overlap, epics: [] };
  }
  const cleanup = await cleanupSpent(hooks, pre.live);
  if (cleanup.stop !== null) {
    return {
      ...refusedReport([{ kind: 'source-shrank', message: cleanup.stop }], pre.dropped),
      cleanup,
    };
  }
  hooks.phase(PHASE_TITLES.issues);
  const run = await runEntries(hooks, graph, {
    maxSlices: parsed.args.maxSlices,
    launch: pre.main,
    overlap,
    prReview: parsed.args.prReview,
  });
  const prReviews = await runPrReviews(hooks, run.targets, parsed.args.prReview);
  return { status: 'done', dropped: pre.dropped, overlap, epics: run.epics, cleanup, prReviews };
}

/**
 * Cut every entry, then drive what survives the failed cuts: the entries
 * of the graph with every issue of a failed cut and its dependents dropped,
 * each paired with its setup by `epic` key — so an entry the drop emptied
 * is never driven, and drive's entry `i` is always the graph's.
 *
 * @param hooks - The workflow hooks.
 * @param graph - Pre-flight's graph, overlap edges merged.
 * @param opts - The in-flight cap, the launch snapshot, the overlap record
 *   and the `--pr-review` setting.
 * @returns Resolves to every entry's report, in run-set order, and the PRs
 *   the drive opened, in publish order.
 */
async function runEntries(
  hooks: WorkflowHooks,
  graph: RunGraph,
  opts: Pick<DriveInput, 'maxSlices' | 'launch' | 'overlap' | 'prReview'>,
): Promise<{ readonly epics: EpicReport[]; readonly targets: ReviewTarget[] }> {
  const cuts: EntryCut[] = [];
  for (const entry of graph.runSet) cuts.push(await cutEntry(hooks, entry));
  const lost = cuts.flatMap((c) => ('stopped' in c ? c.issues : []));
  const kept = dropWithDependents(graph, lost).graph;
  const setups = kept.runSet.flatMap((entry) => {
    const cut = cuts.find((c) => 'setup' in c && c.setup.epic === entry.epic);
    return cut !== undefined && 'setup' in cut ? [cut.setup] : [];
  });
  const driven: DriveResult =
    setups.length === 0
      ? { epics: [], published: [], landed: [] }
      : await drive({ hooks, graph: kept, entries: setups, ...opts });
  const epics = cuts.map((c, k) => {
    if ('stopped' in c) {
      return {
        ...c.stopped,
        schedule: c.issues.map((n) => neverStarted(n, graph, opts.overlap)),
      };
    }
    return cutReport(c.setup, graph, k, driven.epics, opts.overlap);
  });
  return { epics, targets: reviewTargets(setups, driven) };
}

/**
 * Cut and provision one entry's batch worktree.
 *
 * @param hooks - The workflow hooks.
 * @param entry - The run-set entry.
 * @returns Resolves to the entry's setup, or a `stopped` report naming the
 *   failed command.
 */
async function cutEntry(hooks: WorkflowHooks, entry: RunSetEntry): Promise<EntryCut> {
  const tag = entry.epic === null ? 'list' : `epic-${String(entry.epic)}`;
  const selection =
    entry.epic === null ? ['--issues', entry.issues.join(',')] : ['--epic', String(entry.epic)];
  const cut = await runTool(hooks, 'cut-batch', ['.', ...selection], { ...PRE_CUT, tag });
  const { worktree, branch, base, batch, reportDir } = cut ?? {};
  if (
    cut?.status !== 'ok' ||
    !isText(worktree) ||
    !isText(branch) ||
    !isText(base) ||
    !isText(batch) ||
    !isText(reportDir)
  ) {
    return stoppedEntry(entry, branch ?? '', envelopeProblem('cut-batch', cut));
  }
  const argv = [batch, '--report-dir', reportDir];
  const prov = await runTool(hooks, 'provision-batch', argv, runPlace(reportDir, tag));
  if (prov?.status !== 'ok' || !isText(prov.registry)) {
    return stoppedEntry(entry, branch, envelopeProblem('provision-batch', prov));
  }
  const registry = prov.registry;
  return {
    setup: { epic: entry.epic, tag, branch, main: worktree, batch, base, reportDir, registry },
  };
}

/**
 * Whether a consumed field is present as a string.
 *
 * @param value - The field.
 * @returns `true` for a string.
 */
function isText(value: string | null | undefined): value is string {
  return typeof value === 'string';
}

/**
 * The report of an entry whose batch could not be set up.
 *
 * @param entry - The entry.
 * @param branch - Its branch, when the cut named one.
 * @param message - What failed.
 * @returns A `stopped` report, every issue `blocked` (its schedule filled in
 *   by the caller, which holds the graph), and the issues lost.
 */
function stoppedEntry(entry: RunSetEntry, branch: string, message: string): EntryCut {
  const stopped: EpicReport = {
    epic: entry.epic,
    branch,
    outcome: 'stopped',
    message,
    issues: entry.issues.map((issue) => ({
      issue,
      outcome: 'blocked',
      cite: 'see',
      reason: 'its batch was not set up',
    })),
    schedule: [],
    residue: [],
  };
  return { stopped, issues: entry.issues };
}

/**
 * The report of an entry that was cut: its drive report, every issue a
 * failed cut elsewhere dropped cited `see` as skipped and scheduled as
 * never started — `nothing-landed` when the drop emptied the entry.
 *
 * @param setup - The entry's setup.
 * @param graph - Pre-flight's graph.
 * @param k - The entry's index in it.
 * @param driven - The driven entries' reports.
 * @param overlap - Pre-flight's overlap record, for each never-started
 *   blocker's source.
 * @returns The report, its issues and schedule in the planned order.
 */
function cutReport(
  setup: EntrySetup,
  graph: RunGraph,
  k: number,
  driven: readonly EpicReport[],
  overlap: OverlapRecord,
): EpicReport {
  const report: EpicReport = driven.find((r) => r.epic === setup.epic) ?? {
    epic: setup.epic,
    branch: setup.branch,
    outcome: 'nothing-landed',
    issues: [],
    schedule: [],
    residue: [],
  };
  const planned = graph.runSet[k]?.issues ?? [];
  const issues = planned.map(
    (issue): IssueReport =>
      report.issues.find((r) => r.issue === issue) ?? {
        issue,
        outcome: 'skipped',
        cite: 'see',
        reason: 'a blocker lost its batch',
      },
  );
  const schedule = planned.map(
    (issue) =>
      report.schedule.find((s) => s.issue === issue) ?? neverStarted(issue, graph, overlap),
  );
  return { ...report, issues, schedule };
}

/**
 * A `refused` report.
 *
 * @param refusals - Every refusal.
 * @param dropped - Every drop.
 * @returns The report.
 */
function refusedReport(
  refusals: readonly ShipRefusal[],
  dropped: readonly DroppedIssue[],
): ShipReport {
  return { status: 'refused', refusals, dropped, epics: [] };
}
