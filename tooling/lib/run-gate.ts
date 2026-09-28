/**
 * The run gate's pure decision core (#1031): resolve a launch spec into a
 * run set, decide whether the run may start, and derive its dependency edges.
 * No I/O — `tooling/lib/run-gate-gh.ts` gathers the inputs, and the rules
 * below are the oracle the unit tests pin.
 *
 * **What an `ok` verdict guarantees the scheduler.** Every edge has both ends
 * inside one run-set entry (no cross-epic edge), the edge graph is acyclic,
 * and — given a non-empty launch spec, which the CLI enforces and nothing here
 * re-checks — no entry is empty. The scheduler (`createScheduler` in
 * `run-scheduler.ts`) re-validates all three anyway: edges unioned in after
 * the gate (#1036's file-overlap edges) never pass through this module.
 *
 * **The epic container is never gated.** It is only asked for its sub-issues;
 * its state, labels and body never reach this module.
 */

import {
  findCycles,
  runSetIssues,
  transitiveDependents,
  type RunEdge,
  type RunGraph,
  type RunSet,
} from './run-set.js';

/** The label an issue must carry to be gated ready. */
export const READY_LABEL = 'ready-for-agent';

/** What the run was launched over: whole epics, or an explicit issue list. */
export type LaunchSpec =
  | { readonly kind: 'epics'; readonly epics: readonly number[] }
  | { readonly kind: 'issues'; readonly issues: readonly number[] };

/** `refuse`: any failure refuses. `exclude`: excludable failures drop their issue. */
export type GateMode = 'refuse' | 'exclude';

/** An issue's GitHub state. */
export type IssueState = 'OPEN' | 'CLOSED';

/** The gate-relevant facts about one run-set issue. */
export interface IssueFacts {
  /** The issue number. */
  readonly number: number;
  /** Its GitHub state. */
  readonly state: IssueState;
  /** Its label names. */
  readonly labels: readonly string[];
  /** Its blockers — body section ∪ native links, deduped, ascending. */
  readonly blockedBy: readonly number[];
}

/** One sub-issue of an epic container. */
export interface EpicChild {
  /** The sub-issue number. */
  readonly number: number;
  /** Its GitHub state. */
  readonly state: IssueState;
}

/** Why the gate refused (or, in exclude mode, dropped) something. */
export type GateFailure =
  | { readonly kind: 'closed'; readonly issue: number; readonly message: string }
  | { readonly kind: 'missing-label'; readonly issue: number; readonly message: string }
  | {
      readonly kind: 'open-blocker';
      readonly issue: number;
      readonly blocker: number;
      readonly message: string;
    }
  | {
      readonly kind: 'cross-epic-blocker';
      readonly issue: number;
      readonly blocker: number;
      readonly blockerEpic: number;
      readonly message: string;
    }
  | { readonly kind: 'cycle'; readonly issues: readonly number[]; readonly message: string }
  | { readonly kind: 'empty-epic'; readonly epic: number; readonly message: string }
  | { readonly kind: 'empty-run-set'; readonly message: string };

/** One issue exclude mode dropped from the run. */
export type Exclusion =
  | { readonly issue: number; readonly cause: 'failed' }
  | { readonly issue: number; readonly cause: 'dependent'; readonly blockers: readonly number[] };

/** The gate's answer for a launch. */
export interface GateVerdict extends RunGraph {
  /** Whether the run may start. */
  readonly verdict: 'ok' | 'refused';
  /** The mode the gate ran in. */
  readonly mode: GateMode;
  /** Every failure found. */
  readonly failures: readonly GateFailure[];
  /** What exclude mode dropped (always empty when refused). */
  readonly excluded: readonly Exclusion[];
}

/** The failure kinds a single-issue check can report. */
export type IssueCheckFailure = Extract<GateFailure, { kind: 'closed' | 'missing-label' }>;

/** The answer to `check N`. */
export interface IssueCheck {
  /** The checked issue. */
  readonly issue: number;
  /** Whether it may (still) run. */
  readonly ready: boolean;
  /** Why not, when not ready. */
  readonly failures: readonly IssueCheckFailure[];
}

/** Input to {@link evaluateRunGate}. */
export interface RunGateInput {
  /** The resolved run set. */
  readonly runSet: RunSet;
  /** Facts for every run-set issue. */
  readonly facts: readonly IssueFacts[];
  /** States of every out-of-set blocker. */
  readonly blockerStates: ReadonlyMap<number, IssueState>;
  /** The gate mode. */
  readonly mode: GateMode;
}

/**
 * R1: resolve a launch spec into its run set. An `issues` spec becomes one
 * `epic: null` entry, ascending. An `epics` spec becomes one entry per epic,
 * in spec order, holding its OPEN sub-issues ascending — a closed sub-issue is
 * done, so it is omitted rather than failed (and, being CLOSED, it satisfies
 * any dependent it blocks). An epic left with no open sub-issue resolves to an
 * empty entry, which {@link evaluateRunGate} refuses (R6).
 *
 * @param spec - The launch spec.
 * @param epicChildren - Each spec epic's sub-issues, open and closed.
 * @returns The run set.
 * @throws When `epicChildren` lacks a spec epic.
 */
export function resolveRunSet(
  spec: LaunchSpec,
  epicChildren: ReadonlyMap<number, readonly EpicChild[]>,
): RunSet {
  if (spec.kind === 'issues') {
    return [{ epic: null, issues: [...spec.issues].sort((a, b) => a - b) }];
  }
  return spec.epics.map((epic) => ({
    epic,
    issues: childrenOf(epicChildren, epic)
      .filter((c) => c.state === 'OPEN')
      .map((c) => c.number)
      .sort((a, b) => a - b),
  }));
}

/**
 * One spec epic's sub-issues.
 *
 * @param epicChildren - Each spec epic's sub-issues.
 * @param epic - The epic.
 * @returns Its sub-issues.
 * @throws When the caller supplied no sub-issue list for a spec epic.
 */
function childrenOf(
  epicChildren: ReadonlyMap<number, readonly EpicChild[]>,
  epic: number,
): readonly EpicChild[] {
  const children = epicChildren.get(epic);
  if (children === undefined) throw new Error(`run-gate: no sub-issues for epic ${ref(epic)}`);
  return children;
}

/**
 * R11: whether one issue is ready — OPEN and labelled exactly
 * {@link READY_LABEL}. Blockers are deliberately never checked: mid-run, an
 * in-set blocker stays OPEN until the run's PR merges its `fixes #N`, so a
 * blocker check would mark every dependent not-ready.
 *
 * @param facts - The issue's facts.
 * @returns The check; `failures` holds only `closed` / `missing-label`.
 */
export function checkIssue(facts: IssueFacts): IssueCheck {
  const failures = ownFailures(facts);
  return { issue: facts.number, ready: failures.length === 0, failures };
}

/**
 * The blockers outside the run set — the issues whose state
 * {@link evaluateRunGate} needs in `blockerStates`.
 *
 * @param runSet - The resolved run set.
 * @param facts - Facts for every run-set issue.
 * @returns The out-of-set blocker numbers, deduped, ascending.
 */
export function outOfSetBlockers(runSet: RunSet, facts: readonly IssueFacts[]): number[] {
  const inSet = new Set(runSetIssues(runSet));
  const out = new Set<number>();
  for (const f of facts) {
    for (const b of f.blockedBy) if (!inSet.has(b)) out.add(b);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Evaluate the run gate over a resolved run set.
 *
 * Per issue: CLOSED fails `closed` (R2); lacking the exact
 * {@link READY_LABEL} fails `missing-label` (R3). Per blocker (R4): one in the
 * run set yields an edge — or, when it sits in a different epic entry, fails
 * `cross-epic-blocker` (an epic's branch never carries another epic's
 * commit); one outside and CLOSED is satisfied; one outside and OPEN fails
 * `open-blocker`. Run-wide: every cycle among the in-set edges fails `cycle`
 * (R5) and every empty epic entry fails `empty-epic` (R6).
 *
 * `refuse` mode refuses on any failure. `exclude` mode (R8) refuses only on a
 * `cycle` or `empty-epic`; otherwise it drops each failed issue, then the
 * transitive dependents of the failed OPEN ones — walked over the in-set
 * edges minus every edge whose blocker is CLOSED, since a closed blocker
 * satisfies its dependent — then removes emptied entries, and refuses with
 * `empty-run-set` if nothing remains.
 *
 * Every refused verdict has one shape, whatever the mode (R7): `failures`
 * lists every failure found, `excluded` is `[]`, and `runSet`/`edges` are the
 * resolved pre-exclusion set, for information only. An `ok` verdict in
 * exclude mode carries the post-exclusion set, the drop reasons as
 * `failures`, and the drop list as `excluded`.
 *
 * Output is deterministic (R9, R10): `edges` are the same-entry in-set edges,
 * deduped, sorted by (`blocker`, `dependent`); `runSet` keeps spec order;
 * `excluded` is ascending by issue, each dependent listing its dropped OPEN
 * direct blockers ascending; `failures` are ordered by subject (issue, else epic),
 * then kind in {@link GateFailure} declaration order, then blocker, with
 * `cycle` and `empty-run-set` last.
 *
 * @param input - The resolved run set, facts, blocker states and mode.
 * @returns The verdict.
 * @throws When `facts` lacks a run-set issue or `blockerStates` lacks an
 *   out-of-set blocker — a caller bug, never a verdict.
 */
export function evaluateRunGate(input: RunGateInput): GateVerdict {
  const analysis = analyse(input);
  const resolvedEdges = sameEntryEdges(analysis.inSetEdges, analysis.entries);
  const verdict = (
    kind: GateVerdict['verdict'],
    graph: RunGraph,
    failures: readonly GateFailure[],
    excluded: readonly Exclusion[],
  ): GateVerdict => ({ verdict: kind, mode: input.mode, ...graph, failures, excluded });
  const refused = (failures: readonly GateFailure[]): GateVerdict =>
    verdict('refused', { runSet: input.runSet, edges: resolvedEdges }, failures, []);

  if (analysis.failures.length === 0) {
    return verdict('ok', { runSet: input.runSet, edges: resolvedEdges }, [], []);
  }
  if (input.mode === 'refuse' || analysis.failures.some((f) => !isExcludable(f))) {
    return refused(analysis.failures);
  }
  const excluded = exclusions(analysis);
  const kept = keptRunSet(input.runSet, excluded);
  if (kept.length === 0) return refused([...analysis.failures, emptyRunSetFailure()]);
  const keptIssues = new Set(runSetIssues(kept));
  const keptEdges = resolvedEdges.filter(
    (e) => keptIssues.has(e.blocker) && keptIssues.has(e.dependent),
  );
  return verdict('ok', { runSet: kept, edges: keptEdges }, analysis.failures, excluded);
}

/**
 * Whether exclude mode may drop the failure's issue rather than refuse.
 *
 * @param f - The failure.
 * @returns `true` for the per-issue kinds; `false` for `cycle`, `empty-epic`
 *   and `empty-run-set`.
 */
function isExcludable(f: GateFailure): f is Extract<GateFailure, { issue: number }> {
  return 'issue' in f;
}

/**
 * R8's drop list (rule stated on {@link evaluateRunGate}).
 *
 * @param analysis - The analysis; every failure in it is excludable.
 * @returns The exclusions, ascending by issue.
 */
function exclusions(analysis: Analysis): Exclusion[] {
  const failed = new Set(analysis.failures.filter(isExcludable).map((f) => f.issue));
  const isOpen = (n: number): boolean => analysis.facts.get(n)?.state === 'OPEN';
  const walkEdges = analysis.inSetEdges.filter((e) => isOpen(e.blocker));
  const dependents = transitiveDependents([...failed].filter(isOpen), walkEdges).filter(
    (n) => !failed.has(n),
  );
  const dropped = new Set([...failed, ...dependents]);
  const droppedBlockersOf = (issue: number): number[] =>
    walkEdges.filter((e) => e.dependent === issue && dropped.has(e.blocker)).map((e) => e.blocker);
  return [
    ...[...failed].map((issue): Exclusion => ({ issue, cause: 'failed' })),
    ...dependents.map(
      (issue): Exclusion => ({ issue, cause: 'dependent', blockers: droppedBlockersOf(issue) }),
    ),
  ].sort((a, b) => a.issue - b.issue);
}

/**
 * The run set minus the dropped issues, emptied entries removed.
 *
 * @param runSet - The resolved run set.
 * @param excluded - The drop list.
 * @returns The post-exclusion run set, entry order kept.
 */
function keptRunSet(runSet: RunSet, excluded: readonly Exclusion[]): RunSet {
  const dropped = new Set(excluded.map((x) => x.issue));
  return runSet
    .map((entry) => ({ epic: entry.epic, issues: entry.issues.filter((n) => !dropped.has(n)) }))
    .filter((entry) => entry.issues.length > 0);
}

/** Everything {@link evaluateRunGate} derives from the resolved run set. */
interface Analysis {
  /** Where each run-set issue sits. */
  readonly entries: EntryIndex;
  /** Facts per run-set issue. */
  readonly facts: ReadonlyMap<number, IssueFacts>;
  /** Every failure found, in R10 order. */
  readonly failures: readonly GateFailure[];
  /** Every blocker → dependent edge with both ends in the set, cross-epic included. */
  readonly inSetEdges: readonly RunEdge[];
}

/**
 * Assess every run-set issue and the run as a whole (R2–R6).
 *
 * @param input - The gate input.
 * @returns The analysis.
 */
function analyse(input: RunGateInput): Analysis {
  const entries = indexEntries(input.runSet);
  const facts = indexFacts(input.facts);
  const subjectFailures: GateFailure[] = emptyEpicFailures(input.runSet);
  const inSetEdges: RunEdge[] = [];
  const issues = runSetIssues(input.runSet);
  for (const issue of issues) {
    const assessed = assessIssue(factsFor(facts, issue), entries, input.blockerStates);
    subjectFailures.push(...assessed.failures);
    inSetEdges.push(...assessed.edges);
  }
  const cycles = findCycles(issues, inSetEdges).map(cycleFailure);
  subjectFailures.sort(compareFailures);
  return {
    entries,
    facts,
    failures: [...subjectFailures, ...cycles],
    inSetEdges: sortEdges(inSetEdges),
  };
}

/** Where a run-set issue sits. */
interface EntrySlot {
  /** Its entry's position in the run set. */
  readonly position: number;
  /** That entry's epic. */
  readonly epic: number | null;
}

/** Every run-set issue's {@link EntrySlot}. */
type EntryIndex = ReadonlyMap<number, EntrySlot>;

/**
 * Map every run-set issue to its entry.
 *
 * @param runSet - The run set.
 * @returns Issue → entry slot.
 */
function indexEntries(runSet: RunSet): EntryIndex {
  const entries = new Map<number, EntrySlot>();
  runSet.forEach((entry, position) => {
    for (const issue of entry.issues) entries.set(issue, { position, epic: entry.epic });
  });
  return entries;
}

/**
 * R6: one `empty-epic` failure per epic entry with no issues.
 *
 * @param runSet - The resolved run set.
 * @returns The failures, in entry order.
 */
function emptyEpicFailures(runSet: RunSet): GateFailure[] {
  return runSet.flatMap((entry) =>
    entry.epic !== null && entry.issues.length === 0 ? [emptyEpicFailure(entry.epic)] : [],
  );
}

/**
 * R9: keep the edges whose ends share an entry.
 *
 * @param edges - In-set edges.
 * @param entries - Where each run-set issue sits.
 * @returns The same-entry edges, order preserved.
 */
function sameEntryEdges(edges: readonly RunEdge[], entries: EntryIndex): RunEdge[] {
  return edges.filter(
    (e) => entries.get(e.blocker)?.position === entries.get(e.dependent)?.position,
  );
}

/**
 * Key the facts by issue number.
 *
 * @param facts - The facts list.
 * @returns Issue → facts.
 */
function indexFacts(facts: readonly IssueFacts[]): ReadonlyMap<number, IssueFacts> {
  return new Map(facts.map((f) => [f.number, f]));
}

/**
 * The facts for one run-set issue.
 *
 * @param facts - Issue → facts.
 * @param issue - The run-set issue.
 * @returns Its facts.
 * @throws When the caller supplied no facts for a run-set issue.
 */
function factsFor(facts: ReadonlyMap<number, IssueFacts>, issue: number): IssueFacts {
  const found = facts.get(issue);
  if (found === undefined) throw new Error(`run-gate: no facts for run-set issue ${ref(issue)}`);
  return found;
}

/**
 * One issue's own failures (R2–R4) and its incoming in-set edges.
 *
 * @param facts - The issue's facts.
 * @param entries - Where each run-set issue sits.
 * @param blockerStates - States of the out-of-set blockers.
 * @returns The failures, in kind order then blocker ascending, and the edges.
 */
function assessIssue(
  facts: IssueFacts,
  entries: EntryIndex,
  blockerStates: ReadonlyMap<number, IssueState>,
): { failures: GateFailure[]; edges: RunEdge[] } {
  const issue = facts.number;
  const own = entries.get(issue);
  const failures: GateFailure[] = ownFailures(facts);
  const edges: RunEdge[] = [];
  const blockers = [...new Set(facts.blockedBy)];
  blockers.sort((a, b) => a - b);
  for (const blocker of blockers) {
    const home = entries.get(blocker);
    if (home !== undefined) edges.push({ blocker, dependent: issue });
    const failure = blockerFailure(issue, blocker, { home, own }, blockerStates);
    if (failure !== undefined) failures.push(failure);
  }
  return { failures, edges };
}

/**
 * R2 + R3: the failures an issue earns on its own, blockers aside.
 *
 * @param facts - The issue's facts.
 * @returns `closed` and/or `missing-label`, in that order.
 */
function ownFailures(facts: IssueFacts): IssueCheckFailure[] {
  const failures: IssueCheckFailure[] = [];
  if (facts.state === 'CLOSED') failures.push(closedFailure(facts.number));
  if (!facts.labels.includes(READY_LABEL)) failures.push(missingLabelFailure(facts.number));
  return failures;
}

/** Where a blocker and its dependent sit (`home` undefined = outside the run set). */
interface BlockerPlacement {
  readonly home: EntrySlot | undefined;
  readonly own: EntrySlot | undefined;
}

/**
 * R4: the failure one blocker causes, if any.
 *
 * @param issue - The dependent.
 * @param blocker - The blocker.
 * @param placement - Where the blocker and the dependent sit.
 * @param blockerStates - States of the out-of-set blockers.
 * @returns `open-blocker` for an OPEN out-of-set blocker, `cross-epic-blocker`
 *   for an in-set blocker in another epic entry, else `undefined`.
 */
function blockerFailure(
  issue: number,
  blocker: number,
  placement: BlockerPlacement,
  blockerStates: ReadonlyMap<number, IssueState>,
): GateFailure | undefined {
  const { home, own } = placement;
  if (home === undefined) {
    const open = blockerState(blockerStates, blocker) === 'OPEN';
    return open ? openBlockerFailure(issue, blocker) : undefined;
  }
  const crossEpic = home.epic !== null && home.position !== own?.position;
  return crossEpic ? crossEpicFailure(issue, blocker, home.epic) : undefined;
}

/** R10's kind rank: the {@link GateFailure} declaration order. */
const KIND_RANK: Readonly<Record<GateFailure['kind'], number>> = {
  closed: 0,
  'missing-label': 1,
  'open-blocker': 2,
  'cross-epic-blocker': 3,
  cycle: 4,
  'empty-epic': 5,
  'empty-run-set': 6,
};

/**
 * R10's comparator for subject failures (order stated on {@link evaluateRunGate}).
 *
 * @param a - One failure.
 * @param b - The other.
 * @returns A sort comparator result.
 */
function compareFailures(a: GateFailure, b: GateFailure): number {
  return (
    subjectOf(a) - subjectOf(b) ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    blockerOf(a) - blockerOf(b)
  );
}

/**
 * A failure's subject number.
 *
 * @param f - The failure.
 * @returns Its issue, else its epic, else 0 (run-level kinds never reach the sort).
 */
function subjectOf(f: GateFailure): number {
  if ('issue' in f) return f.issue;
  if ('epic' in f) return f.epic;
  return 0;
}

/**
 * A failure's blocker number.
 *
 * @param f - The failure.
 * @returns Its blocker, or 0 for a blocker-less kind.
 */
function blockerOf(f: GateFailure): number {
  return 'blocker' in f ? f.blocker : 0;
}

/**
 * An out-of-set blocker's state.
 *
 * @param blockerStates - States of the out-of-set blockers.
 * @param blocker - The blocker.
 * @returns Its state.
 * @throws When the caller supplied no state for an out-of-set blocker.
 */
function blockerState(blockerStates: ReadonlyMap<number, IssueState>, blocker: number): IssueState {
  const state = blockerStates.get(blocker);
  if (state === undefined) throw new Error(`run-gate: no state for blocker ${ref(blocker)}`);
  return state;
}

/**
 * Dedupe edges and sort them by (`blocker`, `dependent`).
 *
 * @param edges - The edges.
 * @returns A new, sorted, duplicate-free list.
 */
function sortEdges(edges: readonly RunEdge[]): RunEdge[] {
  const unique = new Map(edges.map((e) => [`${String(e.blocker)}>${String(e.dependent)}`, e]));
  return [...unique.values()].sort((a, b) => a.blocker - b.blocker || a.dependent - b.dependent);
}

/**
 * Render an issue reference.
 *
 * @param n - The issue number.
 * @returns `#n`.
 */
function ref(n: number): string {
  return `#${String(n)}`;
}

function closedFailure(issue: number): IssueCheckFailure {
  return { kind: 'closed', issue, message: `${ref(issue)} is closed` };
}

function missingLabelFailure(issue: number): IssueCheckFailure {
  return {
    kind: 'missing-label',
    issue,
    message: `${ref(issue)} lacks the ${READY_LABEL} label`,
  };
}

function openBlockerFailure(issue: number, blocker: number): GateFailure {
  return {
    kind: 'open-blocker',
    issue,
    blocker,
    message: `${ref(issue)} is blocked by ${ref(blocker)}, which is open and outside the run set`,
  };
}

function crossEpicFailure(issue: number, blocker: number, blockerEpic: number): GateFailure {
  return {
    kind: 'cross-epic-blocker',
    issue,
    blocker,
    blockerEpic,
    message: `${ref(issue)} is blocked by ${ref(blocker)}, which belongs to a different epic (${ref(blockerEpic)}) in this run`,
  };
}

function cycleFailure(issues: readonly number[]): GateFailure {
  return {
    kind: 'cycle',
    issues,
    message: `blocked-by cycle among ${issues.map(ref).join(', ')}`,
  };
}

function emptyEpicFailure(epic: number): GateFailure {
  return { kind: 'empty-epic', epic, message: `epic ${ref(epic)} has no open sub-issues` };
}

function emptyRunSetFailure(): GateFailure {
  return {
    kind: 'empty-run-set',
    message: 'exclude mode dropped every issue; nothing left to run',
  };
}
