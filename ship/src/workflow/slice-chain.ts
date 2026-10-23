/**
 * One issue attempt of the `ship` workflow (Ship ADR-0001 decisions 7–8), in a slice worktree cut
 * from the epic's branch head, its stages ending in a landing through the epic's commit queue.
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
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import type { SchedulerEvent } from '../core/scheduler/run-scheduler.types.js';

import {
  AGENT_CALLS,
  type ScriptApiTsdocOutput,
  type ScriptApiTsdocSkip,
  type ReviewOutput,
  type SliceWork,
  type TddOutput,
  type TestReviewSkip,
} from './calls/agent-calls.js';
import {
  landingEvent,
  teardownEvent,
  teardownResidue,
  type CommitQueue,
  type EpicHaltEvent,
} from './commit-queue.js';
import type { WorkflowHooks } from './runtime.types.js';
import { commitMessage, commitMessageTemplate, type SliceSize } from './pr/pr-body.js';
import type { LeaseValues, SliceCommitValues, SliceReviewValues } from './calls/prompts.js';
import { anyUnder, isTrivialSurface } from './stages.js';
import {
  envelopeProblem,
  runPlace,
  runTool,
  type KeptWork,
  type ToolPlace,
} from './calls/tool-calls.js';

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
  /** An attached run's number and open PR; `null` for an unattached run. */
  readonly attached: AttachedRun | null;
}

/** An attached run, as `cut-batch --attach --attached-run` named it. */
export interface AttachedRun {
  /** Its number (`attach.run`), which names its slices. */
  readonly run: number;
  /** The open PR it lands on (`attach.pr`). */
  readonly pr: number;
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
    };

/** How an attempt ended, for the drive loop to settle: its slice's outcome, then its teardown's. */
export type AttemptEnding = SliceOutcome & {
  /** The halt it called for: an unlanded `epic-halt` primary, else its teardown's; or `null`. */
  readonly halt: EpicHaltEvent | null;
  /** What the teardown left behind; `null` when it was clean or had nothing to tear down. */
  readonly residue: string | null;
  /** What the teardown kept of an unlanded slice's work; `null` when it answered no `kept`. */
  readonly kept: KeptWork | null;
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
  /** The previous attempt's kept patch, handed to the tdd; `null` for none. */
  readonly previousPatch: string | null;
  /** `<issue>-<attempt>`: the attempt's label detail and file-name stem. */
  readonly tag: string;
  readonly place: ToolPlace;
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

/**
 * A slice the cut made: its attempt, its worktree, the batch commit it was cut at, and where its
 * work is kept should it not land.
 */
interface CutSlice extends CutTrace {
  readonly at: AttemptId;
  readonly slice: string;
  readonly base: string;
  readonly keptDir: string;
}

/** The re-check and cut's answer: the cut slice, or the stop and what the cut named. */
type Opened =
  | { readonly next: CutSlice }
  | { readonly stop: SchedulerEvent; readonly cut: CutTrace };

/** A provisioned slice: the project dir its server-tier runs lease against. */
interface ProvisionedSlice extends CutSlice {
  readonly projectDir: string;
}

/** A built slice: the tdd's answer; `sha` its commit. */
interface BuiltSlice extends ProvisionedSlice {
  readonly tdd: TddOutput;
  readonly sha: string;
  /**
   * The slice commit's changed paths: the tdd's, then each slice review amend's, re-read
   * ({@link afterAmend}). The Script API TSDoc review's amend is not re-read: no stage reads
   * them after it.
   */
  readonly files: readonly string[];
  /** The paths the slice review amends changed since the tdd's commit, re-read like `files`. */
  readonly amended: readonly string[];
}

/** A spec-reviewed slice: the spec review's answer; `sha` its amend. */
interface SpecReviewedSlice extends BuiltSlice {
  readonly specReview: ReviewOutput;
}

/** A test-reviewed slice: the test review's answer, or why it was skipped; `sha` its amend. */
interface TestReviewedSlice extends SpecReviewedSlice {
  readonly testReview: ReviewOutput | TestReviewSkip;
}

/** A reviewed slice: the standards review's answer too; `sha` its amend. */
interface ReviewedSlice extends TestReviewedSlice {
  readonly standardsReview: ReviewOutput;
}

/**
 * An authored slice, ready to land: the Script API TSDoc review's answer, or why it was skipped;
 * `sha` its last amend.
 */
interface AuthoredSlice extends ReviewedSlice {
  readonly scriptApiTsdoc: ScriptApiTsdocOutput | ScriptApiTsdocSkip;
}

/**
 * Run attempt `attempt` (1 for the first) of an issue, up to its authored slice, its tdd handed
 * `previousPatch` when not `null`. Resolves to the attempt's first note — for an authored slice,
 * one carrying the queued landing; never rejects.
 */
export async function runAttempt(
  ctx: EntryContext,
  issue: number,
  attempt: number,
  previousPatch: string | null,
): Promise<AttemptNote> {
  const at = attemptId(ctx, issue, attempt, previousPatch);
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
  previousPatch: string | null,
): AttemptId {
  const tag = `${String(issue)}-${String(attempt)}`;
  return { ctx, issue, attempt, previousPatch, tag, place: runPlace(ctx, tag) };
}

/** Re-check the issue, then cut its slice, each at a boundary that sees a halt. */
async function openSlice(at: AttemptId): Promise<Opened> {
  const ready = await atBoundary({ next: at }, at, recheckStage);
  if ('stop' in ready) return { stop: ready.stop, cut: NO_CUT };
  if (at.ctx.isHalting()) return { stop: haltedStop(at), cut: NO_CUT };
  return cutStage(at);
}

/** Run the provision through the Script API TSDoc review, each at a boundary that sees a halt. */
async function authorSlice(cut: CutSlice): Promise<Step<AuthoredSlice>> {
  const { at } = cut;
  const provisioned = await atBoundary({ next: cut }, at, provisionStage);
  const built = await atBoundary(provisioned, at, tddStage);
  const specReviewed = await atBoundary(built, at, specReviewStage);
  const testReviewed = await atBoundary(specReviewed, at, testReviewStage);
  const reviewed = await atBoundary(testReviewed, at, standardsReviewStage);
  return atBoundary(reviewed, at, scriptApiTsdocStage);
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
  const kept = keptDir(at.ctx.main, cut.slice, cut.startedAt);
  return {
    next: { at, slice: cut.slice, base: out.base, startedAt: cut.startedAt, keptDir: kept },
  };
}

/**
 * An unlanded slice's kept dir: `<main>/reports/kept/<slice dir name>-<startedAt made path-safe>`,
 * outside every run root `retire-run` removes; `startedAt` tells a re-run's same-named slice apart.
 */
function keptDir(main: string, slice: string, startedAt: string | null): string {
  const name = slice.slice(slice.lastIndexOf('/') + 1);
  const stamp = startedAt === null ? '' : `-${startedAt.replace(/[:.]/gu, '-')}`;
  return `${main}/reports/kept/${name}${stamp}`;
}

/** The `cut-slice` words that name an attached run's slices: `--attached-run <R>`, or `[]`. */
function attachedRunArgs(entry: Pick<EntrySetup, 'attached'>): string[] {
  return entry.attached === null ? [] : ['--attached-run', String(entry.attached.run)];
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

/** Author the slice's one commit; a tdd that committed goes on. */
async function tddStage(s: ProvisionedSlice): Promise<Step<BuiltSlice>> {
  const { at } = s;
  const values = {
    issue: at.issue,
    attempt: at.attempt,
    slice: s.slice,
    base: s.base,
    reportDir: at.ctx.reportDir,
    reportPath: tddReportPath(at),
    keptDir: s.keptDir,
    previousPatch: at.previousPatch,
    messagePath: messagePath(at),
    messageTemplate: commitMessageTemplate(at.issue),
    lease: leaseValues(s),
  };
  const tdd = await AGENT_CALLS.tdd(at.ctx.hooks, values, at.tag);
  if (tdd === null) return { stop: died(at) };
  if (tdd.verdict === 'BLOCKED' || tdd.sha === '') {
    return { stop: blocked(at, `tdd ${tdd.verdict}: ${tdd.reason ?? 'no commit'}`) };
  }
  return { next: { ...s, tdd, sha: tdd.sha, files: tdd.files, amended: [] } };
}

/** Hold the slice to its issue, amending its commit with any fix; `sha` its amend. */
async function specReviewStage(s: BuiltSlice): Promise<Step<SpecReviewedSlice>> {
  const { at } = s;
  const out = await AGENT_CALLS.specReview(
    at.ctx.hooks,
    sliceReviewValues(s, 'spec-review'),
    at.tag,
  );
  return afterAmend(s, 'spec review', out, (specReview) => ({ ...s, specReview }));
}

/**
 * Hold the slice's tests to the claims it makes, amending its commit with any test fix, unless
 * {@link testSkip} names a reason; `sha` its amend.
 */
async function testReviewStage(s: SpecReviewedSlice): Promise<Step<TestReviewedSlice>> {
  const { at } = s;
  const skip = await testSkip(s);
  if (skip !== null) return { next: { ...s, testReview: skip } };
  const out = await AGENT_CALLS.testReview(
    at.ctx.hooks,
    sliceReviewValues(s, 'test-review'),
    at.tag,
  );
  return afterAmend(s, 'test review', out, (testReview) => ({ ...s, testReview }));
}

const TEST_PREFIXES: readonly string[] = [
  'test/',
  'tooling/test/',
  'server-pool/test/',
  'ship/test/',
];

/**
 * Why a slice's tests go unreviewed, `null` when they are: `'trivial surface'` when its files
 * change no code; else, none under {@link TEST_PREFIXES}, `'comment-only'` when `comment-only.ts`
 * proves its commit comment-only, leaving no code path uncompared. A failed proof reviews them.
 */
async function testSkip(s: SpecReviewedSlice): Promise<TestReviewSkip | null> {
  const { files } = s;
  if (isTrivialSurface(files)) return 'trivial surface';
  if (anyUnder(files, TEST_PREFIXES)) return null;
  const range = `${s.base}..${s.sha}`;
  const out = await runTool(s.at.ctx.hooks, 'comment-only', [range], s.at.place);
  const proven =
    out !== null &&
    out.exitCode === 0 &&
    out.notCompared !== undefined &&
    isTrivialSurface(out.notCompared);
  return proven ? 'comment-only' : null;
}

/** Hold the slice to the repo's rules, amending its commit with any fix; `sha` its amend. */
async function standardsReviewStage(s: TestReviewedSlice): Promise<Step<ReviewedSlice>> {
  const { at } = s;
  const out = await AGENT_CALLS.standardsReview(
    at.ctx.hooks,
    sliceReviewValues(s, 'standards-review'),
    at.tag,
  );
  return afterAmend(s, 'standards review', out, (standardsReview) => ({
    ...s,
    standardsReview,
  }));
}

/**
 * Review the Script API TSDoc the slice reaches, amending its commit with any fix, when the slice
 * changes a path under `src/`; `sha` its amend.
 */
async function scriptApiTsdocStage(s: ReviewedSlice): Promise<Step<AuthoredSlice>> {
  const { at } = s;
  if (!s.files.some((path) => path.startsWith('src/'))) {
    return { next: { ...s, scriptApiTsdoc: 'no src/ change' } };
  }
  const values = {
    ...sliceCommitValues(s),
    reportPath: `${at.ctx.reportDir}/script-api-tsdoc-${at.tag}.md`,
  };
  const out = await AGENT_CALLS.scriptApiTsdoc(at.ctx.hooks, values, at.tag);
  return afterReview(at, 'script api tsdoc', out, (scriptApiTsdoc) => ({ ...s, scriptApiTsdoc }));
}

/**
 * Carry an amending stage's answer on: none stops the slice as died, a `blocked` one or one naming
 * no commit stops it with `label`, else `next` folds it in and `sha` becomes its amend.
 */
function afterReview<
  O extends { readonly verdict: string; readonly sha: string; readonly summary: string },
  T,
>(
  at: AttemptId,
  label: string,
  out: O | null,
  next: (out: O) => T,
): Step<T & { readonly sha: string }> {
  if (out === null) return { stop: died(at) };
  if (out.verdict === 'blocked') return { stop: blocked(at, `${label}: ${out.summary}`) };
  if (out.sha === '') return { stop: blocked(at, `${label}: no commit`) };
  return { next: { ...next(out), sha: out.sha } };
}

/**
 * {@link afterReview}, then for a `fixed` answer its `files` and `amended`, re-read from git. A
 * runner that returns nothing stops the slice as died; a failed re-read stops it blocked, naming
 * the read, never keeping the stale list.
 */
async function afterAmend<T extends BuiltSlice>(
  s: BuiltSlice,
  label: string,
  out: ReviewOutput | null,
  next: (out: ReviewOutput) => T,
): Promise<Step<T>> {
  const step = afterReview(s.at, label, out, next);
  if ('stop' in step || out?.verdict !== 'fixed') return step;
  const [files, amended] = await Promise.all([
    reread(s, label, step.next.sha, s.base),
    reread(s, label, step.next.sha, s.tdd.sha),
  ]);
  if ('stop' in files) return files;
  if ('stop' in amended) return amended;
  return { next: { ...step.next, files: files.next, amended: amended.next } };
}

/** The paths `base..sha` changes in the slice, per {@link afterAmend}. */
async function reread(
  s: BuiltSlice,
  label: string,
  sha: string,
  base: string,
): Promise<Step<readonly string[]>> {
  const { at } = s;
  const read = await runTool(
    at.ctx.hooks,
    'changed-files',
    [s.slice, sha, '--base', base],
    at.place,
  );
  if (read === null) return { stop: died(at) };
  if (read.status !== 'ok' || read.files === undefined) {
    return { stop: blocked(at, `${label}: ${envelopeProblem('changed-files', read)}`) };
  }
  return { next: read.files };
}

/**
 * Land the authored slice on the batch — run inside the commit queue — its message file first
 * rewritten per {@link commitMessage} from the tdd's commit line and cite.
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
  const message = commitMessage(at.issue, s.tdd);
  const place = runPlace(at.ctx, at.tag, { path: messagePath(at), content: message });
  const out = await runTool(at.ctx.hooks, 'land', argv, place);
  const event = landingEvent(out, { issue: at.issue, epic: at.ctx.epic });
  if (event.kind === 'epic-halt') at.ctx.markHalting();
  if (event.kind === 'committed' && typeof out?.commit === 'string') {
    const { tdd, specReview, testReview, standardsReview, scriptApiTsdoc } = s;
    return {
      kind: 'landed',
      work: { tdd, specReview, testReview, standardsReview, scriptApiTsdoc },
      commit: out.commit,
      committedAt: out.at ?? null,
      size:
        typeof out.lines === 'number' && out.files !== undefined
          ? { files: out.files.length, lines: out.lines }
          : null,
    };
  }
  return notLanded(event);
}

/** The outcome of a slice that did not land, `primary` ending it. */
function notLanded(primary: SchedulerEvent): SliceOutcome {
  return { kind: 'unlanded', primary };
}

/** The `epic-halt` of a landing whose call threw: the batch state is unknown. */
function landThrew(at: AttemptId, err: unknown): SchedulerEvent {
  at.ctx.markHalting();
  return { kind: 'epic-halt', epic: at.ctx.epic, reason: `land threw: ${errorText(err)}` };
}

/**
 * End the attempt: tear down the slice the cut named — an unlanded slice the cut made keeping its
 * work in its kept dir — then report; never rejects. A teardown call that rejects is read as the
 * runner returning nothing — residue, not a halt.
 */
async function endAttempt(
  at: AttemptId,
  cut: CutTrace | CutSlice,
  outcome: SliceOutcome,
): Promise<AttemptNote> {
  const keep =
    outcome.kind === 'unlanded' && 'keptDir' in cut
      ? ['--keep-to', cut.keptDir, '--base', cut.base, '--report', tddReportPath(at)]
      : [];
  const teardown =
    cut.slice === null
      ? null
      : await runTool(at.ctx.hooks, 'teardown', [cut.slice, ...keep], at.place).catch(() => null);
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
    kept: teardown?.kept ?? null,
    startedAt: cut.startedAt,
  };
  return { kind: 'ended', issue: at.issue, ending };
}

/**
 * Where the slice's server-tier runs lease from: the tdd and the slice reviews are handed one
 * recipe.
 */
function leaseValues(s: ProvisionedSlice): LeaseValues {
  return { main: s.at.ctx.main, projectDir: s.projectDir, registry: s.at.ctx.registry };
}

/**
 * The slice's one commit as the stages after the tdd are handed it.
 *
 * @returns The issue, the slice, its base, the report dir, the current
 *   commit and its changed paths.
 */
function sliceCommitValues(s: BuiltSlice): SliceCommitValues {
  return {
    issue: s.at.issue,
    slice: s.slice,
    base: s.base,
    reportDir: s.at.ctx.reportDir,
    sha: s.sha,
    files: s.files,
  };
}

/** A slice review's prompt input, `report` its report's file-name prefix. */
function sliceReviewValues(s: BuiltSlice, report: string): SliceReviewValues {
  return {
    ...sliceCommitValues(s),
    reportPath: `${s.at.ctx.reportDir}/${report}-${s.at.tag}.md`,
    passed: {
      sha: s.tdd.sha,
      tests: s.tdd.greenTests,
      evidence: s.tdd.evidence,
      amended: s.amended,
    },
    lease: leaseValues(s),
  };
}

/** The attempt's tdd report: `<reportDir>/tdd-<issue>-<attempt>.md`. */
function tddReportPath(at: AttemptId): string {
  return `${at.ctx.reportDir}/tdd-${at.tag}.md`;
}

/**
 * The attempt's commit message file: the tdd fills it from its template; the landing rewrites it.
 *
 * @param at - The attempt.
 * @returns `<reportDir>/commit-<issue>-<attempt>.txt`.
 */
function messagePath(at: AttemptId): string {
  return `${at.ctx.reportDir}/commit-${at.tag}.txt`;
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
