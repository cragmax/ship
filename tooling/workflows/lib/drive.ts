/**
 * The `ship` workflow's event loop (ADR-0045 decision 3): drives the run
 * scheduler over every cut entry. It keeps the scheduler state, one
 * in-flight promise per issue (and per running epic end), and each entry's
 * halt state; it runs every action in the order the scheduler emits it, and
 * feeds each settled attempt's events in order.
 *
 * - `start` runs an attempt (`slice-chain.ts`); `requeue` and `retry` only
 *   bump the issue's attempt number — the attempt already tore its slice down.
 * - An authored attempt feeds `slot-free`; its landing settles later.
 * - An ended attempt is settled by `settleEvents` (`commit-queue.ts`),
 *   recorded, then fed.
 * - `skip` and `block` record the issue as `see #N`; `epic-done` runs the
 *   epic end when anything landed (else `nothing-landed`); `epic-halted`
 *   records the entry halted.
 *
 * **Two halt flags per entry.** *Halting* is raised as soon as a landing or
 * teardown calls for a halt — the entry's attempts stop and its queued
 * landings never run. *Halted* means the scheduler was fed `epic-halt`;
 * `settleEvents` reads it, since a second `epic-halt` throws.
 *
 * Generic over entries and issues: one issue proves the chain (#1035),
 * #1036 the parallelism.
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

import { createCommitQueue, settleEvents } from './commit-queue.js';
import { epicEnd, type EpicReport, type IssueReport } from './epic-end.js';
import type { WorkflowHooks } from './hooks.types.js';
import type { LandedIssue } from './pr-body.js';
import type { MainSnapshot } from './preflight.js';
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
  /** The run graph; entry `i` is `entries[i]`. */
  readonly graph: RunGraph;
  /** Each entry, cut and provisioned, in run-set order. */
  readonly entries: readonly EntrySetup[];
  /** The authoring cap. */
  readonly maxSlices: number;
  /** The main checkout as pre-flight found it. */
  readonly launch: MainSnapshot | null;
}

/** A settled flight. */
type Note =
  | AttemptNote
  | { readonly kind: 'epic-end'; readonly entry: number; readonly report: EpicReport };

/** How an entry ended without a report of its own epic end. */
type EntryEnd = 'halted' | 'nothing-landed';

/** The loop's state. */
interface Drive {
  readonly input: DriveInput;
  readonly contexts: EntryContext[];
  scheduler: SchedulerState | null;
  readonly flights: Map<string, Promise<Note>>;
  readonly attempts: Map<number, number>;
  readonly halting: Set<number>;
  readonly halted: Set<number>;
  readonly outcomes: Map<number, IssueReport>;
  readonly landed: Map<number, LandedIssue[]>;
  readonly residue: Map<number, string[]>;
  readonly ends: Map<number, EpicReport | EntryEnd>;
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
    halting: new Set(),
    halted: new Set(),
    outcomes: new Map(),
    landed: new Map(),
    residue: new Map(),
    ends: new Map(),
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
 * Handle one settled flight.
 *
 * @param d - The loop state.
 * @param note - The flight's note.
 */
function onNote(d: Drive, note: Note): void {
  if (note.kind === 'epic-end') {
    d.ends.set(note.entry, note.report);
  } else if (note.kind === 'authored') {
    d.flights.set(flightKey(note), note.landing);
    feed(d, [{ kind: 'slot-free', issue: note.issue }]);
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
    case 'start': {
      const ctx = d.contexts[entryOfIssue(d, action.issue)];
      if (ctx === undefined) throw new Error(`ship: no entry holds #${String(action.issue)}`);
      const attempt = d.attempts.get(action.issue) ?? 1;
      d.flights.set(`issue:${String(action.issue)}`, runAttempt(ctx, action.issue, attempt));
      break;
    }
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
      d.ends.set(entryOfEpic(d, action.epic), 'halted');
      break;
  }
}

/**
 * Start an entry's epic end, or record that nothing landed. An epic end
 * that rejects reports its entry `stopped` with the throw's message — it
 * never rejects the drive, so the other entries still report.
 *
 * @param d - The loop state.
 * @param i - The entry.
 */
function endEpic(d: Drive, i: number): void {
  const landed = d.landed.get(i) ?? [];
  const entry = d.input.entries[i];
  if (landed.length === 0 || entry === undefined) {
    d.ends.set(i, 'nothing-landed');
    return;
  }
  if (!d.epicEndEntered) d.input.hooks.phase(PHASE_TITLES.epicEnd);
  d.epicEndEntered = true;
  const issues = issueReports(d, i);
  const residue = d.residue.get(i) ?? [];
  const report = epicEnd({
    hooks: d.input.hooks,
    entry,
    landed,
    issues,
    residue,
    launch: d.input.launch,
  }).catch(
    (err: unknown): EpicReport => ({
      epic: entry.epic,
      branch: entry.branch,
      outcome: 'stopped',
      message: `the epic end threw: ${err instanceof Error ? err.message : String(err)}`,
      issues,
      residue,
    }),
  );
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
 * @returns Its epic end's report, or a `halted` / `nothing-landed` one.
 */
function entryReport(d: Drive, i: number): EpicReport {
  const end = d.ends.get(i) ?? 'halted';
  if (typeof end !== 'string') return end;
  const entry = d.input.entries[i];
  return {
    epic: entry?.epic ?? null,
    branch: entry?.branch ?? '',
    outcome: end,
    issues: issueReports(d, i),
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
