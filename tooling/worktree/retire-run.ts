/**
 * `retire-run <main> --branch ship/<slug>` — retire a merged run: delete its slice branches
 * (`slice/<slug>/…`), remove its run root (`ph-ship/<slug>/`) and delete its run branch, once its
 * batch is torn down.
 *
 * Invariant: every guard runs before any mutation — the branch guard ({@link assertMerged}), then
 * the folder guard: emptiness ({@link assertOnlyRunRecord}), nested worktrees, links
 * ({@link assertNothingLive}). Then the slice branches are deleted, the run root removed and the
 * run branch deleted, in that order, so a failed slice deletion leaves the run retirable again.
 * `git branch -d` is never the guard: it accepts a branch merged only to its own upstream (PF-61).
 */

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { compareStrings } from '../shared.js';
import { attachSlug } from './cut-attach.js';
import { runCaptured } from './exec.js';
import { assertMainWorktree, branchesUnder, git, isInside, listWorktrees } from './git.js';
import { findLinks, isRealDir } from './links.js';
import { runLayout, RUN_UPSTREAM, sliceBranchPrefix } from './run-layout.js';
import { Refusal, recordFailure, StepFailure, type RetireRunResult } from './types.js';

/** Inputs of {@link retireRun}. */
export interface RetireRunInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** The run branch, short form (`ship/<slug>`). */
  readonly branch: string;
}

/**
 * Retire the run on `branch`.
 *
 * @returns The envelope: `ok` with `rootRemoved`, `branchDeleted` and `sliceBranches`; `refused`
 *   (`not-main-worktree`, `not-run-batch`, `branch-unmerged`, `root-not-empty`, `nested-worktree`,
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
    sliceBranches: [],
  };
  try {
    assertMainWorktree(main, 'preconditions');
    const slug = attachSlug(branch);
    const { root } = runLayout(main, slug);
    assertMerged(main, branch);
    assertOnlyRunRecord(root);
    assertNothingLive(main, root);
    deleteSliceBranches(main, slug, result.sliceBranches);
    rmSync(root, { recursive: true, force: true });
    result.rootRemoved = true;
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
 * @throws StepFailure `branch-guard` when `git merge-base --is-ancestor` exits other than 0 or 1
 *   (a missing branch exits 128).
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
 * Refuse `root-not-empty` unless every entry of the run root is the real directory `reports` or an
 * empty real directory named `slice-*`; the message names each other entry.
 *
 * @throws A filesystem error when the run root cannot be read (a missing run root included).
 */
function assertOnlyRunRecord(root: string): void {
  const offenders = readdirSync(root).filter((name) => {
    const path = join(root, name);
    if (name === 'reports') return !isRealDir(path);
    return !(name.startsWith('slice-') && isRealDir(path) && readdirSync(path).length === 0);
  });
  if (offenders.length > 0) {
    throw new Refusal(
      'root-not-empty',
      'folder-guard',
      `${root} holds more than reports/ and empty slice folders: ${offenders.join(', ')}`,
    );
  }
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
