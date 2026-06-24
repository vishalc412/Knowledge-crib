import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from './pipeline.js';

// Reuse the M10 PL/SQL golden fixture (a self-contained package body + its table DDL). Every edge
// resolves within the single file, so the only thing this test exercises is the M11 CFG pass.
const PLSQL_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'parsers',
  'fixtures',
  'plsql',
);

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-cfg-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

const FILE = 'claims.pkb';
const stmtId = (line: number): string => idFor({ kind: 'statement', file: FILE, line });
const condId = (line: number): string => idFor({ kind: 'condition', file: FILE, line });

describe('PlSqlCfgPass — guard-chain annotation (M11 gate)', () => {
  it('stamps hand-derived path conditions onto executes edges', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    expect(report.cfg.annotated).toBeGreaterThan(0);

    const validate = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'claim_pkg.validate_claim',
    );
    const process = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'claim_pkg.process_claim',
    );
    expect(validate).toBeDefined();
    expect(process).toBeDefined();
    const vId = validate!.id;
    const pId = process!.id;

    // validate_claim: SELECT @L13 is at procedure top-level → empty path, no guard.
    const select13 = soul.getEdge(edgeId(vId, stmtId(13), 'executes'));
    expect(select13).toBeDefined();
    expect(select13!.cfgPath).toEqual([]);
    expect(select13!.guard).toBeUndefined();
    expect(select13!.branch).toBeUndefined();
    expect(select13!.inLoop).toBe(false);
    expect(select13!.inException).toBe(false);

    // validate_claim: UPDATE @L15 sits inside IF@L14 THEN → guard = cond@L14, branch THEN.
    const update15 = soul.getEdge(edgeId(vId, stmtId(15), 'executes'));
    expect(update15!.cfgPath).toEqual([condId(14)]);
    expect(update15!.guard).toBe(condId(14));
    expect(update15!.branch).toBe('THEN');
    expect(update15!.inLoop).toBe(false);

    // process_claim: SELECT @L23 at top-level → empty path.
    const select23 = soul.getEdge(edgeId(pId, stmtId(23), 'executes'));
    expect(select23!.cfgPath).toEqual([]);
    expect(select23!.guard).toBeUndefined();

    // process_claim: INSERT @L25 inside IF@L24 THEN → guard cond@L24, branch THEN.
    const insert25 = soul.getEdge(edgeId(pId, stmtId(25), 'executes'));
    expect(insert25!.cfgPath).toEqual([condId(24)]);
    expect(insert25!.guard).toBe(condId(24));
    expect(insert25!.branch).toBe('THEN');

    // process_claim: DELETE @L27 inside IF@L24 ELSE → the IF's condition is on the path (polarity
    // FALSE recorded by branch='ELSE'), guard still cond@L24.
    const delete27 = soul.getEdge(edgeId(pId, stmtId(27), 'executes'));
    expect(delete27!.cfgPath).toEqual([condId(24)]);
    expect(delete27!.guard).toBe(condId(24));
    expect(delete27!.branch).toBe('ELSE');
  });

  it('annotates the calls edge with the call-site path condition (top-level call → empty path)', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const process = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'claim_pkg.process_claim',
    )!;
    const validate = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'claim_pkg.validate_claim',
    )!;
    // the call `validate_claim(p_id);` at L22 is at process_claim top-level (before the IF@L24).
    const calls = soul.getEdge(edgeId(process.id, validate.id, 'calls'));
    expect(calls).toBeDefined();
    expect(calls!.cfgPath).toEqual([]);
    expect(calls!.guard).toBeUndefined();
    expect(calls!.branch).toBeUndefined();
    expect(calls!.inLoop).toBe(false);
  });

  it('emits condition nodes the guard chain references (cond@L14, cond@L24)', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    const conds = new Set([...soul.iterate('condition')].map((n) => n.id));
    expect(conds.has(condId(14))).toBe(true);
    expect(conds.has(condId(24))).toBe(true);
    // every guard/cfgPath element on an annotated edge references an existing condition node
    const nodes = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      for (const c of e.cfgPath ?? []) expect(nodes.has(c)).toBe(true);
      if (e.guard) expect(nodes.has(e.guard)).toBe(true);
    }
  });

  it('cfgPath is always an array (the 1.0 string→string[] bump)', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    for (const e of soul.iterateEdges()) {
      if (e.cfgPath !== undefined) expect(Array.isArray(e.cfgPath)).toBe(true);
    }
  });
});

describe('P0b schema bump — v1.0 soul round-trip (M11 gate)', () => {
  it('loads a v1.0 soul with no cfgPath as undefined (no widening), and re-commit preserves it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crib-cfg-v1-'));
    try {
      const manifest = newManifest({ now: '2026-01-01T00:00:00.000Z' });
      manifest.schemaVersion = '1.0'; // simulate a pre-M11 soul
      const soul = new SoulStore(dir, { manifest });
      soul.load();

      const procId = idFor({ kind: 'symbol', path: 'f.sql', qualifiedName: 'p', startLine: 1 });
      const stmtIdVal = idFor({ kind: 'statement', file: 'f.sql', line: 2 });
      const proc: Node = {
        id: procId,
        kind: 'symbol',
        type: 'procedure',
        name: 'p',
        qualifiedName: 'p',
        file: 'f.sql',
        span: { start: 1, end: 1 },
        lang: 'plsql',
        hash: contentHash('p'),
      };
      const stmt: Node = {
        id: stmtIdVal,
        kind: 'statement',
        sqlKind: 'select',
        file: 'f.sql',
        span: { start: 2, end: 2 },
        lang: 'plsql',
        hash: contentHash('f.sql:2:select'),
      };
      // a v1.0 edge carries NO guard-chain fields
      const edge: Edge = {
        id: edgeId(procId, stmtIdVal, 'executes'),
        src: procId,
        dst: stmtIdVal,
        rel: 'executes',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
      };
      soul.putNodes([proc, stmt]);
      soul.putEdges([edge]);
      soul.commit('2026-01-01T00:00:00.000Z');

      // reload — the loader gate accepts schemaVersion 1.0
      const soul2 = new SoulStore(dir);
      expect(() => soul2.load()).not.toThrow();
      const e = soul2.getEdge(edge.id);
      expect(e).toBeDefined();
      expect(e!.cfgPath).toBeUndefined(); // no widening
      expect(e!.inLoop).toBeUndefined();
      expect(e!.inException).toBeUndefined();
      expect(e!.guard).toBeUndefined();

      // re-commit a v1.0 soul must NOT invent cfgPath on write (byte-stable, no widening)
      soul2.commit('2026-01-01T00:00:00.000Z');
      const soul3 = new SoulStore(dir);
      soul3.load();
      expect(soul3.getEdge(edge.id)!.cfgPath).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to load a soul with an unknown schemaVersion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crib-cfg-unknown-'));
    try {
      // minimal manifest with a future schemaVersion; loader gate should reject before hydration
      writeFileSync(
        join(dir, 'crib.json'),
        JSON.stringify({
          cribFormatVersion: '1.0',
          schemaVersion: '9.9',
          repo: { id: 'x', root: '.' },
          generator: { tool: 'knowledge-crib', version: '0.0.0' },
          chunking: { shardHexDigits: 2, maxChunkLines: 5000, format: 'jsonl' },
          stores: {
            soul: 'jsonl-chunked',
            index: { backend: 'sqlite', path: '.crib/index/crib.sqlite' },
          },
          stats: { nodes: 0, edges: 0, clusters: 0, lastUpdated: '2026-01-01T00:00:00.000Z' },
          capabilities: { embeddings: false, multimodal: false },
        }),
      );
      const soul = new SoulStore(dir);
      expect(() => soul.load()).toThrow(/unsupported soul schemaVersion/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
