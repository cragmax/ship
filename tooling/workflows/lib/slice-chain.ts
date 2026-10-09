/**
 * One issue attempt of the `ship` workflow (ADR-0045 decisions 3–4), in a slice worktree cut from
 * the epic's branch head, its stages ending in a landing through the epic's commit queue.
 *
 * **Every attempt ends the same way**: its slice, when one was cut, is torn down first, then it
 * reports how the slice left it and the halt it called for — no issue settles while its slice
 * exists. **A halting entry stops its attempts** at the next stage boundary, and its queued landing
 * never runs: such an attempt ends with `epic-halt`. A landing that calls for a halt (or throws)
 * marks the entry inside its queue task, before the queue releases the next landing; a teardown
 * runs outside the queue, so its halt is marked as it returns and a landing already released still
 * runs. An agent that returns nothing is `agent-died` (the issue retried once, in a fresh slice);
 * a stage that cannot proceed, or throws, is `blocked` with the reason, never a rejection.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
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
  type TestReviewSkip,
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

/** How an attempt's slice left it: landed on the batch, or not. */
type SliceOutcome =
  | {
      readonly kind: 'landed';
      /** What the slice produced. */
      readonly work: SliceWork;
      /** The batch commit. */
      readonly commit: string;
      /** The `land` envelope's `at`; `null` when it had none. */
      readonly committedAt: string | null;
      /** `null` unless the `land` envelope carried `files` and `lines`. */
      readonly size: SliceSize | null;
    }
  | {
      readonly kind: 'unlanded';
      /** What ended it. */
      readonly primary: SchedulerEvent;
      /** A conflicting landing's files; `[]` otherwise. */
      readonly conflicts: readonly string[];
    };

/** How an attempt ended, for the drive loop to settle: its slice's outcome, then its teardown's. */
export type AttemptEnding = SliceOutcome & {
  /** The halt it called for: an unlanded `epic-halt` primary, else its teardown's; or `null`. */
  readonly halt: EpicHaltEvent | null;
  /** What the teardown left behind; `null` when it was clean or had nothing to tear down. */
  readonly residue: string | null;
  /** When the slice was cut (the `cut-slice` envelope's `at`); `null` when no cut gave one. */
  readonly startedAt: string | null;
};

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

/** Who an attempt is — its entry, issue, number and call place; nothing in it changes. */
interface AttemptId {
  readonly ctx: EntryContext;
  readonly issue: number;
  readonly attempt: number;
  /** `<issue>-<attempt>`: the attempt's label detail and file-name stem. */
  readonly tag: string;
  readonly place: ToolPlace;
  /** The files the previous attempt's landing conflicted on; `[]` for none. */
  readonly previousConflicts: readonly string[];
}

/** A stage's answer: its output for the next stage, or the event that ends the attempt. */
type Step<T> = { readonly next: T } | { readonly stop: SchedulerEvent };

/** What a cut named, a failed cut's too: the slice to tear down, and when; `null`s for none. */
interface CutTrace {
  readonly slice: string | null;
  readonly startedAt: string | null;
}

/** No cut, or one that named nothing: nothing to tear down. */
const NO_CUT: CutTrace = { slice: null, startedAt: null };

/** A slice the cut made: its attempt, its worktree and the batch commit it was cut at. */
interface CutSlice extends CutTrace {
  readonly at: AttemptId;
  readonly slice: string;
  readonly base: string;
}

/** The re-check and cut's answer: the cut slice, or the stop and what the cut named. */
type Opened =
  | { readonly next: CutSlice }
  | { readonly stop: SchedulerEvent; readonly cut: CutTrace };

/** A provisioned slice: the project dir its server-tier runs lease against. */
interface ProvisionedSlice extends CutSlice {
  readonly projectDir: string;
}

/** A planned slice: the card it is built from (the applier's, when one ran). */
interface PlannedSlice extends ProvisionedSlice {
  readonly card: PlanCard;
}

/** A built slice: the tdd's answer; `sha` its commit. */
interface BuiltSlice extends PlannedSlice {
  readonly tdd: TddOutput;
  readonly sha: string;
}

/** A diff-reviewed slice: the diff reviewer's answer. */
interface DiffReviewedSlice extends BuiltSlice {
  readonly diffReview: DiffReviewOutput;
}

/** A reviewed slice: the reviewer's answer; `sha` its amend. */
interface ReviewedSlice extends DiffReviewedSlice {
  readonly review: ReviewOutput;
}

/** An authored slice: the test reviewer's answer, or why it was skipped; `sha` the last amend. */
interface AuthoredSlice extends ReviewedSlice {
  readonly testReview: TestReviewOutput | TestReviewSkip;
}

/**
 * Run attempt `attempt` (1 for the first) of an issue, up to its authored slice;
 * `previousConflicts` are the files the previous attempt's landing conflicted on, for the planner
 * to re-plan against. Resolves to the attempt's first note — for an authored slice, one carrying
 * the queued landing; never rejects.
 */
export async function runAttempt(
  ctx: EntryContext,
  issue: number,
  attempt: number,
  previousConflicts: readonly string[] = [],
): Promise<AttemptNote> {
  const at = attemptId(ctx, issue, attempt, previousConflicts);
  const opened = await openSlice(at).catch(
    (err: unknown): Opened => ({ stop: stageThrew(at, err), cut: NO_CUT }),
  );
  if ('stop' in opened) return endAttempt(at, opened.cut, notLanded(opened.stop));
  const cut = opened.next;
  const authored = await authorSlice(cut).catch((err: unknown) => ({ stop: stageThrew(at, err) }));
  if ('stop' in authored) return endAttempt(at, cut, notLanded(authored.stop));
  const slice = authored.next;
  const landing = ctx.queue
    .enqueue(() => landSlice(slice).catch((err: unknown) => notLanded(landThrew(at, err))))
    .then((outcome) => endAttempt(at, cut, outcome));
  return { kind: 'authored', issue, landing };
}

/** Who the attempt is, its tag `<issue>-<attempt>`. */
function attemptId(
  ctx: EntryContext,
  issue: number,
  attempt: number,
  previousConflicts: readonly string[],
): AttemptId {
  const tag = `${String(issue)}-${String(attempt)}`;
  return { ctx, issue, attempt, tag, place: runPlace(ctx.reportDir, tag), previousConflicts };
}

/** Re-check the issue, then cut its slice, each at a boundary that sees a halt. */
async function openSlice(at: AttemptId): Promise<Opened> {
  const ready = await atBoundary({ next: at }, at, recheckStage);
  if ('stop' in ready) return { stop: ready.stop, cut: NO_CUT };
  if (at.ctx.isHalting()) return { stop: haltedStop(at), cut: NO_CUT };
  return cutStage(at);
}

/** Run the provision through the test review, each stage at a boundary that sees a halt. */
async function authorSlice(cut: CutSlice): Promise<Step<AuthoredSlice>> {
  const { at } = cut;
  const provisioned = await atBoundary({ next: cut }, at, provisionStage);
  const planned = await atBoundary(provisioned, at, planStage);
  const approved = await atBoundary(planned, at, planReviewStage);
  const built = await atBoundary(approved, at, tddStage);
  const diffReviewed = await atBoundary(built, at, diffReviewStage);
  const reviewed = await atBoundary(diffReviewed, at, reviewStage);
  return atBoundary(reviewed, at, testReviewStage);
}

/** Pass a stop on; else stop for a halting entry; else run the next stage. */
async function atBoundary<I, O>(
  step: Step<I>,
  at: AttemptId,
  stage: (input: I) => Promise<Step<O>>,
): Promise<Step<O>> {
  if ('stop' in step) return step;
  if (at.ctx.isHalting()) return { stop: haltedStop(at) };
  return stage(step.next);
}

/** Re-check the issue is still open and labelled; `label-removed` when not. */
async function recheckStage(at: AttemptId): Promise<Step<AttemptId>> {
  const out = await runTool(at.ctx.hooks, 'check', [String(at.issue)], at.place);
  if (out === null) return { stop: died(at) };
  if (out.ready === true) return { next: at };
  if (out.ready === false) return { stop: { kind: 'label-removed', issue: at.issue } };
  return {
    stop: blocked(at, `check gave no verdict: ${out.stderrTail ?? `exit ${String(out.exitCode)}`}`),
  };
}

/**
 * Cut the attempt's slice from the batch head; a stop carries the slice a
 * failed cut named, for the teardown.
 */
async function cutStage(at: AttemptId): Promise<Opened> {
  const argv = [
    at.ctx.batch,
    '--issue',
    String(at.issue),
    '--attempt',
    String(at.attempt),
    ...attachedRunArgs(at.ctx),
  ];
  const out = await runTool(at.ctx.hooks, 'cut-slice', argv, at.place);
  if (out === null) return { stop: died(at), cut: NO_CUT };
  const cut: CutTrace = {
    slice: typeof out.slice === 'string' ? out.slice : null,
    startedAt: typeof out.at === 'string' ? out.at : null,
  };
  if (out.status !== 'ok' || cut.slice === null || typeof out.base !== 'string') {
    return { stop: blocked(at, envelopeProblem('cut-slice', out)), cut };
  }
  return { next: { at, slice: cut.slice, base: out.base, startedAt: cut.startedAt } };
}

/** The `cut-slice` words that name an attached run's slices: `--attached-run <R>`, or `[]`. */
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
  return { next: { ...planned, tdd, sha: tdd.sha } };
}

/**
 * Check the slice's commit, read-only, against the repo's rules and its
 * issue and plan; the findings go to {@link diffReviewPath} for the reviewer.
 * `agent-died` when the diff reviewer returns nothing.
 */
async function diffReviewStage(s: BuiltSlice): Promise<Step<DiffReviewedSlice>> {
  const { at } = s;
  const values = {
    ...sliceCommitValues(s),
    findingsPath: diffReviewPath(at),
    reportDir: at.ctx.reportDir,
  };
  const out = await AGENT_CALLS.diffReview(at.ctx.hooks, values, at.tag);
  if (out === null) return { stop: died(at) };
  return { next: { ...s, diffReview: out } };
}

/**
 * Review the slice — the diff review's findings verified, its own
 * correctness pass — amending its commit with any fix; its output's `sha` is the amend.
 */
async function reviewStage(s: DiffReviewedSlice): Promise<Step<ReviewedSlice>> {
  const { at } = s;
  const values = { ...sliceReviewValues(s, 'review'), findingsPath: diffReviewPath(at) };
  const review = await AGENT_CALLS.reviewer(at.ctx.hooks, values, at.tag);
  if (review === null) return { stop: died(at) };
  if (review.verdict === 'blocked') return { stop: blocked(at, `review: ${review.summary}`) };
  return { next: { ...s, review, sha: review.sha } };
}

/**
 * Harden the tests on the slice's final shape, unless {@link testReviewSkip} names a reason; `sha`
 * its amend.
 */
async function testReviewStage(s: ReviewedSlice): Promise<Step<AuthoredSlice>> {
  const { at } = s;
  const skip = await testReviewSkip(s);
  if (skip !== null) return { next: { ...s, testReview: skip } };
  const out = await AGENT_CALLS.testReview(
    at.ctx.hooks,
    sliceReviewValues(s, 'test-review'),
    at.tag,
  );
  if (out === null) return { stop: died(at) };
  if (out.verdict === 'blocked') return { stop: blocked(at, `test review: ${out.summary}`) };
  return { next: { ...s, testReview: out, sha: out.sha } };
}

/**
 * Why the test review is skipped, `null` when it runs: `'trivial surface'` when the tdd's files
 * change no code; else, none under `test/`, `'comment-only'` when `tooling/comment-only.ts` proves
 * `base..sha` comment-only, leaving no code path uncompared. A failed proof runs it.
 */
async function testReviewSkip(s: ReviewedSlice): Promise<TestReviewSkip | null> {
  if (isTrivialSurface(s.tdd.files)) return 'trivial surface';
  if (s.tdd.files.some((path) => path.startsWith('test/'))) return null;
  const { at } = s;
  const out = await runTool(at.ctx.hooks, 'comment-only', [`${s.base}..${s.sha}`], at.place);
  const proven =
    out !== null &&
    out.exitCode === 0 &&
    out.notCompared !== undefined &&
    isTrivialSurface(out.notCompared);
  return proven ? 'comment-only' : null;
}

/**
 * Land the authored slice on the batch — run inside the commit queue — its message file first
 * rewritten with the tdd's salvage.
 */
async function landSlice(s: AuthoredSlice): Promise<SliceOutcome> {
  const { at } = s;
  if (at.ctx.isHalting()) return notLanded(haltedStop(at));
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
  if (event.kind === 'committed' && typeof out?.commit === 'string') {
    const { card, tdd, diffReview, review, testReview } = s;
    return {
      kind: 'landed',
      work: { card, tdd, diffReview, review, testReview },
      commit: out.commit,
      committedAt: out.at ?? null,
      size:
        typeof out.lines === 'number' && out.files !== undefined
          ? { files: out.files.length, lines: out.lines }
          : null,
    };
  }
  const conflicts = event.kind === 'harvest-conflict' ? (out?.conflicts ?? []) : [];
  return { kind: 'unlanded', primary: event, conflicts };
}

/** The outcome of a slice that did not land, `primary` ending it. */
function notLanded(primary: SchedulerEvent): SliceOutcome {
  return { kind: 'unlanded', primary, conflicts: [] };
}

/** The `epic-halt` of a landing whose call threw: the batch state is unknown. */
function landThrew(at: AttemptId, err: unknown): SchedulerEvent {
  at.ctx.markHalting();
  return { kind: 'epic-halt', epic: at.ctx.epic, reason: `land threw: ${errorText(err)}` };
}

/**
 * End the attempt: tear down the slice the cut named, then report; never rejects. A teardown call
 * that rejects is read as the runner returning nothing — residue, not a halt.
 */
async function endAttempt(
  at: AttemptId,
  cut: CutTrace,
  outcome: SliceOutcome,
): Promise<AttemptNote> {
  const teardown =
    cut.slice === null
      ? null
      : await runTool(at.ctx.hooks, 'teardown', [cut.slice], at.place).catch(() => null);
  const teardownHalt = teardownEvent(teardown, at.ctx.epic);
  if (teardownHalt !== null) at.ctx.markHalting();
  const halt =
    outcome.kind === 'unlanded' && outcome.primary.kind === 'epic-halt'
      ? outcome.primary
      : teardownHalt;
  const ending: AttemptEnding = {
    ...outcome,
    halt,
    residue: cut.slice === null ? null : teardownResidue(teardown),
    startedAt: cut.startedAt,
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

/** The planner's prompt input; `findingsPath` is for `apply` mode only. */
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
 * Where the slice's server-tier runs lease from: the tdd, the planner, the reviewer and the test
 * reviewer are handed one recipe.
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
function sliceCommitValues(s: BuiltSlice): SliceCommitValues {
  return {
    issue: s.at.issue,
    slice: s.slice,
    base: s.base,
    planPath: planPath(s.at),
    sha: s.sha,
    files: s.tdd.files,
  };
}

/** The reviewer's or the test reviewer's prompt input, `report` its report's file-name prefix. */
function sliceReviewValues(s: BuiltSlice, report: string): SliceReviewValues {
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
function planPath(at: AttemptId): string {
  return `${at.ctx.reportDir}/plans/${String(at.issue)}.md`;
}

/**
 * The attempt's commit message file: the tdd writes it; the landing rewrites it, salvage added.
 *
 * @param at - The attempt.
 * @returns `<reportDir>/commit-<issue>-<attempt>.txt`.
 */
function messagePath(at: AttemptId): string {
  return `${at.ctx.reportDir}/commit-${at.tag}.txt`;
}

/** The attempt's diff-review findings file: the diff reviewer writes it, the reviewer reads it. */
function diffReviewPath(at: AttemptId): string {
  return `${at.ctx.reportDir}/diff-review-${at.tag}.md`;
}

/**
 * The event of an attempt stopped for its halting entry.
 *
 * @param at - The attempt.
 * @returns `epic-halt` for the entry.
 */
function haltedStop(at: AttemptId): SchedulerEvent {
  return { kind: 'epic-halt', epic: at.ctx.epic, reason: 'its epic halted' };
}

/**
 * The event of an agent that returned nothing.
 *
 * @param at - The attempt.
 * @returns `agent-died`.
 */
function died(at: AttemptId): SchedulerEvent {
  return { kind: 'agent-died', issue: at.issue };
}

/** The event of a stage that cannot let the issue proceed. */
function blocked(at: AttemptId, reason: string): SchedulerEvent {
  return { kind: 'blocked', issue: at.issue, reason };
}

/** The `blocked` event of a stage that threw, naming the throw. */
function stageThrew(at: AttemptId, err: unknown): SchedulerEvent {
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
