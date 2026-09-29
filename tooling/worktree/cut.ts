/**
 * `cut-batch <main> (--epic E | --issues N,…)` and
 * `cut-slice <batch> (--issue N --attempt K | --critic)` — cut an
 * unattended run's feature branch and batch worktree, and one slice
 * worktree (an issue attempt's, or the epic end's critic's), at the places
 * `run-layout.ts` names (ADR-0045).
 *
 * Invariant, both commands: every guard runs before the first mutation — a
 * `git worktree add -b` — so a refusal leaves the repository's branches,
 * worktree list and every checkout exactly as they were.
 *
 * `cut-batch` is the one mutating command of the CLI without the
 * self-hosted guard: it must run from the main checkout, which is its
 * target. It is safe there because it never touches the main checkout's
 * working tree — it writes only `.git` (a branch and the worktree
 * registry) and a sibling directory, the run root. `cut-slice` keeps the
 * guard: its target is the batch, which the CLI never runs from.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { posix } from 'node:path';

import {
  assertMainWorktree,
  git,
  listWorktrees,
  refExists,
  resolveCommit,
  samePath,
} from './git.js';
import { assertLinkedWorktree } from './harvest.js';
import {
  criticSliceLayout,
  RUN_BASE_BRANCH,
  runLayout,
  runSlug,
  runSlugOf,
  sliceLayout,
  type RunSelection,
} from './run-layout.js';
import type { CutBatchResult, CutSliceResult } from './types-run.js';
import { Refusal, recordFailure } from './types.js';

/** Inputs of {@link cutSlice}. */
export interface CutSliceInput {
  /** The batch worktree, absolute with forward slashes. */
  readonly batch: string;
  /** Which slice: an issue attempt (attempt 1 for the first), or the epic end's critic. */
  readonly slice: { readonly issue: number; readonly attempt: number } | { readonly critic: true };
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Cut a run's feature branch at `master` and check it out as the batch
 * worktree, beside the main checkout, with an empty report directory.
 *
 * @param input - `main`: the main checkout; `selection`: what the run ships.
 * @returns The envelope: `ok` with the branch, base, run root, batch and
 *   report dir; `refused` (`not-main-worktree`, `branch-exists`,
 *   `path-exists`) before any mutation; or `failed` with the step.
 */
export function cutBatch(input: {
  readonly main: string;
  readonly selection: RunSelection;
}): CutBatchResult {
  const { main } = input;
  const result: CutBatchResult = {
    command: 'cut-batch',
    status: 'ok',
    worktree: main,
    errors: [],
    branch: null,
    base: null,
    runRoot: null,
    batch: null,
    reportDir: null,
    attach: null,
  };
  try {
    assertMainWorktree(main, 'preconditions');
    const layout = runLayout(main, runSlug(input.selection));
    assertBranchFree(main, layout.branch);
    assertPathFree(layout.root);
    const base = resolveCommit(main, `refs/heads/${RUN_BASE_BRANCH}`, 'preconditions');
    git(main, ['worktree', 'add', '-q', '-b', layout.branch, layout.batch, base], 'worktree-add');
    Object.assign(result, {
      branch: layout.branch,
      base,
      runRoot: layout.root,
      batch: layout.batch,
    });
    mkdirSync(layout.reports, { recursive: true });
    result.reportDir = layout.reports;
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Cut a slice branch — an issue attempt's, or the epic end's critic's — at
 * the batch `HEAD` and check it out beside the batch.
 *
 * @param input - Batch, which slice, and the self-hosted seam.
 * @returns The envelope: `ok` with the branch, base and slice path;
 *   `refused` (harvest's linked-worktree reasons, `not-run-batch`,
 *   `branch-exists`, `path-exists`) before any mutation; or `failed`.
 */
export function cutSlice(input: CutSliceInput): CutSliceResult {
  const { batch, selfPath = import.meta.filename } = input;
  const result: CutSliceResult = {
    command: 'cut-slice',
    status: 'ok',
    worktree: batch,
    errors: [],
    branch: null,
    base: null,
    slice: null,
  };
  try {
    assertLinkedWorktree(batch, selfPath);
    const root = posix.dirname(batch);
    const slug = assertRunBatch(batch);
    const slice =
      'critic' in input.slice
        ? criticSliceLayout(root, slug)
        : sliceLayout(root, slug, input.slice.issue, input.slice.attempt);
    assertBranchFree(batch, slice.branch);
    assertPathFree(slice.path);
    const base = resolveCommit(batch, 'HEAD', 'preconditions');
    git(batch, ['worktree', 'add', '-q', '-b', slice.branch, slice.path, base], 'worktree-add');
    Object.assign(result, { branch: slice.branch, base, slice: slice.path });
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Require the batch to have a run branch checked out.
 *
 * @param batch - The batch worktree.
 * @returns The run's slug.
 * @throws Refusal `not-run-batch` when the batch is detached or on a branch
 *   outside the run namespace.
 */
export function assertRunBatch(batch: string): string {
  const entry = listWorktrees(batch, 'preconditions').find((w) => samePath(w.path, batch));
  const slug = runSlugOf(entry?.branch ?? '');
  if (slug === null) {
    throw new Refusal(
      'not-run-batch',
      'preconditions',
      `${batch} is on ${entry?.branch ?? 'no branch'}, not a ship/ run branch`,
    );
  }
  return slug;
}

/**
 * Refuse when the branch exists already.
 *
 * @param dir - Any checkout of the repository.
 * @param branch - Short branch name.
 * @throws Refusal `branch-exists`.
 */
function assertBranchFree(dir: string, branch: string): void {
  if (refExists(dir, `refs/heads/${branch}`)) {
    throw new Refusal('branch-exists', 'preconditions', `branch ${branch} exists already`);
  }
}

/**
 * Refuse when the path exists already, as anything.
 *
 * @param path - The directory to be created.
 * @throws Refusal `path-exists`.
 */
function assertPathFree(path: string): void {
  if (existsSync(path)) {
    throw new Refusal('path-exists', 'preconditions', `${path} exists already`);
  }
}
