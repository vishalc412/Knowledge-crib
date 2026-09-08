/**
 * WP4 — the refresh coordinator's serialized loop and reader-bundle contract.
 *
 * Pins the register's WP4 scenarios at the unit level (watch.test.ts covers the end-to-end
 * convergence the same coordinator drives):
 *   WP4.1 concurrent triggers coalesce to ONE cycle — the busy slot latches a single pending
 *        reason, and the replay passes the capture guard so an UNCHANGED source ends the chain
 *        with zero wasted cycles;
 *   WP4.4 a save landing MID-BUILD discards the invisible candidate and reschedules — the bundle
 *        is never published-then-patched, and exactly one publication survives;
 *   WP4.5 an in-flight request (retain/release pin) survives a publication swap — the reader
 *        keeps the OLD bundle until it drains, then adopts; generations diverge then converge;
 *   WP4.6 a failing cycle (throwing extractor) preserves the last-good bundle, records the error
 *        for readerFreshness, and CLEARS it only when a later cycle succeeds;
 *   WP4.7 staleReasons accuracy: head-moved / working-tree-changed / canonical-advanced set
 *        `stale`; committed-index-behind-head is reported WITHOUT setting stale (the overlay
 *        compensates); an unreachable index anchor degrades to a full rebuild, stale, and recovers
 *        once the index is re-anchored.
 * Plus the cold (non-serving) ReaderFreshness shape used by `crib status`, viz and manual serve.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { STALE_REASONS } from '@knowledge-crib/mcp';
import { defaultExtractors, indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ReaderBundle,
  RefreshCoordinator,
  coldReaderFreshness,
} from './refresh-coordinator.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-coord-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function greet(): string { return "hi"; }\n');
  git(repo, ['init', '-q']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commitAll(root: string, msg: string): void {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', msg]);
}
function soulFor(): SoulStore {
  const s = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  s.load();
  return s;
}
/** Index the fixture at its REAL HEAD so `changedFilesSince` anchors resolve in later scenarios. */
async function indexedSoul(): Promise<SoulStore> {
  commitAll(repo, 'base');
  const soul = soulFor();
  await indexRepo(soul, repo);
  soul.setVcsHead(git(repo, ['rev-parse', 'HEAD']));
  soul.commit('2026-01-01T00:00:00Z');
  return soul;
}
function symbolIn(coordinator: RefreshCoordinator, path: string, name: string): boolean {
  for (const n of coordinator.currentOverlay?.iterate('symbol') ?? []) {
    if (n.file === path && n.name === name) return true;
  }
  return false;
}
/** An extractor fleet whose .ts member throws while `path` is poisoned (WP4.6 failure injection).
 * Delegates instead of spreading — extractors are class instances; a spread loses prototype methods. */
function poisonableExtractors(): ReturnType<typeof defaultExtractors> {
  return defaultExtractors().map((e): ReturnType<typeof defaultExtractors>[number] => ({
    name: e.name,
    capabilities: e.capabilities,
    supports: (file) => e.supports(file),
    extract: async (file, ctx) => {
      if (file.path === 'src/poison.ts') throw new Error('poisoned parse');
      return e.extract(file, ctx);
    },
  }));
}

// ─── WP4.1: serialization + coalescing ────────────────────────────────────────

describe('WP4.1 — one serialized slot, concurrent triggers coalesce', () => {
  it('two triggers arriving mid-cycle coalesce into ONE replay, and an unchanged source ends the chain (zero wasted cycles)', async () => {
    const soul = await indexedSoul();
    const publishes: Array<{ gen: string; reason: string }> = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const coordinator = new RefreshCoordinator(soul, repo, {
      onPublish: (b, reason) => void publishes.push({ gen: b.generation, reason }),
      // Park the first cycle's build so the triggers below arrive while the slot is held.
      onCandidateBuilt: () => gate,
    });
    try {
      const init = coordinator.initialize();
      // Synchronously after initialize(): busy is held, the cycle is parked mid-build.
      expect(coordinator.freshness().refreshState).toBe('refreshing');
      coordinator.requestRefresh('watcher');
      coordinator.requestRefresh('fallback');
      openGate();
      await init;
      // The initial published; the latched pair replayed through the capture guard, found the
      // source unchanged, and ended the chain — no second cycle, no second publication.
      expect(publishes).toHaveLength(1);
      const [initial] = publishes;
      expect(initial?.reason).toBe('initial');
      expect(coordinator.freshness().refreshState).toBe('idle');
      // Let the event loop settle: the replay chain stays ended.
      await new Promise((r) => setTimeout(r, 50));
      expect(publishes).toHaveLength(1);
    } finally {
      coordinator.close();
    }
  });
});

// ─── WP4.4: re-check before publication ────────────────────────────────────────

describe('WP4.4 — a save mid-build discards the candidate and reschedules', () => {
  it('the stale candidate never publishes; exactly one bundle survives and it includes the save', async () => {
    const soul = await indexedSoul();
    const publishes: ReaderBundle[] = [];
    const warnings: string[] = [];
    let saved = false;
    const coordinator = new RefreshCoordinator(soul, repo, {
      onPublish: (b) => void publishes.push(b),
      onWarn: (m) => void warnings.push(m),
      onCandidateBuilt: () => {
        // The save lands BETWEEN candidate build and the source re-check (WP4.4's exact window).
        if (!saved) {
          saved = true;
          writeFileSync(join(repo, 'src', 'mid.ts'), 'export function midflight(): void {}\n');
        }
      },
    });
    try {
      await coordinator.initialize();
      await coordinator.whenIdle();
      // The pre-save candidate was discarded (warned, never published); the rescheduled cycle
      // produced exactly one bundle that DOES contain the mid-flight save.
      expect(publishes).toHaveLength(1);
      const [only] = publishes;
      expect(only?.capture.dirtyPaths).toContain('src/mid.ts');
      expect(symbolIn(coordinator, 'src/mid.ts', 'midflight')).toBe(true);
      expect(warnings.some((w) => w.includes('candidate discarded'))).toBe(true);
      expect(coordinator.freshness().refreshState).toBe('idle');
      expect(coordinator.freshness().stale).toBe(false);
    } finally {
      coordinator.close();
    }
  });
});

// ─── WP4.5: publication drains in-flight readers ──────────────────────────────

describe('WP4.5 — an in-flight reader survives the publication swap', () => {
  it('a published bundle waits while a request is pinned, then swaps on release (generations diverge then converge)', async () => {
    const soul = await indexedSoul();
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      const before = coordinator.freshness().readerGeneration;
      // One request in flight (the pin router's retain).
      coordinator.retain();
      writeFileSync(join(repo, 'src', 'new.ts'), 'export function fresh(): void {}\n');
      coordinator.requestRefresh('watcher');
      await coordinator.whenIdle();
      // Publication happened, but the swap is deferred: the READER still serves the old bundle —
      // its FTS handle is alive and its graph does not yet contain the new symbol.
      const mid = coordinator.freshness();
      expect(mid.publishedGeneration).not.toBe(mid.readerGeneration);
      expect(mid.readerGeneration).toBe(before);
      expect(symbolIn(coordinator, 'src/new.ts', 'fresh')).toBe(false);
      // The request drains → the swap lands and the retired bundle is closed.
      coordinator.release();
      const after = coordinator.freshness();
      expect(after.publishedGeneration).toBe(after.readerGeneration);
      expect(after.readerGeneration).not.toBe(before);
      expect(symbolIn(coordinator, 'src/new.ts', 'fresh')).toBe(true);
      expect(after.refreshState).toBe('idle');
    } finally {
      coordinator.close();
    }
  });
});

// ─── WP4.6: last-good preservation on failure ─────────────────────────────────

describe('WP4.6 — a failing cycle preserves the last-good bundle', () => {
  it('a poisoned parse keeps serving the previous bundle, reports refreshState error, and clears it only on success', async () => {
    const soul = await indexedSoul();
    const coordinator = new RefreshCoordinator(soul, repo, { extractors: poisonableExtractors() });
    await coordinator.initialize();
    try {
      const goodGeneration = coordinator.freshness().readerGeneration;
      // A file whose parse throws → the cycle fails; the candidate never publishes.
      writeFileSync(join(repo, 'src', 'poison.ts'), 'export function boom(): void {}\n');
      coordinator.requestRefresh('watcher');
      await coordinator.whenIdle();
      const failed = coordinator.freshness();
      expect(failed.refreshState).toBe('error');
      expect(failed.lastRefreshError?.message).toContain('poisoned parse');
      expect(failed.lastRefreshError?.code).toBe('Error');
      expect(failed.readerGeneration).toBe(goodGeneration); // last-good keeps serving
      expect(failed.stale).toBe(true); // and honestly says the reader is behind the tree
      expect(failed.staleReasons).toContain(STALE_REASONS.WORKING_TREE_CHANGED);
      // Fix the source: the poisoned file is removed and a clean file lands — the next cycle
      // succeeds, publishes, and CLEARS the error.
      rmSync(join(repo, 'src', 'poison.ts'));
      writeFileSync(join(repo, 'src', 'healed.ts'), 'export function healed(): void {}\n');
      coordinator.requestRefresh('watcher');
      await coordinator.whenIdle();
      const healed = coordinator.freshness();
      expect(healed.refreshState).toBe('idle');
      expect(healed.lastRefreshError).toBeNull();
      expect(healed.readerGeneration).not.toBe(goodGeneration);
      expect(symbolIn(coordinator, 'src/healed.ts', 'healed')).toBe(true);
    } finally {
      coordinator.close();
    }
  });
});

// ─── WP4.7: staleReasons accuracy + anchor fallback ────────────────────────────

describe('WP4.7 — readerFreshness verdicts', () => {
  it('clean tree: idle, not stale, no reasons', async () => {
    const soul = await indexedSoul();
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      const f = coordinator.freshness();
      expect(f.refreshState).toBe('idle');
      expect(f.stale).toBe(false);
      expect(f.staleReasons).toEqual([]);
      expect(f.readerGeneration).toBe(f.publishedGeneration);
      expect(f.lastRefreshError).toBeNull();
      expect(f.lastSuccessfulRefreshAt).toBeTruthy();
    } finally {
      coordinator.close();
    }
  });

  it('an unserved edit: stale via working-tree-changed, refreshState stays idle until triggered', async () => {
    const soul = await indexedSoul();
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      writeFileSync(join(repo, 'src', 'edit.ts'), 'export function edited(): void {}\n');
      const f = coordinator.freshness();
      expect(f.stale).toBe(true);
      expect(f.staleReasons).toContain(STALE_REASONS.WORKING_TREE_CHANGED);
      // Honest: no trigger has fired yet, so the LOOP is idle even though the reader is behind.
      expect(f.refreshState).toBe('idle');
      // A trigger closes the gap.
      coordinator.requestRefresh('watcher');
      await coordinator.whenIdle();
      expect(coordinator.freshness().stale).toBe(false);
    } finally {
      coordinator.close();
    }
  });

  it('a commit BEFORE the first bundle is overlay-compensated (committed-behind WITHOUT stale); a commit AFTER publication is genuinely stale (head-moved)', async () => {
    const soul = await indexedSoul();
    const h0 = git(repo, ['rev-parse', 'HEAD']);
    // HEAD advances h0→h1 before any bundle exists: the cycle overlays the committed delta, so the
    // committed index being behind is NOT reader-staleness — the pinned WP4.7 distinction.
    writeFileSync(join(repo, 'src', 'delta.ts'), 'export function delta(): void {}\n');
    commitAll(repo, 'advance');
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      const f = coordinator.freshness();
      expect(f.indexedHead).toBe(h0);
      expect(f.currentHead).not.toBe(h0);
      expect(f.staleReasons).toContain(STALE_REASONS.COMMITTED_BEHIND);
      expect(f.stale).toBe(false); // ← the distinction WP4.7 pins
      expect(symbolIn(coordinator, 'src/delta.ts', 'delta')).toBe(true);
      // Now move HEAD UNDER the serving bundle: genuinely stale (head-moved-since-publication).
      writeFileSync(join(repo, 'src', 'later.ts'), 'export function later(): void {}\n');
      commitAll(repo, 'later');
      const stale = coordinator.freshness();
      expect(stale.stale).toBe(true);
      expect(stale.staleReasons).toContain(STALE_REASONS.HEAD_MOVED);
      expect(stale.staleReasons).toContain(STALE_REASONS.COMMITTED_BEHIND);
    } finally {
      coordinator.close();
    }
  });

  it('external crib update: canonical-advanced is stale (anchor still valid), and clears after the refresh', async () => {
    const soul = await indexedSoul();
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      // Another process re-indexes: the canonical graph advances at a REACHABLE head.
      writeFileSync(join(repo, 'src', 'z.ts'), 'export function zed(): void {}\n');
      commitAll(repo, 'z');
      await indexRepo(soul, repo);
      soul.setVcsHead(git(repo, ['rev-parse', 'HEAD']));
      soul.commit('2026-02-02T00:00:00Z');
      const stale = coordinator.freshness();
      expect(stale.stale).toBe(true);
      expect(stale.staleReasons).toContain(STALE_REASONS.CANONICAL_ADVANCED);
      expect(stale.staleReasons).not.toContain(STALE_REASONS.ANCHOR_UNAVAILABLE);
      coordinator.requestRefresh('fallback');
      await coordinator.whenIdle();
      expect(coordinator.freshness().stale).toBe(false);
    } finally {
      coordinator.close();
    }
  });

  it('an unreachable index anchor degrades to a full tracked+untracked rebuild, and recovers on re-anchor', async () => {
    const soul = await indexedSoul();
    // Point the manifest at a sha that no longer resolves (history rewritten / gc'd away).
    soul.setVcsHead('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    soul.commit('2026-03-03T00:00:00Z');
    const coordinator = new RefreshCoordinator(soul, repo, {});
    await coordinator.initialize();
    try {
      const f = coordinator.freshness();
      expect(f.stale).toBe(true);
      expect(f.staleReasons).toContain(STALE_REASONS.ANCHOR_UNAVAILABLE);
      // The honest repair: the bundle covers the whole current supported tree, not a delta.
      expect(coordinator.currentDirtyPaths).toContain('src/a.ts');
      expect(symbolIn(coordinator, 'src/a.ts', 'greet')).toBe(true);
      // A later `crib update` re-anchors the index → the reason clears.
      soul.setVcsHead(git(repo, ['rev-parse', 'HEAD']));
      soul.commit('2026-04-04T00:00:00Z');
      coordinator.requestRefresh('fallback');
      await coordinator.whenIdle();
      const healed = coordinator.freshness();
      expect(healed.staleReasons).not.toContain(STALE_REASONS.ANCHOR_UNAVAILABLE);
      expect(healed.stale).toBe(false);
    } finally {
      coordinator.close();
    }
  });
});

// ─── cold readerFreshness (crib status / viz / manual serve) ───────────────────

describe('coldReaderFreshness — the non-serving shape', () => {
  it('unindexed root: unindexed, not stale, generations honestly null', () => {
    const f = coldReaderFreshness(repo, join(repo, '.crib'));
    expect(f.refreshState).toBe('unindexed');
    expect(f.stale).toBe(false);
    expect(f.publishedGeneration).toBeNull();
    expect(f.readerGeneration).toBeNull();
    expect(f.lastSuccessfulRefreshAt).toBeNull();
    expect(f.staleReasons).toContain(STALE_REASONS.SOURCE_UNKNOWN); // no commits → head unknown
  });

  it('indexed then a new commit: behind-HEAD is GENUINE staleness for a cold reader (no overlay compensates)', async () => {
    await indexedSoul();
    const h0 = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'src', 'later.ts'), 'export function later(): void {}\n');
    commitAll(repo, 'later');
    const f = coldReaderFreshness(repo, join(repo, '.crib'));
    expect(f.refreshState).toBe('idle');
    expect(f.indexedHead).toBe(h0);
    expect(f.currentHead).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(f.stale).toBe(true);
    expect(f.staleReasons).toContain(STALE_REASONS.COMMITTED_BEHIND);
    expect(f.lastSuccessfulRefreshAt).toBeTruthy();
  });

  it('re-anchored to the live head: not stale', async () => {
    const soul = await indexedSoul();
    writeFileSync(join(repo, 'src', 'later.ts'), 'export function later(): void {}\n');
    commitAll(repo, 'later');
    soul.setVcsHead(git(repo, ['rev-parse', 'HEAD']));
    soul.commit('2026-05-05T00:00:00Z');
    const f = coldReaderFreshness(repo, join(repo, '.crib'));
    expect(f.stale).toBe(false);
    expect(f.staleReasons).toEqual([]);
  });
});
