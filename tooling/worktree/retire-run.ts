/**
 * `retire-run <main> --branch ship/<slug>` — retire a merged run: remove its run root
 * (`ph-ship/<slug>/`) and delete its run branch, once its batch is torn down.
 *
 * Invariant: every guard runs before any mutation — the branch guard ({@link assertMerged}), then
 * the folder guard: emptiness ({@link assertOnlyRunRecord}), nested worktrees, links
 * ({@link assertNothingLive}). The run root is removed before the branch is deleted.
 * `git branch -d` is never the guard: it accepts a branch merged only to its own upstream (#1297).
 */

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { attachSlug } from './cut-attach.js';
import { runCaptured } from './exec.js';
import { assertMainWorktree, git, isInside, listWorktrees } from './git.js';
import { findLinks, isRealDir } from './links.js';
import { runLayout, RUN_UPSTREAM } from './run-layout.js';
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
 * @returns The envelope: `ok` with `rootRemoved` and `branchDeleted`; `refused`
 *   (`not-main-worktree`, `not-run-batch`, `branch-unmerged`, `root-not-empty`, `nested-worktree`,
 *   `links-remain`) with nothing mutated; or `failed` with the step, each flag saying what was done
 *   before it.
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
  };
  try {
    assertMainWorktree(main, 'preconditions');
    const { root } = runLayout(main, attachSlug(branch));
    assertMerged(main, branch);
    assertOnlyRunRecord(root);
    assertNothingLive(main, root);
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
