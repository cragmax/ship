/**
 * The run layout of an unattended run (ADR-0045) — the one home of its
 * naming rules. Every tool that names a run's branch or directory derives
 * it here, never by re-spelling the rule:
 *
 * - the slug: `epic-<E>` for an epic run, the issue numbers ascending and
 *   joined with `-` for an explicit list;
 * - the feature branch `ship/<slug>` — the namespace pre-flight's live-run
 *   check keys on, which nothing else may use;
 * - the run root `<dirname(main)>/ph-ship/<slug>/`, a sibling of the main
 *   checkout, holding `ship-<head>/` (the batch worktree, head per
 *   {@link runHead}), `slice-<N>-<K>/` (one per issue attempt),
 *   `slice-critic/` (the epic end's critic) and `reports/`;
 * - the slice branch `slice/<slug>/<N>-<K>`, and the critic's
 *   `slice/<slug>/critic` — never under `ship/`;
 * - an attached run R's own names beside those: its report folder
 *   `reports/attach-<R>/`, its slices `slice-a<R>-<N>-<K>/` and
 *   `slice-a<R>-critic/`, on `slice/<slug>/a<R>-<N>-<K>` and
 *   `slice/<slug>/a<R>-critic` ({@link nextAttachedRun} picks R).
 *
 * Pure: no filesystem or git access, so any path it returns may not exist.
 */

import { posix } from 'node:path';

import { toPosix } from '../shared.js';

/**
 * The branch namespace of every unattended run's feature branch
 * (`ship/<slug>`), the earlier parallel batch flow's included, so its live
 * batches stay visible. Slice, harness-agent (`worktree-agent-*`) and
 * detached worktrees are not runs.
 */
export const RUN_BRANCH_PREFIX = 'refs/heads/ship/';

/**
 * The branch every run is cut from and merged back into
 * (`.claude/rules/git.md` § Unattended workflow runs).
 */
export const RUN_BASE_BRANCH = 'master';

/** The remote-tracking branch of {@link RUN_BASE_BRANCH}, as `git merge` / `git log` name it. */
export const RUN_UPSTREAM = `origin/${RUN_BASE_BRANCH}`;

/** What a run ships: one epic, or an explicit list of issues. */
export type RunSelection = { readonly epic: number } | { readonly issues: readonly number[] };

/** Where a run lives; paths absolute with forward slashes. */
export interface RunLayout {
  /** The run root. */
  readonly root: string;
  /** The batch worktree, `<root>/ship-<head>`. */
  readonly batch: string;
  /** The run's report directory. */
  readonly reports: string;
  /** The feature branch, short form (`ship/<slug>`). */
  readonly branch: string;
}

/** Where one slice lives: an issue attempt's, or the critic's. */
export interface SliceLayout {
  /** The slice worktree, absolute with forward slashes. */
  readonly path: string;
  /** The slice branch, short form (`slice/<slug>/<N>-<K>` or `slice/<slug>/critic`). */
  readonly branch: string;
}

/** The prefix of an epic run's slug. */
const EPIC_SLUG_PREFIX = 'epic-';

/**
 * The slug of a run.
 *
 * @param selection - The epic, or the explicit issue list (any order; the
 *   caller has checked each is a positive integer).
 * @returns `epic-<E>`, or the numbers ascending joined with `-`.
 */
export function runSlug(selection: RunSelection): string {
  if ('epic' in selection) return `${EPIC_SLUG_PREFIX}${String(selection.epic)}`;
  return [...selection.issues]
    .sort((a, b) => a - b)
    .map(String)
    .join('-');
}

/**
 * The head of a run's slug, which names its batch worktree `ship-<head>`.
 * An epic slug is its own head. Any other slug's head is its text before
 * the first `-` — for an explicit list the lowest issue, since
 * {@link runSlug} sorts ascending; a slug with no `-` is its own head.
 *
 * Derived from the slug alone because `cut-batch --attach` knows only the
 * branch ({@link runSlugOf}), never the run selection.
 *
 * Not `ship-<slug>`: #1079 measured it (2026-09-30) — the deepest file
 * under a batch's real `node_modules` is 154 characters below the batch
 * folder. With the longest real slug, `ship-<slug>` brings that path to
 * 256 characters against Windows' traditional 260-character limit
 * (`core.longpaths` unset); `ship-<head>` gives 226.
 *
 * @param slug - From {@link runSlug} or {@link runSlugOf}.
 * @returns The slug for an epic run; otherwise the text before its first
 *   `-`, or the whole slug when it has none.
 */
function runHead(slug: string): string {
  if (slug.startsWith(EPIC_SLUG_PREFIX)) return slug;
  const dash = slug.indexOf('-');
  return dash === -1 ? slug : slug.slice(0, dash);
}

/**
 * The layout of the run with `slug` of the repository whose main checkout
 * is `main`.
 *
 * @param main - The main checkout, either slash direction.
 * @param slug - From {@link runSlug}.
 * @returns The run root `<dirname(main)>/ph-ship/<slug>`, its batch
 *   worktree `<root>/ship-<head>` (head per {@link runHead}), its report
 *   directory `<root>/reports`, and the feature branch `ship/<slug>`.
 */
export function runLayout(main: string, slug: string): RunLayout {
  const root = `${posix.dirname(toPosix(main))}/ph-ship/${slug}`;
  return {
    root,
    batch: `${root}/ship-${runHead(slug)}`,
    reports: `${root}/reports`,
    branch: `${RUN_BRANCH_PREFIX.slice('refs/heads/'.length)}${slug}`,
  };
}

/**
 * The file name of a batch's trimmed pool registry inside a report dir.
 */
export const BATCH_REGISTRY_FILE = 'pool-registry.batch.json';

/**
 * The namespace of a run's slice branches.
 *
 * @param slug - The run's slug.
 * @returns `slice/<slug>/`.
 */
export function sliceBranchPrefix(slug: string): string {
  return `slice/${slug}/`;
}

/**
 * A slice's layout from its id.
 *
 * @param root - The run root.
 * @param slug - The run's slug.
 * @param id - The slice id, prefixed `a<run>-` for an attached run's.
 * @param run - The attached run's number; `null` for an unattached run.
 * @returns `<root>/slice-<id>` on `slice/<slug>/<id>`.
 */
function sliceAt(root: string, slug: string, id: string, run: number | null): SliceLayout {
  const named = run === null ? id : `a${String(run)}-${id}`;
  return { path: `${root}/slice-${named}`, branch: `${sliceBranchPrefix(slug)}${named}` };
}

/**
 * The layout of attempt `attempt` of `issue`'s slice.
 *
 * @param root - The run root ({@link RunLayout.root}).
 * @param slug - The run's slug.
 * @param issue - The issue number.
 * @param attempt - The attempt number, 1 for the first.
 * @param run - The attached run's number; `null` (the default) for an
 *   unattached run.
 * @returns The slice worktree path and branch: id `<N>-<K>`, or
 *   `a<run>-<N>-<K>` for an attached run.
 */
export function sliceLayout(
  root: string,
  slug: string,
  issue: number,
  attempt: number,
  run: number | null = null,
): SliceLayout {
  return sliceAt(root, slug, `${String(issue)}-${String(attempt)}`, run);
}

/**
 * The layout of the epic end's critic slice — one per run.
 *
 * @param root - The run root ({@link RunLayout.root}).
 * @param slug - The run's slug.
 * @param run - The attached run's number; `null` (the default) for an
 *   unattached run.
 * @returns `<root>/slice-critic` on `slice/<slug>/critic`, or
 *   `slice-a<run>-critic` on `slice/<slug>/a<run>-critic` for an attached run.
 */
export function criticSliceLayout(
  root: string,
  slug: string,
  run: number | null = null,
): SliceLayout {
  return sliceAt(root, slug, 'critic', run);
}

/**
 * An attached run's own report folder.
 *
 * @param layout - The run's layout.
 * @param run - The attached run's number.
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
