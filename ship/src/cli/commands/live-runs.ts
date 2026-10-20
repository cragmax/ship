/**
 * `live-runs <main>` — every live unattended run: each registered worktree on a run branch
 * (`RUN_BRANCH_PREFIX`, `run-layout.ts`) with its commits and files ahead of `RUN_BASE_BRANCH`,
 * its dirtiness, its PR (via `gh`) and its nested worktrees. Read-only: no self-hosted guard.
 *
 * Accepted residual: `ahead`/`landed` are exact only while local `master` is level with `origin`'s.
 *
 * A PR `gh` cannot report makes the envelope `failed` with one `pr-state` error per branch while
 * every run is still reported in full: "could not ask" never reads as "no PR". Any git failure
 * fails the whole command. `spent` keys on the run's tip, not only its branch: a `ship/<slug>`
 * re-cut after its PR merged has commits beyond the old PR's head ({@link spentOf}).
 */

import { existsSync } from 'node:fs';

import { z } from 'zod';

import { compareStrings } from '../../../../tooling/lib/strings.js';

import { GH_TIMEOUT_MS, runCaptured } from '../git/exec.js';
import {
  git,
  gitPaths,
  isInside,
  listWorktrees,
  requireWorktreeRoot,
  samePath,
  statusEntries,
  type WorktreeEntry,
} from '../git/git.js';
import { RUN_BASE_BRANCH, RUN_BRANCH_PREFIX } from '../git/run-layout.js';
import {
  recordFailure,
  StepFailure,
  type LiveRun,
  type LiveRunsResult,
  type PrInfo,
} from '../envelope/types.js';

/** `gh`'s PR states in precedence order: a reopened branch's live PR wins. */
const PR_STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const;

/** `gh pr list --json number,state,headRefOid` output. */
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
 * @throws StepFailure `preconditions` when it is not a worktree root, or is a linked worktree.
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
 * Describe one run, every git and `gh` query run in `main`; a failed PR lookup sets `result`
 * `failed` with a `pr-state` error naming the branch.
 *
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
 * Spent: tip `ref` is an ancestor of (or is) its merged or closed PR's head. Both `false` while the
 * PR is open, absent or unknown; `unverified` when its head is unnamed or not a commit here.
 *
 * @throws StepFailure `runs` when `git merge-base --is-ancestor` cannot answer.
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

/** Whether `oid` names a commit here. */
function isCommit(main: string, oid: string): boolean {
  if (!COMMIT_ID.test(oid)) return false;
  return (
    runCaptured('git', ['-C', main, 'cat-file', '-e', `${oid}^{commit}`], { cwd: process.cwd() })
      .exitCode === 0
  );
}

/**
 * Whether a run's worktree has uncommitted changes: `null` when git marks it prunable or its
 * directory is missing, where git never runs.
 *
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
 * @param dir - A checkout of the repository.
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

function unknownPr(error: string): PrLookup {
  return { info: { state: 'unknown', number: null, headOid: null }, error };
}

/**
 * Parse `gh pr list --json number,state,headRefOid` output.
 *
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
