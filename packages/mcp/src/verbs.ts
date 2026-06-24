import { pathFromId } from '@knowledge-crib/core';
import type { Dir, IndexStore, SoulStore } from '@knowledge-crib/core';
import { decisionTable } from '@knowledge-crib/core';
/**
 * The MCP verbs as pure functions over the soul + index. These are the product surface; the stdio
 * server is thin wiring on top. Every edge-bearing result carries {method, provenance, confidence,
 * evidence} so an agent can filter to EXTRACTED-only (`extractedOnly`). Deterministic verbs never
 * touch the network or the enricher.
 */
import type { Edge, Node, NodeKind } from '@knowledge-crib/soul-schema';
import { rehydrate } from './snippet.js';
import { DEFAULT_DOC_LIMIT, DEFAULT_LIMIT, bound } from './token-budget.js';

/**
 * Injected VCS adapter (M6) so `detect_changes` can read the git anchor + changed files without the MCP
 * package depending on the pipeline. The CLI supplies a real adapter; tests inject a stub. Absent ⇒ the
 * verb reports "not configured" rather than guessing.
 */
export interface VcsAdapter {
  currentHead(root: string): string;
  changedFilesSince(root: string, since: string): string[];
}

export interface VerbDeps {
  soul: SoulStore;
  index: IndexStore;
  repoRoot: string;
  vcs?: VcsAdapter;
}

/** Direction as the MCP api expresses it. */
export type ApiDir = 'in' | 'out' | 'both';

export interface DocLink {
  sectionId: string;
  heading?: string;
  anchor?: string;
  snippet: string;
  edgeType: 'describes' | 'references';
  method: string;
  provenance: string;
  confidence: number;
}

const DOC_RELS = new Set(['describes', 'references']);

export class Verbs {
  constructor(private readonly deps: VerbDeps) {}

  status(): Record<string, unknown> {
    const m = this.deps.soul.getManifest();
    return {
      indexed: m.stats.nodes > 0,
      schemaVersion: m.schemaVersion,
      stats: { nodes: m.stats.nodes, edges: m.stats.edges, clusters: m.stats.clusters },
      ...(m.repo.vcsHead ? { vcsHead: m.repo.vcsHead } : {}),
      ...(m.stats.incrementalSince ? { incrementalSince: m.stats.incrementalSince } : {}),
      capabilities: { ...m.capabilities, ...this.deps.index.capabilities() },
    };
  }

  context(args: { id: string; docLimit?: number; extractedOnly?: boolean }): Record<
    string,
    unknown
  > {
    const node = this.deps.soul.getNode(args.id);
    if (!node) return notFound(args.id);
    const callers = this.callEdges(args.id, 'up', args.extractedOnly).map((e) =>
      this.brief(e.src, e.confidence),
    );
    const callees = this.callEdges(args.id, 'down', args.extractedOnly).map((e) =>
      this.brief(e.dst, e.confidence),
    );
    const docs = bound(
      this.docsFor(args.id, 0, args.extractedOnly),
      args.docLimit ?? DEFAULT_DOC_LIMIT,
    );
    return {
      node: this.publicNode(node),
      callers,
      callees,
      docs: docs.items,
      truncated: docs.truncated,
    };
  }

  impact(args: {
    id: string;
    dir: Dir;
    depth?: number;
    docLimit?: number;
    limit?: number;
    extractedOnly?: boolean;
  }): Record<string, unknown> {
    if (!this.deps.soul.getNode(args.id)) return notFound(args.id);
    const depth = args.depth ?? 2;
    const visited = new Set<string>([args.id]);
    const affected: Array<{
      id: string;
      rel: string;
      distance: number;
      risk: string;
      docs: DocLink[];
    }> = [];
    let frontier = [args.id];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const e of this.adjacency(cur, args.dir, args.extractedOnly)) {
          const nb = args.dir === 'up' ? e.src : e.dst;
          if (visited.has(nb)) continue;
          visited.add(nb);
          next.push(nb);
          affected.push({
            id: nb,
            rel: e.rel,
            distance: d,
            risk: d === 1 ? 'high' : d === 2 ? 'medium' : 'low',
            docs: bound(this.docsFor(nb, 0, args.extractedOnly), args.docLimit ?? DEFAULT_DOC_LIMIT)
              .items,
          });
        }
      }
      frontier = next;
    }
    const page = bound(affected, args.limit ?? DEFAULT_LIMIT);
    return {
      root: args.id,
      dir: args.dir,
      affected: page.items,
      relatedDocs: this.docsFor(args.id, 0, args.extractedOnly),
      truncated: page.truncated,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  query(args: { q: string; kinds?: NodeKind[]; limit?: number }): Record<string, unknown> {
    const hits = this.deps.index
      .query({
        text: args.q,
        ...(args.kinds ? { kinds: args.kinds } : {}),
        limit: args.limit ?? DEFAULT_LIMIT,
      })
      .map((h) => {
        const node = this.deps.soul.getNode(h.id);
        return {
          id: h.id,
          kind: h.kind,
          score: h.score,
          snippet: rehydrate(this.deps.repoRoot, node),
          ...(node?.clusterId ? { clusterId: node.clusterId } : {}),
        };
      });
    return { hits, truncated: false };
  }

  describes(args: { id: string; minConfidence?: number; extractedOnly?: boolean }): Record<
    string,
    unknown
  > {
    if (!this.deps.soul.getNode(args.id)) return notFound(args.id);
    const docs = this.docsFor(args.id, args.minConfidence ?? 0.4, args.extractedOnly);
    return { docs };
  }

  neighbors(args: {
    id: string;
    rel?: string;
    dir?: ApiDir;
    limit?: number;
    extractedOnly?: boolean;
  }): Record<string, unknown> {
    if (!this.deps.soul.getNode(args.id)) return notFound(args.id);
    const edges = this.adjacency(args.id, apiDir(args.dir), args.extractedOnly).filter(
      (e) => !args.rel || e.rel === args.rel,
    );
    const page = bound(edges.map(publicEdge), args.limit ?? 50);
    return {
      edges: page.items,
      truncated: page.truncated,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  shortestPath(args: { from: string; to: string; maxHops?: number }): Record<string, unknown> {
    const r = this.deps.index.shortestPath(args.from, args.to, args.maxHops ?? 6);
    return { path: r.path, edges: r.edges.map(publicEdge), found: r.found };
  }

  /**
   * `detect_changes` — a READ-ONLY dry run (M6): reports the nodes whose files changed since the VCS
   * anchor and the edges that touch those files (projected removals), WITHOUT mutating the soul or the
   * index. Never commits. Degrades gracefully when no adapter / no anchor / non-git.
   */
  detectChanges(args: { since?: string }): Record<string, unknown> {
    const vcs = this.deps.vcs;
    const manifest = this.deps.soul.getManifest();
    const since = args.since ?? manifest.stats.incrementalSince ?? manifest.repo.vcsHead;
    if (!vcs) {
      return {
        changedSymbols: [],
        newEdges: [],
        removedEdges: [],
        note: 'vcs adapter not configured',
      };
    }
    let head: string;
    try {
      head = vcs.currentHead(this.deps.repoRoot);
    } catch {
      return { changedSymbols: [], newEdges: [], removedEdges: [], note: 'not a git work tree' };
    }
    if (!since) {
      return {
        changedSymbols: [],
        newEdges: [],
        removedEdges: [],
        head,
        note: 'no incremental anchor — run `crib index` to establish one',
      };
    }
    let changedPaths: string[];
    try {
      changedPaths = vcs.changedFilesSince(this.deps.repoRoot, since);
    } catch {
      return {
        changedSymbols: [],
        newEdges: [],
        removedEdges: [],
        head,
        note: 'not a git work tree',
      };
    }
    const changed = new Set(changedPaths);
    const changedSymbols: string[] = [];
    const removedEdges: Array<{ id: string; src: string; dst: string; rel: string }> = [];
    for (const node of this.deps.soul.iterate()) {
      const p = node.file ?? pathFromId(node.id);
      if (p !== undefined && changed.has(p)) changedSymbols.push(node.id);
    }
    for (const edge of this.deps.soul.iterateEdges()) {
      const s = pathFromId(edge.src);
      const d = pathFromId(edge.dst);
      if ((s !== undefined && changed.has(s)) || (d !== undefined && changed.has(d))) {
        removedEdges.push({ id: edge.id, src: edge.src, dst: edge.dst, rel: edge.rel });
      }
    }
    return { since, head, changedPaths, changedSymbols, removedEdges };
  }

  /**
   * `extract_rules` (M12) — walk a procedure's guard-annotated CFG (the M11 `cfgPath`/`guard`/
   * `branch` stamped on its `executes`/`calls` edges) and materialize the decision table / rule
   * records. Pure over the soul. `procedure` is a node id or a (qualified|simple) name. Returns
   * NOT_FOUND when no procedure matches.
   */
  extractRules(args: {
    procedure: string;
    includeTables?: boolean;
  }): Record<string, unknown> {
    const table = decisionTable(this.deps.soul, args.procedure, {
      ...(args.includeTables ? { includeTables: true } : {}),
    });
    if (table.rules.length === 0 && !this.deps.soul.getNode(args.procedure)) {
      // confirm the procedure exists at all before declaring emptiness a miss
      const sym = [...this.deps.soul.iterate('symbol')].find(
        (n) =>
          (n.type === 'procedure' || n.type === 'function') &&
          (n.qualifiedName?.toLowerCase() === args.procedure.toLowerCase() ||
            n.name?.toLowerCase() === args.procedure.toLowerCase()),
      );
      if (!sym) return notFound(args.procedure);
    }
    return table as unknown as Record<string, unknown>;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private adjacency(id: string, dir: Dir | 'both', extractedOnly?: boolean): Edge[] {
    const edges =
      dir === 'both'
        ? this.deps.index.neighbors(id)
        : this.deps.index.neighbors(id, undefined, dir);
    return extractedOnly ? edges.filter((e) => e.provenance === 'EXTRACTED') : edges;
  }

  private callEdges(id: string, dir: Dir, extractedOnly?: boolean): Edge[] {
    return this.deps.index
      .neighbors(id, 'calls', dir)
      .filter((e) => !extractedOnly || e.provenance === 'EXTRACTED');
  }

  /** Doc links pointing at `id` (incoming describes/references), filtered + sorted by confidence. */
  private docsFor(id: string, minConfidence: number, extractedOnly?: boolean): DocLink[] {
    const incoming = this.deps.index.neighbors(id, undefined, 'up');
    const links: DocLink[] = [];
    for (const e of incoming) {
      if (!DOC_RELS.has(e.rel)) continue;
      if (e.confidence < minConfidence) continue;
      if (extractedOnly && e.provenance !== 'EXTRACTED') continue;
      const section = this.deps.soul.getNode(e.src);
      links.push({
        sectionId: e.src,
        ...(section?.heading ? { heading: section.heading } : {}),
        ...(section?.anchor ? { anchor: section.anchor } : {}),
        snippet: rehydrate(this.deps.repoRoot, section),
        edgeType: e.rel as 'describes' | 'references',
        method: e.method,
        provenance: e.provenance,
        confidence: e.confidence,
      });
    }
    return links.sort((a, b) => b.confidence - a.confidence);
  }

  private brief(id: string, confidence: number): Record<string, unknown> {
    const n = this.deps.soul.getNode(id);
    return { id, ...(n?.name ? { name: n.name } : {}), confidence };
  }

  private publicNode(n: Node): Record<string, unknown> {
    return {
      id: n.id,
      kind: n.kind,
      ...(n.name ? { name: n.name } : {}),
      ...(n.signature ? { signature: n.signature } : {}),
      ...(n.file ? { file: n.file } : {}),
      ...(n.span ? { span: n.span } : {}),
      ...(n.clusterId ? { clusterId: n.clusterId } : {}),
    };
  }
}

function apiDir(d?: ApiDir): Dir | 'both' {
  if (d === 'in') return 'up';
  if (d === 'out') return 'down';
  return 'both';
}

function publicEdge(e: Edge): Record<string, unknown> {
  return {
    src: e.src,
    dst: e.dst,
    rel: e.rel,
    method: e.method,
    provenance: e.provenance,
    confidence: e.confidence,
    ...(e.evidence ? { evidence: e.evidence } : {}),
  };
}

function notFound(id: string): Record<string, unknown> {
  return { error: { code: 'NOT_FOUND', message: `no node with id ${id}` } };
}
