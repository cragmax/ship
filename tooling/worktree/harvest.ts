/**
 * `harvest <batch> <slice-sha>` — the commit queue's transport step: stage
 * exactly one slice commit's change (`sha^..sha`) in the batch worktree,
 * uncommitted, via `git cherry-pick --no-commit` (ADR-0045 decision 3).
 *
 * Invariant: nothing is mutated before the two guards pass — the target is
 * a registered non-primary worktree root, and its tree is clean with no
 * merge, cherry-pick or revert in progress. Once the pick starts, every
 * outcome other than `ok` ends in the rollback and a batch verified clean
 * at its unchanged `HEAD`; a rollback that fails or leaves residue reports
 * `failed` instead, with a `rollback` entry after the error that triggered
 * it — never `conflict` over a dirty batch, which a scheduler would requeue
 * onto.
 *
 * The rollback is `git reset --hard HEAD`, a deliberate departure from
 * `.claude/rules/git.md` § Commits (no `git reset --hard` without explicit
 * approval) and § Direct commits step 1 (a mixed reset, never `--hard`).
 * The maintainer approved it for this tool on 2026-09-28, on condition of
 * the two guards above: with the target verified a clean linked worktree
 * before the pick, `--hard` discards only the failed pick's own changes.
 * The alternatives fail (git 2.55 win32, observed 2026-09-28):
 * `git reset --merge` leaves the batch's own file deleted after a case
 * collision (` D foo.txt`), and `git cherry-pick --abort` has nothing to
 * abort — `--no-commit` writes no `CHERRY_PICK_HEAD`.
 *
 * Known limitation, not guarded: a slice that force-adds a path the batch
 * holds as an ignored untracked file overwrites that file silently, and a
 * rollback then deletes it.
 */

import { runCaptured } from './exec.js';
import {
  assertNotSelfHosted,
  git,
  gitPaths,
  refExists,
  requireWorktreeRoot,
  samePath,
  statusEntries,
} from './git.js';
import { compareSets, formatDifference, sortedSet, stagedPaths } from './staged-set.js';
import { Conflict, Refusal, recordFailure, StepFailure, type HarvestResult } from './types.js';

/** Per-worktree refs whose presence means an operation is in progress. */
const IN_PROGRESS_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;

/** Inputs of {@link harvest}. */
export interface HarvestInput {
  /** Absolute forward-slash path of the batch worktree. */
  readonly batch: string;
  /** The slice commit, any commit-ish. */
  readonly sha: string;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Harvest one slice commit into the batch, keeping the file header's
 * invariant.
 *
 * @param input - Batch, slice commit, and the self-hosted seam.
 * @returns The envelope: `ok` with the slice's paths staged; `conflict`
 *   with the paths that would not apply and the batch rolled back;
 *   `refused` before any mutation; or `failed` with the step.
 */
export function harvest(input: HarvestInput): HarvestResult {
  const { batch, sha, selfPath = import.meta.filename } = input;
  const result: HarvestResult = {
    command: 'harvest',
    status: 'ok',
    worktree: batch,
    errors: [],
    sha: null,
    files: [],
    conflicts: [],
    rolledBack: false,
  };
  let picking = false;
  try {
    assertLinkedWorktree(batch, selfPath);
    assertBatchClean(batch);
    result.sha = resolveSlice(batch, sha);
    result.files = sliceFiles(batch, result.sha);
    picking = true;
    cherryPick(batch, result.sha);
    assertAppliedCleanly(batch);
    assertStagedEquals(batch, result.files);
  } catch (err) {
    recordFailure(result, err);
    if (err instanceof Conflict) result.conflicts = [...err.files];
    if (picking) rollback(batch, result);
  }
  return result;
}

/**
 * Refuse unless the target is a registered worktree root other than the
 * repository's main worktree, and the CLI does not run from inside it.
 *
 * @param batch - The harvest target.
 * @param selfPath - The running CLI's file.
 * @throws Refusal `unregistered-worktree` when the target is missing,
 *   outside any repository, or only a subdirectory of a worktree; Refusal
 *   `main-worktree` when it is the main worktree (a separate repository's
 *   root is its own main worktree, so it lands here too); Refusal
 *   `self-hosted` from {@link assertNotSelfHosted}.
 */
function assertLinkedWorktree(batch: string, selfPath: string): void {
  let main: string;
  try {
    main = requireWorktreeRoot(batch, 'preconditions').main;
  } catch (err) {
    if (!(err instanceof StepFailure)) throw err;
    throw new Refusal('unregistered-worktree', 'preconditions', err.message, err.detail);
  }
  if (samePath(main, batch)) {
    throw new Refusal('main-worktree', 'preconditions', `${batch} is the main worktree`);
  }
  assertNotSelfHosted(batch, selfPath);
}

/**
 * Refuse unless the batch is clean: the rollback's `reset --hard` would
 * destroy pre-existing work, or a merge's second parent, and a requeue
 * cannot clean a dirty batch. `git status` alone is not enough — mid-merge
 * its porcelain can be empty while `MERGE_HEAD` exists (git 2.55, observed
 * 2026-09-28).
 *
 * @param batch - The batch worktree.
 * @throws Refusal `batch-dirty` naming the status entries or the
 *   in-progress refs.
 */
function assertBatchClean(batch: string): void {
  const entries = statusEntries(batch, 'preconditions');
  if (entries.length > 0) {
    throw new Refusal(
      'batch-dirty',
      'preconditions',
      `batch has uncommitted changes: ${entries.join(', ')}`,
    );
  }
  const inProgress = inProgressRefs(batch);
  if (inProgress.length > 0) {
    throw new Refusal(
      'batch-dirty',
      'preconditions',
      `batch has an operation in progress: ${inProgress.join(', ')}`,
    );
  }
}

/**
 * The in-progress refs present in the batch.
 *
 * @param batch - The batch worktree.
 * @returns The present subset of {@link IN_PROGRESS_REFS}.
 */
function inProgressRefs(batch: string): string[] {
  return IN_PROGRESS_REFS.filter((ref) => refExists(batch, ref));
}

/**
 * Resolve the slice commit and require exactly one parent: `sha^..sha` is
 * undefined for a root commit, and cherry-pick refuses a merge commit
 * without `-m`.
 *
 * @param batch - The batch worktree (shares the object database).
 * @param sha - Any commit-ish.
 * @returns The full sha.
 * @throws StepFailure `preconditions` when it does not resolve to a commit
 *   or does not have exactly one parent.
 */
function resolveSlice(batch: string, sha: string): string {
  const full = git(
    batch,
    ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
    'preconditions',
  );
  const parents =
    git(batch, ['rev-list', '--parents', '-n', '1', full], 'preconditions').split(' ').length - 1;
  if (parents !== 1) {
    throw new StepFailure(
      'preconditions',
      `slice commit ${full} has ${String(parents)} parents; harvest takes a single-parent commit`,
    );
  }
  return full;
}

/**
 * The paths the slice commit changes against its parent, a rename as both
 * endpoints.
 *
 * @param batch - The batch worktree.
 * @param sha - The resolved slice commit.
 * @returns The paths, sorted by code unit.
 * @throws StepFailure `preconditions` when the commit changes nothing.
 */
function sliceFiles(batch: string, sha: string): string[] {
  const files = sortedSet(
    gitPaths(
      batch,
      ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', sha],
      'preconditions',
    ),
  );
  if (files.length === 0) {
    throw new StepFailure('preconditions', `slice commit ${sha} changes nothing`);
  }
  return files;
}

/**
 * Apply the slice commit to the batch's index and tree, uncommitted.
 *
 * @param batch - The batch worktree.
 * @param sha - The resolved slice commit.
 * @throws Conflict `cherry-pick` naming the unmerged paths; StepFailure
 *   `cherry-pick` when git exits non-zero with none (an environment
 *   failure such as a held `index.lock`, which a requeue would not fix).
 */
function cherryPick(batch: string, sha: string): void {
  const r = runCaptured('git', ['-C', batch, 'cherry-pick', '--no-commit', sha], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return;
  const unmerged = gitPaths(batch, ['diff', '--name-only', '--diff-filter=U'], 'cherry-pick');
  const message = `git cherry-pick --no-commit ${sha} exited ${String(r.exitCode)} in ${batch}`;
  if (unmerged.length > 0) {
    throw new Conflict('cherry-pick', message, sortedSet(unmerged), r.tail);
  }
  throw new StepFailure('cherry-pick', message, r.tail);
}

/**
 * Require the worktree to match the index after the pick: a slice adding
 * `Foo.txt` to a batch tracking `foo.txt` picks with exit 0 and a correct
 * staged set, but on a case-insensitive filesystem overwrites `foo.txt`,
 * which then shows as modified (git 2.55 win32, observed 2026-09-28).
 *
 * @param batch - The batch worktree.
 * @throws Conflict `applied-check` naming every unstaged or untracked path.
 */
function assertAppliedCleanly(batch: string): void {
  const stray = sortedSet([
    ...gitPaths(batch, ['diff', '--name-only'], 'applied-check'),
    ...gitPaths(batch, ['ls-files', '--others', '--exclude-standard'], 'applied-check'),
  ]);
  if (stray.length > 0) {
    throw new Conflict(
      'applied-check',
      `the pick left the worktree differing from the index: ${stray.join(', ')}`,
      stray,
    );
  }
}

/**
 * Require the staged set to equal the slice's paths — catches an empty
 * pick (the change is already on the batch) and any silently dropped path.
 *
 * @param batch - The batch worktree.
 * @param files - The slice's paths.
 * @throws StepFailure `staged-check` naming the differences — not a
 *   conflict, since a requeue would repeat it.
 */
function assertStagedEquals(batch: string, files: readonly string[]): void {
  const diff = compareSets(files, stagedPaths(batch, 'staged-check'));
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    throw new StepFailure(
      'staged-check',
      `staged set differs from the slice — ${formatDifference(diff)}`,
    );
  }
}

/**
 * Reset the batch to `HEAD` after a failed pick and verify it clean (the
 * header's rationale for `--hard`). Sets `rolledBack` only once verified.
 *
 * @param batch - The batch worktree, verified clean and linked before the pick.
 * @param result - Envelope; on a failed or unclean rollback its status
 *   becomes `failed` and `errors` gains a `rollback` entry.
 */
function rollback(batch: string, result: HarvestResult): void {
  try {
    git(batch, ['reset', '-q', '--hard', 'HEAD'], 'rollback');
    assertRolledBackClean(batch);
    result.rolledBack = true;
  } catch (err) {
    recordFailure(result, err);
  }
}

/**
 * Verify the batch is clean after the reset.
 *
 * @param batch - The batch worktree.
 * @throws StepFailure `rollback` naming the residue.
 */
function assertRolledBackClean(batch: string): void {
  const residue = [...statusEntries(batch, 'rollback'), ...inProgressRefs(batch)];
  if (residue.length > 0) {
    throw new StepFailure('rollback', `batch not clean after rollback: ${residue.join(', ')}`);
  }
}
