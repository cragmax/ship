/**
 * `cut-batch <main> --attach ship/<slug> [--attached-run]` — give an open run branch its batch
 * worktree at the place `run-layout.ts` names, for a `/resync` or an attached run: reuse the
 * batch already registered there, or check the branch out anew when the batch was torn down
 * while its PR is still open. With `--attached-run` it also allocates the attached run's number
 * and its own report folder.
 *
 * Invariant: every refusal comes before the first mutation of a branch, the worktree list or the
 * report dir — the `update-ref` fast-forward, the `worktree add`, the run folder — and only the
 * fetch (remote-tracking refs alone) precedes the checks that need it. The branch's own
 * unpublished commits ({@link assertPublished}) refuse on both the reused and the
 * checked-out-anew path. Like `cut-batch`, it runs from the main checkout it targets and writes
 * only its gitignored run paths there (`cut.ts`).
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';

import { runCaptured } from '../git/exec.js';
import {
  assertMainWorktree,
  fetchOrigin,
  git,
  listWorktrees,
  refExists,
  resolveCommit,
  samePath,
} from '../git/git.js';
import { lookupPr } from './live-runs.js';
import {
  attachedRunReports,
  BATCH_REGISTRY_FILE,
  isAttachedRunReports,
  nextAttachedRun,
  runLayout,
  runSlugOf,
  sliceBranchPrefix,
  type RunLayout,
} from '../git/run-layout.js';
import type { CutBatchResult } from '../envelope/types-run.js';
import { Refusal, recordFailure, StepFailure } from '../envelope/types.js';

/** Inputs of {@link attachBatch}. */
interface AttachInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** The run branch, short form (`ship/<slug>`). */
  readonly branch: string;
  /** Allocate an attached run's number and report folder (`--attached-run`). */
  readonly attachedRun?: boolean;
}

/**
 * Attach the run branch's batch worktree.
 *
 * @returns The envelope: `ok` with the branch, its tip as `base`, the batch and report dir — with
 *   `attachedRun`, the run's own `reports/attach-<R>` — and `attach`, whose `run` is R (`null`
 *   without `attachedRun`) and whose `registry` is the batch's trimmed pool registry from its last
 *   provisioning ({@link lastRegistry}; `null` when none); `refused` before any branch,
 *   worktree or report-dir mutation (`not-main-worktree`, `not-run-batch`, `no-open-pr`,
 *   `branch-checked-out`, `unpublished-commits`, `path-exists`, `branch-missing`,
 *   `branch-diverged`); or `failed` with the step (`pr-state`, `unpublished`, `fetch`, `attach`,
 *   …).
 */
export function attachBatch(input: AttachInput): CutBatchResult {
  const { main, branch } = input;
  const result: CutBatchResult = {
    command: 'cut-batch',
    status: 'ok',
    worktree: main,
    errors: [],
    branch: null,
    base: null,
    batch: null,
    reportDir: null,
    attach: null,
  };
  try {
    assertMainWorktree(main, 'preconditions');
    const slug = attachSlug(branch);
    const layout = runLayout(main, slug);
    const pr = openPr(main, branch);
    const created = !reusesBatch(main, layout);
    assertPublished(main, branch);
    const fastForwarded = created ? checkOut(main, layout) : false;
    mkdirSync(layout.reports, { recursive: true });
    const { run, reportDir } =
      input.attachedRun === true
        ? allocateRun(main, slug, layout)
        : { run: null, reportDir: layout.reports };
    const registry = lastRegistry(layout);
    Object.assign(result, {
      branch: layout.branch,
      base: resolveCommit(main, `refs/heads/${branch}`, 'attach'),
      batch: layout.batch,
      reportDir,
      attach: {
        created,
        fastForwarded,
        pr,
        run,
        registry,
      },
    });
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * The newest {@link BATCH_REGISTRY_FILE} by modification time among the run's report dir and its
 * attached runs' folders; `null` when no provisioning left one.
 *
 * @throws A filesystem error when the report dir cannot be read.
 */
function lastRegistry(layout: RunLayout): string | null {
  const dirs = [
    layout.reports,
    ...readdirSync(layout.reports)
      .filter(isAttachedRunReports)
      .map((name) => `${layout.reports}/${name}`),
  ];
  let newest: { readonly path: string; readonly mtimeMs: number } | null = null;
  for (const dir of dirs) {
    const path = `${dir}/${BATCH_REGISTRY_FILE}`;
    if (!existsSync(path)) continue;
    const { mtimeMs } = statSync(path);
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path ?? null;
}

/**
 * Allocate an attached run: the lowest number no earlier run's report folder or slice branch
 * holds, and its report folder `<reports>/attach-<run>`, created now; the report dir must exist.
 *
 * @throws StepFailure `attach` when git cannot list the slice branches; a filesystem error else.
 */
function allocateRun(
  main: string,
  slug: string,
  layout: RunLayout,
): { readonly run: number; readonly reportDir: string } {
  const reports = readdirSync(layout.reports);
  const prefix = `refs/heads/${sliceBranchPrefix(slug)}`;
  const branches = git(main, ['for-each-ref', '--format=%(refname)', prefix], 'attach')
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  const run = nextAttachedRun({ reports, branches });
  const reportDir = attachedRunReports(layout, run);
  // Not recursive: a concurrent attach that took the same number first makes
  // this throw, so two runs never share a folder.
  mkdirSync(reportDir);
  return { run, reportDir };
}

/**
 * The slug of the branch named.
 *
 * @param branch - Short branch name.
 * @throws Refusal `not-run-batch` unless it is a `ship/` run branch.
 */
export function attachSlug(branch: string): string {
  const slug = runSlugOf(`refs/heads/${branch}`);
  if (slug === null) {
    throw new Refusal('not-run-batch', 'preconditions', `${branch} is not a ship/ run branch`);
  }
  return slug;
}

/**
 * The branch's open PR.
 *
 * @param main - The main checkout (`gh`'s working directory).
 * @param branch - Short branch name.
 * @returns Its number.
 * @throws StepFailure `pr-state` when `gh` fails or answers unreadably;
 *   Refusal `no-open-pr` naming the state and number otherwise.
 */
export function openPr(main: string, branch: string): number {
  const { info, error } = lookupPr(main, branch);
  if (error !== undefined) throw new StepFailure('pr-state', `${branch}: ${error}`);
  if (info.state !== 'open' || info.number === null) {
    const pr = info.number === null ? '' : ` (#${String(info.number)})`;
    throw new Refusal('no-open-pr', 'pr-state', `${branch} has no open PR: ${info.state}${pr}`);
  }
  return info.number;
}

/**
 * How many first-parent, non-merge commits of the branch no `origin` remote-tracking ref holds (a
 * merge and its second parent's `master` commits never count); `0` without a local branch.
 *
 * @throws StepFailure `unpublished` when git fails.
 */
function unpublishedCommits(main: string, branch: string): number {
  const ref = `refs/heads/${branch}`;
  if (!refExists(main, ref)) return 0;
  const args = [
    'rev-list',
    '--count',
    '--first-parent',
    '--no-merges',
    ref,
    '--not',
    '--remotes=origin',
  ];
  return Number(git(main, args, 'unpublished'));
}

/**
 * Refuse a branch holding commits of its own `origin` lacks — a stopped
 * attached run's fixes, which Ship ADR-0001 decision 17 recovers first. An
 * unpushed merge alone passes.
 *
 * @param branch - Short branch name.
 * @throws Refusal `unpublished-commits` naming the count; StepFailure
 *   `unpublished` when git fails.
 */
export function assertPublished(main: string, branch: string): void {
  const n = unpublishedCommits(main, branch);
  if (n === 0) return;
  throw new Refusal(
    'unpublished-commits',
    'preconditions',
    `${branch} has ${String(n)} commit(s) of its own origin lacks; recover them first (Ship ADR-0001 decision 17)`,
  );
}

/**
 * Whether a registered, non-prunable worktree at the batch path has the branch (`false`: none has).
 *
 * @throws Refusal `branch-checked-out` when checked out anywhere else, a prunable batch included.
 */
function reusesBatch(main: string, layout: RunLayout): boolean {
  const ref = `refs/heads/${layout.branch}`;
  const entry = listWorktrees(main, 'preconditions').find((w) => w.branch === ref);
  if (entry === undefined) return false;
  if (samePath(entry.path, layout.batch) && !entry.prunable) return true;
  const state = entry.prunable ? ' (prunable)' : '';
  throw new Refusal(
    'branch-checked-out',
    'preconditions',
    `${layout.branch} is checked out at ${entry.path}${state}, not ${layout.batch}`,
  );
}

/**
 * Check the branch out at the batch path; `true` when it fast-forwarded the local branch.
 *
 * @throws Refusal `path-exists`, `branch-missing` or `branch-diverged` before any mutation but the
 *   fetch; StepFailure `fetch`, `attach` or `worktree-add` when git fails.
 */
function checkOut(main: string, layout: RunLayout): boolean {
  const { branch, batch } = layout;
  if (existsSync(batch)) {
    throw new Refusal('path-exists', 'preconditions', `${batch} exists already`);
  }
  fetchOrigin(main);
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const hasLocal = refExists(main, local);
  if (!hasLocal && !refExists(main, remote)) {
    throw new Refusal(
      'branch-missing',
      'preconditions',
      `neither ${branch} nor origin/${branch} exists`,
    );
  }
  if (!hasLocal) {
    git(
      main,
      ['worktree', 'add', '-q', '--track', '-b', branch, batch, `origin/${branch}`],
      'worktree-add',
    );
    return false;
  }
  const fastForwarded = refExists(main, remote) && fastForward(main, local, remote);
  git(main, ['worktree', 'add', '-q', batch, branch], 'worktree-add');
  return fastForwarded;
}

/**
 * Move the local branch to `origin`'s only when strictly behind (`true`); a level or ahead branch
 * (an unpushed resync merge) stays.
 *
 * @throws Refusal `branch-diverged` when each has commits the other lacks; StepFailure `attach`.
 */
function fastForward(main: string, local: string, remote: string): boolean {
  const l = resolveCommit(main, local, 'attach');
  const o = resolveCommit(main, remote, 'attach');
  if (l === o) return false;
  if (isAncestor(main, l, o)) {
    git(main, ['update-ref', local, o, l], 'attach');
    return true;
  }
  if (isAncestor(main, o, l)) return false;
  throw new Refusal(
    'branch-diverged',
    'preconditions',
    `${local} and ${remote} each have commits the other lacks`,
  );
}

/**
 * Whether commit `a` is an ancestor of commit `b`.
 *
 * @throws StepFailure `attach` when git cannot answer.
 */
function isAncestor(main: string, a: string, b: string): boolean {
  const r = runCaptured('git', ['-C', main, 'merge-base', '--is-ancestor', a, b], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  throw new StepFailure('attach', `git merge-base --is-ancestor ${a} ${b} failed`, r.tail);
}
