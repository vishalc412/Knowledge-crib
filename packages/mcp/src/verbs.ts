import { pathFromId } from '@knowledge-crib/core';
import type { Dir, Dossier, IndexStore, SoulStore } from '@knowledge-crib/core';
import {
  CALLABLE_SYMBOL_TYPES,
  buildDossier,
  computeCoverage,
  decisionTable,
  dossierToMarkdown,
  frameworkSemantics,
  readDossier,
  writeDossier,
} from '@knowledge-crib/core';
/**
 * The MCP verbs as pure functions over the soul + index. These are the product surface; the stdio
 * server is thin wiring on top. Every edge-bearing result carries {method, provenance, confidence,
 * evidence} so an agent can filter to EXTRACTED-only (`extractedOnly`). Deterministic verbs never
 * touch the network or the enricher.
 */
import type { Edge, Node, NodeKind } from '@knowledge-crib/soul-schema';
import {
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_BODY_MAX_LINES,
  type RehydratedBody,
  rehydrate,
  rehydrateBody,
} from './snippet.js';
import { DEFAULT_DOC_LIMIT, DEFAULT_LIMIT, bound } from './token-budget.js';

/**
 * Infer the body file a package spec SHOULD live next to, from the spec file path. Covers the common
 * Oracle conventions the migration feedback keys on: `.pks`→`.pkb`, `*_spec.sql`→`*_body.sql`, and a
 * generic `spec`→`body` token swap. Returns `undefined` when the path gives no signal (honesty: we do
 * not fabricate a name we are not confident about). Pure + language-agnostic — works for any repo.
 */
function expectedBodyFile(specFile: string): string | undefined {
  if (/\.pks$/i.test(specFile)) return specFile.replace(/\.pks$/i, '.pkb');
  if (/_spec\.sql$/i.test(specFile)) return specFile.replace(/_spec\.sql$/i, '_body.sql');
  if (/spec\.sql$/i.test(specFile)) return specFile.replace(/spec\.sql$/i, 'body.sql');
  if (/\.sql$/i.test(specFile) && /spec/i.test(specFile)) {
    return specFile.replace(/spec/i, 'body');
  }
  return undefined;
}

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

  context(args: {
    id: string;
    docLimit?: number;
    extractedOnly?: boolean;
    /** include the full source text of the node's span (rehydrated from disk, budgeted) */
    withSource?: boolean;
    /** for a procedure/function, fold in its decision table (conditions/actions/reads/writes) */
    withRules?: boolean;
    /** fold in the schema-1.3 framework-semantics relationships: routes exposed, beans produced,
     *  DI dependencies/dependents, JPA relations, component renders. Auto-scopes by node — a class
     *  (controller/@Configuration/@Entity) aggregates its members' route table / bean inventory /
     *  DI graph / relation model via `member-of`; a callable/component/field returns its own direct
     *  edges. A @Bean-supplied dependency is surfaced with `kind: 'produces'` + the producer in one
     *  trip (no round-trip). Unresolved `meta.injects`/`meta.produces` type names surface as
     *  `⚠ unresolved` entries (parity with `gaps`). */
    withFramework?: boolean;
    /** char cap for the rehydrated source body (default {@link DEFAULT_BODY_MAX_CHARS}) */
    sourceMaxChars?: number;
    /** line cap for the rehydrated source body (default {@link DEFAULT_BODY_MAX_LINES}) */
    sourceMaxLines?: number;
    /** absolute file line to start the source page at (paging cursor; default = span start) */
    sourceStartLine?: number;
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const node = soul.getNode(args.id);
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
    const result: Record<string, unknown> = {
      node: this.publicNode(node),
      callers,
      callees,
      docs: docs.items,
      truncated: docs.truncated,
    };
    if (args.withSource) result.source = this.bodyOf(node, args);
    if (args.withRules && node.type && CALLABLE_SYMBOL_TYPES.has(node.type)) {
      result.rules = decisionTable(soul, args.id, { includeTables: true });
      // coverage gates the rules: an `unimplemented`/`partial` readiness tells the consumer the
      // decision table may be empty or lossy because the body is missing or expressions were clipped.
      result.coverage = computeCoverage(soul, args.id, {
        keep: (e) => !args.extractedOnly || e.provenance === 'EXTRACTED',
      });
    }
    if (args.withFramework) {
      // frameworkSemantics is pure over the soul (one iterateEdges scan, cached adjacency); auto-scopes
      // by node. Undefined when the node has no framework edges (a non-Spring method) → key omitted.
      const fw = frameworkSemantics(soul, args.id, {
        keep: (e) => !args.extractedOnly || e.provenance === 'EXTRACTED',
      });
      if (fw) result.framework = fw;
    }
    return result;
  }

  /**
   * `source` — the full source text of one node's span (rehydrated from disk), budgeted + page-able.
   * This is the "give me the body" verb: a procedure body, a CREATE TABLE DDL, a statement, a doc
   * section. Use it to read low-level code that the lean soul references but never copies. Returns
   * NOT_FOUND for an unknown id; an empty `source.text` (truncated:false) when the node has no
   * file/span on disk. When `truncated:true`, `source.nextLine` is the absolute file line to pass
   * back as `startLine` to fetch the next page (line-offset paging for bodies too large for one
   * round-trip — the migration analyst walking a 400-line PL/SQL package body).
   */
  source(args: {
    id: string;
    maxChars?: number;
    maxLines?: number;
    /** absolute file line to start the page at (paging cursor; default = span start) */
    startLine?: number;
  }): Record<string, unknown> {
    const node = this.deps.soul.getNode(args.id);
    if (!node) return notFound(args.id);
    return { node: this.publicNode(node), source: this.bodyOf(node, args) };
  }

  /**
   * `dossier` — one-shot deep reusable context for a symbol, backed by a persisted artifact.
   * Folds together everything an agent otherwise assembles from `context` + `source` +
   * `extract_rules`: the deep node fields, the paged rehydrated source body, callers / callees,
   * linked docs, the decision table (for a callable), AND the schema-1.2 control-flow constructs
   * (raises / handles / iterates / declares). The artifact is built by the shared core
   * {@link buildDossier} (the SAME code path the pipeline uses to persist it post-resolve), so the
   * persisted file and the live verb output are identical in shape.
   *
   * Cache discipline: a default-shape request (no source paging opts) is served from the persisted
   * artifact under `.crib/dossiers/` when it is fresh (node hash + schema version match the live
   * soul); otherwise it is rebuilt and re-persisted. A paged request (sourceStartLine / sourceMaxLines
   * / sourceMaxChars) is a live view — it is rebuilt every time (the cache holds the default page).
   * `format: 'markdown'` returns the deterministic human/agent-facing projection.
   */
  dossier(args: {
    id: string;
    includeTables?: boolean;
    sourceMaxChars?: number;
    sourceMaxLines?: number;
    /** absolute file line to start the source page at (paging cursor; default = span start) */
    sourceStartLine?: number;
    extractedOnly?: boolean;
    format?: 'json' | 'markdown';
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const node = soul.getNode(args.id);
    if (!node) return notFound(args.id);
    const manifest = soul.getManifest();
    const paged =
      args.sourceMaxChars !== undefined ||
      args.sourceMaxLines !== undefined ||
      args.sourceStartLine !== undefined;
    const buildOpts = {
      ...(args.includeTables ? { includeTables: true } : {}),
      ...(args.extractedOnly ? { extractedOnly: true } : {}),
      ...(args.sourceMaxChars !== undefined ? { sourceMaxChars: args.sourceMaxChars } : {}),
      ...(args.sourceMaxLines !== undefined ? { sourceMaxLines: args.sourceMaxLines } : {}),
      ...(args.sourceStartLine !== undefined ? { sourceStartLine: args.sourceStartLine } : {}),
    };

    let dossier: Dossier | undefined;
    if (!paged) {
      // default-shape: prefer the persisted artifact when fresh, else build + persist.
      const read = readDossier(soul.cribDir, args.id, {
        nodeHash: node.hash,
        schemaVersion: manifest.schemaVersion,
      });
      if (!read.missing && !read.stale && read.dossier) {
        dossier = read.dossier;
      } else {
        dossier = buildDossier(
          soul,
          this.deps.repoRoot,
          args.id,
          manifest.stats.lastUpdated,
          buildOpts,
        );
        if (dossier) writeDossier(soul.cribDir, dossier);
      }
    } else {
      // paged view: always rebuild (the cache holds the default page only).
      dossier = buildDossier(
        soul,
        this.deps.repoRoot,
        args.id,
        manifest.stats.lastUpdated,
        buildOpts,
      );
    }
    if (!dossier) return notFound(args.id);
    if (args.format === 'markdown') {
      return { id: args.id, markdown: dossierToMarkdown(dossier) };
    }
    return dossier as unknown as Record<string, unknown>;
  }

  /** Rehydrate a node's full span, mapping the budget + paging args onto the snippet defaults. */
  private bodyOf(
    node: Node,
    args: {
      sourceMaxChars?: number;
      sourceMaxLines?: number;
      sourceStartLine?: number;
      maxChars?: number;
      maxLines?: number;
      startLine?: number;
    },
  ): RehydratedBody {
    return rehydrateBody(this.deps.repoRoot, node, {
      maxChars: args.sourceMaxChars ?? args.maxChars ?? DEFAULT_BODY_MAX_CHARS,
      maxLines: args.sourceMaxLines ?? args.maxLines ?? DEFAULT_BODY_MAX_LINES,
      ...(args.sourceStartLine !== undefined ? { startLine: args.sourceStartLine } : {}),
      ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
    });
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
    // Attach coverage so an EMPTY decision table is never silently read as "no rules": if readiness
    // is `unimplemented`, the table is empty because the body is MISSING — a different fact, and the
    // one that matters for a migration plan. `table.procedure` is the resolved node id.
    const coverage = computeCoverage(this.deps.soul, table.procedure);
    return { ...table, coverage } as unknown as Record<string, unknown>;
  }

  /**
   * `gaps` — surface what an LLM otherwise misses by reading the graph alone: declarations without
   * bodies, package specs with no body file, and call sites that resolve to no symbol. Pure over the
   * soul + index; deterministic. This is the migration-analyst answer to "is the package body
   * missing?" — the crib now says so explicitly instead of letting the analyst infer it from silence.
   *
   * Three signals:
   *   • `unimplemented` — a callable (procedure/function/method/…) whose qualified-name group owns
   *     zero `executes` edges: a declaration with no body anywhere in the soul. For PL/SQL this is
   *     exactly a spec-only procedure whose `.pkb` body is absent.
   *   • `packageSpecsWithoutBody` — a `package` symbol whose member callables are ALL unimplemented
   *     AND none live in a body file (`.pkb`/`.pck`/`.pls`/`.pkh`). The strong "body file missing"
   *     signal (e.g. `PKG_LOAN_RULE_ENGINE` spec present, body absent).
   *   • `unresolvedCallSites` — a callable's recorded call site whose callee simple-name matches no
   *     symbol in the soul: a call into a missing asset. Oracle built-in packages (`DBMS_*`/`UTL_*`/
   *     `APEX_*`/…) are flagged `builtin:true`, never silently hidden.
   */
  gaps(args: { extractedOnly?: boolean } = {}): Record<string, unknown> {
    const soul = this.deps.soul;
    const idx = this.deps.index;
    const keep = (e: Edge): boolean => !args.extractedOnly || e.provenance === 'EXTRACTED';

    const callables: Node[] = [];
    for (const n of soul.iterate('symbol')) {
      if (n.type && CALLABLE_SYMBOL_TYPES.has(n.type)) callables.push(n);
    }

    // Group callables by lowercased qualified-name (or simple name) so a spec declaration + a body
    // definition collapse to one logical procedure: "implemented" iff some member has an executes edge.
    const byName = new Map<string, Node[]>();
    for (const c of callables) {
      const key = (c.qualifiedName ?? c.name ?? c.id).toLowerCase();
      const arr = byName.get(key);
      if (arr) arr.push(c);
      else byName.set(key, [c]);
    }
    const hasExecutes = (id: string): boolean => idx.neighbors(id, 'executes', 'down').some(keep);

    // Incoming `calls` edges across a whole qualified-name group → "referenced everywhere but
    // missing" files. Pure over the index; surfaces the loan-rule-engine signal ("the body is
    // referenced from N files") without a separate lookup.
    const referencedBy = (group: Node[]): { count: number; files: string[] } => {
      const files = new Set<string>();
      let count = 0;
      for (const c of group) {
        for (const e of idx.neighbors(c.id, 'calls', 'up')) {
          if (!keep(e)) continue;
          count++;
          const caller = soul.getNode(e.src);
          if (caller?.file) files.add(caller.file);
        }
      }
      return { count, files: [...files].sort() };
    };

    const unimplemented: Array<Record<string, unknown>> = [];
    const implementedNames = new Set<string>();
    for (const [key, group] of byName) {
      if (group.some((c) => hasExecutes(c.id))) {
        implementedNames.add(key);
        continue;
      }
      const rep = group[0];
      if (!rep) continue;
      const refs = referencedBy(group);
      unimplemented.push({
        id: rep.id,
        ...(rep.name ? { name: rep.name } : {}),
        ...(rep.qualifiedName ? { qualifiedName: rep.qualifiedName } : {}),
        type: rep.type,
        ...(rep.file ? { file: rep.file } : {}),
        ...(rep.span ? { line: rep.span.start } : {}),
        ...(group.length > 1 ? { declaredIn: group.map((c) => c.file).filter(Boolean) } : {}),
        referencedBy: refs,
      });
    }

    // Package specs without a body: a `package` whose member callables are all unimplemented AND
    // none of them live in a body file. `member-of` edges point child→parent, so members are the
    // incoming `member-of` sources of the package node.
    const packageSpecsWithoutBody: Array<Record<string, unknown>> = [];
    for (const n of soul.iterate('symbol')) {
      if (n.type !== 'package') continue;
      const members = idx
        .neighbors(n.id, 'member-of', 'up')
        .map((e) => soul.getNode(e.src))
        .filter((m): m is Node => !!m && !!m.type && CALLABLE_SYMBOL_TYPES.has(m.type));
      if (members.length === 0) continue;
      const implemented = members.filter((m) =>
        implementedNames.has((m.qualifiedName ?? m.name ?? m.id).toLowerCase()),
      ).length;
      if (implemented > 0) continue;
      const hasBodyFile = members.some((m) => /\.(pkb|pck|pls|pkh)$/i.test(m.file ?? ''));
      if (hasBodyFile) continue;
      const specFile = n.file ?? members[0]?.file;
      packageSpecsWithoutBody.push({
        id: n.id,
        ...(n.qualifiedName ? { qualifiedName: n.qualifiedName } : {}),
        ...(n.name ? { name: n.name } : {}),
        ...(n.file ? { file: n.file } : {}),
        declaredCount: members.length,
        implementedCount: 0,
        ...(specFile ? { expectedBodyFile: expectedBodyFile(specFile) } : {}),
        referencedBy: referencedBy(members),
      });
    }

    // Unresolved call sites: callee simple-name matches no symbol. Built-in Oracle packages are
    // flagged, not dropped (honesty: nothing is hidden).
    const BUILTIN = /^(DBMS_|UTL_|APEX_|HTP|HTF_|SYS\.|STANDARD\.|DBA_|ALL_|USER_)/i;
    const nameIndex = new Set<string>();
    for (const c of callables) {
      if (c.name) nameIndex.add(c.name.toLowerCase());
      if (c.qualifiedName) {
        nameIndex.add(c.qualifiedName.toLowerCase());
        nameIndex.add((c.qualifiedName.split('.').pop() ?? '').toLowerCase());
      }
    }
    const unresolvedCallSites: Array<Record<string, unknown>> = [];
    for (const c of callables) {
      const sites = c.meta?.calls as Array<{ callee: string; line: number }> | undefined;
      if (!Array.isArray(sites)) continue;
      for (const s of sites) {
        const simple = (s.callee.split('.').pop() ?? s.callee).toLowerCase();
        if (nameIndex.has(simple)) continue;
        unresolvedCallSites.push({
          caller: c.id,
          ...(c.qualifiedName ? { callerName: c.qualifiedName } : {}),
          ...(c.file ? { callerFile: c.file } : {}),
          callee: s.callee,
          line: s.line,
          builtin: BUILTIN.test(s.callee),
        });
      }
    }

    // --- framework-semantics 1.3 gaps (Spring now, Node/React/Angular later — same shape) ---
    // controller-no-routes: a `controller`-stereotype class whose member methods expose ZERO routes
    // (a @Controller with no handler methods, or whose handlers all lost their @GetMapping). The
    // member-of traversal reuses the gaps discipline: members are the incoming member-of sources.
    const controllersWithoutRoutes: Array<Record<string, unknown>> = [];
    for (const n of soul.iterate('symbol')) {
      if (n.stereotype !== 'controller') continue;
      const members = idx
        .neighbors(n.id, 'member-of', 'up')
        .map((e) => soul.getNode(e.src))
        .filter((m): m is Node => !!m && !!m.type && CALLABLE_SYMBOL_TYPES.has(m.type));
      const routeCount = members.filter((m) =>
        idx.neighbors(m.id, 'exposes', 'down').some(keep),
      ).length;
      if (routeCount === 0) {
        controllersWithoutRoutes.push({
          id: n.id,
          ...(n.qualifiedName ? { qualifiedName: n.qualifiedName } : {}),
          ...(n.name ? { name: n.name } : {}),
          ...(n.file ? { file: n.file } : {}),
          memberCount: members.length,
          routeCount: 0,
        });
      }
    }

    // unresolved-injects: a class declares a DI type in `meta.injects` that the resolver never linked
    // to a symbol (no `injects` edge from the class). The dual of unresolved call sites — a missing
    // bean the consumer expects. Built-in/framework types are flagged, not dropped (honesty).
    const unresolvedInjects: Array<Record<string, unknown>> = [];
    for (const n of soul.iterate('symbol')) {
      const injects = n.meta?.injects as string[] | undefined;
      if (!Array.isArray(injects) || injects.length === 0) continue;
      const emitted = new Set(
        idx
          .neighbors(n.id, 'injects', 'down')
          .filter(keep)
          .map((e) => e.dst),
      );
      // a name is resolved iff some emitted injects dst id contains it (the resolver links by type name).
      const missing: string[] = [];
      for (const t of injects) {
        const ok = [...emitted].some((id) => id.toLowerCase().includes(t.toLowerCase()));
        if (!ok) missing.push(t);
      }
      if (missing.length > 0) {
        unresolvedInjects.push({
          id: n.id,
          ...(n.qualifiedName ? { qualifiedName: n.qualifiedName } : {}),
          ...(n.name ? { name: n.name } : {}),
          ...(n.file ? { file: n.file } : {}),
          ...(n.stereotype ? { stereotype: n.stereotype } : {}),
          unresolved: missing,
        });
      }
    }

    return {
      unimplemented,
      packageSpecsWithoutBody,
      unresolvedCallSites,
      controllersWithoutRoutes,
      unresolvedInjects,
      summary: {
        unimplemented: unimplemented.length,
        packageSpecsWithoutBody: packageSpecsWithoutBody.length,
        unresolvedCallSites: unresolvedCallSites.length,
        controllersWithoutRoutes: controllersWithoutRoutes.length,
        unresolvedInjects: unresolvedInjects.length,
        // `incomplete` iff the soul has any body-missing gap — an unimplemented callable or a
        // package spec with no body. The headline the loan-rule-engine feedback wanted: the crib
        // says up front "you cannot trust behavior analysis here — a body is missing".
        analysisReadiness:
          unimplemented.length > 0 || packageSpecsWithoutBody.length > 0
            ? 'incomplete'
            : 'complete',
      },
    };
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
    if (!n) return { id, confidence };
    return {
      id,
      ...(n.name ? { name: n.name } : {}),
      ...(n.qualifiedName ? { qualifiedName: n.qualifiedName } : {}),
      ...(n.signature ? { signature: n.signature } : {}),
      ...(n.type ? { type: n.type } : {}),
      ...(n.file ? { file: n.file } : {}),
      ...(n.span ? { line: n.span.start } : {}),
      confidence,
    };
  }

  /**
   * The public node shape — surfaces EVERY captured field, not just the symbol-header subset. The
   * deep-extraction fields (schema/table/dataType for columns, sqlKind/expr for statements, branch
   * for conditions, heading/anchor for doc-sections, meta.columns for tables, meta.returnType for
   * procs) are what make crib's context low-level rather than high-level. Only present fields are
   * included, so the shape stays honest per node kind.
   */
  private publicNode(n: Node): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: n.id,
      kind: n.kind,
    };
    if (n.type) out.type = n.type;
    if (n.name) out.name = n.name;
    if (n.qualifiedName) out.qualifiedName = n.qualifiedName;
    if (n.signature) out.signature = n.signature;
    if (n.lang) out.lang = n.lang;
    if (n.file) out.file = n.file;
    if (n.span) out.span = n.span;
    if (n.clusterId) out.clusterId = n.clusterId;
    // deep-extraction: SQL / table / column
    if (n.schema) out.schema = n.schema;
    if (n.table) out.table = n.table;
    if (n.dataType) out.dataType = n.dataType;
    if (n.sqlKind) out.sqlKind = n.sqlKind;
    if (n.expr) out.expr = n.expr;
    if (n.branch) out.branch = n.branch;
    // deep-extraction 1.2 (behavior-bearing fidelity) — the fields that make crib's context
    // detailed-level rather than high-level: raises, exception handlers, cursors, assignments,
    // inline column constraints, and the comment span an explanation was derived from.
    if (n.errorCode) out.errorCode = n.errorCode;
    if (n.errorMessage) out.errorMessage = n.errorMessage;
    if (n.whenSelector) out.whenSelector = n.whenSelector;
    if (n.assignTarget) out.assignTarget = n.assignTarget;
    if (n.cursorQuery) out.cursorQuery = n.cursorQuery;
    if (n.exprTruncated) out.exprTruncated = n.exprTruncated;
    if (Array.isArray(n.constraints)) out.constraints = n.constraints;
    if (n.commentRef) out.commentRef = n.commentRef;
    // doc-section
    if (n.heading) out.heading = n.heading;
    if (n.level !== undefined) out.level = n.level;
    if (n.anchor) out.anchor = n.anchor;
    // framework-semantics 1.3 identity — the handler's own route verb/path, the symbol's stereotype +
    // framework. Without these the route section shows the route but hides the handler's own contract
    // (e.g. its @PreAuthorize on the node), breaking the no-round-trip surfacing guarantee.
    if (n.framework) out.framework = n.framework;
    if (n.stereotype) out.stereotype = n.stereotype;
    if (n.httpMethod) out.httpMethod = n.httpMethod;
    if (n.routePath) out.routePath = n.routePath;
    // selective meta — surface the structured deep fields, not arbitrary blobs
    if (n.meta) {
      const m = n.meta as Record<string, unknown>;
      if (Array.isArray(m.columns)) out.columns = m.columns;
      if (m.returnType !== undefined) out.returnType = m.returnType;
      if (Array.isArray(m.tables)) out.tables = m.tables;
      // PL/SQL object type: the full attribute field list (the deep context)
      if (Array.isArray(m.attributes)) out.attributes = m.attributes;
      // PL/SQL collection type: TABLE OF / VARRAY OF element
      if (m.collection !== undefined) out.collection = m.collection;
      // PL/SQL view marker (a table node that is actually a view)
      if (m.kind !== undefined) out.kindMeta = m.kind;
      // self-recursion flag (set when a procedure calls itself; no self-edge is emitted by design)
      if (m.recursive !== undefined) out.recursive = m.recursive;
      // recorded call sites (callee + line) — surfaces recursive + unresolved/builtin calls that
      // have no `calls` edge, so the analyst sees the full call-site inventory, not just resolved edges
      if (Array.isArray(m.calls)) out.callSites = m.calls;
      // framework-semantics 1.3 meta — route params/security, DI injects, @Bean produces, JPA column.
      if (Array.isArray(m.params)) out.params = m.params;
      if (m.security !== undefined) out.security = m.security;
      if (Array.isArray(m.injects)) out.injects = m.injects;
      if (Array.isArray(m.produces)) out.produces = m.produces;
      if (m.column !== undefined) out.column = m.column;
    }
    return out;
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
