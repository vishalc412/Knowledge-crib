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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { ExtractorRegistry } from '@knowledge-crib/parsers';
import type { ExtractDiagnostic, Extractor } from '@knowledge-crib/parsers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExtractors } from './extractors.js';
import { runParseConcurrent } from './parse-concurrent.js';
import { runParse } from './parse.js';
import { defaultResolvers } from './resolve/index.js';
import { MuleResolver } from './resolve/mule-resolver.js';
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

// Foundation Task 7 — diagnostics aggregation. A custom extractor emits one warning per file; serial
// and concurrent must surface the SAME diagnostics in DISCOVERY order, and the bounded retain + full
// counts (byCode/bySeverity/byExtractor) must be deterministic across execution modes.
describe('Task 7 — ordered diagnostics aggregation', () => {
  /** A custom extractor that emits exactly one warning diagnostic per `.x` file, keyed by discovery
   *  order: `a.x` → test:first, `b.x` → test:second. Emits no nodes (filesParsed still increments). */
  function diagExtractor(): Extractor {
    return {
      name: 'test:diag',
      supports: (file) => file.path.endsWith('.x'),
      async extract(file) {
        const diag: ExtractDiagnostic =
          file.path === 'a.x'
            ? { code: 'test:first', severity: 'warning', message: 'a', file: 'a.x' }
            : { code: 'test:second', severity: 'warning', message: 'b', file: 'b.x' };
        return { nodes: [], edges: [], diagnostics: [diag] };
      },
    };
  }

  function diagRegistry(): ExtractorRegistry {
    const reg = new ExtractorRegistry();
    reg.register(diagExtractor());
    return reg;
  }

  /** Two `.x` files in discovery order (a.x < b.x after the path sort). */
  function diagRepo(): string {
    const r = mkdtempSync(join(tmpdir(), 'crib-diag-'));
    writeFileSync(join(r, 'a.x'), 'x');
    writeFileSync(join(r, 'b.x'), 'y');
    return r;
  }

  /** Parse stats on a fresh repo, in the given execution mode. */
  async function parseIn(mode: 'serial' | 'concurrent', limit?: number) {
    const r = diagRepo();
    const files = discoverFiles(r, {});
    runStructure(soulAt(r), r, files);
    const opts: { parallel: boolean; diagnosticLimit?: number } = {
      parallel: mode !== 'serial',
    };
    if (limit !== undefined) opts.diagnosticLimit = limit;
    const stats = await runParse(soulAt(r), diagRegistry(), r, files, opts);
    rmSync(r, { recursive: true, force: true });
    return stats;
  }

  it('serial and concurrent produce identical diagnostics in discovery order', async () => {
    const serial = await parseIn('serial');
    const concurrent = await parseIn('concurrent');
    expect(serial.diagnostics).toEqual([
      { code: 'test:first', severity: 'warning', message: 'a', file: 'a.x' },
      { code: 'test:second', severity: 'warning', message: 'b', file: 'b.x' },
    ]);
    expect(concurrent.diagnostics).toEqual(serial.diagnostics);
    // existing counts unchanged
    expect(serial.filesParsed).toBe(2);
    expect(concurrent.filesParsed).toBe(2);
    expect(serial.nodes).toBe(0);
    expect(serial.edges).toBe(0);
    // full counts (every diagnostic counted) agree across modes
    expect(concurrent.bySeverity).toEqual(serial.bySeverity);
    expect(concurrent.byCode).toEqual(serial.byCode);
    expect(concurrent.byExtractor).toEqual(serial.byExtractor);
  });

  it('counts every diagnostic by code/severity/extractor', async () => {
    const serial = await parseIn('serial');
    expect(serial.bySeverity).toEqual({ info: 0, warning: 2, error: 0 });
    expect(serial.byCode).toEqual({ 'test:first': 1, 'test:second': 1 });
    expect(serial.byExtractor).toEqual({ 'test:diag': { files: 2, diagnostics: 2 } });
    expect(serial.diagnosticsTruncated).toBe(0);
  });

  it('diagnosticLimit retains the first N in discovery order and reports the remainder truncated', async () => {
    const serial = await parseIn('serial', 1);
    expect(serial.diagnostics).toHaveLength(1);
    expect(serial.diagnostics).toEqual([
      { code: 'test:first', severity: 'warning', message: 'a', file: 'a.x' },
    ]);
    expect(serial.diagnosticsTruncated).toBe(1);
    // counts still reflect EVERY diagnostic (not just retained)
    expect(serial.bySeverity.warning).toBe(2);
    expect(serial.byCode).toEqual({ 'test:first': 1, 'test:second': 1 });
    expect(serial.byExtractor).toEqual({ 'test:diag': { files: 2, diagnostics: 2 } });

    // concurrent applies the limit identically (deterministic across modes)
    const concurrent = await parseIn('concurrent', 1);
    expect(concurrent.diagnostics).toEqual(serial.diagnostics);
    expect(concurrent.diagnosticsTruncated).toBe(1);
    expect(concurrent.bySeverity.warning).toBe(2);
    expect(concurrent.byCode).toEqual(serial.byCode);
  });

  it('diagnosticLimit 0 retains none but still counts all', async () => {
    const serial = await parseIn('serial', 0);
    expect(serial.diagnostics).toHaveLength(0);
    expect(serial.diagnosticsTruncated).toBe(2);
    expect(serial.bySeverity.warning).toBe(2);
    expect(serial.byCode).toEqual({ 'test:first': 1, 'test:second': 1 });
  });
});

/**
 * Task 8 — MuleSoft is registered in the default fleets (exactly one extractor + one resolver), and
 * the parallel parse path produces a byte-identical soul to the serial path for a Mule 4 fixture
 * (the same determinism contract the TS fixture pins). The MuleSoft supports() are disjoint
 * (family === 'mule', set by the discovery classifier), so registering Mule last cannot steal
 * ordinary XML/resource files from any other extractor.
 */
const MULE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mule-cross');

describe('Task 8 — MuleSoft fleet registration + parallel determinism', () => {
  it('defaultExtractors() contains exactly one MuleExtractor', () => {
    const mules = defaultExtractors().filter((e) => e.name === 'family:mulesoft');
    expect(mules.length).toBe(1);
  });

  it('defaultResolvers() contains exactly one MuleResolver', () => {
    const mules = defaultResolvers().filter((r) => r instanceof MuleResolver);
    expect(mules.length).toBe(1);
  });

  it('MuleExtractor supports() is disjoint from generic XML/resource files (never steals)', () => {
    const extractor = defaultExtractors().find((e) => e.name === 'family:mulesoft')!;
    // a classified Mule file is supported
    expect(
      extractor.supports({
        path: 'src/main/mule/orders.xml',
        bytes: 0,
        mtime: 0,
        classification: {
          family: 'mule',
          projectId: '.',
          projectRoot: '',
          dialect: 'mule4',
          role: 'config',
        },
      }),
    ).toBe(true);
    // an unclassified ordinary XML file is NOT supported (no classification → not Mule)
    expect(extractor.supports({ path: 'pom.xml', bytes: 0, mtime: 0 })).toBe(false);
    expect(extractor.supports({ path: 'report.xml', bytes: 0, mtime: 0 })).toBe(false);
  });

  it('a Mule 4 fixture indexes to a byte-identical soul via serial and concurrent paths', async () => {
    const { indexRepo } = await import('./pipeline.js');
    const opts = { now: NOW, dossiers: false, ownership: false };
    const serialRepo = mkdtempSync(join(tmpdir(), 'crib-mule-par-ser-'));
    const concRepo = mkdtempSync(join(tmpdir(), 'crib-mule-par-conc-'));
    cpSync(MULE_FIXTURE, serialRepo, { recursive: true });
    cpSync(MULE_FIXTURE, concRepo, { recursive: true });
    await indexRepo(soulAt(serialRepo), serialRepo, { ...opts, parallel: false });
    await indexRepo(soulAt(concRepo), concRepo, opts); // parallel omitted → concurrency engages
    expect(snapshotCrib(concRepo)).toBe(snapshotCrib(serialRepo));
    rmSync(serialRepo, { recursive: true, force: true });
    rmSync(concRepo, { recursive: true, force: true });
  });

  it('the Mule fixture produces cross-file resolve edges (resolver runs end-to-end via indexRepo)', async () => {
    const { indexRepo } = await import('./pipeline.js');
    const repo = mkdtempSync(join(tmpdir(), 'crib-mule-par-edges-'));
    cpSync(MULE_FIXTURE, repo, { recursive: true });
    const soul = soulAt(repo);
    const report = await indexRepo(soul, repo, { now: NOW, dossiers: false, ownership: false });
    // cross-file flow-ref → one calls edge (getOrders → enrichOrder); static missing → one externalFlow
    expect(report.resolve.calls).toBeGreaterThanOrEqual(1);
    expect(report.resolve.externalFlows).toBeGreaterThanOrEqual(1);
    expect([...soul.iterate('symbol')].some((n) => n.type === 'external-flow')).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});
