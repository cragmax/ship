/**
 * `cut-batch <main> (--epic E | --issues N,…)` and
 * `cut-slice <batch> --issue N --attempt K [--attached-run R]` — cut an
 * unattended run's feature branch and batch worktree, and one slice worktree, at the places
 * `run-layout.ts` names (Ship ADR-0001 decision 3).
 *
 * Invariant, both commands: every guard runs before the first mutation — a `git worktree add -b`
 * — so a refusal leaves the repository's branches, worktree list and every checkout as they were.
 *
 * `cut-batch` is the one mutating command of the CLI without the self-hosted guard: it runs from
 * the main checkout, its target, and writes only `.git` (a branch, the worktree registry) and the
 * main checkout's gitignored run paths (`run-layout.ts`), never a tracked file. `cut-slice` keeps
 * the guard: its target is the batch, which the CLI never runs from.
 */

import { existsSync, mkdirSync } from 'node:fs';

import { runSlug, type RunSelection } from '../../core/run-slug.js';

import {
  assertMainWorktree,
  git,
  listWorktrees,
  refExists,
  resolveCommit,
  samePath,
} from '../git/git.js';
import { assertLinkedWorktree } from './harvest.js';
import { RUN_BASE_BRANCH, runLayout, runSlugOf, sliceLayout } from '../git/run-layout.js';
import type { CutBatchResult, CutSliceResult } from '../envelope/types-run.js';
import { Refusal, recordFailure } from '../envelope/types.js';

/** Inputs of {@link cutSlice}. */
export interface CutSliceInput {
  /** The batch worktree, absolute with forward slashes. */
  readonly batch: string;
  /** Which issue attempt's slice (attempt 1 for the first). */
  readonly slice: { readonly issue: number; readonly attempt: number };
  /** The attached run whose slice this is, naming it `a<R>-…`; absent for an unattached run. */
  readonly attachedRun?: number;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Cut a run's feature branch at `master` and check it out as the batch
 * worktree, with an empty report directory.
 *
 * @param input - `main`: the main checkout; `selection`: what the run ships.
 * @returns The envelope: `ok` with the branch, base, batch and report dir;
 *   `refused` (`not-main-worktree`, `branch-exists`, `path-exists` when the
 *   batch or the report dir exists, a live run with the same head's
 *   included) before any mutation; or `failed` with the step.
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
    batch: null,
    reportDir: null,
    attach: null,
  };

  try {
    assertMainWorktree(main, 'preconditions');
    const layout = runLayout(main, runSlug(input.selection));
    assertBranchFree(main, layout.branch);
    assertPathFree(layout.batch);
    assertPathFree(layout.reports);
    const base = resolveCommit(main, `refs/heads/${RUN_BASE_BRANCH}`, 'preconditions');
    git(main, ['worktree', 'add', '-q', '-b', layout.branch, layout.batch, base], 'worktree-add');
    Object.assign(result, { branch: layout.branch, base, batch: layout.batch });
    mkdirSync(layout.reports, { recursive: true });
    result.reportDir = layout.reports;
  } catch (err) {
    recordFailure(result, err);
  }

  return result;
}

/**
 * Cut an issue attempt's slice branch at the batch `HEAD` and check it out
 * beside the batch. An attached run's slice is named `a<R>-…`
 * (`run-layout.ts`), so it never collides with an earlier run's leftover
 * branch of the same issue attempt.
 *
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
    const slug = assertRunBatch(batch);
    const run = input.attachedRun ?? null;
    const slice = sliceLayout(batch, slug, input.slice.issue, input.slice.attempt, run);
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
