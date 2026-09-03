import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // G3.2 — the embed-install tests dynamic-import an operator-supplied embedder module from a
  // mkdtemp dir under os.tmpdir(). Two vite/node interop traps to defuse:
  //   1. vite's dev-file serving is restricted to the workspace root by default and a dynamic
  //      import from outside it fails with the misleading "Does the file exist?" — allow-list the
  //      tmpdir so the audited import path (loadEmbedderFromModule) can be exercised at all.
  //   2. vite-node routes runtime dynamic imports through its own module graph; a file:// URL to a
  //      real on-disk module must be EXTERNALIZED to reach Node's native import instead.
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
