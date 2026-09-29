/**
 * The `ship` workflow's epic end (ADR-0045 decision 6), for an entry whose
 * issues have all settled with at least one landed: the server tier on
 * Paper then Folia, the master sync, the version bump, the pull request,
 * then a second look at the main checkout.
 *
 * - **A red server tier never blocks the PR** — both results go in its body,
 *   and the PR is the human gate.
 * - **A code conflict or a failed sync stops the epic**: no bump, no push.
 *   So does a failed bump.
 * - **Main untouched**: the main checkout's `HEAD` and dirtiness are read
 *   again with `worktree.ts preflight` and compared with pre-flight's; the
 *   run never works in the main checkout, so a difference is reported.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { WorkflowHooks } from './hooks.types.js';
import { prTitle, renderPrBody, type LandedIssue, type TierRun } from './pr-body.js';
import type { MainSnapshot } from './preflight.js';
import type { EntrySetup } from './slice-chain.js';
import { syncMasterStep, type SyncStepResult } from './sync-master-step.js';
import { envelopeProblem, runPlace, runTool } from './tool-calls.js';

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
   * `pr`: opened; `halted`: a landing or a slice teardown left the batch
   * unverified; `nothing-landed`: no issue landed, so no epic end;
   * `stopped`: its cut or its epic end failed ({@link EpicReport.message}).
   */
  readonly outcome: 'pr' | 'halted' | 'nothing-landed' | 'stopped';
  /** The pull request opened. */
  readonly pr?: number;
  /** Each issue's outcome, in the entry's order. */
  readonly issues: readonly IssueReport[];
  /** What stopped the entry, when `stopped`. */
  readonly message?: string;
  /**
   * Whether the main checkout's `HEAD` and dirtiness at the epic end equal
   * pre-flight's; `null` when either read failed. Absent without an epic end.
   */
  readonly mainUntouched?: boolean | null;
  /** What each slice teardown left behind, one line each. */
  readonly residue: readonly string[];
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
  /** The teardown residue so far. */
  readonly residue: readonly string[];
  /** The main checkout as pre-flight found it. */
  readonly launch: MainSnapshot | null;
}

/** The epic end's outcome before the main-checkout look. */
type Published = Pick<EpicReport, 'outcome' | 'pr' | 'message'>;

/**
 * Run the epic end.
 *
 * @param input - The entry, its issues and the launch snapshot.
 * @returns Resolves to the entry's report.
 */
export async function epicEnd(input: EpicEndInput): Promise<EpicReport> {
  const { hooks, entry } = input;
  const serverTier = [await tierRun(input, 'paper'), await tierRun(input, 'folia')];
  const sync = await syncMasterStep(hooks, entry);
  const published: Published =
    sync.verdict === 'code-conflict' || sync.verdict === 'failed'
      ? { outcome: 'stopped', message: `master sync ${sync.verdict}: ${sync.message}` }
      : await bumpAndPublish(input, serverTier, sync);
  return {
    epic: entry.epic,
    branch: entry.branch,
    ...published,
    issues: input.issues,
    mainUntouched: await mainUntouched(input),
    residue: input.residue,
  };
}

/**
 * Run the server tier on one engine.
 *
 * @param input - The epic end's inputs.
 * @param engine - The engine.
 * @returns Resolves to the engine's run.
 */
async function tierRun(input: EpicEndInput, engine: 'paper' | 'folia'): Promise<TierRun> {
  const { entry } = input;
  const argv = [
    entry.batch,
    '--engine',
    engine,
    '--registry',
    entry.registry,
    '--log',
    `${entry.reportDir}/server-tier-${engine}.log`,
  ];
  const out = await runTool(input.hooks, 'server-tier', argv, runPlace(entry.reportDir, engine));
  return { engine, out };
}

/**
 * Bump the version, then push the branch and open the PR.
 *
 * @param input - The epic end's inputs.
 * @param serverTier - Both engines' runs.
 * @param sync - The master sync.
 * @returns Resolves to `pr` with its number, or `stopped` naming the step
 *   and its first error.
 */
async function bumpAndPublish(
  input: EpicEndInput,
  serverTier: readonly TierRun[],
  sync: SyncStepResult,
): Promise<Published> {
  const { hooks, entry } = input;
  const bump = await runTool(hooks, 'bump', [entry.batch], runPlace(entry.reportDir, entry.tag));
  if (bump?.status !== 'ok') return { outcome: 'stopped', message: envelopeProblem('bump', bump) };
  const body = renderPrBody({
    epic: entry.epic,
    branch: entry.branch,
    reportDir: entry.reportDir,
    landed: input.landed,
    unlanded: input.issues.filter((i) => i.outcome !== 'landed'),
    serverTier,
    sync,
    bump,
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
