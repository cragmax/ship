import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    // A real teardown under test must not kill the tsserver of the session running the suite;
    // CLI subprocesses inherit the switch.
    env: { PH_TSSERVER_RESTART: 'off' },
    // Threads forbid `process.chdir`. Needs the Node floor in package.json's `engines`: an older
    // Node corrupts its heap on worker exit.
    pool: 'threads',
  },
});
