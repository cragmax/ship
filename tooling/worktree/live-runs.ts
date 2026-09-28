/**
 * `live-runs <main>` — every live unattended run of the repository: each
 * registered worktree on a run branch, with its commits and files ahead of
 * the base branch, whether it is dirty, its pull request (via `gh`), and
 * the worktrees nested inside it. Read-only, so there is no self-hosted
 * guard.
 *
 * A PR that `gh` cannot report makes the envelope `failed` with one
 * `pr-state` error per affected branch while every run is still reported in
 * full — "could not ask" must never read as "no PR" at pre-flight. Any git
 * failure fails the whole command.
 */

import { existsSync } from 'node:fs';

import { compareStrings } from '../shared.js';

import { runCaptured } from './exec.js';
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
import {
  recordFailure,
  StepFailure,
  type LiveRun,
  type LiveRunsResult,
  type PrInfo,
} from './types.js';

/**
 * The branch namespace of every unattended run's feature branch
 * (`ship/<slug>`), the earlier parallel batch flow's included, so its live
 * batches stay visible. Slice, harness-agent (`worktree-agent-*`) and
 * detached worktrees are not runs.
 */
const RUN_BRANCH_PREFIX = 'refs/heads/ship/';

/**
 * The branch runs are cut from (`.claude/rules/git.md` § Unattended
 * workflow runs). `ahead` and `landed` are exact only while local `master`
 * is level with `origin/master` — true at pre-flight, which requires it,
 * but not guaranteed at a later resync or spent-run cleanup, where a stale
 * local `master` overcounts `ahead` (a merged PR's commits still look
 * unlanded) and moves the merge-base back.
 */
const RUN_BASE_BRANCH = 'master';

/** `gh`'s PR states in precedence order: a reopened branch's live PR wins. */
const PR_STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;

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
    spent: info.state === 'merged' || info.state === 'closed',
    nested: worktrees
      .map((w) => w.path)
      .filter((path) => !samePath(path, entry.path) && isInside(path, entry.path)),
  };
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
 * Ask `gh` for a branch's pull requests, in every state.
 *
 * @param main - The main checkout (`gh` resolves the repository from it).
 * @param branch - Short branch name.
 * @returns `none` for no PR; otherwise the highest-precedence PR by
 *   {@link PR_STATES}; `unknown` with an `error` when `gh` fails, is
 *   missing, or answers something unreadable.
 */
function lookupPr(main: string, branch: string): PrLookup {
  const r = runCaptured(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state', '--limit', '20'],
    { cwd: main },
  );
  if (r.exitCode !== 0) return unknownPr(`gh pr list exited ${String(r.exitCode)}: ${r.tail}`);
  const prs = parsePrList(r.stdout);
  if (prs === null) return unknownPr(`gh pr list printed unreadable JSON: ${r.stdout}`);
  if (prs.length === 0) return { info: { state: 'none', number: null } };
  for (const [ghState, state] of Object.entries(PR_STATES)) {
    const pr = prs.find((p) => p.state === ghState);
    if (pr !== undefined) return { info: { state, number: pr.number } };
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
  return { info: { state: 'unknown', number: null }, error };
}

/**
 * Parse `gh pr list --json number,state` output.
 *
 * @param stdout - `gh`'s stdout.
 * @returns The entries, or `null` unless it is an array of
 *   `{ number: number, state: string }`.
 */
function parsePrList(stdout: string): { number: number; state: string }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const valid = parsed.every(
    (p: unknown) =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as { number?: unknown }).number === 'number' &&
      typeof (p as { state?: unknown }).state === 'string',
  );
  return valid ? (parsed as { number: number; state: string }[]) : null;
}
