/**
 * `bump <batch>` — the run's one version bump (`.claude/rules/git.md`
 * § Unattended workflow runs): read the batch's own commits since it left
 * `origin/master`, bump `minor` for any `feat`, else `patch`, and commit
 * `package.json` and the lockfile through § Direct commits steps 1–4,
 * the message carrying the run's {@link CO_AUTHOR_TRAILER}.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { CO_AUTHOR_TRAILER } from '../lib/commit-trailer.js';

import { assertRunBatch } from './cut.js';
import { freshLogDir, NPM_TIMEOUT_MS, runStep } from './exec.js';
import { commitWithHooks, git } from './git.js';
import { assertBatchClean, assertLinkedWorktree } from './harvest.js';
import { RUN_UPSTREAM } from './run-layout.js';
import { compareSets, formatDifference, stagedPaths } from './staged-set.js';
import type { BumpResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure } from './types.js';

/** The two files a bump changes, sorted. */
const BUMP_FILES = ['package-lock.json', 'package.json'] as const;

/** A subject that makes the bump `minor`. */
const FEAT_SUBJECT = /^feat[(!:]/u;

/** The bump commit's subject, before the ` — <slug>` suffix. */
const BUMP_SUBJECT = 'chore(build): bump version';

/** Inputs of {@link bump}. */
export interface BumpInput {
  /** The batch worktree, absolute with forward slashes. */
  readonly batch: string;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Bump the batch's version in one commit.
 *
 * @param input - The batch and the self-hosted seam.
 * @returns The envelope: `ok` with `kind`, `from`, `to`, `commit` and
 *   `log`; `refused` before any mutation (harvest's linked-worktree
 *   reasons, `not-run-batch`, `batch-dirty`, `nothing-to-bump`,
 *   `already-bumped`) or after staging (`staged-mismatch`); or `failed`
 *   with the step (`version`, `stage`, `commit`, …). Once `npm version`
 *   has started, every outcome but `ok` restores both files to `HEAD`,
 *   leaving the batch clean; a failed restore adds a `restore` error.
 */
export function bump(input: BumpInput): BumpResult {
  const { batch, selfPath = import.meta.filename } = input;
  const result: BumpResult = {
    command: 'bump',
    status: 'ok',
    worktree: batch,
    errors: [],
    kind: null,
    from: null,
    to: null,
    commit: null,
    log: null,
  };
  let versioned = false;
  try {
    assertLinkedWorktree(batch, selfPath);
    const slug = assertRunBatch(batch);
    assertBatchClean(batch);
    const subjects = ownSubjects(batch);
    assertBumpable(subjects);
    result.kind = subjects.some((s) => FEAT_SUBJECT.test(s)) ? 'minor' : 'patch';
    result.from = packageVersion(batch);
    versioned = true;
    runStep('version', 'npm', ['version', result.kind, '--no-git-tag-version'], {
      cwd: batch,
      timeoutMs: NPM_TIMEOUT_MS,
    });
    result.to = packageVersion(batch);
    stageBump(batch);
    const dir = freshLogDir('bump');
    result.log = `${dir}/commit.log`;
    writeFileSync(`${dir}/message.txt`, `${BUMP_SUBJECT} — ${slug}\n\n${CO_AUTHOR_TRAILER}\n`);
    commitWithHooks(batch, ['-F', `${dir}/message.txt`], result.log);
    result.commit = git(batch, ['rev-parse', 'HEAD'], 'commit');
  } catch (err) {
    recordFailure(result, err);
    if (versioned && result.commit === null) restore(batch, result);
  }
  return result;
}

/**
 * Refuse a batch with nothing to bump, or one bumped already.
 *
 * @param subjects - The batch's own non-merge subjects.
 * @throws Refusal `nothing-to-bump` when there are none; Refusal
 *   `already-bumped` when one starts with {@link BUMP_SUBJECT}.
 */
function assertBumpable(subjects: readonly string[]): void {
  if (subjects.length === 0) {
    throw new Refusal('nothing-to-bump', 'subjects', `no commits of its own since ${RUN_UPSTREAM}`);
  }
  const bumped = subjects.find((s) => s.startsWith(BUMP_SUBJECT));
  if (bumped !== undefined) {
    throw new Refusal('already-bumped', 'subjects', `already bumped: '${bumped}'`);
  }
}

/**
 * Put both files back at `HEAD`, index and worktree, after a failed bump —
 * the batch was verified clean before it, so only the bump's change goes.
 *
 * @param batch - The batch worktree.
 * @param result - Envelope; a failed restore adds a `restore` error.
 */
function restore(batch: string, result: BumpResult): void {
  try {
    git(batch, ['checkout', 'HEAD', '--', ...BUMP_FILES], 'restore');
  } catch (err) {
    recordFailure(result, err);
  }
}

/**
 * The subjects of the batch's own non-merge commits since it left
 * `origin/master`.
 *
 * @param batch - The batch worktree.
 * @returns The subjects, newest first.
 * @throws StepFailure `subjects` when git fails.
 */
function ownSubjects(batch: string): string[] {
  const mergeBase = git(batch, ['merge-base', 'HEAD', RUN_UPSTREAM], 'subjects');
  return git(batch, ['log', '--no-merges', '--format=%s', `${mergeBase}..HEAD`], 'subjects')
    .split(/\r?\n/u)
    .filter((s) => s !== '');
}

/**
 * The batch's `package.json` version.
 *
 * @param batch - The batch worktree.
 * @returns The `version` field.
 * @throws StepFailure `version` when the file is unreadable or has no
 *   string `version`.
 */
function packageVersion(batch: string): string {
  const path = `${batch}/package.json`;
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
  } catch (err) {
    throw new StepFailure(
      'version',
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof version !== 'string') throw new StepFailure('version', `${path} has no version`);
  return version;
}

/**
 * Stage the bump — § Direct commits steps 1–3: reset the index, add the two
 * files by name, check the staged set is exactly them.
 *
 * @param batch - The batch worktree.
 * @throws Refusal `staged-mismatch` naming both differences.
 */
function stageBump(batch: string): void {
  git(batch, ['reset', '-q'], 'stage');
  git(batch, ['add', '--', ...BUMP_FILES], 'stage');
  const diff = compareSets(BUMP_FILES, stagedPaths(batch, 'stage'));
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    throw new Refusal(
      'staged-mismatch',
      'stage',
      `staged set differs from the bump — ${formatDifference(diff)}`,
    );
  }
}
