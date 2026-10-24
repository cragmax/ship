/**
 * Model harness for `run-scheduler.model.test.ts`: arbitraries, driver and must-fail mutants.
 *
 * The checker judges only what a workflow can see (the events it fed, the actions it got back)
 * and computes dependent closures with its own BFS, never with `run-set.ts`'s
 * `transitiveDependents`, which the scheduler under test uses.
 */

import fc from 'fast-check';

import { advance, createScheduler } from '../../../../src/core/scheduler/run-scheduler.js';
import type { RunEdge } from '../../../../src/core/run-set.js';
import type {
  IssueEvent,
  SchedulerAction,
  SchedulerEvent,
  SchedulerInput,
  SchedulerState,
  SkipCause,
  Transition,
} from '../../../../src/core/scheduler/run-scheduler.types.js';

/** The checker's invariants; per-step ones first, in check order, then end-of-run ones. */
type InvariantName =
  | 'halt-stops-entry'
  | 'dependency-order'
  | 'cap'
  | 'work-conserving'
  | 'skip-only-dependents'
  | 'skip-closure-complete'
  | 'requeue-announced'
  | 'retry-once'
  | 'epic-done-when-settled'
  | 'skip-closure-complete (final)'
  | 'requeued-restarted'
  | 'every-issue-settles'
  | 'one-terminal-per-entry';

/** A named invariant failed. */
export class InvariantViolation extends Error {
  readonly invariant: InvariantName;

  /**
   * Build the violation.
   *
   * @param invariant - The invariant that failed.
   * @param detail - What was seen.
   */
  constructor(invariant: InvariantName, detail: string) {
    super(`${invariant}: ${detail}`);
    this.name = 'InvariantViolation';
    this.invariant = invariant;
  }
}

/** One generated step: an event kind and which candidate issue to aim it at. */
interface Choice {
  readonly kind: SchedulerEvent['kind'];
  readonly pick: number;
}

type Observed = 'unstarted' | 'authoring' | 'landing' | 'settled';

/** An entry's end action kind. */
type EndKind = 'epic-done' | 'epic-halted';

/** What the driver has seen so far, built only from fed events and emitted actions. */
interface View {
  readonly input: SchedulerInput;
  readonly order: readonly number[];
  readonly entryOf: ReadonlyMap<number, number | null>;
  readonly blockers: ReadonlyMap<number, readonly number[]>;
  readonly dependents: ReadonlyMap<number, readonly number[]>;
  readonly status: Map<number, Observed>;
  readonly committed: Set<number>;
  readonly deaths: Map<number, number>;
  readonly badRoots: Map<number, SkipCause['trigger']>;
  readonly skipped: Set<number>;
  readonly pendingRestart: Set<number>;
  readonly removedWhileParked: Set<number>;
  /** The entries fed `epic-halt`, by epic key. */
  readonly halted: Set<number | null>;
  /** Each entry's end actions so far, in emission order. */
  readonly ends: Map<number | null, EndKind[]>;
}

/** The scheduler surface the driver talks to — the real one, or a mutant around it. */
interface Machine {
  readonly create: (input: SchedulerInput) => Transition;
  readonly advance: (state: SchedulerState, event: SchedulerEvent) => Transition;
}

/** Builds a machine; a mutant reads the driver's pre-step view to aim its fault. */
type MachineFactory = (view: View) => Machine;

/** The recorded run: every fed event, and every transition (the initial one first). */
interface Trace {
  readonly events: readonly SchedulerEvent[];
  readonly transitions: readonly Transition[];
}

/**
 * The real scheduler.
 *
 * @returns The scheduler's own `createScheduler` and `advance`.
 */
const realMachine: MachineFactory = () => ({ create: createScheduler, advance });

// ---------------------------------------------------------------- arbitraries

interface InputParts {
  readonly issues: readonly number[];
  readonly epics: readonly number[];
  readonly nullAt: number;
  readonly edgePicks: readonly (readonly [number, number, number])[];
  readonly duplicate: boolean;
  readonly maxSlices: number;
}

/**
 * A valid run graph: 1–3 entries of 1–6 unique issues, distinct epic keys (at
 * most one `null`), a forward-only (so acyclic) random DAG inside each entry,
 * sometimes a duplicated edge, and `maxSlices` 1–4.
 *
 * @returns The arbitrary.
 */
export function arbInput(): fc.Arbitrary<SchedulerInput> {
  return fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 3 }).chain((sizes) => {
    const total = sizes.reduce((a, b) => a + b, 0);

    return fc
      .record({
        issues: fc.uniqueArray(fc.integer({ min: 1, max: 99 }), {
          minLength: total,
          maxLength: total,
        }),
        epics: fc.uniqueArray(fc.integer({ min: 900, max: 999 }), {
          minLength: sizes.length,
          maxLength: sizes.length,
        }),
        nullAt: fc.integer({ min: -1, max: sizes.length - 1 }),
        edgePicks: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { maxLength: 12 }),
        duplicate: fc.boolean(),
        maxSlices: fc.integer({ min: 1, max: 4 }),
      })
      .map((parts) => buildInput(sizes, parts));
  });
}

/**
 * A valid run graph plus a planted ring of 1 or more issues kept inside one
 * entry (a 1-ring is a self-loop).
 *
 * @returns The arbitrary: the cyclic input and the ring's members.
 */
export function arbPlantedCycle(): fc.Arbitrary<{
  readonly input: SchedulerInput;
  readonly ring: readonly number[];
}> {
  return arbInput().chain((input) =>
    fc.nat({ max: input.runSet.length - 1 }).chain((index) =>
      fc
        .shuffledSubarray([...(input.runSet[index]?.issues ?? [])], { minLength: 1 })
        .map((ring) => ({
          input: { ...input, edges: [...input.edges, ...ringEdges(ring)] },
          ring,
        })),
    ),
  );
}

/**
 * A script of up to 30 choices, biased toward `committed`.
 *
 * @returns The arbitrary.
 */
export function arbChoices(): fc.Arbitrary<Choice[]> {
  return fc.array(
    fc.record({
      kind: fc.constantFrom<SchedulerEvent['kind']>(
        'committed',
        'committed',
        'slot-free',
        'blocked',
        'harvest-conflict',
        'agent-died',
        'label-removed',
        'epic-halt',
      ),
      pick: fc.nat(),
    }),
    { maxLength: 30 },
  );
}

// ---------------------------------------------------------------- driver

// eslint-disable-next-line local/comment-budget -- jsdoc/require-param binds here: 3 @param + @returns
/**
 * Drive one run, then settle each live issue (`blocked` in a halted entry, else `committed`).
 *
 * @param input - The run graph.
 * @param choices - The generated script.
 * @param factory - The machine under test (the real scheduler by default).
 * @returns The recorded run.
 * @throws InvariantViolation when an invariant fails.
 */
export function runModel(
  input: SchedulerInput,
  choices: readonly Choice[],
  factory: MachineFactory = realMachine,
): Trace {
  const view = newView(input);
  const machine = factory(view);
  const events: SchedulerEvent[] = [];
  const transitions: Transition[] = [];

  const record = (event: SchedulerEvent | null, t: Transition): Transition => {
    step(view, event, t.actions);
    if (event !== null) events.push(event);
    transitions.push(t);

    return t;
  };

  let t = record(null, machine.create(input));

  for (const choice of choices) {
    const event = pickEvent(view, choice);
    if (event !== undefined) t = record(event, machine.advance(deepFreeze(t.state), event));
  }

  for (let n = 0; n < view.order.length * 4; n += 1) {
    const live = view.order.find((i) => isLive(view.status.get(i)));
    if (live === undefined) break;
    const event: SchedulerEvent = inHaltedEntry(view, live)
      ? { kind: 'blocked', issue: live, reason: 'model' }
      : { kind: 'committed', issue: live };

    t = record(event, machine.advance(deepFreeze(t.state), event));
  }

  checkEnd(view);

  return { events, transitions };
}

function ringEdges(ring: readonly number[]): RunEdge[] {
  return ring.map((blocker, i) => ({ blocker, dependent: ring[(i + 1) % ring.length] ?? blocker }));
}

function buildInput(sizes: readonly number[], parts: InputParts): SchedulerInput {
  let offset = 0;
  const runSet = sizes.map((size, i) => {
    const issues = parts.issues.slice(offset, offset + size);
    offset += size;

    return { epic: i === parts.nullAt ? null : (parts.epics[i] ?? null), issues };
  });
  const edges: RunEdge[] = [];

  for (const [e, a, b] of parts.edgePicks) {
    const issues = runSet[e % runSet.length]?.issues ?? [];
    const lo = issues[Math.min(a % issues.length, b % issues.length)];
    const hi = issues[Math.max(a % issues.length, b % issues.length)];
    if (lo !== undefined && hi !== undefined && lo !== hi)
      edges.push({ blocker: lo, dependent: hi });
  }

  const first = edges[0];
  if (parts.duplicate && first !== undefined) edges.push({ ...first });

  return { runSet, edges, maxSlices: parts.maxSlices };
}

/**
 * Deep-freeze a value so any mutation of it throws.
 *
 * @param value - The value.
 * @returns The same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  freezeAll(value);

  return value;
}

function freezeAll(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeAll(child);
}

function newView(input: SchedulerInput): View {
  const order = input.runSet.flatMap((entry) => [...entry.issues]);
  const blockers = new Map<number, number[]>(order.map((i) => [i, []]));
  const dependents = new Map<number, number[]>(order.map((i) => [i, []]));

  for (const e of input.edges) {
    blockers.get(e.dependent)?.push(e.blocker);
    dependents.get(e.blocker)?.push(e.dependent);
  }

  return {
    input,
    order,
    entryOf: new Map(input.runSet.flatMap((entry) => entry.issues.map((i) => [i, entry.epic]))),
    blockers,
    dependents,
    status: new Map(order.map((i) => [i, 'unstarted'])),
    committed: new Set(),
    deaths: new Map(),
    badRoots: new Map(),
    skipped: new Set(),
    pendingRestart: new Set(),
    removedWhileParked: new Set(),
    halted: new Set(),
    ends: new Map(),
  };
}

function isLive(status: Observed | undefined): boolean {
  return status === 'authoring' || status === 'landing';
}

function inHaltedEntry(view: View, issue: number): boolean {
  const epic = view.entryOf.get(issue);

  return epic !== undefined && view.halted.has(epic);
}

function pickEvent(view: View, choice: Choice): SchedulerEvent | undefined {
  if (choice.kind === 'epic-halt') {
    const open = view.input.runSet.filter(
      ({ epic }) => !view.halted.has(epic) && endCount(view, epic) === 0,
    );
    const entry = open[choice.pick % Math.max(open.length, 1)];

    return entry === undefined
      ? undefined
      : { kind: 'epic-halt', epic: entry.epic, reason: 'model' };
  }

  const pool = candidates(view, choice.kind);
  const issue = pool[choice.pick % Math.max(pool.length, 1)];
  if (issue === undefined) return undefined;

  if (choice.kind === 'blocked') return { kind: 'blocked', issue, reason: 'model' };

  if (choice.kind === 'agent-died') {
    return { kind: 'agent-died', issue, stage: 'model', cause: 'model' };
  }

  return { kind: choice.kind, issue };
}

function candidates(view: View, kind: IssueEvent['kind']): number[] {
  if (kind === 'slot-free') return view.order.filter((i) => view.status.get(i) === 'authoring');
  if (kind === 'label-removed') return view.order.filter((i) => view.status.get(i) !== 'settled');

  // A halted entry lands nothing more: the consumer never feeds its issues `committed`.
  if (kind === 'committed') {
    return view.order.filter((i) => isLive(view.status.get(i)) && !inHaltedEntry(view, i));
  }

  return view.order.filter((i) => isLive(view.status.get(i)));
}

function endCount(view: View, epic: number | null): number {
  return view.ends.get(epic)?.length ?? 0;
}

interface PreStep {
  readonly settled: ReadonlySet<number>;
  readonly ends: ReadonlyMap<number | null, number>;
}

function step(view: View, event: SchedulerEvent | null, actions: readonly SchedulerAction[]): void {
  const pre: PreStep = {
    settled: new Set(view.order.filter((i) => view.status.get(i) === 'settled')),
    ends: new Map(view.input.runSet.map(({ epic }) => [epic, endCount(view, epic)])),
  };

  if (event !== null) applyEvent(view, event);
  for (const action of actions) applyAction(view, action);
  checkStep(view, event, actions, pre);
}

function applyEvent(view: View, event: SchedulerEvent): void {
  if (event.kind === 'epic-halt') {
    haltEntry(view, event.epic);

    return;
  }

  const i = event.issue;

  // In a halted entry every settling event settles the issue as halted: no
  // death counted, no bad root, no restart.
  if (inHaltedEntry(view, i) && event.kind !== 'slot-free') {
    view.status.set(i, 'settled');

    return;
  }

  switch (event.kind) {
    case 'committed':
      view.committed.add(i);
      view.status.set(i, 'settled');
      break;
    case 'blocked':
    case 'label-removed':
      if (event.kind === 'label-removed' && view.pendingRestart.has(i)) {
        view.removedWhileParked.add(i);
      }

      view.badRoots.set(i, event.kind);
      view.status.set(i, 'settled');
      break;
    case 'agent-died':
      view.deaths.set(i, (view.deaths.get(i) ?? 0) + 1);
      break;
    case 'slot-free':
      view.status.set(i, 'landing');
      break;
    case 'harvest-conflict':
      break;
  }
}

/**
 * Halt an entry in the view: its unstarted issues (waiting, ready, or parked
 * for a restart) settle and will never start.
 *
 * @param view - The view.
 * @param epic - The halted entry's epic key.
 */
function haltEntry(view: View, epic: number | null): void {
  view.halted.add(epic);

  for (const i of view.input.runSet.find((entry) => entry.epic === epic)?.issues ?? []) {
    if (view.status.get(i) !== 'unstarted') continue;
    view.status.set(i, 'settled');
    view.pendingRestart.delete(i);
  }
}

function applyAction(view: View, action: SchedulerAction): void {
  if (action.kind === 'epic-done' || action.kind === 'epic-halted') {
    view.ends.set(action.epic, [...(view.ends.get(action.epic) ?? []), action.kind]);

    return;
  }

  // The model's graphs carry declared edges only, which never release.
  if (action.kind === 'release') throw new Error(`model: unexpected ${JSON.stringify(action)}`);
  const i = action.issue;

  switch (action.kind) {
    case 'start':
      view.status.set(i, 'authoring');
      view.pendingRestart.delete(i);
      break;
    case 'skip':
      view.skipped.add(i);
      view.status.set(i, 'settled');
      break;
    case 'retry':
    case 'requeue':
      view.pendingRestart.add(i);
      view.status.set(i, 'unstarted');
      break;
    case 'block':
      view.badRoots.set(i, 'retry-exhausted');
      view.status.set(i, 'settled');
      break;
  }
}

// ---------------------------------------------------------------- checker

function checkStep(
  view: View,
  event: SchedulerEvent | null,
  actions: readonly SchedulerAction[],
  pre: PreStep,
): void {
  checkHaltStopsEntry(view, actions);
  checkDependencyOrder(view, actions);
  checkCap(view);
  checkWorkConserving(view);
  checkSkipOnlyDependents(view, actions, pre);
  checkSkipClosureComplete(view, event, actions);
  checkRequeueAnnounced(view, event, actions);
  checkRetryOnce(view, event, actions);
  for (const entry of view.input.runSet) checkEpicDoneWhenSettled(view, entry, actions, pre);
}

function checkHaltStopsEntry(view: View, actions: readonly SchedulerAction[]): void {
  for (const { issue } of ofKind(actions, 'start')) {
    if (inHaltedEntry(view, issue)) {
      violate('halt-stops-entry', `#${issue} started after epic ${view.entryOf.get(issue)} halted`);
    }
  }
}

function ofKind<K extends SchedulerAction['kind']>(
  actions: readonly SchedulerAction[],
  kind: K,
): Extract<SchedulerAction, { kind: K }>[] {
  return actions.filter((a): a is Extract<SchedulerAction, { kind: K }> => a.kind === kind);
}

function violate(invariant: InvariantName, detail: string): never {
  throw new InvariantViolation(invariant, detail);
}

function checkDependencyOrder(view: View, actions: readonly SchedulerAction[]): void {
  for (const { issue } of ofKind(actions, 'start')) {
    const early = (view.blockers.get(issue) ?? []).filter((b) => !view.committed.has(b));
    if (early.length > 0) violate('dependency-order', `#${issue} started before ${early}`);
  }
}

function checkCap(view: View): void {
  const n = authoringCount(view);
  if (n > view.input.maxSlices) violate('cap', `${n} authoring, cap ${view.input.maxSlices}`);
}

function authoringCount(view: View): number {
  return view.order.filter((i) => view.status.get(i) === 'authoring').length;
}

function checkWorkConserving(view: View): void {
  if (authoringCount(view) >= view.input.maxSlices) return;
  const idle = view.order.find(
    (i) =>
      view.status.get(i) === 'unstarted' &&
      (view.blockers.get(i) ?? []).every((b) => view.committed.has(b)),
  );

  if (idle !== undefined) violate('work-conserving', `#${idle} ready while a slot is free`);
}

function checkSkipOnlyDependents(
  view: View,
  actions: readonly SchedulerAction[],
  pre: PreStep,
): void {
  const seen = new Set<number>();

  for (const { issue, cause } of ofKind(actions, 'skip')) {
    const ok =
      closure(view, cause.root).has(issue) &&
      view.badRoots.get(cause.root) === cause.trigger &&
      !pre.settled.has(issue) &&
      !seen.has(issue);

    if (!ok) violate('skip-only-dependents', `skip #${issue} for root #${cause.root}`);
    seen.add(issue);
  }
}

/**
 * Every issue reachable from `root` along blocker → dependent edges, root excluded.
 *
 * @param view - The view (its input edges).
 * @param root - The starting issue.
 * @returns The reached issues.
 */
function closure(view: View, root: number): Set<number> {
  const reached = new Set<number>();
  const queue = [root];

  for (let v = queue.shift(); v !== undefined; v = queue.shift()) {
    for (const w of view.dependents.get(v) ?? []) {
      if (w === root || reached.has(w)) continue;
      reached.add(w);
      queue.push(w);
    }
  }

  return reached;
}

function checkSkipClosureComplete(
  view: View,
  event: SchedulerEvent | null,
  actions: readonly SchedulerAction[],
): void {
  const roots = ofKind(actions, 'block').map((a) => a.issue);
  if (event?.kind === 'blocked' || event?.kind === 'label-removed') roots.push(event.issue);

  for (const root of roots) {
    const open = [...closure(view, root)].filter((i) => view.status.get(i) !== 'settled');
    if (open.length > 0) violate('skip-closure-complete', `#${root} went bad; ${open} unsettled`);
  }
}

function checkRequeueAnnounced(
  view: View,
  event: SchedulerEvent | null,
  actions: readonly SchedulerAction[],
): void {
  const got = ofKind(actions, 'requeue').map((a) => a.issue);
  const want =
    event?.kind === 'harvest-conflict' && !inHaltedEntry(view, event.issue) ? [event.issue] : [];

  if (got.join() !== want.join()) violate('requeue-announced', `requeued [${got}], want [${want}]`);
}

function checkRetryOnce(
  view: View,
  event: SchedulerEvent | null,
  actions: readonly SchedulerAction[],
): void {
  const retried = ofKind(actions, 'retry').map((a) => a.issue);
  const blocked = ofKind(actions, 'block').map((a) => a.issue);
  const died =
    event?.kind === 'agent-died' && !inHaltedEntry(view, event.issue) ? event.issue : undefined;
  const deaths = died === undefined ? 0 : (view.deaths.get(died) ?? 0);
  const want = { retry: deaths === 1 ? [died] : [], block: deaths === 2 ? [died] : [] };

  if (retried.join() !== want.retry.join() || blocked.join() !== want.block.join()) {
    violate('retry-once', `death ${deaths} of #${died}: retry [${retried}], block [${blocked}]`);
  }
}

function checkEpicDoneWhenSettled(
  view: View,
  entry: SchedulerInput['runSet'][number],
  actions: readonly SchedulerAction[],
  pre: PreStep,
): void {
  // Either end action counts: which kind is right is one-terminal-per-entry's.
  const now = [...ofKind(actions, 'epic-done'), ...ofKind(actions, 'epic-halted')].filter(
    (a) => a.epic === entry.epic,
  ).length;
  const before = pre.ends.get(entry.epic) ?? 0;
  const settled = entry.issues.every((i) => view.status.get(i) === 'settled');
  const want = settled && before === 0 ? 1 : 0;

  if (now !== want) {
    violate('epic-done-when-settled', `epic ${entry.epic}: emitted ${now}, want ${want}`);
  }
}

function checkEnd(view: View): void {
  checkFinalSkips(view);
  const stranded = [...view.pendingRestart].filter((i) => !view.removedWhileParked.has(i));
  if (stranded.length > 0) violate('requeued-restarted', `never restarted: ${stranded}`);
  const open = view.order.filter((i) => view.status.get(i) !== 'settled');
  if (open.length > 0) violate('every-issue-settles', `unsettled: ${open}`);

  for (const { epic } of view.input.runSet) {
    const got = (view.ends.get(epic) ?? []).join();
    const want = view.halted.has(epic) ? 'epic-halted' : 'epic-done';
    if (got !== want) violate('one-terminal-per-entry', `epic ${epic}: [${got}], want [${want}]`);
  }
}

function checkFinalSkips(view: View): void {
  const roots = [...view.badRoots.keys()];
  const expected = new Set(roots.flatMap((root) => [...closure(view, root)]));
  for (const root of roots) expected.delete(root);
  const want = [...expected].sort((a, b) => a - b).join();
  const got = [...view.skipped].sort((a, b) => a - b).join();
  if (got !== want) violate('skip-closure-complete (final)', `skipped [${got}], want [${want}]`);
}

// ---------------------------------------------------------------- mutants

/** A must-fail twin: a fault around the real scheduler, and the invariant it trips first. */
interface Mutant {
  readonly name: string;
  readonly trips: InvariantName;
  readonly machine: MachineFactory;
}

function mapCreate(extra: (view: View, t: Transition) => SchedulerAction[]): MachineFactory {
  return (view) => ({
    create: (input) => {
      const t = createScheduler(input);

      return { state: t.state, actions: [...t.actions, ...extra(view, t)] };
    },
    advance,
  });
}

function mapActions(
  edit: (
    view: View,
    event: SchedulerEvent,
    actions: readonly SchedulerAction[],
  ) => SchedulerAction[],
): MachineFactory {
  return (view) => ({
    create: createScheduler,
    advance: (state, event) => {
      const t = advance(state, event);

      return { state: t.state, actions: edit(view, event, t.actions) };
    },
  });
}

function skipNonDependent(
  view: View,
  event: SchedulerEvent,
  actions: readonly SchedulerAction[],
): SchedulerAction[] {
  if (event.kind !== 'blocked' && event.kind !== 'label-removed') return [...actions];
  const root = event.issue;
  const reach = closure(view, root);
  // Not one this step starts: skipping it would free a slot in the view that
  // the real scheduler filled, tripping work-conserving first.
  const started = new Set(ofKind(actions, 'start').map((a) => a.issue));
  const victim = view.order.find(
    (i) => i !== root && !reach.has(i) && !started.has(i) && view.status.get(i) === 'unstarted',
  );

  if (victim === undefined) return [...actions];

  return [...actions, { kind: 'skip', issue: victim, cause: { root, trigger: event.kind } }];
}

/**
 * A second death retried like the first: feed the real scheduler a
 * harvest-conflict instead (so its state stays consistent) and relabel the
 * `requeue` it answers with as a `retry`.
 *
 * @returns The mutant machine factory.
 */
function secondRetry(): MachineFactory {
  return (view) => ({
    create: createScheduler,
    advance: (state, event) => {
      if (event.kind !== 'agent-died' || view.deaths.get(event.issue) !== 1) {
        return advance(state, event);
      }

      const t = advance(state, { kind: 'harvest-conflict', issue: event.issue });
      const actions = t.actions.map(
        (a): SchedulerAction => (a.kind === 'requeue' ? { kind: 'retry', issue: a.issue } : a),
      );

      return { state: t.state, actions };
    },
  });
}

/**
 * A halt that leaves the entry's ready issues startable: the real scheduler
 * halts, then one of the entry's ready issues is started anyway.
 *
 * @returns The mutant machine factory.
 */
function startAfterHalt(): MachineFactory {
  return (view) => ({
    create: createScheduler,
    advance: (state, event) => {
      const t = advance(state, event);
      if (event.kind !== 'epic-halt') return t;
      const ready = readyIssueOf(view, event.epic);
      if (ready === undefined) return t;

      return { state: t.state, actions: [...t.actions, { kind: 'start', issue: ready }] };
    },
  });
}

function readyIssueOf(view: View, epic: number | null): number | undefined {
  const isReady = (i: number): boolean =>
    view.status.get(i) === 'unstarted' &&
    (view.blockers.get(i) ?? []).every((b) => view.committed.has(b));

  return view.order.find((i) => view.entryOf.get(i) === epic && isReady(i));
}

/** The must-fail twins, each paired with the invariant it trips first. */
export const MUTANTS: readonly Mutant[] = [
  {
    name: 'start a dependent before its blocker commits',
    trips: 'dependency-order',
    machine: mapCreate((view) => {
      const dependent = view.order.find((i) => (view.blockers.get(i) ?? []).length > 0);

      return dependent === undefined ? [] : [{ kind: 'start', issue: dependent }];
    }),
  },
  {
    name: 'start every root at init, ignoring the cap',
    trips: 'cap',
    machine: mapCreate((view, t) => {
      const started = new Set(ofKind(t.actions, 'start').map((a) => a.issue));

      return view.order
        .filter((i) => (view.blockers.get(i) ?? []).length === 0 && !started.has(i))
        .map((issue) => ({ kind: 'start', issue }));
    }),
  },
  {
    name: 'also skip an unsettled issue that is not a dependent',
    trips: 'skip-only-dependents',
    machine: mapActions(skipNonDependent),
  },
  {
    name: 'drop the first skip of a step',
    trips: 'skip-closure-complete',
    machine: mapActions((_view, _event, actions) =>
      withoutFirst(actions, (a) => a.kind === 'skip'),
    ),
  },
  {
    name: 'drop the requeue but keep the start',
    trips: 'requeue-announced',
    machine: mapActions((_view, _event, actions) => actions.filter((a) => a.kind !== 'requeue')),
  },
  {
    name: 'drop the start that follows a restart',
    trips: 'work-conserving',
    machine: mapActions((_view, _event, actions) => dropRestartStart(actions)),
  },
  { name: 'retry a second agent death', trips: 'retry-once', machine: secondRetry() },
  {
    name: 'emit every epic-done at init',
    trips: 'epic-done-when-settled',
    machine: mapCreate((view) =>
      view.input.runSet.map(({ epic }) => ({ kind: 'epic-done', epic })),
    ),
  },
  {
    name: 'duplicate every epic-done',
    trips: 'epic-done-when-settled',
    machine: mapActions((_view, _event, actions) =>
      actions.flatMap((a): SchedulerAction[] => (a.kind === 'epic-done' ? [a, a] : [a])),
    ),
  },
  {
    name: 'leave a halted entry’s ready issues startable',
    trips: 'halt-stops-entry',
    machine: startAfterHalt(),
  },
  {
    name: 'end a halted entry with epic-done',
    trips: 'one-terminal-per-entry',
    machine: mapActions((_view, _event, actions) =>
      actions.map(
        (a): SchedulerAction =>
          a.kind === 'epic-halted' ? { kind: 'epic-done', epic: a.epic } : a,
      ),
    ),
  },
];

function withoutFirst(
  actions: readonly SchedulerAction[],
  match: (a: SchedulerAction) => boolean,
): SchedulerAction[] {
  const at = actions.findIndex(match);

  return at < 0 ? [...actions] : actions.filter((_, i) => i !== at);
}

function dropRestartStart(actions: readonly SchedulerAction[]): SchedulerAction[] {
  const restarted = actions.find((a) => a.kind === 'requeue' || a.kind === 'retry');
  if (restarted === undefined) return [...actions];

  return withoutFirst(actions, (a) => a.kind === 'start' && a.issue === restarted.issue);
}
