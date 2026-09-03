import { pathFromId } from '@knowledge-crib/core';
import { LockBusyError, withCribLock } from '@knowledge-crib/core';
import {
  type AliasMap,
  type Federation,
  federatedImpact,
  loadFederation,
} from '@knowledge-crib/core';
import { ifHash, loadAliases, rewriteQuery } from '@knowledge-crib/core';
import { GraphStore } from '@knowledge-crib/core';
import type { CompositeEdge, Dir, Dossier, Hit, IndexStore, SoulStore } from '@knowledge-crib/core';
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
import {
  type CaptureOutboxEntry,
  type ConflictGroup,
  type EffectiveVerdicts,
  MemoryApi,
  type MemoryDecision,
  type MemoryEvalContext,
  type MemoryEvaluator,
  type MemoryEvidence,
  type MemoryFeedback,
  MemoryFtsIndex,
  type MemoryRecord,
  type MemoryRecordKind,
  type MemoryRecordV2,
  type MemorySource,
  type MemoryStore,
  type RecallProjection,
  type RecallStores,
  type RecordBelief,
  type ScoredRecord,
  type SearchHit,
  SoulStoreAnchorPort,
  type SupersedePayload,
  type Verdicts,
  VersionedLexicalScorer,
  applyContradictedFeedback,
  assertNoMemorySecrets,
  bindEvaluationPass,
  bridgedDecisions,
  buildAliasIndex,
  captureRetryCount,
  conflictGroups,
  conservativeVerdicts,
  contradictedForReview,
  effectiveVerdicts,
  gatherRecall,
  isFeedbackSignal,
  isMemoryRecordV2,
  isRecallEligible,
  openMemoryFts,
  pendingCaptures,
  quarantinedRecordIds,
  recallProjection,
} from '@knowledge-crib/memory';
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
  type SemanticDeltaArgs,
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
import { Stats, trackCall } from './stats.js';
import {
  DEFAULT_DOC_LIMIT,
  DEFAULT_LIMIT,
  MAX_DEPTH,
  MAX_DOC_LIMIT,
  MAX_FED_ROOTS,
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

/**
 * W3 — the optional memory ledger deps. Any store may be absent (a fresh repo has no local store
 * yet; a repo may have no team store). The `evaluator` + `evalCtx` are required for FRESH
 * revalidation (audit drift detection, recall `fresh` provenance); when absent, the verbs fall back
 * to the records' stamped verdicts (effective verdicts with no evaluation). The `brief` /
 * `memory_*` verbs degrade to a `memory: 'not configured'` result when the whole object is absent,
 * mirroring the `vcs` "not configured" pattern.
 */
export interface MemoryDeps {
  team?: MemoryStore;
  local?: MemoryStore;
  global?: MemoryStore;
  evaluator?: MemoryEvaluator;
  evalCtx?: MemoryEvalContext;
}

export interface VerbDeps {
  soul: SoulStore;
  index: IndexStore;
  repoRoot: string;
  vcs?: VcsAdapter;
  /** W3 — the trusted agent-memory ledger. Optional; verbs degrade gracefully when absent. */
  memory?: MemoryDeps;
  /** W6 — the optional working-overlay store. When set, the extracted graph is read from the overlay
   *  (canonical + dirty swap, in memory) so edits are queryable without dirtying `.crib/graph`. The
   *  semantic layer still reads from `soul` (the committed soul). */
  workingOverlay?: SoulStore;
  /** Fraction of symbols (by architectural importance) the enrich queue offers. Defaults to
   *  `DEFAULT_SYMBOL_PERCENTILE`; set 1 to queue every symbol. */
  symbolPercentile?: number;
}

/** The optional semantic-search surface an IndexStore backend may provide. Backends without it
 *  degrade to code-only retrieval rather than failing. */
interface SemanticSearchable {
  buildSemanticIndex(
    entries: Array<{ targetId: string; layer: string; purpose: string; detail: string }>,
    generation: number,
  ): void;
  semanticIndexGeneration(): number;
  semanticSearch(text: string, limit: number): Array<{ targetId: string; score: number }>;
}

/** Default number of `overview` analysis pointers returned before paging. Small on purpose: the
 *  list grows with every artifact authored, and orientation needs the module map, not 500 entries. */
/** How long working-tree facts from git stay cached. See {@link Verbs.vcsFacts}. */
const VCS_FACT_TTL_MS = 2000;

const DEFAULT_OVERVIEW_ANALYSES = 40;

/**
 * G3.1/G3.2 — the lexical channel for one memory read call: the FTS index + the versioned scorer
 * the projection's criterion-1 slot ranks with. The PERSISTENT on-disk snapshot (`openMemoryFts`)
 * serves the default all-sources path — it is kept current by the store's write hooks and
 * self-heals on staleness/corruption, so the O(N) per-query rebuild leaves the hot path (the Gate 3
 * scale target). A `sources` FILTER keeps the ephemeral `:memory:` rebuild: a subset corpus would
 * compute BM25's IDF over the wrong corpus and rank differently than the full rebuild (the
 * byte-comparability invariant persistent-fts.ts pins).
 *
 * The scorer is the versioned scorer at the LAUNCH DEFAULT `lexical-only` — score-identical to the
 * incumbent `FtsLexicalScorer` (it delegates 1:1) while naming its configuration on the response
 * provenance (red line #6). A fusion strategy replaces this default ONLY through the pre-registered
 * held-out rule (docs/bench/retrieval-pre-registration.md §4) — never by editing a call site.
 * Callers MUST `fts.close()` in a finally (releases the SQLite handle + the store write listeners).
 */
function lexicalChannel(
  stores: RecallStores,
  records: ReadonlyArray<MemoryRecord | MemoryRecordV2>,
  sourcesFiltered: boolean,
): { fts: MemoryFtsIndex; scorer: VersionedLexicalScorer } {
  const fts = sourcesFiltered ? new MemoryFtsIndex(':memory:') : openMemoryFts(stores);
  return { fts, scorer: new VersionedLexicalScorer({ fts, records, strategy: 'lexical-only' }) };
}

/** G2.3 — how many pending/dead outbox entries the `memory{op:'outbox'}` report lists per section
 *  (the counts stay exact; only the per-entry views cap). */
const OUTBOX_ENTRY_CAP = 50;
/** How many drained entries carry their decision trail (newest first). */
const OUTBOX_DONE_CAP = 20;

/** Floor for the `overview` analysis list, so a caller always receives some entries even when the
 *  envelope (module map + system bible) already fills the requested budget. */
const MIN_OVERVIEW_LIST_TOKENS = 1500;

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

// P0.2 note: the capture-anchoring helpers (loose-name resolution + the lifted-quote budget) lived
// here until Gate 1.3; `memory{op:'capture'}` now delegates to the portable MemoryApi.capture,
// which owns that logic next to its own pure helpers (packages/memory/src/api.ts).

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

/**
 * M3.3 — the public verb methods the Proxy interceptor wraps for per-verb stats. This is the
 * exhaustive set of `verbs.X(...)` entry points registered as MCP tools in server.ts; private
 * helpers (`applyIfHash`, `attachLlm`, …) are deliberately absent so internal calls bypass the trap
 * and aren't double-counted. Keep in sync with server.ts tool registrations.
 */
const PUBLIC_VERBS = new Set<string>([
  'status',
  'context',
  'source',
  'dossier',
  'reconstruct',
  'dossierByScope',
  'impact',
  'federatedImpact',
  'query',
  'enrichStatus',
  'enrichNext',
  'enrichSave',
  'semanticDelta',
  'auditLlm',
  'overview',
  'llmNeighbors',
  'describes',
  'neighbors',
  'ownership',
  'shortestPath',
  'detectChanges',
  'extractRules',
  'gaps',
  // W3 — the trusted agent-memory verbs (PRD lines 226–248). brief is the one-call typed-group
  // retrieval; memory_* are the dedicated read/audit surface. Private memory helpers
  // (recallProjectionOf, memoryView, …) are absent here so internal calls bypass the Proxy trap.
  'brief',
  'memoryRecall',
  'memoryGet',
  'memoryObserve',
  'memoryCapture',
  'memoryStatus',
  'memoryAudit',
  'memoryFeedback',
  // Gate 1.3 — the portable MemoryApi op set wired through the memory dispatcher.
  'memorySearch',
  'memorySupersede',
  'memoryDelete',
  'memoryHistory',
  'memorySync',
  // G2.3 — the capture-outbox drain surface (read-only queue + decision report).
  'memoryOutbox',
]);

export class Verbs {
  private readonly llm: EnrichmentStore;
  private readonly graph: GraphStore;
  /** M2.4 — per-repo alias dictionary loaded once at construction; empty when no file is committed. */
  private readonly aliases: AliasMap;
  /** M3.3 — runtime observability counters (per-verb count/latency + ifHash cache hit rate). */
  private readonly stats = new Stats();
  /** W3 — the optional trusted agent-memory ledger (absent ⇒ memory verbs report "not configured"). */
  private readonly memory?: MemoryDeps;

  constructor(private readonly deps: VerbDeps) {
    this.llm = new EnrichmentStore(deps.soul, deps.repoRoot, {
      ...(deps.symbolPercentile !== undefined ? { symbolPercentile: deps.symbolPercentile } : {}),
    });
    this.graph = new GraphStore(deps.soul);
    // W6 — install the working overlay so the extracted layer reads canonical+dirty from the overlay
    // store. Semantic reads stay on the committed soul (GraphStore keeps `soul` for that).
    if (deps.workingOverlay) this.graph.setWorkingOverlay(deps.workingOverlay);
    this.aliases = loadAliases(deps.soul.cribDir);
    this.memory = deps.memory;
    // M3.3 — Proxy interceptor: wrap every PUBLIC verb method with `trackCall` so per-verb
    // count + latency is recorded for BOTH entry paths (direct in-process calls AND MCP tool
    // calls, since the MCP handler is `verbs.X(a)`). Internal helper calls (`this.applyIfHash`,
    // `this.attachLlm`) resolve on the real `target` and bypass the trap — only the names in
    // PUBLIC_VERBS get wrapped, so private helpers are NOT double-counted. The interceptor times
    // the call and passes the result through verbatim; deterministic verb outputs are byte-identical
    // with or without it (stats are in-memory side-channel, never persisted — see stats.ts).
    // Returning a Proxy wrapping `this` is the canonical single-point instrumentation pattern:
    // external `verbs.X(a)` hits the trap (timed), internal `this.foo()` resolves on the real
    // `target` and bypasses it. The constructor still fully initializes `this` before returning.
    // biome-ignore lint/correctness/noConstructorReturn: intentional Proxy interceptor — see above.
    return new Proxy(this, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        if (typeof prop !== 'string' || !PUBLIC_VERBS.has(prop)) return value;
        return (...args: unknown[]) =>
          trackCall(target.stats, prop, () => value.apply(target, args));
      },
    }) as unknown as this;
  }

  /** M3.3 — accessor for the live stats counters (used by the `stats` MCP tool / CLI). NOT wrapped. */
  getStats(): Stats {
    return this.stats;
  }

  status(opts?: { dirty?: boolean }): Record<string, unknown> {
    const m = this.deps.soul.getManifest();
    const { hasLlmGraph, composite } = this.statusGraphFacts();
    const result: Record<string, unknown> = {
      indexed: m.stats.nodes > 0,
      schemaVersion: m.schemaVersion,
      stats: { nodes: m.stats.nodes, edges: m.stats.edges, clusters: m.stats.clusters },
      ...(m.repo.vcsHead ? { vcsHead: m.repo.vcsHead } : {}),
      ...(m.stats.incrementalSince ? { incrementalSince: m.stats.incrementalSince } : {}),
      capabilities: { ...m.capabilities, ...this.deps.index.capabilities(), llmGraph: hasLlmGraph },
      graph: {
        extracted: { nodes: m.stats.nodes, edges: m.stats.edges },
        semantic: composite.diagnostics,
        composite: { nodes: composite.nodes.length, edges: composite.edges.length },
      },
    };
    if (this.deps.vcs) {
      try {
        const { head, dirtyFiles } = this.vcsFacts();
        result.currentHead = head;
        result.dirty = {
          isDirty: dirtyFiles.length > 0,
          uncommittedCount: dirtyFiles.length,
          aheadOfVcsHead: Boolean(m.repo.vcsHead && m.repo.vcsHead !== head),
          // Default status must stay safely serializable even when a graph rebuild changes thousands
          // of committed soul artifacts. `--dirty` is the explicit detail request.
          ...(opts?.dirty ? { uncommitted: dirtyFiles } : {}),
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
    /** M2.6 change-aware cache. Echo the `hash` a prior call returned to short-circuit an unchanged
     *  response: when the rebuilt response is byte-identical, the body collapses to
     *  `{ unchanged: true, hash }`. Stateless (deterministic BLAKE3 of the response). */
    ifHash?: string;
  }): Record<string, unknown> {
    const soul = this.deps.soul;
    const id = this.resolveNodeId(args.id);
    if (!id) return notFound(args.id);
    const node = soul.getNode(id);
    if (!node) return notFound(args.id);
    const callers = this.callEdges(id, 'up', args.extractedOnly).map((e) =>
      this.nodeBrief(e.src, e.confidence),
    );
    const callees = this.callEdges(id, 'down', args.extractedOnly).map((e) =>
      this.nodeBrief(e.dst, e.confidence),
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
    return this.applyIfHash(args, result);
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
    /** M2.6 change-aware cache. Echo the `hash` a prior call returned to short-circuit an unchanged
     *  response. Stateless (deterministic BLAKE3 of the response). */
    ifHash?: string;
  }): Record<string, unknown> {
    const id = this.resolveNodeId(args.id);
    if (!id) return notFound(args.id);
    const node = this.deps.soul.getNode(id);
    if (!node) return notFound(args.id);
    return this.applyIfHash(args, { node: this.publicNode(node), source: this.bodyOf(node, args) });
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
    /** M2.6 change-aware cache. Echo the `hash` a prior call returned to short-circuit an unchanged
     *  response (works for both `json` and `markdown` formats). Stateless (deterministic BLAKE3). */
    ifHash?: string;
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
      return this.applyIfHash(args, { id, markdown: dossierToMarkdown(dossier) });
    }
    const result = dossier as unknown as Record<string, unknown>;
    this.attachLlm(result, id, args.withLlm);
    return this.applyIfHash(args, result);
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
    includeLlm?: boolean;
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
        for (const e of this.traversalAdjacency(cur, args.dir, args)) {
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
   * `federatedImpact` (M3.2) — cross-repo blast radius. Like `impact` but loads extra repo souls
   * (`roots`) and crosses the route-layer bridge: a repo-A `http-call` (outbound HTTP client call)
   * resolves to the repo-B `route` it serves, matched by {httpMethod, routePath}. The bridge is a
   * runtime computation over the loaded souls — no cross-repo edge is committed, so each soul stays
   * independent + deterministic. The primary soul (`this.deps.repoRoot`) is always federated; extra
   * `roots` add the repos to traverse into. The start `id` is resolved in the primary soul first,
   * then across the extra roots. Each affected node carries `soul` (its repo root) + `crossRepo`
   * (true iff the hop crossed repos via the bridge).
   */
  federatedImpact(args: {
    id: string;
    dir: Dir;
    /** extra repo roots to federate with the primary (`this.deps.repoRoot`). */
    roots?: string[];
    depth?: number;
    limit?: number;
    extractedOnly?: boolean;
  }): Record<string, unknown> {
    const primaryRoot = this.deps.repoRoot;
    // Clamp extra roots to MAX_FED_ROOTS — the CLI path (collectRepeated) has no zod bound, so a
    // runaway `--repo` list is defended here too, not only at the MCP zod layer (server.ts).
    const extraRoots = (args.roots ?? []).slice(0, MAX_FED_ROOTS);
    const roots = uniqueRoots([primaryRoot, ...extraRoots]);
    let fed: Federation;
    try {
      fed = loadFederation(roots);
    } catch (err) {
      // Same {code, message} shape as notFound — a consumer branching on `result.error?.code`
      // (the pattern verbs.test.ts uses) sees a stable code, not a bare string.
      return {
        error: { code: 'FEDERATION_LOAD_FAILED', message: (err as Error).message },
        roots,
      };
    }
    // Resolve the start id: primary soul first (the common case), then across the extra roots.
    let startRoot = primaryRoot;
    let startId = this.resolveNodeIdAcross(fed, args.id, primaryRoot);
    if (!startId) {
      for (const s of fed.souls) {
        if (s.root === primaryRoot) continue;
        const id = resolveIdInSoul(s.soul, args.id);
        if (id) {
          startId = id;
          startRoot = s.root;
          break;
        }
      }
    }
    if (!startId) return notFound(args.id);
    const result = federatedImpact(fed, startRoot, startId, args.dir, {
      depth: args.depth,
      limit: args.limit,
      extractedOnly: args.extractedOnly,
    });
    return {
      root: startRoot,
      dir: args.dir,
      federatedRoots: roots,
      affected: result.affected,
      crossRepoHops: result.crossRepoHops,
      truncated: result.truncated,
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

    // Semantic discoveries from the authored-meaning layer that BM25 did NOT surface, ranked by the
    // SAME semantic_fts BM25 projection `brief` uses ({@link Verbs.semanticHits}) — the measured
    // ranker — and de-duplicated against the BM25 hit set. These live in their own `llmHits` field
    // so they never drown out BM25 ranking (the old `unshift`-at-score-0 path put a test helper
    // that merely mentioned a query term above the real `sqlite-index.ts` for "sqlite").
    //
    // `EnrichmentStore.matchText` (an O(all-artifacts) disk scan ranked by raw term count) is kept
    // only as the fallback for when semantic_fts is unavailable or cold, and the fallback is never
    // silent: `llmSource` names the ranker that served the discoveries, and FTS-sourced hits carry
    // `semanticMatch` — the same signal `brief` uses for "authored meaning FOUND this hit" — while
    // fallback hits do not.
    const llmHits: Array<Record<string, unknown>> = [];
    let llmTruncated = false;
    let llmSource: 'semantic_fts' | 'matchText' | undefined;
    if (args.withLlm !== false) {
      const seen = new Set(bm25Ids);
      const ftsHits = this.semanticHits(args.q, limit + 1);
      if (ftsHits.length > 0) {
        llmSource = 'semantic_fts';
        llmTruncated = ftsHits.length > limit;
        for (const hit of ftsHits.slice(0, limit)) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          const node = soul.getNode(hit.id);
          // Inheritance-aware pointer, identical to what attachLlm folds onto BM25 hits — a
          // discovery ranked for its FILE's prose must not read as the symbol's own meaning.
          const { read, via, inherited } = this.llm.readInherited(hit.id);
          const proj =
            args.withLlm === true ? llmProjection(read) : llmPointer(read, { via, inherited });
          if (!proj) continue;
          llmHits.push({
            id: hit.id,
            kind: node?.kind ?? 'symbol',
            grounding: 'semantic', // authored meaning is what ranked this discovery
            semanticMatch: true,
            snippet: node ? rehydrate(this.deps.repoRoot, node) : '',
            llm: proj,
          });
        }
      } else {
        llmSource = 'matchText';
        const llmArtifacts = this.llm.matchText(args.q, limit + 1);
        llmTruncated = llmArtifacts.length > limit;
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
            grounding: 'semantic', // every llmHit carries an artifact by construction
            snippet: node ? rehydrate(this.deps.repoRoot, node) : '',
            llm: proj,
          });
        }
      }
    }

    // Honest self-report over the RETURNED payload (hits + llmHits), mirroring brief.coverage:
    // how much of this answer is backed by authored meaning rather than source alone. Omitted when
    // withLlm:false — the caller opted the semantic layer out, so reporting a 0-ratio desert would
    // blame them for a choice they made. Below LOW_COVERAGE_RATIO the response carries an explicit
    // caller-facing `hint` instead of relying on the reader to interpret the ratio.
    const coverage = args.withLlm === false ? undefined : coverageOf([...hits, ...llmHits]);
    const baseTruncated = bm25Truncated || llmTruncated;
    const tail: Record<string, unknown> = {
      truncated: baseTruncated,
      // Only when there is something for it to describe. `llmSource` names the ranker that served
      // the discoveries; reporting the provenance of an EMPTY list is noise, and on a tight budget
      // it is noise that crowds out the fields a caller needs to page.
      ...(llmSource !== undefined && llmHits.length > 0 ? { llmSource } : {}),
      ...(coverage !== undefined ? { coverage, ...lowCoverageHint(coverage) } : {}),
    };
    // M1.2 response-wide token budget (opt-in). When maxTokens is set, fit the hits list to the
    // largest leading prefix whose serialized response fits (chars/4); llmHits + the fixed tail
    // fields are counted in the estimate. The non-maxTokens path adds no cursor / no
    // budgetExhausted so existing callers + tests are unchanged.
    if (args.maxTokens === undefined) {
      return { hits, llmHits, ...tail };
    }
    const maxTokens = capMaxTokens(args.maxTokens);
    const fitted = fitTokenBudget(hits, maxTokens, (prefix) =>
      JSON.stringify({
        hits: prefix,
        llmHits,
        ...tail,
        budgetExhausted: true,
        cursor: String(offset + prefix.length),
      }),
    );
    const more = fitted.budgetExhausted || bm25Truncated;
    const result: Record<string, unknown> = {
      hits: fitted.items,
      llmHits,
      ...tail,
      // when maxTokens is opted in, always report budgetExhausted (true/false); cursor only when more.
      budgetExhausted: fitted.budgetExhausted,
      ...(more ? { cursor: String(offset + fitted.items.length) } : {}),
    };
    // `maxTokens` is a ceiling, not a suggestion — the fitter can only trim `hits`, so on a budget
    // too small for even an empty-hits response the ADVISORY tail must yield. `coverage` and its
    // `hint` describe a payload that has just been trimmed to nothing, so they are the first things
    // worth dropping; `truncated`, `budgetExhausted` and `cursor` stay, because without them the
    // caller cannot tell a small answer from a truncated one, or page to get the rest.
    if (estimateTokens(JSON.stringify(result)) > maxTokens) {
      const { coverage: _c, hint: _h, ...rest } = result;
      return rest;
    }
    return result;
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
    // semantic artifacts against soul rebuild. Hold cross-process graph lock around save.
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
   * `semantic_delta` — the semantic-layer delta report (+ optional prune), the explicit companion to
   * `crib update`'s silent orphan auto-prune. Two scoping modes:
   *   • `targets` — an explicit set of target ids (the re-issue surface; a driver passes
   *     `enrich_next`'s `targets` here to assess exactly that set).
   *   • `since` — a VCS ref; when `targets` is absent, the changed symbols/files since `since` are
   *     computed (via {@link affectedTargetIds}) and used as the scan filter, so only artifacts whose
   *     target changed are scanned (faster than a whole-repo `audit_llm` when the diff is small).
   * When BOTH are absent, every persisted artifact is scanned (the whole-repo delta). Non-destructive
   * by default (`prune:false`); `prune` deletes orphans, `pruneStale` also deletes stale-but-present
   * (destructive). The returned `reissueTargets` is the set to pass to `enrich_next`/`enrich_status`
   * `targets` to re-author exactly the flagged targets.
   */
  semanticDelta(args: {
    since?: string;
    targets?: string[];
    prune?: boolean;
    pruneStale?: boolean;
    verifyDrift?: boolean;
  }): Record<string, unknown> {
    let targets = args.targets;
    let vcs: { since: string; head: string; changedPaths: string[] } | undefined;
    if (!targets && args.since !== undefined) {
      const affected = this.affectedTargetIds(args.since);
      if ('note' in affected) {
        // No VCS / no anchor / non-git: fall through to an unscoped whole-repo scan so the verb still
        // reports the delta it can compute (orphans/stale against the current soul), with the note.
        vcs = undefined;
      } else {
        targets = affected.targets;
        vcs = { since: affected.since, head: affected.head, changedPaths: affected.changedPaths };
      }
    }
    const deltaArgs: SemanticDeltaArgs = {
      ...(targets ? { targets } : {}),
      ...(args.prune ? { prune: true } : {}),
      ...(args.pruneStale ? { pruneStale: true } : {}),
      ...(args.verifyDrift ? { verifyDrift: true } : {}),
    };
    const report = this.llm.semanticDelta(deltaArgs);
    return {
      ...report,
      ...(vcs ? { since: vcs.since, head: vcs.head, changedPaths: vcs.changedPaths } : {}),
      ...(args.since !== undefined && !vcs ? { note: 'no vcs anchor — scanned whole repo' } : {}),
    } as unknown as Record<string, unknown>;
  }

  /**
   * Compute the semantic target ids affected by a VCS diff since `since` — the changed symbols + the
   * changed files + EVERY cluster (cluster membership is global; a moved symbol changes its old + new
   * cluster's hash, and we cannot cheaply tell which clusters shifted, so all cluster targets are in
   * scope) + the whole-repo `system:repo` target (any change can invalidate the bible). Mirrors
   * `detectChanges`'s graceful VCS degradation (no adapter / non-git / no anchor → `{note}`).
   */
  private affectedTargetIds(
    since: string,
  ): { since: string; head: string; changedPaths: string[]; targets: string[] } | { note: string } {
    const vcs = this.deps.vcs;
    if (!vcs) return { note: 'vcs adapter not configured' };
    let head: string;
    try {
      head = vcs.currentHead(this.deps.repoRoot);
    } catch {
      return { note: 'not a git work tree' };
    }
    let changedPaths: string[];
    try {
      changedPaths = vcs.changedFilesSince(this.deps.repoRoot, since);
    } catch {
      return { note: 'not a git work tree' };
    }
    const changed = new Set(changedPaths);
    const targets: string[] = [];
    for (const node of this.deps.soul.iterate()) {
      // symbol + file nodes carry a `file`; clusters do not (pathFromId(clusterId) is undefined), so
      // clusters are added by the dedicated pass below, not the file match.
      const p = node.file ?? pathFromId(node.id);
      if (p !== undefined && changed.has(p)) targets.push(node.id);
    }
    for (const node of this.deps.soul.iterate('cluster')) targets.push(node.id);
    targets.push('system:repo');
    return { since, head, changedPaths, targets };
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

  /**
   * The codebase overview, held to a token budget like every other list verb.
   *
   * `analyses` is one entry per authored artifact, so it grows with enrichment and had no cap: on
   * this repo at 494 artifacts a single default `overview` call returned 43,328 tokens — more than
   * a whole conversation's budget, from one call the caller had no reason to think was expensive.
   * `modules` is kept whole (it is the map you actually orient by, and stays small); `analyses` is
   * trimmed to fit and reports what it dropped, so a caller can page rather than be silently
   * truncated.
   */
  overview(
    args: {
      scope?: { pathPrefix?: string; cluster?: string };
      withLlm?: boolean;
      maxTokens?: number;
      limit?: number;
      cursor?: string;
    } = {},
  ): Record<string, unknown> {
    const result = this.llm.overview(args) as unknown as Record<string, unknown>;
    const analyses = result.analyses;
    if (!Array.isArray(analyses)) return result;

    const offset = Math.max(0, Number.parseInt(args.cursor ?? '', 10) || 0);
    const hardLimit = capInt(args.limit, DEFAULT_OVERVIEW_ANALYSES, 500);
    const page = analyses.slice(offset, offset + hardLimit);
    // Budget the LIST against what the envelope leaves, not against the whole response. Measuring
    // the envelope inside the budget meant `modules` and the system bible consumed it before a
    // single analysis fit, and the call returned zero of them — technically within budget, and
    // useless. A floor guarantees a caller always gets some, even on a tight budget.
    const maxTokens = args.maxTokens === undefined ? 4000 : capMaxTokens(args.maxTokens);
    const envelopeTokens = estimateTokens(JSON.stringify({ ...result, analyses: [] }));
    const listBudget = Math.max(maxTokens - envelopeTokens, MIN_OVERVIEW_LIST_TOKENS);
    const fitted = fitTokenBudget(page, listBudget, (prefix) => JSON.stringify(prefix));
    const shown = fitted.items;
    const next = offset + shown.length;
    return {
      ...result,
      analyses: shown,
      analysisCount: { shown: shown.length, total: analyses.length },
      ...(next < analyses.length ? { truncated: true, cursor: String(next) } : {}),
    };
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
    includeLlm?: boolean;
  }): Record<string, unknown> {
    const includeLlm = args.includeLlm === true && args.extractedOnly !== true;
    const composite = includeLlm ? this.graph.composite() : undefined;
    const id =
      this.resolveNodeId(args.id) ??
      (composite?.nodes.some((node) => node.id === args.id) ? args.id : undefined);
    if (!id) return notFound(args.id);
    const edges = this.traversalAdjacency(id, apiDir(args.dir), args).filter(
      (e) => !args.rel || e.rel === args.rel,
    );
    const page = bound(edges.map(publicAnyEdge), capInt(args.limit, 50, MAX_LIMIT));
    return {
      edges: page.items,
      truncated: page.truncated,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  /** M3.1 ownership: the git-blame owners of a node — "who do I ask about this code". Walks outgoing
   *  `owned-by` EXTRACTED edges (symbol → owner) and returns the owner node + the blame commit + the
   *  HEAD the index ran against. A node with no `owned-by` edge (untracked file, non-git repo, owner
   *  unresolved) returns an empty owners list rather than not-found — the node exists, it just has no
   *  owner attribution. Accepts the same id-or-name resolution as the other node verbs. */
  ownership(args: { id: string }): Record<string, unknown> {
    const id = this.resolveNodeId(args.id);
    if (!id || !this.deps.soul.getNode(id)) return notFound(args.id);
    const owners: Array<Record<string, unknown>> = [];
    for (const e of this.adjacency(id, 'down', true)) {
      if (e.rel !== 'owned-by') continue;
      const owner = this.deps.soul.getNode(e.dst);
      if (!owner) continue;
      const ev = (e.evidence ?? {}) as Record<string, unknown>;
      owners.push({
        owner: this.publicNode(owner),
        commit: ev.commit ?? null,
        head: ev.head ?? null,
        confidence: e.confidence,
        provenance: e.provenance,
      });
    }
    return { node: id, owners };
  }

  shortestPath(args: {
    from: string;
    to: string;
    maxHops?: number;
    includeLlm?: boolean;
    extractedOnly?: boolean;
  }): Record<string, unknown> {
    // resolve qualified/simple names on both endpoints (parity with the other node verbs); fall
    // back to the raw input so index.shortestPath reports a clean not-found instead of throwing.
    const from = this.resolveNodeId(args.from) ?? args.from;
    const to = this.resolveNodeId(args.to) ?? args.to;
    const maxHops = capInt(args.maxHops, 6, MAX_HOPS);
    if (args.includeLlm === true && args.extractedOnly !== true) {
      const r = this.graph.shortestPath(from, to, maxHops);
      return { path: r.path, edges: r.edges.map(publicAnyEdge), found: r.path.length > 0 };
    }
    const r = this.deps.index.shortestPath(from, to, maxHops);
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

  private traversalAdjacency(
    id: string,
    dir: Dir | 'both',
    opts: { extractedOnly?: boolean; includeLlm?: boolean },
  ): Array<Edge | CompositeEdge> {
    if (opts.includeLlm !== true || opts.extractedOnly === true) {
      return this.adjacency(id, dir, opts.extractedOnly);
    }
    return this.graph.composite().edges.filter((edge) => {
      if (dir === 'up') return edge.dst === id;
      if (dir === 'down') return edge.src === id;
      return edge.src === id || edge.dst === id;
    });
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

  /** M3.2 — resolve an id-or-name against a specific federated soul (the primary), used by
   *  `federatedImpact` before it falls back to scanning the extra roots. */
  private resolveNodeIdAcross(
    fed: Federation,
    idOrName: string,
    primaryRoot: string,
  ): string | undefined {
    const primary = fed.souls.find((s) => s.root === primaryRoot);
    if (!primary) return undefined;
    return resolveIdInSoul(primary.soul, idOrName);
  }

  private nodeBrief(id: string, confidence: number): Record<string, unknown> {
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
   * W3 — the one-call typed-group retrieval (PRD lines 226–248). Returns code hits, doc instructions,
   * and trusted memories as SEPARATE typed groups so the soul's code BM25 and the memory recall score
   * are never fused (PRD line 333 — "never mix code BM25 + memory scores"). `codeHits` + `instructions`
   * come from ONE BM25 scan over the soul index, partitioned by kind (symbols/files vs doc-sections);
   * `memories` + `conflicts` come from the recall projection (criterion-1 lexical via the separate
   * memory FTS, ranked by the 6-criterion comparator). `cursor` pages the code BM25 offset; the
   * response-wide `maxTokens` budget (default 2000) trims the combined payload. `ifHash` collapses a
   * repeat to `{ unchanged: true, hash }` (~30 bytes — PRD line 338 invariant #3).
   */
  /**
   * Primary recall entry point — every hit carries the best MEANING available for it.
   *
   * The token problem this solves is not the size of a `brief` response (it is ~500 tokens; the
   * per-hit snippet is a single trimmed line, ~11 tokens). It is that a hit carrying only a name
   * and one line of source tells the caller nothing about what the code *does*, so the caller
   * escalates — to `context`/`dossier`, and past those to reading whole files, which is where the
   * thousands of tokens actually go. Attaching authored purpose is what removes the reason to
   * escalate.
   *
   * So prose is added, not swapped in: the cheap snippet stays (dropping ~11 tokens of real
   * signal to add ~46 tokens of pointer would make the payload both larger and less useful).
   * Each hit reports `grounding` — `semantic` when authored prose was found for the target or,
   * flagged as `inherited`, for its owning file/cluster; `code` when nothing was authored — and
   * `coverage` reports the grounded fraction of the response, so a semantic desert is visible
   * instead of silently thin.
   */
  brief(args: {
    q: string;
    paths?: string[];
    targetIds?: string[];
    sources?: MemorySource[];
    maxTokens?: number;
    cursor?: string;
    ifHash?: string;
  }): Record<string, unknown> {
    const limit = DEFAULT_LIMIT;
    const offset = Math.max(0, Number.parseInt(args.cursor ?? '', 10) || 0);
    const q = rewriteQuery(args.q, this.aliases);
    const rawHits = this.deps.index.query({ text: q, limit: limit + 1, offset });
    const moreCode = rawHits.length > limit;
    const keywordHits = moreCode ? rawHits.slice(0, limit) : rawHits;
    // Fuse keyword hits with hits ranked over AUTHORED MEANING. Keyword search alone answers
    // "which code contains these words"; a question like "how do I debug a parser that hangs"
    // shares no words with the fuzz harness that answers it, and used to return a Rust fixture.
    // Semantic hits are interleaved from the front so a precise prose match cannot be buried
    // beneath incidental keyword matches, and duplicates collapse to the keyword hit.
    // A deeper semantic pool than the response can hold: RRF needs to SEE a candidate to rank it,
    // and the answer to a conceptual question routinely sits below the visible cut in its own list.
    const hits =
      offset > 0
        ? keywordHits
        : fuseSemantic(
            keywordHits,
            this.semanticHits(args.q, Math.max(limit * 4, 40)),
            this.deps.soul,
            limit,
          );
    const codeHits: Array<Record<string, unknown>> = [];
    const instructions: Array<Record<string, unknown>> = [];
    for (const h of hits) {
      const node = this.deps.soul.getNode(h.id);
      const { read, via, inherited } = this.llm.readInherited(h.id);
      const pointer = llmPointer(read, { via, inherited });
      const grounded = pointer !== undefined;
      const view: Record<string, unknown> = {
        id: h.id,
        kind: h.kind,
        score: h.score,
        grounding: grounded ? 'semantic' : 'code',
        snippet: rehydrate(this.deps.repoRoot, node),
      };
      // True when authored meaning RANKED this hit, not merely decorated it.
      if ((h as { semanticMatch?: boolean }).semanticMatch === true) view.semanticMatch = true;
      if (pointer) view.llm = pointer;
      if (h.kind === 'doc-section') instructions.push(view);
      else codeHits.push(view);
    }
    // memories + conflicts: the recall projection over the configured stores (optional — a repo with
    // no memory ledger configured returns empty memories, not an error). targets = explicit ids + paths.
    const targets = [...(args.targetIds ?? []), ...(args.paths ?? [])];
    const projection = this.recallProjectionOf({
      query: args.q,
      ...(targets.length > 0 ? { targetIds: targets } : {}),
      ...(args.sources ? { sources: args.sources } : {}),
      fresh: true,
    });
    const memories = projection
      ? projection.memories.slice(0, limit).map((m) => this.memoryView(m, false))
      : [];
    const conflicts = projection ? projection.conflicts.map((g) => this.conflictView(g)) : [];
    const memoryProvenance = projection?.provenance;

    // Fit the whole typed-group payload to the budget: one binary search over a tagged item stream
    // (code/instr/mem) whose serialize fn rebuilds the exact response shape, so the budget guards the
    // real on-wire size, not a proxy. The cursor resumes the CODE BM25 offset (the paged group).
    type Tagged = { group: 'code' | 'instr' | 'mem'; view: Record<string, unknown> };
    const items: Tagged[] = [
      ...codeHits.map((view) => ({ group: 'code' as const, view })),
      ...instructions.map((view) => ({ group: 'instr' as const, view })),
      ...memories.map((view) => ({ group: 'mem' as const, view })),
    ];
    const maxTokens = args.maxTokens === undefined ? 2000 : capMaxTokens(args.maxTokens);
    const fitted = fitTokenBudget(items, maxTokens, (prefix) => {
      // coverage + retrieval describe the candidate prefix, so the estimate counts the real
      // fixed fields the wire response carries (a low-coverage `hint` is one of them).
      const cov = coverageOf(prefix.filter((i) => i.group !== 'mem').map((i) => i.view));
      return JSON.stringify({
        codeHits: prefix.filter((i) => i.group === 'code').map((i) => i.view),
        instructions: prefix.filter((i) => i.group === 'instr').map((i) => i.view),
        memories: prefix.filter((i) => i.group === 'mem').map((i) => i.view),
        conflicts,
        ...(memoryProvenance ? { provenance: memoryProvenance } : {}),
        coverage: cov,
        retrieval: retrievalOf(prefix.filter((i) => i.group !== 'mem').map((i) => i.view)),
        ...lowCoverageHint(cov),
        truncated: true,
        budgetExhausted: true,
      });
    });
    const keptCode = fitted.items.filter((i) => i.group === 'code').map((i) => i.view);
    const keptInstr = fitted.items.filter((i) => i.group === 'instr').map((i) => i.view);
    const keptMem = fitted.items.filter((i) => i.group === 'mem').map((i) => i.view);
    const more = moreCode || fitted.budgetExhausted;
    const coverage = coverageOf([...keptCode, ...keptInstr]);
    const result: Record<string, unknown> = {
      codeHits: keptCode,
      instructions: keptInstr,
      memories: keptMem,
      conflicts,
      ...(memoryProvenance ? { provenance: memoryProvenance } : {}),
      // Honest self-report: how much of THIS answer came from authored meaning rather than source.
      // Below the low-coverage floor the response says so explicitly (`hint`) instead of relying
      // on the caller to interpret the ratio.
      //
      // Counted over the items actually RETURNED (post token-budget trim), not the wider set that
      // was fetched — coverage has to describe the payload the caller is holding, or it would
      // overstate grounding whenever the budget dropped the semantic hits.
      coverage,
      ...lowCoverageHint(coverage),
      // `retrieval` answers a DIFFERENT question from `coverage`, and the difference matters.
      // `coverage` says how many hits carry prose — which saturates at 100% once most files are
      // described, because a symbol inherits its file's purpose whether or not it is relevant.
      // `matched` counts hits that authored meaning actually RANKED, which is the signal that the
      // semantic layer contributed to finding this answer rather than merely decorating it.
      retrieval: retrievalOf([...keptCode, ...keptInstr]),
      truncated: more,
    };
    if (fitted.budgetExhausted) result.budgetExhausted = true;
    if (more) result.cursor = String(offset + keptCode.length);
    return this.applyIfHash(args, result);
  }

  /**
   * W3 — recall trusted memory (PRD `memory_recall`): default limit 5, max 20, default token budget
   * 1200, team + local + applicable-global sources. Returns the ranked eligible memories (default
   * view = evidence summaries + pointers; full evidence opt-in via `withEvidence`), the conflict
   * groups, and deterministic provenance. Normal recall never returns invalid / orphaned /
   * superseded / retracted / pending records (the projection's hard eligibility filter — PRD line
   * 338 invariant #1); conflicting claims appear together (invariant #2).
   */
  memoryRecall(args: {
    q?: string;
    targetIds?: string[];
    sources?: MemorySource[];
    limit?: number;
    maxTokens?: number;
    withEvidence?: boolean;
    includePending?: boolean;
    ifHash?: string;
  }): Record<string, unknown> {
    if (!this.memory) return this.applyIfHash(args, { memory: 'not configured' });
    const limit = capInt(args.limit, 5, 20);
    const projection = this.recallProjectionOf({
      query: args.q ?? '',
      ...(args.targetIds ? { targetIds: args.targetIds } : {}),
      ...(args.sources ? { sources: args.sources } : {}),
      fresh: true,
    });
    if (!projection) return this.applyIfHash(args, { memory: 'not configured' });
    // limit is the hard count cap (default 5, max 20); the token budget trims within the limited set.
    const limited = projection.memories
      .slice(0, limit)
      .map((m) => this.memoryView(m, args.withEvidence));
    const conflictsView = projection.conflicts.map((g) => this.conflictView(g));
    const maxTokens = args.maxTokens === undefined ? 1200 : capMaxTokens(args.maxTokens);
    const fitted = fitTokenBudget(limited, maxTokens, (prefix) =>
      JSON.stringify({
        memories: prefix,
        conflicts: conflictsView,
        provenance: projection.provenance,
        budgetExhausted: true,
      }),
    );
    const more = fitted.budgetExhausted || projection.memories.length > limit;
    const result: Record<string, unknown> = {
      memories: fitted.items,
      conflicts: conflictsView,
      provenance: projection.provenance,
      truncated: more,
    };
    // Opt-in, and kept in its own group. `memories` remains trusted-only whatever this returns.
    if (args.includePending === true) {
      result.pending = this.pendingCandidates(args.q ?? '', limit);
    }
    if (fitted.budgetExhausted) result.budgetExhausted = true;
    return this.applyIfHash(args, result);
  }

  /**
   * W3 — fetch one memory record by id (PRD `memory_get`): the full record + its effective verdicts +
   * store source. Evidence is returned as summaries by default (kind + verdict + soul anchor); the
   * full evidence array is opt-in via `withEvidence`. Searches team `records`, local `active`, then
   * global `records`.
   */
  memoryGet(args: { id: string; withEvidence?: boolean; ifHash?: string }): Record<
    string,
    unknown
  > {
    if (!this.memory) return this.applyIfHash(args, { memory: 'not configured' });
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    const got = api.get(args.id);
    if (!got.found || !got.record || !got.source) {
      return this.applyIfHash(args, { found: false, id: args.id });
    }
    const record = got.record;
    const source = got.source;
    const evidence =
      args.withEvidence === true
        ? record.evidence
        : record.evidence.map((e) => this.evidenceSummary(e));
    // Memory-1 records keep the W3 response contract BYTE-IDENTICAL (the v1 fields are real on
    // v1 — emitting them for a v2 record is the undefined-field bug the wave-2 review flagged).
    if (!isMemoryRecordV2(record)) {
      return this.applyIfHash(args, {
        id: record.id,
        subject: record.subject,
        claim: record.claim,
        scope: record.scope,
        appliesTo: record.appliesTo,
        authorship: record.authorship,
        verdicts: record.verdicts,
        source,
        createdAt: record.createdAt,
        evidence,
        // Supersession links ride on decisions (v1 has no lineage field); surfaced ONLY when one
        // exists so the classic no-successor response stays byte-identical to the W3 contract.
        ...(got.supersededBy && got.supersededBy.length > 0
          ? { supersededBy: got.supersededBy }
          : {}),
      });
    }
    // Memory-2: the v2-aware contract — effective (alias-restored) verdicts, visibility,
    // propositionKey, the bi-temporal validity interval, lineage and placement — never the v1
    // fields the envelope no longer carries.
    return this.applyIfHash(args, {
      id: record.id,
      requestedId: got.requestedId,
      ...(got.resolvedViaAlias ? { resolvedViaAlias: got.resolvedViaAlias.legacyId } : {}),
      schemaVersion: '2',
      kind: record.kind,
      subject: record.subject,
      claim: record.claim,
      visibility: got.visibility,
      propositionKey: record.propositionKey,
      sensitivity: record.sensitivity,
      retentionPolicyId: record.retentionPolicyId,
      provenance: record.provenance,
      validity: got.validity,
      lineage: got.lineage,
      verdicts: got.verdicts,
      source,
      placement: got.placement,
      legacyIds: got.legacyIds,
      supersededBy: got.supersededBy,
      evidence,
    });
  }

  /**
   * Gate 1.3 — `memory{op:'search'}`: the portable API's rich search over the SAME recall
   * projection `memory_recall` uses (6-criterion priority-ordered ranking, alias bridging,
   * conflict grouping, hard eligibility). The hits carry the full G1.3 contract: effective
   * (alias-restored) verdicts, evidence summaries, freshness, validity, lineage, score +
   * ranking version, the conflict groups the hit participates in, and successors that retired it.
   * Ranking must never fork between the two read verbs, so the projection is delegated to
   * {@link MemoryApi.search} with the SAME in-memory FTS lexical scorer `memory_recall` builds.
   */
  memorySearch(args: {
    q?: string;
    targetIds?: string[];
    sources?: MemorySource[];
    limit?: number;
    maxTokens?: number;
    withEvidence?: boolean;
    ifHash?: string;
  }): Record<string, unknown> {
    const mem = this.memory;
    const stores = this.recallStores();
    const api = this.memoryApi();
    if (!mem || !stores || !api) return this.applyIfHash(args, { memory: 'not configured' });
    const query = args.q ?? '';
    // G3.1 — the persistent FTS snapshot serves the default all-sources path (kept current by the
    // store write hooks, self-healing); a sources FILTER keeps the ephemeral rebuild (a subset
    // corpus would rank differently — the byte-comparability invariant). G3.2 — the versioned
    // scorer names its configuration on the response provenance (red line #6).
    const gathered = gatherRecall(stores, {
      ...(args.sources ? { sources: args.sources } : {}),
    });
    const { fts, scorer } = lexicalChannel(
      stores,
      gathered.records.map((r) => r.record),
      args.sources !== undefined,
    );
    try {
      const response = api.search(query, {
        ...(args.targetIds ? { targetIds: args.targetIds } : {}),
        ...(args.sources ? { sources: args.sources } : {}),
        lexicalScorer: scorer,
        ...(mem.evaluator && mem.evalCtx ? { evaluator: mem.evaluator, evalCtx: mem.evalCtx } : {}),
      });
      const limit = capInt(args.limit, 5, 20);
      const hits = response.hits
        .slice(0, limit)
        .map((h) => this.searchHitView(h, args.withEvidence));
      const maxTokens = args.maxTokens === undefined ? 2000 : capMaxTokens(args.maxTokens);
      const fitted = fitTokenBudget(hits, maxTokens, (prefix) =>
        JSON.stringify({ hits: prefix, truncated: true, budgetExhausted: true }),
      );
      const result: Record<string, unknown> = {
        query,
        hits: fitted.items,
        conflicts: response.conflicts,
        provenance: response.provenance,
        truncated: fitted.budgetExhausted || response.hits.length > limit,
      };
      if (fitted.budgetExhausted) result.budgetExhausted = true;
      return this.applyIfHash(args, result);
    } finally {
      fts.close();
    }
  }

  /**
   * Gate 1.3 — `memory{op:'supersede'}`: retire a record in favour of a successor. `successor`
   * names an EXISTING record that replaces it; `claim` (with optional subject/kind/visibility/
   * propositionKey) writes a NEW memory-2 successor. The superseded line is never rewritten —
   * the lifecycle change is an appended `supersede` decision, and history/audit keep the full
   * trail. Idempotent: both the decision and a payload successor are content-addressed.
   */
  memorySupersede(args: {
    id: string;
    successor?: string;
    claim?: string;
    subject?: string;
    kind?: string;
    visibility?: 'private' | 'workspace';
    propositionKey?: string;
    actor: string;
    reason?: string;
    tool?: string;
    ifHash?: string;
  }): Record<string, unknown> {
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    const by: string | SupersedePayload =
      args.successor !== undefined
        ? args.successor
        : {
            claim: args.claim ?? '',
            ...(args.subject !== undefined ? { subject: args.subject } : {}),
            ...(args.kind !== undefined ? { kind: args.kind as MemoryRecordKind } : {}),
            ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
            ...(args.propositionKey !== undefined ? { propositionKey: args.propositionKey } : {}),
          };
    const result = api.supersede(args.id, by, {
      actor: args.actor,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.tool !== undefined ? { tool: args.tool } : {}),
    });
    if (!result.ok) return this.applyIfHash(args, { ok: false, error: result.error });
    return this.applyIfHash(args, { ...result });
  }

  /**
   * Gate 1.3 — `memory{op:'delete'}`: a tombstone, never a removal. Appends a `retract` decision
   * (memory is append-only — the record line stays; search excludes it, history/audit still see
   * it). Resolves legacy ids through the alias map, so a pre-migration id retires its twin.
   */
  memoryDelete(args: {
    id: string;
    actor: string;
    reason?: string;
    ifHash?: string;
  }): Record<string, unknown> {
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    const result = api.delete(args.id, {
      actor: args.actor,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    });
    if (!result.ok) return this.applyIfHash(args, { ok: false, error: result.error });
    return this.applyIfHash(args, { ...result });
  }

  /**
   * Gate 1.3 — `memory{op:'history'}`: the bi-temporal belief timeline for one key (a record id,
   * a legacy id, a subject, or a proposition key). Without `asOf` the full timeline; with `asOf`
   * a point-in-time read projection — only records recorded ≤ asOf and decision events with
   * ts ≤ asOf, i.e. what was BELIEVED then, never a rewrite of the store.
   */
  memoryHistory(args: {
    key: string;
    asOf?: string;
    withEvidence?: boolean;
    ifHash?: string;
  }): Record<string, unknown> {
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    let result: ReturnType<MemoryApi['history']>;
    try {
      result = api.history(args.key, {
        ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
      });
    } catch (err) {
      // An unparseable asOf is a REJECTED argument — reported honestly, never a silently
      // mis-filtered timeline (the API normalizes asOf once and throws on garbage).
      return this.applyIfHash(args, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.applyIfHash(args, {
      key: result.key,
      ...(result.asOf !== undefined ? { asOf: result.asOf } : {}),
      records: result.records.map((b) => this.recordBeliefView(b, args.withEvidence)),
      events: result.events,
    });
  }

  /**
   * Gate 1.3 — `memory{op:'sync'}`: the declared-but-honest non-capability. `sync` is in the
   * portable contract so every adapter can REGISTER the name, but no sync engine exists in this
   * release — the response says so, names the owning gate, and echoes the request untouched.
   */
  memorySync(args: { ifHash?: string }): Record<string, unknown> {
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    return this.applyIfHash(args, { ...api.sync() });
  }

  /**
   * G2.3 — `memory{op:'outbox'}`: the capture-outbox drain surface. Read-only reporting of the
   * LOCAL queue the distiller drains (the durable `cap:` entries capture/observe stage): how many
   * entries are pending / done / dead, what the pending work is, and — for drained entries — the
   * distill decision, its rationale, and whether crib VERIFIED it (the outbox entry's meta carries
   * the audit trail; the provider proposed, crib disposed). Retries ride the content-addressed
   * attempt events, so a pending entry's `retries` is exactly the distiller's failure count so far.
   * The outbox/dead collections are local-only (the no-poison rule), so this reads the local store
   * only and degrades to empty counts when it is absent.
   */
  memoryOutbox(args: { ifHash?: string }): Record<string, unknown> {
    const local = this.memory?.local;
    if (!local) return this.applyIfHash(args, { memory: 'not configured' });
    const pending = pendingCaptures(local);
    const dead = local.readCollection('dead').entries as CaptureOutboxEntry[];
    const done = (local.readCollection('outbox').entries as CaptureOutboxEntry[]).filter(
      (e) => e.status === 'done',
    );
    const pendingView = pending.slice(0, OUTBOX_ENTRY_CAP).map((e) => ({
      id: e.id,
      kind: e.kind,
      subject: e.subject,
      claim: e.claim,
      origin: e.origin,
      proposedAt: e.proposedAt,
      retries: captureRetryCount(local, e.id),
      ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
      ...(e.sessionOffset !== undefined ? { sessionOffset: e.sessionOffset } : {}),
      ...(e.eventOffset !== undefined ? { eventOffset: e.eventOffset } : {}),
    }));
    const deadView = dead
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, OUTBOX_ENTRY_CAP)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        subject: e.subject,
        claim: e.claim,
        ...(typeof e.meta?.deadLetterReason === 'string'
          ? { reason: e.meta.deadLetterReason }
          : {}),
      }));
    // Done entries newest-first (proposedAt is the capture's origin time), capped — the decision
    // trail is for orientation, not a full export.
    const doneView = done
      .sort((a, b) => String(b.proposedAt).localeCompare(String(a.proposedAt)))
      .slice(0, OUTBOX_DONE_CAP)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        subject: e.subject,
        proposedAt: e.proposedAt,
        ...(typeof e.meta?.candidateId === 'string' ? { candidateId: e.meta.candidateId } : {}),
        ...(typeof e.meta?.distillDecision === 'string'
          ? { decision: e.meta.distillDecision }
          : {}),
        ...(typeof e.meta?.distillRationale === 'string'
          ? { rationale: e.meta.distillRationale }
          : {}),
        ...(e.meta?.distillVerified === true ? { verified: true } : {}),
      }));
    return this.applyIfHash(args, {
      counts: { pending: pending.length, done: done.length, dead: dead.length },
      pending: pendingView,
      ...(deadView.length > 0 ? { dead: deadView } : {}),
      ...(doneView.length > 0 ? { done: doneView } : {}),
    });
  }

  /**
   * W3 — memory ledger status (PRD `memory_status`): counts by trust / evidence / applicability /
   * lifecycle / source, plus `eligible` (recall-eligible), `quarantined`, and `pending` (local
   * candidate entries not yet promoted to active records). `fresh: true` in provenance means the
   * counts reflect a live revalidation against the soul (evaluator configured), not just stamped
   * verdicts.
   */
  memoryStatus(args: { ifHash?: string }): Record<string, unknown> {
    if (!this.memory) return this.applyIfHash(args, { memory: 'not configured' });
    const all = this.gatherAllVerdicts(true);
    const trust: Record<string, number> = {};
    const evidence: Record<string, number> = {};
    const applicability: Record<string, number> = {};
    const lifecycle: Record<string, number> = {};
    const source: Record<string, number> = {};
    let eligible = 0;
    let quarantined = 0;
    for (const entry of all.entries) {
      const v = entry.verdicts;
      this.bump(trust, v.trust);
      this.bump(evidence, v.evidence);
      this.bump(applicability, v.applicability);
      this.bump(lifecycle, v.lifecycle);
      this.bump(source, entry.source);
      if (v.quarantined) quarantined += 1;
      if (isRecallEligible(v)) eligible += 1;
    }
    // pending = local candidate entries (candidate-trust, not yet promoted to active records).
    let pending = 0;
    const local = this.memory?.local;
    if (local) pending = local.readCollection('candidates').entries.length;
    const result = {
      counts: {
        total: all.entries.length,
        eligible,
        quarantined,
        pending,
        trust,
        evidence,
        applicability,
        lifecycle,
        source,
      },
      provenance: { fresh: all.fresh, errors: all.errors },
    };
    return this.applyIfHash(args, result);
  }

  /**
   * W3 — read-only memory audit (PRD `memory_audit`): a validation / conflict / drift / privacy /
   * trust report. `validation.drift` lists records whose fresh evidence/applicability verdict differs
   * from the stamped one (content drifted since the record was saved); `conflicts` lists the
   * conflict groups; `privacy` re-runs the write-time secret scan on every record (the store
   * guarantees 0 on write — audit confirms no secret slipped in via a raw shard edit); `trust` is the
   * trust distribution. Read-only: never mutates a record, a decision, or a store.
   */
  memoryAudit(args: { ifHash?: string }): Record<string, unknown> {
    if (!this.memory) return this.applyIfHash(args, { memory: 'not configured' });
    const all = this.gatherAllVerdicts(true);
    let drifted = 0;
    const drift: Array<Record<string, unknown>> = [];
    for (const { record, verdicts: fresh, stamped } of all.entries) {
      // G1.3: a memory-2 record carries no verdicts of its own — its stamped axes ARE the alias
      // snapshot (gatherAllVerdicts derives them); a fresh v2 observation has none at all, so
      // there is nothing stamped to drift against (reading record.verdicts crashed here before).
      if (stamped === undefined) continue;
      if (stamped.evidence !== fresh.evidence || stamped.applicability !== fresh.applicability) {
        drifted += 1;
        if (drift.length < 50) {
          drift.push({
            id: record.id,
            stamped: { evidence: stamped.evidence, applicability: stamped.applicability },
            fresh: { evidence: fresh.evidence, applicability: fresh.applicability },
          });
        }
      }
    }
    const conflicts = conflictGroups(all.entries).map((g) => this.conflictView(g));
    let secretsFlagged = 0;
    for (const { record } of all.entries) {
      try {
        assertNoMemorySecrets(record);
      } catch {
        secretsFlagged += 1;
      }
    }
    const trust: Record<string, number> = {};
    for (const { verdicts } of all.entries) this.bump(trust, verdicts.trust);
    // W5 Slice 3 — surface contradicted-for-review records (PRD W5 line 361: "surface it for review").
    // A `contradicted` feedback whose subject is NOT quarantined took only the bounded penalty and
    // awaits admissible counter-evidence; a `quarantined` verdict marks a record already suppressed.
    let quarantined = 0;
    for (const { verdicts } of all.entries) {
      if (verdicts.quarantined) {
        quarantined += 1;
      }
    }
    const localFeedback = this.memory?.local
      ? (this.memory.local.readCollection('feedback').entries as MemoryFeedback[])
      : [];
    const localQuarantineSubjects = quarantinedRecordIds(
      this.memory?.local
        ? (this.memory.local.readCollection('decisions').entries as MemoryDecision[])
        : [],
    );
    const forReview = contradictedForReview(localFeedback, localQuarantineSubjects).map((fb) => ({
      subject: fb.subject,
      actor: fb.actor,
      ts: fb.ts,
      ...(fb.context ? { context: fb.context } : {}),
    }));
    const result = {
      validation: { records: all.entries.length, drifted, drift },
      conflicts,
      privacy: { secretsScannedOnWrite: true, secretsFlagged },
      trust,
      feedback: {
        quarantined,
        contradictedForReview: forReview,
      },
      provenance: { fresh: all.fresh, errors: all.errors },
    };
    return this.applyIfHash(args, result);
  }

  /**
   * W4 — `memory_observe` (PRD line 239: "Writes a local candidate only"). The MCP server NEVER
   * evaluates, NEVER executes a gate, NEVER writes team memory (PRD line 68: only the CLI + CI
   * runner produce evaluation receipts). It stages an untrusted {@link MemoryCandidate} in the
   * LOCAL `candidates` collection — content-addressed, so a repeat observation of the same claim
   * upserts to the same `cand:` id (idempotent dedupe). Promotion to a trusted record is a separate
   * CLI/CI step (`crib memory evaluate`/`activate`/`propose`).
   *
   * G2.2 — the staging now flows through the portable {@link MemoryApi.observe}, i.e. the SAME
   * funnel capture uses: one capture-policy gate (secrets / PII / paths / transcripts always on),
   * then the durable `cap:` outbox write, then the staging entry — behavior-parity with the W4
   * contract (same validations, same messages, same response fields) plus the additive
   * `outboxId`/`idempotent` ack fields.
   *
   * Degrades to `{ memory: 'not configured' }` when no local store is wired (mirrors the vcs / read
   * verbs). A repo-scoped claim in a repo with no resolvable id is refused (the content id would be
   * unstable across machines) rather than silently written with a blank repoId.
   */
  memoryObserve(args: {
    kind: string;
    subject: string;
    claim: string;
    appliesTo?: string[];
    /** proposed evidence items (loose — the store schema-validates + secret-scans on write). */
    evidence?: ReadonlyArray<Record<string, unknown>>;
    actor: string;
    authorKind?: 'agent' | 'human';
    tool?: string;
    scopeBoundary?: 'repo' | 'global';
    attemptId?: string;
    /** G2.2 — caller-supplied dedupe key; part of the `cap:` outbox seed (never the `cand:` seed). */
    idempotencyKey?: string;
    ifHash?: string;
  }): Record<string, unknown> {
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    const result = api.observe({
      kind: args.kind,
      subject: args.subject,
      claim: args.claim,
      ...(args.appliesTo !== undefined ? { appliesTo: args.appliesTo } : {}),
      ...(args.evidence !== undefined ? { evidence: args.evidence as MemoryEvidence[] } : {}),
      actor: args.actor,
      ...(args.authorKind !== undefined ? { authorKind: args.authorKind } : {}),
      ...(args.tool !== undefined ? { tool: args.tool } : {}),
      ...(args.scopeBoundary !== undefined ? { scopeBoundary: args.scopeBoundary } : {}),
      ...(args.attemptId !== undefined ? { attemptId: args.attemptId } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    });
    if (!result.ok) {
      return this.applyIfHash(args, {
        ok: false,
        error: result.error,
        ...(result.violations !== undefined ? { violations: result.violations } : {}),
      });
    }
    return this.applyIfHash(args, {
      ok: true,
      id: result.id,
      status: result.status,
      origin: result.origin,
      scope: result.scope,
      outboxId: result.outboxId,
      idempotent: result.idempotent,
    });
  }

  /**
   * P0.2 — `memory{op:'capture'}`: automatic episodic capture to the candidate tier. `memory_observe`
   * is the disciplined path — the agent decides what is worth recording and produces grounded evidence
   * every time — but discipline that depends on agent diligence yields an empty ledger. Capture takes
   * the LOOSE form agents already have (what was attempted, what happened, which files/symbols were
   * touched) and writes it as a candidate with ZERO diligence required.
   *
   * What makes a capture more than diary text is the auto-anchor: the loose `symbols`/`files` refs are
   * resolved to soul ids via the same id → qualified-name → simple-name path the node verbs use, and
   * the first resolvable spanned symbol backs an automatically derived `source-quote` evidence item
   * (quote lifted verbatim from the rehydrated span, `targetHash` taken from the live node) — turning
   * a loose observation into a checkable claim. The derived quote is self-checked with the same
   * `verifyEvidence` grounding gate the enrich path uses before it is stamped `valid`, so the stamp is
   * earned, not assumed.
   *
   * Anchoring NEVER fails the capture (a capture that hard-fails on a typo'd symbol name is a capture
   * an agent stops making); the result reports `anchorStatus` — `anchored` / `ambiguous` (a name hit
   * several nodes, nothing guessed) / `unresolvable` / `unanchored` (no refs supplied) — so the caller
   * knows exactly how checkable the candidate is. The record is still candidate-trust: candidates live
   * in the LOCAL `candidates` collection and never enter normal recall (only `includePending` shares
   * them); promotion stays a separate CLI/CI step. Content-addressed like `memory_observe`, so a
   * repeat capture of the same observation upserts to the same `cand:` id. G2.2: the capture runs
   * the same unified staging funnel as observe — a capture-policy gate BEFORE anything is written
   * (typed `violations`, nothing dropped silently) and a durable `cap:` outbox entry written first
   * (acked as `outboxId` + `idempotent`) so a crash before the staging write replays.
   */
  memoryCapture(args: {
    /** the claim's topic key — a soul id, `art:` id, or `topic:<slug>` (mirrors observe). */
    subject: string;
    /** what was attempted / what happened, as free text. Becomes the candidate's claim verbatim. */
    observation: string;
    /** defaults to `fact` — the least presumptuous kind for a loose observation. */
    kind?: string;
    /** loose file paths touched — resolved to file nodes when they exist. */
    files?: string[];
    /** loose symbol names touched — resolved to soul ids; the first spanned one backs the evidence. */
    symbols?: string[];
    actor: string;
    tool?: string;
    scopeBoundary?: 'repo' | 'global';
    // G2.2 — durable-outbox capture-input fields (forwarded to the `cap:` id seed).
    idempotencyKey?: string;
    sessionId?: string;
    sessionOffset?: number;
    eventOffset?: number;
    ifHash?: string;
  }): Record<string, unknown> {
    const local = this.memory?.local;
    if (!local) return this.applyIfHash(args, { memory: 'not configured' });
    const api = this.memoryApi();
    if (!api) return this.applyIfHash(args, { memory: 'not configured' });
    // Gate 1.3 — delegate to the portable capture() (same validations, same messages, same
    // auto-anchor + self-checked quote evidence); the verb keeps only its response mapping.
    const result = api.capture({
      subject: args.subject,
      observation: args.observation,
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.files !== undefined ? { files: args.files } : {}),
      ...(args.symbols !== undefined ? { symbols: args.symbols } : {}),
      ...(args.tool !== undefined ? { tool: args.tool } : {}),
      ...(args.scopeBoundary !== undefined ? { scopeBoundary: args.scopeBoundary } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(args.sessionOffset !== undefined ? { sessionOffset: args.sessionOffset } : {}),
      ...(args.eventOffset !== undefined ? { eventOffset: args.eventOffset } : {}),
      actor: args.actor,
    });
    if (!result.ok) {
      return this.applyIfHash(args, {
        ok: false,
        error: result.error,
        ...(result.violations !== undefined ? { violations: result.violations } : {}),
      });
    }
    // Keep the MCP verb's exact W3 response contract: the portable CaptureSuccess adds `ok` and
    // `duplicate` and always-present arrays; the MCP surface keeps its conditional-array shape.
    // G2.2 adds the durable-outbox ack fields (`outboxId` + `idempotent`), and `ok: true` makes
    // the success shape symmetric with the policy-refusal shape (which carries `ok: false`).
    return this.applyIfHash(args, {
      ok: true,
      id: result.id,
      status: 'pending',
      origin: 'observe',
      scope: result.scope,
      anchorStatus: result.anchorStatus,
      evidenceAttached: result.evidenceAttached,
      outboxId: result.outboxId,
      idempotent: result.idempotent,
      ...(result.anchors.length > 0 ? { anchors: result.anchors } : {}),
      ...(result.ambiguous.length > 0 ? { ambiguous: result.ambiguous } : {}),
      ...(result.unresolvable.length > 0 ? { unresolvable: result.unresolvable } : {}),
    });
  }

  /**
   * W5 Slice 3 — `memory_feedback` (PRD line 241): "Writes a local feedback event; one negative event
   * cannot retract team memory." Records a LOCAL feedback signal (`useful` / `unhelpful` /
   * `contradicted`) on a memory record by id. The event is content-addressed → idempotent (a repeat
   * signal upserts to the same `fb:` id).
   *
   * For a `contradicted` signal, PRD W5 line 361 applies: the record is suppressed (quarantined)
   * LOCALLY only when supported by admissible counter-evidence (a `counterEvidence` item whose kind is
   * admissible for the record's claim kind AND whose verdict is `valid`); otherwise the record keeps a
   * bounded feedback penalty and is surfaced for review (`memory_audit` lists it under
   * `contradictedForReview`). The quarantine decision is written to the LOCAL `decisions` collection
   * ONLY — never team / global — so a single local negative event can never retract team memory (the
   * no-poison rule; recall folds local decisions into local records only).
   *
   * The MCP server never evaluates or executes anything here: `counterEvidence` is supplied by the
   * caller as pre-checked evidence items (kind + verdict); the suppression verdict is a pure decision
   * over those items, not a gate run. Degrades to `{ memory: 'not configured' }` when no local store
   * is wired.
   */
  memoryFeedback(args: {
    /** the `mem:` record id the feedback is about. */
    subject: string;
    /** `useful` / `unhelpful` / `contradicted` (PRD §2 MemoryFeedback). */
    signal: string;
    actor: string;
    context?: string;
    /**
     * Counter-evidence supporting a `contradicted` signal (PRD W5 line 361). Each item is a loose
     * evidence record (kind + verdict + anchor); admissibility is checked per item. Only admissible +
     * `valid` items trigger local quarantine. Ignored for non-`contradicted` signals.
     */
    counterEvidence?: ReadonlyArray<Record<string, unknown>>;
    ifHash?: string;
  }): Record<string, unknown> {
    const local = this.memory?.local;
    if (!local) return this.applyIfHash(args, { memory: 'not configured' });
    if (typeof args.subject !== 'string' || args.subject.length === 0) {
      return this.applyIfHash(args, { ok: false, error: 'subject is required' });
    }
    if (!isFeedbackSignal(args.signal)) {
      return this.applyIfHash(args, {
        ok: false,
        error: `invalid signal '${args.signal}' — expected one of useful, unhelpful, contradicted`,
      });
    }
    if (typeof args.actor !== 'string' || args.actor.length === 0) {
      return this.applyIfHash(args, { ok: false, error: 'actor is required' });
    }
    // resolve the record (local active → team records → global records) to learn its claim kind for
    // counter-evidence admissibility. A missing record is still recorded as feedback (the signal stands
    // for when the record appears), but admissibility cannot be checked → no suppression.
    const found = this.findMemoryRecord(args.subject);
    const claimKind = found?.record.kind;
    const counterEvidence = (args.counterEvidence ?? []) as unknown as MemoryEvidence[];
    const result = applyContradictedFeedback(local, {
      record: { id: args.subject, kind: claimKind ?? 'fact' },
      feedback: {
        id: '',
        schemaVersion: '1',
        signal: args.signal,
        subject: args.subject,
        actor: args.actor,
        ...(args.context ? { context: args.context } : {}),
        ts: new Date().toISOString(),
      },
      counterEvidence: claimKind ? counterEvidence : [],
      now: () => new Date().toISOString(),
    });
    if (result.suppression.suppress) {
      return this.applyIfHash(args, {
        ok: true,
        feedbackId: result.feedbackId,
        suppressed: true,
        quarantineDecisionId: result.suppression.decision.id,
        subject: args.subject,
        note: 'contradicted by admissible counter-evidence — record quarantined locally (team memory untouched)',
      });
    }
    return this.applyIfHash(args, {
      ok: true,
      feedbackId: result.feedbackId,
      suppressed: false,
      surfacedForReview: args.signal === 'contradicted',
      subject: args.subject,
      note:
        args.signal === 'contradicted'
          ? 'contradicted without admissible counter-evidence — bounded penalty applied, surfaced for review'
          : 'feedback recorded (bounded ranking adjustment only)',
    });
  }

  // ─── W3 memory helpers (private — NOT in PUBLIC_VERBS, so they bypass the Proxy trap) ────────

  /** The three memory stores as a RecallStores map, or undefined when memory isn't configured. */
  /**
   * Untrusted, in-flight observations from the LOCAL candidate pool — the shared working set for a
   * swarm of agents on one repository.
   *
   * The trust model deliberately hides these from normal recall: a claim becomes trusted by passing
   * a declared gate, never by an agent writing it down. That is correct, and this does not weaken
   * it. But with many agents working the same repo it also means every agent re-derives what its
   * neighbours already solved, because nothing crosses between them until a human or CI promotes
   * it.
   *
   * So they are returned in a SEPARATE group, never merged into `memories`, every entry stamped
   * `trust: 'untrusted'` and `status: 'pending'` — the same discipline that keeps code hits and
   * memory hits from being fused into one opaque list. A caller can act on a peer's finding while
   * knowing exactly what it is: a lead, not an established fact.
   */
  private pendingCandidates(query: string, limit: number): Array<Record<string, unknown>> {
    const local = this.memory?.local;
    if (!local) return [];
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2);
    const out: Array<{ score: number; view: Record<string, unknown> }> = [];
    for (const entry of local.readCollection('candidates').entries) {
      const rec = entry as unknown as Record<string, unknown>;
      const claim = String(rec.claim ?? '');
      const subject = String(rec.subject ?? '');
      const haystack = `${subject} ${claim}`.toLowerCase();
      const score = terms.length === 0 ? 1 : terms.filter((t) => haystack.includes(t)).length;
      if (score === 0) continue;
      out.push({
        score,
        view: {
          id: rec.id,
          kind: rec.kind,
          subject,
          claim,
          // MemoryCandidate ships the actor at `authorship.actor` (memory-1 schema); the id is
          // content-addressed over the same field, so this is the only place attribution lives.
          actor: (rec.authorship as { actor?: string } | undefined)?.actor,
          // Stated on every entry, not just in the group name, because a single view can be
          // copied out of its group and lose that context.
          trust: 'untrusted',
          status: 'pending',
        },
      });
    }
    return out
      .sort((a, b) => b.score - a.score || String(a.view.id).localeCompare(String(b.view.id)))
      .slice(0, limit)
      .map((x) => x.view);
  }

  private recallStores():
    | { team?: MemoryStore; local?: MemoryStore; global?: MemoryStore }
    | undefined {
    const mem = this.memory;
    if (!mem) return undefined;
    return { team: mem.team, local: mem.local, global: mem.global };
  }

  /**
   * Gate 1.3 — the portable {@link MemoryApi} over this repo's live ledger. Constructed per call
   * (it holds no state beyond the deps): the three stores from {@link MemoryDeps}, the soul as an
   * anchor port (capture's auto-anchoring), the repo's `.crib` dir (repoId resolution), the fresh
   * evaluator + context, and the current code HEAD (search provenance). `undefined` when memory
   * isn't configured — the memory verbs then degrade to the standard "not configured" body.
   */
  private memoryApi(): MemoryApi | undefined {
    const mem = this.memory;
    const stores = this.recallStores();
    if (!mem || !stores) return undefined;
    const head = this.vcsFacts().head;
    return new MemoryApi({
      stores,
      soul: new SoulStoreAnchorPort(this.deps.soul, this.deps.repoRoot),
      cribDir: this.deps.soul.cribDir,
      ...(mem.evaluator !== undefined ? { evaluator: mem.evaluator } : {}),
      ...(mem.evalCtx !== undefined ? { evalCtx: mem.evalCtx } : {}),
      ...(head ? { codeHead: head } : {}),
    });
  }

  /**
   * Gather + rank a recall projection. Builds a disposable IN-MEMORY FTS5 index from the gathered
   * records (the criterion-1 lexical signal — PRD line 333: never mixed with the soul's code BM25)
   * and runs the pure 6-criterion rank + conflict projection. When `fresh` is set AND an evaluator +
   * evalCtx are configured, records are revalidated against the live soul; otherwise stamped
   * verdicts are used. The FTS handle is closed in a finally — a `:memory:` DB holds no filesystem
   * lock, so the PRD's "never hold a FS lock across an evaluation command" rule is honoured.
   */
  private recallProjectionOf(opts: {
    query?: string;
    targetIds?: readonly string[];
    sources?: readonly MemorySource[];
    fresh?: boolean;
  }): RecallProjection | undefined {
    const mem = this.memory;
    const stores = this.recallStores();
    if (!mem || !stores) return undefined;
    const gathered = gatherRecall(stores, { sources: opts.sources });
    // G3.1 — persistent snapshot on the all-sources path, ephemeral rebuild under a sources filter
    // (subset corpora rank differently — see {@link lexicalChannel}). G3.2 — the versioned scorer
    // carries its configuration id on the projection provenance (red line #6).
    const { fts, scorer } = lexicalChannel(
      stores,
      gathered.records.map((r) => r.record),
      opts.sources !== undefined,
    );
    try {
      // G3.3 — bind the SAME generation-keyed cache `MemoryApi.search` binds (shared
      // `bindEvaluationPass`), so recall does not revalidate every record per query either (red
      // line #1): a memoized verdict is served while the dependency generations are unchanged.
      const freshReady =
        opts.fresh === true && mem.evaluator !== undefined && mem.evalCtx !== undefined;
      const bound: Partial<ReturnType<typeof bindEvaluationPass>> = freshReady
        ? bindEvaluationPass(mem.evalCtx, gathered)
        : { generation: null };
      const evalOpts =
        freshReady && mem.evaluator && mem.evalCtx
          ? { evaluator: mem.evaluator, evalCtx: bound.evalCtx ?? mem.evalCtx }
          : {};
      const projection = recallProjection(gathered, {
        query: opts.query ?? '',
        ...(opts.targetIds ? { targetIds: opts.targetIds } : {}),
        lexicalScorer: scorer,
        ...evalOpts,
      });
      // Red line #1 — the recall provenance names the generation the fresh verdicts were proven
      // current against (null when no versioned dependency could be fingerprinted).
      if (bound.generation !== undefined) {
        return {
          ...projection,
          provenance: { ...projection.provenance, generation: bound.generation },
        };
      }
      return projection;
    } finally {
      fts.close();
    }
  }

  /**
   * Gather ALL records (team + local + global) with their effective verdicts — not just the
   * recall-eligible subset. Used by `memory_status` (per-verdict tallies include ineligible
   * records) and `memory_audit` (drift = stamped vs fresh, over every record). `fresh: true` runs
   * the evaluator against the live soul; `fresh: false` uses stamped verdicts.
   *
   * G1.2/G1.3 — migrated (memory-2) records resolve their verdicts through the alias map EXACTLY
   * like `recallProjection`: every alias bound to the twin contributes its verdict snapshot
   * (conservative worst-axis merge) and every legacy-keyed decision bridges onto the record.
   * Without this, status/audit silently demote every migrated record to trust 'candidate' (the
   * v2 envelope has no verdicts of its own) and disagree with recall over the same ledger.
   */
  private gatherAllVerdicts(fresh: boolean): {
    entries: Array<{
      record: MemoryRecord | MemoryRecordV2;
      source: MemorySource;
      verdicts: EffectiveVerdicts;
      /** the as-stamped verdicts a drift check compares against (v2: the alias snapshot). */
      stamped?: Verdicts;
    }>;
    errors: string[];
    fresh: boolean;
  } {
    const mem = this.memory;
    const stores = this.recallStores();
    const entries: Array<{
      record: MemoryRecord | MemoryRecordV2;
      source: MemorySource;
      verdicts: EffectiveVerdicts;
      stamped?: Verdicts;
    }> = [];
    if (!mem || !stores) return { entries, errors: [], fresh: false };
    const gathered = gatherRecall(stores);
    const aliasIndex = buildAliasIndex(gathered.aliases ?? []);
    const evalFn =
      fresh && mem.evaluator && mem.evalCtx
        ? (r: MemoryRecord) => mem.evaluator?.evaluate(r, mem.evalCtx as MemoryEvalContext)
        : undefined;
    for (const { record, source } of gathered.records) {
      const evaluation = evalFn ? evalFn(record) : undefined;
      // No-poison (W5 Slice 2 + 3): local decisions overlay LOCAL records only; team/global decisions
      // are authoritative across stores. Folding local decisions into a team/global record would let a
      // single local negative event (quarantine / tombstone) retract team memory (PRD line 242).
      const decs =
        source === 'local'
          ? [...gathered.decisions, ...gathered.localDecisions]
          : gathered.decisions;
      // Alias-aware verdicts — the SAME pattern recallProjection applies (recall.ts), so status
      // and audit agree with recall over a migrated ledger instead of re-deriving worse axes.
      const asVersioned = record as MemoryRecord | MemoryRecordV2;
      const boundAliases = isMemoryRecordV2(asVersioned) ? aliasIndex.aliasesFor(record.id) : [];
      const recordDecs =
        boundAliases.length > 0 ? bridgedDecisions(boundAliases, record.id, decs) : decs;
      const migrated = conservativeVerdicts(boundAliases);
      const stamped = isMemoryRecordV2(asVersioned) ? migrated : record.verdicts;
      const verdicts = effectiveVerdicts(asVersioned, recordDecs, evaluation, migrated);
      entries.push({
        record: asVersioned,
        source,
        verdicts,
        ...(stamped !== undefined ? { stamped } : {}),
      });
    }
    return { entries, errors: gathered.errors, fresh: evalFn !== undefined };
  }

  /** Find one record by id across team `records`, local `active`, then global `records`. */
  private findMemoryRecord(id: string): { record: MemoryRecord; source: MemorySource } | undefined {
    const mem = this.memory;
    if (!mem) return undefined;
    if (mem.team) {
      for (const e of mem.team.readCollection('records').entries) {
        if ((e as MemoryRecord).id === id) return { record: e as MemoryRecord, source: 'team' };
      }
    }
    if (mem.local) {
      for (const e of mem.local.readCollection('active').entries) {
        if ((e as MemoryRecord).id === id) return { record: e as MemoryRecord, source: 'local' };
      }
    }
    if (mem.global) {
      for (const e of mem.global.readCollection('records').entries) {
        if ((e as MemoryRecord).id === id) return { record: e as MemoryRecord, source: 'global' };
      }
    }
    return undefined;
  }

  /** A lightweight evidence pointer (kind + verdict + soul anchor) — the default recall view. */
  private evidenceSummary(ev: MemoryEvidence): Record<string, unknown> {
    const out: Record<string, unknown> = { kind: ev.kind, verdict: ev.verdict };
    if (ev.soulId) out.soulId = ev.soulId;
    return out;
  }

  /** The public recall view of one scored record: verdicts + score + evidence (summary by
   *  default, full when `withEvidence`). Deterministic over the same projection (ifHash-stable).
   *  Version-aware: a memory-1 record keeps the W3 field set; a migrated memory-2 twin (which
   *  ranks when its alias snapshot restores eligibility) answers with its v2 fields instead of
   *  the undefined v1 ones. */
  private memoryView(m: ScoredRecord, withEvidence?: boolean): Record<string, unknown> {
    const r = m.record as MemoryRecord | MemoryRecordV2;
    const base: Record<string, unknown> = {
      id: r.id,
      subject: r.subject,
      claim: r.claim,
      source: m.source,
      trust: m.verdicts.trust,
      evidence: m.verdicts.evidence,
      applicability: m.verdicts.applicability,
      lifecycle: m.verdicts.lifecycle,
      score: m.score,
      evidenceItems:
        withEvidence === true ? r.evidence : r.evidence.map((e) => this.evidenceSummary(e)),
    };
    if (isMemoryRecordV2(r)) {
      return {
        ...base,
        schemaVersion: '2',
        visibility: r.visibility,
        propositionKey: r.propositionKey,
        validTime: r.validTime,
        transactionTime: r.transactionTime,
        lineage: r.lineage,
      };
    }
    return {
      ...base,
      scope: r.scope,
      appliesTo: r.appliesTo,
      createdAt: r.createdAt,
    };
  }

  /** The G1.3 search-hit view: the recall view's fields plus the rich search contract (freshness,
   *  validity, placement, per-hit conflicts, supersession) — mirrors `memorySearch`'s op doc. */
  private searchHitView(h: SearchHit, withEvidence?: boolean): Record<string, unknown> {
    const view = this.memoryView(
      {
        // ScoredRecord.record is typed MemoryRecord but a migrated twin is v2 at runtime — the
        // same widening recallProjection itself relies on; memoryView narrows via isMemoryRecordV2.
        record: h.record as MemoryRecord,
        // The EFFECTIVE store the projection resolved the hit from — the store whose verdict
        // overlay governs (same per-source field memory_recall reports). NOT placement[0]:
        // placement is local-first and storage-only; a record in local+team is two hits.
        source: h.source,
        verdicts: h.verdicts,
        score: h.score,
      },
      withEvidence,
    );
    return {
      ...view,
      schemaVersion: h.schemaVersion,
      verdicts: h.verdicts,
      visibility: h.visibility,
      ...(h.propositionKey !== undefined ? { propositionKey: h.propositionKey } : {}),
      ...(h.scope !== undefined ? { scope: h.scope } : {}),
      placement: h.placement,
      lineage: h.lineage,
      freshness: h.freshness,
      validity: h.validity,
      rankingVersion: h.rankingVersion,
      conflicts: h.conflicts,
      supersededBy: h.supersededBy,
    };
  }

  /** The G1.3 history view of one believed record (deterministic over the history projection). */
  private recordBeliefView(b: RecordBelief, withEvidence?: boolean): Record<string, unknown> {
    return {
      id: b.id,
      schemaVersion: b.schemaVersion,
      subject: b.subject,
      claim: b.claim,
      recordedAt: b.recordedAt,
      validTime: b.validTime,
      lifecycle: b.lifecycle,
      quarantined: b.quarantined,
      ...(b.validTimeHolds !== undefined ? { validTimeHolds: b.validTimeHolds } : {}),
      ...(b.validTimeWindow !== undefined ? { validTimeWindow: b.validTimeWindow } : {}),
      placement: b.placement,
      legacy: b.legacy,
      evidence:
        withEvidence === true
          ? b.record.evidence
          : b.record.evidence.map((e) => this.evidenceSummary(e)),
    };
  }

  /** A conflict-group view: the shared key + subject + scope + the member record ids. */
  private conflictView(g: ConflictGroup): Record<string, unknown> {
    return {
      key: g.key,
      subject: g.subject,
      scope: g.scope,
      recordIds: g.records.map((r) => r.id),
    };
  }

  /** Tally one into a string-keyed count map (noUncheckedIndexedAccess-safe via `?? 0`). */
  private bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
  }

  /**
   * M2.6 — stateless change-aware response cache. Fingerprints `result` with {@link ifHash} (BLAKE3
   * of its key-sorted serialization). When the caller echoes the same `hash` back as `ifHash` (the
   * value the previous call returned in its `hash` field), the whole body collapses to
   * `{ unchanged: true, hash }` — a ~30-byte stand-in for an unchanged 50 KB dossier, so a repeat
   * `context`/`dossier`/`source` call in the same agent session stops re-filling the input window.
   * Stateless: no session store, no cross-process state — the fingerprint is deterministic BLAKE3.
   */
  private applyIfHash(
    args: { ifHash?: string },
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    const hash = ifHash(result);
    if (args.ifHash !== undefined && args.ifHash === hash) {
      // M3.3 — a cache probe that HIT: caller echoed the prior hash → collapsed body. Only count
      // when `ifHash` was provided (a first fetch with no `ifHash` is not a cache probe, so it is
      // excluded from the hit-rate denominator).
      this.stats.recordCacheHit(true);
      return { unchanged: true, hash };
    }
    if (args.ifHash !== undefined) this.stats.recordCacheHit(false);
    return { ...result, hash };
  }

  /**
   * Working-tree facts from version control, cached for a short window.
   *
   * `status` is a health check an agent may call several times in one turn, and each call spawned
   * TWO git subprocesses. On this repo that is ~150ms per call, because `git status` walks 3,736
   * dirty files — churn the indexer itself produces.
   *
   * A short time window is the right cache key here, unlike everywhere else in this file where a
   * generation counter is available: the working tree changes through human action, which no
   * counter inside this process observes. Two seconds collapses an agent's burst of calls into one
   * git invocation while staying well inside the interval a person could notice.
   */
  private vcsMemo: { at: number; facts: { head: string; dirtyFiles: string[] } } | undefined;

  private vcsFacts(): { head: string; dirtyFiles: string[] } {
    const now = Date.now();
    const memo = this.vcsMemo;
    if (memo !== undefined && now - memo.at < VCS_FACT_TTL_MS) return memo.facts;
    const vcs = this.deps.vcs;
    if (vcs === undefined) return { head: '', dirtyFiles: [] };
    const facts = {
      head: vcs.currentHead(this.deps.repoRoot),
      dirtyFiles: vcs.uncommittedChanges(this.deps.repoRoot),
    };
    this.vcsMemo = { at: now, facts };
    return facts;
  }

  /**
   * The two expensive facts `status` reports, memoized against the counters that govern them.
   *
   * `status` is a health check an agent calls freely, but it was materializing the ENTIRE composite
   * graph (39ms) and re-reading every semantic artifact (11ms) on every call, purely to report node
   * and edge COUNTS. Both costs grew with enrichment — 494 artifacts made a health check the
   * slowest verb in the surface.
   *
   * Neither fact can change without one of these counters moving: `nodeGeneration` covers graph
   * mutation, `generation.semantic` covers every artifact save and prune. So a repeat call is a
   * pair of integer comparisons.
   */
  private statusFactsMemo:
    | {
        nodeGeneration: number;
        semanticGeneration: number;
        facts: { hasLlmGraph: boolean; composite: ReturnType<GraphStore['composite']> };
      }
    | undefined;

  private statusGraphFacts(): {
    hasLlmGraph: boolean;
    composite: ReturnType<GraphStore['composite']>;
  } {
    const nodeGeneration = this.deps.soul.nodeGeneration;
    const semanticGeneration = this.deps.soul.getManifest().generation?.semantic ?? 0;
    const memo = this.statusFactsMemo;
    if (
      memo !== undefined &&
      memo.nodeGeneration === nodeGeneration &&
      memo.semanticGeneration === semanticGeneration
    ) {
      return memo.facts;
    }
    const facts = { hasLlmGraph: this.llm.hasAnyFresh(), composite: this.graph.composite() };
    this.statusFactsMemo = { nodeGeneration, semanticGeneration, facts };
    return facts;
  }

  /**
   * Make sure the searchable projection of the authored semantic layer is current, then rank it.
   *
   * Rebuilt only when `generation.semantic` (bumped by every artifact save) has moved past what the
   * index was built at — so the common case is one integer comparison, and the rebuild cost falls
   * once per enrichment round rather than once per query.
   *
   * A target whose node has since disappeared is dropped: a code re-index can shift line numbers
   * and orphan an artifact, and a hit pointing at a node that no longer exists is worse than none.
   */
  private semanticHits(text: string, limit: number): Array<{ id: string; score: number }> {
    const index = this.deps.index as unknown as Partial<SemanticSearchable>;
    if (
      typeof index.semanticSearch !== 'function' ||
      typeof index.buildSemanticIndex !== 'function' ||
      typeof index.semanticIndexGeneration !== 'function'
    ) {
      return []; // a backend without semantic search degrades to code-only retrieval
    }
    const current = this.deps.soul.getManifest().generation?.semantic ?? 0;
    if (index.semanticIndexGeneration() !== current) {
      const entries = this.llm.allArtifacts().map((a) => {
        // Fold the target's own identity into the searchable text. Authored prose describes what
        // something DOES and often never names it — the hashing module's purpose reads "pure
        // JavaScript content hashing with no native bindings" and contains the word "blake3"
        // nowhere, so a query naming the algorithm could not reach its artifact at all.
        const node = this.deps.soul.getNode(a.targetId);
        const identity = [node?.name, node?.qualifiedName, node?.file].filter(Boolean).join(' ');
        return {
          targetId: a.targetId,
          layer: String(a.layer),
          purpose: String(a.analysis?.purpose ?? ''),
          detail: [
            identity,
            ...(a.analysis?.responsibilities ?? []),
            ...(a.analysis?.businessRules ?? []).map((r) => {
              const rec = r as Record<string, unknown>;
              return [rec.rule, rec.rationale].filter(Boolean).join(' - ');
            }),
          ].join('\n'),
        };
      });
      index.buildSemanticIndex(entries, current);
    }
    return index
      .semanticSearch(text, limit)
      .filter((h) => this.deps.soul.getNode(h.targetId) !== undefined)
      .map((h) => ({ id: h.targetId, score: h.score }));
  }

  private attachLlm(result: Record<string, unknown>, targetId: string, withLlm?: boolean): void {
    if (withLlm === false) return;
    // Inheritance-aware: a symbol with no artifact of its own still surfaces its file's or
    // cluster's purpose (tagged `inherited`), instead of reporting no meaning at all.
    // Default (withLlm undefined): fold the LIGHTWEIGHT pointer only — provenance + confidence +
    // one-line purpose — so a hit signals "LLM insight exists" without paying the multi-KB
    // analysis+graph+evidence blob. Full projection is opt-in via withLlm: true; this is the
    // token-cost discipline that keeps query/context/dossier lightweight by default.
    const { read, via, inherited } = this.llm.readInherited(targetId);
    const projection =
      withLlm === true ? llmProjection(read) : llmPointer(read, { via, inherited });
    // The same discriminator `brief` stamps per hit, grounded through the same readInherited
    // resolver: 'semantic' = authored prose backs this answer (directly or inherited from the
    // owning symbol/file/cluster), 'code' = the caller is holding structure and snippets only.
    // On single-symbol responses (context/dossier) this lands once on the response root.
    result.grounding = read.artifact === undefined ? 'code' : 'semantic';
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
    // M3.1 ownership — an `owner` node carries the git-blame author identity (email when blame
    // exposed one, else name-only). Surfaced so the `ownership` verb's owner records carry email.
    if (n.email) out.email = n.email;
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

function publicAnyEdge(e: Edge | CompositeEdge): Record<string, unknown> {
  return {
    ...publicEdge(e as Edge),
    ...('origin' in e ? { origin: e.origin } : { origin: 'extracted' }),
    ...('targetId' in e && e.targetId ? { targetId: e.targetId } : {}),
    ...('model' in e && e.model ? { model: e.model } : {}),
    ...('rationale' in e && e.rationale ? { rationale: e.rationale } : {}),
  };
}

/**
 * How the returned hits were FOUND, as opposed to how they are decorated.
 *
 * `coverage` counts hits carrying prose, and saturates once most files are described — a symbol
 * inherits its file's purpose regardless of relevance, so it reported 100% while the top hit for
 * "how do I debug a parser that hangs" was an unrelated Rust fixture. `matched` counts only hits
 * that authored meaning actually ranked, which is what tells a reader the semantic layer helped
 * find the answer rather than merely dressing it.
 */
function retrievalOf(views: Array<Record<string, unknown>>): Record<string, unknown> {
  const total = views.length;
  const matched = views.filter((v) => v.semanticMatch === true).length;
  return {
    matched,
    total,
    ...(total > 0 ? { ratio: Math.round((matched / total) * 100) / 100 } : {}),
  };
}

/**
 * Fuse hits ranked over AUTHORED MEANING with keyword hits, alternating from the front:
 * semantic #1, keyword #1, semantic #2, keyword #2, ...
 *
 * Chosen by measurement, not by theory. On a 20-question held-out set (real engineering questions,
 * each scored against every file that legitimately answers it):
 *
 *   keyword only ....... top-1 10%   top-3 10%   MRR 0.147
 *   reciprocal-rank .... top-1 40%   top-3 90%   MRR 0.649
 *   alternating ........ top-1 85%   top-3 90%   MRR 0.873
 *
 * Reciprocal-rank fusion is the textbook choice and it lost decisively here, because it treats the
 * two rankers as equally trustworthy. They are not: for a conceptual question ("how do I debug a
 * parser that hangs") the semantic ranker is usually right and keyword search is usually noise, so
 * damping the semantic top hit toward the keyword one actively destroys the answer. Alternating
 * preserves each ranker's own first choice.
 *
 * If you are tempted to replace this with RRF, re-run the eval first.
 *
 * Duplicates resolve to the keyword hit (it already carries its BM25 score and kind) but are still
 * flagged `semanticMatch`, so a caller can tell authored meaning helped FIND the hit.
 */
function fuseSemantic(
  keyword: Hit[],
  semantic: Array<{ id: string; score: number }>,
  soul: SoulStore,
  limit: number,
): Hit[] {
  if (semantic.length === 0) return keyword;
  const inKeyword = new Map(keyword.map((h) => [h.id, h]));
  const marked = keyword.map((h) =>
    semantic.some((s) => s.id === h.id) ? ({ ...h, semanticMatch: true } as Hit) : h,
  );
  const extra: Hit[] = [];
  for (const s of semantic) {
    if (inKeyword.has(s.id)) continue;
    const node = soul.getNode(s.id);
    if (node === undefined) continue; // artifact orphaned by a re-index
    extra.push({ id: s.id, kind: node.kind, score: s.score, semanticMatch: true } as Hit);
  }
  const out: Hit[] = [];
  for (let i = 0; out.length < limit && (i < extra.length || i < marked.length); i++) {
    if (i < extra.length) out.push(extra[i]!);
    if (out.length < limit && i < marked.length) out.push(marked[i]!);
  }
  return out;
}

/** Grounded-fraction self-report over the hits a response actually carries. */
function coverageOf(views: Array<Record<string, unknown>>): Record<string, unknown> {
  const total = views.length;
  const semantic = views.filter((v) => v.grounding === 'semantic').length;
  return {
    semantic,
    total,
    ...(total > 0 ? { ratio: Math.round((semantic / total) * 100) / 100 } : {}),
  };
}

/**
 * Below this grounded fraction the semantic layer is NOT answering the question, and the honest
 * move is to read source. Half the payload ungrounded is the floor; a coverage ratio is otherwise
 * easy to misread as a grade rather than a routing signal, so the hint spells the action out.
 */
const LOW_COVERAGE_RATIO = 0.5;
const LOW_COVERAGE_HINT = 'low semantic coverage — fall back to reading code for these hits';

/** The caller-facing low-coverage hint, present only when the ratio says so (absent at total 0). */
function lowCoverageHint(coverage: Record<string, unknown>): Record<string, unknown> {
  const ratio = coverage.ratio as number | undefined;
  return ratio !== undefined && ratio < LOW_COVERAGE_RATIO ? { hint: LOW_COVERAGE_HINT } : {};
}

function notFound(id: string): Record<string, unknown> {
  return { error: { code: 'NOT_FOUND', message: `no node with id ${id}` } };
}

/** M3.2 — resolve an id-or-name against an arbitrary soul (exact id, then qualified, then simple). */
function resolveIdInSoul(soul: SoulStore, idOrName: string): string | undefined {
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

/** M3.2 — de-duplicate + resolve repo roots, preserving order (primary first). */
function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (!r) continue;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
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
