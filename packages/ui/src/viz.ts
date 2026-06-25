/**
 * M7 web-viz graph builder — converts a SoulStore into a Cytoscape.js element snapshot. Runs
 * server-side (the `crib viz` HTTP server serializes this to `/graph.json`); the browser `main.js`
 * renders it with compound nodes for clusters.
 *
 * Compound parents: a `member-of` edge whose `dst` is a `cluster` node marks the `src` symbol as a
 * child of that cluster — emitted as `{ data: { ..., parent: <clusterId> } }`, which Cytoscape renders
 * as a compound (nested) node. Everything is plain JSON; no soul types leak to the browser.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SoulStore } from '@knowledge-crib/core';
import type { NodeKind } from '@knowledge-crib/soul-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface VizNodeData {
  id: string;
  label: string;
  kind: NodeKind;
  /** cluster parent id (compound nesting) — undefined for non-clustered nodes. */
  parent?: string;
}
export interface VizEdgeData {
  id: string;
  source: string;
  target: string;
  label: string;
  rel: string;
  method: string;
}
export interface VizGraph {
  schemaVersion: string;
  stats: { nodes: number; edges: number; clusters: number };
  nodes: Array<{ data: VizNodeData }>;
  edges: Array<{ data: VizEdgeData }>;
}

/**
 * Build the viz snapshot. Deterministic: nodes are emitted in sorted-id order, edges in sorted-id
 * order, so two runs over the same soul produce byte-identical `/graph.json` (the determinism gate).
 */
export function buildVizGraph(soul: SoulStore): VizGraph {
  // map symbol → its cluster parent (if any) from member-of edges whose dst is a cluster.
  const parentOf = new Map<string, string>();
  let clusters = 0;
  for (const e of soul.iterateEdges('member-of')) {
    const dst = soul.getNode(e.dst);
    if (dst?.kind === 'cluster') parentOf.set(e.src, e.dst);
  }
  for (const n of soul.iterate('cluster')) clusters++;

  const nodes = [...soul.iterate()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => ({
      data: {
        id: n.id,
        label: n.label ?? n.qualifiedName ?? n.name ?? n.id,
        kind: n.kind,
        ...(parentOf.has(n.id) ? { parent: parentOf.get(n.id) } : {}),
      },
    }));

  const edges = [...soul.iterateEdges()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({
      data: {
        id: e.id,
        source: e.src,
        target: e.dst,
        label: e.rel,
        rel: e.rel,
        method: e.method,
      },
    }));

  return {
    schemaVersion: soul.getManifest().schemaVersion,
    stats: { nodes: nodes.length, edges: edges.length, clusters },
    nodes,
    edges,
  };
}

/** Absolute path to the static web assets dir (index.html, main.js, vendor/). */
export function vizAssetsDir(): string {
  // src/viz.ts → ../web  (works against source at dev time; the CLI resolves via the built dist too)
  return `${dirname(__dirname)}/web`;
}
