/**
 * The `ship` workflow's event loop (Ship ADR-0001 decision 7): drives the run scheduler over every
 * cut entry, running each action in the order the scheduler emits it and feeding each settled
 * attempt's events in order. **The cap bounds everything in flight; epic ends run outside it**:
 * an authored attempt feeds nothing, so its issue keeps its slot until its landing settles.
 *
 * **Concurrency.** The workflow runtime resolves `Promise.race` over un-awaited flights in
 * completion order (Ship PF-7), so while more than one flight is in progress the order of the run's
 * `agent()` calls follows settle timing. With one flight at a time — a single entry at
 * `maxSlices: 1` — it does not: the resume boundary, Ship ADR-0001 decision 17.
 *
 * **One halt state per entry** ({@link HaltState}): once it leaves `running`, the entry's attempts
 * stop and its queued landings never run. Render-safe (`ship/src/build/workflow-render.ts`):
 * ECMAScript built-ins only, no top-level side effect.
 */

import { advance, createScheduler } from '../core/scheduler/run-scheduler.js';
import type {
  ReleasedEdge,
  SchedulerAction,
  SchedulerEvent,
  SchedulerState,
  Transition,
} from '../core/scheduler/run-scheduler.types.js';
import type { RunGraph } from '../core/run-set.js';

import {
  createCommitQueue,
  settleEvents,
  type CommitQueue,
  type HaltState,
} from './commit-queue.js';
import {
  epicEnd,
  unshippedEpicEnd,
  type EpicReport,
  type IssueReport,
} from './epic-end/epic-end.js';
import type { WorkflowHooks } from './runtime.types.js';
import type { LandedIssue, ScheduleBlocker, ScheduleEntry } from './pr/pr-body.js';
import type { MainSnapshot, OverlapRecord } from './preflight.js';
import {
  runAttempt,
  type AttemptEnding,
  type AttemptNote,
  type EntryContext,
  type EntrySetup,
} from './slice-chain.js';
import { PHASE_TITLES } from './stages.js';

/** What the drive loop runs. */
export interface DriveInput {
  /** The workflow hooks. */
  readonly hooks: WorkflowHooks;
  /** The run graph, overlap edges merged; entry `i` is `entries[i]`. */
  readonly graph: RunGraph;
  /** Each entry, cut and provisioned, in run-set order. */
  readonly entries: readonly EntrySetup[];
  /** The most issues in flight at once, from start until settled. */
  readonly maxSlices: number;
  /** The main checkout as pre-flight found it. */
  readonly launch: MainSnapshot | null;
  /** The overlap edges pre-flight added, run-wide. */
  readonly overlap: OverlapRecord;
}

/** A settled flight. */
type Note =
  | AttemptNote
  | { readonly kind: 'epic-end'; readonly entry: number; readonly report: EpicReport };

/** An issue's final attempt, as its schedule reports it. */
type Timing = Pick<ScheduleEntry, 'attempts' | 'startedAt' | 'committedAt' | 'size'>;

/** What settling reads of an ending, by its kind. */
interface EndingFacts extends Pick<Timing, 'committedAt' | 'size'> {
  readonly primary: SchedulerEvent;
}

/** The loop's state. */
interface Drive {
  readonly input: DriveInput;
  readonly contexts: EntryContext[];
  scheduler: SchedulerState | null;
  readonly flights: Map<string, Promise<Note>>;
  readonly attempts: Map<number, number>;
  /** The kept patch of each issue whose last attempt a harvest conflict ended, by issue. */
  readonly previousPatches: Map<number, string>;
  /** Each settled attempt's timing, by issue; the final attempt's wins. */
  readonly timing: Map<number, Timing>;
  /** Each entry's halt state; an entry it lacks is `running`. */
  readonly halts: Map<number, HaltState>;
  readonly outcomes: Map<number, IssueReport>;
  readonly landed: Map<number, LandedIssue[]>;
  readonly residue: Map<number, string[]>;
  readonly ends: Map<number, EpicReport>;
  readonly released: ReleasedEdge[];
  /** The run's repo lock, shared by every epic end. */
  readonly repoLock: CommitQueue;
  epicEndEntered: boolean;
}

/** Drive every entry until each has ended; the reports come in run-set order. */
export async function drive(input: DriveInput): Promise<EpicReport[]> {
  const d = newDrive(input);
  const edges = input.graph.edges.map((e) => ({
    ...e,
    source: scheduleBlocker(e.blocker, e.dependent, input.overlap).source,
  }));

  apply(d, createScheduler({ runSet: input.graph.runSet, edges, maxSlices: input.maxSlices }));

  while (d.flights.size > 0) {
    const note = await Promise.race(d.flights.values());
    d.flights.delete(flightKey(note));
    onNote(d, note);
  }

  return input.entries.map((_entry, i) => entryReport(d, i));
}

/** A fresh loop state, with one context (and commit queue) per entry. */
function newDrive(input: DriveInput): Drive {
  const d: Drive = {
    input,
    contexts: [],
    scheduler: null,
    flights: new Map(),
    attempts: new Map(),
    previousPatches: new Map(),
    timing: new Map(),
    halts: new Map(),
    outcomes: new Map(),
    landed: new Map(),
    residue: new Map(),
    ends: new Map(),
    released: [],
    repoLock: createCommitQueue(),
    epicEndEntered: false,
  };

  input.entries.forEach((entry, i) => {
    d.contexts.push({
      ...entry,
      hooks: input.hooks,
      queue: createCommitQueue(),
      isHalting: () => haltOf(d, i) !== 'running',
      markHalting: () => {
        if (haltOf(d, i) === 'running') d.halts.set(i, 'halting');
      },
    });
  });

  return d;
}

function haltOf(d: Drive, i: number): HaltState {
  return d.halts.get(i) ?? 'running';
}

function flightKey(note: Note): string {
  return note.kind === 'epic-end' ? `epic:${String(note.entry)}` : `issue:${String(note.issue)}`;
}

function onNote(d: Drive, note: Note): void {
  if (note.kind === 'epic-end') {
    d.ends.set(note.entry, note.report);
  } else if (note.kind === 'authored') {
    d.flights.set(flightKey(note), note.landing);
  } else {
    settle(d, note.issue, note.ending);
  }
}

/** Settle an ended attempt: its events, its record, then the feed. */
function settle(d: Drive, issue: number, ending: AttemptEnding): void {
  const i = entryOfIssue(d, issue);
  const epic = d.input.entries[i]?.epic ?? null;
  const { primary, committedAt, size } = endingFacts(issue, ending);
  const { events, entry } = settleEvents(primary, ending.halt, {
    issue,
    epic,
    entry: haltOf(d, i),
  });

  d.halts.set(i, entry);
  if (ending.residue !== null) d.residue.set(i, [...(d.residue.get(i) ?? []), ending.residue]);
  d.timing.set(issue, {
    attempts: d.attempts.get(issue) ?? 1,
    startedAt: ending.startedAt,
    committedAt,
    size,
  });
  keepPreviousPatch(d, issue, ending);
  record(d, i, issue, ending, events);
  feed(d, events);
}

/**
 * Hold the ending's kept patch for the issue's next attempt when a harvest conflict ended it, so
 * the requeued tdd starts from it; any other ending drops the issue's held patch.
 */
function keepPreviousPatch(d: Drive, issue: number, ending: AttemptEnding): void {
  const patch =
    ending.kind === 'unlanded' && ending.primary.kind === 'harvest-conflict'
      ? (ending.kept?.patch ?? null)
      : null;

  if (patch === null) d.previousPatches.delete(issue);
  else d.previousPatches.set(issue, patch);
}

/** What settling reads of an ending; a `landed` one's primary is `committed`. */
function endingFacts(issue: number, ending: AttemptEnding): EndingFacts {
  switch (ending.kind) {
    case 'landed':
      return {
        primary: { kind: 'committed', issue },
        committedAt: ending.committedAt,
        size: ending.size,
      };
    case 'unlanded':
      return { primary: ending.primary, committedAt: null, size: null };
  }
}

/**
 * Record how an attempt left its issue, before its events are fed — so an epic end the feed
 * starts sees every landing.
 */
function record(
  d: Drive,
  i: number,
  issue: number,
  ending: AttemptEnding,
  events: readonly SchedulerEvent[],
): void {
  const committed = events.some((e) => e.kind === 'committed');

  if (ending.kind === 'landed' && committed) {
    d.landed.set(i, [...(d.landed.get(i) ?? []), { ...ending.work, issue, commit: ending.commit }]);
  }

  const report = issueOutcome(issue, ending, committed, haltOf(d, i) === 'halted');
  if (report !== null) d.outcomes.set(issue, report);
}

/**
 * An attempt's outcome for its issue, `committed` whether its settle events
 * hold one; `null` when the issue restarts ({@link unlandedOutcome}).
 */
function issueOutcome(
  issue: number,
  ending: AttemptEnding,
  committed: boolean,
  halted: boolean,
): IssueReport | null {
  switch (ending.kind) {
    case 'landed':
      return committed
        ? { issue, outcome: 'landed', cite: ending.work.tdd.closes, commit: ending.commit }
        : { issue, outcome: 'landed-then-halted', cite: 'see', commit: ending.commit };

    case 'unlanded': {
      const outcome = unlandedOutcome(issue, ending.primary, halted);

      return outcome === null || ending.kept === null ? outcome : { ...outcome, kept: ending.kept };
    }
  }
}

/**
 * An attempt's outcome for an issue whose slice did not land: `halted`, `blocked` or `removed`;
 * `null` when the issue restarts (`harvest-conflict`, a first `agent-died`) — the scheduler's
 * `block` records a second death.
 */
function unlandedOutcome(
  issue: number,
  primary: SchedulerEvent,
  halted: boolean,
): IssueReport | null {
  const reason = 'reason' in primary ? primary.reason : undefined;
  if (halted)
    return { issue, outcome: 'halted', cite: 'see', ...(reason === undefined ? {} : { reason }) };
  if (primary.kind === 'blocked')
    return { issue, outcome: 'blocked', cite: 'see', reason: primary.reason };

  if (primary.kind === 'label-removed') {
    return { issue, outcome: 'removed', cite: 'see', reason: 'no longer open and ready-for-agent' };
  }

  return null;
}

/** Feed events to the scheduler in order, running each transition's actions. */
function feed(d: Drive, events: readonly SchedulerEvent[]): void {
  for (const event of events) {
    d.input.hooks.log(`fed ${event.kind} ${eventSubject(event)}`);
    if (d.scheduler === null) throw new Error('ship: fed an event before the scheduler started');
    apply(d, advance(d.scheduler, event));
  }
}

function apply(d: Drive, t: Transition): void {
  d.scheduler = t.state;
  for (const action of t.actions) act(d, action);
}

function act(d: Drive, action: SchedulerAction): void {
  switch (action.kind) {
    case 'start':
      startAttempt(d, action.issue);
      break;
    case 'requeue':
    case 'retry':
      d.attempts.set(action.issue, (d.attempts.get(action.issue) ?? 1) + 1);
      break;
    case 'skip':
      d.outcomes.set(action.issue, {
        issue: action.issue,
        outcome: 'skipped',
        cite: 'see',
        reason: `blocker #${String(action.cause.root)} ${action.cause.trigger}`,
      });
      break;
    case 'release':
      d.released.push({
        blocker: action.blocker,
        dependent: action.dependent,
        trigger: action.trigger,
      });
      break;
    case 'block':
      d.outcomes.set(action.issue, {
        issue: action.issue,
        outcome: 'blocked',
        cite: 'see',
        reason: 'its agent died on the retry too',
      });
      break;
    case 'epic-done':
      endEpic(d, entryOfEpic(d, action.epic));
      break;
    case 'epic-halted':
      endUnshipped(d, entryOfEpic(d, action.epic), 'halted');
      break;
  }
}

function startAttempt(d: Drive, issue: number): void {
  const ctx = d.contexts[entryOfIssue(d, issue)];
  if (ctx === undefined) throw new Error(`ship: no entry holds #${String(issue)}`);
  const attempt = d.attempts.get(issue) ?? 1;
  d.input.hooks.log(`start #${String(issue)} attempt ${String(attempt)}`);
  d.flights.set(
    `issue:${String(issue)}`,
    runAttempt(ctx, issue, attempt, d.previousPatches.get(issue) ?? null),
  );
}

/**
 * Start an entry's epic end as a flight, or its unshipped end ({@link unshippedEpicEnd}) when
 * nothing landed. An epic end that rejects reports its entry `stopped` with the throw's message —
 * it never rejects the drive, so the other entries still report.
 */
function endEpic(d: Drive, i: number): void {
  const landed = d.landed.get(i) ?? [];
  const entry = d.input.entries[i];

  if (landed.length === 0 || entry === undefined) {
    endUnshipped(d, i, 'nothing-landed');

    return;
  }

  const issues = issueReports(d, i);
  const residue = d.residue.get(i) ?? [];
  const schedule = scheduleOf(d, i);
  const report = epicEnd({
    hooks: d.input.hooks,
    entry,
    landed,
    issues,
    schedule,
    residue,
    launch: d.input.launch,
    repoLock: d.repoLock,
    overlap: entryOverlap(d, i),
  }).catch(
    (err: unknown): EpicReport => ({
      epic: entry.epic,
      branch: entry.branch,
      outcome: 'stopped',
      message: `the epic end threw: ${err instanceof Error ? err.message : String(err)}`,
      issues,
      schedule,
      residue,
    }),
  );

  startEnd(d, i, report);
}

/**
 * Start the unshipped end of an entry that halted or landed nothing; one that rejects reports
 * the entry without retro findings.
 */
function endUnshipped(d: Drive, i: number, outcome: 'halted' | 'nothing-landed'): void {
  const entry = d.input.entries[i];
  if (entry === undefined) return;
  const input = {
    hooks: d.input.hooks,
    entry,
    issues: issueReports(d, i),
    schedule: scheduleOf(d, i),
    residue: d.residue.get(i) ?? [],
  };
  const report = unshippedEpicEnd(input, outcome).catch(
    (): EpicReport => ({
      epic: entry.epic,
      branch: entry.branch,
      outcome,
      issues: input.issues,
      schedule: input.schedule,
      residue: input.residue,
      retro: null,
    }),
  );

  startEnd(d, i, report);
}

/**
 * Put an entry's end in flight, entering the `Epic end` phase with the first; `report` must never
 * reject.
 */
function startEnd(d: Drive, i: number, report: Promise<EpicReport>): void {
  if (!d.epicEndEntered) d.input.hooks.phase(PHASE_TITLES.epicEnd);
  d.epicEndEntered = true;
  d.flights.set(
    `epic:${String(i)}`,
    report.then((r): Note => ({ kind: 'epic-end', entry: i, report: r })),
  );
}

/**
 * An entry's final report: its end's, or a `halted` one for an entry that never got an end
 * action, which the scheduler's one-end-per-entry rule rules out.
 */
function entryReport(d: Drive, i: number): EpicReport {
  const end = d.ends.get(i);
  if (end !== undefined) return end;
  const entry = d.input.entries[i];

  return {
    epic: entry?.epic ?? null,
    branch: entry?.branch ?? '',
    outcome: 'halted',
    issues: issueReports(d, i),
    schedule: scheduleOf(d, i),
    residue: d.residue.get(i) ?? [],
  };
}

/**
 * An entry's issue lines, in the entry's order: each issue's recorded outcome, `halted` for one
 * the halt settled before it started.
 */
function issueReports(d: Drive, i: number): IssueReport[] {
  const issues = d.input.graph.runSet[i]?.issues ?? [];

  return issues.map((issue) => d.outcomes.get(issue) ?? { issue, outcome: 'halted', cite: 'see' });
}

/**
 * An entry's schedule, in the entry's order: each issue's blockers in the drive graph, a released
 * overlap edge's with its trigger, and its final attempt's timing; `attempts: 0` and `null`
 * instants for an issue that never started.
 */
function scheduleOf(d: Drive, i: number): ScheduleEntry[] {
  const issues = d.input.graph.runSet[i]?.issues ?? [];

  return issues.map((issue) => {
    const entry = neverStarted(issue, d.input.graph, d.input.overlap);
    const blockers = entry.blockers.map((b): ScheduleBlocker => {
      const released = d.released.find(
        (r) => r.blocker === b.issue && r.dependent === issue,
      )?.trigger;

      return b.source === 'overlap' && released !== undefined ? { ...b, released } : b;
    });

    return { ...entry, blockers, ...d.timing.get(issue) };
  });
}

/**
 * The schedule line of an issue that never started.
 *
 * @returns Its blockers ascending, each with its source per
 *   {@link scheduleBlocker}, `attempts: 0`, both instants and the size `null`.
 */
export function neverStarted(
  issue: number,
  graph: RunGraph,
  overlap: OverlapRecord,
): ScheduleEntry {
  const blockers = graph.edges
    .filter((e) => e.dependent === issue)
    .map((e) => e.blocker)
    .sort((a, b) => a - b)
    .map((blocker) => scheduleBlocker(blocker, issue, overlap));

  return { issue, blockers, attempts: 0, startedAt: null, committedAt: null, size: null };
}

/**
 * One graph edge's blocker and its source: an edge both declared and estimated reads `declared`,
 * since `mergeOverlapEdges` (`ship/src/core/run-overlap.ts`) adds no edge for a pair the declared
 * edges already order — so a graph edge absent from `overlap.added` is declared.
 */
function scheduleBlocker(
  blocker: number,
  dependent: number,
  overlap: OverlapRecord,
): ScheduleBlocker {
  const added = overlap.added.some((e) => e.blocker === blocker && e.dependent === dependent);

  return { issue: blocker, source: added ? 'overlap' : 'declared' };
}

/** The part of the run's overlap record that concerns one entry. */
function entryOverlap(d: Drive, i: number): OverlapRecord {
  const issues = new Set(d.input.graph.runSet[i]?.issues ?? []);
  const { overlap } = d.input;

  return {
    added: overlap.added.filter((e) => issues.has(e.blocker)),
    sequenced: overlap.sequenced.filter((p) => issues.has(p.a)),
    unsure: overlap.unsure.filter((p) => issues.has(p.a)),
    areaMap: overlap.areaMap,
  };
}

function entryOfIssue(d: Drive, issue: number): number {
  return d.input.graph.runSet.findIndex((entry) => entry.issues.includes(issue));
}

function entryOfEpic(d: Drive, epic: number | null): number {
  return d.input.graph.runSet.findIndex((entry) => entry.epic === epic);
}

function eventSubject(event: SchedulerEvent): string {
  if (event.kind !== 'epic-halt') return `#${String(event.issue)}`;

  return event.epic === null ? 'the issue list' : `epic #${String(event.epic)}`;
}
