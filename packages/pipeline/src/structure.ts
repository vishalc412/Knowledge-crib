/**
 * Phase 1 — structure map. Walk the repo into `file` nodes (the dir tree is implicit in the paths).
 * Ignores VCS/build/dependency dirs and the soul itself. File content is read once here to compute
 * the content hash; the parse phase re-reads lazily via ExtractCtx (cached per file).
 */
import { type Stats, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import type { FileMeta } from '@knowledge-crib/parsers';
import { idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { GitignoreMatcher, readGitignore } from './gitignore.js';
import { secureContentHash } from './mule/discover.js';

/**
 * Dirs never walked by discovery: VCS, dependency caches, build output, and the soul itself.
 * Conservative — only dirs that are never meaningful source. Package-manager caches (`.yarn`,
 * `.gradle`, `target`, `.turbo`, …) are included because they hold thousands of generated/cache
 * files whose only effect is to blow up indexing time + pollute the soul with file nodes. Extend
 * per-run via `--exclude` (CLI) or `DiscoverOpts.ignores`.
 *
 * This is the GUARANTEED baseline — always excluded regardless of any `.gitignore`. On top of it,
 * {@link discoverFiles} also respects the repo's own `.gitignore` (see {@link GitignoreMatcher}) so
 * machine-local state the repo already gitignores (`.claude/`, `.gstack/`, `*.log`, `.env`, …) is
 * kept out of the soul too. The baseline stays hardcoded so a repo WITHOUT a `.gitignore` still
 * skips the universal noise dirs, and so a `.gitignore` can never re-include these (a `!node_modules`
 * line must NOT resurrect `node_modules`).
 */
export const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  '.crib',
  'dist',
  'coverage',
  '.next',
  'build',
  // package-manager / build-tool caches (generated, never source)
  '.yarn',
  '.gradle',
  'target',
  'out',
  '.turbo',
  '.parcel-cache',
  '.nuxt',
  '.svelte-kit',
  '.remix',
  '.astro',
  '.angular',
  'bower_components',
  '.cache',
  '.idea',
  '.vscode',
  '.cursor',
  'tmp',
  'temp',
  'logs',
]);

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.md': 'markdown',
  '.sql': 'sql',
  '.pkb': 'plsql',
  '.pks': 'plsql',
  '.pck': 'plsql',
  '.pls': 'plsql',
  '.pkh': 'plsql',
  '.typ': 'plsql',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

export interface DiscoverOpts {
  ignores?: Set<string>;
  /** Repo-relative POSIX dirs to scope discovery to (monorepo `--package`). When non-empty, the
   *  walk only descends into (and indexes files under) these package roots plus root-level files;
   *  sibling packages are pruned at the dir branch so a 50-package repo indexing one package does
   *  not stat the other 49. Empty/absent → full-repo walk (the default). */
  packageRoots?: string[];
}

/**
 * Walk `root` recursively, returning FileMeta for every non-ignored file (paths repo-relative, POSIX).
 *
 * A path is skipped when EITHER layer excludes it: the {@link DEFAULT_IGNORES} baseline (by entry
 * name — always, regardless of `.gitignore`) OR the repo's `.gitignore` (by repo-relative path,
 * including nested `.gitignore` files scoped to their subtree). The baseline is checked first by
 * entry name (the fast path that also prunes whole dirs before they're walked); `.gitignore` rules
 * are then evaluated on the repo-relative path so anchored/nested patterns work. The `.gitignore`
 * file itself is NOT excluded by its own rules (mirrors git) and remains a file node.
 */
export function discoverFiles(root: string, opts: DiscoverOpts = {}): FileMeta[] {
  const ignores = opts.ignores ?? DEFAULT_IGNORES;
  const git = new GitignoreMatcher();
  git.add('', readGitignore(root, ''));
  const packageRoots = (opts.packageRoots ?? [])
    .map((r) => r.replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const scoped = packageRoots.length > 0;
  // True if dir `rel` should be descended into under package scoping: root always; otherwise `rel`
  // must be an ancestor of, equal to, or inside a selected package root. Sibling packages prune here.
  const inScopeDir = (rel: string): boolean => {
    if (!scoped) return true;
    if (rel === '') return true;
    for (const pr of packageRoots) {
      if (rel === pr) return true;
      if (pr.startsWith(`${rel}/`)) return true; // rel is an ancestor of a package root
      if (rel.startsWith(`${pr}/`)) return true; // rel is inside a package root
    }
    return false;
  };
  const out: FileMeta[] = [];
  const walk = (dir: string, relDir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip rather than fail the whole walk
    }
    for (const entry of entries) {
      if (ignores.has(entry)) continue; // baseline: universal noise dirs (never walked)
      const abs = join(dir, entry);
      const rel = relDir === '' ? entry : `${relDir}/${entry}`;
      let st: Stats | undefined;
      try {
        st = statSync(abs);
      } catch {
        continue; // stat race (file vanished) — skip
      }
      if (st.isDirectory()) {
        if (git.isIgnored(rel, true)) continue; // gitignored dir → do not descend
        if (scoped && !inScopeDir(rel)) continue; // outside selected package(s) → prune descent
        // A nested .gitignore scopes its rules to this subtree. Read BEFORE descending so children
        // see the rules; the layer's `dir` prefix keeps it from leaking to sibling subtrees.
        git.add(rel, readGitignore(root, rel));
        walk(abs, rel);
      } else if (st.isFile()) {
        if (git.isIgnored(rel, false)) continue; // gitignored file → skip
        out.push({ path: rel, lang: langForPath(rel), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Phase 1: write a `file` node per discovered file into the soul. */
export function runStructure(soul: SoulStore, root: string, files: FileMeta[]): void {
  const nodes: Node[] = files.map((f) => fileNode(root, f));
  soul.putNodes(nodes);
}

/**
 * Build FileMeta for a specific set of repo-relative paths (no full walk). Used by incremental update
 * (M6) to re-extract only changed files + their reverse-dependency closure. Missing/deleted paths are
 * skipped (stat fails) — the caller's `removeByFile` has already dropped their old nodes.
 */
export function metaForPaths(root: string, paths: string[]): FileMeta[] {
  const out: FileMeta[] = [];
  for (const p of paths) {
    try {
      const st = statSync(join(root, p));
      if (st.isFile()) {
        out.push({ path: p, lang: langForPath(p), bytes: st.size, mtime: st.mtimeMs });
      }
    } catch {
      // deleted file → no meta; its old soul records are already removed
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function fileNode(root: string, file: FileMeta): Node {
  const content = safeRead(join(root, file.path));
  return {
    id: idFor({ kind: 'file', path: file.path }),
    kind: 'file',
    file: file.path,
    // Sensitive Mule files (secure properties, keystores) never hash their secret bytes: properties
    // files hash their KEYS only; binary stores hash their path only. See mule/discover.ts.
    hash: secureContentHash(file, content),
    ...(file.lang ? { lang: file.lang } : {}),
  };
}

export function langForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return LANG_BY_EXT[path.slice(dot)];
}

function safeRead(abs: string): string {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
