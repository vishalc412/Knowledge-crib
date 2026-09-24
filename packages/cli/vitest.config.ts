import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // This package's suites are END-TO-END: most of them `execFileSync` the BUILT `dist/cli.js` once
  // per assertion, and some index a real fixture repo in `beforeEach`. Process spawn + Node boot is
  // the dominant cost, and it is exactly what a shared CI runner is slowest at.
  //
  // vitest's 5s default was never a sane budget for that. Measured on a fast local machine the
  // slowest test already sat at ~2.6s (51% of the default) with a dozen more at 1.6-2.6s, so any
  // runner ~2x slower failed the whole band at once — which is precisely how CI failed: 9 tests
  // across 3 files, every one of them "Test timed out in 5000ms", while the same suite passed
  // locally. Raising the ceiling fixes the real defect (an under-provisioned budget) rather than
  // the symptom; 30s still catches a genuinely hung spawn instead of hanging the job forever.
  //
  // CORRECTED 2026-09-23 — "only this package needs it" did not hold, and the failure signature
  // above (N tests, every one "Test timed out in 5000ms", green when run locally) recurred in the
  // packages that had no budget of their own. Running the default `pnpm -r run test` — pnpm's 4-way
  // workspace concurrency, since this repo has no `.npmrc` — put `memory`, `pipeline` and `mcp` over
  // the 5s default: 10 timeouts, 9 of them in `pipeline`, plus an `onTaskUpdate` worker-IPC timeout
  // in `mcp` that exited 1 while reporting 490/490 passed. Every one of them passed when run alone;
  // the only variable was what else was on the CPU. The `~1.0s` above is a quiet-box measurement of
  // the slowest *test* and says nothing about a package under four-way load, which is why the budget
  // now lives in those three configs too.
  //
  // NOTE: these MUST live under `test:` — Vitest reads its options from that key, and a top-level
  // `testTimeout` is silently swallowed by Vite as an unknown root option. Putting them at the root
  // first time round changed nothing and CI failed again with the same "timed out in 5000ms".
  test: {
    testTimeout: 30_000,
    // `beforeEach` in the memory/e2e suites runs a full indexRepo + index build, so the hook budget
    // has to move with the test budget or the hook times out first and reads as an unrelated failure.
    hookTimeout: 30_000,
  },
  // WP1.8 — the embed-setup tests dynamic-import a generated embedder from a mkdtemp dir under
  // os.tmpdir() (pinAdapter exercises the same audited import path as the core suite). Vite's
  // dev-file serving is restricted to the workspace root by default, so tmpdir must be
  // allow-listed or the import fails with the misleading "Does the file exist?". Same shape and
  // same realpath caveat as packages/core/vitest.config.ts.
  server: {
    fs: {
      // realpath: on macOS tmpdir() is /var/... but ids resolve to /private/var/... — the
      // allowlist must name the REAL path or the check denies the import.
      allow: [realpathSync(tmpdir())],
    },
    deps: {
      external: [/embedder\.mjs$/, /embedder\.cjs$/, /\/embed\//],
    },
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
