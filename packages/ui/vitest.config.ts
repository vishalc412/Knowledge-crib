import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same budget as cli/memory/mcp/pipeline: Windows CI runners run individual tests 10-100x slower
  // than a dev box (a 57ms core test timed out at the 5s default there), so the default is not a
  // meaningful ceiling. 30s still catches a genuine hang.
  test: {
    testTimeout: 30_000,
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
