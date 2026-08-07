/**
 * W6 — working-overlay refresh (PRD line 365, exit gate line 375).
 *
 * Exercises {@link refreshWorkingOverlay} against a real indexed repo: a dirty callee (a.ts) is
 * re-parsed into the overlay AND its reverse-dependency closure (b.ts, which calls a) is re-resolved
 * so the incoming `b→a` calls edge is re-emitted — the P0-1 closure-before-remove fix. The committed
 * `.crib/graph` is byte-identical before/after (the overlay is ephemeral; nothing is committed).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest, pathFromId } from '@knowledge-crib/core';
import { WorkingOverlay } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from './pipeline.js';
import { refreshWorkingOverlay } from './working-overlay-refresh.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-overlay-refresh-'));
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

/** Every committed extracted shard jsonl + manifest as a {relpath: content} map (for byte-stability). */
function snapshotCommitted(): Map<string, string> {
  const snap = new Map<string, string>();
  const base = join(repo, '.crib', 'graph', 'extracted');
  for (const p of walkJsonl(join(base, 'nodes')))
    snap.set(`nodes/${rel(join(base, 'nodes'), p)}`, readFileSync(p, 'utf8'));
  for (const p of walkJsonl(join(base, 'edges')))
    snap.set(`edges/${rel(join(base, 'edges'), p)}`, readFileSync(p, 'utf8'));
  snap.set('manifest.json', readFileSync(join(repo, '.crib', 'graph', 'manifest.json'), 'utf8'));
  return snap;
}
function walkJsonl(dir: string): string[] {
  let out: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkJsonl(full));
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  } catch {
    out = [];
  }
  return out;
}
function rel(base: string, full: string): string {
  return full.slice(base.length + 1).replace(/\\/g, '/');
}

/** A `calls` edge in the overlay whose src lives in b.ts and dst in a.ts (the closure-re-emitted edge). */
function callsBtoA(overlay: WorkingOverlay): boolean {
  for (const e of overlay.store.iterateEdges('calls')) {
    if (pathFromId(e.src) === 'src/b.ts' && pathFromId(e.dst) === 'src/a.ts') return true;
  }
  return false;
}
function symbolIn(overlay: WorkingOverlay, path: string, name: string): boolean {
  for (const n of overlay.store.iterate('symbol')) {
    if (n.file === path && n.name === name) return true;
  }
  return false;
}

describe('refreshWorkingOverlay', () => {
  it('re-parses a dirty file into the overlay and re-resolves the reverse-dep closure (b→a re-emitted)', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.setVcsHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    soul.commit('2026-01-01T00:00:00Z');
    const before = snapshotCommitted();
    expect(callsBtoA(new WorkingOverlay(soul))).toBe(true); // canonical has the b→a edge

    // Edit the CALLEE only (a.ts). Keep `greet` on line 1 so its content-addressed id is stable.
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      "export function greet(): string { return 'hello'; }\n",
    );

    const overlay = new WorkingOverlay(soul);
    overlay.markDirty('src/a.ts');
    const result = await refreshWorkingOverlay(overlay, soul, repo);

    expect(result.dirty).toEqual(['src/a.ts']);
    // b.ts is in the closure because canonical's b→a edge reaches into the dirty a.ts.
    expect(result.scope).toContain('src/a.ts');
    expect(result.scope).toContain('src/b.ts');
    // a.ts re-parsed: greet is back in the overlay from the edited source.
    expect(symbolIn(overlay, 'src/a.ts', 'greet')).toBe(true);
    // The incoming b→a calls edge is re-emitted by closure re-resolution, even though b.ts was
    // never edited — the P0-1 fix. A resolve over ONLY {a.ts} would have dropped this edge.
    expect(callsBtoA(overlay)).toBe(true);

    // Exit gate (line 375): edits queryable WITHOUT dirtying committed .crib/graph.
    const after = snapshotCommitted();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const k of before.keys()) expect(after.get(k)).toBe(before.get(k));
  });

  it('is a no-op when the overlay is sealed (no dirty files)', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    const overlay = new WorkingOverlay(soul);
    const result = await refreshWorkingOverlay(overlay, soul, repo);
    expect(result.dirty).toEqual([]);
    expect(result.scope).toEqual([]);
    expect(result.parse.filesParsed).toBe(0);
  });

  it('cluster: false skips re-clustering', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      "export function greet(): string { return 'hello'; }\n",
    );
    const overlay = new WorkingOverlay(soul);
    overlay.markDirty('src/a.ts');
    const result = await refreshWorkingOverlay(overlay, soul, repo, { cluster: false });
    expect(result.cluster.communities).toBe(0);
    expect(result.cluster.members).toBe(0);
  });

  it('a deleted dirty file drops out of the overlay (no meta on disk)', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo);
    soul.commit('2026-01-01T00:00:00Z');
    const overlay = new WorkingOverlay(soul);
    expect(symbolIn(overlay, 'src/a.ts', 'greet')).toBe(true);

    rmSync(join(repo, 'src', 'a.ts'));
    overlay.markDirty('src/a.ts');
    await refreshWorkingOverlay(overlay, soul, repo);
    expect(symbolIn(overlay, 'src/a.ts', 'greet')).toBe(false);
  });
});
