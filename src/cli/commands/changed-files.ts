/**
 * `changed-files <worktree> <sha> --base <base>`: the paths a range changes (`base..sha`), as the
 * slice chain re-reads them after a review amends the slice commit.
 *
 * Read-only: no self-hosted guard.
 */

import { sortedSet } from '../../core/strings.js';

import { gitPaths, resolveCommit } from '../git/git.js';
import type { ChangedFilesResult } from '../envelope/types-run.js';
import { recordFailure } from '../envelope/types.js';

/** Inputs of {@link changedFiles}. */
interface ChangedFilesInput {
  /** Any checkout of the repository, absolute with forward slashes. */
  readonly worktree: string;
  /** The range's start, any commit-ish. */
  readonly base: string;
  /** The range's end, any commit-ish. */
  readonly sha: string;
}

/**
 * List the paths `base..sha` changes.
 *
 * @returns The envelope: `ok` with every changed path, repository-relative, both endpoints of a
 *   rename, in code-unit order; or `failed` at step `resolve` (a commit-ish that names no commit)
 *   or `diff`, its `files` empty.
 */
export function changedFiles(input: ChangedFilesInput): ChangedFilesResult {
  const { worktree } = input;
  const result: ChangedFilesResult = {
    command: 'changed-files',
    status: 'ok',
    worktree,
    errors: [],
    files: [],
  };

  try {
    const base = resolveCommit(worktree, input.base, 'resolve');
    const sha = resolveCommit(worktree, input.sha, 'resolve');
    result.files = sortedSet(
      gitPaths(worktree, ['diff', '--name-only', '--no-renames', base, sha], 'diff'),
    );
  } catch (err) {
    recordFailure(result, err);
  }

  return result;
}
