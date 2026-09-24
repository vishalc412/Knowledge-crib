import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Measured 2026-09-23: under the default `pnpm -r run test`, this package reported `Test Files 26
  // passed (26)` / `Tests 490 passed (490)` and STILL exited 1, on a worker-IPC timeout —
  // `[vitest-worker]: Timeout calling "onTaskUpdate"`. Alone it exits 0 with no `Errors` line. So the
  // exit code here is not a signal about correctness, and the timeout is raised for the same reason
  // as packages/cli/vitest.config.ts: these index-heavy suites exceed the 5s default under 4-way
  // workspace contention, and the budget is the defect rather than the test.
  //
  // NOTE: these MUST live under `test:` — Vitest reads its options from that key, and a top-level
  // `testTimeout` is silently swallowed by Vite as an unknown root option.
  test: {
    // Files run one at a time. Measured 2026-09-24 on one machine at one load: the parallel run
    // exited 1 three times out of three on the worker-IPC timeout above (490/490 passing each time),
    // and the serial run exited 0, at 86s against ~77s. It is also what stopped both Windows CI
    // cells. Mechanism (reproduced 2026-09-24 with 70s of synchronous tests): Vitest runs sync tests
    // back to back with microtask-only yields, so the worker never reads the onTaskUpdate reply and
    // the 60s RPC timer fires once a FILE's sync tests exceed 60s — verbs.test.ts took 84s on a
    // Windows runner. vitest.setup.ts yields one macrotask per test, which removes it.
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
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
