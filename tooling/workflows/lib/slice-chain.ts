/**
 * One issue attempt of the `ship` workflow (ADR-0045 decisions 3–4): in a
 * slice worktree cut from the epic's branch head — the readiness re-check,
 * the cut and provision, plan, plan review (its findings applied once), tdd,
 * diff review, review and test review, each agent working in the slice and
 * the last two amending its one commit; then, through the epic's commit
 * queue, the landing.
 *
 * **Every attempt ends the same way** ({@link runAttempt}): its slice, when
 * one was cut, is torn down first, then the attempt reports its primary
 * event and the halt it called for, for the drive loop to settle
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
  type DiffReviewOutput,
  type PlanCard,
  type ReviewOutput,
  type SliceWork,
  type TddOutput,
  type TestReviewOutput,
} from './agent-calls.js';
import {
  landingEvent,
  teardownEvent,
  teardownResidue,
  type CommitQueue,
  type EpicHaltEvent,
} from './commit-queue.js';
import type { WorkflowHooks } from './hooks.types.js';
import { commitMessage, type SliceSize } from './pr-body.js';
import type {
  LeaseValues,
  PlannerValues,
  PriorSlice,
  SliceCommitValues,
  SliceReviewValues,
} from './prompts.js';
import { isTrivialSurface } from './stages.js';
import { envelopeProblem, runPlace, runTool, type ToolPlace } from './tool-calls.js';

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
  /**
   * An attached run's number (`cut-batch --attach --attached-run`'s
   * `attach.run`), which names its slices; `null` for an unattached run.
   */
  readonly attachedRun: number | null;
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
  /** The halt it called for: its primary `epic-halt`, else its teardown's; `null` for none. */
  readonly halt: EpicHaltEvent | null;
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
  /** Its landed commit's size (the `land` envelope's `files` count and `lines`); `null` unless it landed with both. */
  readonly size: SliceSize | null;
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

/** One attempt: who it is, and what its ending reads, filled in as its stages learn it. */
interface Attempt {
  readonly ctx: EntryContext;
  readonly issue: number;
  readonly attempt: number;
  /** `<issue>-<attempt>`: the attempt's label detail and file-name stem. */
  readonly tag: string;
  readonly place: ToolPlace;
  /** The files the previous attempt's landing conflicted on; `[]` for none. */
  readonly previousConflicts: readonly string[];
  /** The slice a cut named, a failed cut's included: what the teardown removes; `null` if none. */
  slice: string | null;
  startedAt: string | null;
  committedAt: string | null;
  size: SliceSize | null;
  conflicts: readonly string[];
  work: SliceWork | null;
  commit: string | null;
}

/** A stage's answer: its output for the next stage, or the event that ends the attempt. */
type Step<T> = { readonly next: T } | { readonly stop: SchedulerEvent };

/** A slice the cut made: its attempt, its worktree and the batch commit it was cut at. */
interface CutSlice {
  readonly at: Attempt;
  readonly slice: string;
  readonly base: string;
}

/** A provisioned slice: the project dir its server-tier runs lease against. */
interface ProvisionedSlice extends CutSlice {
  readonly projectDir: string;
}

/** A planned slice: the card it is built from (the applier's, when one ran). */
interface PlannedSlice extends ProvisionedSlice {
  readonly card: PlanCard;
}

/** A built slice: the tdd's answer, its commit `tdd.sha`. */
interface BuiltSlice extends PlannedSlice {
  readonly tdd: TddOutput;
}

/**
 * The built slice as the stages after the build read it: its commit, moved
 * by each amend, and each review's answer, `null` until given.
 */
interface ReviewingSlice extends BuiltSlice {
  sha: string;
  diffReview: DiffReviewOutput | null;
  review: ReviewOutput | null;
  testReview: TestReviewOutput | null;
}

/** A stage after the build: `null` to go on, or the event that ends the attempt. */
type ReviewStage = (s: ReviewingSlice) => Promise<SchedulerEvent | null>;

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
  const authored = await authorSlice(at).catch((err: unknown) => ({ stop: stageThrew(at, err) }));
  if ('stop' in authored) return endAttempt(at, authored.stop);
  const slice = authored.next;
  const landing = ctx.queue
    .enqueue(() => landSlice(slice).catch((err: unknown) => landThrew(at, err)))
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
    size: null,
    conflicts: [],
    work: null,
    commit: null,
  };
}

/** The stages after the build, in order. */
const REVIEW_STAGES: readonly ReviewStage[] = [diffReviewStage, reviewStage, testReviewStage];

/**
 * Build the slice, then run the stages after the build; the attempt's `work`
 * is filled in once the slice is authored.
 */
async function authorSlice(at: Attempt): Promise<Step<ReviewingSlice>> {
  const built = await buildSlice(at);
  if ('stop' in built) return built;
  const s = startReviews(built.next);
  const stop = await reviewSlice(s);
  if (stop !== null) return { stop };
  const { card, tdd, diffReview, review, testReview } = s;
  if (diffReview === null || review === null) {
    return { stop: blocked(at, 'authoring left no work') };
  }
  at.work = { card, tdd, diffReview, review, testReview };
  return { next: s };
}

/** Run the stages from the re-check through the tdd, each at a boundary that sees a halt. */
async function buildSlice(at: Attempt): Promise<Step<BuiltSlice>> {
  const ready = await atBoundary({ next: at }, at, recheckStage);
  const cut = await atBoundary(ready, at, cutStage);
  const provisioned = await atBoundary(cut, at, provisionStage);
  const planned = await atBoundary(provisioned, at, planStage);
  const reviewed = await atBoundary(planned, at, planReviewStage);
  return atBoundary(reviewed, at, tddStage);
}

/** Pass a stop on; else stop for a halting entry; else run the next stage. */
async function atBoundary<I, O>(
  step: Step<I>,
  at: Attempt,
  stage: (input: I) => Promise<Step<O>>,
): Promise<Step<O>> {
  if ('stop' in step) return step;
  if (at.ctx.isHalting()) return { stop: haltedStop(at) };
  return stage(step.next);
}

/** The built slice as the reviews start from: its commit the tdd's, no review yet. */
function startReviews(built: BuiltSlice): ReviewingSlice {
  return { ...built, sha: built.tdd.sha, diffReview: null, review: null, testReview: null };
}

/** Run the stages after the build, stopping at the first that ends the attempt or for a halt. */
async function reviewSlice(s: ReviewingSlice): Promise<SchedulerEvent | null> {
  for (const stage of REVIEW_STAGES) {
    if (s.at.ctx.isHalting()) return haltedStop(s.at);
    const stop = await stage(s);
    if (stop !== null) return stop;
  }
  return null;
}

/** Re-check the issue is still open and labelled; `label-removed` when not. */
async function recheckStage(at: Attempt): Promise<Step<Attempt>> {
  const out = await runTool(at.ctx.hooks, 'check', [String(at.issue)], at.place);
  if (out === null) return { stop: died(at) };
  if (out.ready === true) return { next: at };
  if (out.ready === false) return { stop: { kind: 'label-removed', issue: at.issue } };
  return {
    stop: blocked(at, `check gave no verdict: ${out.stderrTail ?? `exit ${String(out.exitCode)}`}`),
  };
}

/**
 * Cut the attempt's slice from the batch head; a cut that names its slice
 * records it on the attempt for the teardown, even when it fails.
 */
async function cutStage(at: Attempt): Promise<Step<CutSlice>> {
  const argv = [
    at.ctx.batch,
    '--issue',
    String(at.issue),
    '--attempt',
    String(at.attempt),
    ...attachedRunArgs(at.ctx),
  ];
  const out = await runTool(at.ctx.hooks, 'cut-slice', argv, at.place);
  if (typeof out?.slice === 'string') at.slice = out.slice;
  if (typeof out?.at === 'string') at.startedAt = out.at;
  if (out === null) return { stop: died(at) };
  if (out.status !== 'ok' || typeof out.slice !== 'string' || typeof out.base !== 'string') {
    return { stop: blocked(at, envelopeProblem('cut-slice', out)) };
  }
  return { next: { at, slice: out.slice, base: out.base } };
}

/**
 * The `cut-slice` words that name an attached run's slices.
 *
 * @param entry - The entry.
 * @returns `--attached-run <R>` for an attached run; `[]` otherwise.
 */
export function attachedRunArgs(entry: Pick<EntrySetup, 'attachedRun'>): string[] {
  return entry.attachedRun === null ? [] : ['--attached-run', String(entry.attachedRun)];
}

/** Provision the slice, its integration config included; its `PH_PROJECT_DIR` goes on. */
async function provisionStage(cut: CutSlice): Promise<Step<ProvisionedSlice>> {
  const { at } = cut;
  const argv = [cut.slice, '--batch', at.ctx.batch, '--server'];
  const out = await runTool(at.ctx.hooks, 'provision', argv, at.place);
  if (out === null) return { stop: died(at) };
  const projectDir = out.env?.PH_PROJECT_DIR;
  if (out.status !== 'ok' || typeof projectDir !== 'string') {
    return { stop: blocked(at, envelopeProblem('provision', out)) };
  }
  return { next: { ...cut, projectDir } };
}

/** Plan the issue; a `plan` card goes on. */
async function planStage(s: ProvisionedSlice): Promise<Step<PlannedSlice>> {
  const { at } = s;
  return acceptCard(s, await AGENT_CALLS.planner(at.ctx.hooks, plannerValues(s, 'plan'), at.tag));
}

/** Review the plan, and apply its findings once when there are any; the applier's card goes on. */
async function planReviewStage(planned: PlannedSlice): Promise<Step<PlannedSlice>> {
  const { at } = planned;
  const values = {
    issue: at.issue,
    slice: planned.slice,
    planPath: planPath(at),
    findingsPath: `${at.ctx.reportDir}/plan-review-${at.tag}.md`,
    reportDir: at.ctx.reportDir,
  };
  const review = await AGENT_CALLS.planReviewer(at.ctx.hooks, values, at.tag);
  if (review === null) return { stop: died(at) };
  if (review.findings === 0) return { next: planned };
  const applied = await AGENT_CALLS.planner(
    at.ctx.hooks,
    plannerValues(planned, 'apply', review.findingsPath),
    at.tag,
  );
  return acceptCard(planned, applied);
}

/** Author the slice's one commit; a tdd that committed goes on. */
async function tddStage(planned: PlannedSlice): Promise<Step<BuiltSlice>> {
  const { at } = planned;
  const values = {
    issue: at.issue,
    attempt: at.attempt,
    slice: planned.slice,
    base: planned.base,
    planPath: planPath(at),
    reportPath: `${at.ctx.reportDir}/tdd-${at.tag}.md`,
    messagePath: messagePath(at),
    message: commitMessage(at.issue, planned.card),
    lease: leaseValues(planned),
  };
  const tdd = await AGENT_CALLS.tdd(at.ctx.hooks, values, at.tag);
  if (tdd === null) return { stop: died(at) };
  if (tdd.verdict === 'BLOCKED' || tdd.sha === '') {
    return { stop: blocked(at, `tdd ${tdd.verdict}: ${tdd.reason ?? 'no commit'}`) };
  }
  return { next: { ...planned, tdd } };
}

/**
 * Check the slice's commit, read-only, against the repo's rules and its
 * issue and plan; the findings go to {@link diffReviewPath} for the reviewer.
 * `agent-died` when the diff reviewer returns nothing.
 */
async function diffReviewStage(s: ReviewingSlice): Promise<SchedulerEvent | null> {
  const { at } = s;
  const values = {
    ...sliceCommitValues(s),
    findingsPath: diffReviewPath(at),
    reportDir: at.ctx.reportDir,
  };
  const out = await AGENT_CALLS.diffReview(at.ctx.hooks, values, at.tag);
  if (out === null) return died(at);
  s.diffReview = out;
  return null;
}

/**
 * Review the slice — the diff review's findings verified, its own
 * correctness pass — amending its commit with any fix; the amend moves `sha`.
 */
async function reviewStage(s: ReviewingSlice): Promise<SchedulerEvent | null> {
  const { at } = s;
  const values = { ...sliceReviewValues(s, 'review'), findingsPath: diffReviewPath(at) };
  const review = await AGENT_CALLS.reviewer(at.ctx.hooks, values, at.tag);
  if (review === null) return died(at);
  if (review.verdict === 'blocked') return blocked(at, `review: ${review.summary}`);
  s.review = review;
  s.sha = review.sha;
  return null;
}

/** Harden the tests on the slice's final shape, unless it changes no code; an amend moves `sha`. */
async function testReviewStage(s: ReviewingSlice): Promise<SchedulerEvent | null> {
  const { at } = s;
  if (isTrivialSurface(s.tdd.files)) return null;
  const out = await AGENT_CALLS.testReview(
    at.ctx.hooks,
    sliceReviewValues(s, 'test-review'),
    at.tag,
  );
  if (out === null) return died(at);
  if (out.verdict === 'blocked') return blocked(at, `test review: ${out.summary}`);
  s.testReview = out;
  s.sha = out.sha;
  return null;
}

/**
 * Land the authored slice on the batch — run inside the commit queue — its
 * message file first rewritten with the tdd's salvage.
 *
 * @param s - The authored slice; its attempt gains `commit`, `committedAt`
 *   and `size` when it lands (`size` stays `null` when the envelope's
 *   `lines` is), `conflicts` when it conflicts.
 * @returns Resolves to the landing's event (`commit-queue.ts`), or
 *   `epic-halt` without landing when the entry is halting.
 */
async function landSlice(s: ReviewingSlice): Promise<SchedulerEvent> {
  const { at } = s;
  if (at.ctx.isHalting()) return haltedStop(at);
  const argv = [
    at.ctx.batch,
    s.sha,
    '--base',
    s.base,
    '--message-file',
    messagePath(at),
    '--log',
    `${at.ctx.reportDir}/land-${at.tag}.log`,
  ];
  const message = commitMessage(at.issue, s.card, s.tdd.salvage);
  const place = runPlace(at.ctx.reportDir, at.tag, { path: messagePath(at), content: message });
  const out = await runTool(at.ctx.hooks, 'land', argv, place);
  const event = landingEvent(out, { issue: at.issue, epic: at.ctx.epic });
  if (event.kind === 'epic-halt') at.ctx.markHalting();
  if (event.kind === 'committed') {
    at.commit = out?.commit ?? null;
    at.committedAt = out?.at ?? null;
    at.size =
      typeof out?.lines === 'number' && out.files !== undefined
        ? { files: out.files.length, lines: out.lines }
        : null;
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
  const teardownHalt = teardownEvent(teardown, at.ctx.epic);
  if (teardownHalt !== null) at.ctx.markHalting();
  const ending: AttemptEnding = {
    primary,
    halt: primary.kind === 'epic-halt' ? primary : teardownHalt,
    residue: at.slice === null ? null : teardownResidue(teardown),
    work: at.work,
    commit: at.commit,
    conflicts: at.conflicts,
    startedAt: at.startedAt,
    committedAt: at.committedAt,
    size: at.size,
  };
  return { kind: 'ended', issue: at.issue, ending };
}

/** Keep a planner's (or applier's) `plan` card; `agent-died` for none; `blocked` otherwise. */
function acceptCard(s: ProvisionedSlice, card: PlanCard | null): Step<PlannedSlice> {
  if (card === null) return { stop: died(s.at) };
  if (card.verdict !== 'plan') {
    return { stop: blocked(s.at, `planner ${card.verdict}: ${card.evidence}`) };
  }
  return { next: { ...s, card } };
}

/**
 * The planner's values.
 *
 * @param mode - `plan` or `apply`.
 * @param findingsPath - The findings to apply; `apply` only.
 * @returns The values.
 */
function plannerValues(
  s: ProvisionedSlice,
  mode: 'plan' | 'apply',
  findingsPath?: string,
): PlannerValues {
  const { at } = s;
  return {
    mode,
    issue: at.issue,
    attempt: at.attempt,
    slice: s.slice,
    reportDir: at.ctx.reportDir,
    planPath: planPath(at),
    ...(findingsPath === undefined ? {} : { findingsPath }),
    priorSlices: at.ctx.priorSlices(),
    ...(at.previousConflicts.length === 0 ? {} : { conflicts: at.previousConflicts }),
    lease: leaseValues(s),
  };
}

/**
 * Where the slice's server-tier runs lease from: the tdd, the planner, the
 * reviewer and the test reviewer are handed one recipe.
 *
 * @returns The main checkout, the provision's `PH_PROJECT_DIR` and the
 *   run's pool registry.
 */
function leaseValues(s: ProvisionedSlice): LeaseValues {
  return { main: s.at.ctx.main, projectDir: s.projectDir, registry: s.at.ctx.registry };
}

/**
 * The slice's one commit as the stages after the tdd are handed it.
 *
 * @returns The issue, the slice, its base and plan, the current commit and
 *   the tdd's changed paths.
 */
function sliceCommitValues(s: ReviewingSlice): SliceCommitValues {
  return {
    issue: s.at.issue,
    slice: s.slice,
    base: s.base,
    planPath: planPath(s.at),
    sha: s.sha,
    files: s.tdd.files,
  };
}

/**
 * The reviewer's or the test reviewer's values.
 *
 * @param report - The report's file-name prefix.
 * @returns The values, the slice's lease recipe ({@link leaseValues}) among
 *   them.
 */
function sliceReviewValues(s: ReviewingSlice, report: string): SliceReviewValues {
  return {
    ...sliceCommitValues(s),
    reportPath: `${s.at.ctx.reportDir}/${report}-${s.at.tag}.md`,
    lease: leaseValues(s),
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
 * The attempt's commit message file: the tdd writes it; the landing rewrites it, salvage added.
 *
 * @param at - The attempt.
 * @returns `<reportDir>/commit-<issue>-<attempt>.txt`.
 */
function messagePath(at: Attempt): string {
  return `${at.ctx.reportDir}/commit-${at.tag}.txt`;
}

/**
 * The attempt's diff-review findings file: the diff reviewer writes it, the
 * reviewer reads it.
 *
 * @param at - The attempt.
 * @returns `<reportDir>/diff-review-<issue>-<attempt>.md`.
 */
function diffReviewPath(at: Attempt): string {
  return `${at.ctx.reportDir}/diff-review-${at.tag}.md`;
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
