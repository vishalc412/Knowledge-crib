/**
 * M12 export renderers — `graph.json` (a deterministic soul dump) and `report` (human-readable
 * text). The `rules` and `mermaid` formats are produced by {@link decisionTable} /
 * {@link renderMermaid}; this module holds the whole-soul serializations the CLI `export` command
 * also needs.
 */
import type { SoulStore } from '@knowledge-crib/core';
import { decisionTable } from '@knowledge-crib/core';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { renderMermaid } from './mermaid.js';

export interface GraphJson {
  schemaVersion: string;
  stats: { nodes: number; edges: number };
  nodes: Node[];
  edges: Edge[];
}

/** Deterministic whole-graph JSON: nodes then edges, in store iteration order. */
export function exportGraph(soul: SoulStore): GraphJson {
  const nodes = [...soul.iterate()];
  const edges = [...soul.iterateEdges()];
  return {
    schemaVersion: soul.getManifest().schemaVersion,
    stats: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  };
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
      return `${JSON.stringify(exportGraph(soul), null, 2)}\n`;
    case 'report':
      return `${renderReport(soul, procedure)}\n`;
  }
}
