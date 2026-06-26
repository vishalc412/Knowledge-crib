/**
 * Minimal, zero-dependency `.gitignore` matcher — the canonical "this isn't repo content" signal.
 *
 * `discoverFiles` layers this on top of {@link DEFAULT_IGNORES} so the soul reflects *committed*
 * content, not machine-local state: a repo's own `.gitignore` excludes its build output, dependency
 * caches, editor dirs, session state (`.claude/`, `.gstack/`), and — critically — secret files (`.env`,
 * `*.key`) that must NEVER be read + hashed into the soul. Without this, `crib index` on a repo that
 * gitignores `.env` would still read it for content hashing and persist its text into the soul.
 *
 * Semantics implemented (gitignore spec, the subset that matters in practice):
 *   - `#` comments and blank lines are skipped.
 *   - A leading `!` negates; the LAST matching rule wins (re-include overrides earlier ignore).
 *   - A trailing `/` makes the pattern directory-only.
 *   - A pattern containing a `/` (other than a trailing one) is *anchored* relative to the directory
 *     of the `.gitignore` file it came from; otherwise it matches a name at ANY depth.
 *   - Globs: `*` = one segment (`[^/]*`), `**` = across separators (`.*`), `?` = one char, `[abc]` =
 *     character class. Other regex metacharacters are escaped.
 *   - Nested `.gitignore` files scope their rules to their own subtree; a deeper file's rules take
 *     precedence over a shallower file's (matches git's precedence rule).
 *
 * NOT handled: `**` with complex surrounding globs beyond the common mid-path double-glob shape, and per-pattern
 * leading-slash anchoring is supported, but full gitignore edge cases (e.g. escaped spaces) are out of
 * scope — knowledge-crib indexes code repos, where patterns are simple. The matcher is deliberately
 * conservative: when in doubt it does NOT ignore (a false-include is a tolerable extra file node; a
 * false-exclude would silently drop real source).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GitignoreRule {
  /** `!`-prefixed → re-include. */
  negated: boolean;
  /** Trailing `/` → matches directories only. */
  dirOnly: boolean;
  /** Contains a `/` (after stripping the trailing slash) → anchored to the .gitignore dir. */
  anchored: boolean;
  /** Compiled glob regex. For unanchored rules, matches `<name>` at the end of any path. */
  re: RegExp;
}

/** A gitignore file's rules plus the repo-relative directory they are scoped to (empty = repo root). */
interface GitignoreLayer {
  dir: string;
  rules: GitignoreRule[];
}

/** Parse `.gitignore` text into rules (order preserved; last match wins at match time). */
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith('/')) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern === '') continue; // a bare `!` or `/` — nothing to match
    // Strip a SINGLE leading anchor slash (rooted to the .gitignore dir). A trailing slash was already
    // removed; any remaining slash makes the pattern anchored.
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    const anchored = pattern.includes('/');
    rules.push({ negated, dirOnly, anchored, re: compileGlob(pattern, anchored) });
  }
  return rules;
}

/**
 * Compile a gitignore glob into a `RegExp`.
 *   - anchored → `^<glob>$` (matched against the path relative to the .gitignore dir).
 *   - unanchored → `(^|/)<glob>$` (matches the name at any depth).
 */
function compileGlob(pattern: string, anchored: boolean): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!; // loop bound guarantees this is defined (noUncheckedIndexedAccess)
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` matches across path separators. Consume an optional following slash so a mid-path
        // double-glob collapses to a single `.*` rather than leaving a double slash (never a match).
        src += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        src += '\\['; // unterminated — treat as a literal bracket
      } else {
        src += pattern.slice(i, end + 1); // char class copies through verbatim
        i = end;
      }
    } else if (/[.+^$(){}|\\]/.test(c)) {
      src += `\\${c}`;
    } else {
      src += c;
    }
  }
  return anchored ? new RegExp(`^${src}$`) : new RegExp(`(^|/)${src}$`);
}

/**
 * Mutable, layered matcher. Add the root `.gitignore`, then add nested `.gitignore` rules as the
 * walk descends into their directories. Layers are scoped by their `dir` prefix, so accumulating them
 * (without popping) is safe — a rule from `packages/a/.gitignore` cannot leak into `packages/b/`.
 */
export class GitignoreMatcher {
  private readonly layers: GitignoreLayer[] = [];

  /** Add rules scoped to `dir` (empty string for the repo root). No-op for an empty rule set. */
  add(dir: string, rules: GitignoreRule[]): void {
    if (rules.length > 0) this.layers.push({ dir, rules });
  }

  /**
   * True iff `relPath` (repo-relative, POSIX) is ignored. Layers apply in insertion order (root first,
   * deeper later), and the LAST matching rule across all applicable layers wins — so a deeper
   * `.gitignore` overrides a shallower one, and a `!` re-include overrides an earlier ignore.
   */
  isIgnored(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const layer of this.layers) {
      if (layer.dir !== '' && !(relPath === layer.dir || relPath.startsWith(`${layer.dir}/`))) {
        continue; // path is outside this layer's subtree
      }
      const rel = layer.dir === '' ? relPath : relPath.slice(layer.dir.length + 1);
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(rel)) ignored = !rule.negated;
      }
    }
    return ignored;
  }
}

/** Read + parse a `.gitignore` at `dir/.gitignore` if present, else return `[]`. */
export function readGitignore(root: string, dir: string): GitignoreRule[] {
  const path = dir === '' ? join(root, '.gitignore') : join(root, dir, '.gitignore');
  if (!existsSync(path)) return [];
  try {
    return parseGitignore(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}
