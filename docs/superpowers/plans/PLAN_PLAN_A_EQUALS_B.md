# Knowledge-crib Robustness Plan — Make Plan A == Plan B, and preferable

**Goal:** Make the crib-driven migration plan (Plan A) produce the *same* output as the full-code-read plan (Plan B), and make crib the *preferred* path on efficiency + effectiveness.

**Author context:** Built from reading `packages/{core,mcp,parsers,pipeline,soul-schema,cli}` after running `crib index .` on `LoanOriginationEngine` (a PL/SQL rule engine migration target).

---

## 1. Current-state findings (what the code actually does today)

### 1.1 The lean-soul + rehydrate design (good foundation)
- Text is **never copied** into the soul — every node references source by `file` + `span` (`soul-schema/src/types.ts:30`). Bodies are rehydrated on demand from disk by `rehydrateBody` (`core/src/source.ts:64`), with char/line budgets + line-offset paging. So the body IS retrievable per node.
- The **derived index** (`core/src/index-store.ts`, `core/src/index/sqlite-index.ts`) is 100% rebuildable from the soul — `buildFromSoul(soul)` takes no options. Swappable backend (sqlite today, Kùzu stub exists).

### 1.2 The MCP server is already Plan-B-capable *per symbol* (`mcp/src/verbs.ts`)
- `context({id, withSource, withRules, withFramework})` — folds body + decision table + framework semantics into ONE call (verbs.ts:93).
- `source({id, startLine})` — paged full body (verbs.ts:165).
- `dossier({id})` — persisted deep artifact: body + callers/callees + linked docs + decision table + CFG constructs (raises/handles/iterates/declares). Cached on disk under `.crib/dossiers/` (verbs.ts:192).
- `extractRules({procedure})` — decision table from the guard-annotated CFG + a `coverage` readiness flag (verbs.ts:444).
- **`gaps()`** — already detects `unimplemented` (spec-only callables), `packageSpecsWithoutBody` (with `expectedBodyFile` mapping `_spec.sql → _body.sql`), `unresolvedCallSites`, and emits `analysisReadiness: 'incomplete' | 'complete'` (verbs.ts:485). **This is exactly the "the body is missing" finding I made manually** — crib already surfaces it, just not via the CLI.
- Edge vocabulary is already rich: `calls/describes/references/member-of/executes/reads/writes/raises/handles/iterates/declares/exposes/injects/renders/produces` (`soul-schema/src/enums.ts:30`); node kinds cover `table/column/statement/condition/exception-handler/raise/cursor/assignment/route/field`.

### 1.3 The gaps that make Plan A < Plan B today
| # | Gap | Where | Effect on Plan A |
|---|---|---|---|
| **G1** | FTS5 indexes **only** `name, qualifiedName, signature, heading, file` — **not the body** | `sqlite-index.ts:27`, `:255` | `query "DTI > 0.43"` cannot match the rule body; it matches only the signature. Discovery of logic-by-content is impossible. |
| **G2** | `query` returns **only a one-line snippet** (`rehydrate`, ≤160 chars) per hit — never the body, never the rules | `verbs.ts:324` (`snippet: rehydrate(...)`); CLI `cli.ts:242` | A single `crib query` gives signatures only. Getting logic needs N follow-up `source`/`context` calls. This is the "Plan A returns only signatures" symptom from the LoanOriginationEngine comparison. |
| **G3** | No vector/semantic search — `capabilities().vector = false` unconditionally; `embeddings: false` | `sqlite-index.ts:161`; `index-store.ts:67` | BM25 is synonym-poor: "debt-to-income" ≠ `EVAL_DTI_RATIO`. The `--semantic` flag only runs a TF-IDF *linker* (emits `references` edges), not a search path. |
| **G4** | No **bulk / package-level** context — bodies+rules are per-symbol only | `verbs.ts` has no `dossier by package` / `context by file` | For a 50-procedure package, Plan A needs 50 round-trips where Plan B reads one file. Aggregation efficiency gap. |
| **G5** | The rich verbs (`gaps`, `extractRules`, `context`, `dossier`, `impact`, `shortestPath`) are **MCP-only**; CLI exposes only `query` (signatures) | `cli.ts:104-124` | An analyst using `crib` on the CLI (or `claude -p` automation per cost-control rules) gets the *weak* path. The Plan A I ran used `crib query` and therefore missed everything the MCP already does. |
| **G6** | No "reconstruction" artifact for missing bodies | `gaps` *reports* missing; no verb *assembles* what's needed to re-author | For the LoanOriginationEngine case (body absent), Plan B reconstructs from signature+constants+prose. Crib reports the gap but doesn't emit the per-rule reconstruction spec. |

### 1.4 What is *not* a gap
- Thin edges in the LoanOriginationEngine index (4 `references`) are a **content artifact** (no body → no SQL statements to extract), already reported by `gaps` as `analysisReadiness: 'incomplete'`. The extractor/resolver vocabulary is sufficient; with a body present, `reads`/`writes`/`references`/`iterates` fire.

---

## 2. Workstreams

### WS-1 — Body-searchable FTS (closes G1)  *[highest leverage]*
**Change:** add a `body` column to `nodes_fts`, populated at index-build/delta time by rehydrating each node's span from disk (capped, e.g. first 8–16 KB per node; store `bodyTruncated` flag). The soul stays lean — only the *derived index* carries body text for search.

**Files:**
- `core/src/index/sqlite-index.ts` — add `body` to `FTS_COLUMNS` and the `CREATE VIRTUAL TABLE` DDL; in `insertNode`, rehydrate via `rehydrateBody(repoRoot, node, {maxChars: BODY_FTS_CAP})` and insert. `buildFromSoul` already has the soul; it needs `repoRoot` (currently not passed — thread it through `buildFromSoul(soul, repoRoot)` or store on the store). `applyDelta` likewise.
- `core/src/index-store.ts` — widen `buildFromSoul`/`applyDelta` signature to accept `repoRoot` (or add to `IndexStore` ctor). Update `IndexCapabilities` if needed (no).
- `core/src/index/factory.ts` + `pipeline/src/index.ts` — pass `repoRoot` when building.
- Tests: `sqlite-index.test.ts` — assert `query("DTI > 0.43")` hits `EVAL_DTI_RATIO` only when the body contains it; assert a body-less spec file still indexes signatures.

**Invariant preserved:** soul stays lean (text referenced, not copied); index remains 100% derived + rebuildable; deterministic verbs untouched. Body FTS is a search-only projection.

**Risk:** index size + build cost grow with body text. Mitigate with per-node char cap + `exprTruncated`-style honesty flag; benchmark on a large repo.

### WS-2 — `query` returns bodies + rules (closes G2)
**Change:** add optional fields to the `query` verb so one call returns what Plan B gets by opening the file:
```
query({ q, kinds?, limit?, withSource?, sourceMaxChars?, withRules?, extractedOnly? })
  → hits: [{ id, kind, score, snippet, body?, rules?, coverage? }]
```
- `withSource` → `rehydrateBody` per hit (respecting `sourceMaxChars`).
- `withRules` → `decisionTable` + `computeCoverage` per hit (only for callable hits).
- CLI: `crib query <text> [--with-source] [--with-rules] [--limit N]`.

**Files:**
- `mcp/src/verbs.ts` `query()` (verbs.ts:324) — add the options; reuse `bodyOf` + `decisionTable`/`computeCoverage` already on the class.
- `cli/src/cli.ts` `cmdQuery` (cli.ts:242) — parse `--with-source`/`--with-rules`/`--limit`, pass through, pretty-print.
- `mcp/src/server.ts` — expose the new params on the `query` tool schema.
- Tests: `verbs.test.ts` — one `query("EVAL_DTI_RATIO", {withSource:true, withRules:true})` returns body + decision table.

**Effect:** a single `crib query "DTI"` returns the symbol, its body, and its decision table — matching Plan B's "open the file and read the rule."

### WS-3 — Optional vector/semantic search (closes G3)
**Change:** add a pluggable embedding path so `capabilities().vector = true` when configured; off by default (preserve the no-network deterministic guarantee).

- New `core/src/index/vector-index.ts` (or sqlite-vec backed): embed node bodies + signatures at build, store vectors in a `node_embeddings(id, kind, embedding BLOB)` table, expose `vectorQuery(text, opts): Hit[]` (cosine ANN; sqlite-vec if available, else brute-force over a few thousand nodes).
- Embedder abstraction: `core/src/embedder.ts` with a local default (transformers.js / Xenova `all-MiniLM-L6-v2` style small model, runs in-process) and a pluggable external embedder (env `CRIB_EMBEDDER`). No embedder configured → `vector:false` as today.
- `IndexStore.query` becomes **hybrid**: BM25 ∪ vector, merge + rerank by normalized score; gate vector via `capabilities().vector` and an `IndexOpts.embeddings`/CLI `--embed` flag (distinct from the existing `--semantic` TF-IDF linker).
- Manifest `capabilities.embeddings = true` when built with embeddings.

**Files:** new `core/src/embedder.ts`, `core/src/index/vector-index.ts`; edits to `sqlite-index.ts` (add `vectorQuery`, change `capabilities()`), `index-store.ts` (`HybridQuery` gains `semantic?: boolean`; `IndexCapabilities.vector` already exists), `pipeline.ts` (`IndexOpts.embeddings`, call embedder after build), `cli.ts` (`crib index --embed`), `manifest.ts`/`types.ts` (capabilities already has `embeddings`).

**Phasing:** ship WS-1/WS-2 first (they recover most of Plan B's fidelity with zero new deps); WS-3 is the synonym-killer and is optional/heavier.

### WS-4 — Bulk / package-level context (closes G4)
**Change:** let one call return all bodies+rules+edges for a *package*, *file*, or *cluster* — the "read the whole SQL file" equivalent.

- New verb `dossierByScope({scope: 'package'|'file'|'cluster', id, withSource, withRules})` → returns an array of per-symbol dossiers (or a merged markdown). Internally walks `member-of` (package) / `file` filter / `clusterId` and reuses `buildDossier` per member, batched.
- CLI: `crib context --package PKG_LOAN_RULE_ENGINE --with-source --with-rules` (new `crib context` subcommand — see WS-5).
- Budget controls: `maxSymbols`, per-symbol `sourceMaxChars`, total char cap with truncation flags (honesty).

**Files:** `mcp/src/verbs.ts` (new verb + server wiring), `core/src/dossier/builder.ts` (batch helper), `cli/src/cli.ts`.

**Effect:** for the 50-procedure `PKG_LOAN_RULE_ENGINE`, Plan A makes **one** call and gets every body + decision table + edge; Plan B reads 1000 lines and cross-references manually. This is where crib becomes *more efficient* than Plan B.

### WS-5 — Expose rich verbs on the CLI (closes G5)
**Change:** add CLI subcommands mirroring the MCP verbs so analysts and `claude -p` automation get the strong path:

| CLI command | Verb | Purpose |
|---|---|---|
| `crib gaps [--extracted-only]` | `gaps` | analysis readiness + missing bodies + unresolved calls |
| `crib rules <proc> [--include-tables]` | `extractRules` | decision table + coverage |
| `crib context <id> [--with-source] [--with-rules] [--with-framework]` | `context` | deep per-symbol context |
| `crib dossier <id> [--format markdown]` | `dossier` | persisted deep artifact |
| `crib impact <id> --dir up\|down [--depth N]` | `impact` | blast radius |
| `crib path <from> <to>` | `shortestPath` | dependency path |
| `crib neighbors <id> [--rel reads]` | `neighbors` | direct edges |
| `crib query <text> [--with-source] [--with-rules]` | `query` | WS-2 enhanced search |

**Files:** `cli/src/cli.ts` (new `case` branches + thin wrappers reusing `Verbs`), `cli/src/registry.ts` if needed, tests `cli/src/*.test.ts`.

**Effect:** the Plan A I ran (`crib query`) would instead start with `crib gaps` → immediately learn the body is missing → `crib rules <proc>` / `crib context --with-source` per rule. Equals Plan B's manual discovery, faster.

### WS-6 — Reconstruction artifact (closes G6)
**Change:** a verb that, for each `unimplemented` callable, assembles what's needed to re-author the body — the "Plan B reconstructs from prose" step, automated and structured.

```
reconstruct({id | package})
  → [{ symbolId, signature, constants[], linkedDocs[], referencedTables[],
       decisionTable, coverage, expectedBodyFile, notes }]
```
- Gathers: signature (node), constants (package-level `CONSTANT` symbols already extracted as `assignment`/`field` nodes — verify), linked `doc-section`s via `describes`/`references` (the prose logic), `reads`/`writes` edges to tables (schema references), `coverage` (=`unimplemented`), and `expectedBodyFile` from `gaps`.
- CLI: `crib reconstruct <package> --format markdown` → emits a per-rule reconstruction spec an agent (or human) ports to .NET.

**Files:** new verb in `mcp/src/verbs.ts` reusing `gaps` + `describes` + `decisionTable` + `computeCoverage`; `core/src/dossier/` helper; `cli.ts` subcommand.

**Effect:** for the LoanOriginationEngine case, `crib reconstruct PKG_LOAN_RULE_ENGINE` emits per-rule {signature, the 2 thresholds (30/80), the ARCHITECTURE.md prose sections for that rule, the tables it reads, expected body file} — exactly the reconstruction input Plan B assembles by hand. This is the largest *effectiveness* win for migration specifically.

### WS-7 — Verify/extend SQL data-flow edges (defense-in-depth)
The vocabulary already has `reads/writes/references`. Confirm the `sql-resolver` + `schema-catalog` + `plsql-cfg` actually emit them for DML and SELECT INTO, cursor queries, and FK `references` between tables; add tests against a *body-present* fixture (the repo's PL/SQL tests use a loan-rule fixture — extend it with a synthetic body). This ensures that when a body IS present, the data-flow graph crib builds is as complete as Plan B's mental model.

**Files:** `pipeline/src/resolve/sql-resolver.ts`, `schema-catalog.ts`, `plsql-cfg.ts`, `parsers/src/plsql/PlSqlExtractor.ts`; tests in `resolve/*.test.ts` + a body-present fixture.

---

## 3. How this closes Plan A vs Plan B

| Plan B advantage (from the comparison doc) | Closed by |
|---|---|
| Captures constants (30/80) and exact logic | WS-1 (body searchable) + WS-2 (body returned) + WS-6 (reconstruction assembles constants+prose) |
| Finds logic by content (not signatures) | WS-1 (body FTS) + WS-3 (vector synonyms) |
| Detects missing body by exhaustion | Already in `gaps`; exposed to CLI by WS-5 |
| Sees dynamic dispatch / data-flow / caller contract | Edge vocabulary already present; WS-7 verifies; WS-4 surfaces per-package |
| Reads whole file in one pass | WS-4 (package-level dossier) — one call > one file read |
| Synonym handling (human reading) | WS-3 (vector search) |

| Plan A efficiency advantage once built | Reason |
|---|---|
| Sub-second discovery vs. reading 1818 lines | BM25+vector over the index |
| One call returns body+rules+edges | WS-2/WS-4 |
| `crib gaps` → missing-body verdict in ms vs. manual exhaustion | WS-5 |
| `crib reconstruct` → structured port spec vs. hand-assembly | WS-6 |

**End state:** `crib reconstruct PKG_LOAN_RULE_ENGINE` + `crib query --with-source --with-rules` produces the *same* migration input Plan B produces, faster, and additionally tells you (via `gaps`/`coverage`) exactly where the body is missing — which Plan B can only assert by reading everything.

---

## 4. Architecture invariants to preserve (do NOT break)
1. **Lean soul** — text referenced by `file`+`span`, never copied. WS-1/WS-3 put text only in the *derived index*, not the soul.
2. **Index is 100% derived** — `buildFromSoul(soul, repoRoot)` rebuilds it; no index-only state. WS-1 threads `repoRoot` through build (additive).
3. **Deterministic verbs never touch the network** — WS-3 vector path is opt-in; when no embedder is configured, `vector:false` and behavior is unchanged.
4. **Additive schema** — any new node/edge fields are optional (`SCHEMA_VERSION` bump 1.3→1.4, add to `SUPPORTED_SCHEMA_VERSIONS`); old souls load verbatim.
5. **Honesty flags** — `truncated`/`exprTruncated` discipline extended to body FTS cap (`bodyTruncated`) and vector absence.
6. **MCP ↔ CLI parity** — every new verb is exposed both ways (WS-5); no CLI-only or MCP-only analyst feature.

---

## 5. Phasing & effort

| Phase | Workstreams | Effort | Dependency |
|---|---|---|---|
| **P1 — Body discovery** | WS-1 + WS-2 + WS-5 (query/context/gaps/rules/dossier on CLI) | ~3–4 days | none. Recovers ~70% of Plan B fidelity with zero new deps. |
| **P2 — Bulk + reconstruction** | WS-4 + WS-6 | ~3 days | P1. The migration-specific effectiveness wins. |
| **P3 — Semantic search** | WS-3 | ~3–5 days | optional; can ship after P1. Needs an embedder choice (local Xenova default) + sqlite-vec or brute-force ANN. |
| **P4 — Edge verification** | WS-7 | ~2 days | independent; pair with a body-present fixture. |

**Recommended order:** P1 → P2 → P4 → P3. P1 alone makes `crib query --with-source --with-rules` + `crib gaps` equal Plan B for the LoanOriginationEngine case; P2 makes crib *preferable* (reconstruction in one call); P3 is the synonym-killer for harder corpora.

---

## 6. Acceptance criteria (the "Plan A == Plan B" test)
On the `LoanOriginationEngine` repo, after P1+P2:
1. `crib gaps` prints `analysisReadiness: 'incomplete'` and lists `PKG_LOAN_RULE_ENGINE` under `packageSpecsWithoutBody` with `expectedBodyFile: …/PKG_LOAN_RULE_ENGINE_body.sql`. ✅ matches Plan B's "body missing" finding.
2. `crib query "DTI ratio" --with-source --with-rules` returns `EVAL_DTI_RATIO` with its body (or `coverage: unimplemented` + linked docs when body absent) — the same content Plan B gets by reading the spec + ARCHITECTURE.md.
3. `crib reconstruct PKG_LOAN_RULE_ENGINE --format markdown` emits one section per rule with: signature, the two threshold constants (30/80), the linked `ARCHITECTURE.md` section(s), referenced tables, and `expectedBodyFile` — the full reconstruction input, machine-generated.
4. `crib context --package PKG_LOAN_RULE_ENGINE --with-source --with-rules` returns all 50 symbols' bodies+rules+edges in **one** call (where bodies exist) — strictly faster than Plan B's file read + cross-reference.
5. `crib status` reports `embeddings: false` by default (deterministic) and `embeddings: true` only after `crib index --embed` — invariant #3 holds.
6. All existing tests pass (`pnpm verify`); new tests cover body-FTS, `query --with-source/--with-rules`, `reconstruct`, CLI subcommands; biome + typecheck clean.

---

## 7. Risks
- **Index size blow-up (WS-1):** body text in FTS can be large. Cap per node + benchmark; consider FTS-only for `symbol`/`statement`/`doc-section` kinds (skip `column`/`cluster`).
- **Build-time file access (WS-1):** `buildFromSoul` now needs `repoRoot` + disk access; incremental `update`/`applyDelta` must rehydrate only changed nodes. Already the pattern for dossiers.
- **Embedder dependency (WS-3):** a local model adds a binary/dep. Keep it optional + behind a flag; the deterministic path must run with no embedder installed.
- **`reconstruct` honesty (WS-6):** when the body is missing, the reconstruction spec must say `coverage: unimplemented` loudly — never present prose+constants as if they were the implementation. Reuse `computeCoverage`.

---

**Bottom line:** crib already has the hard parts (`gaps`, `extractRules`, `dossier`, rehydration, rich edge vocabulary). The reason Plan A looked weak in the LoanOriginationEngine comparison is that (a) the CLI only exposed `query`-with-signatures, and (b) FTS didn't index bodies. WS-1 (body FTS) + WS-2 (query returns bodies/rules) + WS-5 (CLI exposes the rich verbs) close the equality gap; WS-4 (bulk) + WS-6 (reconstruct) make crib *preferable*; WS-3 (vector) handles the synonym tail. P1 is ~4 days and recovers most of Plan B with no new dependencies.