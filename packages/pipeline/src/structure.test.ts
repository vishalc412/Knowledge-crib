import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFiles, isMinifiedArtifact } from './structure.js';

// A code-knowledge graph is only useful if its symbols are nameable. Minified and vendored code is
// neither: before this filter, two vendored React bundles contributed 401 symbols (8.9% of the
// whole graph) named `B`, `C`, `D`, `E` — and because the enrich queue ranks files by symbol
// density, the largest of them sorted FIRST in the entire enrichment backlog.
describe('discovery excludes third-party and minified artifacts', () => {
  it('classifies minified filenames', () => {
    for (const yes of ['react-dom.production.min.js', 'app.min.css', 'x.min.mjs', 'a.min.cjs']) {
      expect(isMinifiedArtifact(yes)).toBe(true);
    }
    // Ordinary source must never be caught — including files that merely contain "min".
    for (const no of ['minify.ts', 'admin.js', 'main.js', 'index.js', 'determine.ts']) {
      expect(isMinifiedArtifact(no)).toBe(false);
    }
  });

  it('skips vendor directories and minified files during discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'crib-discover-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'web', 'vendor'), { recursive: true });
      writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'src', 'app.min.js'), 'var B=1,C=2;\n');
      writeFileSync(join(root, 'web', 'vendor', 'react.js'), 'var D=3;\n');

      const found = discoverFiles(root).map((f) => f.path);
      expect(found).toContain('src/app.ts');
      expect(found).not.toContain('src/app.min.js'); // minified: mangled identifiers
      expect(found).not.toContain('web/vendor/react.js'); // vendored: not this repo's code
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
