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

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
