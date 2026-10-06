/**
 * `cut-batch <main> --attach ship/<slug> [--attached-run]` — give an open
 * run branch its batch worktree at the place `run-layout.ts` names, for a
 * `/resync` or an attached run: reuse the batch already registered there,
 * or check the branch out anew when the batch was torn down while its PR is
 * still open. With `--attached-run` it also allocates the attached run's
 * number and its own report folder.
 *
 * Invariant: every refusal comes before the first mutation of a branch, the
 * worktree list or the report dir — the `update-ref` fast-forward, the
 * `worktree add`, the run folder — and only the fetch (remote-tracking refs
 * alone) precedes the checks that need it: whether the branch exists
 * locally or on `origin`, and how the two relate. The branch's own
 * unpublished commits ({@link assertPublished}) refuse on both the reused
 * and the checked-out-anew path. Like `cut-batch`, it runs from the main
 * checkout it targets and never touches that checkout's working tree
 * (`cut.ts`).
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';

import { runCaptured } from './exec.js';
import {
  assertMainWorktree,
  fetchOrigin,
  git,
  listWorktrees,
  refExists,
  resolveCommit,
  samePath,
} from './git.js';
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
} from './run-layout.js';
import type { CutBatchResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure } from './types.js';

/** Inputs of {@link attachBatch}. */
export interface AttachInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** The run branch, short form (`ship/<slug>`). */
  readonly branch: string;
  /** Allocate an attached run's number and report folder (`--attached-run`). */
  readonly attachedRun?: boolean;
}

/**
 * Attach the run branch's batch worktree, keeping the file header's
 * invariant.
 *
 * @param input - The main checkout and the branch.
 * @returns The envelope: `ok` with the branch, its tip as `base`, the run
 *   root, batch and report dir — with `attachedRun`, the run's own
 *   `reports/attach-<R>` — and `attach`, whose `run` is R (`null` without
 *   `attachedRun`) and whose `registry` is the batch's trimmed pool registry
 *   from its last provisioning ({@link lastRegistry}; `null` when none);
 *   `refused` before any branch, worktree or report-dir mutation
 *   (`not-main-worktree`, `not-run-batch`, `no-open-pr`,
 *   `branch-checked-out`, `unpublished-commits`, `path-exists`,
 *   `branch-missing`, `branch-diverged`); or `failed` with the step
 *   (`pr-state`, `unpublished`, `fetch`, `attach`, …).
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
    runRoot: null,
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
      runRoot: layout.root,
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
 * The batch's trimmed pool registry from its last provisioning: the newest
 * {@link BATCH_REGISTRY_FILE} by modification time among the run's report
 * dir — where `/ship` and `/resync` provision — and its attached runs'
 * folders — where an attached run that checked the batch out anew
 * provisions.
 *
 * @param layout - The run's layout.
 * @returns The file's path; `null` when no provisioning left one.
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
 * Allocate an attached run: the lowest number no earlier run's report
 * folder or slice branch holds, and its own report folder.
 *
 * @param main - The main checkout.
 * @param slug - The run's slug.
 * @param layout - The run's layout; its report dir exists.
 * @returns The run's number and its report folder, `<reports>/attach-<run>`,
 *   created now.
 * @throws StepFailure `attach` when git cannot list the slice branches; a
 *   filesystem error when the report dir cannot be read or the folder cannot
 *   be made.
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
 * @returns The slug.
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
 * The branch's own commits `origin` lacks: its first-parent, non-merge
 * commits that no `origin` remote-tracking ref holds. A merge — and the
 * `master` commits it brings in on its second parent — never counts.
 *
 * @param main - The main checkout.
 * @param branch - Short branch name.
 * @returns The count; `0` when the local branch does not exist.
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
 * attached run's fixes, which ADR-0045 decision 10 recovers first. An
 * unpushed merge alone passes.
 *
 * @param main - The main checkout.
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
    `${branch} has ${String(n)} commit(s) of its own origin lacks; recover them first (ADR-0045 decision 10)`,
  );
}

/**
 * Whether the branch is already checked out at the layout's batch.
 *
 * @param main - The main checkout.
 * @param layout - The run's layout.
 * @returns `true` when a registered, non-prunable worktree at the batch
 *   path has the branch; `false` when no worktree has it.
 * @throws Refusal `branch-checked-out` naming the path when it is checked
 *   out anywhere else — a prunable batch entry included.
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
 * Check the branch out at the batch path: from the local branch
 * (fast-forwarded to `origin`'s first when strictly behind), or as a new
 * tracking branch when only `origin` has it.
 *
 * @param main - The main checkout.
 * @param layout - The run's layout.
 * @returns Whether the local branch was fast-forwarded.
 * @throws Refusal `path-exists`, `branch-missing` or `branch-diverged`
 *   before any mutation but the fetch; StepFailure `fetch`, `attach` or
 *   `worktree-add` when git fails.
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
 * Bring the local branch level with `origin`'s when it is strictly behind;
 * leave it when level or ahead (an unpushed resync merge).
 *
 * @param main - The main checkout, freshly fetched.
 * @param local - The local branch's full ref.
 * @param remote - `origin`'s remote-tracking ref.
 * @returns Whether it moved the local branch.
 * @throws Refusal `branch-diverged` when each has commits the other lacks;
 *   StepFailure `attach` when git fails.
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
 * @param main - The main checkout.
 * @param a - A commit id.
 * @param b - A commit id.
 * @returns `true` when `git merge-base --is-ancestor a b` exits 0.
 * @throws StepFailure `attach` when it exits other than 0 or 1.
 */
function isAncestor(main: string, a: string, b: string): boolean {
  const r = runCaptured('git', ['-C', main, 'merge-base', '--is-ancestor', a, b], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) return false;
  throw new StepFailure('attach', `git merge-base --is-ancestor ${a} ${b} failed`, r.tail);
}
