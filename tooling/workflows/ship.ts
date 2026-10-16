/**
 * The `ship` workflow's entry (ADR-0045): ships epics or explicit issue lists unattended, one pull
 * request per epic. Rendered into `.claude/workflows/ship.js` by `tooling/render-workflows.ts` —
 * edit this source and run `npm run fix`, never the rendered file.
 *
 * Every refusal — the arguments, pre-flight, or a `source-shrank` spent-run teardown — ends the run
 * before anything is cut. The epic end never tears down its own batch: while its PR is open, that
 * worktree is how `live-runs`, and so the next launch's collision check, sees the run. An attached
 * run (`--attach ship/<slug>`, issues only, so one entry) lands on an open PR's existing branch
 * instead of cutting one. Resume (`resumeFromRunId`) is safe only for a single-entry run at
 * `maxSlices: 1`; any other run is recovered by hand once cut (`lib/drive.ts` § Concurrency;
 * ADR-0045 decision 10).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import type { RunGraph, RunSetEntry } from '../lib/run-set.js';

import { parseShipArgs } from './lib/args.js';
import { drive, neverStarted, type DriveInput } from './lib/drive.js';
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
import { withCheckout } from './lib/prompts.js';
import { PHASE_TITLES } from './lib/stages.js';
import {
  envelopeProblem,
  preCutPlace,
  runPlace,
  runTool,
  type CutBatchOutput,
  type RunAt,
} from './lib/tool-calls.js';

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
}

/** An entry's cut: its setup, or the report of a cut that failed and the issues it loses. */
type EntryCut =
  | { readonly setup: EntrySetup }
  | { readonly stopped: EpicReport; readonly issues: readonly number[] };

/** Run the `ship` workflow. */
export async function runShip(hooks: WorkflowHooks, rawArgs: unknown): Promise<ShipReport> {
  const parsed = parseShipArgs(rawArgs);
  if (parsed.refusal !== undefined) return refusedReport([parsed.refusal], []);
  hooks.phase(PHASE_TITLES.preflight);
  const pre = await runPreflight(hooks, parsed.args);
  if (
    pre.refusals.length > 0 ||
    pre.graph === null ||
    pre.overlap === null ||
    pre.checkout === null
  ) {
    return refusedReport(pre.refusals, pre.dropped);
  }
  const { graph, overlap } = pre;
  if (parsed.args.preflightOnly) {
    return { status: 'preflight-ok', dropped: pre.dropped, graph, overlap, epics: [] };
  }
  const bound = withCheckout(hooks, pre.checkout);
  const cleanup = await cleanupSpent(bound, pre.live);
  if (cleanup.stop !== null) {
    return {
      ...refusedReport([{ kind: 'source-shrank', message: cleanup.stop }], pre.dropped),
      cleanup,
    };
  }
  hooks.phase(PHASE_TITLES.issues);
  const epics = await runEntries(
    bound,
    graph,
    { maxSlices: parsed.args.maxSlices, launch: pre.main, overlap },
    parsed.args.attach,
  );
  return { status: 'done', dropped: pre.dropped, overlap, epics, cleanup };
}

/**
 * Cut every entry, then drive the graph less every issue of a failed cut and its dependents, each
 * entry paired with its setup by `epic` key — so an entry the drop emptied is never driven, and
 * drive's entry `i` is always the graph's.
 */
async function runEntries(
  hooks: WorkflowHooks,
  graph: RunGraph,
  opts: Pick<DriveInput, 'maxSlices' | 'launch' | 'overlap'>,
  attach: string | null,
): Promise<EpicReport[]> {
  const cuts: EntryCut[] = [];
  for (const entry of graph.runSet) cuts.push(await cutEntry(hooks, entry, attach));
  const lost = cuts.flatMap((c) => ('stopped' in c ? c.issues : []));
  const kept = dropWithDependents(graph, lost).graph;
  const setups = kept.runSet.flatMap((entry) => {
    const cut = cuts.find((c) => 'setup' in c && c.setup.epic === entry.epic);
    return cut !== undefined && 'setup' in cut ? [cut.setup] : [];
  });
  const driven =
    setups.length === 0 ? [] : await drive({ hooks, graph: kept, entries: setups, ...opts });
  return cuts.map((c, k) => {
    if ('stopped' in c) {
      return {
        ...c.stopped,
        schedule: c.issues.map((n) => neverStarted(n, graph, opts.overlap)),
      };
    }
    return cutReport(c.setup, graph, k, driven, opts.overlap);
  });
}

/**
 * Cut and provision one entry's batch worktree — or, for an attached run, attach the open PR's
 * branch's batch; a failed command yields a `stopped` report naming it.
 */
async function cutEntry(
  hooks: WorkflowHooks,
  entry: RunSetEntry,
  attach: string | null,
): Promise<EntryCut> {
  const tag = entry.epic === null ? 'list' : `epic-${String(entry.epic)}`;
  const argv = ['.', ...cutSelection(entry, attach)];
  const cut = await runTool(hooks, 'cut-batch', argv, preCutPlace(tag));
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
  const attached =
    typeof cut.attach?.run === 'number' ? { run: cut.attach.run, pr: cut.attach.pr } : null;
  if (attach !== null && attached === null) {
    return stoppedEntry(entry, branch, 'cut-batch --attach named no attached run');
  }
  const at = { batch, reportDir, tag };
  const found = await batchRegistry(hooks, cut.attach ?? null, at);
  if ('stop' in found) return stoppedEntry(entry, branch, found.stop);
  const { registry } = found;
  return {
    setup: {
      epic: entry.epic,
      tag,
      branch,
      main: worktree,
      batch,
      base,
      reportDir,
      registry,
      attached,
    },
  };
}

function cutSelection(entry: RunSetEntry, attach: string | null): string[] {
  if (attach !== null) return ['--attach', attach, '--attached-run'];
  return entry.epic === null
    ? ['--issues', entry.issues.join(',')]
    : ['--epic', String(entry.epic)];
}

/**
 * The batch's trimmed pool registry: a reused attached batch's, as `cut-batch --attach` found it —
 * none stops the entry — otherwise `provision-batch`'s, provisioning a batch cut or checked out
 * anew.
 */
async function batchRegistry(
  hooks: WorkflowHooks,
  attached: NonNullable<CutBatchOutput['attach']> | null,
  at: RunAt & { readonly batch: string; readonly tag: string },
): Promise<{ readonly registry: string } | { readonly stop: string }> {
  if (attached !== null && !attached.created) {
    return attached.registry === null
      ? { stop: 'cut-batch --attach found no trimmed pool registry for the reused batch' }
      : { registry: attached.registry };
  }
  const argv = [at.batch, '--report-dir', at.reportDir];
  const prov = await runTool(hooks, 'provision-batch', argv, runPlace(at, at.tag));
  if (prov?.status !== 'ok' || !isText(prov.registry)) {
    return { stop: envelopeProblem('provision-batch', prov) };
  }
  return { registry: prov.registry };
}

function isText(value: string | null | undefined): value is string {
  return typeof value === 'string';
}

/**
 * The `stopped` report of an entry whose batch could not be set up: every issue `blocked`, cited
 * `see`; the caller, which holds the graph, fills in its schedule.
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
 * The report of an entry that was cut: its drive report, every issue a failed cut elsewhere
 * dropped cited `see` as skipped and scheduled as never started — `nothing-landed` when the drop
 * emptied the entry.
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

function refusedReport(
  refusals: readonly ShipRefusal[],
  dropped: readonly DroppedIssue[],
): ShipReport {
  return { status: 'refused', refusals, dropped, epics: [] };
}
