import { defineConfig } from 'vitest/config';

/**
 * Tests run in plain Node, not a browser.
 *
 * Everything under `src/db`, `src/srs`, `src/export` and `src/sync` is
 * browser-free apart from the IndexedDB global, which `fake-indexeddb`
 * supplies in the setup file — so the entire data layer can be exercised
 * without jsdom, and the suite stays fast enough to leave running.
 *
 * Files are isolated from each other by default, so each test file gets its
 * own empty IndexedDB; `resetDatabase()` in src/test/helpers.ts clears it
 * between tests within a file.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
