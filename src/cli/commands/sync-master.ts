/**
 * `sync-master <batch>` merges `origin/master` into the batch. A
 * `git merge-tree` probe refuses a code conflict before merging: a conflict on any path but the
 * lockfile, `package.json`'s version line included. No version is set: a version line both sides
 * changed alike merges as git merges it. A merge that stops on the lockfile alone regenerates it
 * ({@link regenerateLockfile}) before its commit.
 *
 * Invariant: a `failed` envelope never leaves a merge this call started in progress: it is
 * aborted. A failed abort adds an `abort` error. `refused` leaves the batch as found. Nothing is
 * mutated, not even the fetch's remote-tracking refs, before the batch is verified a clean linked
 * worktree, no slice linked in. The merged tree is refreshed before reporting. A refresh failing
 * after a clean merge keeps that commit (`merged`, `commit` / `upstream` set, `install` / `build`
 * failed), no rollback.
 */

import { sortedSet } from '../../core/strings.js';

import {
  COMMIT_TIMEOUT_MS,
  freshLogDir,
  NPM_TIMEOUT_MS,
  runCaptured,
  runStep,
} from '../git/exec.js';
import {
  commitWithHooks,
  fetchOrigin,
  git,
  gitPaths,
  isInside,
  listWorktrees,
  refExists,
  samePath,
} from '../git/git.js';
import { assertBatchClean, assertLinkedWorktree } from './harvest.js';
import { needsBuild } from './land.js';
import { linkTarget } from '../git/links.js';
import { RUN_UPSTREAM } from '../git/run-layout.js';
import type { ConflictPath, SyncMasterResult } from '../envelope/types-run.js';
import { Refusal, recordFailure, StepFailure } from '../envelope/types.js';

/** How many subjects a conflict's `landedBy` carries at most. */
const LANDED_BY_LIMIT = 5;

/** The lockfile, regenerated rather than merged by hand. */
const LOCKFILE = 'package-lock.json';

/** Inputs of {@link syncMaster}. */
interface SyncMasterInput {
  /** The batch worktree, absolute with forward slashes. */
  readonly batch: string;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/** Per-call state threaded through the steps. */
interface Run {
  readonly batch: string;
  readonly result: SyncMasterResult;
  /** Set once this call starts its merge. */
  owned: boolean;
  /** This call's log directory, created at the first log. */
  logDir: string | null;
}

/**
 * Merge `origin/master` into the batch, keeping the file header's invariant.
 *
 * @returns The envelope: `ok` with `outcome` `up-to-date` or `merged`,
 *   `upstream` naming the `origin/master` sha the batch then contains;
 *   `refused` (harvest's linked-worktree reasons, `batch-dirty`,
 *   `slices-live`, `code-conflict`); or `failed` with the step.
 */
export function syncMaster(input: SyncMasterInput): SyncMasterResult {
  const { batch, selfPath = import.meta.filename } = input;
  const run: Run = {
    batch,
    owned: false,
    logDir: null,
    result: {
      command: 'sync-master',
      status: 'ok',
      worktree: batch,
      errors: [],
      outcome: null,
      commit: null,
      upstream: null,
      conflicts: [],
      refreshed: { ci: false, build: false },
      logs: [],
    },
  };

  try {
    assertLinkedWorktree(batch, selfPath);
    start(run);
  } catch (err) {
    recordFailure(run.result, err);
    if (run.result.status === 'failed' && run.owned) abortMerge(run);
  }

  return run.result;
}

/**
 * Refuse while any other registered worktree's `node_modules` links into
 * the batch's: the refresh's `npm ci` empties the link target, a live
 * slice's dependencies with it. `preflight --attach` runs the same check
 * on an attached run's target batch, through the main checkout.
 *
 * @param dir - Any checkout of the repository, to list the worktrees through.
 * @param batch - The batch worktree, which need not exist.
 * @throws Refusal `slices-live` naming each such worktree; StepFailure
 *   `preconditions` when git cannot list the worktrees.
 */
export function assertNoLiveSlices(dir: string, batch: string): void {
  const modules = `${batch}/node_modules`;
  const live = listWorktrees(dir, 'preconditions')
    .filter((w) => !samePath(w.path, batch))
    .filter((w) => {
      const target = linkTarget(`${w.path}/node_modules`);

      return target !== null && isInside(target, modules);
    })
    .map((w) => w.path);

  if (live.length > 0) {
    throw new Refusal(
      'slices-live',
      'preconditions',
      `node_modules of ${live.join(', ')} link into ${modules}; tear those slices down first`,
    );
  }
}

/**
 * Fetch, probe, merge. A merge stopped on the lockfile is settled, refreshed, then committed.
 *
 * @throws Refusal `batch-dirty`, `slices-live` or `code-conflict`; StepFailure per failed step.
 */
function start(run: Run): void {
  const { batch, result } = run;
  assertBatchClean(batch);
  assertNoLiveSlices(batch, batch);
  fetchOrigin(batch);
  const upstream = git(batch, ['rev-parse', '--verify', `${RUN_UPSTREAM}^{commit}`], 'upstream');

  if (isMerged(batch)) {
    result.outcome = 'up-to-date';
    result.upstream = upstream;

    return;
  }

  const mergeBase = git(batch, ['merge-base', 'HEAD', RUN_UPSTREAM], 'probe');
  result.conflicts = probeConflicts(batch).map((path) => ({
    path,
    kind: path === LOCKFILE ? 'lockfile' : 'code',
    landedBy: landedBy(batch, mergeBase, path),
  }));
  assertNoCodeConflict(result.conflicts);
  run.owned = true;

  if (merge(run)) {
    recordMerged(run, upstream);
    refresh(run, mergeBase);

    return;
  }

  settleStoppedMerge(batch);
  refresh(run, mergeBase);
  commitMerge(run);
  recordMerged(run, upstream);
}

/**
 * Settle a merge stopped on the lockfile by regenerating it. Throws StepFailure `merge` for any
 * other unmerged path, one the probe missed; `lockfile` when regenerating fails.
 */
function settleStoppedMerge(batch: string): void {
  const unmerged = unmergedPaths(batch, 'merge');
  const other = unmerged.filter((path) => path !== LOCKFILE);

  if (other.length > 0) {
    throw new StepFailure('merge', `merge conflicted beyond the probe: ${other.join(', ')}`);
  }

  if (unmerged.includes(LOCKFILE)) regenerateLockfile(batch);
}

/**
 * Resolve the conflicted lockfile by regeneration, never by hand: take `origin/master`'s, let npm
 * rewrite it against the merged `package.json`, and stage it by name.
 *
 * @param batch - The batch worktree, mid-merge.
 * @throws StepFailure `lockfile` when git or npm fails.
 */
function regenerateLockfile(batch: string): void {
  git(batch, ['checkout', '--theirs', '--', LOCKFILE], 'lockfile');
  runStep('lockfile', 'npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: batch,
    timeoutMs: NPM_TIMEOUT_MS,
  });
  git(batch, ['add', '--', LOCKFILE], 'lockfile');
}

/**
 * `true` when `origin/master`, freshly fetched, is an ancestor of the batch's `HEAD`.
 *
 * @throws StepFailure `up-to-date` when git cannot tell.
 */
function isMerged(batch: string): boolean {
  const r = runCaptured('git', ['-C', batch, 'merge-base', '--is-ancestor', RUN_UPSTREAM, 'HEAD'], {
    cwd: process.cwd(),
  });

  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;

  throw new StepFailure('up-to-date', `git merge-base --is-ancestor failed in ${batch}`, r.tail);
}

/**
 * The paths a merge of `origin/master` into `HEAD` would conflict on, sorted, empty for a clean
 * merge.
 *
 * @throws StepFailure `probe` when `git merge-tree` errors.
 */
function probeConflicts(batch: string): string[] {
  const r = runCaptured(
    'git',
    ['-C', batch, 'merge-tree', '--write-tree', '--name-only', '-z', 'HEAD', RUN_UPSTREAM],
    { cwd: process.cwd() },
  );

  if (r.exitCode === 0) return [];

  if (r.exitCode !== 1) {
    throw new StepFailure(
      'probe',
      `git merge-tree exited ${String(r.exitCode)} in ${batch}`,
      r.tail,
    );
  }

  const [listing = ''] = r.stdout.split('\0\0');

  return sortedSet(
    listing
      .split('\0')
      .slice(1)
      .filter((path) => path !== ''),
  );
}

/**
 * Up to {@link LANDED_BY_LIMIT} subjects, newest first, of `origin/master` commits since the
 * merge-base touching `path`, first-parent only so a PR landed by merge commit is named by that
 * commit, never its inner commits. Throws StepFailure `probe` when git fails.
 */
function landedBy(batch: string, mergeBase: string, path: string): string[] {
  return git(
    batch,
    [
      'log',
      '--first-parent',
      '--format=%s',
      '-n',
      String(LANDED_BY_LIMIT),
      `${mergeBase}..${RUN_UPSTREAM}`,
      '--',
      path,
    ],
    'probe',
  )
    .split(/\r?\n/u)
    .filter((subject) => subject !== '');
}

/**
 * Refuse before merging when any conflict is code.
 *
 * @throws Refusal `code-conflict` naming each code path.
 */
function assertNoCodeConflict(conflicts: readonly ConflictPath[]): void {
  const code = conflicts.filter((c) => c.kind === 'code').map((c) => c.path);
  if (code.length === 0) return;

  throw new Refusal(
    'code-conflict',
    'probe',
    `merging ${RUN_UPSTREAM} would conflict in code: ${code.join(', ')}`,
  );
}

/**
 * Merge, output logged: `true` when it committed, `false` when it stopped with `MERGE_HEAD` set.
 * Throws StepFailure `merge` when it ends uncommitted, no merge in progress.
 */
function merge(run: Run): boolean {
  const r = runCaptured('git', ['-C', run.batch, 'merge', '--no-edit', RUN_UPSTREAM], {
    cwd: process.cwd(),
    timeoutMs: COMMIT_TIMEOUT_MS,
    logFile: logFile(run, 'merge.log'),
  });

  if (r.exitCode === 0) return true;
  if (refExists(run.batch, 'MERGE_HEAD')) return false;

  throw new StepFailure('merge', `git merge ${RUN_UPSTREAM} exited ${String(r.exitCode)}`, r.tail);
}

/** A log file in this call's `freshLogDir` directory, recorded on the envelope's `logs`. */
function logFile(run: Run, name: string): string {
  run.logDir ??= freshLogDir('sync-master');
  const path = `${run.logDir}/${name}`;
  run.result.logs.push(path);

  return path;
}

/**
 * Once the merged tree is final: `npm ci` when `origin/master` changed the lockfile since the
 * merge-base, then `npm run build` when a path `dist/` is built from changed or `npm ci` ran.
 * Throws StepFailure `refresh` when git fails, `install` or `build` when npm does.
 */
function refresh(run: Run, mergeBase: string): void {
  const { batch, result } = run;
  const changed = gitPaths(
    batch,
    ['diff', '--name-only', '--no-renames', mergeBase, RUN_UPSTREAM],
    'refresh',
  );

  if (changed.includes(LOCKFILE)) {
    runStep('install', 'npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: batch,
      timeoutMs: NPM_TIMEOUT_MS,
    });
    result.refreshed.ci = true;
  }

  if (result.refreshed.ci || needsBuild(changed)) {
    runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
    result.refreshed.build = true;
  }
}

/**
 * The batch's unmerged paths, sorted.
 *
 * @throws StepFailure for `step` when git fails.
 */
function unmergedPaths(batch: string, step: string): string[] {
  return sortedSet(gitPaths(batch, ['diff', '--name-only', '--diff-filter=U'], step));
}

/**
 * Commit the merge with its hooks, the output to a log.
 *
 * @throws StepFailure `commit` on a non-zero exit, spawn failure or budget kill.
 */
function commitMerge(run: Run): void {
  commitWithHooks(run.batch, ['--no-edit'], logFile(run, 'commit.log'));
}

/**
 * Record the landed merge commit and the `origin/master` it merged.
 *
 * @param run - Call state: gains `outcome` `merged`, `commit`, and `upstream`.
 * @param upstream - The merged-in `origin/master` sha.
 */
function recordMerged(run: Run, upstream: string): void {
  run.result.outcome = 'merged';
  run.result.commit = git(run.batch, ['rev-parse', 'HEAD'], 'merge');
  run.result.upstream = upstream;
}

/**
 * Abort this call's merge after a failure, when one is in progress.
 *
 * @param run - Call state: a failed abort adds an `abort` error.
 */
function abortMerge(run: Run): void {
  try {
    if (refExists(run.batch, 'MERGE_HEAD')) git(run.batch, ['merge', '--abort'], 'abort');
  } catch (err) {
    recordFailure(run.result, err);
  }
}
