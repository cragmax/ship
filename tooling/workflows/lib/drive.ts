/**
 * The `ship` workflow's event loop (ADR-0045 decision 3): drives the run
 * scheduler over every cut entry. It keeps the scheduler state, one
 * in-flight promise per issue (and per running epic end), and each entry's
 * halt state; it runs every action in the order the scheduler emits it, and
 * feeds each settled attempt's events in order.
 *
 * - `start` logs `start #N attempt K` and runs an attempt (`slice-chain.ts`),
 *   handing it the files the issue's last landing conflicted on; `requeue`
 *   and `retry` only bump the issue's attempt number — the attempt already
 *   tore its slice down.
 * - **The cap bounds everything in flight; epic ends run outside it.** An
 *   authored attempt feeds nothing: the issue holds its slot from `start`
 *   until it settles, the commit-queue wait included (the scheduler header:
 *   a workflow that wants a bound on everything in flight never sends
 *   `slot-free`).
 * - An ended attempt is settled by `settleEvents` (`commit-queue.ts`),
 *   recorded — its outcome and its schedule, the final attempt's winning —
 *   then fed.
 * - `skip` and `block` record the issue as `see #N`; `epic-done` starts the
 *   epic end as a flight of its own when anything landed, else the retro
 *   alone; `epic-halted` starts the retro alone. The `Epic end` phase is
 *   entered with the first end flight.
 *
 * **Concurrency.** The loop races un-awaited, `agent()`-chaining promises
 * with `Promise.race` and starts new ones mid-flight; the workflow runtime
 * runs them concurrently and resolves the race in completion order (Claude
 * Code workflow runtime, observed 2026-09-29, #1036 P1). Each entry has its
 * own commit queue; the run has one more, the repo lock its epic ends share.
 * So while more than one flight is in progress, the order of the run's
 * `agent()` calls follows settle timing. With one flight at a time, it does
 * not. That is a single entry at `maxSlices: 1`: each issue holds its slot
 * until it settles, and the entry's one epic end starts after its last issue
 * settles. This is the resume boundary of ADR-0045 decision 10.
 *
 * **Two halt flags per entry.** *Halting* is raised as soon as a landing or
 * teardown calls for a halt — the entry's attempts stop and its queued
 * landings never run. *Halted* means the scheduler was fed `epic-halt`;
 * `settleEvents` reads it, since a second `epic-halt` throws.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import { advance, createScheduler } from '../../lib/run-scheduler.js';
import type {
  SchedulerAction,
  SchedulerEvent,
  SchedulerState,
  Transition,
} from '../../lib/run-scheduler.types.js';
import type { RunGraph } from '../../lib/run-set.js';

import { createCommitQueue, settleEvents, type CommitQueue } from './commit-queue.js';
import { epicEnd, unshippedEpicEnd, type EpicReport, type IssueReport } from './epic-end.js';
import type { WorkflowHooks } from './hooks.types.js';
import type { LandedIssue, ScheduleBlocker, ScheduleEntry } from './pr-body.js';
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
type Timing = Pick<ScheduleEntry, 'attempts' | 'startedAt' | 'committedAt'>;

/** The loop's state. */
interface Drive {
  readonly input: DriveInput;
  readonly contexts: EntryContext[];
  scheduler: SchedulerState | null;
  readonly flights: Map<string, Promise<Note>>;
  readonly attempts: Map<number, number>;
  /** Each issue's last conflicting files, for its next attempt's planner. */
  readonly conflicts: Map<number, readonly string[]>;
  /** Each settled attempt's timing, by issue; the final attempt's wins. */
  readonly timing: Map<number, Timing>;
  readonly halting: Set<number>;
  readonly halted: Set<number>;
  readonly outcomes: Map<number, IssueReport>;
  readonly landed: Map<number, LandedIssue[]>;
  readonly residue: Map<number, string[]>;
  readonly ends: Map<number, EpicReport>;
  /** The run's repo lock, shared by every epic end. */
  readonly repoLock: CommitQueue;
  epicEndEntered: boolean;
}

/**
 * Drive every entry until each has ended.
 *
 * @param input - The graph, the entries and the cap.
 * @returns Resolves to each entry's report, in run-set order.
 */
export async function drive(input: DriveInput): Promise<EpicReport[]> {
  const d = newDrive(input);
  apply(d, createScheduler({ ...input.graph, maxSlices: input.maxSlices }));
  while (d.flights.size > 0) {
    const note = await Promise.race(d.flights.values());
    d.flights.delete(flightKey(note));
    onNote(d, note);
  }
  return input.entries.map((_entry, i) => entryReport(d, i));
}

/**
 * A fresh loop state, with one context (and commit queue) per entry.
 *
 * @param input - The loop's input.
 * @returns The state.
 */
function newDrive(input: DriveInput): Drive {
  const d: Drive = {
    input,
    contexts: [],
    scheduler: null,
    flights: new Map(),
    attempts: new Map(),
    conflicts: new Map(),
    timing: new Map(),
    halting: new Set(),
    halted: new Set(),
    outcomes: new Map(),
    landed: new Map(),
    residue: new Map(),
    ends: new Map(),
    repoLock: createCommitQueue(),
    epicEndEntered: false,
  };
  input.entries.forEach((entry, i) => {
    d.contexts.push({
      ...entry,
      hooks: input.hooks,
      queue: createCommitQueue(),
      isHalting: () => d.halting.has(i),
      markHalting: () => {
        d.halting.add(i);
      },
      priorSlices: () =>
        (d.landed.get(i) ?? []).map((l) => ({
          issue: l.issue,
          commit: l.commit,
          plan: l.card.planPath,
        })),
    });
  });
  return d;
}

/**
 * A flight's key.
 *
 * @param note - The flight's note.
 * @returns `epic:<entry>` for an epic end, `issue:<N>` otherwise.
 */
function flightKey(note: Note): string {
  return note.kind === 'epic-end' ? `epic:${String(note.entry)}` : `issue:${String(note.issue)}`;
}

/**
 * Handle one settled flight. An authored attempt feeds nothing: its issue
 * keeps its slot until its landing settles.
 *
 * @param d - The loop state.
 * @param note - The flight's note.
 */
function onNote(d: Drive, note: Note): void {
  if (note.kind === 'epic-end') {
    d.ends.set(note.entry, note.report);
  } else if (note.kind === 'authored') {
    d.flights.set(flightKey(note), note.landing);
  } else {
    settle(d, note.issue, note.ending);
  }
}

/**
 * Settle an ended attempt: its events, its record, then the feed.
 *
 * @param d - The loop state.
 * @param issue - The issue.
 * @param ending - How the attempt ended.
 */
function settle(d: Drive, issue: number, ending: AttemptEnding): void {
  const i = entryOfIssue(d, issue);
  const epic = d.input.entries[i]?.epic ?? null;
  const events = settleEvents(ending.primary, ending.teardown, {
    issue,
    epic,
    entryHalted: d.halted.has(i),
  });
  if (ending.residue !== null) d.residue.set(i, [...(d.residue.get(i) ?? []), ending.residue]);
  d.conflicts.set(issue, ending.conflicts);
  d.timing.set(issue, {
    attempts: d.attempts.get(issue) ?? 1,
    startedAt: ending.startedAt,
    committedAt: ending.committedAt,
  });
  if (events.some((e) => e.kind === 'epic-halt')) {
    d.halting.add(i);
    d.halted.add(i);
  }
  record(d, i, issue, ending, events);
  feed(d, events);
}

/**
 * Record how an attempt left its issue, before its events are fed — so an
 * epic end the feed starts sees every landing.
 *
 * @param d - The loop state.
 * @param i - The issue's entry.
 * @param issue - The issue.
 * @param ending - How the attempt ended.
 * @param events - Its settle events.
 */
function record(
  d: Drive,
  i: number,
  issue: number,
  ending: AttemptEnding,
  events: readonly SchedulerEvent[],
): void {
  const { work, commit } = ending;
  if (events.some((e) => e.kind === 'committed') && work !== null && commit !== null) {
    d.landed.set(i, [...(d.landed.get(i) ?? []), { ...work, issue, commit }]);
    d.outcomes.set(issue, { issue, outcome: 'landed', cite: work.card.closes, commit });
    return;
  }
  const report = unlandedOutcome(issue, ending, d.halted.has(i));
  if (report !== null) d.outcomes.set(issue, report);
}

/**
 * An attempt's outcome for an issue that did not land now.
 *
 * @param issue - The issue.
 * @param ending - How the attempt ended.
 * @param halted - Whether its entry is halted.
 * @returns `landed-then-halted`, `halted`, `blocked` or `removed`; `null`
 *   when the issue restarts (`harvest-conflict`, a first `agent-died`) —
 *   the scheduler's `block` records a second death.
 */
function unlandedOutcome(
  issue: number,
  ending: AttemptEnding,
  halted: boolean,
): IssueReport | null {
  const { primary, commit } = ending;
  const reason = 'reason' in primary ? primary.reason : undefined;
  if (primary.kind === 'committed' && commit !== null) {
    return { issue, outcome: 'landed-then-halted', cite: 'see', commit };
  }
  if (halted)
    return { issue, outcome: 'halted', cite: 'see', ...(reason === undefined ? {} : { reason }) };
  if (primary.kind === 'blocked')
    return { issue, outcome: 'blocked', cite: 'see', reason: primary.reason };
  if (primary.kind === 'label-removed') {
    return { issue, outcome: 'removed', cite: 'see', reason: 'no longer open and ready-for-agent' };
  }
  return null;
}

/**
 * Feed events to the scheduler in order, running each transition's actions.
 *
 * @param d - The loop state.
 * @param events - The events.
 */
function feed(d: Drive, events: readonly SchedulerEvent[]): void {
  for (const event of events) {
    d.input.hooks.log(`fed ${event.kind} ${eventSubject(event)}`);
    if (d.scheduler === null) throw new Error('ship: fed an event before the scheduler started');
    apply(d, advance(d.scheduler, event));
  }
}

/**
 * Take a transition: keep its state, run its actions in order.
 *
 * @param d - The loop state.
 * @param t - The transition.
 */
function apply(d: Drive, t: Transition): void {
  d.scheduler = t.state;
  for (const action of t.actions) act(d, action);
}

/**
 * Run one scheduler action.
 *
 * @param d - The loop state.
 * @param action - The action.
 */
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

/**
 * Start an issue's next attempt.
 *
 * @param d - The loop state.
 * @param issue - The issue.
 */
function startAttempt(d: Drive, issue: number): void {
  const ctx = d.contexts[entryOfIssue(d, issue)];
  if (ctx === undefined) throw new Error(`ship: no entry holds #${String(issue)}`);
  const attempt = d.attempts.get(issue) ?? 1;
  d.input.hooks.log(`start #${String(issue)} attempt ${String(attempt)}`);
  const conflicts = d.conflicts.get(issue) ?? [];
  d.flights.set(`issue:${String(issue)}`, runAttempt(ctx, issue, attempt, conflicts));
}

/**
 * Start an entry's epic end as a flight, or its retro alone when nothing
 * landed. An epic end that rejects reports its entry `stopped` with the
 * throw's message — it never rejects the drive, so the other entries still
 * report.
 *
 * @param d - The loop state.
 * @param i - The entry.
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
 * Start the retro-only end of an entry that halted or landed nothing. One
 * that rejects reports the entry without retro findings.
 *
 * @param d - The loop state.
 * @param i - The entry.
 * @param outcome - How the entry ended.
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
 * Put an entry's end in flight, entering the `Epic end` phase with the first.
 *
 * @param d - The loop state.
 * @param i - The entry.
 * @param report - The end's report, never rejecting.
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
 * An entry's final report.
 *
 * @param d - The loop state.
 * @param i - The entry.
 * @returns Its end's report; a `halted` one for an entry that never got an
 *   end action, which the scheduler's one-end-per-entry rule rules out.
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
 * An entry's issue lines, in the entry's order.
 *
 * @param d - The loop state.
 * @param i - The entry.
 * @returns Each issue's recorded outcome; `halted` for one the halt settled
 *   before it started.
 */
function issueReports(d: Drive, i: number): IssueReport[] {
  const issues = d.input.graph.runSet[i]?.issues ?? [];
  return issues.map((issue) => d.outcomes.get(issue) ?? { issue, outcome: 'halted', cite: 'see' });
}

/**
 * An entry's schedule, in the entry's order.
 *
 * @param d - The loop state.
 * @param i - The entry.
 * @returns Each issue's blockers in the drive graph (ascending), each with
 *   its source, and its final attempt's timing; `attempts: 0` and `null`
 *   instants for an issue that never started.
 */
function scheduleOf(d: Drive, i: number): ScheduleEntry[] {
  const issues = d.input.graph.runSet[i]?.issues ?? [];
  return issues.map((issue) => ({
    ...neverStarted(issue, d.input.graph, d.input.overlap),
    ...d.timing.get(issue),
  }));
}

/**
 * The schedule line of an issue that never started.
 *
 * @param issue - The issue.
 * @param graph - The graph its blockers are read from.
 * @param overlap - Pre-flight's overlap record, for each blocker's source.
 * @returns Its blockers ascending, each with its source per
 *   {@link scheduleBlocker}, `attempts: 0`, both instants `null`.
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
  return { issue, blockers, attempts: 0, startedAt: null, committedAt: null };
}

/**
 * One graph edge's blocker, with where the edge came from.
 *
 * An edge both declared and estimated reads `declared`: the overlap merge
 * (`mergeOverlapEdges`, `tooling/lib/run-overlap.ts`) adds no edge for a
 * pair the declared edges already order, recording it `sequenced` instead —
 * so a graph edge absent from `overlap.added` is declared.
 *
 * @param blocker - The edge's blocker.
 * @param dependent - The edge's dependent.
 * @param overlap - Pre-flight's overlap record.
 * @returns `overlap` with the added edge's confidence when `overlap.added`
 *   holds the edge; else `declared`.
 */
function scheduleBlocker(
  blocker: number,
  dependent: number,
  overlap: OverlapRecord,
): ScheduleBlocker {
  const added = overlap.added.find((e) => e.blocker === blocker && e.dependent === dependent);
  if (added === undefined) return { issue: blocker, source: 'declared' };
  return { issue: blocker, source: 'overlap', confidence: added.confidence };
}

/**
 * The part of the run's overlap record that concerns one entry.
 *
 * @param d - The loop state.
 * @param i - The entry.
 * @returns The added edges and sequenced pairs inside the entry.
 */
function entryOverlap(d: Drive, i: number): OverlapRecord {
  const issues = new Set(d.input.graph.runSet[i]?.issues ?? []);
  const { overlap } = d.input;
  return {
    added: overlap.added.filter((e) => issues.has(e.blocker)),
    sequenced: overlap.sequenced.filter((p) => issues.has(p.a)),
    areaMap: overlap.areaMap,
  };
}

/**
 * The entry holding an issue.
 *
 * @param d - The loop state.
 * @param issue - An issue of the run.
 * @returns The entry's index.
 */
function entryOfIssue(d: Drive, issue: number): number {
  return d.input.graph.runSet.findIndex((entry) => entry.issues.includes(issue));
}

/**
 * The entry with an `epic` key.
 *
 * @param d - The loop state.
 * @param epic - The key.
 * @returns The entry's index.
 */
function entryOfEpic(d: Drive, epic: number | null): number {
  return d.input.graph.runSet.findIndex((entry) => entry.epic === epic);
}

/**
 * What an event concerns, for the run log.
 *
 * @param event - The event.
 * @returns `#<issue>`, or the entry for `epic-halt`.
 */
function eventSubject(event: SchedulerEvent): string {
  if (event.kind !== 'epic-halt') return `#${String(event.issue)}`;
  return event.epic === null ? 'the issue list' : `epic #${String(event.epic)}`;
}
