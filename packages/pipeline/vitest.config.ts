import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Measured 2026-09-23: under the default `pnpm -r run test` — pnpm's 4-way workspace concurrency,
  // since this repo has no `.npmrc` — 9 tests timed out at vitest's 5s default, every one of them a
  // full-index / re-index test (and several of them the determinism gates). This package alone still
  // kept one timeout, and that test ran in 1,384 ms when given room: the budget is the defect, not
  // the test. Same diagnosis and same fix as packages/cli/vitest.config.ts, which carried it alone.
  //
  // NOTE: these MUST live under `test:` — Vitest reads its options from that key, and a top-level
  // `testTimeout` is silently swallowed by Vite as an unknown root option.
  test: {
    testTimeout: 30_000,
    // Several suites `beforeEach` a full indexRepo + index build, so the hook budget has to move with
    // the test budget or the hook times out first and reads as an unrelated failure.
    hookTimeout: 30_000,
  },
  plugins: [
    {
      name: 'handle-node-sqlite',
      enforce: 'pre',
      resolveId(id) {
        // Vite 5 does not recognize node:sqlite as a built-in and strips the node: prefix,
        // trying to resolve a package named "sqlite". Canonicalize it so our load hook runs.
        if (id === 'node:sqlite' || id === 'sqlite') {
          return 'node:sqlite';
        }
      },
      load(id) {
        if (id === 'node:sqlite') {
          // Load the real Node.js built-in at runtime; Vite never sees the native module.
          return "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); export const DatabaseSync = require('node:sqlite').DatabaseSync;";
        }
      },
    },
  ],
});
