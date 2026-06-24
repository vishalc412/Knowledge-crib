/**
 * Phase 1 — structure map. Walk the repo into `file` nodes (the dir tree is implicit in the paths).
 * Ignores VCS/build/dependency dirs and the soul itself. File content is read once here to compute
 * the content hash; the parse phase re-reads lazily via ExtractCtx (cached per file).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import type { FileMeta } from '@knowledge-crib/parsers';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  '.crib',
  'dist',
  'coverage',
  '.next',
  'build',
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
}

/** Walk `root` recursively, returning FileMeta for every non-ignored file (paths repo-relative, POSIX). */
export function discoverFiles(root: string, opts: DiscoverOpts = {}): FileMeta[] {
  const ignores = opts.ignores ?? DEFAULT_IGNORES;
  const out: FileMeta[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (ignores.has(entry)) continue;
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        const rel = toPosix(relative(root, abs));
        out.push({ path: rel, lang: langForPath(rel), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root);
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
    hash: contentHash(content),
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
