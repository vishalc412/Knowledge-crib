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
  // Only this package needs it today — the next slowest package is `pipeline` at ~1.0s, which keeps
  // ~5x headroom under the default. Revisit if that number climbs.
  testTimeout: 30_000,
  // `beforeEach` in the memory/e2e suites runs a full indexRepo + index build, so the hook budget
  // has to move with the test budget or the hook times out first and the failure reads as unrelated.
  hookTimeout: 30_000,
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
