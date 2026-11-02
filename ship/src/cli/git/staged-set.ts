/**
 * `staged-guard <worktree> <file>…`: the staged set of a worktree must
 * equal a caller's list exactly, before a commit, so no stray path rides
 * along and no intended one is left out. Read-only, so it runs in any
 * worktree, the main checkout included, and has no self-hosted guard.
 *
 * Paths compare by exact code unit on every platform, never case-folded:
 * after a harvest, a reset plus add-by-name under `core.ignorecase=true`
 * drops a case-only rename's both endpoints from the index (git 2.55
 * win32, observed 2026-09-28), and a case-folded compare passes that loss.
 */

import { sortedSet, toPosix } from '../../../../tooling/lib/strings.js';

import { gitPaths, requireWorktreeRoot } from './git.js';
import { Refusal, recordFailure, type StagedGuardResult } from '../envelope/types.js';

/** A mismatch between an expected and an actual path set. */
interface SetDifference {
  /** Expected but absent, sorted. */
  readonly missing: string[];
  /** Present but not expected, sorted. */
  readonly unexpected: string[];
}

/**
 * Render a {@link SetDifference} for an error message.
 *
 * @returns `missing: [..]; unexpected: [..]`, each list comma-separated.
 */
export function formatDifference(diff: SetDifference): string {
  return `missing: [${diff.missing.join(', ')}]; unexpected: [${diff.unexpected.join(', ')}]`;
}

/**
 * The staged paths of a checkout. `--no-renames` lists a rename as both
 * endpoints, so it matches a list that names both.
 *
 * @param step - Step name reported on failure.
 * @returns The staged paths, sorted and distinct.
 * @throws StepFailure for `step` when git fails.
 */
export function stagedPaths(dir: string, step: string): string[] {
  return sortedSet(gitPaths(dir, ['diff', '--cached', '--name-only', '--no-renames'], step));
}

/**
 * Compare two path sets by exact code unit (see the file header).
 *
 * @returns Both one-sided differences, sorted and distinct, both empty when
 *   the sets are equal.
 */
export function compareSets(expected: readonly string[], actual: readonly string[]): SetDifference {
  const want = new Set(expected);
  const have = new Set(actual);

  return {
    missing: sortedSet(expected.filter((p) => !have.has(p))),
    unexpected: sortedSet(actual.filter((p) => !want.has(p))),
  };
}

/**
 * Check a worktree's staged set against the expected list.
 *
 * @param input - `worktree`: any worktree root; `files`: the expected
 *   repo-relative paths, each through {@link normaliseRepoPath}.
 * @returns The envelope: `ok` when the sets are equal; `refused`
 *   `staged-mismatch` naming `missing` and `unexpected` otherwise; `failed`
 *   `preconditions` when `worktree` is not a worktree root, or `staged-set`
 *   when git cannot list the staged paths.
 */
export function stagedGuard(input: {
  readonly worktree: string;
  readonly files: readonly string[];
}): StagedGuardResult {
  const { worktree } = input;
  const result: StagedGuardResult = {
    command: 'staged-guard',
    status: 'ok',
    worktree,
    errors: [],
    expected: sortedSet(input.files.map(normaliseRepoPath)),
    staged: [],
    missing: [],
    unexpected: [],
  };

  try {
    requireWorktreeRoot(worktree, 'preconditions');
    result.staged = stagedPaths(worktree, 'staged-set');
    Object.assign(result, compareSets(result.expected, result.staged));
    assertEqualSets(result);
  } catch (err) {
    recordFailure(result, err);
  }

  return result;
}

/**
 * A caller-given repo-relative path in git's spelling: backslashes become forward slashes and a
 * leading `./` is dropped. Case and absolute paths are left alone, to fail loudly as `missing`.
 */
function normaliseRepoPath(path: string): string {
  let out = toPosix(path);
  while (out.startsWith('./')) out = out.slice(2);

  return out;
}

/**
 * Refuse when the compared sets differ.
 *
 * @param result - Envelope with `missing` and `unexpected` filled.
 * @throws Refusal `staged-mismatch` naming both differences.
 */
function assertEqualSets(result: StagedGuardResult): void {
  if (result.missing.length === 0 && result.unexpected.length === 0) return;

  throw new Refusal(
    'staged-mismatch',
    'staged-set',
    `staged set differs from the expected list — ${formatDifference(result)}`,
  );
}
