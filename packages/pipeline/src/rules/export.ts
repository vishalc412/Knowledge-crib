/**
 * M12 export renderers — `graph.json` (a deterministic soul dump) and `report` (human-readable
 * text). The `rules` and `mermaid` formats are produced by {@link decisionTable} /
 * {@link renderMermaid}; this module holds the whole-soul serializations the CLI `export` command
 * also needs.
 */
import type { SoulStore } from '@knowledge-crib/core';
import { GraphStore, decisionTable, pathFromId } from '@knowledge-crib/core';
import type { CompositeEdge, CompositeNode } from '@knowledge-crib/core';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { renderMermaid } from './mermaid.js';

export interface GraphJson {
  schemaVersion: string;
  stats: { nodes: number; edges: number };
  nodes: Array<Node | CompositeNode>;
  edges: Array<Edge | CompositeEdge>;
  semantic?: ReturnType<GraphStore['semantic']>['diagnostics'];
}

/** Deterministic whole-graph JSON: nodes then edges, in store iteration order. */
export function exportGraph(soul: SoulStore, extractedOnly = false): GraphJson {
  const store = new GraphStore(soul);
  const snapshot = extractedOnly ? store.extracted() : store.composite();
  const nodes = snapshot.nodes;
  const edges = snapshot.edges;
  return {
    schemaVersion: soul.getManifest().schemaVersion,
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
    ...(!extractedOnly ? { semantic: snapshot.diagnostics } : {}),
  };
}

/** A surprising connection crosses a package boundary and/or has no shared cluster. */
export interface SurprisingConnection {
  edge: Edge;
  reason: string;
  score: number;
}

/** First path segment used as a coarse package/module discriminator. */
function packageOf(file: string): string {
  return file.split('/')[0] ?? file;
}

/**
 * Find edges that bridge unexpectedly distant parts of the graph. An edge is "surprising" when its
 * source and destination live in different top-level packages, or when two symbols belong to no
 * shared cluster. Higher score = more surprising. Returns the top `limit` sorted by score desc,
 * then confidence desc.
 */
export function surprisingConnections(soul: SoulStore, limit = 20): SurprisingConnection[] {
  const clusterMap = new Map<string, string[]>();
  for (const cluster of soul.iterate('cluster')) {
    for (const memberId of cluster.members ?? []) {
      if (!clusterMap.has(memberId)) clusterMap.set(memberId, []);
      clusterMap.get(memberId)!.push(cluster.id);
    }
  }

  const results: SurprisingConnection[] = [];
  for (const edge of soul.iterateEdges()) {
    const srcNode = soul.getNode(edge.src);
    const dstNode = soul.getNode(edge.dst);
    if (!srcNode || !dstNode) continue;

    const srcPath = srcNode.file ?? pathFromId(edge.src) ?? undefined;
    const dstPath = dstNode.file ?? pathFromId(edge.dst) ?? undefined;
    const crossPkg =
      srcPath !== undefined && dstPath !== undefined && packageOf(srcPath) !== packageOf(dstPath);

    const srcClusters = clusterMap.get(edge.src) ?? [];
    const dstClusters = clusterMap.get(edge.dst) ?? [];
    const sharedCluster =
      srcClusters.length > 0 &&
      dstClusters.length > 0 &&
      srcClusters.some((c) => dstClusters.includes(c));

    const reasons: string[] = [];
    let score = 0;
    if (crossPkg) {
      score += 2;
      reasons.push('cross-package');
    }
    if (!sharedCluster && (srcClusters.length > 0 || dstClusters.length > 0)) {
      score += 1;
      reasons.push('cross-cluster');
    }

    if (score > 0) {
      results.push({ edge, reason: reasons.join(', '), score });
    }
  }

  results.sort((a, b) => b.score - a.score || b.edge.confidence - a.edge.confidence);
  return results.slice(0, limit);
}

/** A human-readable report: header stats, kind breakdown, and (if given) one procedure's rules. */
export function renderReport(soul: SoulStore, procedure?: string): string {
  const m = soul.getManifest();
  const lines: string[] = [
    'knowledge-crib report',
    '======================',
    `schema: ${m.schemaVersion}`,
    `nodes: ${m.stats.nodes}  edges: ${m.stats.edges}  clusters: ${m.stats.clusters}`,
  ];
  if (m.repo.vcsHead) lines.push(`vcsHead: ${m.repo.vcsHead}`);

  const byKind = new Map<string, number>();
  for (const n of soul.iterate()) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  lines.push('', 'nodes by kind:');
  for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`  ${k.padEnd(14)} ${v}`);

  const byRel = new Map<string, number>();
  for (const e of soul.iterateEdges()) byRel.set(e.rel, (byRel.get(e.rel) ?? 0) + 1);
  if (byRel.size > 0) {
    lines.push('', 'edges by relation:');
    for (const [k, v] of [...byRel.entries()].sort((a, b) => b[1] - a[1]))
      lines.push(`  ${k.padEnd(14)} ${v}`);
  }

  const surprises = surprisingConnections(soul, 20);
  if (surprises.length > 0) {
    lines.push('', 'surprising connections:');
    for (const s of surprises) {
      lines.push(`  ${s.edge.rel.padEnd(10)} ${s.edge.src} -> ${s.edge.dst}  (${s.reason})`);
    }
  }

  if (procedure) {
    const table = decisionTable(soul, procedure, { includeTables: true });
    lines.push(
      '',
      `rules for ${table.procedureName ?? table.procedure}:`,
      `  conditions: ${table.conditions.length > 0 ? table.conditions.join(', ') : '(none)'}`,
      `  rules: ${table.rules.length}`,
    );
    for (const r of table.rules) {
      const cond = r.conditions
        .map((c) => `${c.id}${c.polarity ? `=${c.polarity}` : ''}`)
        .join(' ∧ ');
      const guard = cond || '⊤';
      const act =
        r.action.kind === 'calls'
          ? `call ${r.action.expr ?? r.action.target}`
          : `${r.action.sqlKind ?? 'stmt'}${r.action.expr ? ` ${r.action.expr}` : ''}`;
      const loops = [r.inLoop ? 'loop' : '', r.inException ? 'exc' : ''].filter(Boolean).join(',');
      lines.push(
        `    [${guard}]${loops ? ` <${loops}>` : ''} → ${act}${r.action.line ? ` @L${r.action.line}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

/** Render any export format for the CLI. `procedure` is required for rules/mermaid. */
export function renderExport(
  soul: SoulStore,
  format: 'rules' | 'mermaid' | 'graph.json' | 'report',
  procedure?: string,
  opts: { extractedOnly?: boolean } = {},
): string {
  switch (format) {
    case 'rules': {
      if (!procedure) throw new Error('rules format requires a procedure id or name');
      return `${JSON.stringify(decisionTable(soul, procedure, { includeTables: true }), null, 2)}\n`;
    }
    case 'mermaid': {
      if (!procedure) throw new Error('mermaid format requires a procedure id or name');
      return `${renderMermaid(decisionTable(soul, procedure))}\n`;
    }
    case 'graph.json':
      return `${JSON.stringify(exportGraph(soul, opts.extractedOnly), null, 2)}\n`;
    case 'report':
      return `${renderReport(soul, procedure)}\n`;
  }
}
