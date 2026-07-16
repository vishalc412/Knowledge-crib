# Plan: Make Plan A Always Beat Plan B — Knowledge-crib Supremacy Roadmap

**Goal:** After this plan, a `PL/SQL → .NET` migration analyst using knowledge-crib (Plan A) gets *strictly more* correct information, *strictly faster*, with *strictly less* human assembly than a colleague reading every SQL file by hand (Plan B).

**Current baseline:** P1 (WS-1, WS-2, WS-5) and P2 (WS-4, WS-6) of `PLAN_PLAN_A_EQUALS_B.md` are complete and adversarially verified on `LoanOriginationEngine`. Body-FTS, rich query, CLI parity, package-level dossier, and reconstruction are in place.

**What is left:** semantic search, full data-flow edge verification, migration-target awareness, rule-semantic extraction, automated parity tests, multi-repo planning, and scale hardening.

---

## 1. The equality gaps that remain (Plan A still weaker today)

| # | Gap | Why Plan B wins today | Closes in |
|---|---|---|---|
| R1 | **Synonym search** | A human reader knows "debt-to-income" == DTI; crib BM25 does not. | WS-A1 |
| R2 | **Body-present data-flow certainty** | Plan B reads a real body and sees every `SELECT`/`INSERT`; crib's SQL resolver is only tested on the spec-only fixture. | WS-A2 |
| R3 | **Target awareness** | Plan B knows .NET conventions; crib treats the migration as a one-repo source dump. | WS-A3 |
| R4 | **Rule semantics** | Plan B infers "if DTI > 43% then reject"; crib returns a decision table of guards, not a human-readable rule sentence. | WS-A4 |
| R5 | **Validation automation** | Plan B can run the existing `evaluate_single_application.sql` golden file; crib has no equivalent parity harness. | WS-A5 |
| R6 | **Cross-package / multi-repo** | Plan B can compare source vs target repos; crib is single-repo only. | WS-A6 |
| R7 | **Scale confidence** | Plan B has no index build time; crib is untested on 10k+ symbol repos. | WS-A7 |
| R8 | **Prose → logic enrichment** | Plan B reads `ARCHITECTURE.md` and turns prose into pseudo-code; crib only links the prose. | WS-A8 |

---

## 2. Workstreams

### WS-A1 — Semantic / vector search (finish WS-3)
**Objective:** `crib query "debt-to-income threshold"` returns `EVAL_DTI_RATIO` even though the body says `DTI`.

**Implementation:**
1. Add an optional `VectorIndex` module behind the `IndexStore` interface.
   - Default local embedder: `transformers.js` / Xenova `all-MiniLM-L6-v2` (Node 22, in-process, no network after first load).
   - Optional external embedder via `CRIB_EMBEDDER` env / config.
   - Store vectors in a new sqlite table `node_embeddings(id, kind, embedding)`.
   - ANN via `sqlite-vec` if installed, else deterministic brute-force over filtered nodes (acceptable up to ~50k nodes).
2. `IndexStore.query(q)` becomes hybrid: `BM25 hits ∪ vector hits`, merged and reranked by normalized score.
3. `capabilities().vector = true` only when an embedder is active; default remains `false` (deterministic path untouched).
4. CLI: `crib index --embed` and `crib query <text> --semantic`.

**Files:** `core/src/index/vector-index.ts`, `core/src/embedder.ts`, `core/src/index/sqlite-index.ts`, `core/src/index-store.ts`, `cli/src/cli.ts`, `mcp/src/server.ts`.

**Acceptance:** On `LoanOriginationEngine`, `crib query "debt-to-income" --semantic --limit 5` includes `EVAL_DTI_RATIO` and `EVAL_DTI_RATIO` is in the top-3.

**Effort:** ~4 days.

---

### WS-A2 — Body-present data-flow verification (finish WS-7)
**Objective:** When a package body *is* present, crib produces the same `reads`/`writes`/`executes`/`references` graph a human reader would draw.

**Implementation:**
1. Build a synthetic body-present PL/SQL fixture in `pipeline/fixtures/sql-dataflow/`:
   - A package with procedures that `SELECT`, `INSERT`, `UPDATE`, `DELETE`, open cursors, call other packages, and use dynamic SQL.
2. Run the PL/SQL extractor + SQL resolver on it.
3. Compare actual edges against a hand-derived expected graph. Fix false positives/negatives in:
   - `pipeline/src/resolve/sql-resolver.ts`
   - `parsers/src/plsql/PlSqlExtractor.ts`
   - `parsers/src/plsql/ast.ts` / `parser.ts`
4. Add a regression test that fails if data-flow precision drops below 95%.

**Acceptance:** The fixture produces ≥95% precision/recall on `reads`/`writes`/`calls`/`executes` edges; no regression on the existing spec-only fixture.

**Effort:** ~3 days.

---

### WS-A3 — Migration target awareness
**Objective:** Crib understands there is a *source* repo (PL/SQL) and a *target* repo (.NET), and it can diff them.

**Implementation:**
1. New manifest field `migrationTarget?: { repoRoot: string; lang: string; soulRef?: string }`.
2. New CLI: `crib index-target <path> --lang csharp` indexes the .NET target into a separate `.crib` at that root.
3. New verb `migrationStatus({sourcePackage, targetNamespace})`:
   - Lists symbols mapped vs. unmapped.
   - Flags symbols present in source but missing in target.
   - Flags target symbols with no source origin (orphans).
4. New verb `migrationDiff({symbol})` — side-by-side source dossier + target dossier + divergence notes.

**Acceptance:** For `PKG_LOAN_RULE_ENGINE` → `LoanOriginationEngine/dotnet`, `crib migrationStatus` reports 53 source symbols, mapped/unmapped counts, and the top-10 unmapped by criticality.

**Effort:** ~4 days.

---

### WS-A4 — Rule semantic extraction
**Objective:** Turn guard-annotated CFG nodes into human-readable migration rules.

**Implementation:**
1. Extend `extractRules` / `decisionTable` to emit a `semantics` field per rule:
   - `condition`: human sentence (e.g., "DTI ratio exceeds 0.43").
   - `action`: "REJECT", "WARN", "APPROVE", "MANUAL_REVIEW", etc.
   - `priority`: hard-reject vs. soft scoring.
   - `references`: constants and threshold names used.
2. Use deterministic templates from CFG constructs:
   - `if <expr> then <action>` → "If {expr} then {action}".
   - `case <selector>` branches → "When {value}: {action}".
   - Exception handlers → "On {exception}: {action}".
3. Add `crib rules <proc> --semantics` and `crib reconstruct <pkg> --semantics`.

**Acceptance:** `crib rules EVAL_DTI_RATIO --semantics` returns a sentence-level rule matching the intent described in `ARCHITECTURE.md`.

**Effort:** ~4 days.

---

### WS-A5 — Automated parity / golden-file test generation
**Objective:** Generate a test harness that proves the .NET port behaves like the PL/SQL source.

**Implementation:**
1. New verb `generateParityTests({package, examples})`:
   - Reads example callers like `evaluate_single_application.sql`.
   - Extracts input parameters (app_id, product, amount, tenure).
   - Emits an xUnit/NUnit test stub for each example + one per rule edge case.
2. Output: `dotnet/tests/LoanRuleEngine.Parity.Tests/generated/`.
3. CLI: `crib generate-tests PKG_LOAN_RULE_ENGINE --examples examples/evaluate_single_application.sql --out dotnet/tests/`.

**Acceptance:** Generated tests compile against the .NET skeleton and fail until the port matches the expected decision/risk/rate/amount outputs.

**Effort:** ~4 days.

---

### WS-A6 — Cross-repo migration planning
**Objective:** Plan a migration across source + target repos in one command.

**Implementation:**
1. New verb `migrationPlan({sourcePackage, targetNamespace, phases})`:
   - Phase ordering from dependency graph (orchestrator first, then categories, then atoms).
   - Risk scoring per symbol (fan-in, body complexity, prose-only logic).
   - Suggested .NET type mapping per PL/SQL type.
   - Recommended test coverage per phase.
2. Output formats: JSON, Markdown, CSV (for Jira/Notion import).
3. CLI: `crib plan-migration PKG_LOAN_RULE_ENGINE --target ./dotnet --format markdown`.

**Acceptance:** The generated plan for `PKG_LOAN_RULE_ENGINE` has ≥90% of its phase order matching an expert's manual ordering and explicitly flags the 30/80 thresholds as acceptance criteria.

**Effort:** ~5 days.

---

### WS-A7 — Scale and performance hardening
**Objective:** Crib stays sub-second on repos with 10k+ symbols.

**Implementation:**
1. Benchmark harness: `crib benchmark` on synthetic repos of 1k/5k/10k/50k symbols.
2. Profile and fix:
   - `buildFromSoul` file I/O — already cached per file; verify no N+1.
   - Dossier bulk build — already 1-scan; verify memory usage.
   - FTS query ranking — add `MATCH` limits before `ORDER BY` if needed.
3. Add lazy pagination for `dossierByScope` and `reconstruct` when `maxSymbols` is large.
4. Document performance budget: index build <5s per 1k symbols; query <100ms; dossierByScope <1s for 100 symbols.

**Acceptance:** On a 10k-symbol synthetic repo, `crib query`, `crib context`, and `crib reconstruct` each complete in <1s; `crib index` completes in <60s.

**Effort:** ~4 days.

---

### WS-A8 — Optional LLM enrichment for prose → logic
**Objective:** When a body is missing, use an LLM to convert linked `ARCHITECTURE.md` prose into a structured rule spec — but only when explicitly requested, never on the deterministic hot path.

**Implementation:**
1. New verb `enrichReconstruction({package, provider})`:
   - Takes the `reconstruct` output (constants, signatures, docs).
   - Calls an LLM with a deterministic prompt: "Given these signatures, constants, and prose sections, produce a rule table with conditions and actions."
   - Returns `enrichedRules` alongside `reconstruction`, clearly marked as `provenance: ENRICHED` and `confidence`.
2. Requires `CRIB_LLM_API_KEY` / config; fails gracefully with a message if unset.
3. Never runs during `index`, `query`, or `reconstruct` unless requested.

**Acceptance:** `crib enrich-reconstruction PKG_LOAN_RULE_ENGINE` produces a rule table where ≥80% of the 18 evaluators have a plausible condition/action derived from `ARCHITECTURE.md` prose.

**Effort:** ~3 days.

---

### WS-A9 — Deterministic self-hosting: crib eats its own soul
**Objective:** Knowledge-crib's own source graph is indexed and queryable, so the tool can reason about itself during development.

**Implementation:**
1. Ensure `crib index .` on `Knowlege-crib` itself produces a valid soul.
2. Add CI check: `pnpm verify` includes a self-index smoke test.
3. Use `crib query` in dev docs to find relevant code by intent.

**Acceptance:** `cd ~/Projects/knowledge-crib && crib index . && crib query "vector index" --with-source` returns the relevant core files.

**Effort:** ~1 day (mostly CI wiring).

---

### WS-A10 — Agent playbooks and migration skill packaging
**Objective:** Turn the improved Plan A into reusable agent instructions.

**Implementation:**
1. Add a `skills/` directory with a `migrate-plsql-to-dotnet` skill:
   - Prompt template: "Use `crib gaps`, `crib reconstruct`, `crib rules --semantics`, `crib plan-migration`, `crib generate-tests` in this order."
   - Example output format.
   - Escape hatches (body missing → use `enrich-reconstruction`).
2. Add a `playbooks/` directory with markdown runbooks for common migration phases.
3. Update `docs/knowledge-crib-user-guide.md` and `docs/knowledge-crib-mcp-api.md`.

**Acceptance:** A fresh `claude -p` invocation with `--allowedTools Read,Bash` and the skill prompt produces a credible first-cut migration plan for `PKG_LOAN_RULE_ENGINE` without opening a SQL file.

**Effort:** ~2 days.

---

## 3. Phasing

| Phase | Workstreams | Goal | Effort | Depends on |
|---|---|---|---|---|
| **P3 — Semantic + Verified Data-flow** | WS-A1, WS-A2 | Close the last pure-discovery gaps (synonyms, body-present certainty). | ~7 days | P2 |
| **P4 — Migration Intelligence** | WS-A3, WS-A4, WS-A6 | Make crib migration-aware and capable of producing human-readable rule specs + cross-repo plans. | ~13 days | P3 |
| **P5 — Validation Automation** | WS-A5, WS-A8 | Generate tests and optional LLM enrichment so the migration is verifiable. | ~7 days | P4 |
| **P6 — Scale + Self-hosting + Skills** | WS-A7, WS-A9, WS-A10 | Harden performance, dogfood the tool, and ship reusable agent playbooks. | ~7 days | P5 |

**Recommended order:** P3 → P4 → P5 → P6. Total: ~34 days of focused engineering.

---

## 4. Acceptance criteria (the "Plan A > Plan B" test)

On `LoanOriginationEngine` after all phases:

1. **Synonym discovery:** `crib query "debt-to-income auto-reject threshold" --semantic` returns `EVAL_DTI_RATIO` and `C_THRESHOLD_AUTO_REJECT` in the top-5. Plan B cannot search by synonym faster than crib.
2. **One-call reconstruction:** `crib reconstruct PKG_LOAN_RULE_ENGINE --semantics --format markdown` returns constants (30/80), per-rule sentences, linked docs, expected body file, and referenced tables — strictly more structured than Plan B's manual notes.
3. **Migration plan in one command:** `crib plan-migration PKG_LOAN_RULE_ENGINE --target ./dotnet --format markdown` produces a phased plan with dependency order, risk scores, and test recommendations.
4. **Generated tests:** `crib generate-tests PKG_LOAN_RULE_ENGINE` emits compiling parity tests for the .NET target.
5. **Target diff:** `crib migrationStatus --source ./LoanOriginationEngine --target ./dotnet` reports mapped/unmapped/orphan counts.
6. **Performance:** All commands above complete in <2 seconds on `LoanOriginationEngine`.
7. **No regressions:** `pnpm verify` green; existing P1/P2 acceptance criteria still pass.

---

## 5. Risks and guards

| Risk | Guard |
|---|---|
| Vector index bloat / slow build | Optional `--embed`; local small model; caps on embedding nodes. |
| LLM enrichment hallucinates rules | Marked `provenance: ENRICHED`; never on deterministic path; human review required. |
| .NET target mapping wrong | Keep mapping table configurable; default is convention-based, not authoritative. |
| Generated parity tests are brittle | Generate assertions only on stable outputs (decision, risk score, rate, amount, audit count). |
| Scale surprises | Benchmark harness runs before P6 ships; SLOs documented. |
| Self-hosting circular dependency | Self-index uses the *previous* stable build, not the in-flight one. |

---

## 6. Why this makes Plan A strictly better than Plan B

| Capability | Plan B (human read) | Plan A after this plan |
|---|---|---|
| Find rule by synonym | Manual grep/search | Vector search |
| Enumerate 50 symbols + bodies + rules | Read file, scroll, take notes | `crib context --package` |
| Reconstruct missing body | Hand-assemble from prose | `crib reconstruct --semantics` |
| Generate human-readable rule sentences | Manual inference | `crib rules --semantics` |
| Cross-repo source ↔ target diff | Two IDEs/tabs | `crib migrationStatus` |
| Phase-order a port | Manual dependency graph | `crib plan-migration` |
| Generate parity tests | Manual test authoring | `crib generate-tests` |
| Prove no body is missing | Exhaustive read | `crib gaps` in ms |
| Scale to large codebases | Slower linearly | Sub-second via index |

**Bottom line:** Plan B is a fallback for verification; Plan A becomes the primary migration tool.

---

*Prepared for the KnowledgeCrib project*
*Date: 2026-06-26*
*Depends on: PLAN_PLAN_A_EQUALS_B.md (P1+P2 complete)*
