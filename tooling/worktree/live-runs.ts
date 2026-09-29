/**
 * `live-runs <main>` — every live unattended run of the repository: each
 * registered worktree on a run branch (`RUN_BRANCH_PREFIX`, `run-layout.ts`),
 * with its commits and files ahead of
 * the base branch, whether it is dirty, its pull request (via `gh`), and
 * the worktrees nested inside it. Read-only, so there is no self-hosted
 * guard.
 *
 * `ahead` and `landed` count against `RUN_BASE_BRANCH` and are exact only
 * while local `master` is level with `origin/master` — true at pre-flight,
 * which requires it, but not guaranteed at a later resync or spent-run
 * cleanup, where a stale local `master` overcounts `ahead` (a merged PR's
 * commits still look unlanded) and moves the merge-base back.
 *
 * A PR that `gh` cannot report makes the envelope `failed` with one
 * `pr-state` error per affected branch while every run is still reported in
 * full — "could not ask" must never read as "no PR" at pre-flight. Any git
 * failure fails the whole command.
 *
 * `spent` keys on the run's tip, not only the branch name: a `ship/<slug>`
 * re-cut after its PR merged has commits beyond the old PR's head, so a run
 * is spent only when its tip is contained in that head ({@link spentOf}).
 */

import { existsSync } from 'node:fs';

import { z } from 'zod';

import { compareStrings } from '../shared.js';

import { GH_TIMEOUT_MS, runCaptured } from './exec.js';
import {
  git,
  gitPaths,
  isInside,
  listWorktrees,
  requireWorktreeRoot,
  samePath,
  statusEntries,
  type WorktreeEntry,
} from './git.js';
import { RUN_BASE_BRANCH, RUN_BRANCH_PREFIX } from './run-layout.js';
import {
  recordFailure,
  StepFailure,
  type LiveRun,
  type LiveRunsResult,
  type PrInfo,
} from './types.js';

/** `gh`'s PR states in precedence order: a reopened branch's live PR wins. */
const PR_STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;

/** `gh pr list --json number,state,headRefOid` output; unknown keys are tolerated. */
const PrListSchema = z.array(
  z.object({ number: z.number(), state: z.string(), headRefOid: z.string().optional() }),
);

/** A full commit id, as `gh` names a PR head. */
const COMMIT_ID = /^[0-9a-f]{40,64}$/u;

/** What {@link lookupPr} found. */
interface PrLookup {
  readonly info: PrInfo;
  /** Why the state is `unknown`; absent otherwise. */
  readonly error?: string;
}

/**
 * List the live runs of the repository whose main checkout is `main`.
 *
 * @param input - `main`: the repository's main checkout.
 * @returns The envelope: `ok` with every run sorted by branch; `failed`
 *   `pr-state` (runs still listed) when any PR lookup failed; or `failed`
 *   `preconditions` / `runs` when `main` is not the main checkout or git
 *   fails.
 */
export function liveRuns(input: { readonly main: string }): LiveRunsResult {
  const { main } = input;
  const result: LiveRunsResult = {
    command: 'live-runs',
    status: 'ok',
    worktree: main,
    errors: [],
    runs: [],
  };
  try {
    requireMainCheckout(main);
    const worktrees = listWorktrees(main, 'runs');
    for (const entry of worktrees.slice(1)) {
      if (entry.branch?.startsWith(RUN_BRANCH_PREFIX) !== true) continue;
      result.runs.push(describeRun(main, entry, worktrees, result));
    }
    result.runs.sort((x, y) => compareStrings(x.branch, y.branch));
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Require `main` to be the repository's main checkout root.
 *
 * @param main - The path given.
 * @throws StepFailure `preconditions` when it is not a worktree root, or
 *   is a linked worktree.
 */
function requireMainCheckout(main: string): void {
  const identity = requireWorktreeRoot(main, 'preconditions');
  if (!samePath(identity.main, main)) {
    throw new StepFailure(
      'preconditions',
      `${main} is not the main checkout (the main checkout is ${identity.main})`,
    );
  }
}

/**
 * Describe one run; a failed PR lookup is recorded on the envelope.
 *
 * @param main - The main checkout, where every git and `gh` query runs.
 * @param entry - The run's worktree entry (branch under the run prefix).
 * @param worktrees - Every registered worktree, for `nested`.
 * @param result - Envelope; a failed PR lookup sets `failed` and adds a
 *   `pr-state` error naming the branch.
 * @returns The run.
 * @throws StepFailure `runs` when git fails.
 */
function describeRun(
  main: string,
  entry: WorktreeEntry,
  worktrees: readonly WorktreeEntry[],
  result: LiveRunsResult,
): LiveRun {
  const ref = entry.branch ?? '';
  const branch = ref.slice('refs/heads/'.length);
  const mergeBase = git(main, ['merge-base', RUN_BASE_BRANCH, ref], 'runs');
  const { info, error } = lookupPr(main, branch);
  if (error !== undefined) {
    result.status = 'failed';
    result.errors.push({ step: 'pr-state', message: `${branch}: ${error}` });
  }
  const { spent, unverified } = spentOf(main, ref, info);
  return {
    path: entry.path,
    branch,
    ahead: Number(git(main, ['rev-list', '--count', `${RUN_BASE_BRANCH}..${ref}`], 'runs')),
    mergeBase,
    landed: gitPaths(main, ['diff', '--name-only', '--no-renames', mergeBase, ref], 'runs').sort(
      compareStrings,
    ),
    dirty: isDirty(entry),
    pr: info,
    spent,
    spentUnverified: unverified,
    nested: worktrees
      .map((w) => w.path)
      .filter((path) => !samePath(path, entry.path) && isInside(path, entry.path)),
  };
}

/**
 * Whether a run is spent: its PR merged or closed, and its tip contained in
 * the PR's head.
 *
 * @param main - The main checkout.
 * @param ref - The run branch's full ref.
 * @param info - Its PR.
 * @returns `spent` and `unverified` both `false` while the PR is open,
 *   absent or unknown; `unverified` when the PR is over but its head is
 *   unnamed or not a commit here; otherwise `spent` when the tip is an
 *   ancestor of (or equal to) the head.
 * @throws StepFailure `runs` when `git merge-base --is-ancestor` fails.
 */
function spentOf(
  main: string,
  ref: string,
  info: PrInfo,
): { readonly spent: boolean; readonly unverified: boolean } {
  if (info.state !== 'merged' && info.state !== 'closed')
    return { spent: false, unverified: false };
  if (info.headOid === null || !isCommit(main, info.headOid)) {
    return { spent: false, unverified: true };
  }
  const r = runCaptured('git', ['-C', main, 'merge-base', '--is-ancestor', ref, info.headOid], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return { spent: true, unverified: false };
  if (r.exitCode === 1) return { spent: false, unverified: false };
  throw new StepFailure(
    'runs',
    `git merge-base --is-ancestor ${ref} ${info.headOid} failed`,
    r.tail,
  );
}

/**
 * Whether a commit id names a commit in the repository.
 *
 * @param main - The main checkout.
 * @param oid - The id `gh` gave; anything but a full hex id is not one.
 * @returns `true` when `git cat-file -e <oid>^{commit}` succeeds.
 */
function isCommit(main: string, oid: string): boolean {
  if (!COMMIT_ID.test(oid)) return false;
  return (
    runCaptured('git', ['-C', main, 'cat-file', '-e', `${oid}^{commit}`], { cwd: process.cwd() })
      .exitCode === 0
  );
}

/**
 * Whether a run's worktree has uncommitted changes; git never runs in a
 * missing directory.
 *
 * @param entry - The run's worktree entry.
 * @returns `null` when git marks it prunable or its directory is missing.
 * @throws StepFailure `runs` when git fails.
 */
function isDirty(entry: WorktreeEntry): boolean | null {
  if (entry.prunable || !existsSync(entry.path)) return null;
  return statusEntries(entry.path, 'runs').length > 0;
}

/**
 * Ask `gh` for a branch's pull requests, in every state, with each head
 * commit, under `GH_TIMEOUT_MS`. `publish` and `cut-batch --attach` read it
 * too, for their open-PR checks.
 *
 * @param dir - A checkout of the repository (`gh` resolves the repository from it).
 * @param branch - Short branch name.
 * @returns `none` for no PR; otherwise the highest-precedence PR by
 *   {@link PR_STATES}, its `headOid` `null` when `gh` names none; `unknown`
 *   with an `error` when `gh` fails, is missing, or answers something
 *   unreadable.
 */
export function lookupPr(dir: string, branch: string): PrLookup {
  const r = runCaptured(
    'gh',
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state,headRefOid',
      '--limit',
      '20',
    ],
    { cwd: dir, timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) return unknownPr(`gh pr list exited ${String(r.exitCode)}: ${r.tail}`);
  const prs = parsePrList(r.stdout);
  if (prs === null) return unknownPr(`gh pr list printed unreadable JSON: ${r.stdout}`);
  if (prs.length === 0) return { info: { state: 'none', number: null, headOid: null } };
  for (const [ghState, state] of Object.entries(PR_STATES)) {
    const pr = prs.find((p) => p.state === ghState);
    if (pr !== undefined) {
      return { info: { state, number: pr.number, headOid: pr.headRefOid ?? null } };
    }
  }
  return unknownPr(`gh pr list reported unrecognised states: ${r.stdout}`);
}

/**
 * An `unknown` lookup.
 *
 * @param error - Why.
 * @returns The lookup.
 */
function unknownPr(error: string): PrLookup {
  return { info: { state: 'unknown', number: null, headOid: null }, error };
}

/**
 * Parse `gh pr list --json number,state,headRefOid` output.
 *
 * @param stdout - `gh`'s stdout.
 * @returns The entries, or `null` unless it is JSON matching {@link PrListSchema}.
 */
function parsePrList(stdout: string): z.infer<typeof PrListSchema> | null {
  try {
    const parsed = PrListSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
