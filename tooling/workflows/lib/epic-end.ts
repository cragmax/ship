/**
 * The `ship` workflow's epic end (ADR-0045 decision 6). For an entry whose
 * issues have all settled with at least one landed ({@link epicEnd}): the
 * critic (`critic-step.ts`), the master sync, the version bump, then the
 * retro and the PR writer concurrently (the hooks' `parallel`), then one
 * repo-lock task: the main-checkout look, the master check and the pull
 * request. An entry that halted or landed nothing gets the retro alone
 * ({@link unshippedEpicEnd}).
 *
 * - **No server-tier step here** — the publish's push runs it: the pre-push
 *   hook's `server-tier` job runs both engines across the local pool, and a
 *   red tier refuses the push (ADR-0045 decision 6, amended 2026-10-08).
 * - **A critic landing that leaves the batch unverified halts the epic**:
 *   no master sync, no push.
 * - **A code conflict or a failed sync stops the epic**: no bump, no push.
 *   So does a failed bump, and so does a step that throws. A bump finding
 *   the version already at its target commits nothing (status `ok`, `commit`
 *   `null`), and the epic end goes on to the retro and the publish.
 * - **The retro runs exactly once per entry**, whatever path the entry
 *   ends on, before the PR on the shipping path.
 * - **The PR writer runs on the shipping path only**, after the bump. One
 *   that returns nothing or rejects never blocks the PR; the body falls back
 *   (`renderPrBody`).
 * - **An over-limit PR body** ships as {@link fitPrBody} fits it, its moved
 *   sections posted as PR comments once the PR is open ({@link openPr}); a
 *   failed post is reported and never stops the epic.
 * - **An attached run** (the entry's `attachedRun` set) has no PR writer and
 *   opens no PR: its publish is `publish --push-only` onto the open PR, then
 *   its run report posted as one PR comment, then a section appended to the
 *   PR's body ({@link pushOntoPr}). A PR no longer open stops the epic
 *   (`publish refused (no-open-pr): …`); its landed issues stay landed on
 *   the branch.
 * - **The repo lock** ({@link EpicEndInput.repoLock}): the master sync and
 *   the publish task (the main-checkout look, the master check, the push and
 *   PR with its moved sections' comments, and an attached run's report
 *   comment and body edit) each run as one task of the run's one lock, so no
 *   two epic ends talk to `origin` or read the main checkout at once; the
 *   critic, the bump, the retro and the PR writer run outside it.
 * - **Main untouched**: the main checkout's `HEAD` and dirtiness are read
 *   again with `worktree.ts preflight` and compared with pre-flight's — read
 *   in the publish task before the push on the shipping path (so the PR body
 *   shows it), after the epic end on every other path; the run never works
 *   in the main checkout, so a difference is reported.
 * - **Master only moved forward**: {@link checkMasterStep}, `origin` also
 *   against the `origin/master` the epic end's own sync merged or found
 *   merged. A deleted, rewound or undecidable ref, a check that gives no
 *   verdict, a missing launch snapshot, or a sync naming no `origin/master`
 *   sha stops the epic before the push: no push, no PR, the stop message
 *   naming the ref, its shas and the sha to restore from — for `origin`,
 *   that synced sha.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import { aggregateLeaseTimings, type LeaseAggregate } from '../../lib/lease-timings.js';

import { AGENT_CALLS, type PrWriterOutput, type RetroFinding } from './agent-calls.js';
import type { CommitQueue } from './commit-queue.js';
import { criticStep } from './critic-step.js';
import type { WorkflowHooks } from './hooks.types.js';
import { checkMasterStep, type MasterCheck, type PassedMasterCheck } from './master-check.js';
import {
  fitPrBody,
  prTitle,
  renderAttachedReport,
  renderAttachedSection,
  renderBlockedComment,
  sliceLeaseLines,
  type CriticReport,
  type LandedIssue,
  type PrBodyInput,
  type ScheduleEntry,
} from './pr-body.js';
import type { MainSnapshot, OverlapRecord } from './preflight.js';
import type { EntrySetup } from './slice-chain.js';
import { syncMasterStep, type SyncStepResult } from './sync-master-step.js';
import {
  envelopeProblem,
  runPlace,
  runTool,
  type BumpOutput,
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
  /** How the PR cites it: `fixes` only for a landed issue whose plan card says so. */
  readonly cite: 'fixes' | 'see';
  /** Its batch commit, when it landed. */
  readonly commit?: string;
  /** Why, when it did not land. */
  readonly reason?: string;
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
   * `pr`: opened; `halted`: a landing (the critic's included) or a slice
   * teardown left the batch unverified; `nothing-landed`: no issue landed,
   * so no epic end but the retro; `stopped`: its cut or its epic end failed
   * ({@link EpicReport.message}).
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
  /** What each slice teardown left behind, one line each. */
  readonly residue: readonly string[];
  /** The critic's part; absent without an epic end. */
  readonly critic?: CriticReport;
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
  critic?: CriticReport;
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
type Published = Pick<EpicReport, 'outcome' | 'pr' | 'message' | 'prBodyEdit' | 'prReportComment'>;

/**
 * Run the epic end.
 *
 * @param input - The entry, its issues and the launch snapshot.
 * @returns Resolves to the entry's report; a step that throws stops the
 *   epic (`the epic end threw: …`), the retro still run.
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
  if (state.retro === undefined)
    state.retro = await retroStep(input, retroReport(input, published));
  return {
    epic: input.entry.epic,
    branch: input.entry.branch,
    ...published,
    issues: input.issues,
    schedule: input.schedule,
    mainUntouched: await mainAtEnd(input, state),
    ...(state.masterCheck === undefined ? {} : { masterCheck: state.masterCheck }),
    residue: input.residue,
    ...(state.critic === undefined ? {} : { critic: state.critic }),
    retro: state.retro,
    ...(state.leases === undefined ? {} : { leases: state.leases }),
    ...(issueComments.length === 0 ? {} : { issueComments }),
  };
}

/**
 * The epic end of an entry that halted or landed nothing: the retro alone.
 *
 * @param input - The entry, its issues, schedule and residue.
 * @param outcome - How the entry ended.
 * @returns Resolves to the entry's report.
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
  return { ...report, retro: await retroStep(input, report) };
}

/**
 * Tell each issue the run blocked why, as one comment each
 * (`post-issue-comment`, `gh` run from the main checkout), the comment
 * written first to `<reportDir>/issue-comment-<N>.md` per
 * {@link renderBlockedComment}. The run changes no label.
 *
 * @param input - The entry and its issues.
 * @param pr - The run's pull request, when it opened one.
 * @returns Resolves to one record per `blocked` issue, in the entry's order:
 *   its `url`, or `url: null` with the `problem` — the envelope's per
 *   `envelopeProblem`, `post-issue-comment ok without a url`, or
 *   `post-issue-comment threw: …`. Never rejects, so a failed post never
 *   fails the run; `[]` when no issue was blocked.
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
      issue: issue.issue,
      ...(issue.reason === undefined ? {} : { reason: issue.reason }),
      ...(pr === undefined ? {} : { pr }),
      branch: entry.branch,
      reportDir: entry.reportDir,
    });
    const argv = [entry.main, '--issue', String(issue.issue), '--comment-file', path];
    const place = runPlace(entry.reportDir, String(issue.issue), { path, content });
    comments.push(await postIssueComment(input.hooks, issue.issue, argv, place));
  }
  return comments;
}

/**
 * One `post-issue-comment` call, its outcome as the report records it.
 *
 * @param hooks - The workflow hooks.
 * @param issue - The issue.
 * @param argv - The command's arguments after its name.
 * @param place - Where its envelope goes, with the comment to write first.
 * @returns Resolves to the record per {@link commentBlockedStep}; never rejects.
 */
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
 * The shipping path, up to the pull request: critic, sync, bump, the retro
 * and (unattached runs only) the PR writer concurrently, then the publish
 * task.
 *
 * @param input - The epic end's inputs.
 * @param state - Filled in as each step reports.
 * @returns Resolves to `pr`, `halted` (the critic) or `stopped` (sync, bump,
 *   master check or publish).
 */
async function shipSteps(input: EpicEndInput, state: EndState): Promise<Published> {
  const { hooks, entry } = input;
  const critic = await criticStep(input);
  const { halt, ...criticReport } = critic;
  state.critic = criticReport;
  state.leases = leaseTotals(input.landed);
  if (halt !== null) return { outcome: 'halted', message: `the critic halted the epic: ${halt}` };
  const sync = await input.repoLock.enqueue(() => syncMasterStep(hooks, entry));
  if (sync.verdict === 'code-conflict' || sync.verdict === 'failed') {
    return { outcome: 'stopped', message: `master sync ${sync.verdict}: ${sync.message}` };
  }
  const bump = await runTool(hooks, 'bump', [entry.batch], runPlace(entry.reportDir, entry.tag));
  if (bump?.status !== 'ok') return { outcome: 'stopped', message: envelopeProblem('bump', bump) };
  // No thunk rejects (each step catches), so the runtime's unobserved
  // `null`-for-a-throw is never read. An attached run runs no PR writer: its
  // section is appended after the push (`pushOntoPr`).
  await hooks.parallel([
    async () => {
      state.retro = await retroStep(input, retroReport(input, { outcome: 'pr' }));
    },
    async () => {
      if (entry.attachedRun === null) state.writer = await prWriterStep(input, sync.upstream);
    },
  ]);
  return publishStep(input, { sync, bump, state });
}

/** What the pull request body reports besides the entry's inputs. */
interface EndFindings {
  readonly sync: SyncStepResult;
  readonly bump: BumpOutput;
  readonly state: EndState;
}

/**
 * The publish task — one repo-lock task: read the main checkout, check
 * `master`, then, only when the check passed, push and open the PR — or,
 * for an attached run, push onto its open PR and then append its section to
 * the PR's body ({@link pushOntoPr}).
 *
 * @param input - The epic end's inputs.
 * @param found - The steps' results; its state gains the main-checkout
 *   comparison and the master check.
 * @returns Resolves to `pr` with its number, or `stopped` naming the master
 *   check or the publish — an attached run's per {@link pushOntoPr}.
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
    if (input.entry.attachedRun !== null) {
      return pushOntoPr(input, found, checked, input.entry.attachedRun);
    }
    return openPr(input, found, checked);
  });
}

/** The passed master check and the main-checkout comparison, both for a body. */
interface Checked {
  readonly masterCheck: PassedMasterCheck;
  readonly mainUntouched: boolean | null;
}

/**
 * Push an attached run's branch onto its open PR (`publish --push-only`),
 * then, only when the push ended `pr`, post the run's report as a PR
 * comment ({@link postReportStep}) and append the run's section to the PR's
 * body ({@link appendSectionStep}) — linking the comment when it was
 * posted, naming the report dir when not. Runs inside the publish task, as
 * {@link openPr} does.
 *
 * @param input - The epic end's inputs.
 * @param found - The steps' results, for the section.
 * @param checked - The passed master check and the main-checkout
 *   comparison, for the section.
 * @param run - The attached run's number R.
 * @returns Resolves to `pr` with the open PR's number — with
 *   `prReportComment` naming a failed post and `prBodyEdit` a failed section
 *   edit, the outcome still `pr` — or `stopped` naming the publish, a PR no
 *   longer open included, with no post and no edit made.
 */
async function pushOntoPr(
  input: EpicEndInput,
  found: EndFindings,
  checked: Checked,
  run: number,
): Promise<Published> {
  const { hooks, entry } = input;
  const argv = [entry.batch, '--push-only', '--log', `${entry.reportDir}/publish.log`];
  const out = await runTool(hooks, 'publish', argv, runPlace(entry.reportDir, entry.tag));
  const published = publishedPr(out);
  if (published.outcome !== 'pr' || published.pr === undefined) return published;
  const base = { ...bodyInput(input, found, checked), run };
  const posted = await postReportStep(input, published.pr, renderAttachedReport(base));
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
 * Post an attached run's report as one comment on its open PR
 * (`post-pr-comment`), the report written first to
 * `<reportDir>/pr-report-comment.md`.
 *
 * @param input - The epic end's inputs.
 * @param pr - The open PR's number.
 * @param report - The report, per {@link renderAttachedReport}.
 * @returns Resolves to the posted comment's `url` when the post came back
 *   `ok` with one; otherwise to the `failure` — the envelope's problem per
 *   `envelopeProblem`, `post-pr-comment ok without a url`, or
 *   `post-pr-comment threw: …` — and never rejects, so a failed post never
 *   fails the run.
 */
async function postReportStep(
  input: EpicEndInput,
  pr: number,
  report: string,
): Promise<{ readonly url: string } | { readonly failure: string }> {
  const file = { name: 'pr-report-comment.md', flag: '--comment-file', content: report };
  const posted = await prFileStep(input, 'post-pr-comment', pr, file);
  if ('failure' in posted) return posted;
  return typeof posted.ok.url === 'string'
    ? { url: posted.ok.url }
    : { failure: 'post-pr-comment ok without a url' };
}

/**
 * Append an attached run's section to its open PR's body
 * (`append-pr-body`), the section written first to
 * `<reportDir>/pr-section.md`.
 *
 * @param input - The epic end's inputs.
 * @param pr - The open PR's number.
 * @param section - The section, per {@link renderAttachedSection}.
 * @returns Resolves to `null` when the edit came back `ok`; otherwise to the
 *   problem — the envelope's per `envelopeProblem`, or
 *   `append-pr-body threw: …` — and never rejects, so a failed edit never
 *   fails the run.
 */
async function appendSectionStep(
  input: EpicEndInput,
  pr: number,
  section: string,
): Promise<string | null> {
  const file = { name: 'pr-section.md', flag: '--section-file', content: section };
  const edited = await prFileStep(input, 'append-pr-body', pr, file);
  return 'failure' in edited ? edited.failure : null;
}

/**
 * Run one of the open PR's file-fed tools on the batch, with `--pr N` and
 * the file's flag, the file written first to `<reportDir>/<name>`.
 *
 * @param input - The epic end's inputs.
 * @param tool - The tool.
 * @param pr - The open PR's number.
 * @param file - The file's name in the report dir, its flag and its content.
 * @returns Resolves to the `ok` output; otherwise to the `failure` — the
 *   envelope's problem per `envelopeProblem`, or `<tool> threw: …` — and
 *   never rejects.
 */
async function prFileStep<N extends 'append-pr-body' | 'post-pr-comment'>(
  input: EpicEndInput,
  tool: N,
  pr: number,
  file: { readonly name: string; readonly flag: string; readonly content: string },
): Promise<{ readonly ok: ToolOutputs[N] } | { readonly failure: string }> {
  const { hooks, entry } = input;
  const path = `${entry.reportDir}/${file.name}`;
  const argv = [entry.batch, '--pr', String(pr), file.flag, path];
  const place = runPlace(entry.reportDir, entry.tag, { path, content: file.content });
  try {
    const out = await runTool(hooks, tool, argv, place);
    return out?.status === 'ok' ? { ok: out } : { failure: envelopeProblem(tool, out) };
  } catch (err) {
    return { failure: `${tool} threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * How a publish ended.
 *
 * @param out - `publish`'s output.
 * @returns `pr` with its number for an `ok` naming the PR; otherwise
 *   `stopped` naming the publish.
 */
function publishedPr(out: PublishOutput | null): Published {
  const pr = out?.status === 'ok' ? out.pr : null;
  if (pr === undefined || pr === null) {
    return { outcome: 'stopped', message: envelopeProblem('publish', out) };
  }
  return { outcome: 'pr', pr: pr.number };
}

/**
 * Push the branch and open the PR, its body per {@link fitPrBody}; once the PR
 * is open, post each moved section as a PR comment, in order. Runs inside the
 * publish task, so it calls the runner directly: a nested `enqueue` on the
 * same lock would wait for the task it is part of.
 *
 * @param input - The epic end's inputs.
 * @param found - The steps' results.
 * @param checked - The passed master check and the main-checkout
 *   comparison, both for the body.
 * @returns Resolves to `pr` with its number — with `prReportComment` naming
 *   each failed post, `; `-joined — or `stopped` naming the publish.
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
  ];
  const place = runPlace(entry.reportDir, entry.tag, { path: bodyPath, content: fitted.body });
  const published = publishedPr(await runTool(hooks, 'publish', argv, place));
  if (published.outcome !== 'pr' || published.pr === undefined) return published;
  const failures: string[] = [];
  for (const moved of fitted.comments) {
    const file = { name: moved.file, flag: '--comment-file', content: moved.text };
    const posted = await prFileStep(input, 'post-pr-comment', published.pr, file);
    if ('failure' in posted) failures.push(posted.failure);
  }
  return failures.length === 0 ? published : { ...published, prReportComment: failures.join('; ') };
}

/**
 * What a PR body and an attached run's section report, but the PR writer's
 * answer.
 *
 * @param input - The epic end's inputs.
 * @param found - The steps' results.
 * @param checked - The passed master check and the main-checkout comparison.
 * @returns The entry's report: every issue not `landed` as unlanded; a
 *   missing critic as `not-run`, missing lease totals recomputed, a missing
 *   retro as `null`.
 */
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
    masterCheck: checked.masterCheck,
    mainUntouched: checked.mainUntouched,
    critic: found.state.critic ?? { outcome: 'not-run', reason: 'no critic step', findings: [] },
    overlap: input.overlap,
    schedule: input.schedule,
    leases: found.state.leases ?? leaseTotals(input.landed),
    retro: found.state.retro ?? null,
  };
}

/**
 * The entry's lease totals: every landed slice's release lines, the tdd's, the
 * review's and the test review's alike ({@link sliceLeaseLines}), each counted
 * in its engine's and its issue's totals with no role breakdown.
 *
 * @param landed - The landed issues.
 * @returns The totals.
 */
function leaseTotals(landed: readonly LandedIssue[]): LeaseAggregate {
  return aggregateLeaseTimings(
    landed.flatMap((l) =>
      sliceLeaseLines(l).flatMap((r) => r.lines.map((line) => ({ issue: l.issue, line }))),
    ),
  );
}

/**
 * Run the retro over the entry's report.
 *
 * @param input - The entry and the hooks.
 * @param report - The report so far, as the retro reads it.
 * @returns Resolves to its findings; `null` when it returned none or threw.
 */
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
 * Run the PR writer over the PR's net diff.
 *
 * @param input - The entry, its landed issues and the hooks.
 * @param upstream - The `origin/master` sha the master sync left the batch
 *   holding; `null` when it named none. The writer reads `<upstream>...HEAD`,
 *   or `<batch base>...HEAD` when `upstream` is `null`.
 * @returns Resolves to its answer; `null` when it returned none or threw —
 *   never rejects.
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
      plan: l.card.planPath,
      subject: l.card.commit.subject,
    })),
    reportDir: entry.reportDir,
  };
  return AGENT_CALLS.prWriter(input.hooks, values, entry.tag).catch(() => null);
}

/**
 * The report the retro reads on the shipping path.
 *
 * @param input - The epic end's inputs.
 * @param published - How the path ended, or `pr` before the pull request.
 * @returns The entry's outcome, issues, schedule and residue.
 */
function retroReport(input: EpicEndInput, published: Published): EpicReport {
  return {
    epic: input.entry.epic,
    branch: input.entry.branch,
    ...published,
    issues: input.issues,
    schedule: input.schedule,
    residue: input.residue,
  };
}

/**
 * The main-checkout comparison the report carries.
 *
 * @param input - The epic end's inputs.
 * @param state - What the epic end learnt.
 * @returns Resolves to the publish task's comparison when it ran; otherwise
 *   to a fresh one, read as one repo-lock task.
 */
async function mainAtEnd(input: EpicEndInput, state: EndState): Promise<boolean | null> {
  if (state.mainUntouched !== undefined) return state.mainUntouched;
  return input.repoLock.enqueue(() => mainUntouched(input));
}

/**
 * Read the main checkout again and compare it with the launch.
 *
 * @param input - The epic end's inputs.
 * @returns Resolves to whether `HEAD` and dirtiness are unchanged; `null`
 *   when either snapshot is missing.
 */
async function mainUntouched(input: EpicEndInput): Promise<boolean | null> {
  const { entry, launch } = input;
  const out = await runTool(
    input.hooks,
    'preflight',
    [entry.main],
    runPlace(entry.reportDir, entry.tag),
  );
  const now = out?.snapshot;
  if (launch === null || now === undefined || now === null) return null;
  return now.head === launch.snapshot.head && now.dirty === launch.snapshot.dirty;
}
