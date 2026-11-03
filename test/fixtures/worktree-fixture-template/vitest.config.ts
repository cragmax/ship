// The config worktree-fixture-template.integration.test.ts runs its child vitest with.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { root: import.meta.dirname, include: ['test/unit/**/*.test.ts'] },
});
