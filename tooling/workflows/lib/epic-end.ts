/**
 * The `ship` workflow's epic end (ADR-0045 decision 6). For an entry whose
 * issues have all settled with at least one landed ({@link epicEnd}): the
 * critic (`critic-step.ts`), the master sync, the version bump, the retro,
 * then one repo-lock task: the main-checkout look, the master check and the
 * pull request. An entry that halted or landed nothing gets the retro alone
 * ({@link unshippedEpicEnd}).
 *
 * - **No server tier here** — PR CI's `Server integration` workflow
 *   (`.github/workflows/server-integration.yml`) runs it on both engines
 *   against the pull request, and its verdict is the PR's checks list
 *   (ADR-0045 decision 6, #1059).
 * - **A critic landing that leaves the batch unverified halts the epic**:
 *   no master sync, no push.
 * - **A code conflict or a failed sync stops the epic**: no bump, no push.
 *   So does a failed bump, and so does a step that throws.
 * - **The retro runs exactly once per entry**, whatever path the entry
 *   ends on, before the PR on the shipping path.
 * - **The repo lock** ({@link EpicEndInput.repoLock}): the master sync and
 *   the publish task (the main-checkout look, the master check, the push and
 *   PR) each run as one task of the run's one lock, so no two epic ends talk
 *   to `origin` or read the main checkout at once; the critic, the bump and
 *   the retro run outside it.
 * - **Main untouched**: the main checkout's `HEAD` and dirtiness are read
 *   again with `worktree.ts preflight` and compared with pre-flight's — read
 *   in the publish task before the push on the shipping path (so the PR body
 *   shows it), after the epic end on every other path; the run never works
 *   in the main checkout, so a difference is reported.
 * - **Master only moved forward**: {@link checkMasterStep}. A deleted,
 *   rewound or undecidable ref, a check that gives no verdict, or a missing
 *   launch snapshot stops the epic before the push: no push, no PR, the stop
 *   message naming the ref, both shas and the sha to restore from.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import { aggregateLeaseTimings, type LeaseAggregate } from '../../lib/lease-timings.js';

import { AGENT_CALLS, type RetroFinding } from './agent-calls.js';
import type { CommitQueue } from './commit-queue.js';
import { criticStep } from './critic-step.js';
import type { WorkflowHooks } from './hooks.types.js';
import { checkMasterStep, type MasterCheck, type PassedMasterCheck } from './master-check.js';
import {
  prTitle,
  renderPrBody,
  sliceLeaseLines,
  type CriticReport,
  type LandedIssue,
  type ScheduleEntry,
} from './pr-body.js';
import type { MainSnapshot, OverlapRecord } from './preflight.js';
import type { EntrySetup } from './slice-chain.js';
import { syncMasterStep, type SyncStepResult } from './sync-master-step.js';
import { envelopeProblem, runPlace, runTool, type BumpOutput } from './tool-calls.js';

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
  /** The main-checkout comparison, once the publish task read it. */
  mainUntouched?: boolean | null;
  /** The master check, once the publish task took it. */
  masterCheck?: MasterCheck;
}

/** The epic end's outcome before the main-checkout look. */
type Published = Pick<EpicReport, 'outcome' | 'pr' | 'message'>;

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
  const report: EpicReport = {
    epic: input.entry.epic,
    branch: input.entry.branch,
    outcome,
    issues: input.issues,
    schedule: input.schedule,
    residue: input.residue,
  };
  return { ...report, retro: await retroStep(input, report) };
}

/**
 * The shipping path, up to the pull request: critic, sync, bump, retro,
 * then the publish task.
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
  state.retro = await retroStep(input, retroReport(input, { outcome: 'pr' }));
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
 * `master`, then push and open the PR only when the check passed.
 *
 * @param input - The epic end's inputs.
 * @param found - The steps' results; its state gains the main-checkout
 *   comparison and the master check.
 * @returns Resolves to `pr` with its number, or `stopped` naming the master
 *   check or the publish.
 */
async function publishStep(input: EpicEndInput, found: EndFindings): Promise<Published> {
  return input.repoLock.enqueue(async (): Promise<Published> => {
    const untouched = await mainUntouched(input);
    found.state.mainUntouched = untouched;
    const check = await checkMasterStep(input.hooks, input.entry, input.launch);
    found.state.masterCheck = check;
    if (!check.passed)
      return { outcome: 'stopped', message: `master check failed: ${check.failure}` };
    return openPr(input, found, { masterCheck: check, mainUntouched: untouched });
  });
}

/**
 * Push the branch and open the PR. Runs inside the publish task, so it calls
 * the runner directly: a nested `enqueue` on the same lock would wait for
 * the task it is part of.
 *
 * @param input - The epic end's inputs.
 * @param found - The steps' results.
 * @param checked - The passed master check and the main-checkout
 *   comparison, both for the body.
 * @returns Resolves to `pr` with its number, or `stopped` naming the publish.
 */
async function openPr(
  input: EpicEndInput,
  found: EndFindings,
  checked: { readonly masterCheck: PassedMasterCheck; readonly mainUntouched: boolean | null },
): Promise<Published> {
  const { hooks, entry } = input;
  const body = renderPrBody({
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
  const place = runPlace(entry.reportDir, entry.tag, { path: bodyPath, content: body });
  const out = await runTool(hooks, 'publish', argv, place);
  const pr = out?.status === 'ok' ? out.pr : null;
  if (pr === undefined || pr === null) {
    return { outcome: 'stopped', message: envelopeProblem('publish', out) };
  }
  return { outcome: 'pr', pr: pr.number };
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
