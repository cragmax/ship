/**
 * `harvest <batch> <slice-sha>`: stage one slice commit's change (`sha^..sha`) in the batch,
 * uncommitted, via `git cherry-pick --no-commit` (Ship ADR-0001 decision 7).
 *
 * Invariant: nothing is mutated before two guards pass (a registered non-primary worktree root,
 * clean, no merge, cherry-pick, or revert in progress). Once the pick starts, every non-`ok`
 * outcome ends in the rollback and a batch verified clean at its unchanged `HEAD`. A failed or
 * unclean rollback reports `failed` with a `rollback` entry after the triggering error, never
 * `conflict` over a dirty batch, which a scheduler would requeue onto.
 *
 * The rollback is `git reset --hard HEAD`, Ship ADR-0001 decision 10's approved exception: the
 * guards verified a clean linked worktree, so it discards only the failed pick's changes.
 */

import { ESLINT_SUPPRESSIONS } from '../../core/generated-files.js';
import { sortedSet } from '../../../../tooling/lib/strings.js';

import { runCaptured } from '../git/exec.js';
import {
  assertNotSelfHosted,
  git,
  gitPaths,
  refExists,
  requireWorktreeRoot,
  resolveCommit,
  samePath,
  statusEntries,
} from '../git/git.js';
import { regenerateSuppressions } from './regenerate-suppressions.js';
import { compareSets, formatDifference, stagedPaths } from '../git/staged-set.js';
import {
  Conflict,
  Refusal,
  recordFailure,
  StepFailure,
  type HarvestResult,
  type ResultBase,
} from '../envelope/types.js';

/** Per-worktree refs whose presence means an operation is in progress. */
const IN_PROGRESS_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;

/** Inputs of {@link harvest}. */
interface HarvestInput {
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
 * Accepted residual: a force-added path the batch holds ignored is overwritten, and rollback
 * deletes it (unprobed).
 *
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
 * @throws Refusal `unregistered-worktree` when the target is missing,
 *   outside any repository, or only a subdirectory of a worktree; Refusal
 *   `main-worktree` when it is the main worktree (a separate repository's
 *   root is its own main worktree, so it lands here too); Refusal
 *   `self-hosted` from {@link assertNotSelfHosted}.
 */
export function assertLinkedWorktree(batch: string, selfPath: string): void {
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
 * cannot clean a dirty batch.
 *
 * @throws Refusal `batch-dirty` naming the status entries or the
 *   in-progress refs.
 */
export function assertBatchClean(batch: string): void {
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
 * Reset the batch to `HEAD` after a failed pick and verify it clean (the
 * header's rationale for `--hard`). Sets `rolledBack` only once verified.
 *
 * @param batch - The batch worktree, verified by {@link assertLinkedWorktree}
 *   and {@link assertBatchClean} before anything was staged in it: the
 *   precondition of the approved `--hard`. Never call it otherwise. The
 *   linked-root half is re-checked before the reset ({@link assertResettable}).
 * @param result - Envelope. On a failed or unclean rollback its status
 *   becomes `failed` and `errors` gains a `rollback` entry.
 */
export function rollback(batch: string, result: ResultBase & { rolledBack: boolean }): void {
  try {
    assertResettable(batch);
    git(batch, ['reset', '-q', '--hard', 'HEAD'], 'rollback');
    assertRolledBackClean(batch);
    result.rolledBack = true;
  } catch (err) {
    recordFailure(result, err);
  }
}

/**
 * What keeps the batch from being clean: its status entries, then the
 * in-progress refs present.
 *
 * @returns The residue, empty when the batch is clean.
 * @throws StepFailure for `step` when git cannot report the status.
 */
export function batchResidue(batch: string, step: string): string[] {
  return [...statusEntries(batch, step), ...inProgressRefs(batch)];
}

/**
 * Re-check at the reset that its target is a linked worktree root: the `--hard` approval never
 * covers the main worktree.
 *
 * @throws StepFailure `rollback` when it is not a worktree root, or is the main worktree.
 */
function assertResettable(batch: string): void {
  if (samePath(requireWorktreeRoot(batch, 'rollback').main, batch)) {
    throw new StepFailure('rollback', `refusing git reset --hard in the main worktree ${batch}`);
  }
}

/**
 * Require the staged set to equal `files`: catches an empty pick and a silently dropped path.
 *
 * @throws StepFailure `staged-check` naming the differences, not a conflict: a requeue repeats it.
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
 * Require the tree to match the index.
 *
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
 * Apply the slice commit to the batch's index and tree, uncommitted.
 * @throws Conflict naming the unmerged paths, unless only `eslint-suppressions.json` conflicts
 *   ({@link regenerateSuppressions}); StepFailure on a non-zero exit with none (e.g. `index.lock`).
 */
function cherryPick(batch: string, sha: string): void {
  const r = runCaptured('git', ['-C', batch, 'cherry-pick', '--no-commit', sha], {
    cwd: process.cwd(),
  });

  if (r.exitCode === 0) return;
  const unmerged = gitPaths(batch, ['diff', '--name-only', '--diff-filter=U'], 'cherry-pick');
  const message = `git cherry-pick --no-commit ${sha} exited ${String(r.exitCode)} in ${batch}`;

  if (unmerged.length > 0 && unmerged.every((p) => p === ESLINT_SUPPRESSIONS)) {
    regenerateSuppressions(batch);

    return;
  }

  if (unmerged.length > 0) {
    throw new Conflict('cherry-pick', message, sortedSet(unmerged), r.tail);
  }

  throw new StepFailure('cherry-pick', message, r.tail);
}

/**
 * The paths the slice commit changes against its parent, a rename as both endpoints, sorted by
 * code unit.
 *
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
 * Resolve the slice commit to a full sha, requiring one parent.
 *
 * @throws StepFailure `preconditions` unless it resolves to a commit with exactly one parent.
 */
function resolveSlice(batch: string, sha: string): string {
  const full = resolveCommit(batch, sha, 'preconditions');
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

/** The in-progress refs present in the batch. */
function inProgressRefs(batch: string): string[] {
  return IN_PROGRESS_REFS.filter((ref) => refExists(batch, ref));
}

/**
 * Verify the batch is clean after the reset.
 *
 * @throws StepFailure `rollback` naming the residue.
 */
function assertRolledBackClean(batch: string): void {
  const residue = batchResidue(batch, 'rollback');

  if (residue.length > 0) {
    throw new StepFailure('rollback', `batch not clean after rollback: ${residue.join(', ')}`);
  }
}
