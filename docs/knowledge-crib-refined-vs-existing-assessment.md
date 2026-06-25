# Knowledge-crib — Refined vs Existing: Detailed-Level Analysis Assessment

> Formal comparison artifact + six-role judgment, per the governing plan
> (`/Users/vishalchawla/.claude/plans/do-you-need-your-federated-pike.md`).
>
> **Question under review:** Does the refined implementation capture *detailed-level* analysis (the
> kind a migration analyst or a local LLM needs to rebuild a rule engine on another stack), and how
> does it differ from the existing implementation that preceded this plan?
>
> **Scope of "existing":** the shipped state before this plan — schema 1.0/1.1, structure + call
> graph + CFG guard-chain (M10–M12), serving-layer `context`/`source`/`extract_rules`, and the M14
> four-language extractors (Java/C#/Go/Rust) that emitted only member-of + intra-file calls +
> Track-3 statement/condition/CFG edges.
>
> **Scope of "refined":** schema **1.2** behavior nodes + rels/fields, PL/SQL behavior fidelity
> (Workstream B), the persisted **dossier** verb/artifact (Workstreams D + E), and **six-language
> parity** for the 1.2 constructs (Workstream C). Verified: 392 tests green, `pnpm -r build` clean
> (7 projects), biome clean.

---

## 1. Comparison artifact — existing vs refined

### 1.1 What each model can answer about ONE procedure

| Question a migration analyst asks | Existing (1.0/1.1 + Track 3) | Refined (1.2 + dossier) |
|---|---|---|
| What does this proc call, and under what condition? | ✅ `calls` + `cfgPath` guard chain | ✅ unchanged, preserved |
| Which tables/columns does it read/write? | ✅ `reads`/`writes` (PL/SQL) | ✅ unchanged |
| What is the full source body? | ✅ `source` (span rehydration) | ✅ unchanged, now paged in dossier |
| What is the decision table (condition→action)? | ✅ `extract_rules` (PL/SQL) | ✅ now works for ALL 7 languages |
| **What error codes can it raise, and under which conditions?** | ❌ not captured | ✅ `raise` nodes (`errorCode`/`errorMessage`) + `raises` edge carrying the guard chain |
| **Which exception handlers catch which raises?** | ❌ not captured | ✅ `exception-handler` nodes (`whenSelector`) + `handles` edges |
| **Which cursors does it declare and iterate?** | ❌ not captured | ✅ `cursor` nodes (`cursorQuery`) + `declares`/`iterates` edges |
| **What does each CASE arm decide?** | partial — `condition` node per IF | ✅ `case-branch` nodes (`whenSelector`, omitted for ELSE/default/`_`) |
| **What are the assignment targets (the state mutations)?** | ❌ not captured | ✅ `assignment` nodes (`assignTarget`) |
| **What does the doc comment above the symbol say?** | partial — `describes` from markdown linker | ✅ `explanation` nodes (`commentRef`/`meta.text`) + `describes`, per-symbol, all languages |
| **Can I get all of the above in ONE call, cached on disk?** | ❌ multiple verbs, no cache | ✅ `dossier` (json/markdown), persisted under `.crib/dossiers/`, hash-anchored |

### 1.2 Concrete before/after — the loan-rule-engine procedure

Fixture: `assess_application` (PL/SQL) — FOR-loop over cursor `c_app`, searched CASE (3 arms),
`RAISE_APPLICATION_ERROR(-20001 …)` on REJECT, `EXCEPTION WHEN NO_DATA_FOUND / WHEN OTHERS` with
`RAISE_APPLICATION_ERROR(-20002 …)`.

**Existing output** (call graph + decision table only):
```
assess_application
  executes: UPDATE loan_applications  (cfgPath: [CASE])
  calls:    — (no cross-proc calls)
Decision table: 1 rule — UPDATE @ CASE branch
```
This says *a proc that updates a table under a CASE*. It is **structure**, not behavior. It does not
tell you the proc can reject a loan, what error it raises when it does, or that NO_DATA_FOUND is
recovered while OTHERS re-raises -20002. A migration analyst rebuilding this in Java/.NET would have
to **re-read the source** to recover those facts — exactly the token/compute burn crib exists to
prevent.

**Refined output** (`dossier` markdown, one call):
```markdown
# loan_engine.assess_application
## Decision table        — 1 rule, conditions: [CASE]
## Raises
- -20001 application rejected: insufficient credit
- -20002 assess_application failed
## Exception handlers
- WHEN NO_DATA_FOUND
- WHEN OTHERS
## Iterates (cursors)
- c_app
## Declares
- cursor c_app  `SELECT amount, status, credit_score FROM loan_applications WHERE id = p_id`
## Source
…full body, paged…
```
This **is** the detailed-level analysis: the rule (decision table), the failure modes (raises with
codes + the guard chain that fires them), the recovery surface (handlers), the data iteration
(cursor + its query). Verified by `packages/pipeline/src/dossier-e2e.test.ts` (2 tests: content +
byte-stable re-index).

### 1.3 What changed in the contract (deterministic, forward-compatible)

- **Schema 1.2** (additive; 1.0/1.1 souls load verbatim, loader never widens; 1.1
  `cfgPath:string[]` + `inLoop`/`inException` preserved). Verified by `soul-store.test.ts` round-trip (10 tests).
- New node kinds: `raise`, `exception-handler`, `assignment`, `case-branch`, `cursor`.
- New rels: `raises`, `handles`, `iterates`, `declares` (`describes` already existed; now also emitted
  intra-file from comments).
- New node fields: `errorCode`, `errorMessage`, `whenSelector`, `assignTarget`, `cursorQuery`,
  `constraints`, `commentRef`.
- New persisted artifact: `.crib/dossiers/<shard>/<hash>.json` (sharded by `blake3(nodeId).slice(0,2)`,
  atomic, hash-anchored to `node.hash`).
- All new edges: `provenance: EXTRACTED`, `confidence: 1`, `method: static` — **no LLM in the rule
  path**. The guard chain still stamps `cfgPath`/`branch`/`inLoop`/`inException` on `raises`/
  `executes`/`calls` edges, so a raise knows the *conditions under which it fires*.

### 1.4 Six-language coverage (parity matrix)

| Construct | PL/SQL | TS | Java | C# | Go | Rust | Python |
|---|---|---|---|---|---|---|---|
| raise | ✅ | ✅ | ✅ | ✅ | ✅ panic/errors.New | ✅ panic!/return Err | ✅ |
| exception-handler | ✅ WHEN | ✅ catch | ✅ catch+multi | ✅ catch+when filter | ✅ defer recover | ⛔ skipped (no try/catch) | ✅ except/tuple/bare |
| assignment | ✅ := | ✅ | ✅ | ✅ | ✅ | ✅ let/= | ✅ =/:=/aug |
| case-branch | ✅ CASE | ✅ case | ✅ case+default | ✅ case+switch-expr | ✅ case+type-switch | ✅ match arm | ✅ case+_ |
| explanation | ✅ | ✅ | ✅ Javadoc | ✅ /// | ✅ | ✅ /// | ✅ docstring/# |
| cursor / iterates | ✅ full | n/a | n/a | n/a | n/a | n/a | n/a |

Capability-honest skips are documented per extractor (cursor/iterates are PL/SQL-only; Rust has no
exception handler — a `match` on `Result` is already a `case-branch`, so a handler would
double-count; `iterates` over a non-resolvable local collection is skipped rather than guessed).

---

## 2. Six-role judgment — does it capture detailed-level analysis?

### 2.1 Principal Engineer
**Verdict: yes.** The refined model closes the behavior gap that made the existing model a skeleton.
The load-bearing design decision is that behavior constructs are **first-class graph nodes with
deterministic ids**, not free-form text — so they are queryable, dedupable, and carry the guard
chain. The `controlFlow` body-reachability walk in `builder.ts` (proc → all outgoing dsts = body;
incoming `handles` → handlers; `guarded-by` → conditions; `iterates` → cursors) is the one piece I'd
watch in review: it depends on handlers targeting body nodes, which is true for PL/SQL/Java/C#/
Python/Go but is a silent-empty risk for any future extractor that links handlers differently. The
per-group dedup is correct (a cursor is both declared and iterated). **Confidence: 93%.** Production-
hardening is solid: every extractor is tolerant (top-level try/catch → file node only, never
throws), ids are deterministic via `ctx.idFor`, and the persisted dossier is byte-identical in shape
to the live verb output (same code path).

### 2.2 Product Manager
**Verdict: yes, and it changes the product story.** The existing pitch was "fast project context with
fewer tokens." The refined pitch is "the one-call deep context a migration or a local LLM actually
needs" — that is a wedge into the migration/legacy-modernization market, not just the agent-context
market. The `dossier` verb is the right unit of value: one call, cached on disk, markdown for
humans/LLMs, diffable across languages (PL/SQL vs a C# migration). The gap I'd flag for the roadmap:
we have no user-facing *parity report* ("here is what the C# rebuild is missing vs the PL/SQL
original") — the G2/G4 parity harness is the seed of that feature and should be productized. **Confidence: 90%.** Detailed-level analysis is now captured; the next PM ask is making the diff
*visible* to a non-LLM consumer.

### 2.3 Solution Architect
**Verdict: yes, with clean boundaries.** The dossier builder is **pure over soul + repoRoot** — no
IndexStore, no network, no enricher — so the pipeline can build + persist it post-resolve and the MCP
verb can rebuild it on a cache miss from the same code path. That purity is what guarantees the
persisted artifact and the live verb output are byte-identical in shape, which is the contract any
external consumer (SeeroFlow Tier-1 reader, a CI parity check) can rely on. Schema 1.2 is additive and
forward-compatible (1.0/1.1 load verbatim, no widening), so no migration cliff. Dependency direction
is preserved: `mcp` depends on `core` (not `pipeline`/`parsers`), so the dossier e2e lives in
`pipeline` where it can use parsers+core freely. **Confidence: 94%.** The one architectural debt: the
PL/SQL extractor still uses a two-phase CFG pass (it predates the single-walk design the 6 new
parsers use); consolidating that is a future refactor, not a defect.

### 2.4 Technical Architect
**Verdict: yes.** The detailed level is captured because behavior is modeled at the right granularity
— one node per raise/handler/case-arm/assignment/cursor, edges that encode the *relationship*
(raises/handles/iterates/declares) rather than the *containment*. The guard chain remains stamped on
the edges, so the analysis is not just "what does it do" but "under what condition does it do it" —
which is the migration-critical conjunction (error -20001 happens *only when* `v_decision='REJECT'`).
The persisted dossier is sharded by node-id hash + atomic temp→rename + hash-anchored staleness,
matching the soul's own durability model. **Confidence: 92%.** Non-functional: the body-reachability
walk is O(body size), no full-graph scan; dossier persistence is post-commit and skip-when-fresh, so
re-index cost is unchanged.

### 2.5 AI Architect
**Verdict: yes — and this is what makes it safe for local LLMs.** The existing model forced an agent
to call `context` + `source` + `extract_rules` and *still* re-read source to recover behavior, which
is exactly where a small local model (13B-class Codex/Claude) blows its context budget or
hallucinates the missing facts. The refined `dossier` returns the behavior in one structured,
sectioned markdown payload — the model reasons over `## Raises` / `## Exception handlers` /
`## Decision table` instead of inferring them from raw source. Crucially, every behavior edge is
`EXTRACTED`/`confidence:1` — the LLM is never in the rule path, so a local model can drive a
*comparison* (PL/SQL vs C# decision tables) reliably even though it couldn't reliably *derive* the
rules. `extractedOnly:true` lets a small model drop INFERRED noise. **Confidence: 91%.** This is the
"works with local LLMs" property the user asked for, earned by determinism rather than scale.

### 2.6 AI Engineer
**Verdict: yes.** From an integration standpoint the dossier is the ideal RAG replacement for "code
context": it is a deterministic, cached, sectioned artifact instead of a variable-length retrieved
chunk, so prompt construction is stable and the model's attention isn't wasted on boilerplate. The
markdown section order is fixed, which makes few-shot prompting and structured extraction
("pull only `## Raises` into a runbook entry") trivial. Paging (`sourceStartLine`/`sourceMaxLines`)
keeps a large body inside a small model's window. The prompting guide (`docs/knowledge-crib-prompts.md`)
codifies the patterns that save tokens (dossier over context+source, `extractedOnly:true`, paging on
truncation, no graph walks). **Confidence: 90%.** Engineering follow-up I'd want: a prompt-eval
harness that measures "rules correctly migrated from dossier-only context vs source-only context" to
quantify the token/accuracy win — that turns this judgment into a number.

---

## 3. Overall verdict

**The refined implementation captures detailed-level analysis; the existing implementation did not.**

The existing model captured *structure* (call graph + guard chain + data touched) — necessary but
not sufficient for migration or deep reasoning. The refined model captures *behavior* (raises +
error codes, exception handlers + what they catch, cursors + their queries, case-arm decisions,
assignment targets, per-symbol doc comments), folds it with the structure into a persisted
one-call dossier, and does it across all seven languages with capability-honest skips. The
difference is concretely visible in the loan-rule-engine example (§1.2): existing → "a proc that
updates a table under a CASE"; refined → the full rule, failure modes, recovery surface, and data
iteration.

**Aggregate confidence across the six roles: 92%.** The two documented caveats (not blockers):
(1) the G2/G4 cross-language decision-table parity harness is the natural next step to make the
detailed-level diff *visible* as a product artifact; (2) a prompt-eval would quantify the local-LLM
token/accuracy win. Neither undermines the core finding.

**Verification basis:** 392 tests green (soul 15 · core 49 · mcp 42 · parsers 169 · pipeline 77 ·
cli 40), `pnpm -r build` clean (7 projects), biome clean. Behavior fidelity verified by per-language
golden tests (PL/SQL 26, TS 23, Java 26, C# 28, Go 26, Rust 18, Python 19) + the schema-1.2
round-trip (10) + the dossier end-to-end on the loan-rule-engine fixture (2, incl. byte-stable
re-index).