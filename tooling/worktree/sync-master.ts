/**
 * `sync-master <batch> [--continue]` — the epic-end merge step (ADR-0045
 * decision 6): merge `origin/master` into the run's batch worktree.
 *
 * Start mode probes the merge first (`git merge-tree`, which touches
 * neither index nor worktree) and refuses a code conflict before merging.
 * A conflict in a doc index stops the merge for a resolver, its
 * `MERGE_HEAD` kept; `--continue` then finishes it ({@link finish}) in
 * `.claude/rules/git.md` § Direct commits' merge-commit order, never
 * resetting. The resolver edits and never stages: `--continue` stages.
 *
 * Invariant: a `failed` envelope never leaves a merge this call started or
 * continued in progress — it is aborted (`git merge --abort`), and a failed
 * abort adds an `abort` error. A `refused` or `conflict` envelope leaves the
 * merge state as it found it or as the resolver needs it. Nothing is
 * mutated — not even the fetch's remote-tracking refs — before the batch is
 * verified a clean linked worktree with no slice linked into it.
 *
 * The batch is refreshed (`npm ci`, `npm run build`) on the merged tree
 * before the envelope reports it: after a clean merge's own commit, or
 * before `needs-resolution` or the finishing commit. A refresh failing
 * after a clean merge leaves that merge commit — `outcome` `merged` with
 * `commit` and `upstream` set, status `failed` step `install` or `build`;
 * the refreshed `node_modules` and `dist` are never rolled back.
 * `--continue` refreshes nothing: the resolver edits only doc indexes.
 *
 * The version-line rule (`package-version.ts`; its I/O in
 * `sync-master-version.ts`) intervenes only when both the batch and
 * `origin/master` moved the `package.json` version since the merge-base:
 * a `package.json` conflict confined to the top-level version line is then
 * kind `package`, not code, and the merge runs `--no-ff --no-commit` — so
 * an identical bump, which git merges clean, still stops before its commit.
 * The rule writes and stages `package.json` at master's version bumped by
 * the branch's own, regenerates and stages the lockfile, and the merge
 * commit is made through the hooks as a resolver-free `--continue` would
 * make it. A `package.json` conflict beyond the version line stays code.
 * `--continue` finishes a merge whose `package.json` is already staged.
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
 * @param input - The batch, the mode and the self-hosted seam.
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
 * @param run - Call state.
 * @throws Refusal `batch-dirty`, `slices-live` or `code-conflict`; Conflict
 *   `merge` when doc-index paths await a resolver; StepFailure for a failed
 *   step — `version` when both sides moved the version and one is not a
 *   plain `x.y.z`, before anything merges.
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
 * Settle what a stopped merge left that needs no resolver: the version
 * rule's `package.json` and lockfile, or a conflicted lockfile regenerated.
 *
 * @param batch - The batch worktree, `MERGE_HEAD` set.
 * @param rule - The version rule's intervention, or `null`.
 * @returns The doc-index paths left for a resolver, sorted.
 * @throws StepFailure `merge` when an unmerged path is neither settled here
 *   nor a doc index; `version` or `lockfile` when settling fails.
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
 * `--continue`, and start mode's own finish: stage the resolved doc
 * indexes by name, then commit the merge through the hooks.
 *
 * @param run - Call state; `result.pending` is the recomputed pending list.
 * @throws Refusal `no-merge-in-progress` without `MERGE_HEAD`; Refusal
 *   `unresolved` when a pending path is outside the doc indexes, still
 *   holds a conflict-marker line (nothing staged then), or is still
 *   unmerged after staging; StepFailure `continue` when reading
 *   `MERGE_HEAD`, listing or staging the pending paths fails; StepFailure
 *   `commit` when the commit fails.
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
 * Whether `origin/master` is already contained in the batch's `HEAD`.
 *
 * @param batch - The batch worktree, freshly fetched.
 * @returns `true` when it is an ancestor of `HEAD`.
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
 * The paths a merge of `origin/master` into `HEAD` would conflict on,
 * computed without touching the index or the worktree.
 *
 * @param batch - The batch worktree.
 * @returns The conflicted paths, sorted; empty for a clean merge.
 * @throws StepFailure `probe` when `git merge-tree` fails (exit other than 0 or 1).
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
  // `-z` output: the tree id, each conflicted path, then an empty field
  // before the messages section (git 2.55, observed 2026-09-28).
  const [listing = ''] = r.stdout.split('\0\0');
  return sortedSet(
    listing
      .split('\0')
      .slice(1)
      .filter((path) => path !== ''),
  );
}

/**
 * Classify a conflicted path.
 *
 * @param path - Repository-relative path.
 * @param packageResolved - Whether the version rule resolves `package.json`.
 * @returns `lockfile` for {@link LOCKFILE}, `doc-index` for a
 *   {@link DOC_INDEX_PATHS} member, `package` for {@link PACKAGE_JSON} when
 *   `packageResolved`, `code` for anything else.
 */
function conflictKind(path: string, packageResolved: boolean): ConflictKind {
  if (path === LOCKFILE) return 'lockfile';
  if (path === PACKAGE_JSON && packageResolved) return 'package';
  return DOC_INDEX_PATHS.includes(path) ? 'doc-index' : 'code';
}

/**
 * The `origin/master` commits since the merge-base that touched a path,
 * along the first-parent line — so a PR that landed by merge commit is
 * named by that commit (`Merge pull request #N …`), never its inner commits.
 *
 * @param batch - The batch worktree.
 * @param mergeBase - The merge-base of `HEAD` and `origin/master`.
 * @param path - Repository-relative path.
 * @returns Up to {@link LANDED_BY_LIMIT} subjects, newest first.
 * @throws StepFailure `probe` when git fails.
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

/**
 * A log file in this call's `freshLogDir` directory, recorded on the
 * envelope's `logs`.
 *
 * @param run - Call state.
 * @param name - The file name.
 * @returns The log file's path.
 */
function logFile(run: Run, name: string): string {
  run.logDir ??= freshLogDir('sync-master');
  const path = `${run.logDir}/${name}`;
  run.result.logs.push(path);
  return path;
}

/**
 * Run the merge, its output to a log. A clean merge commits itself, unless
 * `stop` holds it before its commit.
 *
 * @param run - Call state.
 * @param stop - Merge `--no-ff --no-commit`, for the version rule to edit
 *   the merged tree first.
 * @returns `true` when the merge committed; `false` when it stopped —
 *   on conflicts or by `stop` — with `MERGE_HEAD` set.
 * @throws StepFailure `merge` when it ends without a commit and without a
 *   merge in progress.
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
 * Refresh the batch for what `origin/master` changed since the merge-base,
 * once the merged tree is final: `npm ci` when the lockfile changed, then
 * `npm run build` when a path `dist/` is built from changed or `npm ci` ran.
 *
 * @param run - Call state; `result.refreshed` records each refresh that ran.
 * @param mergeBase - The merge-base of the pre-merge `HEAD` and `origin/master`.
 * @throws StepFailure `refresh` when git fails; `install` or `build` when
 *   npm does.
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
 * The batch's unmerged paths.
 *
 * @param batch - The batch worktree.
 * @param step - Step name reported on failure.
 * @returns The paths, sorted.
 * @throws StepFailure for `step` when git fails.
 */
function unmergedPaths(batch: string, step: string): string[] {
  return sortedSet(gitPaths(batch, ['diff', '--name-only', '--diff-filter=U'], step));
}

/**
 * Require the merge to have stopped only on doc indexes — what the probe
 * promised; anything else fails the merge, which the caller then aborts.
 *
 * @param pending - The unmerged paths.
 * @throws StepFailure `merge` naming the paths outside the doc indexes.
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
 * @param batch - The batch worktree.
 * @param pending - The unmerged paths.
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
 * @param run - Call state.
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
