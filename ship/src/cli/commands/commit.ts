/**
 * `commit --message-file <f> -- <path>…` — an interactive session's commit, run from the root of
 * the checkout it commits in: exactly the named paths become one commit under the hooks, or
 * nothing does. The hook output goes to a log in a fresh temp dir, read only on failure.
 */

import { join } from 'node:path';

import { sortedSet, toPosix } from '../../../../tooling/shared.js';

import { freshLogDir } from '../git/exec.js';
import { commitWithHooks, git, refExists, requireWorktreeRoot } from '../git/git.js';
import {
  compareSets,
  formatDifference,
  normaliseRepoPath,
  stagedPaths,
} from '../git/staged-set.js';
import { Refusal, recordFailure, type CommitResult } from '../envelope/types.js';

/** Inputs of {@link commit}; paths absolute with forward slashes, `files` repo-relative. */
interface CommitInput {
  /** The checkout root. */
  readonly worktree: string;
  /** The commit message file, passed to `git commit -F`. */
  readonly messageFile: string;
  /** The paths to commit, each through {@link normaliseRepoPath}. */
  readonly files: readonly string[];
}

/**
 * Commit exactly `files`: reset the index (mixed, never `--hard`), stage them by name, require the
 * staged set to equal them, then commit with the hooks.
 *
 * @returns The envelope: `ok` with the new `commit`; `refused` `merge-in-progress` with the index
 *   untouched, or `staged-mismatch` with the named paths left staged and nothing committed;
 *   `failed` at `preconditions` (not a checkout root), `reset`, `stage` (a path git cannot add) or
 *   `commit` (a hook or git refused; `errors[0].detail` holds the log's tail, no commit made).
 */
export function commit(input: CommitInput): CommitResult {
  const { worktree } = input;
  const result: CommitResult = {
    command: 'commit',
    status: 'ok',
    worktree,
    errors: [],
    files: sortedSet(input.files.map(normaliseRepoPath)),
    commit: null,
    log: null,
  };
  try {
    requireWorktreeRoot(worktree, 'preconditions');
    assertNoMerge(worktree);
    git(worktree, ['reset', '-q'], 'reset');
    git(worktree, ['add', '--', ...result.files], 'stage');
    assertStagedSet(worktree, result.files);
    result.log = toPosix(join(freshLogDir('commit'), 'commit.log'));
    commitWithHooks(worktree, ['-F', input.messageFile], result.log);
    result.commit = git(worktree, ['rev-parse', 'HEAD'], 'commit');
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Refuse while a merge is in progress: a reset would delete `MERGE_HEAD`, and the commit would
 * lose its second parent.
 *
 * @throws Refusal `merge-in-progress`.
 */
function assertNoMerge(worktree: string): void {
  if (!refExists(worktree, 'MERGE_HEAD')) return;
  throw new Refusal(
    'merge-in-progress',
    'preconditions',
    `${worktree} has a merge in progress; stage its resolutions by name and run git commit --no-edit`,
  );
}

/**
 * Require the staged set to equal the named paths, a rename as both endpoints.
 *
 * @throws Refusal `staged-mismatch` naming both differences.
 */
function assertStagedSet(worktree: string, files: readonly string[]): void {
  const diff = compareSets(files, stagedPaths(worktree, 'staged-set'));
  if (diff.missing.length === 0 && diff.unexpected.length === 0) return;
  throw new Refusal(
    'staged-mismatch',
    'staged-set',
    `staged set differs from the named paths — ${formatDifference(diff)}`,
  );
}
