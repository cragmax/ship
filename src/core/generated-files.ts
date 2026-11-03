/**
 * Render-safe (`src/build/workflow-render.ts`): it joins the `ship` workflow's render
 * closure through `preflight.ts`, so pre-flight's overlap filter and `harvest`'s regeneration
 * share one name.
 */

/** The ESLint suppressions baseline, repository-relative. */
export const ESLINT_SUPPRESSIONS = 'eslint-suppressions.json';

/** Generated or baseline files, repository-relative. */
export const GENERATED_FILES: readonly string[] = [ESLINT_SUPPRESSIONS];
