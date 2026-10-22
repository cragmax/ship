/**
 * `land <batch> <slice-sha> --base <cut-sha> --message-file <f> --log <l>` — the commit queue's
 * one deterministic step: a slice commit becomes exactly one batch commit, or nothing (Ship
 * ADR-0001 decision 10).
 *
 * Invariant: nothing is mutated before four guards pass — harvest's linked-worktree and clean-batch
 * guards, cut-slice's `ship/` run-branch guard, and a slice of exactly one commit whose parent is
 * the cut. Once staged, every non-`ok` outcome ends in harvest's rollback with the batch verified
 * clean at its unchanged `HEAD`, or reports `failed` with a `rollback` entry.
 *
 * The rollback's `reset --hard` is the exception `harvest.ts`' header states. After a commit
 * killed at its budget the rollback may fail or `batchClean` re-verify `false`, and the caller
 * halts the epic; a lock file is never deleted here. A Windows budget kill can leave
 * part of the commit's process tree running (what survives: `exec.ts`' header). The build runs
 * under `NPM_TIMEOUT_MS`, the commit under `COMMIT_TIMEOUT_MS` (`commitWithHooks`, `git.ts`).
 */

import { assertRunBatch } from './cut.js';
import { NPM_TIMEOUT_MS, runStep } from '../git/exec.js';
import { commitWithHooks, git, resolveCommit } from '../git/git.js';
import {
  assertBatchClean,
  assertLinkedWorktree,
  batchResidue,
  harvest,
  rollback,
} from './harvest.js';
import { compareSets, formatDifference, stagedPaths } from '../git/staged-set.js';
import type { LandResult } from '../envelope/types-run.js';
import { Refusal, recordFailure } from '../envelope/types.js';

/** Inputs of {@link land}; paths absolute with forward slashes. */
interface LandInput {
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

/**
 * Land one slice commit on the batch, keeping the file header's invariant.
 *
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
    lines: null,
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
    result.lines = changedLines(batch, result.sha);
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
 * The size the schedule reports: insertions plus deletions over the slice commit's text
 * files; a binary file adds none.
 *
 * @throws StepFailure `preconditions` when git fails.
 */
function changedLines(batch: string, sha: string): number {
  const rows = git(
    batch,
    ['diff-tree', '-r', '--no-commit-id', '--numstat', '--no-renames', sha],
    'preconditions',
  );
  let lines = 0;
  for (const row of rows.split('\n')) {
    const [added = '-', removed = '-'] = row.split('\t');
    lines += (added === '-' ? 0 : Number(added)) + (removed === '-' ? 0 : Number(removed));
  }
  return lines;
}

/**
 * The slice's full sha, once `base..sha` holds one commit whose only parent is `base`, the cut.
 *
 * @throws StepFailure `preconditions` when either does not resolve to a commit; Refusal
 *   `slice-not-single-commit` otherwise.
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
 * Harvest the slice, copying its `files`, `conflicts` and `rolledBack` onto `result`, and on a
 * non-`ok` harvest its status, reason and errors.
 *
 * @returns `true` when staged; `false` when the harvest failed (it rolled back itself).
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
 * Require the staged set to equal the harvest's `files`, a rename as both endpoints
 * (Ship ADR-0001 decision 10).
 *
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

/** The files `npm run build` reads besides `src/`: its script and `tsc`'s config. */
const BUILD_FILES: readonly string[] = ['package.json', 'tsconfig.json'];

/**
 * Whether a change touches a path the batch's `dist/` is built from: the
 * pre-commit tests read `dist/` (the bin, the runtime `.d.ts`), which the
 * gate's `gate:build` re-emits in parallel with them, so the build makes it
 * current first. Only `src/` builds into `dist/` (Framework ADR-0045 decision 6).
 * `sync-master` asks it of what the merge brings.
 *
 * @param files - Repository-relative paths changed.
 * @returns `true` when any lies under `src/` or is one of {@link BUILD_FILES}.
 */
export function needsBuild(files: readonly string[]): boolean {
  return files.some((file) => file.startsWith('src/') || BUILD_FILES.includes(file));
}

/** Re-verify the batch clean, never throwing: `false` when residue remains or git cannot tell. */
function isClean(batch: string): boolean {
  try {
    return batchResidue(batch, 'batch-clean').length === 0;
  } catch {
    return false;
  }
}
