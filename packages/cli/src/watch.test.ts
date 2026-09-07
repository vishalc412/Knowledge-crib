/**
 * W6 — watch mode convergence (PRD line 365, exit gate line 375, verification matrix line 410).
 *
 * `crib serve --watch` must reach convergence within one debounce plus one fallback scan: an
 * uncommitted edit becomes queryable through the overlay WITHOUT dirtying committed `.crib/graph`,
 * a missed watcher event is caught by the 2s fallback VCS scan, an external `crib update` is
 * detected via manifest drift and resynced, and restarting watch reproduces the same working
 * snapshot. The VCS scan is the source of truth; `fs.watch` is only a low-latency trigger, so these
 * tests lean on the fallback scan (deterministic) rather than the OS watcher (flaky on CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, WorkingOverlay, newManifest, pathFromId } from '@knowledge-crib/core';
import type { OverlayRefreshResult } from '@knowledge-crib/pipeline';
import { indexRepo, untrackedFiles } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WatchMode } from './watch.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-watch-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), "export function greet(): string { return 'hi'; }\n");
  writeFileSync(
    join(repo, 'src', 'b.ts'),
    "import { greet } from './a.js';\nexport function main(): string { return greet(); }\n",
  );
  git(repo, ['init', '-q']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function soulFor(): SoulStore {
  const s = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  s.load();
  return s;
}

/** Resolve when `onRefresh` reports a dirty set containing `path`, or reject after `timeoutMs`. */
function waitForDirty(
  path: string,
  timeoutMs = 4000,
): { promise: Promise<OverlayRefreshResult>; onRefresh: (r: OverlayRefreshResult) => void } {
  let resolve!: (r: OverlayRefreshResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<OverlayRefreshResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(
    () => reject(new Error(`timed out waiting for dirty ${path}`)),
    timeoutMs,
  );
  const onRefresh = (r: OverlayRefreshResult): void => {
    if (r.dirty.includes(path)) {
      clearTimeout(timer);
      resolve(r);
    }
  };
  return { promise, onRefresh };
}

function symbolIn(overlay: WorkingOverlay, path: string, name: string): boolean {
  for (const n of overlay.store.iterate('symbol')) {
    if (n.file === path && n.name === name) return true;
  }
  return false;
}
function callsBtoA(overlay: WorkingOverlay): boolean {
  for (const e of overlay.store.iterateEdges('calls')) {
    if (pathFromId(e.src) === 'src/b.ts' && pathFromId(e.dst) === 'src/a.ts') return true;
  }
  return false;
}
/** Bytes of every committed extracted shard + manifest (must stay identical through watch). */
function committedBytes(): string {
  const crib = join(repo, '.crib', 'graph');
  let out = '';
  const walk = (d: string): void => {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out += readFileSync(full, 'utf8');
      }
    } catch {
      /* not present yet */
    }
  };
  walk(join(crib, 'extracted'));
  return out;
}

describe('WatchMode — convergence (exit gate line 375)', () => {
  it('an uncommitted edit becomes queryable in the overlay within one debounce + one fallback, without dirtying .crib/graph', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.setVcsHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    soul.commit('2026-01-01T00:00:00Z');
    const canonicalSnapshot = committedBytes();

    const overlay = new WorkingOverlay(soul);
    const { promise, onRefresh } = waitForDirty('src/a.ts');
    const watch = new WatchMode(soul, overlay, repo, { debounceMs: 40, fallbackMs: 80, onRefresh });
    await watch.start();
    try {
      // Edit the callee (uncommitted). Keep `greet` on line 1 → stable content-addressed id.
      writeFileSync(
        join(repo, 'src', 'a.ts'),
        "export function greet(): string { return 'hello'; }\n",
      );
      const result = await promise;
      expect(result.dirty).toContain('src/a.ts');
      // Edit re-parsed into the overlay + closure re-resolved (b→a re-emitted).
      expect(symbolIn(overlay, 'src/a.ts', 'greet')).toBe(true);
      expect(callsBtoA(overlay)).toBe(true);
      // Exit gate: committed .crib/graph is byte-identical — the overlay is ephemeral.
      expect(committedBytes()).toBe(canonicalSnapshot);
    } finally {
      watch.stop();
    }
  });

  it('an untracked source file is picked up by the fallback VCS scan', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');

    const overlay = new WorkingOverlay(soul);
    const { promise, onRefresh } = waitForDirty('src/c.ts');
    const watch = new WatchMode(soul, overlay, repo, { debounceMs: 40, fallbackMs: 80, onRefresh });
    await watch.start();
    try {
      writeFileSync(join(repo, 'src', 'c.ts'), 'export function extra(): number { return 1; }\n');
      const result = await promise;
      expect(result.dirty).toContain('src/c.ts');
      expect(symbolIn(overlay, 'src/c.ts', 'extra')).toBe(true);
    } finally {
      watch.stop();
    }
  });

  it('restart produces the same working snapshot (deterministic reconstruction from VCS state)', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    // Leave a.ts edited (uncommitted) on disk for both watch sessions.
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      "export function greet(): string { return 'hello'; }\n",
    );

    async function snapshotDirty(): Promise<readonly string[]> {
      const overlay = new WorkingOverlay(soul);
      const { promise, onRefresh } = waitForDirty('src/a.ts');
      const watch = new WatchMode(soul, overlay, repo, {
        debounceMs: 40,
        fallbackMs: 80,
        onRefresh,
      });
      await watch.start();
      try {
        await promise;
        return overlay.dirty;
      } finally {
        watch.stop();
      }
    }
    const first = await snapshotDirty();
    const second = await snapshotDirty();
    expect([...second]).toEqual([...first]);
    expect(second).toContain('src/a.ts');
  });
});

describe('WatchMode — external crib update drift', () => {
  it('the fallback detects canonical drift, resyncs the overlay, and fires onDrift', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.setVcsHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    soul.commit('2026-01-01T00:00:00Z');

    const overlay = new WorkingOverlay(soul);
    let drifted = false;
    const watch = new WatchMode(soul, overlay, repo, {
      debounceMs: 40,
      fallbackMs: 80,
      onDrift: () => {
        drifted = true;
      },
    });
    await watch.start();
    try {
      // Simulate another process running `crib update`: advance canonical on disk. The overlay's
      // captured fingerprint is now stale.
      soul.setVcsHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      soul.commit('2026-02-02T00:00:00Z');
      // Wait for the fallback scan to notice the drift + resync.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (drifted && !overlay.canonicalDrifted()) {
            clearInterval(t);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(t);
          resolve();
        }, 4000);
      });
      expect(drifted).toBe(true);
      expect(overlay.canonicalDrifted()).toBe(false); // resync re-seeded from the advanced soul
    } finally {
      watch.stop();
    }
  });

  /**
   * R04 (docs/audits/2026-09-05/post-merge-reaudit.md) — a canonical advance over a CLEAN working
   * tree must still reach `onRefresh`.
   *
   * Consumers rebuild their read projections in that callback (`crib serve` rebuilds the overlay
   * FTS index there and nowhere else). `refresh()` used to return early whenever the dirty set was
   * empty, which is exactly the shape of an external `crib update` that committed everything: the
   * server logged "canonical soul advanced — overlay resynced", `status` reported the NEW head,
   * and queries kept being answered from the projection built against the OLD graph. The audit saw
   * a connected reader return no match for a symbol that a freshly started reader found at once.
   *
   * The tree here is COMMITTED — with uncommitted files present, the dirty set is non-empty and
   * `onRefresh` fires for that reason instead, which is why the original drift test missed this.
   */
  it('fires onRefresh on drift even when the working tree is CLEAN (nothing to re-parse)', async () => {
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.setVcsHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    soul.commit('2026-01-01T00:00:00Z');

    const overlay = new WorkingOverlay(soul);
    const refreshes: { dirty: number; reason: string }[] = [];
    const watch = new WatchMode(soul, overlay, repo, {
      debounceMs: 40,
      fallbackMs: 80,
      onRefresh: (result, reason) => refreshes.push({ dirty: result.dirty.length, reason }),
    });
    await watch.start();
    try {
      expect(overlay.dirty).toHaveLength(0); // the precondition the bug depended on

      // Another process runs `crib update`: canonical advances, working tree stays clean.
      soul.setVcsHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      soul.commit('2026-02-02T00:00:00Z');

      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (refreshes.some((r) => r.reason === 'drift')) {
            clearInterval(t);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(t);
          resolve();
        }, 4000);
      });
      const drift = refreshes.find((r) => r.reason === 'drift');
      expect(drift, 'onRefresh must fire for the drift so readers rebuild').toBeDefined();
      // Honest payload: no file was re-parsed. The callback's job here is only to say
      // "canonical moved, rebuild what you derived from it".
      expect(drift?.dirty).toBe(0);
    } finally {
      watch.stop();
    }
  });
});

describe('WatchMode — clean Git transitions', () => {
  it('overlays a clean branch switch without requiring an external crib update', async () => {
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-qb', 'alternate']);
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      'export function alternateOnly(): number { return 2; }\n',
    );
    git(repo, ['add', 'src/a.ts']);
    git(repo, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'alternate']);
    git(repo, ['checkout', '-q', base]);

    const soul = soulFor();
    await indexRepo(soul, repo);
    const overlay = new WorkingOverlay(soul);
    const watch = new WatchMode(soul, overlay, repo, {
      debounceMs: 40,
      fallbackMs: 80,
    });
    await watch.start();
    try {
      git(repo, ['checkout', '-q', 'alternate']);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for clean branch transition')),
          4000,
        );
        const poll = setInterval(() => {
          if (
            !symbolIn(overlay, 'src/a.ts', 'alternateOnly') ||
            symbolIn(overlay, 'src/a.ts', 'greet')
          )
            return;
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }, 25);
      });
      expect(symbolIn(overlay, 'src/a.ts', 'alternateOnly')).toBe(true);
      expect(symbolIn(overlay, 'src/a.ts', 'greet')).toBe(false);
    } finally {
      watch.stop();
    }
  });
});

describe('WatchMode — VCS scan is the source of truth', () => {
  it('untrackedFiles respects .gitignore (gitignored untracked files are excluded from the dirty set)', () => {
    writeFileSync(join(repo, '.gitignore'), 'src/ignored.ts\n');
    writeFileSync(join(repo, 'src', 'ignored.ts'), 'export function ghost(): void {}\n');
    writeFileSync(join(repo, 'src', 'seen.ts'), 'export function visible(): void {}\n');
    const untracked = untrackedFiles(repo);
    expect(untracked).toContain('src/seen.ts');
    expect(untracked).not.toContain('src/ignored.ts');
  });

  it('isWatchable filtering is exercised via collectDirty: a build-output .ts file is never reported', async () => {
    // `dist/` is in IGNORE_PREFIXES; even though a .ts file under it is a source-ish lang, the
    // watcher must not schedule refreshes for it. We assert via the dirty set after a fallback.
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'out.ts'), 'export function built(): void {}\n');

    const overlay = new WorkingOverlay(soul);
    let reported: readonly string[] = [];
    const watch = new WatchMode(soul, overlay, repo, {
      debounceMs: 40,
      fallbackMs: 80,
      onRefresh: (r) => {
        reported = r.dirty;
      },
    });
    await watch.start();
    try {
      // Let at least one fallback scan fire.
      await new Promise((r) => setTimeout(r, 250));
      expect(reported).not.toContain('dist/out.ts');
    } finally {
      watch.stop();
    }
  });
});
