/**
 * The `ship` workflow's epic end (ADR-0045 decision 6). For an entry whose issues all settled with
 * at least one landed ({@link epicEnd}): the epic review, the master sync, the bump, the pushed
 * paths, the retro and PR writer concurrently, then the publish task; one that halted or landed
 * nothing gets its unshipped end ({@link unshippedEpicEnd}). A stop after the retro re-runs it.
 *
 * No server-tier step: pre-push runs it on a Platform-wide change; red refuses the push (ADR-0051).
 * A code conflict, a failed sync, a failed bump or a throwing step stops the epic; a bump finding
 * the version already at its target commits nothing, and the end goes on.
 *
 * The master sync and the publish task each run as one task of the run's repo lock
 * ({@link EpicEndInput.repoLock}), so no two epic ends talk to `origin` or read the main checkout
 * at once; the epic review, the bump, the retro and the PR writer run outside it.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import { aggregateLeaseTimings, type LeaseAggregate } from '../../lib/lease-timings.js';
import type { PushedChanges } from '../../lib/push-scope.js';

import { AGENT_CALLS, type PrWriterOutput, type RetroFinding } from './agent-calls.js';
import type { CommitQueue } from './commit-queue.js';
import type { WorkflowHooks } from './hooks.types.js';
import { checkMasterStep, type MasterCheck, type PassedMasterCheck } from './master-check.js';
import {
  fitPrBody,
  prTitle,
  renderAttachedReport,
  renderAttachedSection,
  renderBlockedComment,
  sliceLeaseLines,
  type EpicReviewReport,
  type LandedIssue,
  type PrBodyInput,
  type ScheduleEntry,
} from './pr-body.js';
import type { MainSnapshot, OverlapRecord } from './preflight.js';
import type { FileToWrite } from './prompts.js';
import type { AttachedRun, EntrySetup } from './slice-chain.js';
import { syncMasterStep, type SyncStepResult } from './sync-master-step.js';
import {
  envelopeProblem,
  PR_PLACEHOLDER,
  preCutPlace,
  runPlace,
  runTool,
  toolCommandLine,
  type BumpOutput,
  type KeptWork,
  type PublishOutput,
  type ToolOutputs,
} from './tool-calls.js';

/** How an issue ended. */
export type IssueOutcome =
  | 'landed'
  | 'landed-then-halted'
  | 'blocked'
  | 'skipped'
  | 'removed'
  | 'halted';

/** One issue's line of the run report. */
export interface IssueReport {
  /** The issue. */
  readonly issue: number;
  /** How it ended; `landed-then-halted`: its commit landed, then its epic halted. */
  readonly outcome: IssueOutcome;
  /** How the PR cites it: `fixes` only for a landed issue whose tdd says so. */
  readonly cite: 'fixes' | 'see';
  /** Its batch commit, when it landed. */
  readonly commit?: string;
  /** Why, when it did not land. */
  readonly reason?: string;
  /** Where its unlanded attempt's work was kept, when its teardown answered a `kept`. */
  readonly kept?: KeptWork;
}

/** One issue the run blocked, and whether its reason reached the issue as a comment. */
interface IssueComment {
  /** The issue. */
  readonly issue: number;
  /** The posted comment's URL; `null` when the post failed. */
  readonly url: string | null;
  /**
   * Why the post failed — the `post-issue-comment` envelope's problem, or the
   * call's throw; absent when it posted.
   */
  readonly problem?: string;
}

/** One entry's result. */
export interface EpicReport {
  /** The entry's epic, or `null` for an explicit list. */
  readonly epic: number | null;
  /** The entry's feature branch; empty when it was never cut. */
  readonly branch: string;
  /**
   * `pr`: opened; `halted`: a landing or a slice teardown left the batch
   * unverified; `nothing-landed`: no issue landed, so no epic end but the
   * retro and, unattached, its own cleanup; `stopped`: its cut or its epic
   * end failed ({@link EpicReport.message}).
   */
  readonly outcome: 'pr' | 'halted' | 'nothing-landed' | 'stopped';
  /** The pull request opened. */
  readonly pr?: number;
  /** Each issue's outcome, in the entry's order. */
  readonly issues: readonly IssueReport[];
  /** Each issue's schedule, in the entry's order. */
  readonly schedule: readonly ScheduleEntry[];
  /** What stopped or halted the entry, when its epic end says. */
  readonly message?: string;
  /**
   * After a failed publish only: the commands that finish the epic end by hand, in order, run
   * from the main checkout; each file they name is in the report directory. A
   * {@link PR_PLACEHOLDER} stands for the number of the PR the first one opens.
   */
  readonly recovery?: readonly string[];
  /**
   * Why an attached run's section was not appended to its PR's body — the
   * `append-pr-body` problem, or the call's throw — while the push stood;
   * absent when it was appended or no edit was due.
   */
  readonly prBodyEdit?: string;
  /**
   * Why a run-report comment — an attached run's report, or a PR body's
   * moved sections — was not posted to its PR: the `post-pr-comment`
   * problem, or the call's throw, one per failed post, `; `-joined, while the
   * push stood; absent when every post was made or none was due.
   */
  readonly prReportComment?: string;
  /**
   * Whether the main checkout's `HEAD` and dirtiness equal pre-flight's,
   * read before the push on the shipping path, after the epic end
   * otherwise; `null` when either read failed. Absent without an epic end.
   */
  readonly mainUntouched?: boolean | null;
  /**
   * The forward-only check of `master`, taken in the publish task before the
   * push; absent when the epic end stopped before it or the check threw.
   */
  readonly masterCheck?: MasterCheck;
  /**
   * What each slice teardown, and a nothing-landed run's batch teardown or
   * retire-run, left behind, one line each.
   */
  readonly residue: readonly string[];
  /** The epic review's part; absent without an epic end. */
  readonly epicReview?: EpicReviewReport;
  /** The retro's findings, `null` when it returned none; absent for an entry never cut. */
  readonly retro?: readonly RetroFinding[] | null;
  /** The entry's lease totals; absent without an epic end. */
  readonly leases?: LeaseAggregate;
  /**
   * One record per issue the run blocked, in the entry's order: its
   * reason's comment, posted or not ({@link commentBlockedStep}); absent
   * when no issue was blocked.
   */
  readonly issueComments?: readonly IssueComment[];
}

/** An epic end's inputs. */
export interface EpicEndInput {
  /** The workflow hooks. */
  readonly hooks: WorkflowHooks;
  /** The entry. */
  readonly entry: EntrySetup;
  /** Its landed issues, in landing order. */
  readonly landed: readonly LandedIssue[];
  /** Every issue's outcome so far. */
  readonly issues: readonly IssueReport[];
  /** Every issue's schedule. */
  readonly schedule: readonly ScheduleEntry[];
  /** The teardown residue so far. */
  readonly residue: readonly string[];
  /** The main checkout as pre-flight found it. */
  readonly launch: MainSnapshot | null;
  /** The run's repo lock, shared by every entry's epic end. */
  readonly repoLock: CommitQueue;
  /** The overlap edges pre-flight added to this entry. */
  readonly overlap: OverlapRecord;
}

/** What an epic end learnt, step by step. */
interface EndState {
  epicReview?: EpicReviewReport;
  leases?: LeaseAggregate;
  retro?: readonly RetroFinding[] | null;
  /** The PR writer's answer, once it ran; `null` when it returned none or threw. */
  writer?: PrWriterOutput | null;
  /** The main-checkout comparison, once the publish task read it. */
  mainUntouched?: boolean | null;
  /** The master check, once the publish task took it. */
  masterCheck?: MasterCheck;
}

/** The epic end's outcome before the main-checkout look. */
type Published = Pick<
  EpicReport,
  'outcome' | 'pr' | 'message' | 'recovery' | 'prBodyEdit' | 'prReportComment'
>;

/**
 * Run the epic end.
 *
 * @returns Resolves to the entry's report; a step that throws stops the
 *   epic (`the epic end threw: …`), the retro still run over the stopped report.
 */
export async function epicEnd(input: EpicEndInput): Promise<EpicReport> {
  const state: EndState = {};
  const published = await shipSteps(input, state).catch(
    (err: unknown): Published => ({
      outcome: 'stopped',
      message: `the epic end threw: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  const issueComments = await commentBlockedStep(input, published.pr);
  const retro =
    published.outcome === 'pr' && state.retro !== undefined
      ? state.retro
      : await retroStep(input, retroReport(input, published, issueComments));
  return {
    epic: input.entry.epic,
    branch: input.entry.branch,
    ...published,
    issues: input.issues,
    schedule: input.schedule,
    mainUntouched: await mainAtEnd(input, state),
    ...(state.masterCheck === undefined ? {} : { masterCheck: state.masterCheck }),
    residue: input.residue,
    ...(state.epicReview === undefined ? {} : { epicReview: state.epicReview }),
    retro,
    ...(state.leases === undefined ? {} : { leases: state.leases }),
    ...(issueComments.length === 0 ? {} : { issueComments }),
  };
}

/**
 * The epic end of an entry that halted or landed nothing: the blocked-issue comments and the retro;
 * then, for an unattached run that landed nothing only, tear its batch down and, after an `ok`
 * teardown, retire it (`retire-run`: run branch, slice branches and report dir). `halted`
 * cleans up nothing — its batch is unverified — and an attached run's batch and branch are the open
 * PR's.
 *
 * @returns Resolves to the entry's report; a non-`ok` teardown or retire-run is one `residue` line,
 *   never a rejection.
 */
export async function unshippedEpicEnd(
  input: Pick<EpicEndInput, 'hooks' | 'entry' | 'issues' | 'schedule' | 'residue'>,
  outcome: 'halted' | 'nothing-landed',
): Promise<EpicReport> {
  const issueComments = await commentBlockedStep(input, undefined);
  const report: EpicReport = {
    epic: input.entry.epic,
    branch: input.entry.branch,
    outcome,
    issues: input.issues,
    schedule: input.schedule,
    residue: input.residue,
    ...(issueComments.length === 0 ? {} : { issueComments }),
  };
  const retro = await retroStep(input, report);
  if (outcome === 'halted' || input.entry.attached !== null) return { ...report, retro };
  return { ...report, residue: [...input.residue, ...(await retireStep(input))], retro };
}

/**
 * Tear an unshipped entry's batch down, then retire its run: the residue lines, `[]` when both were
 * `ok`. Never rejects: a throw is the runner returning nothing. retire-run's envelope goes under
 * `PRE_CUT`, since it removes the run's report dir.
 */
async function retireStep(input: Pick<EpicEndInput, 'hooks' | 'entry'>): Promise<string[]> {
  const { hooks, entry } = input;
  const down = await runTool(hooks, 'teardown', [entry.batch], runPlace(entry, entry.tag)).catch(
    () => null,
  );
  if (down?.status !== 'ok') return [`${entry.batch}: ${envelopeProblem('teardown', down)}`];
  const out = await runTool(
    hooks,
    'retire-run',
    ['.', '--branch', entry.branch],
    preCutPlace(entry.tag),
  ).catch(() => null);
  return out?.status === 'ok' ? [] : [`${entry.branch}: ${envelopeProblem('retire-run', out)}`];
}

/**
 * Tell each issue the run blocked why, one comment each ({@link renderBlockedComment}), changing no
 * label: one record per `blocked` issue, its `url` or `url: null` with the `problem`. Never
 * rejects, so a failed post never fails the run.
 */
async function commentBlockedStep(
  input: Pick<EpicEndInput, 'hooks' | 'entry' | 'issues'>,
  pr: number | undefined,
): Promise<IssueComment[]> {
  const { entry } = input;
  const comments: IssueComment[] = [];
  for (const issue of input.issues) {
    if (issue.outcome !== 'blocked') continue;
    const path = `${entry.reportDir}/issue-comment-${String(issue.issue)}.md`;
    const content = renderBlockedComment({
      ...issue,
      ...(pr === undefined ? {} : { pr }),
      branch: entry.branch,
      reportDir: entry.reportDir,
    });
    const argv = [entry.main, '--issue', String(issue.issue), '--comment-file', path];
    const place = runPlace(entry, String(issue.issue), { path, content });
    comments.push(await postIssueComment(input.hooks, issue.issue, argv, place));
  }
  return comments;
}

/** One `post-issue-comment` call, its outcome as the report records it; never rejects. */
async function postIssueComment(
  hooks: WorkflowHooks,
  issue: number,
  argv: readonly string[],
  place: ReturnType<typeof runPlace>,
): Promise<IssueComment> {
  try {
    const out = await runTool(hooks, 'post-issue-comment', argv, place);
    if (out?.status !== 'ok') {
      return { issue, url: null, problem: envelopeProblem('post-issue-comment', out) };
    }
    return typeof out.url === 'string'
      ? { issue, url: out.url }
      : { issue, url: null, problem: 'post-issue-comment ok without a url' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { issue, url: null, problem: `post-issue-comment threw: ${message}` };
  }
}

/**
 * The shipping path up to the pull request — epic review, sync, bump, the pushed-paths read, the
 * retro and (unattached runs only) the PR writer concurrently, then the publish task — filling in
 * `state` as steps report.
 */
async function shipSteps(input: EpicEndInput, state: EndState): Promise<Published> {
  const { hooks, entry } = input;
  state.leases = leaseTotals(input.landed);
  state.epicReview = await epicReviewStep(input);
  const sync = await input.repoLock.enqueue(() => syncMasterStep(hooks, entry));
  if (sync.verdict === 'code-conflict' || sync.verdict === 'failed') {
    return { outcome: 'stopped', message: `master sync ${sync.verdict}: ${sync.message}` };
  }
  const bump = await runTool(hooks, 'bump', [entry.batch], runPlace(entry, entry.tag));
  if (bump?.status !== 'ok') return { outcome: 'stopped', message: envelopeProblem('bump', bump) };
  // Never rejects, so it can run beside the `parallel` below.
  const read = pushedPathsStep(input, sync.upstream);
  // No thunk rejects (each step catches), so `parallel`'s `null` for a throw (`hooks.types.ts`)
  // is never read. An attached run runs no PR writer: its section is appended after the push
  // (`pushOntoPr`).
  await hooks.parallel([
    async () => {
      state.retro = await retroStep(input, retroReport(input, { outcome: 'pr' }));
    },
    async () => {
      if (entry.attached === null) state.writer = await prWriterStep(input, sync.upstream);
    },
  ]);
  return publishStep(input, { sync, bump, pushed: await read, state });
}

/**
 * The paths the push will change, read from the batch's `HEAD` after the bump, from the base
 * pre-push diffs it from: the synced `origin/master`, the merge base of a new branch; for an
 * attached run, the batch's cut, the open PR's tip. Never rejects: a failure is `unresolved`.
 */
async function pushedPathsStep(
  input: EpicEndInput,
  upstream: string | null,
): Promise<PushedChanges> {
  const { hooks, entry } = input;
  const base = entry.attached === null ? (upstream ?? entry.base) : entry.base;
  const argv = [entry.batch, 'HEAD', '--base', base];
  try {
    const read = await runTool(hooks, 'changed-files', argv, runPlace(entry, entry.tag));
    if (read?.status === 'ok' && read.files !== undefined) {
      return { kind: 'resolved', paths: read.files };
    }
    return { kind: 'unresolved', why: envelopeProblem('changed-files', read) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'unresolved', why: `changed-files threw: ${message}` };
  }
}

/** What the pull request body reports besides the entry's inputs. */
interface EndFindings {
  readonly sync: SyncStepResult;
  readonly bump: BumpOutput;
  readonly pushed: PushedChanges;
  readonly state: EndState;
}

/**
 * The publish task, one repo-lock task: read the main checkout, check `master`, then, only when
 * the check passed, push and open the PR — or push onto an attached run's open PR
 * ({@link pushOntoPr}).
 */
async function publishStep(input: EpicEndInput, found: EndFindings): Promise<Published> {
  return input.repoLock.enqueue(async (): Promise<Published> => {
    const untouched = await mainUntouched(input);
    found.state.mainUntouched = untouched;
    const check = await checkMasterStep(
      input.hooks,
      input.entry,
      input.launch,
      found.sync.upstream,
    );
    found.state.masterCheck = check;
    if (!check.passed)
      return { outcome: 'stopped', message: `master check failed: ${check.failure}` };
    const checked = { masterCheck: check, mainUntouched: untouched };
    if (input.entry.attached !== null) {
      return pushOntoPr(input, found, checked, input.entry.attached);
    }
    return openPr(input, found, checked);
  });
}

/** The passed master check and the main-checkout comparison, both for a body. */
interface Checked {
  readonly masterCheck: PassedMasterCheck;
  readonly mainUntouched: boolean | null;
}

/** An attached run's report comment file, and the flag that hands it to `post-pr-comment`. */
const REPORT_COMMENT = { name: 'pr-report-comment.md', flag: '--comment-file' } as const;

/** An attached run's PR-body section file, and the flag that hands it to `append-pr-body`. */
const PR_SECTION = { name: 'pr-section.md', flag: '--section-file' } as const;

/**
 * Push an attached run's branch onto its open PR, then post its report and append its section: a
 * failed post or edit keeps the outcome `pr`, named in `prReportComment` / `prBodyEdit`; a failed
 * push, a PR no longer open included, stops the epic with nothing posted.
 */
async function pushOntoPr(
  input: EpicEndInput,
  found: EndFindings,
  checked: Checked,
  attached: AttachedRun,
): Promise<Published> {
  const { hooks, entry } = input;
  const base = { ...bodyInput(input, found, checked), run: attached.run };
  const report = renderAttachedReport(base);
  const files = [
    { ...REPORT_COMMENT, tool: 'post-pr-comment', content: report },
    {
      ...PR_SECTION,
      tool: 'append-pr-body',
      content: renderAttachedSection({ ...base, reportComment: null }),
    },
  ] as const;
  const argv = [entry.batch, '--push-only', '--log', `${entry.reportDir}/publish.log`];
  const place = runPlace(entry, entry.tag, ...files.map((f) => reportFile(entry, f)));
  const recovery = [
    toolCommandLine('publish', argv),
    ...files.map((f) => toolCommandLine(f.tool, prFileArgv(entry, String(attached.pr), f))),
  ];
  const published = publishedPr(await runTool(hooks, 'publish', argv, place), recovery);
  if (published.outcome !== 'pr' || published.pr === undefined) return published;
  const posted = await postReportStep(input, published.pr, report);
  const reportComment = 'url' in posted ? posted.url : null;
  const section = renderAttachedSection({ ...base, reportComment });
  const failure = await appendSectionStep(input, published.pr, section);
  return {
    ...published,
    ...('failure' in posted ? { prReportComment: posted.failure } : {}),
    ...(failure === null ? {} : { prBodyEdit: failure }),
  };
}

/**
 * Post an attached run's report as one comment on its open PR: the comment's `url`, or the
 * `failure`. Never rejects, so a failed post never fails the run.
 */
async function postReportStep(
  input: EpicEndInput,
  pr: number,
  report: string,
): Promise<{ readonly url: string } | { readonly failure: string }> {
  const file = { ...REPORT_COMMENT, content: report };
  const posted = await prFileStep(input, 'post-pr-comment', pr, file);
  if ('failure' in posted) return posted;
  return typeof posted.ok.url === 'string'
    ? { url: posted.ok.url }
    : { failure: 'post-pr-comment ok without a url' };
}

/**
 * Append an attached run's section to its open PR's body: `null`, or the problem. Never rejects,
 * so a failed edit never fails the run.
 */
async function appendSectionStep(
  input: EpicEndInput,
  pr: number,
  section: string,
): Promise<string | null> {
  const file = { ...PR_SECTION, content: section };
  const edited = await prFileStep(input, 'append-pr-body', pr, file);
  return 'failure' in edited ? edited.failure : null;
}

/** A file one of the open PR's file-fed tools reads: its name in the report dir, flag and text. */
interface PrFile {
  readonly name: string;
  readonly flag: string;
  readonly content: string;
}

/** A {@link PrFile} as the runner writes it: `<reportDir>/<name>`. */
function reportFile(entry: Pick<EntrySetup, 'reportDir'>, file: PrFile): FileToWrite {
  return { path: `${entry.reportDir}/${file.name}`, content: file.content };
}

/** The words of a PR file tool's call on the batch; `pr` may be {@link PR_PLACEHOLDER}. */
function prFileArgv(
  entry: Pick<EntrySetup, 'batch' | 'reportDir'>,
  pr: string,
  file: PrFile,
): string[] {
  return [entry.batch, '--pr', pr, file.flag, `${entry.reportDir}/${file.name}`];
}

/**
 * Run one of the open PR's file-fed tools on the batch, the file written first to
 * `<reportDir>/<name>`: the `ok` output, or the `failure`. Never rejects.
 */
async function prFileStep<N extends 'append-pr-body' | 'post-pr-comment'>(
  input: EpicEndInput,
  tool: N,
  pr: number,
  file: PrFile,
): Promise<{ readonly ok: ToolOutputs[N] } | { readonly failure: string }> {
  const { hooks, entry } = input;
  const argv = prFileArgv(entry, String(pr), file);
  const place = runPlace(entry, entry.tag, reportFile(entry, file));
  try {
    const out = await runTool(hooks, tool, argv, place);
    return out?.status === 'ok' ? { ok: out } : { failure: envelopeProblem(tool, out) };
  } catch (err) {
    return { failure: `${tool} threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A publish call's outcome: `pr`, or `stopped` with the `recovery` that finishes by hand. */
function publishedPr(out: PublishOutput | null, recovery: readonly string[]): Published {
  const pr = out?.status === 'ok' ? out.pr : null;
  if (pr === undefined || pr === null) {
    return { outcome: 'stopped', message: envelopeProblem('publish', out), recovery };
  }
  return { outcome: 'pr', pr: pr.number };
}

/**
 * Push, open the PR with {@link fitPrBody}'s body, then post each moved section as a PR comment (a
 * failed post goes in `prReportComment`, never a stop). Runs inside the publish task, so it calls
 * the runner directly: a nested `enqueue` on the same lock would wait for its own task.
 */
async function openPr(
  input: EpicEndInput,
  found: EndFindings,
  checked: Checked,
): Promise<Published> {
  const { hooks, entry } = input;
  const fitted = fitPrBody({
    ...bodyInput(input, found, checked),
    writer: found.state.writer ?? null,
  });
  const bodyPath = `${entry.reportDir}/pr-body.md`;
  const argv = [
    entry.batch,
    '--title',
    prTitle({ branch: entry.branch, landed: input.landed }),
    '--body-file',
    bodyPath,
    '--log',
    `${entry.reportDir}/publish.log`,
    ...(draft(found.state.epicReview) ? ['--draft'] : []),
  ];
  const moved = fitted.comments.map((m) => ({
    name: m.file,
    flag: '--comment-file',
    content: m.text,
  }));
  const place = runPlace(
    entry,
    entry.tag,
    { path: bodyPath, content: fitted.body },
    ...moved.map((file) => reportFile(entry, file)),
  );
  const recovery = [
    toolCommandLine('publish', argv),
    ...moved.map((file) =>
      toolCommandLine('post-pr-comment', prFileArgv(entry, PR_PLACEHOLDER, file)),
    ),
  ];
  const published = publishedPr(await runTool(hooks, 'publish', argv, place), recovery);
  if (published.outcome !== 'pr' || published.pr === undefined) return published;
  const failures: string[] = [];
  for (const file of moved) {
    const posted = await prFileStep(input, 'post-pr-comment', published.pr, file);
    if ('failure' in posted) failures.push(posted.failure);
  }
  return failures.length === 0 ? published : { ...published, prReportComment: failures.join('; ') };
}

/** Whether the PR opens as a draft: the epic review rejected the change, or judged nothing. */
function draft(review: EpicReviewReport | undefined): boolean {
  return review?.verdict === 'rejected' || review?.verdict === null;
}

/** What a PR body and an attached run's section report, but the PR writer's answer. */
function bodyInput(
  input: EpicEndInput,
  found: EndFindings,
  checked: Checked,
): Omit<PrBodyInput, 'writer'> {
  const { entry } = input;
  return {
    epic: entry.epic,
    branch: entry.branch,
    reportDir: entry.reportDir,
    landed: input.landed,
    unlanded: input.issues.filter((i) => i.outcome !== 'landed'),
    sync: found.sync,
    bump: found.bump,
    pushed: found.pushed,
    masterCheck: checked.masterCheck,
    mainUntouched: checked.mainUntouched,
    epicReview: found.state.epicReview ?? {
      verdict: null,
      profiled: input.entry.epic === null,
      notRun: 'no epic review step',
      answer: null,
    },
    overlap: input.overlap,
    schedule: input.schedule,
    leases: leaseTotals(input.landed),
    retro: found.state.retro ?? null,
  };
}

/**
 * The entry's lease totals: every landed slice's release lines, the tdd's and the
 * reviews' alike ({@link sliceLeaseLines}), each counted in its engine's and its
 * issue's totals with no role breakdown.
 */
function leaseTotals(landed: readonly LandedIssue[]): LeaseAggregate {
  return aggregateLeaseTimings(
    landed.flatMap((l) =>
      sliceLeaseLines(l).flatMap((r) => r.lines.map((line) => ({ issue: l.issue, line }))),
    ),
  );
}

/**
 * Judge the landed change as one, once the last slice has landed; never rejects. Profiled for an
 * entry with no epic. An issue that did not land forces `rejected`, whatever the review answered.
 */
async function epicReviewStep(input: EpicEndInput): Promise<EpicReviewReport> {
  const { entry } = input;
  const unlanded = input.issues.filter((i) => i.outcome !== 'landed');
  const values = {
    batch: entry.batch,
    range: `${entry.base}..HEAD`,
    epic: entry.epic,
    issues: input.landed.map((l) => l.issue),
    unlanded: unlanded.map((i) => ({
      issue: i.issue,
      outcome: i.outcome,
      ...(i.reason === undefined ? {} : { reason: i.reason }),
    })),
    sliceReports: input.landed.flatMap((l) => sliceReports(input, l)),
    reportDir: entry.reportDir,
    reportPath: `${entry.reportDir}/epic-review.md`,
  };
  const answer = await AGENT_CALLS.epicReview(input.hooks, values, entry.tag).catch(() => null);
  const forced =
    unlanded.length === 0
      ? {}
      : { forced: `did not land: ${unlanded.map((i) => `#${String(i.issue)}`).join(', ')}` };
  return {
    verdict: unlanded.length > 0 ? 'rejected' : (answer?.verdict ?? null),
    profiled: entry.epic === null,
    ...forced,
    ...(answer === null ? { notRun: 'the epic review returned nothing' } : {}),
    answer,
  };
}

/**
 * A landed issue's slice review reports, its final attempt's: the spec review's, the test review's
 * when it ran, the standards review's, and the Manifest TSDoc review's when it ran.
 */
function sliceReports(input: EpicEndInput, landed: LandedIssue): string[] {
  const attempt = input.schedule.find((s) => s.issue === landed.issue)?.attempts ?? 1;
  const tag = `${String(landed.issue)}-${String(attempt)}`;
  const stages = ['spec-review'];
  if (typeof landed.testReview !== 'string') stages.push('test-review');
  stages.push('standards-review');
  if (typeof landed.manifestTsdoc !== 'string') stages.push('manifest-tsdoc');
  return stages.map((stage) => `${input.entry.reportDir}/${stage}-${tag}.md`);
}

/** Run the retro over the entry's report: its findings, `null` when it returned none or threw. */
async function retroStep(
  input: Pick<EpicEndInput, 'hooks' | 'entry'>,
  report: unknown,
): Promise<readonly RetroFinding[] | null> {
  const { entry } = input;
  const values = { epic: entry.epic, reportDir: entry.reportDir, report };
  const out = await AGENT_CALLS.retro(input.hooks, values, entry.tag).catch(() => null);
  return out?.findings ?? null;
}

/**
 * Run the PR writer over `<upstream>...HEAD`, or `<batch base>...HEAD` when the sync named no
 * `upstream`. Never rejects: `null` when it returned none or threw, and the PR body falls back
 * ({@link renderPrBody}).
 */
async function prWriterStep(
  input: Pick<EpicEndInput, 'hooks' | 'entry' | 'landed'>,
  upstream: string | null,
): Promise<PrWriterOutput | null> {
  const { entry } = input;
  const values = {
    epic: entry.epic,
    batch: entry.batch,
    range: `${upstream ?? entry.base}...HEAD`,
    landed: input.landed.map((l) => ({
      issue: l.issue,
      commit: l.commit,
      subject: l.tdd.commit.subject,
    })),
    reportDir: entry.reportDir,
  };
  return AGENT_CALLS.prWriter(input.hooks, values, entry.tag).catch(() => null);
}

/**
 * The report the retro reads on the shipping path: `pr` before the PR opens, or a stopped epic
 * end's final outcome with its blocked-issue comments.
 */
function retroReport(
  input: EpicEndInput,
  published: Published,
  issueComments: readonly IssueComment[] = [],
): EpicReport {
  return {
    epic: input.entry.epic,
    branch: input.entry.branch,
    ...published,
    issues: input.issues,
    schedule: input.schedule,
    residue: input.residue,
    ...(issueComments.length === 0 ? {} : { issueComments }),
  };
}

/**
 * The main-checkout comparison the report carries: the publish task's when it ran, else a fresh
 * one read as one repo-lock task.
 */
async function mainAtEnd(input: EpicEndInput, state: EndState): Promise<boolean | null> {
  if (state.mainUntouched !== undefined) return state.mainUntouched;
  return input.repoLock.enqueue(() => mainUntouched(input));
}

/**
 * Read the main checkout again: whether its `HEAD` and dirtiness equal the launch's; `null` when
 * either snapshot is missing.
 */
async function mainUntouched(input: EpicEndInput): Promise<boolean | null> {
  const { entry, launch } = input;
  const out = await runTool(input.hooks, 'preflight', [entry.main], runPlace(entry, entry.tag));
  const now = out?.snapshot;
  if (launch === null || now === undefined || now === null) return null;
  return now.head === launch.snapshot.head && now.dirty === launch.snapshot.dirty;
}
