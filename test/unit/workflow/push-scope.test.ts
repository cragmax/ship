import { describe, expect, it } from 'vitest';

import { isPlatformWide } from '../../../src/workflow/pr/push-scope.js';

describe('isPlatformWide', () => {
  // One path per entry of the repo's Platform-wide list, so an entry dropped from the copy shows.
  it.each([
    'ph-plugin/build.gradle.kts',
    'src/fluent/ph-plugin-protocol.ts',
    'src/rcon/client.ts',
    'src/engine/bot/wrapped-bot.ts',
    'src/engine/state/bot-list.ts',
    'server-pool/src/lease.ts',
    'src/world-state-reset/index.ts',
    'tooling/integration/run-integration.ts',
    'tooling/lib/integration-tiers.ts',
    'tooling/hooks/push-scope.ts',
    'tooling/hooks/lib/push-scope.ts',
    'tooling/hooks/lib/platform-wide.ts',
    'tooling/hooks/lib/master-guard.ts',
    'tooling/lib/strings.ts',
    'lefthook.yml',
    '.lefthook/pre-push/server.sh',
    'config/vitest.config.ts',
    'config/vitest.integration.config.ts',
    'config/vitest.bodies.config.ts',
    'test/helpers/fixtures.ts',
    'tooling/test/helpers/worktree-fixture.ts',
    'package.json',
    'package-lock.json',
  ])('matches %s', (path) => {
    expect(isPlatformWide(path)).toBe(true);
  });

  it.each([
    'package.json.bak',
    'lefthook.yml.orig',
    'tooling/lib/strings.ts.map',
    'src/rcon',
    'tooling/hooks/commit-msg.ts',
  ])('does not match %s, outside every entry', (path) => {
    expect(isPlatformWide(path)).toBe(false);
  });
});
