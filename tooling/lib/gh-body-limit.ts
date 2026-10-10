/**
 * Render-safe (`tooling/lib/workflow-render.ts`): it joins the `ship` workflow's render
 * closure through `pr-body.ts`, so the PR body and the `tooling/worktree/` guards share one limit.
 */

/**
 * GitHub's limit on a PR body and on a comment body. Counted as the JS
 * string's `length` (UTF-16 code units — never fewer than the text's
 * characters); the API refuses a longer body as
 * `body is too long (maximum is 65536 characters)`.
 */
export const GH_BODY_LIMIT = 65_536;
