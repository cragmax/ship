/**
 * The run layout of an unattended run (ADR-0045) — the one home of its
 * naming rules. Every tool that names a run's branch or directory derives
 * it here, never by re-spelling the rule:
 *
 * - the slug: `epic-<E>` for an epic run, the issue numbers ascending and
 *   joined with `-` for an explicit list;
 * - the feature branch `ship/<slug>` — the namespace pre-flight's live-run
 *   check keys on, which nothing else may use;
 * - the run root `<dirname(main)>/ph-runs/<slug>/`, a sibling of the main
 *   checkout, holding `batch/` (the batch worktree), `slice-<N>-<K>/` (one
 *   per issue attempt) and `reports/`;
 * - the slice branch `slice/<slug>/<N>-<K>`, never under `ship/`.
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

/** What a run ships: one epic, or an explicit list of issues. */
export type RunSelection = { readonly epic: number } | { readonly issues: readonly number[] };

/** Where a run lives; paths absolute with forward slashes. */
export interface RunLayout {
  /** The run root. */
  readonly root: string;
  /** The batch worktree. */
  readonly batch: string;
  /** The run's report directory. */
  readonly reports: string;
  /** The feature branch, short form (`ship/<slug>`). */
  readonly branch: string;
}

/** Where one issue attempt's slice lives. */
export interface SliceLayout {
  /** The slice worktree, absolute with forward slashes. */
  readonly path: string;
  /** The slice branch, short form (`slice/<slug>/<N>-<K>`). */
  readonly branch: string;
}

/**
 * The slug of a run.
 *
 * @param selection - The epic, or the explicit issue list (any order; the
 *   caller has checked each is a positive integer).
 * @returns `epic-<E>`, or the numbers ascending joined with `-`.
 */
export function runSlug(selection: RunSelection): string {
  if ('epic' in selection) return `epic-${String(selection.epic)}`;
  return [...selection.issues]
    .sort((a, b) => a - b)
    .map(String)
    .join('-');
}

/**
 * The layout of the run with `slug` of the repository whose main checkout
 * is `main`.
 *
 * @param main - The main checkout, either slash direction.
 * @param slug - From {@link runSlug}.
 * @returns The run root, its batch and report directories, and the
 *   feature branch.
 */
export function runLayout(main: string, slug: string): RunLayout {
  const root = `${posix.dirname(toPosix(main))}/ph-runs/${slug}`;
  return {
    root,
    batch: `${root}/batch`,
    reports: `${root}/reports`,
    branch: `${RUN_BRANCH_PREFIX.slice('refs/heads/'.length)}${slug}`,
  };
}

/**
 * The layout of attempt `attempt` of `issue`'s slice.
 *
 * @param root - The run root ({@link RunLayout.root}).
 * @param slug - The run's slug.
 * @param issue - The issue number.
 * @param attempt - The attempt number, 1 for the first.
 * @returns The slice worktree path and branch.
 */
export function sliceLayout(
  root: string,
  slug: string,
  issue: number,
  attempt: number,
): SliceLayout {
  const id = `${String(issue)}-${String(attempt)}`;
  return { path: `${root}/slice-${id}`, branch: `slice/${slug}/${id}` };
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
