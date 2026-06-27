import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SoulStore,
  SqliteIndexStore,
  newManifest,
  readDossier,
  shardOf,
} from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from './pipeline.js';
import { updateRepo } from './update.js';
import type { UpdateReport } from './update.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-update-'));
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

/** Snapshot every `.crib` shard jsonl file + the manifest as a {relpath: content} map. */
function snapshotSoul(): Map<string, string> {
  const snap = new Map<string, string>();
  for (const sub of ['nodes', 'edges']) {
    const base = join(repo, '.crib', sub);
    for (const p of walkJsonl(base)) snap.set(`${sub}/${rel(base, p)}`, readFileSync(p, 'utf8'));
  }
  snap.set('crib.json', readFileSync(join(repo, '.crib', 'crib.json'), 'utf8'));
  return snap;
}
function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonl(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
function rel(base: string, full: string): string {
  return full.slice(base.length + 1).replace(/\\/g, '/');
}

async function indexAndCommit(): Promise<void> {
  // Commit FIRST so `indexRepo` can stamp the VCS anchor (mirrors real `crib index` after a commit).
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'initial']);
  await indexRepo(soulFor(), repo, { now: '2026-01-01T00:00:00.000Z' });
}

describe('updateRepo (M6 incremental, git-anchored)', () => {
  it('returns null for a non-git repo (degrade to full index)', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'crib-nogit-'));
    try {
      mkdirSync(join(plain, 'src'), { recursive: true });
      writeFileSync(join(plain, 'src', 'a.ts'), 'export const x = 1;\n');
      const s = new SoulStore(join(plain, '.crib'), {
        manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
      });
      s.load();
      await indexRepo(s, plain, { now: '2026-01-01T00:00:00.000Z' });
      const result = await updateRepo(s, plain, {});
      expect(result).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('incrementally re-extracts an edited file; reverse-dep edge survives, only that shard diffs', async () => {
    await indexAndCommit();
    const h1 = git(repo, ['rev-parse', 'HEAD']);

    // Capture the b→A calls edge id + the post-index shard snapshot (the honest gate baseline).
    const afterIndex = soulFor();
    const callsEdge = [...afterIndex.iterateEdges('calls')].find((e) => e.dst.includes('greet'))!;
    expect(callsEdge).toBeTruthy();
    const s0 = snapshotSoul();

    // Body-only edit to a.ts (same line count → ids stable, hash differs). Commit advances HEAD.
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      "export function greet(): string { return 'hello'; }\n",
    );
    git(repo, ['add', 'src/a.ts']);
    git(repo, ['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'edit']);
    const h2 = git(repo, ['rev-parse', 'HEAD']);

    // Also build a derived index from the initial soul, to prove the delta keeps the index consistent.
    const soul0 = soulFor();
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul0, repo);
    const bMain = [...soul0.iterate('symbol')].find((n) => n.qualifiedName === 'main')!;
    const aGreet = [...soul0.iterate('symbol')].find((n) => n.qualifiedName === 'greet')!;
    expect(index.impact(bMain.id, 'down').nodes).toContain(aGreet.id);

    // Run the incremental update on a freshly-loaded soul (simulating a later session).
    const soul = soulFor();
    const result = await updateRepo(soul, repo, { now: '2026-01-02T00:00:00.000Z' });
    expect(result).not.toBeNull();
    expect(result && 'noop' in result).toBe(false);

    const report = result as UpdateReport;
    expect(report.changedPaths).toEqual(['src/a.ts']);
    expect(report.scopeFiles).toContain('src/a.ts');
    expect(report.scopeFiles).toContain('src/b.ts'); // reverse-dependency closure
    expect(report.delta.removed).toEqual([]); // P0-1: no silent edge loss

    // The reverse-dep B→A edge is still present in the soul (was pruned then re-emitted).
    const reopened = soulFor();
    expect(reopened.getEdge(callsEdge.id)).toBeDefined();

    // Applying the delta to the derived index preserves impact (edge survived in the index too).
    index.applyDelta(report.delta, repo);
    expect(index.impact(bMain.id, 'down').nodes).toContain(aGreet.id);
    index.close();

    // HONEST GATE: only the edited file's node shard chunks differ; everything else is byte-identical.
    const digits = reopened.getManifest().chunking.shardHexDigits;
    const aShard = shardOf('src/a.ts', digits);
    const bShard = shardOf('src/b.ts', digits);
    expect(aShard).not.toBe(bShard);
    const s1 = snapshotSoul();
    const changed: string[] = [];
    for (const key of new Set([...s0.keys(), ...s1.keys()])) {
      if (s0.get(key) !== s1.get(key)) changed.push(key);
    }
    const expectedChangedShard = `nodes/${aShard}/0000.jsonl`;
    expect(changed).toContain(expectedChangedShard);
    expect(changed).not.toContain(`nodes/${bShard}/0000.jsonl`);
    // Every non-manifest change is exactly the a.ts node shard.
    expect(changed.filter((k) => k !== 'crib.json')).toEqual([expectedChangedShard]);

    // The manifest anchor advanced to the new HEAD.
    expect(reopened.getManifest().stats.incrementalSince).toBe(h2);
    expect(reopened.getManifest().repo.vcsHead).toBe(h2);
    expect(h1).not.toBe(h2);
  });

  it('refreshes graph-dependent dossiers after an incremental edge deletion', async () => {
    await indexAndCommit();
    const indexed = soulFor();
    const greet = [...indexed.iterate('symbol')].find((node) => node.qualifiedName === 'greet')!;
    expect(
      readDossier(join(repo, '.crib'), greet.id, {
        nodeHash: greet.hash,
        schemaVersion: indexed.getManifest().schemaVersion,
      }).dossier?.callers.map((caller) => caller.qualifiedName),
    ).toContain('main');

    writeFileSync(join(repo, 'src', 'b.ts'), "export function main(): string { return 'done'; }\n");
    git(repo, ['add', 'src/b.ts']);
    git(repo, [
      '-c',
      'user.email=t@t.test',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'remove-call',
    ]);

    const updated = soulFor();
    const result = (await updateRepo(updated, repo, {
      now: '2026-01-02T00:00:00.000Z',
    })) as UpdateReport;
    expect(result.dossiers.written).toBeGreaterThan(0);
    expect(
      readDossier(join(repo, '.crib'), greet.id, {
        nodeHash: greet.hash,
        schemaVersion: updated.getManifest().schemaVersion,
      }).dossier?.callers,
    ).toEqual([]);
  });

  it('regression (cc-update-java-extractor): a `crib update` on an edited .java controller re-emits ' +
    'its Spring route + exposes edges — NOT silently dropped by a TS-only default fleet', async () => {
    // A Spring controller fixture. Before the P0 fix, update.ts defaulted its extractor fleet to
    // TypeScript + Markdown ONLY, so re-extracting an edited .java file produced zero Java symbols,
    // zero routes, zero exposes — the whole Spring surface vanished into delta.removed. This test
    // pins the shared `defaultExtractors()` fleet (Java + C# + Go + Rust + Python + PL/SQL + TS + MD)
    // so an incremental update re-extracts the changed file's language.
    mkdirSync(join(repo, 'src', 'main'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'main', 'LoansController.java'),
      [
        '@RestController',
        '@RequestMapping("/api")',
        'class LoansController {',
        '  @GetMapping("/loans") String list() { return ""; }',
        '}',
        '',
      ].join('\n'),
    );
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'spring']);
    await indexRepo(soulFor(), repo, { now: '2026-01-01T00:00:00.000Z' });

    // The initial index carries the Spring route + the exposes edge (handler → route).
    const afterIndex = soulFor();
    const routeBefore = [...afterIndex.iterate('route')];
    expect(routeBefore.map((n) => `${n.httpMethod} ${n.routePath}`).sort()).toEqual([
      'GET /api/loans',
    ]);
    expect([...afterIndex.iterateEdges('exposes')].length).toBe(1);

    // Body-only edit: append a second handler. Same line count for the existing handler keeps its
    // ids stable; the new handler adds one route + one exposes. Commit advances HEAD.
    writeFileSync(
      join(repo, 'src', 'main', 'LoansController.java'),
      [
        '@RestController',
        '@RequestMapping("/api")',
        'class LoansController {',
        '  @GetMapping("/loans") String list() { return ""; }',
        '  @PostMapping("/loans") String create() { return ""; }',
        '}',
        '',
      ].join('\n'),
    );
    git(repo, ['add', 'src/main/LoansController.java']);
    git(repo, [
      '-c',
      'user.email=t@t.test',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'add-route',
    ]);

    const soul = soulFor();
    const result = await updateRepo(soul, repo, { now: '2026-01-02T00:00:00.000Z' });
    expect(result).not.toBeNull();
    expect(result && 'noop' in result).toBe(false);
    const report = result as UpdateReport;

    // The P0 gate: no Spring artifact is silently dropped — the original route + exposes survive the
    // re-extract (they are re-emitted, not lost to delta.removed).
    expect(report.delta.removed).toEqual([]);
    const reopened = soulFor();
    expect(
      [...reopened.iterate('route')].map((n) => `${n.httpMethod} ${n.routePath}`).sort(),
    ).toEqual(['GET /api/loans', 'POST /api/loans']);
    expect([...reopened.iterateEdges('exposes')].length).toBe(2);
  });

  it('reports a noop and advances the anchor when nothing changed', async () => {
    await indexAndCommit();
    // An empty commit advances HEAD without touching any indexed file → true noop.
    git(repo, [
      '-c',
      'user.email=t@t.test',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'noop',
    ]);
    const h2 = git(repo, ['rev-parse', 'HEAD']);

    const soul = soulFor();
    const result = await updateRepo(soul, repo, { now: '2026-01-03T00:00:00.000Z' });
    expect(result && 'noop' in result).toBe(true);
    if (result && 'noop' in result) {
      expect(result.scopeFiles).toEqual([]);
    }
    expect(soulFor().getManifest().stats.incrementalSince).toBe(h2);
  });
});
