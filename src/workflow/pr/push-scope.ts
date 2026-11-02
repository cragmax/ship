/**
 * What the consuming repo's pre-push runs, as the PR body's full-tiers line reports it: a copy,
 * kept by hand, of the repo's Platform-wide list and `vitest related` cap
 * (`tooling/hooks/lib/platform-wide.ts`). Render-safe (`ship/src/build/workflow-render.ts`):
 * ECMAScript built-ins only, no value import, no top-level side effect.
 */

/** The paths a push changes, or why they could not be read. */
export type PushedChanges =
  | { readonly kind: 'resolved'; readonly paths: readonly string[] }
  | { readonly kind: 'unresolved'; readonly why: string };

/**
 * The Platform-wide paths: a push touching one runs both tiers in full. An entry ending `/`
 * matches every path under it. Any other matches itself only.
 */
const PLATFORM_WIDE_PATHS: readonly string[] = [
  'ph-plugin/',
  'src/fluent/ph-plugin-protocol.ts',
  'src/rcon/',
  'src/engine/bot/',
  'src/engine/state/bot-list.ts',
  'server-pool/',
  'src/world-state-reset/',
  'tooling/integration/',
  'tooling/lib/integration-tiers.ts',
  'tooling/hooks/push-scope.ts',
  'tooling/hooks/lib/push-scope.ts',
  'tooling/hooks/lib/platform-wide.ts',
  'tooling/hooks/lib/master-guard.ts',
  'tooling/lib/strings.ts',
  'lefthook.yml',
  '.lefthook/',
  'config/vitest.config.ts',
  'config/vitest.integration.config.ts',
  'config/vitest.bodies.config.ts',
  'test/helpers/',
  'tooling/test/helpers/',
  'package.json',
  'package-lock.json',
];

/**
 * The most changed files a pre-push `vitest related` run takes: past it the standalone tier runs
 * in full.
 */
export const MAX_RELATED_FILES = 300;

/** Whether a repo-relative POSIX path is a Platform-wide path. */
export function isPlatformWide(path: string): boolean {
  return PLATFORM_WIDE_PATHS.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );
}
