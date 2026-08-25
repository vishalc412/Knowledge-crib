/**
 * Mule discovery pre-pass (Foundation Task 4).
 *
 * Runs between {@link discoverFiles} and {@link runStructure}: reads text for the small set of
 * marker-bearing files (descriptors + a config peek), calls {@link classifyMuleFiles} to group them
 * into Mule projects + detect dialect, and stamps a clone-safe {@link FileClassification} + a
 * role-specific `lang` onto each Mule FileMeta in place. The classification lets `MuleExtractor.
 * supports()` dispatch disjointly from generic XML/resource files (Task 13), and the `sensitive`
 * flag drives key-only / no-value hashing in {@link fileNode} so secrets never enter the soul.
 *
 * Bounded I/O: only marker paths are read (descriptors, src/main/mule|app, src/test/munit, .dwl,
 * .mel, .raml, .properties) — never the whole tree — so this stays cheap even on a 50k-file repo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractDiagnostic, FileMeta } from '@knowledge-crib/parsers';
import { contentHash } from '@knowledge-crib/soul-schema';
import { classifyMuleFiles } from './classify.js';

/** True if a path is worth reading text from for Mule dialect detection. Descriptors carry the
 *  dialect signal (packaging, mule-artifact.json); a config peek confirms legacy namespaces. */
function isMuleMarker(path: string): boolean {
  return (
    /(?:^|\/)(?:mule-artifact\.json|mule-deploy\.properties|pom\.xml)$/.test(path) ||
    path.includes('/src/main/mule/') ||
    path.includes('/src/main/app/') ||
    path.includes('/src/test/munit/') ||
    /\.(dwl|dw|mel|raml)$/.test(path)
  );
}

/** Role → lang stamp for classified Mule files (queryability + the parallel pool's grammar preload). */
const ROLE_LANG: Record<string, string> = {
  config: 'mule',
  munit: 'mule-munit',
  dataweave: 'dataweave',
  mel: 'mel',
  raml: 'raml',
  properties: 'mule-properties',
  descriptor: 'mule-descriptor',
  resource: 'mule-resource',
};

/**
 * Read text for marker-bearing files, classify Mule projects, and stamp a clone-safe
 * {@link FileClassification} + role-specific `lang` onto each Mule FileMeta IN PLACE. Non-Mule files
 * are untouched. Returns Mule diagnostics for the parse-phase aggregator (Task 7). Mutates only the
 * FileMeta objects passed in; deterministic; pure over the read text.
 */
export function classifyMuleDiscovery(root: string, files: FileMeta[]): ExtractDiagnostic[] {
  const textByPath = new Map<string, string>();
  for (const f of files) {
    if (!isMuleMarker(f.path)) continue;
    try {
      textByPath.set(f.path, readFileSync(join(root, f.path), 'utf8'));
    } catch {
      // unreadable (binary, race, permission) — classifyMuleFiles treats missing text as ''.
    }
  }
  const { files: classified, diagnostics } = classifyMuleFiles(files, textByPath);
  for (const f of files) {
    const c = classified.get(f.path);
    if (!c) continue;
    f.classification = c;
    const lang = ROLE_LANG[c.role];
    if (lang) f.lang = lang;
  }
  return diagnostics;
}

/**
 * Extract property KEYS from a `.properties`/`.yaml`/`.yml` text — names only, NEVER values. Used to
 * fingerprint sensitive config files for change detection without persisting any secret bytes.
 * Recognizes `key=value` and `key: value` (any indentation), ignoring `#`/`!` comments and blanks.
 */
export function propertyKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('---')) continue;
    const m = line.match(/^([^\s=:#!]+)\s*[:=]/);
    if (m && m[1] !== undefined) keys.push(m[1]);
  }
  return keys;
}

/** `blake3:<hex>` over the SORTED property keys of a sensitive config file — stable across value
 *  edits and reordering, and never includes a secret value. Empty key set hashes the empty string
 *  (still a valid `blake3:` digest) so a file that is all-comments still gets a stable redacted hash. */
export function keyOnlyHash(text: string): string {
  return contentHash(propertyKeys(text).sort().join('\n'));
}

/** `blake3:<hex>` over the repo-relative path only — for sensitive binary files (keystores,
 *  truststores, .jks/.p12) where there are no keys to extract and the bytes are secret. The hash
 *  stays a valid `blake3:` digest (schema requires it) while never touching file content. */
export function pathOnlyHash(repoRelativePath: string): string {
  return contentHash(repoRelativePath);
}

/**
 * The schema-valid, secret-safe content hash for a file given its classification + text.
 *  - normal file → full content hash (unchanged behavior).
 *  - sensitive `properties` → key-only hash (keys sorted; values never hashed).
 *  - any other sensitive file (binary store / secret resource) → path-only hash (bytes never hashed).
 * Non-Mule files (no classification) always get the full content hash.
 */
export function secureContentHash(file: FileMeta, content: string): string {
  const c = file.classification;
  if (!c?.sensitive) return contentHash(content);
  if (c.role === 'properties') return keyOnlyHash(content);
  return pathOnlyHash(file.path);
}
