/**
 * VCS anchor + content-digest semantics (WP4.3/WP4.4).
 *
 * Two behaviors this file pins that the path-list era got wrong:
 *
 * 1. A rebased-away anchor is NOT "not a git work tree". The old `changedFilesSince` threw
 *    NotARepoError for both, so `crib update` crashed on a healthy repo and `detect_changes`
 *    reported the wrong repair. The typed {@link AnchorUnavailableError} must come out of the one
 *    failure and `updateRepo` must degrade to a full re-index on it, never crash.
 * 2. The working-tree digest is CONTENT-addressed. The old digests hashed the dirty PATH LIST, so
 *    an edit inside an already-dirty file left the digest unchanged — the exact state a resume
 *    anchor and a gate receipt exist to detect.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnchorUnavailableError,
  NotARepoError,
  changedFilesSince,
  contentDigestForPaths,
  dirtyTreeFingerprint,
  uncommittedChanges,
} from './vcs.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-vcs-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const one = 1;\n');
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('changedFilesSince — anchor availability is not repo-ness (WP4.4)', () => {
  it('throws AnchorUnavailableError when the anchor was rebased away, NOT NotARepoError', () => {
    const orphan = git(['rev-parse', 'HEAD']);
    // Rewrite history: amend replaces the commit. The amend ALONE is not enough to make the old
    // sha unresolvable — the reflog still reaches it — so expire + gc, which is exactly the state
    // a user ends up in after `git rebase` + a few weeks of routine gc.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const two = 2;\n');
    git(['add', '.']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--amend', '-m', 'two']);
    git(['reflog', 'expire', '--expire=now', '--all']);
    git(['gc', '--prune=now', '--quiet']);
    expect(() => changedFilesSince(repo, orphan)).toThrow(AnchorUnavailableError);
    try {
      changedFilesSince(repo, orphan);
    } catch (err) {
      // The message must name the anchor and the repair — it is the operator's only signal.
      expect((err as Error).message).toContain(orphan);
      expect((err as Error).message).toContain('re-index');
    }
  });

  it('still throws NotARepoError when the root genuinely is not a work tree', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'crib-vcs-norepo-'));
    try {
      expect(() => changedFilesSince(notRepo, 'deadbeef')).toThrow(NotARepoError);
      expect(() => changedFilesSince(notRepo, 'deadbeef')).not.toThrow(AnchorUnavailableError);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe('dirtyTreeFingerprint / contentDigestForPaths — content-addressed (WP4.3)', () => {
  it('changes when a dirty file BYTES change, with the path list unchanged', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const one = 2;\n'); // dirty
    const first = dirtyTreeFingerprint(repo);
    expect(uncommittedChanges(repo)).toEqual(['src/a.ts']);
    const same = dirtyTreeFingerprint(repo);
    // Stable across re-reads of identical state.
    expect(same.digest).toBe(first.digest);

    writeFileSync(join(repo, 'src', 'a.ts'), 'export const one = 3;\n'); // SAME path, new bytes
    const second = dirtyTreeFingerprint(repo);
    expect(second.paths).toEqual(['src/a.ts']); // the path list did NOT move…
    expect(second.digest).not.toBe(first.digest); // …but the digest must
  });

  it('is binary-safe: distinct binary contents do not collide via a shared U+FFFD coercion', () => {
    const bin = join(repo, 'src', 'blob.bin');
    writeFileSync(bin, Buffer.from([0x80, 0xfe, 0x01]));
    const a = contentDigestForPaths(repo, ['src/blob.bin']);
    writeFileSync(bin, Buffer.from([0xff, 0xc0, 0x01]));
    const b = contentDigestForPaths(repo, ['src/blob.bin']);
    expect(a).not.toBe(b);
  });

  it('hashes a deleted-but-staged file by its ABSENCE — distinct from any present content', () => {
    writeFileSync(join(repo, 'src', 'gone.ts'), 'export const x = 1;\n');
    git(['add', '.']);
    writeFileSync(join(repo, 'src', 'gone.ts'), 'export const x = 2;\n');
    const present = contentDigestForPaths(repo, ['src/gone.ts']);
    rmSync(join(repo, 'src', 'gone.ts'));
    const absent = contentDigestForPaths(repo, ['src/gone.ts']);
    expect(absent).not.toBe(present);
  });

  it('distinguishes two different dirty sets with identical join shapes', () => {
    // "a b" + "c" and "a" + "b c" join identically; the digest must tell them apart.
    writeFileSync(join(repo, 'src', 'a b.ts'), 'one');
    writeFileSync(join(repo, 'src', 'c.ts'), 'two');
    const digest = contentDigestForPaths(repo, ['src/a b.ts', 'src/c.ts']);
    writeFileSync(join(repo, 'src', 'a b.ts'), 'x');
    writeFileSync(join(repo, 'src', 'c.ts'), 'y');
    const other = contentDigestForPaths(repo, ['src/a b.ts', 'src/c.ts']);
    expect(digest).not.toBe(other);
  });
});
