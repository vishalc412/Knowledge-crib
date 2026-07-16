/** Explicit derived materialization of unified composite graph. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GraphStore, graphFingerprint } from './graph-store.js';
import type { SoulStore } from './soul-store.js';

export interface MaterializeResult {
  root: string;
  sourceFingerprint: string;
  nodes: number;
  edges: number;
}

export function materializeComposite(soul: SoulStore): MaterializeResult {
  const target = join(soul.cribDir, 'index', 'composite');
  const staging = join(soul.cribDir, 'index', `.composite-${process.pid}-${randomUUID()}`);
  const snapshot = new GraphStore(soul).compositeLive();
  const fingerprint = graphFingerprint(soul);
  const { sourceFingerprint } = fingerprint;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, 'graph.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const db = new DatabaseSync(join(staging, 'crib.sqlite'));
    try {
      db.exec(`
        CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, origin TEXT, json TEXT NOT NULL);
        CREATE TABLE edges (id TEXT PRIMARY KEY, src TEXT, dst TEXT, rel TEXT, origin TEXT, json TEXT NOT NULL);
        CREATE INDEX edges_src ON edges(src);
        CREATE INDEX edges_dst ON edges(dst);
        CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, name, summary, kind, origin);
      `);
      const nodeInsert = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)');
      const ftsInsert = db.prepare('INSERT INTO nodes_fts VALUES (?, ?, ?, ?, ?)');
      for (const node of snapshot.nodes) {
        const raw = node as Record<string, unknown>;
        nodeInsert.run(node.id, node.kind, node.origin, JSON.stringify(node));
        ftsInsert.run(
          node.id,
          String(raw.name ?? raw.label ?? raw.qualifiedName ?? ''),
          String(raw.summary ?? raw.purpose ?? ''),
          node.kind,
          node.origin,
        );
      }
      const edgeInsert = db.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)');
      for (const edge of snapshot.edges) {
        edgeInsert.run(edge.id, edge.src, edge.dst, edge.rel, edge.origin, JSON.stringify(edge));
      }
    } finally {
      db.close();
    }
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify(
        {
          version: 1,
          ...fingerprint,
          builtAgainstHead: soul.getManifest().repo.vcsHead ?? null,
          nodes: snapshot.nodes.length,
          edges: snapshot.edges.length,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return {
      root: target,
      sourceFingerprint,
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
