/**
 * A pure `(state, event) → (state, actions)` machine deciding which issue of an unattended run
 * starts, waits, restarts or is skipped, and when each entry ends, from the gate's run graph plus
 * `maxSlices` (#1032). Transitions: {@link IssuePhase}; the slot rule, ready and action order and
 * consumer obligations: their docs in `run-scheduler.types.ts`. One retry per issue for life,
 * requeues included, no requeue cap; a skip only for a still-waiting dependent, so never twice; a
 * halt never touches another entry.
 *
 * **Fail loud, pure.** Every throw an `Error` prefixed `run scheduler:` naming the offender; no
 * I/O, clock or randomness; input never mutated; issue-keyed records never iterated (input order
 * decides). **Render-ready, a contract** (the `ship`
 * workflow loads no module, #1026): one value import (`./run-set.js`), the rest type-only;
 * built-ins only (the renderer's `FORBIDDEN_TOKENS`); no top-level side effect or name `run-set.ts`
 * declares (the renderer refuses a repeat); erasable syntax only. A text guard test enforces it.
 */

import {
  findCycles,
  runSetIssues,
  transitiveDependents,
  type RunEdge,
  type RunSet,
} from './run-set.js';
import type {
  IssueEvent,
  IssuePhase,
  SchedulerAction,
  SchedulerEvent,
  SchedulerInput,
  SchedulerState,
  SkipCause,
  Transition,
} from './run-scheduler.types.js';

/** The phases each issue-keyed event kind is valid in. */
const ACCEPTED_PHASES: Readonly<Record<IssueEvent['kind'], readonly IssuePhase[]>> = {
  committed: ['authoring', 'landing'],
  blocked: ['authoring', 'landing'],
  'harvest-conflict': ['authoring', 'landing'],
  'agent-died': ['authoring', 'landing'],
  'slot-free': ['authoring'],
  'label-removed': ['waiting', 'ready', 'authoring', 'landing'],
};

/** The terminal phases. */
const SETTLED_PHASES: readonly IssuePhase[] = [
  'committed',
  'blocked',
  'removed',
  'skipped',
  'halted',
];

/**
 * Validate the run graph and build the initial state and actions.
 *
 * @remarks The guards run in the order the `@throws` below list; the first
 * failure throws. Duplicate edges are tolerated and deduplicated.
 *
 * @returns The initial state and the initial `start`s.
 * @throws Error when `maxSlices` is not an integer of 1 or more.
 * @throws Error when an entry has no issues.
 * @throws Error when an issue is listed twice, in one entry or across entries.
 * @throws Error when two entries share an `epic` key (two `null`s included).
 * @throws Error when an edge endpoint is outside the run set.
 * @throws Error when an edge crosses entries.
 * @throws Error when the edges form a cycle (a self-loop included), naming each member.
 */
export function createScheduler(input: SchedulerInput): Transition {
  assertInput(input);
  const state = initialState(input);
  return finish(state, openDraft(state));
}

/**
 * Apply one event.
 *
 * @param state - The current state; never mutated.
 * @param event - What the workflow observed.
 * @returns The next state and the actions to execute, in order.
 * @throws Error when `event.kind` is not an event kind (an untyped caller's typo).
 * @throws Error when `event.issue` is not in the run.
 * @throws Error when the issue's phase does not accept `event.kind` (a settled issue accepts none).
 * @throws Error on `committed` for an issue of a halted entry.
 * @throws Error on `epic-halt` for an `epic` key no entry has, or for an
 *   entry already halted or done.
 */
export function advance(state: SchedulerState, event: SchedulerEvent): Transition {
  const draft = openDraft(state);
  if (event.kind === 'epic-halt') onEpicHalt(draft, state, event.epic);
  else onIssueEvent(draft, state, event);
  return finish(state, draft);
}

/** Apply one issue-keyed event to the draft. */
function onIssueEvent(draft: Draft, state: SchedulerState, event: IssueEvent): void {
  assertPhase(state, event);
  const issue = event.issue;
  if (
    state.halted[entryIndexOf(state, issue)] === true &&
    settleInHaltedEntry(draft, state, event)
  ) {
    return;
  }
  switch (event.kind) {
    case 'committed':
      onCommitted(draft, state, issue);
      break;
    case 'blocked':
      settleAndSkip(draft, state, issue, 'blocked');
      break;
    case 'harvest-conflict':
      restart(draft, { kind: 'requeue', issue });
      break;
    case 'agent-died':
      onAgentDied(draft, state, issue);
      break;
    case 'label-removed':
      onLabelRemoved(draft, state, issue);
      break;
    case 'slot-free':
      draft.phase[issue] = 'landing';
      break;
  }
}

/**
 * Settle an in-flight issue of a halted entry when the halt changes the event (the halt rules on
 * {@link IssuePhase}): `true` when handled here, `false` for `slot-free` and `label-removed`.
 */
function settleInHaltedEntry(draft: Draft, state: SchedulerState, event: IssueEvent): boolean {
  if (event.kind === 'committed') {
    const { epic } = state.runSet[entryIndexOf(state, event.issue)] ?? { epic: null };
    fail(`committed for ${hash(event.issue)}, whose ${entryLabel(epic)} is halted`);
  }
  if (event.kind === 'slot-free' || event.kind === 'label-removed') return false;
  draft.phase[event.issue] = 'halted';
  return true;
}

/**
 * Halt the entry keyed `epic`: settle its waiting and ready issues as halted and drop them from
 * the ready queue; its in-flight issues keep their phase.
 */
function onEpicHalt(draft: Draft, state: SchedulerState, epic: number | null): void {
  const index = state.runSet.findIndex((entry) => entry.epic === epic);
  const subject = `epic-halt for ${entryLabel(epic)}`;
  if (index < 0) fail(`${subject}, which is not in the run`);
  if (state.halted[index] === true) fail(`${subject}, which is halted`);
  if (state.epicDone[index] === true) fail(`${subject}, which is done`);
  draft.halted[index] = true;
  for (const issue of state.runSet[index]?.issues ?? []) {
    if (draft.phase[issue] !== 'waiting' && draft.phase[issue] !== 'ready') continue;
    draft.phase[issue] = 'halted';
    dequeue(draft, issue);
  }
}

/** The index of the entry holding `issue`, an issue in the run. */
function entryIndexOf(state: SchedulerState, issue: number): number {
  return state.runSet.findIndex((entry) => entry.issues.includes(issue));
}

/** A transition in progress: fresh copies of the state's mutable parts, plus the action buckets. */
interface Draft {
  readonly phase: Record<number, IssuePhase>;
  readonly retried: Record<number, true>;
  readonly ready: number[];
  readonly epicDone: boolean[];
  readonly halted: boolean[];
  readonly response: SchedulerAction[];
  readonly skips: SchedulerAction[];
  readonly starts: SchedulerAction[];
  /** The end actions: `epic-done` and `epic-halted`. */
  readonly ends: SchedulerAction[];
}

/** Run the input guards in {@link createScheduler}'s `@throws` order. */
function assertInput(input: SchedulerInput): void {
  const { maxSlices, runSet, edges } = input;
  if (!Number.isInteger(maxSlices) || maxSlices < 1) {
    fail(`maxSlices must be an integer of 1 or more, got ${String(maxSlices)}`);
  }
  for (const entry of runSet) {
    if (entry.issues.length === 0) fail(`the entry for ${entryLabel(entry.epic)} has no issues`);
  }
  const entryOf = entryIndexByIssue(runSet);
  assertDistinctEpics(runSet);
  // Before findCycles, which ignores an edge with an endpoint outside its issue list.
  assertEdgesInEntries(edges, entryOf);
  const cycles = findCycles(runSetIssues(runSet), edges);
  if (cycles.length > 0) {
    fail(`dependency cycle among ${cycles.map((c) => c.map(hash).join(', ')).join('; ')}`);
  }
}

/** Map each issue to its entry's index. */
function entryIndexByIssue(runSet: RunSet): ReadonlyMap<number, number> {
  const entryOf = new Map<number, number>();
  runSet.forEach((entry, index) => {
    for (const issue of entry.issues) {
      if (entryOf.has(issue)) fail(`issue ${hash(issue)} appears more than once in the run set`);
      entryOf.set(issue, index);
    }
  });
  return entryOf;
}

/** Reject two entries with one `epic` key (two `null`s included). */
function assertDistinctEpics(runSet: RunSet): void {
  const seen = new Set<number | null>();
  for (const { epic } of runSet) {
    if (seen.has(epic))
      fail(`two entries share the epic key ${epic === null ? 'null' : hash(epic)}`);
    seen.add(epic);
  }
}

/** Reject an edge with an endpoint outside the run set, then one crossing entries. */
function assertEdgesInEntries(
  edges: readonly RunEdge[],
  entryOf: ReadonlyMap<number, number>,
): void {
  for (const e of edges) {
    const outside = [e.blocker, e.dependent].find((issue) => !entryOf.has(issue));
    if (outside !== undefined) {
      fail(`edge ${edgeLabel(e)} names ${hash(outside)}, which is outside the run set`);
    }
  }
  for (const e of edges) {
    if (entryOf.get(e.blocker) !== entryOf.get(e.dependent)) {
      fail(`edge ${edgeLabel(e)} crosses run-set entries`);
    }
  }
}

/** Build the initial state: roots ready in input order, the rest waiting. */
function initialState(input: SchedulerInput): SchedulerState {
  const runSet = input.runSet.map((entry) => ({ epic: entry.epic, issues: [...entry.issues] }));
  const order = runSet.flatMap((entry) => entry.issues);
  const edges = dedupeEdges(input.edges);
  const blockers: Record<number, number[]> = {};
  const phase: Record<number, IssuePhase> = {};
  for (const issue of order) blockers[issue] = [];
  for (const e of edges) blockers[e.dependent]?.push(e.blocker);
  for (const issue of order) phase[issue] = blockers[issue]?.length ? 'waiting' : 'ready';
  return {
    maxSlices: input.maxSlices,
    runSet,
    edges,
    order,
    blockers,
    phase,
    retried: {},
    ready: order.filter((issue) => phase[issue] === 'ready'),
    epicDone: runSet.map(() => false),
    halted: runSet.map(() => false),
  };
}

/** Drop repeated edges, keeping first occurrences in order. */
function dedupeEdges(edges: readonly RunEdge[]): RunEdge[] {
  const seen = new Set<string>();
  const out: RunEdge[] = [];
  for (const e of edges) {
    const key = `${String(e.blocker)}>${String(e.dependent)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ blocker: e.blocker, dependent: e.dependent });
  }
  return out;
}

/** Reject an unknown event kind, an unknown issue, or a phase that does not accept the event. */
function assertPhase(state: SchedulerState, event: IssueEvent): void {
  const phase = state.phase[event.issue];
  const subject = `${event.kind} for ${hash(event.issue)}`;
  // The rendered workflow is plain JS: nothing type-checks the kind it feeds.
  if (!Object.hasOwn(ACCEPTED_PHASES, event.kind)) fail(`unknown event ${subject}`);
  if (phase === undefined) fail(`${subject}, which is not in the run`);
  if (!ACCEPTED_PHASES[event.kind].includes(phase)) fail(`${subject}, which is ${phase}`);
}

/** Start a transition: an empty draft over fresh copies of the state's mutable parts. */
function openDraft(state: SchedulerState): Draft {
  return {
    phase: { ...state.phase },
    retried: { ...state.retried },
    ready: [...state.ready],
    epicDone: [...state.epicDone],
    halted: [...state.halted],
    response: [],
    skips: [],
    starts: [],
    ends: [],
  };
}

/**
 * Fill free slots, emit the finished epics and assemble the transition from the state the draft
 * was opened from: the next state and the actions in {@link Transition.actions} order.
 */
function finish(state: SchedulerState, draft: Draft): Transition {
  fill(draft, state);
  emitEnds(draft, state);
  return {
    state: {
      ...state,
      phase: draft.phase,
      retried: draft.retried,
      ready: draft.ready,
      epicDone: draft.epicDone,
      halted: draft.halted,
    },
    actions: [...draft.response, ...draft.skips, ...draft.starts, ...draft.ends],
  };
}

/** Settle an issue as committed and promote the waiting issues it unblocked. */
function onCommitted(draft: Draft, state: SchedulerState, issue: number): void {
  draft.phase[issue] = 'committed';
  for (const candidate of state.order) {
    if (draft.phase[candidate] !== 'waiting') continue;
    const blockers = state.blockers[candidate] ?? [];
    if (blockers.every((b) => draft.phase[b] === 'committed')) {
      draft.phase[candidate] = 'ready';
      draft.ready.push(candidate);
    }
  }
}

/** Retry on the first death; block and skip the dependents on the second. */
function onAgentDied(draft: Draft, state: SchedulerState, issue: number): void {
  if (draft.retried[issue]) {
    draft.response.push({ kind: 'block', issue, reason: 'retry-exhausted' });
    settleAndSkip(draft, state, issue, 'retry-exhausted');
    return;
  }
  draft.retried[issue] = true;
  restart(draft, { kind: 'retry', issue });
}

/** Drop an issue from the run (and the ready queue) and skip its dependents. */
function onLabelRemoved(draft: Draft, state: SchedulerState, issue: number): void {
  dequeue(draft, issue);
  settleAndSkip(draft, state, issue, 'label-removed');
}

/** Drop an issue from the ready queue, when it is queued. */
function dequeue(draft: Draft, issue: number): void {
  const queued = draft.ready.indexOf(issue);
  if (queued >= 0) draft.ready.splice(queued, 1);
}

/** Announce a restart (the `requeue` or `retry` action) and put the issue at the queue front. */
function restart(draft: Draft, response: SchedulerAction & { kind: 'requeue' | 'retry' }): void {
  draft.response.push(response);
  draft.phase[response.issue] = 'ready';
  draft.ready.unshift(response.issue);
}

/** Settle a root that went bad and skip every still-waiting transitive dependent. */
function settleAndSkip(
  draft: Draft,
  state: SchedulerState,
  root: number,
  trigger: SkipCause['trigger'],
): void {
  draft.phase[root] = trigger === 'label-removed' ? 'removed' : 'blocked';
  for (const issue of transitiveDependents([root], state.edges)) {
    if (draft.phase[issue] !== 'waiting') continue;
    draft.phase[issue] = 'skipped';
    draft.skips.push({ kind: 'skip', issue, cause: { root, trigger } });
  }
}

/** Start ready issues from the queue head while a slot is free. */
function fill(draft: Draft, state: SchedulerState): void {
  let authoring = state.order.filter((issue) => draft.phase[issue] === 'authoring').length;
  while (authoring < state.maxSlices) {
    const next = draft.ready.shift();
    if (next === undefined) return;
    draft.phase[next] = 'authoring';
    draft.starts.push({ kind: 'start', issue: next });
    authoring += 1;
  }
}

/**
 * Emit the end action for each entry whose last issue just settled, in input order:
 * `epic-halted` for a halted entry, `epic-done` otherwise.
 */
function emitEnds(draft: Draft, state: SchedulerState): void {
  state.runSet.forEach((entry, index) => {
    if (draft.epicDone[index] === true) return;
    const phases = entry.issues.map((issue) => draft.phase[issue]);
    if (!phases.every((p) => p !== undefined && SETTLED_PHASES.includes(p))) return;
    draft.epicDone[index] = true;
    const kind = draft.halted[index] === true ? 'epic-halted' : 'epic-done';
    draft.ends.push({ kind, epic: entry.epic });
  });
}

/** Throw a `run scheduler:`-prefixed error. */
function fail(message: string): never {
  throw new Error(`run scheduler: ${message}`);
}

/** Render an issue number as `#N`. */
function hash(issue: number): string {
  return `#${String(issue)}`;
}

/** Render an edge as `#blocker -> #dependent`. */
function edgeLabel(e: RunEdge): string {
  return `${hash(e.blocker)} -> ${hash(e.dependent)}`;
}

/**
 * Name an entry by its epic key.
 *
 * @returns `epic #N`, or `the explicit list`.
 */
function entryLabel(epic: number | null): string {
  return epic === null ? 'the explicit list' : `epic ${hash(epic)}`;
}
