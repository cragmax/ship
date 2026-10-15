/**
 * `changed-files <worktree> <sha> --base <base>` — the paths a range changes (`base..sha`), as the
 * slice chain re-reads them after a review amends the slice commit (ADR-0045).
 *
 * Read-only: no self-hosted guard.
 */

import { gitPaths, resolveCommit } from './git.js';
import { sortedSet } from './staged-set.js';
import type { ChangedFilesResult } from './types-run.js';
import { recordFailure } from './types.js';

/** Inputs of {@link changedFiles}. */
export interface ChangedFilesInput {
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
