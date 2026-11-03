/**
 * The run-set vocabulary: the single declaration of an unattended run's issue set and its
 * dependency edges. The run gate (`src/core/gate/run-gate.ts`)
 * produces a {@link RunGraph}, and the run scheduler consumes it. Neither re-declares these shapes.
 *
 * **Edge semantics.** A {@link RunEdge} `{ blocker, dependent }` means `dependent` waits for
 * `blocker`'s commit, so a walk along edges reaches everything a blocker holds up.
 *
 * **Zero imports, pure: a contract, not a style.** This module is rendered into the workflow
 * script with the scheduler, and that script permits no module system and no ambient runtime. So
 * it carries no `import` of any kind and no `export … from` re-export, and uses no `eval` /
 * `new Function`, no clock or randomness, no Node globals and no I/O (the renderer's
 * `FORBIDDEN_TOKENS` lists the names). It uses erasable syntax only. Never pull a helper in from
 * elsewhere: sort numbers inline with `(a, b) => a - b`. A text guard test enforces it.
 */

/** One entry of a run set: one epic's issues, or an explicit issue list (`epic: null`). */
export interface RunSetEntry {
  /** The epic whose open sub-issues these are, or `null` for an explicit list. */
  readonly epic: number | null;
  /** The entry's issue numbers, ascending. */
  readonly issues: readonly number[];
}

/** An unattended run's issues, grouped by entry (spec order). */
export type RunSet = readonly RunSetEntry[];

/** `dependent` waits for `blocker`'s commit. Also the shape of overlap edges. */
export interface RunEdge {
  /** The issue whose commit must land first. */
  readonly blocker: number;
  /** The issue that waits for it. */
  readonly dependent: number;
}

/** The scheduler's input graph (the gate's `ok` verdict carries one). */
export interface RunGraph {
  /** The run's issues, grouped by entry. */
  readonly runSet: RunSet;
  /** The dependency edges among them, sorted by (`blocker`, `dependent`). */
  readonly edges: readonly RunEdge[];
}

/** Every issue of a run set, flattened across entries: each issue number once, ascending. */
export function runSetIssues(runSet: RunSet): number[] {
  const all = new Set<number>();

  for (const entry of runSet) {
    for (const issue of entry.issues) all.add(issue);
  }

  return [...all].sort((a, b) => a - b);
}

/**
 * The blocked-by cycles among `issues`: each strongly connected component of
 * more than one issue, plus each self-loop as a singleton.
 *
 * An edge with an endpoint outside `issues` is ignored. `[]` means the graph
 * is acyclic: the scheduler's construction-time check.
 *
 * @returns The cycles, each ascending, ordered by first member.
 */
export function findCycles(issues: readonly number[], edges: readonly RunEdge[]): number[][] {
  const adj = adjacency(issues, edges);
  const cycles = stronglyConnected(adj).filter(
    (c) => c.length > 1 || c.some((n) => adj.get(n)?.includes(n) === true),
  );

  for (const cycle of cycles) cycle.sort((a, b) => a - b);
  cycles.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));

  return cycles;
}

/**
 * Every issue reachable from `roots` along blocker → dependent edges: what
 * dropping the roots would hold up.
 *
 * @returns The reached issues, roots excluded, each once, ascending.
 */
export function transitiveDependents(
  roots: readonly number[],
  edges: readonly RunEdge[],
): number[] {
  const next = new Map<number, number[]>();

  for (const e of edges) {
    const out = next.get(e.blocker) ?? [];
    out.push(e.dependent);
    next.set(e.blocker, out);
  }

  const seen = new Set<number>(roots);
  const reached: number[] = [];

  const walk = (v: number): void => {
    for (const w of next.get(v) ?? []) {
      if (seen.has(w)) continue;
      seen.add(w);
      reached.push(w);
      walk(w);
    }
  };

  for (const r of roots) walk(r);

  return reached.sort((a, b) => a - b);
}

/** Each of `issues` mapped to its dependents, dropping any edge with an endpoint outside. */
function adjacency(
  issues: readonly number[],
  edges: readonly RunEdge[],
): ReadonlyMap<number, readonly number[]> {
  const adj = new Map<number, number[]>();
  for (const n of issues) adj.set(n, []);

  for (const e of edges) {
    if (adj.has(e.dependent)) adj.get(e.blocker)?.push(e.dependent);
  }

  return adj;
}

/** Tarjan bookkeeping for one visited node. */
interface TarjanNode {
  readonly index: number;
  low: number;
}

/**
 * Tarjan's strongly connected components over an adjacency map.
 *
 * @param adj - The adjacency map, whose keys are the nodes.
 * @returns Every component (singletons included), members unordered.
 */
function stronglyConnected(adj: ReadonlyMap<number, readonly number[]>): number[][] {
  const visited = new Map<number, TarjanNode>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const components: number[][] = [];

  const popComponent = (root: number): number[] => {
    const component: number[] = [];

    for (let w = stack.pop(); w !== undefined; w = w === root ? undefined : stack.pop()) {
      onStack.delete(w);
      component.push(w);
    }

    return component;
  };

  const visit = (v: number): TarjanNode => {
    const node: TarjanNode = { index: visited.size, low: visited.size };
    visited.set(v, node);
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      const seen = visited.get(w);
      if (seen === undefined) node.low = Math.min(node.low, visit(w).low);
      else if (onStack.has(w)) node.low = Math.min(node.low, seen.index);
    }

    if (node.low === node.index) components.push(popComponent(v));

    return node;
  };

  for (const v of adj.keys()) if (!visited.has(v)) visit(v);

  return components;
}
