import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // A real teardown under test must not kill the tsserver of the session running the suite;
    // CLI subprocesses inherit the switch.
    env: { PH_TSSERVER_RESTART: 'off' },
    testTimeout: 60_000,
  },
});
