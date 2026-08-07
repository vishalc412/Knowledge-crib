import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { ExtractorRegistry } from '@knowledge-crib/parsers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExtractors } from './extractors.js';
import { runParseConcurrent } from './parse-concurrent.js';
import { runParse } from './parse.js';
import { discoverFiles, runStructure } from './structure.js';

/**
 * M3.4 — pins the parallel-parse determinism contract: the bounded-concurrency pool produces a
 * byte-identical soul to the serial loop. The load-bearing guarantee is that the soul's in-memory
 * Map insertion order (which the order-sensitive downstream phases iterate) matches the serial
 * discovery order, so a full re-index via the concurrent path must yield the exact same committed
 * chunks as the serial path.
 */
const NOW = '2026-01-01T00:00:00.000Z';

/** A multi-file TS repo — enough files that the concurrency path engages (>1 file) and that the
 *  ordering of putNodes/putEdges across files is actually exercised. */
function buildRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'crib-par-test-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  const files: Record<string, string> = {
    'src/auth.ts':
      'export class AuthService { login(): void { this.issue(); } issue(): void { log(); } }\nexport function log(): void {}\n',
    'src/users.ts':
      'export class User { constructor(readonly id: string) {} greet(): string { return this.id; } }\n',
    'src/orders.ts':
      'import { User } from "./users.js";\nexport function mkOrder(u: User): string { return u.greet(); }\n',
    'src/util.ts':
      'export const add = (a: number, b: number): number => a + b;\nexport const mul = (a: number, b: number): number => a * b;\n',
    'src/readme.md': '# Module\n\nThe AuthService issues tokens.\n',
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  return repo;
}

function registry(): ExtractorRegistry {
  const r = new ExtractorRegistry();
  for (const e of defaultExtractors()) r.register(e);
  return r;
}

function soulAt(repo: string): SoulStore {
  // Fixed repoId so the manifest's `repo.id` (otherwise a random UUID per call) doesn't obscure the
  // parse-determinism comparison — repo.id is a per-repo identity, not parse output.
  const s = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: NOW, repoId: 'fixed-repo-id-for-par-test' }),
  });
  s.load();
  return s;
}

/** Snapshot the committed .crib tree as a deterministic string (sorted paths + file contents). */
function snapshotCrib(repo: string): string {
  const crib = join(repo, '.crib');
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === '.crib' ? `.crib/${name}` : `${rel}/${name}`;
      // skip gitignored DERIVED state (sqlite index + embeddings dirs) — never committed, not what
      // parse produces. Only snapshot the soul shards (nodes/edges/manifest) + cluster topology.
      if (r === '.crib/index' || r === '.crib/embeddings') continue;
      if (statSync(abs).isDirectory()) {
        walk(abs, r);
        continue;
      }
      out.push(r);
      out.push(readFileSync(abs, 'utf8'));
    }
  };
  walk(crib, '.crib');
  return out.join('\n');
}

let repo: string;
beforeEach(() => {
  repo = buildRepo();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('M3.4 parallel parse — determinism', () => {
  it('runParseConcurrent produces identical counts to the serial loop', async () => {
    const files = discoverFiles(repo, {});
    runStructure(soulAt(repo), repo, files); // file nodes (shared precondition)
    // serial
    const serialSoul = soulAt(repo);
    runStructure(serialSoul, repo, files);
    const serial = await runParse(serialSoul, registry(), repo, files, { parallel: false });
    // concurrent (separate soul so the two don't share Map state)
    const concRepo = mkdtempSync(join(tmpdir(), 'crib-par-test-c-'));
    cpSync(join(repo, 'src'), join(concRepo, 'src'), { recursive: true });
    const concFiles = discoverFiles(concRepo, {});
    const concSoul = soulAt(concRepo);
    runStructure(concSoul, concRepo, concFiles);
    const conc = await runParseConcurrent(concSoul, registry(), concRepo, concFiles, 4);
    expect(conc.filesParsed).toBe(serial.filesParsed);
    expect(conc.nodes).toBe(serial.nodes);
    expect(conc.edges).toBe(serial.edges);
    rmSync(concRepo, { recursive: true, force: true });
  });

  it('a full indexRepo via the concurrent path commits a byte-identical soul to the serial path', async () => {
    const { indexRepo } = await import('./pipeline.js');
    // dossiers + ownership OFF: dossiers stamp real-time builtAt (a separate, intentional
    // nondeterminism), ownership needs git. This test isolates parse + the order-sensitive
    // downstream phases (resolve/link/cluster) — the surfaces the parallel path touches.
    const opts = { now: NOW, dossiers: false, ownership: false };
    const serialRepo = mkdtempSync(join(tmpdir(), 'crib-par-ser-'));
    cpSync(join(repo, 'src'), join(serialRepo, 'src'), { recursive: true });
    await indexRepo(soulAt(serialRepo), serialRepo, { ...opts, parallel: false });
    const concRepo = mkdtempSync(join(tmpdir(), 'crib-par-conc-'));
    cpSync(join(repo, 'src'), join(concRepo, 'src'), { recursive: true });
    await indexRepo(soulAt(concRepo), concRepo, opts); // parallel omitted → concurrency engages
    expect(snapshotCrib(concRepo)).toBe(snapshotCrib(serialRepo));
    rmSync(serialRepo, { recursive: true, force: true });
    rmSync(concRepo, { recursive: true, force: true });
  });

  it('parallel:false forces the serial loop (no concurrency) and still matches the concurrent soul', async () => {
    const { indexRepo } = await import('./pipeline.js');
    const opts = { now: NOW, dossiers: false, ownership: false };
    const a = mkdtempSync(join(tmpdir(), 'crib-par-a-'));
    const b = mkdtempSync(join(tmpdir(), 'crib-par-b-'));
    cpSync(join(repo, 'src'), join(a, 'src'), { recursive: true });
    cpSync(join(repo, 'src'), join(b, 'src'), { recursive: true });
    await indexRepo(soulAt(a), a, { ...opts, parallel: false });
    await indexRepo(soulAt(b), b, opts);
    expect(snapshotCrib(a)).toBe(snapshotCrib(b));
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});
