/**
 * `sync-master <batch> [--continue]` merges `origin/master` into the batch (ADR-0045 decision 6). A
 * `git merge-tree` probe refuses a code conflict before merging; a doc-index conflict stops,
 * `MERGE_HEAD` kept, for a resolver who edits, never stages: `--continue` stages and commits in
 * `.claude/rules/git.md` § Direct commits' merge-commit order, never resetting. Only when both
 * sides moved the version does the version rule ({@link planVersionRule}) hold the merge
 * `--no-ff --no-commit`: an identical bump stops before its commit.
 *
 * Invariant: a `failed` envelope never leaves a merge this call started or continued in progress:
 * it is aborted; a failed abort adds an `abort` error. `refused` / `conflict` leave the merge as
 * found or as the resolver needs. Nothing is mutated, not even the fetch's remote-tracking refs,
 * before the batch is verified a clean linked worktree, no slice linked in. Start mode refreshes
 * the merged tree before reporting, `--continue` never; a refresh failing after a clean merge keeps
 * that commit (`merged`, `commit` / `upstream` set, `install` / `build` failed), no rollback.
 */

import { readFileSync } from 'node:fs';

import { COMMIT_TIMEOUT_MS, freshLogDir, NPM_TIMEOUT_MS, runCaptured, runStep } from './exec.js';
import {
  commitWithHooks,
  fetchOrigin,
  git,
  gitPaths,
  isInside,
  listWorktrees,
  refExists,
  samePath,
} from './git.js';
import { assertBatchClean, assertLinkedWorktree } from './harvest.js';
import { needsBuild } from './land.js';
import { linkTarget } from './links.js';
import { RUN_UPSTREAM } from './run-layout.js';
import { sortedSet } from './staged-set.js';
import {
  applyVersionRule,
  LOCKFILE,
  PACKAGE_JSON,
  planVersionRule,
  regenerateLockfile,
  type VersionRule,
} from './sync-master-version.js';
import type { ConflictKind, ConflictPath, SyncMasterResult } from './types-run.js';
import { Conflict, Refusal, recordFailure, StepFailure } from './types.js';

/** The doc indexes: a conflict in one goes to a resolver, never refuses. */
const DOC_INDEX_PATHS: readonly string[] = [
  'GLOSSARY.md',
  'docs/adr/readme.md',
  'docs/platform-facts/readme.md',
];

/** How many subjects a conflict's `landedBy` carries at most. */
const LANDED_BY_LIMIT = 5;

/** A conflict-marker line git writes into a conflicted file. */
const MARKER_LINE = /^(?:<{7} |={7}\r?$|>{7} )/mu;

/** Inputs of {@link syncMaster}. */
export interface SyncMasterInput {
  /** The batch worktree, absolute with forward slashes. */
  readonly batch: string;
  /** Finish a merge stopped for a resolver instead of starting one. */
  readonly continue: boolean;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/** Per-call state threaded through the steps. */
interface Run {
  readonly batch: string;
  readonly result: SyncMasterResult;
  /** Set once the merge in progress is this call's: started, or verified to continue. */
  owned: boolean;
  /** This call's log directory, created at the first log. */
  logDir: string | null;
}

/**
 * Merge `origin/master` into the batch, or finish a merge stopped for a
 * resolver, keeping the file header's invariant.
 *
 * @returns The envelope: `ok` with `outcome` `up-to-date` or `merged`,
 *   `upstream` naming the `origin/master` sha the batch then contains;
 *   `conflict` with `needs-resolution` and `pending`; `refused` (harvest's
 *   linked-worktree reasons, `batch-dirty`, `slices-live`, `code-conflict`,
 *   `no-merge-in-progress`, `unresolved`); or `failed` with the step.
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
      version: null,
      pending: [],
      refreshed: { ci: false, build: false },
      logs: [],
    },
  };
  try {
    assertLinkedWorktree(batch, selfPath);
    if (input.continue) finish(run);
    else start(run);
  } catch (err) {
    recordFailure(run.result, err);
    if (run.result.status === 'failed' && run.owned) abortMerge(run);
  }
  return run.result;
}

/**
 * Start mode: fetch, probe, merge.
 *
 * @throws Refusal `batch-dirty`, `slices-live` or `code-conflict`; Conflict `merge` when doc-index
 *   paths await a resolver; StepFailure per failed step, {@link planVersionRule}'s before merging.
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
  const { version, rule } = planVersionRule(batch, mergeBase);
  result.version = version;
  result.conflicts = probeConflicts(batch).map((path) => ({
    path,
    kind: conflictKind(path, rule !== null),
    landedBy: landedBy(batch, mergeBase, path),
  }));
  assertNoCodeConflict(result.conflicts);
  run.owned = true;
  if (merge(run, rule !== null)) {
    recordMerged(run, upstream);
    refresh(run, mergeBase);
    return;
  }
  const pending = settleStoppedMerge(batch, rule);
  refresh(run, mergeBase);
  if (pending.length > 0) {
    result.pending = pending;
    result.outcome = 'needs-resolution';
    throw new Conflict(
      'merge',
      `doc-index conflicts await a resolver: ${pending.join(', ')}`,
      pending,
    );
  }
  finish(run);
}

/**
 * Settle what needs no resolver: the version rule's `package.json` and lockfile, or a conflicted
 * lockfile regenerated; returns the doc-index paths left, sorted. Throws StepFailure `merge` for an
 * unmerged path neither settled here nor a doc index; `version` or `lockfile` when settling fails.
 */
function settleStoppedMerge(batch: string, rule: VersionRule | null): string[] {
  const unmerged = unmergedPaths(batch, 'merge');
  const settled = rule === null ? [LOCKFILE] : [LOCKFILE, PACKAGE_JSON];
  const pending = unmerged.filter((path) => !settled.includes(path));
  assertOnlyDocIndexes(pending);
  if (rule !== null) {
    applyVersionRule(batch, rule.merged, rule.target, unmerged.includes(LOCKFILE));
  } else if (unmerged.includes(LOCKFILE)) {
    regenerateLockfile(batch, true);
  }
  return pending;
}

/**
 * `--continue`, and start mode's own finish: stage the resolved doc indexes by name, then commit
 * through the hooks. Throws Refusal `no-merge-in-progress`; `unresolved` per {@link assertResolved}
 * (nothing staged then) or when still unmerged after staging; StepFailure `continue` or `commit`.
 */
function finish(run: Run): void {
  const { batch, result } = run;
  if (!refExists(batch, 'MERGE_HEAD')) {
    throw new Refusal('no-merge-in-progress', 'preconditions', `${batch} has no merge in progress`);
  }
  run.owned = true;
  const upstream = git(batch, ['rev-parse', '--verify', 'MERGE_HEAD^{commit}'], 'continue');
  result.pending = unmergedPaths(batch, 'continue');
  assertResolved(batch, result.pending);
  if (result.pending.length > 0) git(batch, ['add', '--', ...result.pending], 'continue');
  const left = unmergedPaths(batch, 'continue');
  if (left.length > 0) {
    throw new Refusal('unresolved', 'continue', `still unmerged after staging: ${left.join(', ')}`);
  }
  commitMerge(run);
  result.pending = [];
  recordMerged(run, upstream);
}

/**
 * Refuse while any other registered worktree's `node_modules` links into
 * the batch's: the refresh's `npm ci` empties the link target, a live
 * slice's dependencies with it. `preflight --attach` runs the same check
 * on an attached run's target batch, through the main checkout.
 *
 * @param dir - Any checkout of the repository, to list the worktrees through.
 * @param batch - The batch worktree; it need not exist.
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

/** A conflicted path's kind; a `package.json` conflict the version rule can't resolve is `code`. */
function conflictKind(path: string, packageResolved: boolean): ConflictKind {
  if (path === LOCKFILE) return 'lockfile';
  if (path === PACKAGE_JSON && packageResolved) return 'package';
  return DOC_INDEX_PATHS.includes(path) ? 'doc-index' : 'code';
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
 * @param conflicts - The classified conflicts.
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

/** A log file in this call's `freshLogDir` directory, recorded on the envelope's `logs`. */
function logFile(run: Run, name: string): string {
  run.logDir ??= freshLogDir('sync-master');
  const path = `${run.logDir}/${name}`;
  run.result.logs.push(path);
  return path;
}

/**
 * Merge, output logged; a clean merge commits unless `stop` holds it (`--no-ff --no-commit`, for
 * the version rule to edit the tree): `true` when it committed, `false` when it stopped with
 * `MERGE_HEAD` set. Throws StepFailure `merge` when it ends uncommitted, no merge in progress.
 */
function merge(run: Run, stop: boolean): boolean {
  const hold = stop ? ['--no-ff', '--no-commit'] : [];
  const r = runCaptured('git', ['-C', run.batch, 'merge', '--no-edit', ...hold, RUN_UPSTREAM], {
    cwd: process.cwd(),
    timeoutMs: COMMIT_TIMEOUT_MS,
    logFile: logFile(run, 'merge.log'),
  });
  if (r.exitCode === 0 && !stop) return true;
  if (refExists(run.batch, 'MERGE_HEAD')) return false;
  throw new StepFailure('merge', `git merge ${RUN_UPSTREAM} exited ${String(r.exitCode)}`, r.tail);
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
 * Require the merge to have stopped only on doc indexes, as the probe promised.
 *
 * @throws StepFailure `merge` naming the paths outside them; the caller then aborts.
 */
function assertOnlyDocIndexes(pending: readonly string[]): void {
  const other = pending.filter((path) => !DOC_INDEX_PATHS.includes(path));
  if (other.length > 0) {
    throw new StepFailure('merge', `merge conflicted outside the doc indexes: ${other.join(', ')}`);
  }
}

/**
 * Refuse unless every pending path is a doc index free of conflict markers.
 *
 * @throws Refusal `unresolved` naming the offending paths.
 */
function assertResolved(batch: string, pending: readonly string[]): void {
  const outside = pending.filter((path) => !DOC_INDEX_PATHS.includes(path));
  if (outside.length > 0) {
    throw new Refusal('unresolved', 'continue', `not a doc index: ${outside.join(', ')}`);
  }
  const marked = pending.filter((path) =>
    MARKER_LINE.test(readFileSync(`${batch}/${path}`, 'utf8')),
  );
  if (marked.length > 0) {
    throw new Refusal('unresolved', 'continue', `conflict markers remain in ${marked.join(', ')}`);
  }
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
 * @param run - Call state; gains `outcome` `merged`, `commit` and `upstream`.
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
 * @param run - Call state; a failed abort adds an `abort` error.
 */
function abortMerge(run: Run): void {
  try {
    if (refExists(run.batch, 'MERGE_HEAD')) git(run.batch, ['merge', '--abort'], 'abort');
  } catch (err) {
    recordFailure(run.result, err);
  }
}
