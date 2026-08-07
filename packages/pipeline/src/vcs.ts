/**
 * VCS (git) helpers for incremental updates (M6). Thin typed wrappers over `git` child-process calls,
 * so the pipeline can detect changed files since an anchor sha. Paths are repo-relative + POSIX.
 *
 * All callers degrade gracefully: a non-git repo or a missing anchor sha is reported, never crashes
 * the index path — `updateRepo` falls back to a full `indexRepo`.
 */
import { execFileSync } from 'node:child_process';
import { sep } from 'node:path';

export class NotARepoError extends Error {
  constructor(root: string) {
    super(`${root} is not a git work tree`);
    this.name = 'NotARepoError';
  }
}

/** True if `root` is inside a git work tree. */
export function isGitRepo(root: string): boolean {
  try {
    return (
      execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/** The current HEAD commit sha, or throws NotARepoError / "no commits yet". */
export function currentHead(root: string): string {
  const sha = git(root, ['rev-parse', 'HEAD']);
  if (sha === undefined) throw new NotARepoError(root);
  return sha;
}

/**
 * Repo-relative POSIX paths of files changed on disk between `since..HEAD` (renames disabled so a
 * renamed file shows under both names — the store drops the old path and indexes the new).
 * Returns [] if nothing changed. Throws NotARepoError if `root` is not a git work tree.
 */
export function changedFilesSince(root: string, since: string): string[] {
  const out = git(root, ['diff', '--name-only', '--no-renames', `${since}..HEAD`]);
  if (out === undefined) throw new NotARepoError(root);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(toPosix);
}

/**
 * Repo-relative POSIX paths of files with uncommitted changes relative to HEAD: both staged
 * (`--cached`) and unstaged. Does NOT include untracked files — those are not yet part of the
 * project's source-of-truth and indexing them silently could leak ignored build artifacts.
 * Returns [] if nothing changed. Throws NotARepoError if `root` is not a git work tree.
 */
export function uncommittedChanges(root: string): string[] {
  const cached = git(root, ['diff', '--cached', '--name-only', '--no-renames']) ?? '';
  const unstaged = git(root, ['diff', '--name-only', '--no-renames']) ?? '';
  const set = new Set<string>();
  for (const block of [cached, unstaged]) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) set.add(toPosix(trimmed));
    }
  }
  return [...set].sort();
}

/** True if the work tree has staged or unstaged changes relative to HEAD. */
export function hasUncommittedChanges(root: string): boolean {
  return uncommittedChanges(root).length > 0;
}

/**
 * Repo-relative POSIX paths of ALL files tracked by git (`git ls-files`). Used by the W1 committed
 * AI-artifact scanner: unlike {@link discoverFiles}, this lists tracked files EVEN WHEN they sit
 * under a `.gitignore`d tool directory (`.claude/`, `.cursor/`) — because `.gitignore` only hides
 * UNtracked files, and a tracked artifact stays listed. That is the PRD line-194 case: "uses
 * tracked-file enumeration plus a safe allowlist, even when a tracked artifact resides under a
 * normally ignored tool directory."
 *
 * Returns [] if `root` is not a git work tree (the caller falls back to the normal discovered file
 * set filtered by the artifact allowlist). Does NOT include untracked files — those are not yet
 * committed facts and indexing them could leak ignored build artifacts.
 */
export function trackedFiles(root: string): string[] {
  const out = git(root, ['ls-files']);
  if (out === undefined) return []; // non-git
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(toPosix);
}

/** One `git blame` attribution record per source line (1-based `line`). `commit` is the short sha
 *  the line was last touched by; `name`/`email` the author (email undefined when blame exposed no
 *  email — rare, e.g. a malformed mailmap). Used by the M3.1 ownership phase to map symbols → owners. */
export interface BlameLine {
  line: number;
  commit: string;
  name: string;
  email?: string;
}

/**
 * Per-line `git blame` attribution for one repo-relative file, parsed from `--line-porcelain` (one
 * header+author block per source line, so each line is self-contained). Returns [] if the file is
 * not tracked or blame fails (untracked file, binary, no commits) — the caller skips silently.
 * `--line-porcelain` is deterministic given HEAD + the working tree.
 */
export function blameLines(root: string, path: string): BlameLine[] {
  const out = git(root, ['blame', '--line-porcelain', '--', path]);
  if (out === undefined) return [];
  const lines = out.split('\n');
  const records: BlameLine[] = [];
  let cur: { line: number; commit: string; name: string; email?: string } | null = null;
  const header = /^([0-9a-f]{7,40})\s+(\d+)\s+(\d+)/;
  for (const raw of lines) {
    const h = raw.match(header);
    if (h) {
      if (cur) records.push(cur);
      cur = { line: Number(h[3] ?? '0'), commit: h[1] ?? '', name: '', email: undefined };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('author-mail ')) {
      const m = raw.match(/<([^>]+)>/);
      if (m) cur.email = m[1];
    } else if (raw.startsWith('author ') && !raw.startsWith('author-mail')) {
      cur.name = raw.slice('author '.length);
    } else if (raw.startsWith('\t')) {
      // the content line ends this record
      if (cur) records.push(cur);
      cur = null;
    }
  }
  if (cur) records.push(cur);
  return records;
}

/** Run a git subcommand; returns trimmed stdout, or undefined on git failure (missing repo/commits). */
function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

// ─── W4 trusted-ref helpers (PRD lines 250–280, 340–350) ─────────────────────
//
// `crib memory check` derives team trust from blobs present in a trusted Git ref and loads policy
// from the merge base (never the untrusted PR version). These are thin, deterministic wrappers over
// git plumbing — all use execFileSync with shell:false (the PRD line-273 execution rule applies to
// the gate runner; these read-only git calls follow the same no-shell discipline).

/** True if a git ref resolves (branch/tag/HEAD/ref). `refs/remotes/origin/HEAD`, a sha, etc. */
export function refExists(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', ref]) !== undefined;
}

/** The merge-base commit sha of `a` and `b`, or undefined if either ref is missing. */
export function mergeBase(root: string, a: string, b: string): string | undefined {
  return git(root, ['merge-base', a, b]);
}

/** The commit sha a ref resolves to, or undefined (used to pin the trusted-ref head for receipts). */
export function revParse(root: string, ref: string): string | undefined {
  return git(root, ['rev-parse', ref]);
}

/** Repo-relative POSIX paths of all files under `pathPrefix` as they exist in `ref`'s tree. */
export function lsTreeFiles(root: string, ref: string, pathPrefix: string): string[] {
  const out = git(root, ['ls-tree', '-r', '--full-tree', '--name-only', ref, '--', pathPrefix]);
  if (out === undefined) return [];
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(toPosix);
}

/** The full contents of `path` (repo-relative) as it exists in `ref`'s tree, or undefined. */
export function showFileAtRef(root: string, ref: string, path: string): string | undefined {
  // `git show` returns the blob contents; ref:path uses the path-in-tree syntax.
  return git(root, ['show', `${ref}:${path}`]);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
