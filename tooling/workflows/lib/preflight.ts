/**
 * The `ship` workflow's pre-flight phase (ADR-0045): everything a run must
 * hold before it cuts anything. It runs, in order, `worktree.ts preflight`
 * (master level with `origin/master`, `gh` logged in, the warm set
 * answering — the warm set is always checked, since every epic end runs
 * the server tier), the run gate, `worktree.ts live-runs`, then the scout
 * once, over the gate's run set and the changed files of every unspent live
 * run (a spent run's PR is merged or closed, so it can no longer collide).
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
 * overlap with a live run always refuses.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { GateFailure } from '../../lib/run-gate.js';
import { runSetIssues, transitiveDependents, type RunGraph } from '../../lib/run-set.js';
import type { PreflightCheck, PreflightResult } from '../../worktree/types-run.js';

import type { ShipArgs } from './args.js';
import type { JsonSchema, WorkflowHooks } from './hooks.types.js';
import { PROMPTS, type LiveRunFiles } from './prompts.js';
import { agentOptions } from './stages.js';
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
 * scout); `empty-run-set` (exclude mode dropped everything).
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
  | 'scout-unavailable';

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
   * end's "main untouched" check; `null` unless the checks passed.
   */
  readonly main: MainSnapshot | null;
}

/** The main checkout at one moment, as `worktree.ts preflight` reports it. */
export interface MainSnapshot {
  /** The main checkout, absolute. */
  readonly worktree: string;
  /** Its `HEAD` and whether it had uncommitted changes. */
  readonly snapshot: NonNullable<PreflightResult['snapshot']>;
}

/** A graph with issues dropped. */
export interface DropResult {
  /** The remaining graph. */
  readonly graph: RunGraph;
  /** The dropped issues' transitive dependents that were dropped with them, ascending. */
  readonly dependents: readonly number[];
}

/** The scout's verdict on one run-set issue. */
interface ScoutIssue {
  readonly issue: number;
  readonly stale: boolean;
  readonly evidence: string;
}

/** A run-set issue whose change would touch a live run's files. */
interface ScoutOverlap {
  readonly issue: number;
  readonly branch: string;
  readonly files: readonly string[];
  readonly evidence: string;
}

/** The scout's answer. */
interface ScoutVerdict {
  readonly issues: readonly ScoutIssue[];
  readonly overlaps: readonly ScoutOverlap[];
}

/** The scout's output schema. */
const SCOUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'integer' },
          stale: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['issue', 'stale', 'evidence'],
      },
    },
    overlaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'integer' },
          branch: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
        },
        required: ['issue', 'branch', 'files', 'evidence'],
      },
    },
  },
  required: ['issues', 'overlaps'],
};

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
  const checks = await runTool(hooks, 'preflight', ['.']);
  const gate = await runTool(hooks, 'run-gate', [
    args.selection,
    ...args.numbers.map(String),
    ...(args.exclude ? ['--exclude'] : []),
  ]);
  const live = await runTool(hooks, 'live-runs', ['.']);
  const refusals = [...checkRefusals(checks), ...gateRefusals(gate), ...liveRunRefusals(live)];
  const main = mainSnapshot(checks);
  if (gate?.runSet === undefined) return { refusals, dropped: [], graph: null, main };
  const graph = { runSet: gate.runSet, edges: gate.edges ?? [] };
  const scout = await runScout(hooks, graph, live);
  return settleScout({ refusals, dropped: gateDrops(gate), graph, main }, scout, args.exclude);
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
 * Run the scout over the gate's run set and the unspent live runs' files.
 *
 * @param hooks - The workflow hooks.
 * @param graph - The gate's graph.
 * @param live - `live-runs`' output.
 * @returns Resolves to the scout's verdict; `null` when it returned none.
 */
async function runScout(
  hooks: WorkflowHooks,
  graph: RunGraph,
  live: LiveRunsOutput | null,
): Promise<ScoutVerdict | null> {
  const liveRuns: LiveRunFiles[] = (live?.runs ?? [])
    .filter((r) => !r.spent)
    .map((r) => ({ branch: r.branch, landed: r.landed }));
  const prompt = PROMPTS.scout({ issues: runSetIssues(graph.runSet), liveRuns });
  const out = await hooks.agent(prompt, agentOptions('scout', null, SCOUT_SCHEMA));
  return typeof out === 'object' && out !== null ? (out as ScoutVerdict) : null;
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
    return { refusals, dropped: found.dropped, graph: found.graph, main: found.main };
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
  return { refusals, dropped, graph, main: found.main };
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
