# Plan: Make Plan A Always Beat Plan B — Universal Extractor Edition

**Supersedes / generalizes:** `PLAN_MAKE_A_BEATS_B.md` (which was PL/SQL → .NET only).
**Repo:** `~/Projects/knowledge-crib`
**Date:** 2026-06-26
**Depends on:** `PLAN_PLAN_A_EQUALS_B.md` (P1+P2 complete), M0–M8 + M10–M14 done, schema 1.3 self-soul committed (07612f4, not pushed).

**Goal:** After this plan, a migration analyst using knowledge-crib (Plan A) on **any** of the 7 supported source languages (PL/SQL, Java, C#, Go, Rust, Python, TypeScript) porting to **any** supported target gets *strictly more* correct information, *strictly faster*, with *strictly less* human assembly than a colleague reading every source file by hand (Plan B). No extractor is left as a second-class citizen.

---

## 0. Decisions locked (from grilling)

| # | Decision | Choice |
|---|---|---|
| D1 | CFG parity scope | **All 7 extractors to full statement/condition/CFG parity first**, then layer migration features. |
| D2 | Search approach | **Hybrid.** Deterministic alias/tokenization layer now (zero deps); `VectorIndex` interface stubbed behind `--embed` for a later phase. |
| D3 | Migration targets | **Target-agnostic core + pluggable target packs.** Build out `dotnet`, `java`, `node-ts` packs now; `python`/`go`/`rust` packs slot in later. |
| D4 | Architecture | **Universal core verbs + per-language skill packs.** Structured work in `core`; language-specific prompts/type-maps/parity templates in `skills/`. |

---

## 1. Why Plan A still loses to Plan B today (universal gaps)

The PL/SQL-only plan listed 8 gaps (R1–R8). Generalizing to every extractor exposes **3 more** that are invisible when you only look at PL/SQL:

| # | Gap | Why Plan B wins today | Closes in |
|---|---|---|---|
| R1 | Synonym search | Human knows "debt-to-income" == DTI; crib BM25 does not. | Phase 2 |
| R2 | Body-present data-flow certainty | Only PL/SQL + Java/Spring + TS emit full CFG; C#/Go/Rust/Python are partial → crib is silent on their control flow. | Phase 0 |
| R3 | Target awareness | Crib treats migration as a one-repo source dump; no source↔target diff. | Phase 3 |
| R4 | Rule semantics | Crib returns guard-annotated decision tables, not human-readable rule sentences. | Phase 1 |
| R5 | Validation automation | No parity-test generator for any target language. | Phase 3 |
| R6 | Cross-package / multi-repo | Crib is single-repo only. | Phase 3 |
| R7 | Scale confidence | Untested on 10k+ symbol repos. | Phase 4 |
| R8 | Prose → logic enrichment | Crib links prose but does not convert it to structured rules. | Phase 4 |
| **R9** | **Per-extractor CFG parity** | C#/Go/Rust/Python do not all emit `condition`/`statement`/`executes`/`calls` CFG nodes, so `extractRules` returns nothing for them. (S65 track, failing tests: `guarded.go` missing, C# malformed-body degradation, Go `findProcedure` undefined.) | **Phase 0** |
| **R10** | **bodyAvailable marker** | No dossier field distinguishes "spec-only symbol" from "implemented symbol." A .NET target reader cannot tell what must be reconstructed. | Phase 1 |
| **R11** | **Language-agnostic rule templates** | Rule-semantics templates are implicitly PL/SQL-shaped (`if/then`, `case`, `EXCEPTION`). Java/Python/Go/C# have different idioms (try/catch, switch, match, elif, decorators). | Phase 1 |

---

## 2. Phases

### Phase 0 — Universal CFG parity (finish S65)  ~6 days
**Objective:** All 7 extractors emit the same guard-annotated CFG shape that `core/src/rules/extract.ts` already consumes, so `crib rules <proc>` works on any language.

**This is the gating phase.** Nothing in Phase 1+ is language-agnostic unless every extractor feeds the same CFG contract.

**Work per extractor** (all under `packages/parsers/src/<lang>/`):
- **C#** — fix malformed-body degradation test (1636/1642/1643): emit `condition`/`statement` nodes only within the method span; verify parse continues past stray operators. Add `executes`/`calls` edges with `cfgPath`/`guard`/`branch`/`inLoop`/`inException` stamps matching the PL/SQL convention.
- **Go** — restore `guarded.go` fixture (1637); fix `findProcedure` returning undefined despite symbol existing (1641). Emit CFG for `if/else/for/switch/select`.
- **Rust** — emit CFG for `if/else/match/loop/while`; map `match` arms to `branch` polarity (THEN/ELSE-equivalent) honestly (no fabricated polarity where the language has none).
- **Python** — emit CFG for `if/elif/else/for/while/try-except`; map `elif` to ELSIF, `except` to the exception-handler path convention.
- **Java / TS** — already at CFG parity per memory (Spring/React tracks complete); add a parity-coverage regression test so they cannot regress.
- **PL/SQL** — the reference; add it to the same parity-coverage suite.

**Shared contract** (`packages/parsers/src/types.ts`): formalize the CFG emission contract — `condition`, `statement`, `executes`, `calls` edges with the M11 stamp fields — as a documented interface every extractor must satisfy, plus a `cfgParity()` test helper that runs the same assertion suite across all 7.

**Acceptance:**
- `pnpm verify` green; the failing S65 tests (1636–1643) fixed.
- A new `parity-coverage.test.ts` row per language: each extractor emits ≥95% precision/recall on `condition`/`statement`/`executes`/`calls` edges against a per-language hand-derived fixture.
- `crib rules <proc>` returns non-empty results on a fixture procedure in **all 7** languages.

**Files:** `packages/parsers/src/{csharp,go,rust,python}/*`, `packages/parsers/src/types.ts`, `packages/parsers/src/parity-coverage.test.ts`, per-language fixtures under `packages/parsers/fixtures/<lang>/`.

---

### Phase 1 — Language-agnostic migration core  ~8 days
**Objective:** The structured migration intelligence lives in `core`, reads the universal CFG, and is callable for any source language. No PL/SQL-specific logic in `core`.

**1a. bodyAvailable + reconstructionSource markers (R10)**
- Add to every symbol node's dossier: `bodyAvailable: boolean`, `reconstructionSource?: string` (e.g. `ARCHITECTURE.md#section`), `expectedBodyFile?: string`.
- Each extractor sets `bodyAvailable: false` when only a signature/spec exists (PL/SQL spec-only packages, TS interface declarations, Java abstract methods, C# interface/abstract, Python stubs, Go interface methods, Rust trait decls without default impl).
- Surfaced in `crib gaps` and `crib reconstruct`.

**1b. `crib gaps <scope>` verb (closes R10, R2)** — language-agnostic gap report:
- Symbols with bodies available vs. missing.
- Rules whose logic lives only in linked prose (doc-section nodes).
- Constants captured vs. inferred.
- A signed gap list that says "reconstruct these N bodies before target coding starts."

**1c. `crib reconstruct <scope> --semantics` verb (R4, R11)** — rule-semantics layer:
- Extends `core/src/rules/extract.ts` to emit a `semantics` field per rule: `{ condition: string, action: string, priority: 'hard-reject'|'soft-scoring'|'...', references: string[] }`.
- **Language-agnostic template registry** (`core/src/rules/semantics-templates.ts`): `if/then`, `case/when`, `exception/on`, `switch/case`, `match/arm`, `elif`, `try/catch`, decorator-gated handlers. Each template knows its source language id. Honest limit: emit `condition: '<untranslatable idiom>'` rather than fabricate.
- Links doc-section nodes to the symbols they describe (already an edge type in schema 1.3).

**1d. `crib plan-migration <scope>` verb (R3, R6)** — dependency-graph-driven phase ordering:
- Phase order from `executes`/`calls` edges (orchestrator → drivers → atoms → resolver → audit), language-agnostic.
- Risk score per symbol: fan-in × body-complexity × prose-only-logic flag.
- Output: JSON / Markdown / CSV.

**Acceptance:** `crib gaps`, `crib reconstruct --semantics`, `crib plan-migration` all produce non-empty, correct output on a fixture in **each** of the 7 source languages, not just PL/SQL.

**Files:** `packages/core/src/dossier/{builder,reconstruct,by-scope}.ts`, `packages/core/src/rules/{extract.ts,semantics-templates.ts,gaps.ts}`, `packages/core/src/index.ts`, `packages/mcp/src/{server.ts,verbs.ts}`, `packages/cli/src/cli.ts`.

---

### Phase 2 — Search parity (hybrid)  ~3 days
**Objective:** `crib query "debt-to-income threshold"` returns `EVAL_DTI_RATIO` deterministically, with a clean extension point for embeddings.

**2a. Deterministic alias/tokenization layer (ships now)**
- Identifier tokenization: `EVAL_DTI_RATIO` → `eval dti ratio`; `debt-to-income` → `debt to income`.
- A small, curated alias dictionary (`core/src/search/aliases.ts`): `dti ↔ debt-to-income ↔ debt_to_income`, `auto-reject ↔ hard-reject`, etc. Editable, no model.
- `IndexStore.query` merges BM25 hits ∪ alias-expanded hits, normalized.

**2b. VectorIndex interface stub (deferred)**
- Add `core/src/index/vector-index.ts` as a no-op-default interface: `capabilities().vector = false` unless an embedder is configured.
- CLI: `crib query <text> --semantic` exists but warns "no embedder configured" until Phase 4 wires one. This keeps the deterministic path untouched and the interface stable.

**Acceptance:** `crib query "debt-to-income" --limit 5` includes `EVAL_DTI_RATIO` in the top-3 **without** any model download. `--semantic` is a recognized flag that degrades gracefully.

**Files:** `packages/core/src/search/{aliases.ts,tokenizer.ts}`, `packages/core/src/index/{vector-index.ts,sqlite-index.ts}`, `packages/core/src/index-store.ts`, `packages/cli/src/cli.ts`, `packages/mcp/src/server.ts`.

---

### Phase 3 — Target packs + parity generation + skill packs  ~8 days
**Objective:** Migration intelligence becomes target-aware and packaged per language pair.

**3a. Target packs (pluggable)**
- New directory `packages/core/src/migration/targets/` with one module per target: `dotnet.ts`, `java.ts`, `node-ts.ts` (built now); `python.ts`/`go.ts`/`rust.ts` slot in later behind the same interface.
- Each pack exports: `{ langId, typeMap: Record<SourceType, TargetType>, parityTestFramework, parityTestTemplate }`.
- `crib index-target <path> --lang <id>` indexes a target repo into a separate `.crib` at that root.

**3b. `crib migrationStatus` / `migrationDiff` (R3, R6)** — source↔target diff:
- Lists source symbols mapped vs. unmapped, target orphans, and per-symbol divergence notes.

**3c. `crib generate-tests <scope> --target <id>` (R5)** — parity-test generator:
- Reads example callers + rule edge cases; emits a compiling parity test per case in the target framework (xUnit for dotnet, JUnit for java, Jest for node-ts).
- Assertions only on stable outputs (decision, risk score, rate, amount, audit count).

**3d. Per-language skill packs**
- `skills/migrate-plsql-to-dotnet`, `skills/migrate-java-to-spring`, `skills/migrate-csharp-to-dotnet`, `skills/migrate-python-to-fastapi`, etc.
- Each pack: prompt template (ordered `gaps → reconstruct --semantics → plan-migration → generate-tests`), language-specific type-map, parity templates, escape hatches (body missing → `enrich-reconstruction`).

**Acceptance:** For `PKG_LOAN_RULE_ENGINE → dotnet`, `JavaService → java`, `ExpressApp → node-ts`: `crib migrationStatus` reports mapped/unmapped/orphan counts; `crib generate-tests` emits compiling tests in the right framework.

**Files:** `packages/core/src/migration/{targets/*.ts,status.ts,diff.ts,generate-tests.ts}`, `packages/mcp/src/verbs.ts`, `packages/cli/src/cli.ts`, `skills/migrate-*`.

---

### Phase 4 — Scale, self-hosting, optional LLM enrichment  ~6 days
**4a. Scale hardening (R7)** — `crib benchmark` on synthetic 1k/5k/10k/50k-symbol repos; lazy pagination for `dossierByScope`/`reconstruct`; documented SLOs (index <5s/1k symbols, query <100ms, reconstruct <1s/100 symbols).

**4b. Self-hosting** — `crib index .` on Knowlege-crib itself is a CI smoke test; the tool reasons about its own source.

**4c. Optional LLM enrichment (R8)** — `crib enrich-reconstruction <scope>` calls an LLM to convert linked prose → structured rule table. `provenance: ENRICHED`, `confidence`, never on the deterministic path, fails gracefully without `CRIB_LLM_API_KEY`.

**4d. Wire the VectorIndex** (the Phase 2 stub) to a local MiniLM via `--embed` only if you opt in; default stays off.

**Acceptance:** All Phase 0–3 commands <2s on a 10k-symbol repo; `pnpm verify` green; no regressions on P1/P2.

---

## 3. Per-extractor impact (the "every extractor" guarantee)

| Extractor | Phase 0 work | Phase 1 feed | Phase 3 target pack |
|---|---|---|---|
| **PL/SQL** | reference (parity-coverage only) | gaps/semantics/plan ✓ | dotnet (built), java/node-ts |
| **Java** | parity-coverage regression guard | ✓ | spring (built), dotnet/node-ts |
| **C#** | fix malformed-body + emit CFG | ✓ | dotnet (built) |
| **Go** | restore fixtures, fix `findProcedure`, emit CFG | ✓ | (later pack) |
| **Rust** | emit CFG for match/loop | ✓ | (later pack) |
| **Python** | emit CFG for if/elif/except | ✓ | (later pack) |
| **TypeScript** | parity-coverage regression guard | ✓ (React/Express/Nest already wired) | node-ts (built) |

If any row's Phase 0 work slips, that language gets `crib gaps`/`rules`/`plan-migration` only after it lands — the core verbs degrade gracefully (return empty + a `cfgParity: false` capability flag), never crash.

---

## 4. Acceptance criteria (the universal "Plan A > Plan B" test)

On a fixture migration in **each** source language → its primary target:

1. **CFG parity:** `crib rules <proc>` returns non-empty rules in all 7 languages.
2. **Synonym discovery:** `crib query "<synonym>" --limit 5` returns the right symbol top-3, no model download.
3. **One-call reconstruction:** `crib reconstruct <scope> --semantics --format markdown` returns constants, per-rule sentences, linked docs, `bodyAvailable` flags — strictly more than Plan B's manual notes.
4. **Gap report:** `crib gaps <scope>` lists missing bodies + prose-only rules in ms.
5. **Migration plan:** `crib plan-migration <scope> --target <id> --format markdown` produces dependency-ordered, risk-scored phases.
6. **Target diff:** `crib migrationStatus --source <s> --target <t>` reports mapped/unmapped/orphans.
7. **Generated tests:** `crib generate-tests <scope> --target <id>` emits compiling parity tests.
8. **Performance:** all commands <2s on a 10k-symbol repo.
9. **No regressions:** `pnpm verify` green; P1/P2 + schema 1.3 acceptance still pass.

---

## 5. Risks and guards

| Risk | Guard |
|---|---|
| Phase 0 slips block everything | Core verbs degrade gracefully (`cfgParity: false`); a language with no CFG still gets `gaps` on symbol-level body markers. |
| Per-language semantics templates fabricate meaning | Emit `<untranslatable idiom>` rather than guess; `provenance` stamps every derived field. |
| Target type-maps wrong | Convention-based, configurable, not authoritative; per-pack override file. |
| Generated parity tests brittle | Assert only stable outputs; never internal state. |
| Embeddings bloat creep | Interface stubbed; default off; only wires in Phase 4 with opt-in. |
| LLM enrichment hallucinates | `provenance: ENRICHED`, human review required, never on deterministic path. |
| Self-hosting circular dep | Self-index uses the previous stable build, not the in-flight one. |

---

## 6. Why this makes Plan A strictly better than Plan B — for every extractor

| Capability | Plan B (human read) | Plan A after this plan |
|---|---|---|
| Find rule by synonym | Manual grep | Alias-expanded BM25 (+ optional vectors) |
| Enumerate symbols + bodies + rules, any language | Read file, scroll, note | `crib context --package` / `--scope` |
| Reconstruct missing body, any language | Hand-assemble from prose | `crib reconstruct --semantics` |
| Human-readable rule sentences, any language | Manual inference | `crib rules --semantics` (language-aware templates) |
| Cross-repo source ↔ target diff | Two IDEs | `crib migrationStatus` |
| Phase-order a port, any language | Manual dep graph | `crib plan-migration` |
| Generate parity tests, any target | Manual authoring | `crib generate-tests --target <id>` |
| Prove no body is missing | Exhaustive read | `crib gaps` in ms |
| Scale to large codebases | Slower linearly | Sub-second via index |

**Bottom line:** Phase 0 makes the CFG universal. Phase 1–3 make migration intelligence language-agnostic at the core with language flavor isolated in skill packs. Plan B becomes a verification fallback; Plan A becomes the primary migration tool for **all 7** source languages.

---

*Author: Claude Code for Vishal Chawla*
*Supersedes: PLAN_MAKE_A_BEATS_B.md (PL/SQL-only)*
*Effort estimate: ~21 days across 5 phases, Phase 0 gating.*
