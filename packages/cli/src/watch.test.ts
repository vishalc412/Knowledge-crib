/**
 * W6/WP4 — watch mode convergence (PRD line 365, exit gate line 375, verification matrix line 410).
 *
 * WP4.1 split watch mode into two layers with one contract between them:
 *   - `WatchMode` (src/watch.ts) is the TRIGGER layer — fs.watch + the fallback interval, nothing
 *     else. Its tests (here) use a spy coordinator and assert only the trigger contract: debounced
 *     `requestRefresh('watcher')`, periodic `requestRefresh('fallback')`, non-watchable paths never
 *     schedule, watcher-unavailable degrades to fallback-only.
 *   - `RefreshCoordinator` (refresh-coordinator.test.ts) owns every refresh decision. The
 *     convergence tests here run a REAL coordinator end-to-end: an edit becomes queryable in the
 *     published bundle within one debounce + one fallback scan, the committed `.crib/graph` stays
 *     byte-identical, an external `crib update` and a clean branch switch each produce a new
 *     published bundle, and a restart reproduces the same snapshot — now pinned by the capture-hash
 *     generation, the strongest determinism statement the design can make.
 *
 * The VCS scan is the source of truth; `fs.watch` is only a low-latency trigger, so the convergence
 * tests lean on `coordinator.requestRefresh('fallback')` (deterministic) rather than the OS watcher.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest, pathFromId } from '@knowledge-crib/core';
import { indexRepo, untrackedFiles } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ReaderBundle, RefreshCoordinator } from './refresh-coordinator.js';
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

/** Record every published bundle; tests poll it because onPublish fires synchronously. */
function recorder(): { bundles: ReaderBundle[]; onPublish: (b: ReaderBundle) => void } {
  const bundles: ReaderBundle[] = [];
  return { bundles, onPublish: (b) => void bundles.push(b) };
}
async function waitForBundle(
  bundles: ReaderBundle[],
  want: (b: ReaderBundle) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<ReaderBundle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = bundles.find(want);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function symbolIn(store: SoulStore | undefined, path: string, name: string): boolean {
  if (!store) return false;
  for (const n of store.iterate('symbol')) {
    if (n.file === path && n.name === name) return true;
  }
  return false;
}
function callsBtoA(store: SoulStore | undefined): boolean {
  if (!store) return false;
  for (const e of store.iterateEdges('calls')) {
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

// ─── trigger layer: WatchMode → coordinator ───────────────────────────────────

describe('WatchMode — trigger layer (WP4.1)', () => {
  it('debounces a burst of watcher events into ONE requestRefresh(watcher)', async () => {
    const requests: string[] = [];
    // The debounce is a FIXED WINDOW: the first event opens it, later events are absorbed, it
    // fires once on expiry. Five writes microseconds apart can still arrive in two OS batches
    // (macOS FSEvents coalesces with its own latency, and under a loaded test runner the gap
    // exceeds a 40ms window) — so the window here must be wide enough to absorb real delivery
    // jitter, and the assertion must wait for QUIESCENCE (the count stable for a full window)
    // rather than a fixed sleep, so a straggler batch is observed, not missed.
    const DEBOUNCE_MS = 400;
    const watch = new WatchMode({ requestRefresh: (reason) => void requests.push(reason) }, repo, {
      debounceMs: DEBOUNCE_MS,
      fallbackMs: 60_000,
    });
    await watch.start();
    try {
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(repo, 'src', `x${i}.ts`), `export const n${i} = ${i};\n`);
      }
      const watcherCount = (): number => requests.filter((r) => r === 'watcher').length;
      const deadline = Date.now() + 8000;
      while (watcherCount() < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Quiescence: the watcher count must stop moving for one full window (+margin). A late
      // straggler batch would bump the count and restart the settle — and then fail the assert.
      let stableSince = Date.now();
      let lastCount = -1;
      while (Date.now() - stableSince < DEBOUNCE_MS + 150) {
        await new Promise((r) => setTimeout(r, 50));
        const n = watcherCount();
        if (n !== lastCount) {
          lastCount = n;
          stableSince = Date.now();
        }
      }
      expect(lastCount).toBe(1);
      expect(requests.filter((r) => r === 'fallback')).toHaveLength(0);
    } finally {
      watch.stop();
    }
  });

  it('fires requestRefresh(fallback) on the interval (the convergence backstop)', async () => {
    const requests: string[] = [];
    const watch = new WatchMode({ requestRefresh: (reason) => void requests.push(reason) }, repo, {
      debounceMs: 40,
      fallbackMs: 60,
    });
    await watch.start();
    try {
      await new Promise((r) => setTimeout(r, 220));
      expect(requests.filter((r) => r === 'fallback').length).toBeGreaterThanOrEqual(2);
    } finally {
      watch.stop();
    }
  });

  it('never schedules for non-watchable paths (dist/, .crib/)', async () => {
    const requests: string[] = [];
    const watch = new WatchMode({ requestRefresh: (reason) => void requests.push(reason) }, repo, {
      debounceMs: 40,
      fallbackMs: 60_000,
    });
    await watch.start();
    try {
      mkdirSync(join(repo, 'dist'), { recursive: true });
      writeFileSync(join(repo, 'dist', 'out.ts'), 'export function built(): void {}\n');
      mkdirSync(join(repo, '.crib', 'graph'), { recursive: true });
      writeFileSync(join(repo, '.crib', 'graph', 'x.json'), '{}\n');
      await new Promise((r) => setTimeout(r, 500));
      expect(requests).toHaveLength(0);
    } finally {
      watch.stop();
    }
  });

  it('degrades to fallback-only when fs.watch is unavailable', async () => {
    const warnings: string[] = [];
    const requests: string[] = [];
    // A path that cannot be watched (ENOENT) exercises the setup failure path.
    const watch = new WatchMode(
      { requestRefresh: (reason) => void requests.push(reason) },
      join(repo, 'does-not-exist'),
      { fallbackMs: 50, onWarn: (msg) => void warnings.push(msg) },
    );
    await watch.start();
    try {
      await new Promise((r) => setTimeout(r, 180));
      expect(warnings.some((w) => w.includes('fallback scan only'))).toBe(true);
      expect(requests.filter((r) => r === 'fallback').length).toBeGreaterThanOrEqual(2);
    } finally {
      watch.stop();
    }
  });
});

// ─── convergence: real coordinator end-to-end ────────────────────────────────

describe('WatchMode + RefreshCoordinator — convergence (exit gate line 375)', () => {
  it('an uncommitted edit becomes queryable in the published bundle within one debounce + one fallback, without dirtying .crib/graph', async () => {
    const soul = soulFor();
    // indexRepo anchors the manifest at the REAL HEAD so the coordinator's committed-delta scan
    // resolves; the extra commit just fixes lastUpdated for the byte-stability snapshot below.
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    const canonicalSnapshot = committedBytes();

    const { bundles, onPublish } = recorder();
    const coordinator = new RefreshCoordinator(soul, repo, { onPublish });
    await coordinator.initialize();
    try {
      // Edit the callee (uncommitted). Keep `greet` on line 1 → stable content-addressed id.
      writeFileSync(
        join(repo, 'src', 'a.ts'),
        "export function greet(): string { return 'hello'; }\n",
      );
      coordinator.requestRefresh('fallback');
      const bundle = await waitForBundle(
        bundles,
        (b) => b.capture.dirtyPaths.includes('src/a.ts'),
        'published bundle containing the edit',
      );
      // Edit re-parsed into the published overlay + closure re-resolved (b→a re-emitted).
      expect(symbolIn(coordinator.currentOverlay, 'src/a.ts', 'greet')).toBe(true);
      expect(callsBtoA(coordinator.currentOverlay)).toBe(true);
      expect(bundle.refresh?.dirty).toContain('src/a.ts');
      // Exit gate: committed .crib/graph is byte-identical — the overlay is ephemeral.
      expect(committedBytes()).toBe(canonicalSnapshot);
    } finally {
      coordinator.close();
    }
  });

  it('an untracked source file is picked up by the fallback VCS scan', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');

    const { bundles, onPublish } = recorder();
    const coordinator = new RefreshCoordinator(soul, repo, { onPublish });
    await coordinator.initialize();
    try {
      writeFileSync(join(repo, 'src', 'c.ts'), 'export function extra(): number { return 1; }\n');
      coordinator.requestRefresh('fallback');
      await waitForBundle(
        bundles,
        (b) => b.capture.dirtyPaths.includes('src/c.ts'),
        'untracked file pickup',
      );
      expect(symbolIn(coordinator.currentOverlay, 'src/c.ts', 'extra')).toBe(true);
    } finally {
      coordinator.close();
    }
  });

  it('restart reproduces the same snapshot — pinned by the capture-hash generation (determinism)', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    // Leave a.ts edited (uncommitted) on disk for both sessions.
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      "export function greet(): string { return 'hello'; }\n",
    );

    async function session(): Promise<{ dirtyPaths: string[]; generation: string }> {
      const coordinator = new RefreshCoordinator(soul, repo, {});
      await coordinator.initialize();
      try {
        return {
          dirtyPaths: [...coordinator.currentDirtyPaths],
          generation: coordinator.freshness().readerGeneration ?? '',
        };
      } finally {
        coordinator.close();
      }
    }
    const first = await session();
    const second = await session();
    // The PRD's restart-convergence property, now by construction: a bundle is a pure function of
    // (on-disk canonical graph, VCS state), so two sessions hash to the SAME generation.
    expect(second.dirtyPaths).toEqual(first.dirtyPaths);
    expect(second.generation).toBe(first.generation);
    expect(second.dirtyPaths).toContain('src/a.ts');
  });

  it('a build-output file never enters a published bundle, and triggers no refresh of its own', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'out.ts'), 'export function built(): void {}\n');

    const { bundles, onPublish } = recorder();
    const coordinator = new RefreshCoordinator(soul, repo, { onPublish });
    await coordinator.initialize();
    try {
      // `dist/out.ts` is untracked but NOT watchable: the capture guard sees an unchanged source
      // and the fallback tick is a no-op — no new bundle is published for build churn.
      const before = bundles.length;
      coordinator.requestRefresh('fallback');
      await coordinator.whenIdle();
      await new Promise((r) => setTimeout(r, 100));
      expect(bundles.length).toBe(before);
      for (const b of bundles) expect(b.capture.dirtyPaths).not.toContain('dist/out.ts');
      expect(coordinator.currentDirtyPaths).not.toContain('dist/out.ts');
    } finally {
      coordinator.close();
    }
  });
});

describe('WatchMode + RefreshCoordinator — canonical drift + transitions', () => {
  it('an external `crib update` over a CLEAN tree still publishes a new bundle (readers rebuild)', async () => {
    // R04 (docs/audits/2026-09-05/post-merge-reaudit.md): a canonical advance over a clean working
    // tree must still reach consumers. The old code returned early on an empty dirty set; the
    // coordinator's capture includes the canonical fingerprint, so drift alone moves the hash.
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    const soul = soulFor();
    // indexRepo anchors the manifest at the real HEAD — a reachable anchor keeps this scenario on
    // the clean-delta path (the fake-sha form would degrade to the anchor-unavailable rebuild).
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');

    const { bundles, onPublish } = recorder();
    const coordinator = new RefreshCoordinator(soul, repo, { onPublish });
    await coordinator.initialize();
    try {
      expect(coordinator.currentDirtyPaths).toHaveLength(0); // the precondition the R04 bug fed on
      expect(coordinator.freshness().refreshState).toBe('idle');
      // Another process runs `crib update`: canonical advances at the SAME reachable head, the
      // working tree stays clean — only the on-disk graph fingerprint moves.
      await indexRepo(soul, repo);
      soul.commit('2026-02-02T00:00:00Z');
      // The live capture disagrees with the served bundle BEFORE any refresh…
      expect(coordinator.freshness().staleReasons).toContain('canonical-graph-advanced');
      coordinator.requestRefresh('fallback');
      await waitForBundle(
        bundles,
        (b) => b.capture.dirtyPaths.length === 0 && b !== bundles[0],
        'drift-only publication over a clean tree',
      );
      // …and agrees again after: the new bundle was seeded from the ADVANCED canonical graph.
      expect(coordinator.freshness().stale).toBe(false);
      expect(coordinator.freshness().refreshState).toBe('idle');
      expect(coordinator.freshness().staleReasons).not.toContain('canonical-graph-advanced');
    } finally {
      coordinator.close();
    }
  });

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
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      git(repo, ['checkout', '-q', 'alternate']);
      // HEAD moved: the capture guard sees a source change and the committed delta (base..HEAD)
      // names src/a.ts — the uniform recompute subsumes the old transition state machine.
      coordinator.requestRefresh('fallback');
      const deadline = Date.now() + 8000;
      while (
        !(
          symbolIn(coordinator.currentOverlay, 'src/a.ts', 'alternateOnly') &&
          !symbolIn(coordinator.currentOverlay, 'src/a.ts', 'greet')
        ) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
        coordinator.requestRefresh('fallback');
      }
      expect(symbolIn(coordinator.currentOverlay, 'src/a.ts', 'alternateOnly')).toBe(true);
      expect(symbolIn(coordinator.currentOverlay, 'src/a.ts', 'greet')).toBe(false);
    } finally {
      coordinator.close();
    }
  });
});

describe('VCS scan is the source of truth', () => {
  it('untrackedFiles respects .gitignore (gitignored untracked files are excluded)', () => {
    writeFileSync(join(repo, '.gitignore'), 'src/ignored.ts\n');
    writeFileSync(join(repo, 'src', 'ignored.ts'), 'export function ghost(): void {}\n');
    writeFileSync(join(repo, 'src', 'seen.ts'), 'export function visible(): void {}\n');
    const untracked = untrackedFiles(repo);
    expect(untracked).toContain('src/seen.ts');
    expect(untracked).not.toContain('src/ignored.ts');
  });
});
