/**
 * `cut-batch <main> --attach ship/<slug>` — give an open run branch its
 * batch worktree at the place `run-layout.ts` names, for a `/resync`: reuse
 * the batch already registered there, or check the branch out anew when
 * the batch was torn down while its PR is still open.
 *
 * Invariant: every refusal comes before the first mutation of a branch or
 * the worktree list — the `update-ref` fast-forward or the `worktree add` —
 * and only the fetch (remote-tracking refs alone) precedes the checks that
 * need it: whether the branch exists locally or on `origin`, and how the
 * two relate. Like `cut-batch`, it runs from the main checkout it targets
 * and never touches that checkout's working tree (`cut.ts`).
 */

import { existsSync, mkdirSync } from 'node:fs';

import { runCaptured } from './exec.js';
import {
  assertMainWorktree,
  fetchOrigin,
  git,
  listWorktrees,
  refExists,
  resolveCommit,
  samePath,
} from './git.js';
import { lookupPr } from './live-runs.js';
import { runLayout, runSlugOf, type RunLayout } from './run-layout.js';
import type { CutBatchResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure } from './types.js';

/** Inputs of {@link attachBatch}. */
export interface AttachInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** The run branch, short form (`ship/<slug>`). */
  readonly branch: string;
}

/**
 * Attach the run branch's batch worktree, keeping the file header's
 * invariant.
 *
 * @param input - The main checkout and the branch.
 * @returns The envelope: `ok` with the branch, its tip as `base`, the run
 *   root, batch and report dir, and `attach`; `refused` before any branch
 *   or worktree mutation (`not-main-worktree`, `not-run-batch`,
 *   `no-open-pr`, `branch-checked-out`, `path-exists`, `branch-missing`,
 *   `branch-diverged`); or `failed` with the step (`pr-state`, `fetch`, …).
 */
export function attachBatch(input: AttachInput): CutBatchResult {
  const { main, branch } = input;
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
    const layout = runLayout(main, runSlug(branch));
    const pr = openPr(main, branch);
    const created = !reusesBatch(main, layout);
    const fastForwarded = created ? checkOut(main, layout) : false;
    mkdirSync(layout.reports, { recursive: true });
    Object.assign(result, {
      branch: layout.branch,
      base: resolveCommit(main, `refs/heads/${branch}`, 'attach'),
      runRoot: layout.root,
      batch: layout.batch,
      reportDir: layout.reports,
      attach: { created, fastForwarded, pr },
    });
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * The slug of the branch named.
 *
 * @param branch - Short branch name.
 * @returns The slug.
 * @throws Refusal `not-run-batch` unless it is a `ship/` run branch.
 */
function runSlug(branch: string): string {
  const slug = runSlugOf(`refs/heads/${branch}`);
  if (slug === null) {
    throw new Refusal('not-run-batch', 'preconditions', `${branch} is not a ship/ run branch`);
  }
  return slug;
}

/**
 * The branch's open PR.
 *
 * @param main - The main checkout (`gh`'s working directory).
 * @param branch - Short branch name.
 * @returns Its number.
 * @throws StepFailure `pr-state` when `gh` fails or answers unreadably;
 *   Refusal `no-open-pr` naming the state and number otherwise.
 */
function openPr(main: string, branch: string): number {
  const { info, error } = lookupPr(main, branch);
  if (error !== undefined) throw new StepFailure('pr-state', `${branch}: ${error}`);
  if (info.state !== 'open' || info.number === null) {
    const pr = info.number === null ? '' : ` (#${String(info.number)})`;
    throw new Refusal('no-open-pr', 'pr-state', `${branch} has no open PR: ${info.state}${pr}`);
  }
  return info.number;
}

/**
 * Whether the branch is already checked out at the layout's batch.
 *
 * @param main - The main checkout.
 * @param layout - The run's layout.
 * @returns `true` when a registered, non-prunable worktree at the batch
 *   path has the branch; `false` when no worktree has it.
 * @throws Refusal `branch-checked-out` naming the path when it is checked
 *   out anywhere else — a prunable batch entry included.
 */
function reusesBatch(main: string, layout: RunLayout): boolean {
  const ref = `refs/heads/${layout.branch}`;
  const entry = listWorktrees(main, 'preconditions').find((w) => w.branch === ref);
  if (entry === undefined) return false;
  if (samePath(entry.path, layout.batch) && !entry.prunable) return true;
  const state = entry.prunable ? ' (prunable)' : '';
  throw new Refusal(
    'branch-checked-out',
    'preconditions',
    `${layout.branch} is checked out at ${entry.path}${state}, not ${layout.batch}`,
  );
}

/**
 * Check the branch out at the batch path: from the local branch
 * (fast-forwarded to `origin`'s first when strictly behind), or as a new
 * tracking branch when only `origin` has it.
 *
 * @param main - The main checkout.
 * @param layout - The run's layout.
 * @returns Whether the local branch was fast-forwarded.
 * @throws Refusal `path-exists`, `branch-missing` or `branch-diverged`
 *   before any mutation but the fetch; StepFailure `fetch`, `attach` or
 *   `worktree-add` when git fails.
 */
function checkOut(main: string, layout: RunLayout): boolean {
  const { branch, batch } = layout;
  if (existsSync(batch)) {
    throw new Refusal('path-exists', 'preconditions', `${batch} exists already`);
  }
  fetchOrigin(main);
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const hasLocal = refExists(main, local);
  if (!hasLocal && !refExists(main, remote)) {
    throw new Refusal(
      'branch-missing',
      'preconditions',
      `neither ${branch} nor origin/${branch} exists`,
    );
  }
  if (!hasLocal) {
    git(
      main,
      ['worktree', 'add', '-q', '--track', '-b', branch, batch, `origin/${branch}`],
      'worktree-add',
    );
    return false;
  }
  const fastForwarded = refExists(main, remote) && fastForward(main, local, remote);
  git(main, ['worktree', 'add', '-q', batch, branch], 'worktree-add');
  return fastForwarded;
}

/**
 * Bring the local branch level with `origin`'s when it is strictly behind;
 * leave it when level or ahead (an unpushed resync merge).
 *
 * @param main - The main checkout, freshly fetched.
 * @param local - The local branch's full ref.
 * @param remote - `origin`'s remote-tracking ref.
 * @returns Whether it moved the local branch.
 * @throws Refusal `branch-diverged` when each has commits the other lacks;
 *   StepFailure `attach` when git fails.
 */
function fastForward(main: string, local: string, remote: string): boolean {
  const l = resolveCommit(main, local, 'attach');
  const o = resolveCommit(main, remote, 'attach');
  if (l === o) return false;
  if (isAncestor(main, l, o)) {
    git(main, ['update-ref', local, o, l], 'attach');
    return true;
  }
  if (isAncestor(main, o, l)) return false;
  throw new Refusal(
    'branch-diverged',
    'preconditions',
    `${local} and ${remote} each have commits the other lacks`,
  );
}

/**
 * Whether commit `a` is an ancestor of commit `b`.
 *
 * @param main - The main checkout.
 * @param a - A commit id.
 * @param b - A commit id.
 * @returns `true` when `git merge-base --is-ancestor a b` exits 0.
 * @throws StepFailure `attach` when it exits other than 0 or 1.
 */
function isAncestor(main: string, a: string, b: string): boolean {
  const r = runCaptured('git', ['-C', main, 'merge-base', '--is-ancestor', a, b], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  throw new StepFailure('attach', `git merge-base --is-ancestor ${a} ${b} failed`, r.tail);
}
