import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The VR client imports the shared slideshow modules by their served
    // URL ('/shared-js/…'); map those to the real files for unit tests.
    alias: {
      '/shared-js/slideshow-timing.js': fileURLToPath(new URL('./renderer/js/slideshow-timing.js', import.meta.url)),
      '/shared-js/slideshow-color.js': fileURLToPath(new URL('./renderer/js/slideshow-color.js', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js'],
    globals: true,
    setupFiles: ['tests/setup.js'],

    // Auto-retry transient flakes (timer races, WebSocket cold-starts,
    // vite source-map cold-load) so the suite stops failing for non-bug
    // reasons. A genuinely-broken test still fails after 2 retries; a
    // flake passes on attempt 2 or 3. If a test consistently needs the
    // retry, it's a real race condition and belongs in
    // notes/FLAKY-TESTS.md — re-runs are not a substitute for a fix.
    retry: 2,

    // Cap parallel test-file workers to reduce contention with timer /
    // WebSocket / canvas tests. Default is one-per-CPU which races
    // those tests against each other; 4 is the sweet spot on typical
    // dev hardware. Vitest 4 moved pool config to top-level; the
    // poolOptions wrapper was removed.
    pool: 'threads',
    maxWorkers: 4,
    minWorkers: 1,
  },
});
