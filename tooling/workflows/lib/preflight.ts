/**
 * The `ship` workflow's pre-flight phase (ADR-0045): everything a run must hold before it cuts
 * anything. In order: `worktree.ts preflight` (master level, `gh` logged in, the warm set — always
 * checked, since server-tier tdd runs lease it), the run gate, `live-runs`, the scout once over the
 * run set and the unspent live runs' files, then the overlap estimate once over what it left.
 *
 * **Every refusal is collected**: no check stops the phase early but the scout's need for a run
 * set. No verdict, or a verdict missing its backing fields, is a refusal, as is a run-set issue the
 * scout returns no verdict for — never a pass. **Exclude mode** drops a stale issue with its
 * dependents ({@link dropWithDependents}); a live-run code overlap, and any overlap
 * {@link settleOverlap} keeps across two epics, still refuses. **An attached run**'s `no-open-pr`,
 * `slices-live` and `unpublished-commits` refuse like any check; {@link runScout} owns the target.
 * **A leftover slice branch** refuses unless its run is spent ({@link exemptSpentSlices}).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level effect.
 */

import { GENERATED_FILES } from '../../lib/generated-files.js';
import type { GateFailure } from '../../lib/run-gate.js';
import {
  mergeOverlapEdges,
  type OverlapCrossPair,
  type OverlapMerge,
  type OverlapPair,
} from '../../lib/run-overlap.js';
import {
  runSetIssues,
  transitiveDependents,
  type RunEdge,
  type RunGraph,
} from '../../lib/run-set.js';
import { runSlug } from '../../lib/run-slug.js';
import type { PreflightCheck, PreflightResult } from '../../worktree/types-run.js';

import {
  AGENT_CALLS,
  type EstimatedPair,
  type OverlapConfidence,
  type ScoutVerdict,
} from './agent-calls.js';
import type { ShipArgs } from './args.js';
import type { WorkflowHooks } from './hooks.types.js';
import type { LiveRunFiles } from './prompts.js';
import {
  runTool,
  type GateOutput,
  type LiveRunsOutput,
  type PreflightOutput,
} from './tool-calls.js';

/**
 * What stopped a launch: `usage` (the arguments); a failed pre-flight check
 * or `preflight-error`; a gate failure kind or `gate-error`;
 * `live-runs-failed`; `stale`, `overlap` or `scout-unavailable` (the
 * scout); `empty-run-set` (exclude mode dropped everything);
 * `overlap-cross-epic` or `overlap-estimate-failed` (the overlap estimate);
 * `source-shrank` (the launch's spent-run cleanup: a teardown found a link
 * target shrank).
 */
export type ShipRefusalKind =
  | 'usage'
  | PreflightCheck
  | 'preflight-error'
  | GateFailure['kind']
  | 'gate-error'
  | 'live-runs-failed'
  | 'stale'
  | 'overlap'
  | 'scout-unavailable'
  | 'overlap-cross-epic'
  | 'overlap-estimate-failed'
  | 'source-shrank';

/** One reason the run may not start. */
export interface ShipRefusal {
  /** What failed. */
  readonly kind: ShipRefusalKind;
  /** The issue it concerns, when one does. */
  readonly issue?: number;
  /** What was found. */
  readonly message: string;
}

/** One issue exclude mode dropped from the run. */
export interface DroppedIssue {
  /** The issue. */
  readonly issue: number;
  /**
   * `gate`: the gate dropped it; `stale`: the scout found it stale; `dependent`: a dropped issue
   * blocks it.
   */
  readonly cause: 'gate' | 'stale' | 'dependent';
  /** Why, from the gate or the scout. */
  readonly message: string;
}

/** What pre-flight found. */
export interface PreflightOutcome {
  /** Every refusal, in check order; empty when the run may start. */
  readonly refusals: readonly ShipRefusal[];
  /** Every issue dropped, gate drops first. */
  readonly dropped: readonly DroppedIssue[];
  /** The run graph to schedule, drops applied; `null` when the gate gave none. */
  readonly graph: RunGraph | null;
  /**
   * The main checkout as pre-flight found it — the baseline of the epic
   * end's main-untouched comparison and master check; `null` unless the
   * checks passed.
   */
  readonly main: MainSnapshot | null;
  /** The overlap edges merged into `graph`; `null` when the estimate failed or never ran. */
  readonly overlap: OverlapRecord | null;
  /**
   * `live-runs`' answer as pre-flight read it, reused by the launch's
   * spent-run cleanup; `null` when the runner returned none.
   */
  readonly live: LiveRunsOutput | null;
}

/** An overlap edge pre-flight added, with the estimator's word for it. */
export type OverlapEdge = RunEdge & {
  /** How sure the estimator was. */
  readonly confidence: OverlapConfidence;
  /** What backs it. */
  readonly reason: string;
};

/** What the overlap estimate added to the run graph. */
export interface OverlapRecord {
  /** The edges added, sorted by (`blocker`, `dependent`). */
  readonly added: readonly OverlapEdge[];
  /** The pairs the declared edges already order: nothing added. */
  readonly sequenced: readonly OverlapPair[];
  /** Whether the estimator could read the area map. */
  readonly areaMap: 'read' | 'unavailable';
}

/** The main checkout at one moment, as `worktree.ts preflight` reports it. */
export interface MainSnapshot {
  /** The main checkout, absolute. */
  readonly worktree: string;
  /**
   * Its `HEAD`, whether it had uncommitted changes, and the launch shas of local and `origin`'s
   * `master`.
   */
  readonly snapshot: NonNullable<PreflightResult['snapshot']>;
}

/** A graph with issues dropped. */
export interface DropResult {
  /** The remaining graph. */
  readonly graph: RunGraph;
  /** The dropped issues' transitive dependents that were dropped with them, ascending. */
  readonly dependents: readonly number[];
}

/**
 * Run the pre-flight phase.
 *
 * @param hooks - The workflow hooks.
 * @param args - The launch arguments.
 * @returns Resolves to every refusal, every drop and the graph to schedule.
 */
export async function runPreflight(
  hooks: WorkflowHooks,
  args: ShipArgs,
): Promise<PreflightOutcome> {
  const checks = await runTool(hooks, 'preflight', preflightArgv(args));
  const gate = await runTool(hooks, 'run-gate', [
    args.selection,
    ...args.numbers.map(String),
    ...(args.exclude ? ['--exclude'] : []),
  ]);
  const live = await runTool(hooks, 'live-runs', ['.']);
  const kept = exemptSpentSlices(checks, live);
  const refusals = [...checkRefusals(kept), ...gateRefusals(gate), ...liveRunRefusals(live)];
  const main = mainSnapshot(kept);
  if (gate?.runSet === undefined) {
    return { refusals, dropped: [], graph: null, main, overlap: null, live };
  }
  const graph = { runSet: gate.runSet, edges: gate.edges ?? [] };
  const scout = await runScout(hooks, graph, live, args.attach);
  const found = { refusals, dropped: gateDrops(gate), graph, main, overlap: null, live };
  return settleOverlap(hooks, settleScout(found, scout, args.exclude));
}

/**
 * `preflight`'s argv: an attached run's target, or every run slug the launch cuts — one per epic,
 * or the list's.
 */
function preflightArgv(args: ShipArgs): string[] {
  if (args.attach !== null) return ['.', '--attach', args.attach];
  const slugs =
    args.selection === 'epics'
      ? args.numbers.map((epic) => runSlug({ epic }))
      : [runSlug({ issues: args.numbers })];
  return ['.', '--slug', slugs.join(',')];
}

/**
 * `preflight`'s output less each `stale-slice-branch` problem ending `of <branch>` of a spent run:
 * cleanup retires that run, or leaves its run branch so `cut-batch` refuses before any slice.
 * A refusal left with no problem reads as `ok` (launch baseline kept); one that named none, as is.
 */
function exemptSpentSlices(
  checks: PreflightOutput | null,
  live: LiveRunsOutput | null,
): PreflightOutput | null {
  if (checks?.status !== 'refused' || checks.reason !== 'preflight-failed') return checks;
  const all = checks.problems ?? [];
  const tails = (live?.runs ?? []).filter((r) => r.spent).map((r) => ` of ${r.branch}`);
  const problems = all.filter(
    (p) => p.check !== 'stale-slice-branch' || !tails.some((t) => p.message.endsWith(t)),
  );
  if (problems.length === all.length) return checks;
  if (problems.length > 0) return { ...checks, problems };
  const ok: PreflightOutput = { ...checks, status: 'ok', problems };
  delete ok.reason;
  return ok;
}

/**
 * Merge the estimate's pairs, `likely` and `unsure` alike, into a graph of two or more issues,
 * first dropping a pair that shares only generated files (#1294); one `overlap-cross-epic` refusal
 * per cross-entry pair, one `overlap-estimate-failed` for no answer or a throwing merge.
 */
async function settleOverlap(
  hooks: WorkflowHooks,
  found: PreflightOutcome,
): Promise<PreflightOutcome> {
  const { graph } = found;
  if (graph === null || runSetIssues(graph.runSet).length < 2) {
    return { ...found, overlap: { added: [], sequenced: [], areaMap: 'read' } };
  }
  const estimate = await AGENT_CALLS.overlapEstimator(hooks, graph);
  if (estimate === null) {
    return withRefusals(found, [
      { kind: 'overlap-estimate-failed', message: 'the overlap estimator returned nothing' },
    ]);
  }
  const pairs = estimate.pairs.filter((p) => !generatedOnly(p));
  let merged: OverlapMerge;
  try {
    merged = mergeOverlapEdges(graph, pairs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return withRefusals(found, [{ kind: 'overlap-estimate-failed', message }]);
  }
  if (merged.kind === 'cross-entry') {
    return withRefusals(
      found,
      merged.pairs.map((p) => crossEpicRefusal(p, pairs)),
    );
  }
  const overlap: OverlapRecord = {
    added: merged.added.map((e) => ({ ...e, ...pairWord(e.blocker, e.dependent, pairs) })),
    sequenced: merged.sequenced,
    areaMap: estimate.areaMap,
  };
  return { ...found, graph: merged.graph, overlap };
}

function generatedOnly(pair: EstimatedPair): boolean {
  return pair.shared.length > 0 && pair.shared.every((s) => GENERATED_FILES.includes(s));
}

/** The outcome with more refusals, its `overlap` set to `null`. */
function withRefusals(found: PreflightOutcome, refusals: readonly ShipRefusal[]): PreflightOutcome {
  return { ...found, refusals: [...found.refusals, ...refusals], overlap: null };
}

/**
 * The refusal of a pair across epics, on its first issue — any confidence: epics in one run must
 * be code-disjoint.
 */
function crossEpicRefusal(pair: OverlapCrossPair, pairs: readonly EstimatedPair[]): ShipRefusal {
  const word = pairs.find((p) => samePair(p, pair.a, pair.b));
  const epic = (e: number | null): string =>
    e === null ? 'the explicit list' : `epic #${String(e)}`;
  const shared = word === undefined ? '' : `; shared ${word.shared.join(', ')}`;
  return {
    kind: 'overlap-cross-epic',
    issue: pair.a,
    message:
      `#${String(pair.a)} (${epic(pair.epicA)}) and #${String(pair.b)} (${epic(pair.epicB)}) ` +
      `may overlap (${word?.confidence ?? 'unsure'})${shared}: ${word?.reason ?? 'no reason given'}` +
      '; epics in one run must be code-disjoint',
  };
}

/** The estimator's confidence and reason for one unordered pair: its first matching pair's. */
function pairWord(
  a: number,
  b: number,
  pairs: readonly EstimatedPair[],
): Pick<OverlapEdge, 'confidence' | 'reason'> {
  const word = pairs.find((p) => samePair(p, a, b));
  return { confidence: word?.confidence ?? 'unsure', reason: word?.reason ?? '' };
}

/** Whether an estimated pair is the unordered pair `{a, b}`, in either order. */
function samePair(p: OverlapPair, a: number, b: number): boolean {
  return (p.a === a && p.b === b) || (p.a === b && p.b === a);
}

/**
 * The main checkout and its snapshot from `preflight`'s output; `null` unless the checks passed and
 * carry both.
 */
function mainSnapshot(checks: PreflightOutput | null): MainSnapshot | null {
  const snapshot = checks?.status === 'ok' ? checks.snapshot : undefined;
  if (typeof checks?.worktree !== 'string' || snapshot === undefined || snapshot === null) {
    return null;
  }
  return { worktree: checks.worktree, snapshot };
}

/**
 * Drop `issues` from a graph together with their transitive dependents, every edge with a dropped
 * endpoint, and every entry left empty — so the result is a valid scheduler input whenever `graph`
 * is. An issue not in the graph is ignored.
 */
export function dropWithDependents(graph: RunGraph, issues: readonly number[]): DropResult {
  const inGraph = new Set(runSetIssues(graph.runSet));
  const roots = issues.filter((n) => inGraph.has(n));
  const dependents = transitiveDependents(roots, graph.edges);
  const gone = new Set([...roots, ...dependents]);
  return {
    graph: {
      runSet: graph.runSet
        .map((entry) => ({ epic: entry.epic, issues: entry.issues.filter((n) => !gone.has(n)) }))
        .filter((entry) => entry.issues.length > 0),
      edges: graph.edges.filter((e) => !gone.has(e.blocker) && !gone.has(e.dependent)),
    },
    dependents,
  };
}

/**
 * The pre-flight checks' refusals: one per failed check; one `preflight-error` when the command
 * itself failed, or refused `preflight-failed` naming no problem.
 */
function checkRefusals(checks: PreflightOutput | null): ShipRefusal[] {
  if (checks?.status === 'ok') return [];
  const problems =
    checks?.status === 'refused' && checks.reason === 'preflight-failed'
      ? (checks.problems ?? [])
      : [];
  if (problems.length > 0) return problems.map((p) => ({ kind: p.check, message: p.message }));
  return [{ kind: 'preflight-error', message: toolError(checks, 'preflight') }];
}

/**
 * The gate's refusals: none only for an `ok` carrying its `runSet` and `edges`; no verdict, an `ok`
 * without its graph, or a refusal naming no failure is one `gate-error`.
 */
function gateRefusals(gate: GateOutput | null): ShipRefusal[] {
  if (gate?.verdict === 'ok' && gate.runSet !== undefined && gate.edges !== undefined) return [];
  const failures = gate?.verdict === 'refused' ? (gate.failures ?? []) : [];
  if (failures.length > 0) {
    return failures.map((f) => ({
      kind: f.kind,
      ...('issue' in f ? { issue: f.issue } : {}),
      message: f.message,
    }));
  }
  return [{ kind: 'gate-error', message: toolError(gate, 'run gate') }];
}

/**
 * The gate's exclude-mode drops.
 *
 * @param gate - An `ok` gate's output.
 * @returns One drop per exclusion, with the matching failure's message.
 */
function gateDrops(gate: GateOutput): DroppedIssue[] {
  return (gate.excluded ?? []).map((x) => {
    if (x.cause === 'dependent') {
      const blockers = x.blockers.map((b) => `#${String(b)}`).join(', ');
      return { issue: x.issue, cause: 'dependent', message: `blocked by dropped ${blockers}` };
    }
    const failure = (gate.failures ?? []).find((f) => 'issue' in f && f.issue === x.issue);
    return { issue: x.issue, cause: 'gate', message: failure?.message ?? 'failed the run gate' };
  });
}

/**
 * The live-runs refusal: the command failed, an `ok` came without its `runs` list, or a run's PR
 * state is unknown — "could not ask" is never read as "no PR".
 */
function liveRunRefusals(live: LiveRunsOutput | null): ShipRefusal[] {
  if (live?.status !== 'ok' || live.runs === undefined) {
    return [{ kind: 'live-runs-failed', message: toolError(live, 'live-runs') }];
  }
  const unknown = live.runs.filter((r) => r.pr.state === 'unknown');
  if (unknown.length === 0) return [];
  const branches = unknown.map((r) => r.branch).join(', ');
  return [{ kind: 'live-runs-failed', message: `pull request state unknown for ${branches}` }];
}

/**
 * Run the scout over the gate's run set and the unspent live runs' files — for an attached run,
 * every such run but its target, judged against the target's PR head.
 */
async function runScout(
  hooks: WorkflowHooks,
  graph: RunGraph,
  live: LiveRunsOutput | null,
  attach: string | null,
): Promise<ScoutVerdict | null> {
  const liveRuns: LiveRunFiles[] = (live?.runs ?? [])
    .filter((r) => !r.spent && r.branch !== attach)
    .map((r) => ({ branch: r.branch, landed: r.landed }));
  const issues = runSetIssues(graph.runSet);
  return AGENT_CALLS.scout(hooks, {
    issues,
    liveRuns,
    ...(attach === null ? {} : { prHead: `origin/${attach}` }),
  });
}

/**
 * Fold the scout's verdict in: overlaps and (outside exclude mode) stale issues refuse; in exclude
 * mode stale issues drop with their dependents.
 */
function settleScout(
  found: PreflightOutcome & { readonly graph: RunGraph },
  scout: ScoutVerdict | null,
  exclude: boolean,
): PreflightOutcome {
  const issues = runSetIssues(found.graph.runSet);
  const judged = new Set((scout?.issues ?? []).map((v) => v.issue));
  const unjudged = issues.filter((n) => !judged.has(n));
  const refusals = [...found.refusals];
  if (unjudged.length > 0) {
    refusals.push({
      kind: 'scout-unavailable',
      message: `no scout verdict for ${unjudged.map((n) => `#${String(n)}`).join(', ')}`,
    });
  }
  for (const o of scout?.overlaps ?? []) {
    refusals.push({ kind: 'overlap', issue: o.issue, message: `${o.branch}: ${o.evidence}` });
  }
  const stale = (scout?.issues ?? []).filter((v) => v.stale && issues.includes(v.issue));
  if (!exclude) {
    for (const v of stale) refusals.push({ kind: 'stale', issue: v.issue, message: v.evidence });
    return { ...found, refusals };
  }
  const { graph, dependents } = dropWithDependents(
    found.graph,
    stale.map((v) => v.issue),
  );
  if (graph.runSet.length === 0) {
    refusals.push({ kind: 'empty-run-set', message: 'no issue is left after the stale drops' });
  }
  const dropped: DroppedIssue[] = [
    ...found.dropped,
    ...stale.map((v): DroppedIssue => ({ issue: v.issue, cause: 'stale', message: v.evidence })),
    ...dependents.map(
      (n): DroppedIssue => ({ issue: n, cause: 'dependent', message: 'blocked by a stale issue' }),
    ),
  ];
  return { ...found, refusals, dropped, graph };
}

/** Why a tool gave no usable verdict: its stderr tail, first error or refusal reason. */
function toolError(
  out: {
    readonly stderrTail?: string;
    readonly errors?: readonly { readonly message: string }[];
    readonly reason?: string;
    readonly exitCode: number;
  } | null,
  what: string,
): string {
  if (out === null) return `the runner returned nothing for ${what}`;
  return (
    out.stderrTail ??
    out.errors?.[0]?.message ??
    out.reason ??
    `${what} exited ${String(out.exitCode)} with no usable verdict`
  );
}
