/**
 * The publishable workspace package set, DISCOVERED rather than hand-listed.
 *
 * The audited defect (docs/audits/2026-09-05, F10) was a hardcoded list: `packages/memory` joined
 * the workspace but was never added to `pack-check`, so the gate passed green while validating
 * seven of eight tarballs. The same omission in `build-installers` shipped installer bundles
 * without memory until it was noticed by hand. A gate whose coverage is a literal cannot report on
 * what it does not know exists, so both derive their set from the filesystem here instead.
 *
 * "Publishable" means a workspace package that is not marked `private` — exactly the set `pnpm
 * pack` can produce a tarball for.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every publishable workspace package, as `{ dir, name }`, sorted by directory for determinism.
 * `dir` is repo-relative (the form the gates pass to `pnpm pack --cwd`).
 */
export function discoverPublishablePackages() {
  const packagesRoot = join(repoRoot, 'packages');
  const found = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesRoot, entry.name, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue; // not a package directory (no readable manifest) — nothing to publish
    }
    if (manifest.private === true) continue;
    found.push({ dir: `packages/${entry.name}`, name: manifest.name });
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Assert that a hand-ordered list covers every discovered package.
 *
 * Some consumers genuinely need a specific order (installers must pack a dependency before its
 * dependents, or the offline install resolves the missing one from the public registry). Those keep
 * their ordered literal but call this, so ORDER stays hand-maintained while COVERAGE cannot silently
 * drift. Returns the ordered list; throws naming the missing or unknown entries.
 */
export function assertCoversWorkspace(orderedDirs) {
  const discovered = discoverPublishablePackages().map((p) => p.dir);
  const missing = discovered.filter((dir) => !orderedDirs.includes(dir));
  const unknown = orderedDirs.filter((dir) => !discovered.includes(dir));
  if (missing.length > 0 || unknown.length > 0) {
    const problems = [
      missing.length > 0 ? `not covered: ${missing.join(', ')}` : '',
      unknown.length > 0
        ? `listed but not a publishable workspace package: ${unknown.join(', ')}`
        : '',
    ].filter(Boolean);
    throw new Error(
      `workspace package list is out of date — ${problems.join('; ')}. Add it in dependency order (a package must precede anything that depends on it).`,
    );
  }
  return orderedDirs;
}
