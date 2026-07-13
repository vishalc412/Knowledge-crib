import { pathFromId } from '@knowledge-crib/core';
import { LockBusyError, withCribLock } from '@knowledge-crib/core';
import { type AliasMap, loadAliases, rewriteQuery } from '@knowledge-crib/core';
import type { Dir, Dossier, IndexStore, SoulStore } from '@knowledge-crib/core';
import {
  CALLABLE_SYMBOL_TYPES,
  buildDossier,
  buildDossiersByScope,
  buildFunctionalMap,
  buildReconstruction,
  computeCoverage,
  decisionTable,
  dossierToMarkdown,
  expectedBodyFile,
  frameworkSemantics,
  readDossier,
  readLlmOverlay,
  reconstructionToMarkdown,
  writeDossier,
} from '@knowledge-crib/core';
import type { DossiersByScope as DossiersByScopeShape } from '@knowledge-crib/core';
/**
 * The MCP verbs as pure functions over the soul + index. These are the product surface; the stdio
 * server is thin wiring on top. Every edge-bearing result carries {method, provenance, confidence,
 * evidence} so an agent can filter to EXTRACTED-only (`extractedOnly`). Deterministic verbs never
 * touch the network or the enricher.
 */
import type { Edge, Node, NodeKind } from '@knowledge-crib/soul-schema';
import {
  type EnrichNextArgs,
  type EnrichStatusArgs,
  EnrichmentStore,
  llmPointer,
  llmProjection,
} from './enrichment.js';
import {
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_BODY_MAX_LINES,
  type RehydratedBody,
  rehydrate,
  rehydrateBody,
} from './snippet.js';
import {
  DEFAULT_DOC_LIMIT,
  DEFAULT_LIMIT,
  MAX_DEPTH,
  MAX_DOC_LIMIT,
  MAX_HOPS,
  MAX_LIMIT,
  MAX_SCOPE_SYMBOLS,
  MAX_SOURCE_CHARS,
  MAX_SOURCE_LINES,
  bound,
  capInt,
  capMaxTokens,
  clampMax,
  estimateTokens,
  fitTokenBudget,
} from './token-budget.js';

/**
 * Infer the body file a package spec SHOULD live next to, from the spec file path. Covers the common
 * Oracle conventions the migration feedback keys on: `.pks`→`.pkb`, `*_spec.sql`→`*_body.sql`, and a
 * generic `spec`→`body` token swap. Returns `undefined` when the path gives no signal (honesty: we do
 * not fabricate a name we are not confident about). Pure + language-agnostic — works for any repo.
 * Imported from @knowledge-crib/core (WS-6) so the CLI / pipeline / verbs share one implementation.
 */

/**
 * Injected VCS adapter (M6) so `detect_changes` can read the git anchor + changed files without the MCP
 * package depending on the pipeline. The CLI supplies a real adapter; tests inject a stub. Absent ⇒ the
 * verb reports "not configured" rather than guessing.
 */
export interface VcsAdapter {
  currentHead(root: string): string;
  changedFilesSince(root: string, since: string): string[];
  /** Repo-relative paths of staged + unstaged working-tree changes relative to HEAD. */
  uncommittedChanges(root: string): string[];
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

type GapCategory = 'project' | 'tests' | 'fixtures' | 'builtin' | 'external';
type GapCategoryCounts = Record<GapCategory, number>;

const GAP_CATEGORIES: readonly GapCategory[] = [
  'project',
  'tests',
  'fixtures',
  'builtin',
  'external',
];

const BUILTIN_CALLEE_PATTERNS: readonly RegExp[] = [
  /^(DBMS_|UTL_|APEX_|HTP|HTF_|SYS\.|STANDARD\.|DBA_|ALL_|USER_)/i,
  /^(Array|String|Number|Boolean|Object|Promise|JSON|Math|Date|RegExp|Map|Set|WeakMap|WeakSet|Symbol|Reflect|Error|TypeError|console|process|Buffer)\b/i,
  /^(setTimeout|clearTimeout|setInterval|clearInterval|parseInt|parseFloat|isNaN|require)\b/i,
  /^(fs|path|crypto|url|util|events|stream|child_process|os|http|https|assert)\./i,
  /^(print|len|range|enumerate|zip|map|filter|sum|min|max|abs|open|dict|list|set|tuple|str|int|float|bool|super|isinstance|hasattr|getattr|setattr)\b/i,
  /^(os|sys|pathlib|json|re|typing|dataclasses|itertools|functools|collections|subprocess|logging|datetime|math)\./i,
  /^(java|javax|jakarta)\./i,
  /^(System|String|Integer|Long|Double|Boolean|Math|List|Map|Set|Optional|Collections|Arrays|Objects)\./,
  /^(System|Microsoft)\./,
  /^(Console|Enumerable|Task|DateTime|Guid|StringComparer)\./,
  /^(fmt|strings|errors|context|json|http|os|filepath|strconv|sync|time)\./,
  /^(std|core|alloc)::/,
  /^(Option|Result|Vec|String|Box|HashMap|HashSet)::/,
];

const EXTERNAL_CALLEE_PATTERNS: readonly RegExp[] = [
  /^@[\w-]+\//,
  /^(react|react-dom|lodash|axios|express|fastify|zod|vitest|jest|mocha|chai|commander)\b/i,
  /^(org\.springframework|org\.slf4j|com\.fasterxml|com\.google|io\.micrometer)\./i,
];

function initGapCategories(): GapCategoryCounts {
  return { project: 0, tests: 0, fixtures: 0, builtin: 0, external: 0 };
}

function isBuiltinCallee(callee: string): boolean {
  return BUILTIN_CALLEE_PATTERNS.some((p) => p.test(callee));
}

function isExternalCallee(callee: string): boolean {
  return EXTERNAL_CALLEE_PATTERNS.some((p) => p.test(callee));
}

function fileCategory(file?: string): GapCategory {
  if (!file) return 'project';
  if (
    /(^|\/)(__tests__|test|tests|spec)\//i.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file)
  )
    return 'tests';
  if (/(^|\/)(fixtures?|__fixtures__|__probe__)\//i.test(file)) return 'fixtures';
  return 'project';
}

function classifyGap(args: { file?: string; callee?: string }): GapCategory {
  if (args.callee && isBuiltinCallee(args.callee)) return 'builtin';
  if (args.callee && isExternalCallee(args.callee)) return 'external';
  return fileCategory(args.file);
}

function countByFileCategory(rows: Array<Record<string, unknown>>): GapCategoryCounts {
  const counts = initGapCategories();
  for (const row of rows) {
    const file =
      typeof row.file === 'string'
        ? row.file
        : typeof row.callerFile === 'string'
          ? row.callerFile
          : undefined;
    counts[fileCategory(file)]++;
  }
  return counts;
}

function sumGapCategories(parts: GapCategoryCounts[]): GapCategoryCounts {
  const out = initGapCategories();
  for (const part of parts) {
    for (const category of GAP_CATEGORIES) out[category] += part[category];
  }
  return out;
}

export class Verbs {
  private readonly llm: EnrichmentStore;
  /** M2.4 — per-repo alias dictionary loaded once at construction; empty when no file is committed. */
  private readonly aliases: AliasMap;

  constructor(private readonly deps: VerbDeps) {
    this.llm = new EnrichmentStore(deps.soul, deps.repoRoot);
    this.aliases = loadAliases(deps.soul.cribDir);
  }

  status(opts?: { dirty?: boolean }): Record<string, unknown> {
    const m = this.deps.soul.getManifest();
    const hasLlmGraph = this.llm.hasAnyFresh();
    const result: Record<string, unknown> = {
      indexed: m.stats.nodes > 0,
      schemaVersion: m.schemaVersion,
      stats: { nodes: m.stats.nodes, edges: m.stats.edges, clusters: m.stats.clusters },
      ...(m.repo.vcsHead ? { vcsHead: m.repo.vcsHead } : {}),
      ...(m.stats.incrementalSince ? { incrementalSince: m.stats.incrementalSince } : {}),
      capabilities: { ...m.capabilities, ...this.deps.index.capabilities(), llmGraph: hasLlmGraph },
    };
    if (this.deps.vcs) {
      try {
        const head = this.deps.vcs.currentHead(this.deps.repoRoot);
        const dirtyFiles = this.deps.vcs.uncommittedChanges(this.deps.repoRoot);
        result.currentHead = head;
        result.dirty = {
          isDirty: dirtyFiles.length > 0,
          uncommitted: dirtyFiles,
          aheadOfVcsHead: Boolean(m.repo.vcsHead && m.repo.vcsHead !== head),
        };
        if (opts?.dirty) {
          const since = m.stats.incrementalSince ?? m.repo.vcsHead;
          const changed = new Set<string>();
          if (since) {
            for (const p of this.deps.vcs.changedFilesSince(this.deps.repoRoot, since))
              changed.add(p);
          }
          for (const p of dirtyFiles) changed.add(p);
          const scope = new Set(changed);
          for (const edge of this.deps.soul.iterateEdges()) {
            const d = pathFromId(edge.dst);
            if (d !== undefined && changed.has(d)) {
              const s = pathFromId(edge.src);
              if (s !== undefined) scope.add(s);
            }
          }
          result.dirtyPreview = {
            wouldUpdate: [...changed].sort(),
            wouldScope: [...scope].sort(),
            head,
          };
        }
      } catch {
        // VCS read is best-effort; never mask deterministic status.
      }
    }
    return result;
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
    /** fold in saved LLM-authored semantic graph analysis; default-on when present. */
    withLlm?: boolean;
    /** char cap for the rehydrated source body (default {@link DEFAULT_BODY_MAX_CHARS}) */
    sourceMaxChars?: number;
    /** line cap for the rehydrated source body (default {@link DEFAULT_BODY_MAX_LINES}) */
    sourceMaxLines?: number;
    /** absolute file line to start the source page at (paging cursor; default = span start) */
    sourceStartLine?: number;
    /** response-wide token budget (chars/4). When set with `withSource`, the source body is shrunk
     *  to fit the remaining budget and `budgetExhausted:true` is set; page via `source.nextLine`.
     *  (M1.2) */
    maxTokens?: number;
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const id = this.resolveNodeId(args.id);
    if (!id) return notFound(args.id);
    const node = soul.getNode(id);
    if (!node) return notFound(args.id);
    const callers = this.callEdges(id, 'up', args.extractedOnly).map((e) =>
      this.brief(e.src, e.confidence),
    );
    const callees = this.callEdges(id, 'down', args.extractedOnly).map((e) =>
      this.brief(e.dst, e.confidence),
    );
    const docs = bound(
      this.docsFor(id, 0, args.extractedOnly),
      capInt(args.docLimit, DEFAULT_DOC_LIMIT, MAX_DOC_LIMIT),
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
      result.rules = decisionTable(soul, id, { includeTables: true });
      // coverage gates the rules: an `unimplemented`/`partial` readiness tells the consumer the
      // decision table may be empty or lossy because the body is missing or expressions were clipped.
      result.coverage = computeCoverage(soul, id, {
        keep: (e) => !args.extractedOnly || e.provenance === 'EXTRACTED',
      });
    }
    if (args.withFramework) {
      // frameworkSemantics is pure over the soul (one iterateEdges scan, cached adjacency); auto-scopes
      // by node. Undefined when the node has no framework edges (a non-Spring method) → key omitted.
      const fw = frameworkSemantics(soul, id, {
        keep: (e) => !args.extractedOnly || e.provenance === 'EXTRACTED',
      });
      if (fw) result.framework = fw;
    }
    this.attachLlm(result, id, args.withLlm);
    // M1.2 response-wide token budget (opt-in). When set with `withSource`, guarantee the serialized
    // response fits `maxTokens` (chars/4). The source body is the variable part; the node + callers +
    // callees + docs + llm skeleton is counted once and the source is shrunk to the remaining budget.
    // `budgetExhausted` signals the body was cut; the body's existing `nextLine` cursor pages it.
    if (args.maxTokens !== undefined && args.withSource && result.source !== undefined) {
      const maxTokens = capMaxTokens(args.maxTokens);
      const { source: _drop, ...withoutSource } = result;
      const tokensWithout = estimateTokens(withoutSource);
      const remaining = maxTokens - tokensWithout;
      result.budgetExhausted = false;
      if (remaining < 1) {
        // skeleton alone overflows: drop the body, keep the budgetExhausted signal so a tighter-
        // budgeted retry can page it via the body's own span-start cursor.
        result.source = undefined;
        result.budgetExhausted = true;
      } else {
        // The char budget bounds `source.text`, but the source OBJECT carries JSON overhead
        // (totalLines/startLine/nextLine/truncated) the char budget does not count. Re-estimate the
        // full response after the first shrink and halve the char budget until it fits (bounded loop
        // — chars/4 is monotonic, so this converges in a few steps).
        let charBudget = Math.max(1, remaining * 4);
        let shrunk = this.bodyOf(node, { ...args, sourceMaxChars: charBudget });
        let guard = 0;
        while (
          estimateTokens({ ...result, source: shrunk }) > maxTokens &&
          charBudget > 1 &&
          guard++ < 8
        ) {
          charBudget = Math.max(1, Math.floor(charBudget / 2));
          shrunk = this.bodyOf(node, { ...args, sourceMaxChars: charBudget });
        }
        if (estimateTokens({ ...result, source: shrunk }) > maxTokens) {
          // even a 1-char body overflows (budget sits below skeleton + the source-object's irreducible
          // JSON wrapper) — drop the body so the response still honors the budget; budgetExhausted
          // signals a tighter-budgeted retry can page it via the body's span-start cursor.
          result.source = undefined;
          result.budgetExhausted = true;
        } else {
          result.source = shrunk;
          result.budgetExhausted = guard > 0 || shrunk.truncated;
        }
      }
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
    const id = this.resolveNodeId(args.id);
    if (!id) return notFound(args.id);
    const node = this.deps.soul.getNode(id);
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
   * artifact under `.crib/dossiers/` when it is fresh. Full and incremental indexing refresh
   * graph-dependent dossier content; the read gate also checks node hash, schema, and shape version.
   * Otherwise it is rebuilt and re-persisted. A paged request (sourceStartLine / sourceMaxLines
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
    /** fold in saved LLM-authored semantic graph analysis; default-on when present. */
    withLlm?: boolean;
    format?: 'json' | 'markdown';
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const id = this.resolveNodeId(args.id);
    if (!id) return notFound(args.id);
    const node = soul.getNode(id);
    if (!node) return notFound(args.id);
    const manifest = soul.getManifest();
    const paged =
      args.sourceMaxChars !== undefined ||
      args.sourceMaxLines !== undefined ||
      args.sourceStartLine !== undefined;
    const buildOpts = {
      ...(args.includeTables ? { includeTables: true } : {}),
      ...(args.extractedOnly ? { extractedOnly: true } : {}),
      ...(args.sourceMaxChars !== undefined
        ? { sourceMaxChars: clampMax(args.sourceMaxChars, MAX_SOURCE_CHARS) }
        : {}),
      ...(args.sourceMaxLines !== undefined
        ? { sourceMaxLines: clampMax(args.sourceMaxLines, MAX_SOURCE_LINES) }
        : {}),
      ...(args.sourceStartLine !== undefined ? { sourceStartLine: args.sourceStartLine } : {}),
    };

    let dossier: Dossier | undefined;
    if (!paged) {
      // default-shape: prefer the persisted artifact when fresh, else build + persist.
      // Cache is keyed by the canonical id, so a request by qualified/simple name and one by full
      // id share one dossier file (no duplicate artifacts).
      const read = readDossier(soul.cribDir, id, {
        nodeHash: node.hash,
        schemaVersion: manifest.schemaVersion,
      });
      if (!read.missing && !read.stale && read.dossier) {
        dossier = read.dossier;
      } else {
        dossier = buildDossier(soul, this.deps.repoRoot, id, manifest.stats.lastUpdated, buildOpts);
        if (dossier) writeDossier(soul.cribDir, dossier);
      }
    } else {
      // paged view: always rebuild (the cache holds the default page only).
      dossier = buildDossier(soul, this.deps.repoRoot, id, manifest.stats.lastUpdated, buildOpts);
    }
    if (!dossier) return notFound(args.id);
    if (args.format === 'markdown') {
      return { id, markdown: dossierToMarkdown(dossier) };
    }
    const result = dossier as unknown as Record<string, unknown>;
    this.attachLlm(result, id, args.withLlm);
    return result;
  }

  /**
   * `reconstruct` — the package-scoped migration-reconstruction view: CONSTANT values (the 30/80
   * thresholds), every member callable with its implementation status, the union of tables the
   * package reads/writes, docs linked to the package or its members, and the expected body file.
   * The artifact an agent hands a migrator in one call instead of orchestrating `context` over every
   * member + `gaps` + `extract_rules`. Backed by the pure core {@link buildReconstruction} (same code
   * path the pipeline could use to persist it). Returns NOT_FOUND for an unknown id OR a non-package
   * node (reconstruct is package-scoped; use `dossier`/`context` for a single callable). Accepts the
   * full id OR a qualified/simple name (parity with the other node verbs).
   */
  reconstruct(args: {
    id: string;
    extractedOnly?: boolean;
    /** include the referenced-tables section (default true) */
    includeTables?: boolean;
    /** cap on the number of member entries (default 1000; `truncated` flags a cap) */
    maxSymbols?: number;
    format?: 'json' | 'markdown';
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const id = this.resolveNodeId(args.id);
    if (!id) return notFound(args.id);
    const manifest = soul.getManifest();
    const reconstruction = buildReconstruction(
      soul,
      this.deps.repoRoot,
      id,
      manifest.stats.lastUpdated,
      {
        ...(args.extractedOnly ? { extractedOnly: true } : {}),
        ...(args.includeTables !== undefined ? { includeTables: args.includeTables } : {}),
        ...(args.maxSymbols !== undefined
          ? { maxSymbols: clampMax(args.maxSymbols, MAX_SCOPE_SYMBOLS) }
          : {}),
      },
    );
    if (!reconstruction) return notFound(args.id);
    if (args.format === 'markdown') {
      return { id, markdown: reconstructionToMarkdown(reconstruction) };
    }
    return reconstruction as unknown as Record<string, unknown>;
  }

  /**
   * `dossierByScope` — bulk per-symbol dossiers for EVERY symbol in a scope (a package's members, a
   * file's symbols, or a cluster's symbols), built in ONE call. The analyst flow: instead of
   * orchestrating `dossier` over each of ~50 package members (50 round-trips), one call returns the
   * deep reusable context for all of them — constants-aware node, rehydrated body, callers/callees,
   * decision table, implementation status, linked docs — so a migration plan built from crib (Plan A)
   * sees the same per-symbol detail a full code read (Plan B) sees. Backed by the pure core
   * {@link buildDossiersByScope} (the 1-scan-adjacency path: `iterateEdges()` is walked ONCE for the
   * whole scope, then every per-symbol {@link buildDossier} reuses it). Returns NOT_FOUND when the
   * scope node cannot be resolved. Honesty flags: `symbolCount` (total resolved) + `truncated` (capped
   * at `maxSymbols`) + `skipped` (symbol ids that resolved to no dossier). `format:'markdown'`
   * concatenates {@link dossierToMarkdown} per symbol under a scope banner.
   */
  dossierByScope(args: {
    /** the scope kind: 'package' (the package's member symbols), 'file' (a file's symbols), or
     *  'cluster' (a cluster's symbols). */
    scope: 'package' | 'file' | 'cluster';
    /** the scope node id, OR — for a package — the qualified/simple name (parity with the other node
     *  verbs); for a file, the path (with or without the `file:` prefix); for a cluster, the slug. */
    id: string;
    extractedOnly?: boolean;
    /** resolve reads/writes table names in each callable's decision table (extra lookups). */
    includeTables?: boolean;
    /** cap on the number of per-symbol dossiers returned (default 1000; `truncated` flags a cap). */
    maxSymbols?: number;
    sourceMaxChars?: number;
    sourceMaxLines?: number;
    format?: 'json' | 'markdown';
    /** resume cursor (a prior response's `cursor`) — skip the first N resolved symbols. Decoupled
     *  from `maxTokens` (paging works without a budget), but a cursor is only RETURNED when `maxTokens`
     *  is set (the opt-in budget path). (M1.2) */
    cursor?: string;
    /** response-wide token budget (chars/4). When set, the dossiers list is trimmed to the largest
     *  leading prefix that fits and `budgetExhausted:true` + a `cursor` resume point are returned.
     *  (M1.2) */
    maxTokens?: number;
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    // package: use the standard qname resolver for parity with `dossier`/`context`; file/cluster: pass
    // the raw id (buildDossiersByScope handles the file:/c: prefix + path/slug resolution itself).
    const resolved = args.scope === 'package' ? (this.resolveNodeId(args.id) ?? args.id) : args.id;
    const manifest = soul.getManifest();
    const offset = Math.max(0, Number.parseInt(args.cursor ?? '', 10) || 0);
    const result = buildDossiersByScope(
      soul,
      this.deps.repoRoot,
      args.scope,
      resolved,
      manifest.stats.lastUpdated,
      {
        ...(args.extractedOnly ? { extractedOnly: true } : {}),
        ...(args.includeTables ? { includeTables: true } : {}),
        ...(args.maxSymbols !== undefined
          ? { maxSymbols: clampMax(args.maxSymbols, MAX_SCOPE_SYMBOLS) }
          : {}),
        ...(args.sourceMaxChars !== undefined
          ? { sourceMaxChars: clampMax(args.sourceMaxChars, MAX_SOURCE_CHARS) }
          : {}),
        ...(args.sourceMaxLines !== undefined
          ? { sourceMaxLines: clampMax(args.sourceMaxLines, MAX_SOURCE_LINES) }
          : {}),
        offset,
      },
    );
    if (!result) return notFound(args.id);
    if (args.format === 'markdown') {
      return { id: result.id, markdown: dossiersByScopeToMarkdown(result) };
    }
    // M1.2 response-wide token budget (opt-in). Fit the per-symbol dossiers to the largest leading
    // prefix whose serialized response fits (chars/4). The scope metadata + symbolCount + truncated
    // + skipped are fixed; symbols is the variable. `truncated` (core cap/offset) is unchanged;
    // `budgetExhausted` is the new token-cut signal; `cursor` resumes at the next dossier.
    if (args.maxTokens === undefined) {
      return result as unknown as Record<string, unknown>;
    }
    const maxTokens = capMaxTokens(args.maxTokens);
    const symbols = result.symbols;
    const fitted = fitTokenBudget(symbols, maxTokens, (prefix) =>
      JSON.stringify({
        ...result,
        symbols: prefix,
        budgetExhausted: true,
        cursor: String(offset + prefix.length),
      }),
    );
    const out = { ...result, symbols: fitted.items } as unknown as Record<string, unknown>;
    const more = fitted.budgetExhausted || result.truncated;
    // when maxTokens is opted in, always report budgetExhausted (true/false); cursor only when more.
    out.budgetExhausted = fitted.budgetExhausted;
    if (more) out.cursor = String(offset + fitted.items.length);
    return out;
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
      maxChars: capInt(
        args.sourceMaxChars ?? args.maxChars,
        DEFAULT_BODY_MAX_CHARS,
        MAX_SOURCE_CHARS,
      ),
      maxLines: capInt(
        args.sourceMaxLines ?? args.maxLines,
        DEFAULT_BODY_MAX_LINES,
        MAX_SOURCE_LINES,
      ),
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
    const id = this.resolveNodeId(args.id);
    if (!id || !this.deps.soul.getNode(id)) return notFound(args.id);
    const depth = capInt(args.depth, 2, MAX_DEPTH);
    const visited = new Set<string>([id]);
    const affected: Array<{
      id: string;
      rel: string;
      distance: number;
      risk: string;
      docs: DocLink[];
    }> = [];
    let frontier = [id];
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
            docs: bound(
              this.docsFor(nb, 0, args.extractedOnly),
              capInt(args.docLimit, DEFAULT_DOC_LIMIT, MAX_DOC_LIMIT),
            ).items,
          });
        }
      }
      frontier = next;
    }
    const page = bound(affected, capInt(args.limit, DEFAULT_LIMIT, MAX_LIMIT));
    return {
      root: id,
      dir: args.dir,
      affected: page.items,
      relatedDocs: this.docsFor(id, 0, args.extractedOnly),
      truncated: page.truncated,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  /**
   * `query` — free-text search over names/signatures/headings/files AND rehydrated body text (FTS5
   * BM25, WS-1). By default returns one-line snippets (the discovery view). With `withSource` /
   * `withRules` / `withFramework` it folds the deep per-symbol context into EACH hit — so a single
   * `crib query "DTI" --with-source --with-rules` returns the symbol, its body, and its decision
   * table, matching what a full file read surfaces (closes the Plan-A-vs-Plan-B discovery gap).
   *
   * Cost: when `withRules`/`withFramework` is set, outgoing+incoming adjacency is built ONCE from a
   * single soul edge scan and reused across all hits (decisionTable / computeCoverage /
   * frameworkSemantics all accept prebuilt adjacency), so N hits cost 1 scan + N×O(degree) — never
   * N full edge scans. `withRules`/`withFramework` apply only to callable/symbol hits; non-callable
   * hits (tables/columns/statements) still return their snippet + (optional) source body.
   */
  query(args: {
    q: string;
    kinds?: NodeKind[];
    limit?: number;
    /** restrict rules/framework edges to EXTRACTED provenance (parity with `context`). */
    extractedOnly?: boolean;
    /** include the full rehydrated source body per hit (budgeted; see sourceMaxChars/Lines). */
    withSource?: boolean;
    /** char cap for each hit's rehydrated source body (default {@link DEFAULT_BODY_MAX_CHARS}). */
    sourceMaxChars?: number;
    /** line cap for each hit's rehydrated source body (default {@link DEFAULT_BODY_MAX_LINES}). */
    sourceMaxLines?: number;
    /** for a callable hit, fold in its decision table + coverage readiness. */
    withRules?: boolean;
    /** fold in framework-semantics (routes/beans/DI/relations) per hit, when present. */
    withFramework?: boolean;
    /** include saved LLM semantic analysis on hits and search LLM analysis text too. */
    withLlm?: boolean;
    /** resume cursor (a prior response's `cursor`) — skip the first N BM25-ranked hits (FTS5 OFFSET).
     *  Decoupled from `maxTokens`: paging works without a budget, but a cursor is only RETURNED when
     *  `maxTokens` is set (the opt-in budget path). (M1.2) */
    cursor?: string;
    /** response-wide token budget (chars/4). When set, the hits list is trimmed to the largest
     *  leading prefix that fits and `budgetExhausted:true` + a `cursor` resume point are returned.
     *  (M1.2) */
    maxTokens?: number;
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const limit = capInt(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    // cursor → offset into the BM25-ranked set (FTS5 OFFSET). Floor at 0; non-numeric → 0.
    const offset = Math.max(0, Number.parseInt(args.cursor ?? '', 10) || 0);
    // M2.4 — rewrite the query with the per-repo alias dictionary before it reaches the index.
    // Empty dict (the common case) is a pure no-op, so queries without aliases are byte-identical.
    const q = rewriteQuery(args.q, this.aliases);
    // Over-fetch by one to detect whether the BM25 result set was capped (honest `truncated` flag)
    // without an extra count query; we slice back to `limit` after the overflow check.
    const rawHits = this.deps.index.query({
      text: q,
      ...(args.kinds ? { kinds: args.kinds } : {}),
      limit: limit + 1,
      offset,
    });
    const bm25Truncated = rawHits.length > limit;
    const hits0 = bm25Truncated ? rawHits.slice(0, limit) : rawHits;

    // Build outgoing + incoming adjacency ONCE when rules/framework are requested, so per-hit
    // decisionTable / computeCoverage / frameworkSemantics reuse it instead of re-scanning edges.
    const needEdges = args.withRules || args.withFramework;
    let outgoing: Map<string, Edge[]> | undefined;
    let incoming: Map<string, Edge[]> | undefined;
    if (needEdges) {
      outgoing = new Map<string, Edge[]>();
      incoming = new Map<string, Edge[]>();
      for (const e of soul.iterateEdges()) {
        const o = outgoing.get(e.src);
        if (o) o.push(e);
        else outgoing.set(e.src, [e]);
        const i = incoming.get(e.dst);
        if (i) i.push(e);
        else incoming.set(e.dst, [e]);
      }
    }
    const keep = (e: Edge) => !args.extractedOnly || e.provenance === 'EXTRACTED';

    const bm25Ids = new Set(hits0.map((h) => h.id));
    const hits = hits0.map((h) => {
      const node = soul.getNode(h.id);
      const hit: Record<string, unknown> = {
        id: h.id,
        kind: h.kind,
        score: h.score,
        snippet: rehydrate(this.deps.repoRoot, node),
        ...(node?.clusterId ? { clusterId: node.clusterId } : {}),
      };
      if (args.withSource && node) {
        // the paged/body view; `truncated` tells the consumer to page via `source.nextLine` if needed.
        hit.source = this.bodyOf(node, args);
      }
      if (args.withRules && node?.type && CALLABLE_SYMBOL_TYPES.has(node.type)) {
        hit.rules = decisionTable(soul, h.id, { includeTables: true, out: outgoing });
        // coverage gates the rules: an `unimplemented`/`partial` readiness says the decision table may
        // be empty/lossy because the body is missing or expressions were clipped — never present
        // an empty rules array as if the callable had no logic.
        hit.coverage = computeCoverage(soul, h.id, { keep, outgoing, incoming });
      }
      if (args.withFramework) {
        const fw = frameworkSemantics(soul, h.id, { keep, outgoing, incoming });
        if (fw) hit.framework = fw;
      }
      // Lightweight LLM pointer by default; full analysis/graph/evidence only when withLlm===true;
      // never attach when withLlm===false. This keeps the default discovery view cheap.
      this.attachLlm(hit, h.id, args.withLlm);
      return hit;
    });

    // Semantic discoveries from the LLM graph layer that BM25 did NOT surface — ranked by term-overlap
    // (see EnrichmentStore.matchText) and de-duplicated against the BM25 hit set. These live in their
    // own `llmHits` field so they never drown out BM25 ranking (the old `unshift`-at-score-0 path put
    // a test helper that merely mentioned a query term above the real `sqlite-index.ts` for "sqlite").
    const seen = new Set(bm25Ids);
    const llmArtifacts = args.withLlm === false ? [] : this.llm.matchText(args.q, limit + 1);
    const llmTruncated = llmArtifacts.length > limit;
    const llmHits: Array<Record<string, unknown>> = [];
    for (const artifact of llmArtifacts.slice(0, limit)) {
      if (seen.has(artifact.targetId)) continue;
      seen.add(artifact.targetId);
      const node = soul.getNode(artifact.targetId);
      const read = { artifact, missing: false, stale: false };
      const proj = args.withLlm === true ? llmProjection(read) : llmPointer(read);
      if (!proj) continue;
      llmHits.push({
        id: artifact.targetId,
        kind: node?.kind ?? 'symbol',
        snippet: node ? rehydrate(this.deps.repoRoot, node) : '',
        llm: proj,
      });
    }

    const baseTruncated = bm25Truncated || llmTruncated;
    // M1.2 response-wide token budget (opt-in). When maxTokens is set, fit the hits list to the
    // largest leading prefix whose serialized response fits (chars/4); llmHits + the fixed
    // `truncated` flag are counted in the estimate. The non-maxTokens path is byte-identical to
    // before (no cursor / no budgetExhausted) so existing callers + tests are unchanged.
    if (args.maxTokens === undefined) {
      return { hits, llmHits, truncated: baseTruncated };
    }
    const maxTokens = capMaxTokens(args.maxTokens);
    const fitted = fitTokenBudget(hits, maxTokens, (prefix) =>
      JSON.stringify({
        hits: prefix,
        llmHits,
        truncated: baseTruncated,
        budgetExhausted: true,
        cursor: String(offset + prefix.length),
      }),
    );
    const more = fitted.budgetExhausted || bm25Truncated;
    return {
      hits: fitted.items,
      llmHits,
      truncated: baseTruncated,
      // when maxTokens is opted in, always report budgetExhausted (true/false); cursor only when more.
      budgetExhausted: fitted.budgetExhausted,
      ...(more ? { cursor: String(offset + fitted.items.length) } : {}),
    };
  }

  /**
   * `ask` — natural-language question answered from the crib deterministically.
   *
   * No live LLM is invoked. The verb classifies the question, retrieves the most relevant
   * symbol/file/cluster context, and returns either a structured object or a Markdown answer
   * assembled from the retrieved facts. This makes `crib ask` useful in headless/MCP settings
   * while keeping the Knowledge-crib server model-free.
   */
  ask(args: {
    q: string;
    limit?: number;
    format?: 'json' | 'markdown';
    withSource?: boolean;
    withRules?: boolean;
    withFramework?: boolean;
    extractedOnly?: boolean;
  }): Record<string, unknown> {
    const q = args.q.trim();
    if (!q) {
      return { error: { code: 'BAD_ARGS', message: 'question must be non-empty' } };
    }

    // 1. Direct-node question: the query itself resolves to a known node id/name.
    const resolvedId = this.resolveNodeId(q);
    if (resolvedId) {
      const ctx = this.context({
        id: resolvedId,
        ...(args.withSource ? { withSource: true } : {}),
        ...(args.withRules ? { withRules: true } : {}),
        ...(args.withFramework ? { withFramework: true } : {}),
        ...(args.extractedOnly ? { extractedOnly: true } : {}),
      });
      const result = {
        question: q,
        interpretation: 'explain',
        nodeId: resolvedId,
        context: ctx,
      };
      if (args.format === 'markdown') {
        return { ...result, markdown: askToMarkdown(result) };
      }
      return result;
    }

    // 2. Overview/architecture question: serve the system bible when enriched, else a cluster summary.
    if (isOverviewQuestion(q)) {
      const overview = this.overview();
      const hasAnalyses = Array.isArray(overview.analyses) && overview.analyses.length > 0;
      const result = {
        question: q,
        interpretation: 'overview',
        overview,
        ...(hasAnalyses ? {} : { fallback: this.clusterSummary() }),
      };
      if (args.format === 'markdown') {
        return { ...result, markdown: askToMarkdown(result) };
      }
      return result;
    }

    // 3. Discovery question: search the index and gather deep context per hit.
    // M2.4 — rewrite the discovery query with the alias dict (no-op when empty); `q` (original) is
    // still used above for node-id resolution + overview detection and echoed as the question.
    const hits = this.deps.index.query({
      text: rewriteQuery(q, this.aliases),
      limit: capInt(args.limit, DEFAULT_LIMIT, MAX_LIMIT),
    });
    const needEdges = args.withRules || args.withFramework;
    let outgoing: Map<string, Edge[]> | undefined;
    let incoming: Map<string, Edge[]> | undefined;
    if (needEdges) {
      outgoing = new Map<string, Edge[]>();
      incoming = new Map<string, Edge[]>();
      for (const e of this.deps.soul.iterateEdges()) {
        const o = outgoing.get(e.src);
        if (o) o.push(e);
        else outgoing.set(e.src, [e]);
        const i = incoming.get(e.dst);
        if (i) i.push(e);
        else incoming.set(e.dst, [e]);
      }
    }
    const keep = (e: Edge) => !args.extractedOnly || e.provenance === 'EXTRACTED';

    const enriched = hits.map((h) => {
      const node = this.deps.soul.getNode(h.id);
      const hit: Record<string, unknown> = {
        id: h.id,
        kind: h.kind,
        score: h.score,
        snippet: rehydrate(this.deps.repoRoot, node),
        ...(node?.clusterId ? { clusterId: node.clusterId } : {}),
      };
      if (args.withSource && node) {
        hit.source = this.bodyOf(node, {});
      }
      if (args.withRules && node?.type && CALLABLE_SYMBOL_TYPES.has(node.type)) {
        hit.rules = decisionTable(this.deps.soul, h.id, { includeTables: true, out: outgoing });
        hit.coverage = computeCoverage(this.deps.soul, h.id, { keep, outgoing, incoming });
      }
      if (args.withFramework) {
        const fw = frameworkSemantics(this.deps.soul, h.id, { keep, outgoing, incoming });
        if (fw) hit.framework = fw;
      }
      this.attachLlm(hit, h.id);
      return hit;
    });

    // Also surface saved LLM analyses whose text matches the question. Lightweight pointers only —
    // `ask` is the deterministic discovery path and never folds the full analysis/graph blob.
    const existing = new Set(enriched.map((h) => String(h.id)));
    const limit = capInt(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const llmArtifacts = this.llm.matchText(q, limit + 1);
    const llmTruncated = llmArtifacts.length > limit;
    const llmHits: Array<Record<string, unknown>> = [];
    for (const artifact of llmArtifacts.slice(0, limit)) {
      if (existing.has(artifact.targetId)) continue;
      const node = this.deps.soul.getNode(artifact.targetId);
      const proj = llmPointer({ artifact, missing: false, stale: false });
      if (!proj) continue;
      llmHits.push({
        id: artifact.targetId,
        kind: node?.kind ?? 'symbol',
        snippet: node ? rehydrate(this.deps.repoRoot, node) : '',
        llm: proj,
      });
      existing.add(artifact.targetId);
    }

    const result = {
      question: q,
      interpretation: 'discovery',
      hits: enriched,
      llmHits,
      truncated: llmTruncated,
    };
    if (args.format === 'markdown') {
      return { ...result, markdown: askToMarkdown(result) };
    }
    return result;
  }

  /** Summarize the soul for overview questions when no LLM system bible exists — a thin wrapper
   *  over `buildFunctionalMap` (the same module-segmented view the overview verb serves). Keeps a
   *  `clusters` list (label-fixed, LLM name preferred) for back-compat with callers that read
   *  `fallback.clusters`, plus the `modules` array that is the real functional segregation. */
  private clusterSummary(): Record<string, unknown> {
    const soul = this.deps.soul;
    const map = buildFunctionalMap(soul);
    const overlay = readLlmOverlay(soul);
    const clusters = [...soul.iterate('cluster')]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        label: overlay.entries.get(c.id)?.name ?? c.label ?? c.id,
        memberCount: c.members?.length ?? 0,
      }));
    const modules = map.modules.map((m) => ({
      id: m.id,
      name: m.name,
      pathPrefix: m.pathPrefix,
      ...(m.purpose ? { purpose: m.purpose.text } : {}),
      counts: m.counts,
      coverage: m.coverage,
    }));
    return { clusters, modules };
  }

  enrichStatus(args: EnrichStatusArgs = {}): Record<string, unknown> {
    return this.llm.status(args) as unknown as Record<string, unknown>;
  }

  enrichNext(args: EnrichNextArgs = {}): Record<string, unknown> {
    return this.llm.next(args) as unknown as Record<string, unknown>;
  }

  enrichSave(args: {
    batchId: string;
    items: Array<{
      targetId: string;
      model?: string;
      analysis: Record<string, unknown>;
      graph: {
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
      };
      evidence: Array<Record<string, unknown>>;
    }>;
  }): Record<string, unknown> {
    // Serializes writers: an enrich_save landing while `crib index`/`update` runs would race the
    // .crib/llm files against the soul rebuild. Hold the cross-process crib lock around the save.
    // On a busy crib, return a structured busy result (deterministic verbs never throw).
    const cribDir = this.deps.soul.cribDir;
    try {
      return withCribLock(
        { cribDir },
        () => this.llm.save(args as never) as unknown as Record<string, unknown>,
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        return { error: 'crib_busy', message: error.message, holderPid: error.holderPid };
      }
      throw error;
    }
  }

  /**
   * `audit_llm` (M1.3 — the moat): re-verify every persisted LLM artifact on disk against the current
   * soul. Re-runs the grounding check (rehydrate each evidence quote's anchor span, require overlap)
   * so a post-refactor re-verify is identical to the original save-time verdict. PURE — never calls a
   * model, never mutates artifacts. Returns per-target verdicts + drift + staleness.
   */
  auditLlm(): Record<string, unknown> {
    return this.llm.auditLlm() as unknown as Record<string, unknown>;
  }

  overview(
    args: { scope?: { pathPrefix?: string; cluster?: string }; withLlm?: boolean } = {},
  ): Record<string, unknown> {
    return this.llm.overview(args) as unknown as Record<string, unknown>;
  }

  llmNeighbors(args: { id: string }): Record<string, unknown> {
    const id = this.resolveNodeId(args.id) ?? args.id;
    return this.llm.neighbors(id);
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
    const id = this.resolveNodeId(args.id);
    if (!id || !this.deps.soul.getNode(id)) return notFound(args.id);
    const edges = this.adjacency(id, apiDir(args.dir), args.extractedOnly).filter(
      (e) => !args.rel || e.rel === args.rel,
    );
    const page = bound(edges.map(publicEdge), capInt(args.limit, 50, MAX_LIMIT));
    return {
      edges: page.items,
      truncated: page.truncated,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  shortestPath(args: { from: string; to: string; maxHops?: number }): Record<string, unknown> {
    // resolve qualified/simple names on both endpoints (parity with the other node verbs); fall
    // back to the raw input so index.shortestPath reports a clean not-found instead of throwing.
    const from = this.resolveNodeId(args.from) ?? args.from;
    const to = this.resolveNodeId(args.to) ?? args.to;
    const r = this.deps.index.shortestPath(from, to, capInt(args.maxHops, 6, MAX_HOPS));
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
  gaps(args: { extractedOnly?: boolean; includeBuiltins?: boolean } = {}): Record<string, unknown> {
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

    // Unresolved call sites: callee simple-name matches no symbol. Builtins/external APIs are counted
    // in summary.byCategory, and are shown only when explicitly requested so project gaps stay legible.
    const nameIndex = new Set<string>();
    for (const c of callables) {
      if (c.name) nameIndex.add(c.name.toLowerCase());
      if (c.qualifiedName) {
        nameIndex.add(c.qualifiedName.toLowerCase());
        nameIndex.add((c.qualifiedName.split('.').pop() ?? '').toLowerCase());
      }
    }
    const unresolvedCallSites: Array<Record<string, unknown>> = [];
    const unresolvedByCategory = initGapCategories();
    for (const c of callables) {
      const sites = c.meta?.calls as Array<{ callee: string; line: number }> | undefined;
      if (!Array.isArray(sites)) continue;
      for (const s of sites) {
        const simple = (s.callee.split('.').pop() ?? s.callee).toLowerCase();
        if (nameIndex.has(simple)) continue;
        const category = classifyGap({ file: c.file, callee: s.callee });
        unresolvedByCategory[category]++;
        if ((category === 'builtin' || category === 'external') && !args.includeBuiltins) {
          continue;
        }
        unresolvedCallSites.push({
          caller: c.id,
          ...(c.qualifiedName ? { callerName: c.qualifiedName } : {}),
          ...(c.file ? { callerFile: c.file } : {}),
          callee: s.callee,
          line: s.line,
          builtin: category === 'builtin',
          category,
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

    const byCategory = sumGapCategories([
      countByFileCategory(unimplemented),
      countByFileCategory(packageSpecsWithoutBody),
      unresolvedByCategory,
      countByFileCategory(controllersWithoutRoutes),
      countByFileCategory(unresolvedInjects),
    ]);

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
        byCategory,
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

  /**
   * Resolve an id-or-name to a canonical node id, so every node-targeted verb accepts either the
   * full node id (`sym:...@L105`) OR a qualified/simple name (`PKG_LOAN_RULE_ENGINE.EVAL_DTI_RATIO`
   * / `EVAL_DTI_RATIO`) — the same convenience `extract_rules`/`findProcedure` already offer. Order:
   * exact id, then qualified name (case-insensitive), then simple name (case-insensitive, first
   * match). Returns undefined when nothing matches so the caller can emit NOT_FOUND with the
   * ORIGINAL input (not the resolved id). Pure over the soul; one-or-two iterate() passes only when
   * the input is not already an exact id.
   */
  private resolveNodeId(idOrName: string): string | undefined {
    const soul = this.deps.soul;
    if (soul.getNode(idOrName)) return idOrName;
    const needle = idOrName.toLowerCase();
    for (const n of soul.iterate()) {
      if (n.qualifiedName?.toLowerCase() === needle) return n.id;
    }
    for (const n of soul.iterate()) {
      if (n.name?.toLowerCase() === needle) return n.id;
    }
    return undefined;
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

  private attachLlm(result: Record<string, unknown>, targetId: string, withLlm?: boolean): void {
    if (withLlm === false) return;
    // Default (withLlm undefined): fold the LIGHTWEIGHT pointer only — provenance + confidence +
    // one-line purpose — so a hit signals "LLM insight exists" without paying the multi-KB
    // analysis+graph+evidence blob. Full projection is opt-in via withLlm: true; this is the
    // token-cost discipline that keeps query/context/dossier lightweight by default.
    const read = this.llm.readForTarget(targetId);
    const projection = withLlm === true ? llmProjection(read) : llmPointer(read);
    if (projection) result.llm = projection;
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
      // PL/SQL package state: CONSTANT values + plain defaults (WS-6) — surfaced so `context` carries
      // the migration-critical thresholds (30/80) the same way `reconstruct` does (no round-trip).
      if (Array.isArray(m.variables)) out.variables = m.variables;
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

/**
 * Render a {@link buildDossiersByScope} result as Markdown: a scope banner (scope / label / counts /
 * truncated / skipped) followed by each per-symbol dossier rendered via {@link dossierToMarkdown},
 * separated by horizontal rules. Deterministic + diff-friendly. Each dossier is already
 * self-describing, so this is a thin concatenation with attribution.
 */
function dossiersByScopeToMarkdown(r: DossiersByScopeShape): string {
  const parts: string[] = [];
  parts.push(`# Dossier-by-scope: ${r.label}`);
  parts.push('');
  parts.push(`- scope: ${r.scope}`);
  parts.push(`- id: ${r.id}`);
  parts.push(`- symbols: ${r.symbolCount}${r.truncated ? ` (capped at ${r.symbols.length})` : ''}`);
  if (r.skipped.length > 0) parts.push(`- skipped: ${r.skipped.length}`);
  parts.push('');
  for (const d of r.symbols) {
    parts.push('---');
    parts.push('');
    parts.push(dossierToMarkdown(d));
    parts.push('');
  }
  return parts.join('\n');
}

/** Heuristic classification for overview/architecture questions. */
function isOverviewQuestion(q: string): boolean {
  return /\b(architecture|overview|high.?level|how is .* organized|system structure|repo structure|big picture|what does this repo do)\b/i.test(
    q,
  );
}

/**
 * Render an `ask` result as a deterministic Markdown answer. No model is invoked;
 * the text is assembled from the retrieved node context, relationships, docs, and
 * saved LLM analyses so a human (or another LLM) can read it directly.
 */
function askToMarkdown(result: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push(`# ${result.question}`);
  parts.push('');
  parts.push(`**interpretation:** ${result.interpretation}`);
  parts.push('');

  if (result.interpretation === 'explain') {
    const ctx = result.context as Record<string, unknown> | undefined;
    if (ctx?.error) {
      parts.push(`> ${(ctx.error as { message?: string }).message ?? 'not found'}`);
    } else {
      const node = (ctx?.node ?? {}) as Record<string, unknown>;
      const title = String(node.qualifiedName ?? node.name ?? node.id ?? 'node');
      parts.push(`## ${title}`);
      parts.push('');
      if (node.file) parts.push(`- **file:** ${node.file}`);
      if (node.kind) parts.push(`- **kind:** ${node.kind}`);
      if (node.signature) parts.push(`- **signature:** \`${node.signature}\``);
      parts.push('');

      const src = (ctx?.source as { text?: string } | undefined)?.text;
      if (src) {
        parts.push('### source');
        parts.push('```');
        parts.push(String(src).trim());
        parts.push('```');
        parts.push('');
      }

      const callers = (ctx?.callers ?? []) as Array<Record<string, unknown>>;
      if (callers.length > 0) {
        parts.push(
          `**callers (${callers.length}):** ${callers.map((c) => `\`${c.qualifiedName ?? c.name ?? c.id}\``).join(', ')}`,
        );
        parts.push('');
      }
      const callees = (ctx?.callees ?? []) as Array<Record<string, unknown>>;
      if (callees.length > 0) {
        parts.push(
          `**callees (${callees.length}):** ${callees.map((c) => `\`${c.qualifiedName ?? c.name ?? c.id}\``).join(', ')}`,
        );
        parts.push('');
      }

      const docs = (ctx?.docs ?? []) as Array<Record<string, unknown>>;
      if (docs.length > 0) {
        parts.push('### docs');
        for (const d of docs.slice(0, 5)) {
          parts.push(`- *${d.edgeType}* ${d.heading ? `**${d.heading}**` : d.sectionId}`);
          if (d.snippet) parts.push(`  > ${String(d.snippet).split('\n')[0]}`);
        }
        parts.push('');
      }

      const llm = (ctx?.llm as Record<string, unknown> | undefined)?.analysis as Record<
        string,
        unknown
      >;
      if (llm?.purpose) {
        parts.push('### LLM analysis');
        parts.push(String(llm.purpose));
        parts.push('');
      }
    }
    return parts.join('\n');
  }

  if (result.interpretation === 'overview') {
    const overview = (result.overview ?? {}) as Record<string, unknown>;
    const system = overview.system as Record<string, unknown> | undefined;
    if (system?.purpose) {
      parts.push(String(system.purpose));
      parts.push('');
    }
    const modules = (overview.modules ?? []) as Array<Record<string, unknown>>;
    if (modules.length > 0) {
      parts.push(`## modules (${modules.length})`);
      for (const m of modules) {
        const purpose = (m.purpose as { text?: string } | undefined)?.text ?? '';
        const counts = m.counts as { symbols?: number } | undefined;
        const coverage = m.coverage as { pct?: number } | undefined;
        parts.push(
          `- **${m.name}** (${counts?.symbols ?? 0} symbols${
            coverage?.pct !== undefined ? `, ${coverage.pct}% enriched` : ''
          })${purpose ? ` — ${purpose}` : ''}`,
        );
      }
      parts.push('');
    }
    const analyses = (overview.analyses ?? []) as Array<Record<string, unknown>>;
    if (analyses.length > 0) {
      parts.push('## analyses');
      for (const a of analyses.slice(0, 10)) {
        parts.push(`- **${a.targetId}** — ${a.purpose ?? 'no summary'}`);
      }
      parts.push('');
    }
    const fallback = result.fallback as Record<string, unknown> | undefined;
    if (fallback?.clusters) {
      const clusters = fallback.clusters as Array<Record<string, unknown>>;
      parts.push(`## clusters (${clusters.length})`);
      for (const c of clusters.slice(0, 20)) {
        parts.push(`- ${c.id}${c.memberCount !== undefined ? ` (${c.memberCount} members)` : ''}`);
      }
      parts.push('');
    }
    return parts.join('\n');
  }

  // discovery
  const hits = (result.hits ?? []) as Array<Record<string, unknown>>;
  const llmHits = (result.llmHits ?? []) as Array<Record<string, unknown>>;
  parts.push(
    `Found ${hits.length} graph hits${llmHits.length > 0 ? ` and ${llmHits.length} LLM hits` : ''}.`,
  );
  parts.push('');

  if (hits.length > 0) {
    parts.push('## graph hits');
    for (const h of hits.slice(0, 20)) {
      const node = (h.node ?? h) as Record<string, unknown>;
      const label = String(node.qualifiedName ?? node.name ?? h.id);
      parts.push(`### ${label}`);
      if (node.file) parts.push(`- file: ${node.file}`);
      if (h.score !== undefined) parts.push(`- score: ${h.score}`);
      if (h.snippet) parts.push(`\`\`\`\n${String(h.snippet).trim()}\n\`\`\``);
      parts.push('');
    }
  }

  if (llmHits.length > 0) {
    parts.push('## LLM hits');
    for (const h of llmHits.slice(0, 10)) {
      const llm = (h.llm as Record<string, unknown> | undefined)?.analysis as Record<
        string,
        unknown
      >;
      parts.push(`- **${h.id}** — ${llm?.purpose ?? 'LLM analysis available'}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
