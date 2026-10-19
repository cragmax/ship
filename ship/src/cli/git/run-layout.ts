/**
 * The run layout of an unattended run (Ship ADR-0001 decision 3) — the one home of its naming rules
 * but the slug's (`ship/src/core/run-slug.ts`, render-safe for the workflow). Every tool that names
 * a run's branch or directory derives it here, never by re-spelling the rule.
 *
 * The `ship/` namespace is the feature branch's (`ship/<slug>`), the one pre-flight's live-run
 * check keys on, and nothing else may use it: slice branches (`slice/<slug>/…`) never sit under it.
 * Every worktree of a run is a direct child of the main checkout's {@link WORKTREES_DIR}, named
 * from the batch's `ship-<head>`, and its report dir is `reports/ship-<head>/`; both lie in the
 * main checkout's gitignored paths (Ship ADR-0001 decision 3). An attached run R's names sit beside
 * the run's own, prefixed `a<R>-` ({@link nextAttachedRun} picks R).
 *
 * Pure: no filesystem or git access, so any path it returns may not exist.
 */

import { EPIC_SLUG_PREFIX } from '../../core/run-slug.js';
import { toPosix } from '../../../../tooling/lib/shared.js';

/**
 * The branch namespace of every unattended run's feature branch
 * (`ship/<slug>`), the earlier parallel batch flow's included, so its live
 * batches stay visible. Slice, harness-agent (`worktree-agent-*`) and
 * detached worktrees are not runs.
 */
export const RUN_BRANCH_PREFIX = 'refs/heads/ship/';

/** The branch every run is cut from and merged back into (Ship ADR-0001 decision 10). */
export const RUN_BASE_BRANCH = 'master';

/** The remote-tracking branch of {@link RUN_BASE_BRANCH}, as `git merge` / `git log` name it. */
export const RUN_UPSTREAM = `origin/${RUN_BASE_BRANCH}`;

/**
 * Where every run worktree lives, relative to the main checkout. A direct child, never deeper: a
 * worktree there takes its path-scoped rules from the main checkout, never its own (PF-104).
 */
const WORKTREES_DIR = '.claude/worktrees';

/** Where every run's report dir lives, relative to the main checkout. */
export const REPORTS_DIR = 'reports';

/** Where a run lives; paths absolute with forward slashes. */
export interface RunLayout {
  /** The batch worktree, `<main>/.claude/worktrees/ship-<head>`. */
  readonly batch: string;
  /** The run's report dir, `<main>/reports/ship-<head>`: the run root `retire-run` removes. */
  readonly reports: string;
  /** The feature branch, short form (`ship/<slug>`). */
  readonly branch: string;
}

/** Where one issue attempt's slice lives. */
interface SliceLayout {
  /** The slice worktree, absolute with forward slashes. */
  readonly path: string;
  /** The slice branch, short form (`slice/<slug>/<N>-<K>`). */
  readonly branch: string;
}

/**
 * An epic slug is its own head; any other's is its text before the first `-` (a list's lowest
 * issue: `runSlug` sorts) or the whole slug. Slug-only: `cut-batch --attach` knows only the
 * branch. Not `ship-<slug>`: Windows' 260-character path limit (Ship ADR-0001 decision 3).
 */
function runHead(slug: string): string {
  if (slug.startsWith(EPIC_SLUG_PREFIX)) return slug;
  const dash = slug.indexOf('-');
  return dash === -1 ? slug : slug.slice(0, dash);
}

/**
 * The layout of the run with `slug` of the repository whose main checkout
 * is `main`. Two runs with one head share it: `cut-batch` refuses the
 * second (`path-exists`).
 *
 * @param main - The main checkout, either slash direction.
 * @param slug - From `runSlug`.
 * @returns The batch worktree `<main>/.claude/worktrees/ship-<head>` (head
 *   per {@link runHead}), the report dir `<main>/reports/ship-<head>`, and the
 *   feature branch `ship/<slug>`.
 */
export function runLayout(main: string, slug: string): RunLayout {
  const posixMain = toPosix(main);
  const name = `ship-${runHead(slug)}`;
  return {
    batch: `${posixMain}/${WORKTREES_DIR}/${name}`,
    reports: `${posixMain}/${REPORTS_DIR}/${name}`,
    branch: `${RUN_BRANCH_PREFIX.slice('refs/heads/'.length)}${slug}`,
  };
}

/** The file name of a batch's trimmed pool registry inside a report dir. */
export const BATCH_REGISTRY_FILE = 'pool-registry.batch.json';

/**
 * The namespace of a run's slice branches.
 *
 * @returns `slice/<slug>/`.
 */
export function sliceBranchPrefix(slug: string): string {
  return `slice/${slug}/`;
}

/**
 * The layout of attempt `attempt` of `issue`'s slice, a sibling of the batch.
 *
 * @param batch - The batch worktree ({@link RunLayout.batch}).
 * @param attempt - The attempt number, 1 for the first.
 * @param run - The attached run's number; `null` (the default) for an
 *   unattached run.
 * @returns The slice worktree path and branch: id `<N>-<K>`, or
 *   `a<run>-<N>-<K>` for an attached run.
 */
export function sliceLayout(
  batch: string,
  slug: string,
  issue: number,
  attempt: number,
  run: number | null = null,
): SliceLayout {
  const id = `${String(issue)}-${String(attempt)}`;
  const named = run === null ? id : `a${String(run)}-${id}`;
  return { path: `${batch}-${named}`, branch: `${sliceBranchPrefix(slug)}${named}` };
}

/**
 * An attached run's own report folder.
 *
 * @returns `<reports>/attach-<run>`.
 */
export function attachedRunReports(layout: RunLayout, run: number): string {
  return `${layout.reports}/attach-${String(run)}`;
}

/**
 * Whether a report-dir entry is an attached run's own folder.
 *
 * @param name - An entry name directly under the run's report dir.
 * @returns `true` for `attach-<R>` ({@link attachedRunReports}), R from 1 up.
 */
export function isAttachedRunReports(name: string): boolean {
  return /^attach-[1-9]\d*$/u.test(name);
}

/**
 * The number of the next attached run: the lowest one whose report folder
 * and slice branches no earlier run left behind.
 *
 * @param left - `reports`: the entry names directly under the run's report
 *   dir; `branches`: its slice branches, each without
 *   {@link sliceBranchPrefix}.
 * @returns The lowest `run` from 1 up with no `attach-<run>` among `reports`
 *   and no `branches` entry starting `a<run>-`.
 */
export function nextAttachedRun(left: {
  readonly reports: readonly string[];
  readonly branches: readonly string[];
}): number {
  let run = 1;
  const taken = (n: number): boolean =>
    left.reports.includes(`attach-${String(n)}`) ||
    left.branches.some((b) => b.startsWith(`a${String(n)}-`));
  while (taken(run)) run++;
  return run;
}

/**
 * The slug of a run branch.
 *
 * @param ref - A full branch ref (`refs/heads/…`).
 * @returns The part after {@link RUN_BRANCH_PREFIX}; `null` when `ref` is
 *   not a run branch or the part is empty.
 */
export function runSlugOf(ref: string): string | null {
  if (!ref.startsWith(RUN_BRANCH_PREFIX)) return null;
  const slug = ref.slice(RUN_BRANCH_PREFIX.length);
  return slug === '' ? null : slug;
}
