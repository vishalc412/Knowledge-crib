# Knowledge-crib — Greenfield Build Plan (TypeScript)

> **All-new code** [Q1/Q2]. Inspired by GitNexus (deep analysis) + Graphify (indexing); **copies
> neither**. Runtime **TypeScript/Node** [Q36], OSS **Apache-2.0** [Q37]. Storage = **soul + index**
> per the [soul-format spec](knowledge-crib-soul-format.md). Ships as **one MCP server** [Q33].
> IP rule: read MIT Graphify freely; never paste PolyForm GitNexus source — reimplement ideas.

---

## 0. Repo & stack
- **pnpm monorepo.** Packages:
  | package | role |
  |---------|------|
  | `soul-schema` | JSON Schema + TS types for node/edge/manifest (the contract; spec B) |
  | `core` | `GraphModel`, `SoulStore`, `IndexStore` interfaces + impls |
  | `parsers` | tree-sitter wrappers (web-tree-sitter WASM; node bindings optional) |
  | `pipeline` | extract → resolve → link → cluster → index |
  | `mcp` | the MCP server (stdio), `npx knowledge-crib` |
  | `cli` | `crib index\|status\|query\|serve\|update\|reindex\|merge-driver\|install-hooks\|export\|viz\|mcp` (no `migrate` command) |
  | `ui` | web graph viz (later milestone) |
  | `soul-reader` | tiny engine-free reader for SeeroFlow / external [Q38] |
- **Parsing:** `web-tree-sitter` (WASM) for cross-platform; ~20 langs incrementally.
- **Index store:** behind an `IndexStore` interface — shipped default `better-sqlite3 + FTS5` (no `sqlite-vec` dependency; no vector/ANN path wired). LadybugDB + sqlite-vec remain a planned/not-wired future swap [C3]. Soul format is store-agnostic, so this swap is invisible upstream.
- **Apache-2.0** + `NOTICE` crediting GitNexus & Graphify as inspiration (no code reused).

## 1. Core seams (interfaces first — TDD around these)
```ts
interface SoulStore {                  // source of truth (spec B)
  putNodes(ns: Node[]): void; putEdges(es: Edge[]): void;
  getNode(id: string): Node | undefined;
  iterate(kind?: NodeKind): Iterable<Node>;
  commit(): void; load(): Manifest;     // chunked JSONL r/w + manifest
}
interface IndexStore {                  // derived, fast, rebuildable
  buildFromSoul(soul: SoulStore): void;
  query(q: HybridQuery): Hit[];         // BM25 + optional vector
  impact(id: string, dir: "up"|"down"): ImpactResult;
  neighbors(id: string, rel?: Rel): Edge[];
}
interface Extractor { name: string; supports(f: FileMeta): boolean;
  extract(f: FileMeta, ctx): { nodes: Node[]; edges: Edge[] }; }  // intra-file only
interface Linker { link(soul: SoulStore): Edge[]; }               // cross-modal pass
```

## 2. Pipeline (original code; mirrors the proven *phases*, not the source)
1. **Structure map** → `file` nodes.
2. **Parse** (tree-sitter) → `symbol` nodes + intra-file edges.
3. **Resolve** imports/calls/inheritance/receiver-types → cross-file edges (`method:static`, `provenance:EXTRACTED`).
4. **Doc-extract** (Markdown) → `doc-section` nodes (text referenced by span, not copied).
5. **Cross-modal link** → `describes`/`references` edges (deterministic signals = EXTRACTED; semantic = INFERRED). Conflict rule per spec B §3.
6. **Cluster** (Leiden/Louvain JS) → `clusters.jsonl`.
7. **Index** → `IndexStore.buildFromSoul` (BM25 + optional vectors).
*All writes land in `SoulStore` first; the index is built from it.*

## 3. MCP server (the product)
- TS MCP over stdio; `npx knowledge-crib` → any agentic IDE.
- Resolves `.crib/` from repo root → serves **that project's** soul (per-project memory) [Q33].
- **Verbs:** `index` · `update` · `context(symbol)` · `impact(symbol,dir)` · `query(hybrid)` · `describes(symbol)` · `detect_changes` · `route_map`/`shortest_path`. Reads `IndexStore`, falls back to `SoulStore`.
- Doc payloads bounded (top-N by confidence + `truncated` hint) → token-budget aware [Q25].

## 4. Incremental + git
- `crib update` (post-commit hook) → re-extract changed files → rewrite affected soul chunks → rebuild touched index slice (spec B §5).
- `.crib` **merge driver** applies the deterministic conflict rule on chunk conflicts.

## 5. Milestones (each = one flagged PR + test gate)
| M | Deliverable | Test gate |
|---|-------------|-----------|
| **M0** | `soul-schema` + `SoulStore` (chunked JSONL r/w + manifest) | round-trip nodes/edges → chunks → reload, byte-stable |
| **M1** | `IndexStore` iface + default impl (`buildFromSoul`, query) | build from a fixture soul, query returns expected |
| **M2** | parse pipeline, 1 lang (TS) → symbols + intra-file edges | fixture file → expected nodes/edges |
| **M3** | resolve pass (cross-file imports/calls) | call-edge **precision** on fixture repo |
| **M4** | doc-extractor (MD) + cross-modal linker (deterministic) | doc↔symbol link **precision** measured |
| **M5** | MCP server: `context`/`impact`/`describes`/`query` | **E2E wedge assertion** (below) |
| **M6** | incremental `update` + git hook + merge driver | edit 1 file → only its shard chunks change |
| **M7** | clustering + web UI viz + semantic linker signal | cluster labels render; semantic recall tuned |
| **M8** | more languages (plugin extractors) | per-lang fixtures |
| **M9** | `soul-reader` pkg + SeeroFlow Tier-1 read contract | flow loads context engine-free [Q38] |
| **M10** ⭐ | PL/SQL extractor + SQL data-flow (`table`/`column`/`statement`, `reads`/`writes`/`executes`) | golden: package → expected procs/tables/edges |
| **M11** ⭐ | CFG pass + `guard`/`cfgPath`/`branch` on calls + `condition` nodes | guard-chain correct on a branchy fixture proc |
| **M12** ⭐ | `extract_rules` verb + `export --format rules` (the rule book) | decision-table matches hand-derived rules |
| **M14** ⭐ | framework-semantics layer (schema 1.3): new kinds `route`/`field`/`component`, new rels `exposes`/`injects`/`renders`/`produces`; Spring track (stereotypes/routes/DI/JPA `references`/`@Bean` produces/columns/`@PreAuthorize` security/`@ExceptionHandler`→`exception-handler`+`handles`); surfacing tier (`context withFramework`, dossier framework+`shapeVersion:2`, `gaps` anomalies `controllersWithoutRoutes`+`unresolvedInjects`, viz 1.3 fields); cross-language parity (TS/Java/C#/Go/Rust/Python via `meta.recursive`) | Spring parity: `route.meta.params`/`security`, `field.meta.column`, `references` cardinality; `framework.test.ts` + `validate.test.ts` green |
| later | optional Python offline worker (PDF/image/whisper) | multimodal fixtures [Q32] |

**E2E wedge assertion (M5):** index a repo with `/docs`; agent calls `impact("AuthService","up")`
→ response contains code blast-radius **and** ≥1 `doc-section` linked by `describes` with provenance
snippet. Wedge proven.

**Migration track (M10–M12, ⭐ first-class [Q39]):** depends on M0–M3 (storage + parse + resolve);
runs alongside M4–M5. Validates on a real PL/SQL package; deliverable = the **rule book**
(`crib export --format rules`). The conditions (`cfgPath`) are deterministic/EXTRACTED — no LLM in
the rule path. See [deep-extraction](knowledge-crib-deep-extraction.md).

## 6. Token-cut proof (headline metric [Q25])
Benchmark harness: same task, agent-reads-files vs agent-queries-crib. Record tokens/task. Gate M5
on a measurable reduction while *adding* doc context.

## 7. Risks & guards
| Risk | Guard |
|------|-------|
| Greenfield effort | Narrow MVP first (M0–M5); defer multimodal/langs/UI |
| Index store licensing [C3] | `IndexStore` iface + sqlite fallback; soul unaffected |
| Noisy INFERRED links | provenance + confidence + `--link-threshold`; EXTRACTED-only view |
| Soul ↔ index drift | single-writer; index always rebuildable from soul |
| Parser perf on huge files | WASM worker pool + `--worker-timeout`; incremental updates |

## 8. Open confirmations (don't block M0)
- **C4 scale** (largest repo) → tunes `maxChunkLines` + shard width.
- **C3** Ladybug embeddable? → else sqlite fallback is default.
- **C5** local-only vs hosted → affects MCP transport/auth later.
