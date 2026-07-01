/**
 * Workspace detection — enumerate the packages of a monorepo before indexing so the CLI can scope
 * discovery to one package (`crib index . --package FTCCloud`) instead of always walking the whole
 * repo. Pure read over the target repo's manifest files; no extraction, no network. Returns `null`
 * for a single-package repo (no workspace manifest found) so the caller can skip the prompt and
 * index full.
 *
 * Supported layouts: pnpm-workspace.yaml, Lerna (lerna.json), Nx (nx.json — package list comes from
 * package.json#workspaces or lerna.json; nx.json alone does not enumerate), npm/Yarn workspaces
 * (package.json#workspaces), and Cargo workspaces (root Cargo.toml `[workspace].members`).
 *
 * One soul per repo is preserved: detection only narrows which package dirs discovery descends into
 * (see {@link DiscoverOpts.packageRoots}); cross-package impact queries still work because the soul
 * stays unified. Splitting into one soul per package would lose cross-package blast radius — the
 * killer feature — so we scope extraction, not storage.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';

export interface WorkspacePackage {
  /** Package name — from package.json#name when present, else the dir basename. */
  name: string;
  /** Absolute directory. */
  dir: string;
  /** Repo-relative POSIX path (e.g. `packages/FTCCloud`) — the value threaded into discovery. */
  rel: string;
}

export interface WorkspaceLayout {
  tool: 'pnpm' | 'lerna' | 'nx' | 'npm-workspaces' | 'cargo';
  packages: WorkspacePackage[];
}

/**
 * Detect a monorepo layout at `root` and enumerate its packages. Returns `null` when no workspace
 * manifest is found (single-package repo) or when no package dirs resolve on disk. Package names
 * default to the dir basename when a member has no `package.json` or no `name` field (a workspace
 * member is still a valid index target even if it isn't a published package).
 */
export function detectWorkspace(root: string): WorkspaceLayout | null {
  const pnpm = detectPnpm(root);
  if (pnpm) return pnpm;
  const lerna = detectLerna(root);
  if (lerna) return lerna;
  const nx = detectNx(root);
  if (nx) return nx;
  const npm = detectNpmWorkspaces(root);
  if (npm) return npm;
  const cargo = detectCargo(root);
  if (cargo) return cargo;
  return null;
}

/** Resolve a `--package` arg (name, rel path, or `all`) against a layout → repo-relative roots. */
export function resolvePackageArg(
  root: string,
  arg: string | undefined,
  layout: WorkspaceLayout | null,
): { packageRoots: string[] | undefined; all: boolean; unknown?: string } {
  if (!arg || arg === 'all') return { packageRoots: undefined, all: true };
  if (!layout) return { packageRoots: undefined, all: false, unknown: arg };
  const match = layout.packages.find(
    (p) => p.name === arg || p.rel === arg || p.rel === toPosix(arg),
  );
  if (!match) return { packageRoots: undefined, all: false, unknown: arg };
  return { packageRoots: [match.rel], all: false };
}

function detectPnpm(root: string): WorkspaceLayout | null {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return null;
  const patterns = parsePnpmWorkspacePatterns(readFileSync(file, 'utf8'));
  const packages = expandPatterns(root, patterns);
  if (packages.length === 0) return null;
  return { tool: 'pnpm', packages };
}

function detectLerna(root: string): WorkspaceLayout | null {
  const file = join(root, 'lerna.json');
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const patterns = toStringArray((raw as { packages?: unknown }).packages);
  if (patterns.length === 0) return null;
  const packages = expandPatterns(root, patterns);
  if (packages.length === 0) return null;
  const tool = existsSync(join(root, 'nx.json')) ? 'nx' : 'lerna';
  return { tool, packages };
}

function detectNx(root: string): WorkspaceLayout | null {
  if (!existsSync(join(root, 'nx.json'))) return null;
  // Nx does not enumerate packages itself; it inherits the package list from package.json#workspaces
  // or lerna.json. Detect via those so the tool label is honest.
  const npm = detectNpmWorkspaces(root);
  if (npm) return { tool: 'nx', packages: npm.packages };
  const lerna = detectLerna(root);
  if (lerna) return { tool: 'nx', packages: lerna.packages };
  return null;
}

function detectNpmWorkspaces(root: string): WorkspaceLayout | null {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return null;
  let pkg: { workspaces?: string[] | { packages?: string[] } };
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const patterns = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : pkg.workspaces?.packages;
  const arr = toStringArray(patterns);
  if (arr.length === 0) return null;
  const packages = expandPatterns(root, arr);
  if (packages.length === 0) return null;
  return { tool: 'npm-workspaces', packages };
}

function detectCargo(root: string): WorkspaceLayout | null {
  const file = join(root, 'Cargo.toml');
  if (!existsSync(file)) return null;
  const members = parseCargoMembers(readFileSync(file, 'utf8'));
  if (members.length === 0) return null;
  const packages = expandPatterns(root, members);
  if (packages.length === 0) return null;
  return { tool: 'cargo', packages };
}

/** Parse `packages: [a, b]` lines from a pnpm-workspace.yaml (tolerant — no YAML dependency). */
function parsePnpmWorkspacePatterns(content: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }
    // A new top-level key ends the packages block.
    if (inPackages && /^[a-zA-Z_-]+\s*:/.test(trimmed)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const m = trimmed.match(/^[-*]\s+(.+)$/);
    const raw = m?.[1] ?? trimmed;
    const val = raw.replace(/,#.*$/, '').trim();
    if (val) out.push(stripQuotes(val));
  }
  return out;
}

/** Parse `[workspace] members = [...]` (array or multi-line) from a root Cargo.toml. */
function parseCargoMembers(content: string): string[] {
  const out: string[] = [];
  let inWorkspace = false;
  let inMembers = false;
  let bracketDepth = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[workspace\]/.test(trimmed)) {
      inWorkspace = true;
      inMembers = false;
      continue;
    }
    if (trimmed.startsWith('[')) {
      inWorkspace = false;
      continue;
    }
    if (!inWorkspace) continue;
    if (/^members\s*=/.test(trimmed)) {
      const after = trimmed.slice(trimmed.indexOf('=') + 1).trim();
      if (after.startsWith('[')) {
        inMembers = true;
        bracketDepth = 1;
        collectCargoMembers(after.slice(1), out);
        if (after.includes(']')) inMembers = false;
      } else {
        // multi-line `members =\n  [...]` — wait for bracket on a later line
        inMembers = true;
      }
      continue;
    }
    if (inMembers) collectCargoMembers(trimmed, out);
  }
  return out;
}

function collectCargoMembers(segment: string, out: string[]): void {
  for (const tok of segment.split(/[\s,\[\]]+/)) {
    const v = stripQuotes(tok.trim());
    if (v && v !== '') out.push(v);
  }
}

/** Expand workspace glob patterns into existing package dirs.
 *
 * Non-recursive patterns (`packages/*`, `apps/*`) include every matched dir (a workspace member is
 * a valid index target even without a `package.json#name`). Recursive `**` patterns match every dir
 * at any depth, so they are filtered to dirs that actually look like a package (have a `package.json`
 * or `Cargo.toml`) — otherwise `libs/**` would surface every intermediate `libs/`, `libs/deep/`, …
 * parent dir as a "package". */
function expandPatterns(root: string, patterns: string[]): WorkspacePackage[] {
  const seen = new Set<string>();
  const out: WorkspacePackage[] = [];
  for (const pat of patterns) {
    const recursive = pat.includes('**');
    for (const rel of globDirs(root, pat)) {
      if (seen.has(rel)) continue;
      const dir = join(root, rel);
      if (recursive && !isPackageDir(dir)) continue;
      seen.add(rel);
      out.push({ name: packageNameAt(dir, rel), dir, rel });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Minimal glob → existing directory lister. Supports `*` (one non-dot segment) and `**` (any depth). */
function globDirs(root: string, pattern: string): string[] {
  const segs = pattern.split('/');
  const walk = (dir: string, idx: number, prefix: string): string[] => {
    if (idx >= segs.length) {
      // pattern resolved to a path; include only if it's a directory
      try {
        return statSync(dir).isDirectory() ? [prefix] : [];
      } catch {
        return [];
      }
    }
    const seg = segs[idx]!;
    if (seg === '**') {
      // zero or more dirs; collect this dir (if it's the tail) and recurse
      const results: string[] = [];
      if (idx === segs.length - 1) {
        try {
          if (statSync(dir).isDirectory()) results.push(prefix);
        } catch {
          // unreadable
        }
      }
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith('.')) continue;
          const abs = join(dir, entry);
          try {
            if (!statSync(abs).isDirectory()) continue;
          } catch {
            continue;
          }
          const childPrefix = prefix === '' ? entry : prefix + '/' + entry;
          results.push(...walk(abs, idx, childPrefix));
          results.push(...walk(abs, idx + 1, childPrefix));
        }
      } catch {
        // unreadable dir
      }
      return dedup(results);
    }
    if (seg === '*' || seg === '') {
      const results: string[] = [];
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith('.')) continue;
          const abs = join(dir, entry);
          try {
            if (!statSync(abs).isDirectory()) continue;
          } catch {
            continue;
          }
          const childPrefix = prefix === '' ? entry : prefix + '/' + entry;
          results.push(...walk(abs, idx + 1, childPrefix));
        }
      } catch {
        // unreadable
      }
      return results;
    }
    // literal segment
    const abs = join(dir, seg);
    try {
      if (!statSync(abs).isDirectory()) return [];
    } catch {
      return [];
    }
    const childPrefix = prefix === '' ? seg : prefix + '/' + seg;
    return walk(abs, idx + 1, childPrefix);
  };
  return walk(root, 0, '');
}

function isPackageDir(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'Cargo.toml'));
}

function packageNameAt(dir: string, fallbackRel: string): string {
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const name = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }).name;
      if (name) return name;
    } catch {
      // corrupt package.json — fall back to basename
    }
  }
  const cargoPath = join(dir, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const m = readFileSync(cargoPath, 'utf8').match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (m?.[1]) return m[1];
  }
  return basename(fallbackRel);
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x : '')).filter(Boolean);
}

function stripQuotes(s: string): string {
  let out = s.trim();
  const isQuote = (ch: string): boolean => ch === '"' || ch === "'" || ch === String.fromCharCode(0x60);
  while (out.length > 0 && isQuote(out[0]!)) out = out.slice(1);
  while (out.length > 0 && isQuote(out[out.length - 1]!)) out = out.slice(0, -1);
  return out.trim();
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}