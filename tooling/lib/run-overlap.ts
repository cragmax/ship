/**
 * Overlap edges: the scheduler edges pre-flight adds between two issues of one entry likely to
 * touch the same files, so they land in turn instead of racing to a harvest conflict (#1036,
 * ADR-0045 decision 3). The estimator names the pairs, unordered; {@link mergeOverlapEdges} directs
 * each one and merges it into the run graph.
 *
 * **Direction rule.** The declared edges are ordered topologically (Kahn's algorithm; among ready
 * issues the earliest in run-set order goes first), and each pair runs earlier → later: one linear
 * extension, so the union stays acyclic. "The lower number blocks" does not: entry `[10, 15, 20]`
 * declaring `20 → 10`, with pairs `{10, 15}` and `{15, 20}`, gives `10 → 15 → 20 → 10`.
 *
 * **Render-ready — a contract.** One value import (`./run-set.js`); ECMAScript built-ins only; no
 * top-level side effect; every top-level name prefixed `overlap` / `Overlap`, since the `ship`
 * render closure shares one scope and the renderer refuses a repeated top-level name.
 */

import {
  findCycles,
  runSetIssues,
  transitiveDependents,
  type RunEdge,
  type RunGraph,
} from './run-set.js';

/** Two issues likely to touch the same files; unordered. */
export interface OverlapPair {
  /** One issue. */
  readonly a: number;
  /** The other. */
  readonly b: number;
}

/** A pair whose issues sit in different entries, with both entries' `epic` keys. */
export interface OverlapCrossPair extends OverlapPair {
  /** `a`'s entry's `epic` key; `null` for an explicit list. */
  readonly epicA: number | null;
  /** `b`'s entry's `epic` key; `null` for an explicit list. */
  readonly epicB: number | null;
}

/** The merge's outcome. */
export type OverlapMerge =
  | {
      /** Every pair sits inside one entry. */
      readonly kind: 'ok';
      /** The run graph with the added edges merged in, edges sorted by (`blocker`, `dependent`). */
      readonly graph: RunGraph;
      /** The edges the pairs added, sorted by (`blocker`, `dependent`). */
      readonly added: readonly RunEdge[];
      /** The pairs the declared edges already order, `a` smaller than `b`, sorted. */
      readonly sequenced: readonly OverlapPair[];
    }
  | {
      /** A pair crosses entries: the run may not start (epics in one run must be code-disjoint). */
      readonly kind: 'cross-entry';
      /** Every such pair, `a` smaller than `b`, sorted. */
      readonly pairs: readonly OverlapCrossPair[];
    };

/**
 * Merge overlap pairs into a run graph as directed edges (the file header's
 * direction rule). The merge takes no confidence: every pair it is given
 * counts. Repeated pairs, in either order, count once.
 *
 * @param graph - The run graph: the gate's, drops applied.
 * @param pairs - The estimator's pairs.
 * @returns `cross-entry` listing every pair across entries, when any is;
 *   otherwise `ok` with the merged graph, the added edges and the pairs the
 *   declared edges already sequence.
 * @throws Error `run overlap: …` when a pair names an issue outside the run
 *   set, when a pair names one issue twice, or when the declared edges hold a
 *   cycle — in that order, naming the offender.
 */
export function mergeOverlapEdges(graph: RunGraph, pairs: readonly OverlapPair[]): OverlapMerge {
  const issues = runSetIssues(graph.runSet);
  overlapAssertPairs(issues, pairs);
  const cycles = findCycles(issues, graph.edges);
  if (cycles.length > 0) {
    overlapFail(
      `the declared edges hold a cycle among ${cycles.map((c) => c.map(overlapRef).join(', ')).join('; ')}`,
    );
  }
  const unique = overlapDistinct(pairs);
  const entryOf = overlapEntryIndex(graph);
  const crossing = unique.filter((p) => entryOf.get(p.a) !== entryOf.get(p.b));
  if (crossing.length > 0) {
    return {
      kind: 'cross-entry',
      pairs: crossing.map((p) => ({
        ...p,
        epicA: graph.runSet[entryOf.get(p.a) ?? -1]?.epic ?? null,
        epicB: graph.runSet[entryOf.get(p.b) ?? -1]?.epic ?? null,
      })),
    };
  }
  return overlapDirect(graph, unique);
}

/** Direct each in-entry pair (distinct, `a` smaller than `b`) and merge it in: the `ok` outcome. */
function overlapDirect(graph: RunGraph, pairs: readonly OverlapPair[]): OverlapMerge {
  const rank = overlapTopoRank(graph);
  const added: RunEdge[] = [];
  const sequenced: OverlapPair[] = [];
  for (const p of pairs) {
    const ordered =
      transitiveDependents([p.a], graph.edges).includes(p.b) ||
      transitiveDependents([p.b], graph.edges).includes(p.a);
    if (ordered) {
      sequenced.push(p);
      continue;
    }
    const aFirst = (rank.get(p.a) ?? 0) < (rank.get(p.b) ?? 0);
    added.push(aFirst ? { blocker: p.a, dependent: p.b } : { blocker: p.b, dependent: p.a });
  }
  const edges = overlapSortEdges(overlapDistinctEdges([...graph.edges, ...added]));
  return {
    kind: 'ok',
    graph: { runSet: graph.runSet, edges },
    added: overlapSortEdges(added),
    sequenced,
  };
}

/**
 * Each issue's place in the direction rule's topological order.
 *
 * @param graph - The run graph; its declared edges are acyclic.
 * @returns Issue number to rank, 0 first.
 */
function overlapTopoRank(graph: RunGraph): ReadonlyMap<number, number> {
  const order = graph.runSet.flatMap((entry) => entry.issues);
  const indegree = new Map<number, number>(order.map((n) => [n, 0]));
  overlapShiftIndegree(indegree, graph.edges, 1);
  const rank = new Map<number, number>();
  const nextReady = (): number | undefined =>
    order.find((n) => !rank.has(n) && indegree.get(n) === 0);
  for (let next = nextReady(); next !== undefined; next = nextReady()) {
    rank.set(next, rank.size);
    const ranked = next;
    overlapShiftIndegree(
      indegree,
      graph.edges.filter((e) => e.blocker === ranked),
      -1,
    );
  }
  return rank;
}

/**
 * Shift the in-degree of each edge's dependent in `indegree` (mutated): `by` is `1` to count an
 * edge in, `-1` to release it.
 */
function overlapShiftIndegree(
  indegree: Map<number, number>,
  edges: readonly RunEdge[],
  by: number,
): void {
  for (const e of edges) indegree.set(e.dependent, (indegree.get(e.dependent) ?? 0) + by);
}

/** Reject a pair naming an issue outside the run set, then a pair naming one issue twice. */
function overlapAssertPairs(issues: readonly number[], pairs: readonly OverlapPair[]): void {
  for (const p of pairs) {
    const outside = [p.a, p.b].find((n) => !issues.includes(n));
    if (outside !== undefined) {
      overlapFail(
        `pair ${overlapPairLabel(p)} names ${overlapRef(outside)}, which is outside the run set`,
      );
    }
  }
  for (const p of pairs) {
    if (p.a === p.b) overlapFail(`pair ${overlapPairLabel(p)} pairs an issue with itself`);
  }
}

/** Each unordered pair once, `a` smaller than `b`, sorted. */
function overlapDistinct(pairs: readonly OverlapPair[]): OverlapPair[] {
  const seen = new Map<string, OverlapPair>();
  for (const p of pairs) {
    const pair = { a: Math.min(p.a, p.b), b: Math.max(p.a, p.b) };
    seen.set(`${String(pair.a)}-${String(pair.b)}`, pair);
  }
  return [...seen.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

/** Each issue's entry index. */
function overlapEntryIndex(graph: RunGraph): ReadonlyMap<number, number> {
  const entryOf = new Map<number, number>();
  graph.runSet.forEach((entry, i) => {
    for (const n of entry.issues) entryOf.set(n, i);
  });
  return entryOf;
}

/** Each edge once, first occurrences kept. */
function overlapDistinctEdges(edges: readonly RunEdge[]): RunEdge[] {
  const seen = new Map<string, RunEdge>();
  for (const e of edges) {
    const key = `${String(e.blocker)}>${String(e.dependent)}`;
    if (!seen.has(key)) seen.set(key, { blocker: e.blocker, dependent: e.dependent });
  }
  return [...seen.values()];
}

/** A copy of `edges` sorted by (`blocker`, `dependent`), as the `RunGraph` contract requires. */
function overlapSortEdges(edges: readonly RunEdge[]): RunEdge[] {
  return [...edges].sort((x, y) => x.blocker - y.blocker || x.dependent - y.dependent);
}

/** An issue as messages spell it: `#N`. */
function overlapRef(issue: number): string {
  return `#${String(issue)}`;
}

/** A pair as messages spell it: `{#a, #b}`. */
function overlapPairLabel(pair: OverlapPair): string {
  return `{${overlapRef(pair.a)}, ${overlapRef(pair.b)}}`;
}

/** Throw a `run overlap:`-prefixed error. */
function overlapFail(message: string): never {
  throw new Error(`run overlap: ${message}`);
}
