/**
 * The shape of a run branch, shared by the arguments that name one:
 * `/resync`'s branch, `/ship`'s `--attach` target and, as `ship/<slug>`, each
 * slug of `worktree.ts preflight --slug`.
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

/**
 * A run branch: `ship/`, the namespace `RUN_BRANCH_PREFIX` names
 * (`ship/src/cli/git/run-layout.ts`, which cannot enter the render closure),
 * then a slug in `runSlug`'s domain (`epic-<E>`, or issue numbers joined
 * with `-`).
 */
export const RUN_BRANCH_SHAPE = /^ship\/[a-z0-9][a-z0-9-]*$/;
