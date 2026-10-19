/**
 * Render-safe (`tooling/lib/workflow-render.ts`): it joins the `ship` workflow's render
 * closure through `pr-body.ts`, so the PR body and the `ship/src/cli/` guards share one limit.
 */

/** GitHub's limit on a PR body and on a comment body, counted as the JS string's `length`. */
export const GH_BODY_LIMIT = 65_536;
