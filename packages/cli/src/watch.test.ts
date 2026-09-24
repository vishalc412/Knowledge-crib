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
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest, pathFromId } from '@knowledge-crib/core';
import { indexRepo, untrackedFiles } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ReaderBundle, RefreshCoordinator } from './refresh-coordinator.js';
import { WatchMode, type WatchOpts } from './watch.js';

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
  /**
   * The debounce is a FIXED WINDOW: the first event opens it, later events are absorbed, it fires
   * once on expiry.
   *
   * This drives a SYNTHETIC watcher through the injectable `watchFactory` rather than writing real
   * files and waiting for the OS. The earlier version did the latter and was flaky under load — not
   * because the debounce is wrong, but because the nondeterminism lives in event DELIVERY: macOS
   * FSEvents coalesces on its own latency, and on a loaded machine a five-write burst arrives in
   * several batches spread past any fixed window. It had already been hardened once (a quiescence
   * loop with an 8s deadline, per the comment this replaces) and still failed while a 24-minute
   * embedding build saturated the cores.
   *
   * Widening the window only moves the threshold. Removing the OS from the test removes the whole
   * class: the burst is emitted synchronously, so what is under test — that N events inside one
   * window produce exactly ONE refresh — is asserted directly. The same `watchFactory` seam the
   * degradation tests below already use.
   */
  it('debounces a burst of watcher events into ONE requestRefresh(watcher)', async () => {
    const requests: string[] = [];
    const emitter = new EventEmitter() as EventEmitter & { close(): void };
    emitter.close = () => {};
    // `watch()` takes its change callback as the THIRD argument, so the factory captures it and the
    // test invokes it directly. That is the seam: no filesystem, no OS event delivery, no waiting.
    let fire: ((event: string, filename: string) => void) | undefined;
    const DEBOUNCE_MS = 40;
    const watch = new WatchMode({ requestRefresh: (reason) => void requests.push(reason) }, repo, {
      debounceMs: DEBOUNCE_MS,
      fallbackMs: 60_000,
      watchFactory: ((
        _dir: string,
        _opts: unknown,
        cb: (event: string, filename: string) => void,
      ) => {
        fire = cb;
        return emitter;
      }) as unknown as WatchOpts['watchFactory'],
    });
    await watch.start();
    try {
      expect(fire, 'watchFactory was not given a change callback').toBeDefined();
      // Five events inside one window, delivered with no OS and no scheduling gap between them.
      for (let i = 0; i < 5; i++) fire?.('change', `src/x${i}.ts`);
      expect(requests.filter((r) => r === 'watcher')).toHaveLength(0); // still inside the window

      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));
      expect(requests.filter((r) => r === 'watcher')).toHaveLength(1);

      // A later burst opens a NEW window and fires once more — the window is per-burst, not global.
      for (let i = 0; i < 3; i++) fire?.('change', `src/y${i}.ts`);
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 60));
      expect(requests.filter((r) => r === 'watcher')).toHaveLength(2);

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

  // How an unwatchable directory is REPORTED is not a stable fact: some platform/Node combinations
  // throw synchronously from `watch()`, others create the watcher and emit an asynchronous 'error'
  // (observed on Linux + Node 24, where relying on the throw made this test fail). Both routes must
  // degrade identically, so both are driven explicitly rather than hoping the OS picks one.
  it.each([
    [
      'a synchronous throw',
      (() => {
        const factory = (() => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
        }) as unknown as WatchOpts['watchFactory'];
        return factory;
      })(),
    ],
    [
      'an asynchronous error event',
      (() => {
        const factory = (() => {
          const emitter = new EventEmitter() as EventEmitter & { close(): void };
          emitter.close = () => {};
          setTimeout(() => emitter.emit('error', new Error('inotify limit reached')), 5);
          return emitter;
        }) as unknown as WatchOpts['watchFactory'];
        return factory;
      })(),
    ],
  ])('degrades to fallback-only when the watcher fails with %s', async (_label, watchFactory) => {
    const warnings: string[] = [];
    const requests: string[] = [];
    const watch = new WatchMode({ requestRefresh: (reason) => void requests.push(reason) }, repo, {
      fallbackMs: 50,
      onWarn: (msg) => void warnings.push(msg),
      watchFactory,
    });
    await watch.start();
    try {
      await new Promise((r) => setTimeout(r, 180));
      // Warned once — a persistent watcher error must not flood the log.
      expect(warnings.filter((w) => w.includes('fallback scan only'))).toHaveLength(1);
      // And the convergence backstop keeps running, which is the property that matters.
      expect(requests.filter((r) => r === 'fallback').length).toBeGreaterThanOrEqual(2);
    } finally {
      watch.stop();
    }
  });

  it('keeps converging on a directory that cannot be watched, however the platform reports it', async () => {
    const requests: string[] = [];
    // The real ENOENT path: whether it throws, errors asynchronously, or silently does nothing is
    // the platform's business. What must hold everywhere is that the fallback still converges and
    // nothing escapes as an unhandled error.
    const watch = new WatchMode(
      { requestRefresh: (reason) => void requests.push(reason) },
      join(repo, 'does-not-exist'),
      { fallbackMs: 50 },
    );
    await watch.start();
    try {
      await new Promise((r) => setTimeout(r, 180));
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

  it('a pinned request keeps health honest: unadopted publication reads stale, and the reader converges after release (A05)', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');

    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    // The REAL trigger layer drives this one: a save on disk, no hand-called refresh.
    const watch = new WatchMode(coordinator, repo, { fallbackMs: 100 });
    await watch.start();
    /** Poll a condition — a publication that is not adopted fires no onPublish callback. */
    async function until(label: string, ok: () => boolean): Promise<void> {
      for (let i = 0; i < 100; i++) {
        if (ok()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    }
    try {
      expect(coordinator.freshness().stale).toBe(false);
      const generationA = coordinator.freshness().readerGeneration;
      coordinator.retain(); // an MCP request is in flight; adoption must wait for it
      writeFileSync(join(repo, 'src', 'pinned.ts'), 'export function pinned(): void {}\n');
      await until(
        'publication while a request is pinned',
        () => coordinator.freshness().publishedGeneration !== generationA,
      );

      // The reader still answers from the OLD bundle, so health must say so — and keep saying so
      // even once the tree is restored to exactly what that old bundle was built from.
      const pinnedHealth = coordinator.freshness();
      expect(symbolIn(coordinator.currentOverlay, 'src/pinned.ts', 'pinned')).toBe(false);
      expect(pinnedHealth.stale).toBe(true);
      rmSync(join(repo, 'src', 'pinned.ts'));
      const revertedHealth = coordinator.freshness();
      expect(revertedHealth.publishedGeneration).not.toBe(revertedHealth.readerGeneration);
      expect(revertedHealth.stale).toBe(true);
      expect(revertedHealth.staleReasons).toContain('published-generation-not-adopted');

      coordinator.release();
      await until('reader to converge after release', () => {
        const f = coordinator.freshness();
        return f.publishedGeneration === f.readerGeneration && !f.stale;
      });
      // And the served graph agrees with the health verdict: the reverted file is gone from it.
      // (This fixture has no VCS, so `source-detection-unavailable` is a permanent, honest
      // annotation here — it is reported without claiming the reader is behind.)
      expect(coordinator.freshness().staleReasons).not.toContain(
        'published-generation-not-adopted',
      );
      expect(symbolIn(coordinator.currentOverlay, 'src/pinned.ts', 'pinned')).toBe(false);
    } finally {
      watch.stop();
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
    // A canonical advance over a clean working
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
