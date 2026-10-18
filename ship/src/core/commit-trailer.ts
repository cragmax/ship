/**
 * The co-author trailer — the one home of the attribution line on every
 * commit an unattended run writes the message for: each landed issue's
 * commit (`tooling/workflows/lib/pr-body.ts`) and the version bump
 * (`tooling/worktree/bump.ts`).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): it joins the `ship`
 * workflow's render closure through `pr-body.ts`.
 */

/** The trailer: model-neutral, since several agents on several tiers wrote the run's work. */
export const CO_AUTHOR_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
