/**
 * The `ship` workflow's entry (ADR-0045): ships epics or explicit issue
 * lists unattended, one pull request per epic. Rendered into
 * `.claude/workflows/ship.js` by `tooling/render-workflows.ts` — edit this
 * source and run `npm run codegen`, never the rendered file.
 *
 * {@link runShip} parses the launch arguments and runs the pre-flight
 * phase; any refusal ends the run before anything is cut, and a
 * `preflightOnly` launch stops after a clean pre-flight with the graph it
 * would schedule. A full run then cuts and provisions each entry's batch
 * worktree (an entry whose cut fails is reported `stopped`, its issues and
 * their dependents dropped from the graph and cited `see`), drives the
 * scheduler over the rest (`lib/drive.ts`), and returns the run report.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { RunGraph, RunSetEntry } from '../lib/run-set.js';

import { parseShipArgs } from './lib/args.js';
import { envelopeProblem } from './lib/commit-queue.js';
import { drive, type DriveInput } from './lib/drive.js';
import type { EpicReport, IssueReport } from './lib/epic-end.js';
import type { WorkflowHooks } from './lib/hooks.types.js';
import {
  dropWithDependents,
  runPreflight,
  type DroppedIssue,
  type ShipRefusal,
} from './lib/preflight.js';
import type { EntrySetup } from './lib/slice-chain.js';
import { PHASE_TITLES } from './lib/stages.js';
import { PRE_CUT, runPlace, runTool } from './lib/tool-calls.js';

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
  /** The graph the run would schedule; present only when `preflight-ok`. */
  readonly graph?: RunGraph;
  /** Each entry's result, in run-set order; empty unless `done`. */
  readonly epics: readonly EpicReport[];
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
  if (pre.refusals.length > 0 || pre.graph === null) {
    return refusedReport(pre.refusals, pre.dropped);
  }
  if (parsed.args.preflightOnly) {
    return { status: 'preflight-ok', dropped: pre.dropped, graph: pre.graph, epics: [] };
  }
  hooks.phase(PHASE_TITLES.issues);
  const epics = await runEntries(hooks, pre.graph, {
    maxSlices: parsed.args.maxSlices,
    launch: pre.main,
  });
  return { status: 'done', dropped: pre.dropped, epics };
}

/**
 * Cut every entry, then drive what survives the failed cuts: the entries
 * of the graph with every issue of a failed cut and its dependents dropped,
 * each paired with its setup by `epic` key — so an entry the drop emptied
 * is never driven, and drive's entry `i` is always the graph's.
 *
 * @param hooks - The workflow hooks.
 * @param graph - Pre-flight's graph.
 * @param opts - The authoring cap and the launch snapshot.
 * @returns Resolves to every entry's report, in run-set order.
 */
async function runEntries(
  hooks: WorkflowHooks,
  graph: RunGraph,
  opts: Pick<DriveInput, 'maxSlices' | 'launch'>,
): Promise<EpicReport[]> {
  const cuts: EntryCut[] = [];
  for (const entry of graph.runSet) cuts.push(await cutEntry(hooks, entry));
  const lost = cuts.flatMap((c) => ('stopped' in c ? c.issues : []));
  const kept = dropWithDependents(graph, lost).graph;
  const setups = kept.runSet.flatMap((entry) => {
    const cut = cuts.find((c) => 'setup' in c && c.setup.epic === entry.epic);
    return cut !== undefined && 'setup' in cut ? [cut.setup] : [];
  });
  const driven =
    setups.length === 0 ? [] : await drive({ hooks, graph: kept, entries: setups, ...opts });
  return cuts.map((c, k) =>
    'stopped' in c ? c.stopped : cutReport(c.setup, graph.runSet[k], driven),
  );
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
  const { worktree, branch, batch, reportDir } = cut ?? {};
  if (
    cut?.status !== 'ok' ||
    !isText(worktree) ||
    !isText(branch) ||
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
  return { setup: { epic: entry.epic, tag, branch, main: worktree, batch, reportDir, registry } };
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
 * @returns A `stopped` report, every issue `blocked`, and the issues lost.
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
    residue: [],
  };
  return { stopped, issues: entry.issues };
}

/**
 * The report of an entry that was cut: its drive report, every issue a
 * failed cut elsewhere dropped cited `see` as skipped — `nothing-landed`
 * when the drop emptied the entry.
 *
 * @param setup - The entry's setup.
 * @param entry - The entry as pre-flight planned it.
 * @param driven - The driven entries' reports.
 * @returns The report, its issues in the planned order.
 */
function cutReport(
  setup: EntrySetup,
  entry: RunSetEntry | undefined,
  driven: readonly EpicReport[],
): EpicReport {
  const report: EpicReport = driven.find((r) => r.epic === setup.epic) ?? {
    epic: setup.epic,
    branch: setup.branch,
    outcome: 'nothing-landed',
    issues: [],
    residue: [],
  };
  const issues = (entry?.issues ?? []).map(
    (issue): IssueReport =>
      report.issues.find((r) => r.issue === issue) ?? {
        issue,
        outcome: 'skipped',
        cite: 'see',
        reason: 'a blocker lost its batch',
      },
  );
  return { ...report, issues };
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
