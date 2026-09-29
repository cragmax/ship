/**
 * One issue attempt of the `ship` workflow (ADR-0045 decisions 3–4): in a
 * slice worktree cut from the epic's branch head — the readiness re-check,
 * the cut and provision, plan, plan review (its findings applied once), tdd,
 * review and test review, each agent working in the slice and the last two
 * amending its one commit; then, through the epic's commit queue, the
 * landing.
 *
 * **Every attempt ends the same way** ({@link runAttempt}): its slice, when
 * one was cut, is torn down first, then the attempt reports its primary
 * event and the teardown's envelope for the drive loop to settle
 * (`commit-queue.ts`). Whatever ended it — a landing, a stage that blocked,
 * an agent that died, a not-ready re-check, or its entry halting — no issue
 * settles while its slice exists.
 *
 * **A halting entry stops its attempts** at the next stage boundary, and a
 * queued landing of a halting entry never runs; such an attempt ends with
 * `epic-halt`. A landing that calls for a halt (or throws) marks the entry
 * halting inside its queue task, before the queue releases the next landing.
 * A teardown runs outside the queue, so one that calls for a halt marks the
 * entry as it returns: a landing the queue already released still runs.
 *
 * An agent that returns nothing is `agent-died` (the scheduler retries the
 * issue once, in a fresh slice); a stage whose answer does not let the
 * issue proceed is `blocked`, with the reason. A throw in a stage is
 * `blocked` too, never a rejected attempt.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { SchedulerEvent } from '../../lib/run-scheduler.types.js';

import {
  AGENT_CALLS,
  type PlanCard,
  type ReviewOutput,
  type SliceWork,
  type TddOutput,
  type TestReviewOutput,
} from './agent-calls.js';
import { landingEvent, teardownEvent, teardownResidue, type CommitQueue } from './commit-queue.js';
import type { WorkflowHooks } from './hooks.types.js';
import { commitMessage } from './pr-body.js';
import type { PlannerValues, PriorSlice, SliceReviewValues } from './prompts.js';
import { isTrivialSurface } from './stages.js';
import {
  envelopeProblem,
  runPlace,
  runTool,
  type TeardownOutput,
  type ToolPlace,
} from './tool-calls.js';

/** One run-set entry, cut and provisioned: its batch and report directory. */
export interface EntrySetup {
  /** The entry's `epic` key; `null` for an explicit list. */
  readonly epic: number | null;
  /** What tells the entry's calls from other entries' (`epic-1025`, `list`). */
  readonly tag: string;
  /** The feature branch. */
  readonly branch: string;
  /** The main checkout, absolute. */
  readonly main: string;
  /** The batch worktree. */
  readonly batch: string;
  /** The commit the batch was cut at (`cut-batch`'s `base`): the epic's range starts there. */
  readonly base: string;
  /** The run's report directory. */
  readonly reportDir: string;
  /** The trimmed pool registry. */
  readonly registry: string;
}

/** What an attempt runs against: its entry, its epic's queue and the drive's view of the entry. */
export interface EntryContext extends EntrySetup {
  /** The workflow hooks. */
  readonly hooks: WorkflowHooks;
  /** The epic's commit queue. */
  readonly queue: CommitQueue;
  /** Whether the entry is halting. */
  readonly isHalting: () => boolean;
  /** Mark the entry halting. */
  readonly markHalting: () => void;
  /** What the entry landed so far, in landing order. */
  readonly priorSlices: () => readonly PriorSlice[];
}

/** How an attempt ended, for the drive loop to settle. */
export interface AttemptEnding {
  /** What ended it. */
  readonly primary: SchedulerEvent;
  /** The slice teardown's output; `null` when no slice was cut or the runner returned none. */
  readonly teardown: TeardownOutput | null;
  /** What the teardown left behind; `null` when it was clean or had nothing to tear down. */
  readonly residue: string | null;
  /** What the slice produced; `null` unless it was authored. */
  readonly work: SliceWork | null;
  /** The batch commit; `null` unless it landed. */
  readonly commit: string | null;
  /** The files a conflicting landing named; `[]` unless the landing was a harvest conflict. */
  readonly conflicts: readonly string[];
  /** When the slice was cut (the `cut-slice` envelope's `at`); `null` when no cut answered with one. */
  readonly startedAt: string | null;
  /** When it landed (the `land` envelope's `at`); `null` unless it landed. */
  readonly committedAt: string | null;
}

/** An attempt's note to the drive loop. */
export type AttemptNote =
  | {
      /** Authoring finished; the landing settles later; the issue keeps its slot. */
      readonly kind: 'authored';
      /** The issue. */
      readonly issue: number;
      /** Resolves once the queued landing and the teardown are done. */
      readonly landing: Promise<AttemptNote>;
    }
  | {
      /** The attempt is over, its slice torn down. */
      readonly kind: 'ended';
      /** The issue. */
      readonly issue: number;
      /** How. */
      readonly ending: AttemptEnding;
    };

/** One attempt in progress; each stage fills in what it learnt. */
interface Attempt {
  readonly ctx: EntryContext;
  readonly issue: number;
  readonly attempt: number;
  /** `<issue>-<attempt>`: the attempt's label detail and file-name stem. */
  readonly tag: string;
  readonly place: ToolPlace;
  /** The files the previous attempt's landing conflicted on; `[]` for none. */
  readonly previousConflicts: readonly string[];
  slice: string | null;
  startedAt: string | null;
  committedAt: string | null;
  conflicts: readonly string[];
  base: string;
  projectDir: string;
  sha: string;
  card: PlanCard | null;
  tdd: TddOutput | null;
  review: ReviewOutput | null;
  testReview: TestReviewOutput | null;
  work: SliceWork | null;
  commit: string | null;
}

/** A stage: `null` to go on, or the event that ends the attempt. */
type Stage = (at: Attempt) => Promise<SchedulerEvent | null>;

/**
 * Run one attempt of an issue, up to its authored slice; the note for an
 * authored slice carries the queued landing.
 *
 * @param ctx - The entry.
 * @param issue - The issue.
 * @param attempt - The attempt number, 1 for the first.
 * @param previousConflicts - The files the previous attempt's landing
 *   conflicted on, for the planner to re-plan against; `[]` for none.
 * @returns Resolves to the attempt's first note; never rejects.
 */
export async function runAttempt(
  ctx: EntryContext,
  issue: number,
  attempt: number,
  previousConflicts: readonly string[] = [],
): Promise<AttemptNote> {
  const at = newAttempt(ctx, issue, attempt, previousConflicts);
  const stop = await authorSlice(at).catch((err: unknown) => stageThrew(at, err));
  if (stop !== null) return endAttempt(at, stop);
  const landing = ctx.queue
    .enqueue(() => landSlice(at).catch((err: unknown) => landThrew(at, err)))
    .then((event) => endAttempt(at, event));
  return { kind: 'authored', issue, landing };
}

/**
 * A fresh attempt record.
 *
 * @param ctx - The entry.
 * @param issue - The issue.
 * @param attempt - The attempt number.
 * @param previousConflicts - The previous attempt's conflicting files.
 * @returns The record, nothing learnt yet.
 */
function newAttempt(
  ctx: EntryContext,
  issue: number,
  attempt: number,
  previousConflicts: readonly string[],
): Attempt {
  const tag = `${String(issue)}-${String(attempt)}`;
  return {
    ctx,
    issue,
    attempt,
    tag,
    place: runPlace(ctx.reportDir, tag),
    previousConflicts,
    slice: null,
    startedAt: null,
    committedAt: null,
    conflicts: [],
    base: '',
    projectDir: '',
    sha: '',
    card: null,
    tdd: null,
    review: null,
    testReview: null,
    work: null,
    commit: null,
  };
}

/** The authoring stages, in order. */
const AUTHOR_STAGES: readonly Stage[] = [
  recheckStage,
  cutStage,
  provisionStage,
  planStage,
  planReviewStage,
  tddStage,
  reviewStage,
  testReviewStage,
];

/**
 * Run the authoring stages, stopping at the first that ends the attempt or
 * at a stage boundary where the entry is halting.
 *
 * @param at - The attempt.
 * @returns Resolves to `null` once the slice is authored, or the ending event.
 */
async function authorSlice(at: Attempt): Promise<SchedulerEvent | null> {
  for (const stage of AUTHOR_STAGES) {
    if (at.ctx.isHalting()) return haltedStop(at);
    const stop = await stage(at);
    if (stop !== null) return stop;
  }
  const { card, tdd, review, testReview } = at;
  if (card === null || tdd === null || review === null)
    return blocked(at, 'authoring left no work');
  at.work = { card, tdd, review, testReview };
  return null;
}

/**
 * Re-check the issue is still open and labelled.
 *
 * @param at - The attempt.
 * @returns Resolves to `null` when ready; `label-removed` when not.
 */
async function recheckStage(at: Attempt): Promise<SchedulerEvent | null> {
  const out = await runTool(at.ctx.hooks, 'check', [String(at.issue)], at.place);
  if (out === null) return died(at);
  if (out.ready === true) return null;
  if (out.ready === false) return { kind: 'label-removed', issue: at.issue };
  return blocked(at, `check gave no verdict: ${out.stderrTail ?? `exit ${String(out.exitCode)}`}`);
}

/**
 * Cut the attempt's slice from the batch head.
 *
 * @param at - The attempt; gains `slice`, `base` and `startedAt`.
 * @returns Resolves to `null` once cut.
 */
async function cutStage(at: Attempt): Promise<SchedulerEvent | null> {
  const argv = [at.ctx.batch, '--issue', String(at.issue), '--attempt', String(at.attempt)];
  const out = await runTool(at.ctx.hooks, 'cut-slice', argv, at.place);
  if (typeof out?.slice === 'string') at.slice = out.slice;
  if (typeof out?.at === 'string') at.startedAt = out.at;
  if (out === null) return died(at);
  if (out.status !== 'ok' || at.slice === null || typeof out.base !== 'string') {
    return blocked(at, envelopeProblem('cut-slice', out));
  }
  at.base = out.base;
  return null;
}

/**
 * Provision the slice, its integration config included.
 *
 * @param at - The attempt; gains `projectDir`.
 * @returns Resolves to `null` once provisioned.
 */
async function provisionStage(at: Attempt): Promise<SchedulerEvent | null> {
  const argv = [at.slice ?? '', '--batch', at.ctx.batch, '--server'];
  const out = await runTool(at.ctx.hooks, 'provision', argv, at.place);
  if (out === null) return died(at);
  const projectDir = out.env?.PH_PROJECT_DIR;
  if (out.status !== 'ok' || typeof projectDir !== 'string') {
    return blocked(at, envelopeProblem('provision', out));
  }
  at.projectDir = projectDir;
  return null;
}

/**
 * Plan the issue.
 *
 * @param at - The attempt; gains `card`.
 * @returns Resolves to `null` for a `plan` card.
 */
async function planStage(at: Attempt): Promise<SchedulerEvent | null> {
  const card = await AGENT_CALLS.planner(at.ctx.hooks, plannerValues(at, 'plan'), at.tag);
  return acceptCard(at, card);
}

/**
 * Review the plan, and apply its findings once when there are any.
 *
 * @param at - The attempt; its `card` is replaced by the applier's.
 * @returns Resolves to `null` for an approved plan or an applied one.
 */
async function planReviewStage(at: Attempt): Promise<SchedulerEvent | null> {
  const values = {
    issue: at.issue,
    slice: at.slice ?? '',
    planPath: planPath(at),
    findingsPath: `${at.ctx.reportDir}/plan-review-${at.tag}.md`,
  };
  const review = await AGENT_CALLS.planReviewer(at.ctx.hooks, values, at.tag);
  if (review === null) return died(at);
  if (review.findings === 0) return null;
  const applied = await AGENT_CALLS.planner(
    at.ctx.hooks,
    plannerValues(at, 'apply', review.findingsPath),
    at.tag,
  );
  return acceptCard(at, applied);
}

/**
 * Author the slice's one commit.
 *
 * @param at - The attempt; gains `tdd` and `sha`.
 * @returns Resolves to `null` for a committed slice.
 */
async function tddStage(at: Attempt): Promise<SchedulerEvent | null> {
  const card = requireCard(at);
  const values = {
    issue: at.issue,
    attempt: at.attempt,
    slice: at.slice ?? '',
    base: at.base,
    planPath: planPath(at),
    reportPath: `${at.ctx.reportDir}/tdd-${at.tag}.md`,
    messagePath: messagePath(at),
    message: commitMessage(at.issue, card),
    lease: { main: at.ctx.main, projectDir: at.projectDir, registry: at.ctx.registry },
  };
  const tdd = await AGENT_CALLS.tdd(at.ctx.hooks, values, at.tag);
  if (tdd === null) return died(at);
  if (tdd.verdict === 'BLOCKED' || tdd.sha === '') {
    return blocked(at, `tdd ${tdd.verdict}: ${tdd.reason ?? 'no commit'}`);
  }
  at.tdd = tdd;
  at.sha = tdd.sha;
  return null;
}

/**
 * Review the slice, amending its commit with any fix.
 *
 * @param at - The attempt; gains `review`, and the amended `sha`.
 * @returns Resolves to `null` unless the reviewer blocks.
 */
async function reviewStage(at: Attempt): Promise<SchedulerEvent | null> {
  const review = await AGENT_CALLS.reviewer(at.ctx.hooks, sliceReviewValues(at, 'review'), at.tag);
  if (review === null) return died(at);
  if (review.verdict === 'blocked') return blocked(at, `review: ${review.summary}`);
  at.review = review;
  at.sha = review.sha;
  return null;
}

/**
 * Harden the tests on the slice's final shape, unless it changes no code.
 *
 * @param at - The attempt; gains `testReview`, and the amended `sha`.
 * @returns Resolves to `null` unless the test reviewer blocks.
 */
async function testReviewStage(at: Attempt): Promise<SchedulerEvent | null> {
  if (isTrivialSurface(at.tdd?.files ?? [])) return null;
  const values = sliceReviewValues(at, 'test-review');
  const out = await AGENT_CALLS.testReview(at.ctx.hooks, values, at.tag);
  if (out === null) return died(at);
  if (out.verdict === 'blocked') return blocked(at, `test review: ${out.summary}`);
  at.testReview = out;
  at.sha = out.sha;
  return null;
}

/**
 * Land the authored slice on the batch — run inside the commit queue.
 *
 * @param at - The attempt; gains `commit` and `committedAt` when it lands,
 *   `conflicts` when it conflicts.
 * @returns Resolves to the landing's event (`commit-queue.ts`), or
 *   `epic-halt` without landing when the entry is halting.
 */
async function landSlice(at: Attempt): Promise<SchedulerEvent> {
  if (at.ctx.isHalting()) return haltedStop(at);
  const argv = [
    at.ctx.batch,
    at.sha,
    '--base',
    at.base,
    '--message-file',
    messagePath(at),
    '--log',
    `${at.ctx.reportDir}/land-${at.tag}.log`,
  ];
  const out = await runTool(at.ctx.hooks, 'land', argv, at.place);
  const event = landingEvent(out, { issue: at.issue, epic: at.ctx.epic });
  if (event.kind === 'epic-halt') at.ctx.markHalting();
  if (event.kind === 'committed') {
    at.commit = out?.commit ?? null;
    at.committedAt = out?.at ?? null;
  }
  if (event.kind === 'harvest-conflict') at.conflicts = out?.conflicts ?? [];
  return event;
}

/**
 * The event of a landing whose call threw: the batch state is unknown, so
 * the entry halts — marked inside the queue task, before the next landing
 * is released.
 *
 * @param at - The attempt.
 * @param err - The throw.
 * @returns `epic-halt`, naming it.
 */
function landThrew(at: Attempt, err: unknown): SchedulerEvent {
  at.ctx.markHalting();
  return { kind: 'epic-halt', epic: at.ctx.epic, reason: `land threw: ${errorText(err)}` };
}

/**
 * End the attempt: tear its slice down, then report. A teardown call that
 * rejects is read as the runner returning nothing — residue, not a halt.
 *
 * @param at - The attempt.
 * @param primary - What ended it.
 * @returns Resolves to the `ended` note; never rejects.
 */
async function endAttempt(at: Attempt, primary: SchedulerEvent): Promise<AttemptNote> {
  const teardown =
    at.slice === null
      ? null
      : await runTool(at.ctx.hooks, 'teardown', [at.slice], at.place).catch(() => null);
  if (teardownEvent(teardown, at.ctx.epic) !== null) at.ctx.markHalting();
  const ending: AttemptEnding = {
    primary,
    teardown,
    residue: at.slice === null ? null : teardownResidue(teardown),
    work: at.work,
    commit: at.commit,
    conflicts: at.conflicts,
    startedAt: at.startedAt,
    committedAt: at.committedAt,
  };
  return { kind: 'ended', issue: at.issue, ending };
}

/**
 * Keep a planner's (or applier's) card when it plans.
 *
 * @param at - The attempt; gains `card`.
 * @param card - The answer.
 * @returns `null` for a `plan` card; `agent-died` for none; `blocked` otherwise.
 */
function acceptCard(at: Attempt, card: PlanCard | null): SchedulerEvent | null {
  if (card === null) return died(at);
  if (card.verdict !== 'plan') return blocked(at, `planner ${card.verdict}: ${card.evidence}`);
  at.card = card;
  return null;
}

/**
 * The planner's values.
 *
 * @param at - The attempt.
 * @param mode - `plan` or `apply`.
 * @param findingsPath - The findings to apply; `apply` only.
 * @returns The values.
 */
function plannerValues(at: Attempt, mode: 'plan' | 'apply', findingsPath?: string): PlannerValues {
  return {
    mode,
    issue: at.issue,
    attempt: at.attempt,
    slice: at.slice ?? '',
    reportDir: at.ctx.reportDir,
    planPath: planPath(at),
    ...(findingsPath === undefined ? {} : { findingsPath }),
    priorSlices: at.ctx.priorSlices(),
    ...(at.previousConflicts.length === 0 ? {} : { conflicts: at.previousConflicts }),
  };
}

/**
 * The reviewer's or the test reviewer's values.
 *
 * @param at - The attempt.
 * @param report - The report's file-name prefix.
 * @returns The values.
 */
function sliceReviewValues(at: Attempt, report: string): SliceReviewValues {
  return {
    issue: at.issue,
    slice: at.slice ?? '',
    planPath: planPath(at),
    sha: at.sha,
    files: at.tdd?.files ?? [],
    reportPath: `${at.ctx.reportDir}/${report}-${at.tag}.md`,
  };
}

/**
 * The issue's plan file: one per issue, re-planned by a later attempt.
 *
 * @param at - The attempt.
 * @returns `<reportDir>/plans/<issue>.md`.
 */
function planPath(at: Attempt): string {
  return `${at.ctx.reportDir}/plans/${String(at.issue)}.md`;
}

/**
 * The attempt's commit message file: the tdd writes it, the landing reads it.
 *
 * @param at - The attempt.
 * @returns `<reportDir>/commit-<issue>-<attempt>.txt`.
 */
function messagePath(at: Attempt): string {
  return `${at.ctx.reportDir}/commit-${at.tag}.txt`;
}

/**
 * The attempt's plan card.
 *
 * @param at - The attempt, past its plan stage.
 * @returns The card.
 * @throws {@link Error} when there is none — a stage-order bug, caught as `blocked`.
 */
function requireCard(at: Attempt): PlanCard {
  if (at.card === null) throw new Error('ship: the tdd stage ran without a plan card');
  return at.card;
}

/**
 * The event of an attempt stopped for its halting entry.
 *
 * @param at - The attempt.
 * @returns `epic-halt` for the entry.
 */
function haltedStop(at: Attempt): SchedulerEvent {
  return { kind: 'epic-halt', epic: at.ctx.epic, reason: 'its epic halted' };
}

/**
 * The event of an agent that returned nothing.
 *
 * @param at - The attempt.
 * @returns `agent-died`.
 */
function died(at: Attempt): SchedulerEvent {
  return { kind: 'agent-died', issue: at.issue };
}

/**
 * The event of a stage that cannot let the issue proceed.
 *
 * @param at - The attempt.
 * @param reason - Why.
 * @returns `blocked`.
 */
function blocked(at: Attempt, reason: string): SchedulerEvent {
  return { kind: 'blocked', issue: at.issue, reason };
}

/**
 * The event of a stage that threw.
 *
 * @param at - The attempt.
 * @param err - The throw.
 * @returns `blocked`, naming it.
 */
function stageThrew(at: Attempt, err: unknown): SchedulerEvent {
  return blocked(at, `a stage threw: ${errorText(err)}`);
}

/**
 * A throw's message.
 *
 * @param err - The throw.
 * @returns Its message.
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
