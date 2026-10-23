/**
 * The `ship` workflow's pre-flight (Ship ADR-0001 decision 4): everything a run must hold before
 * it cuts anything. In order: `worktree.ts preflight` (master level, `gh` logged in, the warm set
 * — always checked, as server-tier tdd runs lease it), the run gate, `live-runs`, then, once each,
 * `issue-readiness` on the run set and `issue-overlap` on the rest and unspent live runs' files.
 *
 * **Every refusal is collected**: only an unnamed main checkout and an absent run set stop the
 * phase early. No verdict, a verdict missing its fields, or a run-set issue left unjudged is a
 * refusal, never a pass. **Exclude mode** drops a stale or not-ready issue with its dependents
 * ({@link dropWithDependents}); a live-run overlap, and any pair {@link settleOverlap} keeps across
 * two epics, still refuses. **An attached run**'s `no-open-pr`, `slices-live` and
 * `unpublished-commits` refuse like any check; `issue-readiness` and `issue-overlap` judge its PR
 * head. **A leftover slice branch** refuses unless its run is spent ({@link exemptSpentSlices}).
 *
 * Render-safe (ship/src/build/workflow-render.ts): ECMAScript built-ins only, no top-level effect.
 */

import { GENERATED_FILES } from '../core/generated-files.js';
import type { GateFailure } from '../core/gate/run-gate.js';
import {
  mergeOverlapEdges,
  overlapEntryIndex,
  type OverlapCrossPair,
  type OverlapMerge,
  type OverlapPair,
} from '../core/run-overlap.js';
import {
  runSetIssues,
  transitiveDependents,
  type RunEdge,
  type RunGraph,
} from '../core/run-set.js';
import { runSlug } from '../core/run-slug.js';
import type { PreflightCheck, PreflightResult } from '../cli/envelope/types-run.js';

import {
  AGENT_CALLS,
  type EstimatedPair,
  type IssueReadiness,
  type ReadinessVerdict,
} from './calls/agent-calls.js';
import type { ShipArgs } from './args.js';
import type { WorkflowHooks } from './runtime.types.js';
import { withCheckout, type IssueOverlapValues, type LiveRunFiles } from './calls/prompts.js';
import {
  runTool,
  type GateOutput,
  type LiveRunsOutput,
  type PreflightOutput,
} from './calls/tool-calls.js';

/**
 * What stopped a launch: `usage` (the arguments); a failed pre-flight check
 * or `preflight-error`; a gate failure kind or `gate-error`;
 * `live-runs-failed`; `stale`, `not-ready` or `readiness-unavailable` (`issue-readiness`);
 * `empty-run-set` (exclude mode dropped everything); `overlap` (a live run),
 * `overlap-cross-epic` or `overlap-estimate-failed` (`issue-overlap`);
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
  | 'not-ready'
  | 'overlap'
  | 'readiness-unavailable'
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
   * `gate`: the gate dropped it; `stale` or `not-ready`: `issue-readiness` found it so;
   * `dependent`: a dropped issue blocks it.
   */
  readonly cause: 'gate' | 'stale' | 'not-ready' | 'dependent';
  /** Why, from the gate or `issue-readiness`. */
  readonly message: string;
}

/** What pre-flight found. */
interface PreflightOutcome {
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
  /** The overlap edges merged into `graph`; `null` when `issue-overlap` failed or refused. */
  readonly overlap: OverlapRecord | null;
  /**
   * `live-runs`' answer as pre-flight read it, reused by the launch's
   * spent-run cleanup; `null` when the runner returned none.
   */
  readonly live: LiveRunsOutput | null;
  /**
   * The main checkout `preflight` named, every later call bound to it ({@link withCheckout});
   * `null`, with a refusal, when it named none and nothing else ran.
   */
  readonly checkout: string | null;
}

/** An overlap edge pre-flight added from a `likely` pair, with `issue-overlap`'s reason for it. */
export type OverlapEdge = RunEdge & {
  /** What backs it. */
  readonly reason: string;
};

/** An `unsure` pair within one entry that pre-flight left out of the run graph. */
export type UnsurePair = OverlapPair & Pick<EstimatedPair, 'shared' | 'reason'>;

/** What `issue-overlap`'s pairs added to the run graph. */
export interface OverlapRecord {
  /** The edges added, sorted by (`blocker`, `dependent`). */
  readonly added: readonly OverlapEdge[];
  /** The pairs the declared edges already order: nothing added. */
  readonly sequenced: readonly OverlapPair[];
  /**
   * The `unsure` pairs within one entry, in `issue-overlap`'s order: reported, never ordered (Ship
   * ADR-0001 decision 6).
   */
  readonly unsure: readonly UnsurePair[];
  /** Whether `issue-overlap` could read the area map. */
  readonly areaMap: 'read' | 'unavailable';
}

/** The main checkout at one moment, as `worktree.ts preflight` reports it. */
export interface MainSnapshot {
  /**
   * Its `HEAD`, whether it had uncommitted changes, and the launch shas of local and `origin`'s
   * `master`.
   */
  readonly snapshot: NonNullable<PreflightResult['snapshot']>;
}

/** A graph with issues dropped. */
interface DropResult {
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
  if (typeof checks?.worktree !== 'string') return unanchored(checks);
  const bound = withCheckout(hooks, checks.worktree);
  const gate = await runTool(bound, 'run-gate', [
    args.selection,
    ...args.numbers.map(String),
    ...(args.exclude ? ['--exclude'] : []),
  ]);
  const live = await runTool(bound, 'live-runs', ['.']);
  const kept = exemptSpentSlices(checks, live);
  const refusals = [...checkRefusals(kept), ...gateRefusals(gate), ...liveRunRefusals(live)];
  const at = { main: mainSnapshot(kept), overlap: null, live, checkout: checks.worktree };
  if (gate?.runSet === undefined) return { refusals, dropped: [], graph: null, ...at };
  const graph = { runSet: gate.runSet, edges: gate.edges ?? [] };
  const readiness = await AGENT_CALLS.issueReadiness(bound, {
    issues: runSetIssues(graph.runSet),
    ...(args.attach === null ? {} : { prHead: `origin/${args.attach}` }),
  });
  const found = { refusals, dropped: gateDrops(gate), graph, ...at };
  return settleOverlap(bound, settleReadiness(found, readiness, args.exclude), args.attach);
}

/** The outcome of a `preflight` that named no main checkout: its refusals, and nothing else ran. */
function unanchored(checks: PreflightOutput | null): PreflightOutcome {
  const found = checkRefusals(checks);
  const refusals: ShipRefusal[] =
    found.length > 0
      ? found
      : [{ kind: 'preflight-error', message: 'preflight named no main checkout' }];
  return {
    refusals,
    dropped: [],
    graph: null,
    main: null,
    overlap: null,
    live: null,
    checkout: null,
  };
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
 * What `issue-overlap` is asked: a run set of two or more issues, or of one with an unspent live
 * run (for an attached run, any but its target, judged against its PR head); `null` for neither.
 */
function overlapValues(found: PreflightOutcome, attach: string | null): IssueOverlapValues | null {
  const { graph } = found;
  if (graph === null) return null;
  const liveRuns: LiveRunFiles[] = (found.live?.runs ?? [])
    .filter((r) => !r.spent && r.branch !== attach)
    .map((r) => ({ branch: r.branch, landed: r.landed }));
  const count = runSetIssues(graph.runSet).length;
  if (count === 0 || (count < 2 && liveRuns.length === 0)) return null;
  return { ...graph, liveRuns, ...(attach === null ? {} : { prHead: `origin/${attach}` }) };
}

/**
 * Ask `issue-overlap` ({@link overlapValues}): each live overlap refuses; the pairs merge into the
 * graph, less generated-only ones (a harvest regenerates them) and the `unsure` ones within an
 * entry (recorded as `unsure`), a cross-entry pair refusing.
 */
async function settleOverlap(
  hooks: WorkflowHooks,
  found: PreflightOutcome,
  attach: string | null,
): Promise<PreflightOutcome> {
  const values = overlapValues(found, attach);
  if (values === null) {
    return { ...found, overlap: { added: [], sequenced: [], unsure: [], areaMap: 'read' } };
  }
  const estimate = await AGENT_CALLS.issueOverlap(hooks, values);
  if (estimate === null) {
    return withRefusals(found, [
      { kind: 'overlap-estimate-failed', message: 'issue-overlap returned nothing' },
    ]);
  }
  const live = estimate.liveOverlaps.map(
    (o): ShipRefusal => ({ kind: 'overlap', issue: o.issue, message: `${o.branch}: ${o.reason}` }),
  );
  const graph: RunGraph = { runSet: values.runSet, edges: values.edges };
  const estimated = estimate.pairs.filter((p) => !generatedOnly(p));
  const unsureWithin = unsureWithinEntry(graph, estimated);
  const pairs = estimated.filter((p) => !unsureWithin.includes(p));
  let merged: OverlapMerge;
  try {
    merged = mergeOverlapEdges(graph, pairs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return withRefusals(found, [...live, { kind: 'overlap-estimate-failed', message }]);
  }
  if (merged.kind === 'cross-entry') {
    return withRefusals(found, [...live, ...merged.pairs.map((p) => crossEpicRefusal(p, pairs))]);
  }
  if (live.length > 0) return withRefusals(found, live);
  const overlap: OverlapRecord = {
    added: merged.added.map((e) => ({ ...e, reason: pairReason(e.blocker, e.dependent, pairs) })),
    sequenced: merged.sequenced,
    unsure: unsureWithin.map(({ a, b, shared, reason }) => ({ a, b, shared, reason })),
    areaMap: estimate.areaMap,
  };
  return { ...found, graph: merged.graph, overlap };
}

/**
 * The `unsure` pairs joining two distinct issues of one entry that neither the declared edges
 * order nor a `likely` pair names: such a pair orders no slices (Ship ADR-0001 decision 6), while
 * one across entries still refuses the launch and the merge records the others.
 */
function unsureWithinEntry(graph: RunGraph, pairs: readonly EstimatedPair[]): EstimatedPair[] {
  const entryOf = overlapEntryIndex(graph);
  const ordered = (p: EstimatedPair): boolean =>
    transitiveDependents([p.a], graph.edges).includes(p.b) ||
    transitiveDependents([p.b], graph.edges).includes(p.a);
  return pairs.filter((p) => {
    const entry = entryOf.get(p.a);
    return (
      p.confidence === 'unsure' &&
      p.a !== p.b &&
      entry !== undefined &&
      entry === entryOf.get(p.b) &&
      !ordered(p) &&
      !pairs.some((q) => q.confidence === 'likely' && samePair(q, p.a, p.b))
    );
  });
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

/** `issue-overlap`'s reason for one unordered pair: its first matching pair's. */
function pairReason(a: number, b: number, pairs: readonly EstimatedPair[]): string {
  return pairs.find((p) => samePair(p, a, b))?.reason ?? '';
}

/** Whether an estimated pair is the unordered pair `{a, b}`, in either order. */
function samePair(p: OverlapPair, a: number, b: number): boolean {
  return (p.a === a && p.b === b) || (p.a === b && p.b === a);
}

/** The main checkout's snapshot from `preflight`'s output; `null` unless the checks passed. */
function mainSnapshot(checks: PreflightOutput | null): MainSnapshot | null {
  const snapshot = checks?.status === 'ok' ? checks.snapshot : undefined;
  return snapshot === undefined || snapshot === null ? null : { snapshot };
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

/** Each rubric point of a {@link ReadinessVerdict}, with the name a refusal gives it. */
const RUBRIC_POINTS = [
  ['sliceable', 'sliceable'],
  ['unblocked', 'unblocked'],
  ['rightSized', 'right-sized'],
  ['directionDecided', 'direction-decided'],
  ['specified', 'specified'],
] as const;

/** An issue's failures, in order: `stale` for the tree, `not-ready` naming each failed point. */
function readinessFailures(
  v: ReadinessVerdict,
): { readonly cause: 'stale' | 'not-ready'; readonly message: string }[] {
  const failed = RUBRIC_POINTS.filter(([key]) => !v[key].pass);
  return [
    ...(v.current.pass ? [] : [{ cause: 'stale' as const, message: v.current.evidence }]),
    ...(failed.length === 0
      ? []
      : [
          {
            cause: 'not-ready' as const,
            message: failed.map(([key, name]) => `${name}: ${v[key].evidence}`).join('; '),
          },
        ]),
  ];
}

/**
 * Fold `issue-readiness`'s verdict in: outside exclude mode each stale or not-ready failure
 * refuses; in exclude mode such an issue drops with its dependents.
 */
function settleReadiness(
  found: PreflightOutcome & { readonly graph: RunGraph },
  readiness: IssueReadiness | null,
  exclude: boolean,
): PreflightOutcome {
  const issues = runSetIssues(found.graph.runSet);
  const verdicts = (readiness?.issues ?? []).filter((v) => issues.includes(v.issue));
  const judged = new Set(verdicts.map((v) => v.issue));
  const unjudged = issues.filter((n) => !judged.has(n));
  const refusals = [...found.refusals];
  if (unjudged.length > 0) {
    refusals.push({
      kind: 'readiness-unavailable',
      message: `no issue-readiness verdict for ${unjudged.map((n) => `#${String(n)}`).join(', ')}`,
    });
  }
  const failing = verdicts
    .map((v) => ({ issue: v.issue, failures: readinessFailures(v) }))
    .filter((f) => f.failures.length > 0);
  if (!exclude) {
    for (const f of failing) {
      for (const x of f.failures)
        refusals.push({ kind: x.cause, issue: f.issue, message: x.message });
    }
    return { ...found, refusals };
  }
  const { graph, dependents } = dropWithDependents(
    found.graph,
    failing.map((f) => f.issue),
  );
  if (graph.runSet.length === 0) {
    refusals.push({ kind: 'empty-run-set', message: 'no issue is left after the readiness drops' });
  }
  const dropped: DroppedIssue[] = [
    ...found.dropped,
    ...failing.flatMap(({ issue, failures: [first] }): DroppedIssue[] =>
      first === undefined ? [] : [{ issue, ...first }],
    ),
    ...dependents.map(
      (n): DroppedIssue => ({
        issue: n,
        cause: 'dependent',
        message: 'blocked by a dropped issue',
      }),
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
