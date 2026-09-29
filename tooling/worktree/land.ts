/**
 * `land <batch> <slice-sha> --base <cut-sha> --message-file <f> --log <l>` —
 * the commit queue's single deterministic step (ADR-0045 decision 3): one
 * slice commit becomes exactly one batch commit, or nothing at all.
 *
 * Invariant: nothing is mutated before four guards pass — the batch is a
 * registered linked worktree the CLI does not run from, it is clean with no
 * operation in progress (harvest's own guards, reused), it has a `ship/`
 * run branch checked out (cut-slice's guard, reused), and the slice is
 * exactly one commit whose parent is the cut. Once the harvest has staged
 * the slice, every outcome other than `ok` ends in harvest's rollback and a
 * batch verified clean at its unchanged `HEAD`, or reports `failed` with a
 * `rollback` entry when that cannot be verified.
 *
 * The rollback is harvest's `git reset --hard HEAD`, the one exception to
 * `.claude/rules/git.md` § Commits' `reset --hard` rule: approved by the
 * maintainer on 2026-09-28 for the run's own batch worktree only, never the
 * main checkout, and only once the guards above held (git.md § Harvested
 * slices). A commit killed at its budget can leave `index.lock` behind; the
 * rollback then fails, or `batchClean` re-verifies `false`, and the caller
 * halts the epic. A lock file is never deleted here. On Windows the kill
 * reaches only `git` (`exec.ts`): its hook tree may still be running in the
 * batch when `land` returns.
 *
 * Its two long spawns name their budgets (`exec.ts`): the build runs under
 * `NPM_TIMEOUT_MS`, the commit — whose pre-commit hook runs the commit
 * gate — under `COMMIT_TIMEOUT_MS` (`commitWithHooks`, `git.ts`).
 */

import { assertRunBatch } from './cut.js';
import { NPM_TIMEOUT_MS, runStep } from './exec.js';
import { commitWithHooks, git, resolveCommit } from './git.js';
import {
  assertBatchClean,
  assertLinkedWorktree,
  batchResidue,
  harvest,
  rollback,
} from './harvest.js';
import { compareSets, formatDifference, stagedPaths } from './staged-set.js';
import type { LandResult } from './types-run.js';
import { Refusal, recordFailure } from './types.js';

/** Inputs of {@link land}; paths absolute with forward slashes. */
export interface LandInput {
  /** The batch worktree. */
  readonly batch: string;
  /** The slice commit, any commit-ish. */
  readonly sha: string;
  /** The batch commit the slice was cut from, any commit-ish. */
  readonly base: string;
  /** The commit message file, passed to `git commit -F`. */
  readonly messageFile: string;
  /**
   * Where the commit's whole output (its hooks' included) is written; a
   * failed write never fails the landing (`writeLog` in `exec.ts`).
   */
  readonly logFile: string;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/** Repository-relative prefixes whose change makes `dist/` stale. */
const BUILD_PREFIXES = ['src/', 'tooling/'] as const;

/**
 * Land one slice commit on the batch, keeping the file header's invariant.
 *
 * @param input - Batch, slice commit, cut, message and log files.
 * @returns The envelope: `ok` with the new `commit`; `refused` before any
 *   mutation (harvest's reasons, `not-run-batch`, or
 *   `slice-not-single-commit`); `conflict`
 *   rolled back; or `failed` with the step (`build`, `commit`, …).
 *   `batchClean` is re-verified on every outcome.
 */
export function land(input: LandInput): LandResult {
  const { batch, selfPath = import.meta.filename } = input;
  const result: LandResult = {
    command: 'land',
    status: 'ok',
    worktree: batch,
    errors: [],
    sha: null,
    commit: null,
    files: [],
    conflicts: [],
    rolledBack: false,
    batchClean: false,
  };
  let staged = false;
  try {
    assertLinkedWorktree(batch, selfPath);
    assertRunBatch(batch);
    assertBatchClean(batch);
    result.sha = assertSingleCommit(batch, input.sha, input.base);
    staged = pick(result, batch, result.sha, selfPath);
    if (staged) {
      assertStagedSet(batch, result.files);
      if (needsBuild(result.files)) {
        runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
      }
      commitWithHooks(batch, ['-F', input.messageFile], input.logFile);
      staged = false;
      result.commit = git(batch, ['rev-parse', 'HEAD'], 'commit');
    }
  } catch (err) {
    recordFailure(result, err);
    if (staged) rollback(batch, result);
  }
  result.batchClean = isClean(batch);
  return result;
}

/**
 * Require the slice to be exactly one commit on top of the cut: `cut..sha`
 * holds one commit, and that commit's only parent is the cut.
 *
 * @param batch - The batch worktree (shares the object database).
 * @param sha - The slice commit.
 * @param base - The cut.
 * @returns The slice commit's full sha.
 * @throws StepFailure `preconditions` when either does not resolve to a
 *   commit; Refusal `slice-not-single-commit` otherwise.
 */
function assertSingleCommit(batch: string, sha: string, base: string): string {
  const full = resolveCommit(batch, sha, 'preconditions');
  const cut = resolveCommit(batch, base, 'preconditions');
  const count = Number(git(batch, ['rev-list', '--count', `${cut}..${full}`], 'preconditions'));
  const parents = git(batch, ['rev-list', '--parents', '-n', '1', full], 'preconditions')
    .split(' ')
    .slice(1);
  if (count !== 1 || parents.length !== 1 || parents[0] !== cut) {
    throw new Refusal(
      'slice-not-single-commit',
      'preconditions',
      `slice ${full} is ${String(count)} commit(s) on the cut ${cut} with parent(s) ` +
        `[${parents.join(', ')}]; land takes exactly one commit whose only parent is the cut`,
    );
  }
  return full;
}

/**
 * Harvest the slice and copy its outcome onto the envelope.
 *
 * @param result - Envelope; gains the harvest's `files`, `conflicts` and
 *   `rolledBack`, and on a non-`ok` harvest its status, reason and errors.
 * @param batch - The batch worktree.
 * @param sha - The resolved slice commit.
 * @param selfPath - The running CLI's file.
 * @returns `true` when the slice is staged; `false` when the harvest failed
 *   (it rolled back itself).
 */
function pick(result: LandResult, batch: string, sha: string, selfPath: string): boolean {
  const h = harvest({ batch, sha, selfPath });
  result.files = h.files;
  result.conflicts = h.conflicts;
  result.rolledBack = h.rolledBack;
  if (h.status === 'ok') return true;
  result.status = h.status;
  if (h.reason !== undefined) result.reason = h.reason;
  result.errors.push(...h.errors);
  return false;
}

/**
 * Require the staged set to equal the harvested paths, a rename as both
 * endpoints (`.claude/rules/git.md` § Direct commits step 3).
 *
 * @param batch - The batch worktree.
 * @param files - The harvest's `files`.
 * @throws Refusal `staged-mismatch` naming both differences.
 */
function assertStagedSet(batch: string, files: readonly string[]): void {
  const diff = compareSets(files, stagedPaths(batch, 'staged-set'));
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    throw new Refusal(
      'staged-mismatch',
      'staged-set',
      `staged set differs from the harvest — ${formatDifference(diff)}`,
    );
  }
}

/**
 * Whether a change touches a path the batch's `dist/` is built from: the
 * pre-commit `manifest-coverage` job reads `dist/api-manifest.json`, which
 * only `npm run build` writes. `sync-master` asks it of what the merge brings.
 *
 * @param files - Repository-relative paths changed.
 * @returns `true` when any lies under {@link BUILD_PREFIXES}.
 */
export function needsBuild(files: readonly string[]): boolean {
  return files.some((file) => BUILD_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

/**
 * Re-verify the batch clean, never throwing.
 *
 * @param batch - The batch worktree.
 * @returns `true` when its status is empty and no operation is in progress;
 *   `false` otherwise, or when git cannot tell.
 */
function isClean(batch: string): boolean {
  try {
    return batchResidue(batch, 'batch-clean').length === 0;
  } catch {
    return false;
  }
}
