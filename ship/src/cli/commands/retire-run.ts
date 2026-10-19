/**
 * `retire-run <main> --branch ship/<slug>` — retire a merged run: delete its slice branches
 * (`slice/<slug>/…`), remove its run root (its report dir, `reports/ship-<head>/`) and delete its
 * run branch, once its batch is torn down.
 *
 * Invariant: every guard runs before any mutation — the branch guard ({@link assertMerged}), then
 * the folder guard: the run root's place ({@link assertRunRoot}), nested worktrees, links
 * ({@link assertNothingLive}). Then the slice branches are deleted, the run root removed and the
 * run branch deleted, in that order, so a failed slice deletion leaves the run retirable again.
 * A missing run root skips the folder guard and the removal; the branches still go.
 * `git branch -d` is never the guard: it accepts a branch merged only to its own upstream (PF-61).
 */

import { lstatSync, rmSync } from 'node:fs';
import { posix } from 'node:path';

import { compareStrings } from '../../../../tooling/lib/shared.js';
import { attachSlug } from './cut-attach.js';
import { runCaptured } from '../git/exec.js';
import {
  assertMainWorktree,
  branchesUnder,
  git,
  isInside,
  listWorktrees,
  samePath,
} from '../git/git.js';
import { findLinks } from '../git/links.js';
import { REPORTS_DIR, runLayout, RUN_UPSTREAM, sliceBranchPrefix } from '../git/run-layout.js';
import { Refusal, recordFailure, StepFailure, type RetireRunResult } from '../envelope/types.js';

/** Inputs of {@link retireRun}. */
interface RetireRunInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** The run branch, short form (`ship/<slug>`). */
  readonly branch: string;
}

/**
 * Retire the run on `branch`.
 *
 * @returns The envelope: `ok` with `rootRemoved` (or `rootAbsent`), `branchDeleted` and
 *   `sliceBranches`; `refused`
 *   (`not-main-worktree`, `not-run-batch`, `branch-unmerged`, `not-run-root`, `nested-worktree`,
 *   `links-remain`) with nothing mutated and `sliceBranches` empty; or `failed` with the step, each
 *   flag and `sliceBranches` saying what was done before it.
 */
export function retireRun(input: RetireRunInput): RetireRunResult {
  const { main, branch } = input;
  const result: RetireRunResult = {
    command: 'retire-run',
    status: 'ok',
    worktree: main,
    errors: [],
    branchDeleted: false,
    rootRemoved: false,
    rootAbsent: false,
    sliceBranches: [],
  };
  try {
    assertMainWorktree(main, 'preconditions');
    const slug = attachSlug(branch);
    const root = runLayout(main, slug).reports;
    assertMerged(main, branch);
    result.rootAbsent = !assertRunRoot(main, root);
    if (!result.rootAbsent) assertNothingLive(main, root);
    deleteSliceBranches(main, slug, result.sliceBranches);
    if (!result.rootAbsent) {
      rmSync(root, { recursive: true, force: true });
      result.rootRemoved = true;
    }
    git(main, ['branch', '-D', branch], 'delete-branch');
    result.branchDeleted = true;
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * `git branch -D` each branch under {@link sliceBranchPrefix}, appending it to `deleted`. No
 * ancestry guard: slice branches reach the batch by cherry-pick, so none is ever in master.
 *
 * @throws StepFailure `slice-branches` (listing) or `delete-slice-branch` (one checked out).
 */
function deleteSliceBranches(main: string, slug: string, deleted: string[]): void {
  const names = branchesUnder(main, sliceBranchPrefix(slug), 'slice-branches').sort(compareStrings);
  for (const name of names) {
    git(main, ['branch', '-D', name], 'delete-slice-branch');
    deleted.push(name);
  }
}

/**
 * Refuse `branch-unmerged` unless the branch is in {@link RUN_UPSTREAM}.
 *
 * @throws StepFailure `branch-guard` when `git merge-base --is-ancestor` cannot answer (a missing
 *   branch included).
 */
function assertMerged(main: string, branch: string): void {
  const r = runCaptured(
    'git',
    [
      '-C',
      main,
      'merge-base',
      '--is-ancestor',
      `refs/heads/${branch}`,
      `refs/remotes/${RUN_UPSTREAM}`,
    ],
    { cwd: process.cwd() },
  );
  if (r.exitCode === 0) return;
  if (r.exitCode === 1) {
    throw new Refusal('branch-unmerged', 'branch-guard', `${branch} is not in ${RUN_UPSTREAM}`);
  }
  throw new StepFailure(
    'branch-guard',
    `git merge-base --is-ancestor failed for ${branch}`,
    r.tail,
  );
}

/**
 * Refuse `not-run-root` unless the run root is a real directory named `ship-*` directly under the
 * main checkout's {@link REPORTS_DIR}, so a path bug can remove one run's reports at most.
 *
 * @returns `true` when it passes, `false` when it is missing; any other `lstat` error throws.
 */
function assertRunRoot(main: string, root: string): boolean {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  const placed =
    samePath(posix.dirname(root), `${main}/${REPORTS_DIR}`) &&
    posix.basename(root).startsWith('ship-');
  if (placed && stat.isDirectory() && !stat.isSymbolicLink()) return true;
  throw new Refusal(
    'not-run-root',
    'folder-guard',
    `${root} is not a real ship-* directory directly under ${main}/${REPORTS_DIR}`,
  );
}

/**
 * Refuse `nested-worktree` naming each registered worktree inside the run root, then
 * `links-remain` naming each link in it; nothing is unlinked.
 */
function assertNothingLive(main: string, root: string): void {
  const nested = listWorktrees(main, 'folder-guard')
    .map((w) => w.path)
    .filter((path) => isInside(path, root));
  if (nested.length > 0) {
    throw new Refusal(
      'nested-worktree',
      'folder-guard',
      `registered worktrees lie inside ${root}: ${nested.join(', ')}`,
    );
  }
  const links = findLinks(root);
  if (links.length > 0) {
    throw new Refusal(
      'links-remain',
      'folder-guard',
      `links lie inside ${root}: ${links.map((l) => l.path).join(', ')}`,
    );
  }
}
