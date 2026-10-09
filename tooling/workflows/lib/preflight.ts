/**
 * The `ship` workflow's pre-flight phase (ADR-0045): everything a run must
 * hold before it cuts anything. It runs, in order, `worktree.ts preflight`
 * (master level with `origin/master`, `gh` logged in, the warm set
 * answering — the warm set is always checked, since a slice's server-tier
 * tdd runs lease it), the run gate, `worktree.ts live-runs`, then the scout
 * once, over the gate's run set and the changed files of every unspent live
 * run (a spent run's PR is merged or closed, so it can no longer collide),
 * then the overlap estimate once over what the scout left
 * ({@link PreflightOutcome.overlap}).
 *
 * **Every refusal is collected.** No check stops the phase early — one
 * report names every problem found, so a maintainer fixes them in one
 * pass — except that the scout needs a run set, so a gate output without
 * one skips it. A tool that returns no verdict, or a verdict without the
 * fields that back it (a refusal naming no problem, an `ok` without its
 * graph or runs list), is itself a refusal, and so is a run-set issue the
 * scout returns no verdict for: never read as a pass.
 *
 * **Exclude mode** drops a stale issue with its dependents through
 * {@link dropWithDependents}, as the gate drops a failing one; a code
 * overlap with a live run always refuses, and so does any overlap
 * {@link settleOverlap} keeps between two epics of the run, `unsure` included.
 *
 * **An attached run** (`args.attach`) runs `preflight --attach <branch>`,
 * whose `no-open-pr`, `slices-live` and `unpublished-commits` problems on
 * the target refuse like any failed check; the scout treats the target as
 * {@link runScout} states.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
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
  /** `gate`: the gate dropped it; `stale`: the scout found it stale; `dependent`: a dropped issue blocks it. */
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
  /** Its `HEAD`, whether it had uncommitted changes, and the launch shas of local and `origin`'s `master`. */
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
  const checks = await runTool(
    hooks,
    'preflight',
    args.attach === null ? ['.'] : ['.', '--attach', args.attach],
  );
  const gate = await runTool(hooks, 'run-gate', [
    args.selection,
    ...args.numbers.map(String),
    ...(args.exclude ? ['--exclude'] : []),
  ]);
  const live = await runTool(hooks, 'live-runs', ['.']);
  const refusals = [...checkRefusals(checks), ...gateRefusals(gate), ...liveRunRefusals(live)];
  const main = mainSnapshot(checks);
  if (gate?.runSet === undefined) {
    return { refusals, dropped: [], graph: null, main, overlap: null, live };
  }
  const graph = { runSet: gate.runSet, edges: gate.edges ?? [] };
  const scout = await runScout(hooks, graph, live, args.attach);
  const found = { refusals, dropped: gateDrops(gate), graph, main, overlap: null, live };
  return settleOverlap(hooks, settleScout(found, scout, args.exclude));
}

/**
 * Run the overlap estimate over the settled graph and merge its pairs —
 * every pair, `likely` and `unsure` alike — into the graph
 * (`tooling/lib/run-overlap.ts`). A graph of fewer than two issues needs no
 * estimate. A pair whose every shared path is a generated file is dropped
 * first: it adds no edge and refuses nothing (#1294).
 *
 * @param hooks - The workflow hooks.
 * @param found - The outcome so far; its refusals are kept.
 * @returns The outcome with the merged graph and its overlap record; or with
 *   one `overlap-cross-epic` refusal per pair across entries, or one
 *   `overlap-estimate-failed` refusal when the estimator returned nothing or
 *   the merge threw.
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

/**
 * The outcome with more refusals.
 *
 * @param found - The outcome.
 * @param refusals - The refusals to add.
 * @returns The outcome, `overlap` `null`.
 */
function withRefusals(found: PreflightOutcome, refusals: readonly ShipRefusal[]): PreflightOutcome {
  return { ...found, refusals: [...found.refusals, ...refusals], overlap: null };
}

/**
 * The refusal of a pair across epics — any confidence: epics in one run
 * must be code-disjoint.
 *
 * @param pair - The pair and both entries' `epic` keys.
 * @param pairs - The estimator's pairs, for its word on this one.
 * @returns The refusal, on the pair's first issue.
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

/**
 * The estimator's confidence and reason for one unordered pair.
 *
 * @param a - One issue.
 * @param b - The other.
 * @param pairs - The estimator's pairs.
 * @returns The first matching pair's word.
 */
function pairWord(
  a: number,
  b: number,
  pairs: readonly EstimatedPair[],
): Pick<OverlapEdge, 'confidence' | 'reason'> {
  const word = pairs.find((p) => samePair(p, a, b));
  return { confidence: word?.confidence ?? 'unsure', reason: word?.reason ?? '' };
}

/**
 * Whether an estimated pair is the unordered pair `{a, b}`.
 *
 * @param p - The estimated pair.
 * @param a - One issue.
 * @param b - The other.
 * @returns `true` for either order.
 */
function samePair(p: OverlapPair, a: number, b: number): boolean {
  return (p.a === a && p.b === b) || (p.a === b && p.b === a);
}

/**
 * The main checkout's snapshot from a pre-flight output.
 *
 * @param checks - `preflight`'s output.
 * @returns The checkout and its snapshot; `null` unless the checks passed
 *   and carry both.
 */
function mainSnapshot(checks: PreflightOutput | null): MainSnapshot | null {
  const snapshot = checks?.status === 'ok' ? checks.snapshot : undefined;
  if (typeof checks?.worktree !== 'string' || snapshot === undefined || snapshot === null) {
    return null;
  }
  return { worktree: checks.worktree, snapshot };
}

/**
 * Drop `issues` from a graph together with their transitive dependents,
 * every edge with a dropped endpoint, and every entry left empty — so the
 * result is a valid scheduler input whenever `graph` is.
 *
 * @param graph - The graph.
 * @param issues - The issues to drop; one not in the graph is ignored.
 * @returns The remaining graph and the dependents dropped along.
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
 * The pre-flight checks' refusals.
 *
 * @param checks - `preflight`'s output.
 * @returns One refusal per failed check; one `preflight-error` when the
 *   command itself failed, or refused `preflight-failed` naming no problem.
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
 * The gate's refusals.
 *
 * @param gate - The gate's output.
 * @returns None for an `ok` verdict carrying its `runSet` and `edges`; one
 *   refusal per failure of a refused verdict; otherwise one `gate-error` —
 *   no verdict, an `ok` without its graph, or a refusal naming no failure.
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
 * The live-runs refusal: the command failed, an `ok` came without its
 * `runs` list, or a run's PR state is unknown — "could not ask" is never
 * read as "no PR".
 *
 * @param live - `live-runs`' output.
 * @returns One `live-runs-failed` refusal, or none.
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
 * Run the scout over the gate's run set and the unspent live runs' files —
 * for an attached run, every such run but its target, judged against the
 * target's PR head.
 *
 * @param hooks - The workflow hooks.
 * @param graph - The gate's graph.
 * @param live - `live-runs`' output.
 * @param attach - An attached run's target branch; `null` for an unattached run.
 * @returns Resolves to the scout's verdict; `null` when it returned none.
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
 * Fold the scout's verdict in: overlaps and (outside exclude mode) stale
 * issues refuse; in exclude mode stale issues drop with their dependents.
 *
 * @param found - The refusals, drops and graph so far.
 * @param scout - The scout's verdict.
 * @param exclude - Whether exclude mode is on.
 * @returns The final outcome.
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

/**
 * Why a tool gave no usable verdict.
 *
 * @param out - The tool's output.
 * @param what - The tool, for the message.
 * @returns Its stderr tail, first error or refusal reason; a fallback line
 *   when it returned nothing.
 */
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
