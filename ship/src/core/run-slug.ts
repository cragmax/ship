/**
 * The slug of an unattended run (Ship ADR-0001 decision 3): the name its run branch, run root, and
 * slice branches share. Apart from `ship/src/cli/git/run-layout.ts`, which spells the rest of the
 * layout, so the `ship` workflow can name a run before it is cut.
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

/** What a run ships: one epic, or an explicit list of issues. */
export type RunSelection = { readonly epic: number } | { readonly issues: readonly number[] };

/** The prefix of an epic run's slug. */
export const EPIC_SLUG_PREFIX = 'epic-';

/**
 * The slug of a run.
 *
 * @param selection - The epic, or the explicit issue list (any order, and the
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
