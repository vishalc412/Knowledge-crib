# Knowledge-crib — Testing Strategy & Acceptance Gates

> Every milestone ships behind a test gate. The deterministic core must be golden-tested; the
> probabilistic linker is measured (precision/recall), not asserted exact. CI runs the pyramid on
> every PR.

---

## 1. Test pyramid
| Layer | Scope | Tooling |
|-------|-------|---------|
| Unit | `core` (SoulStore conflict rule, ID grammar, hashing), parsers, scoring | Vitest |
| Golden | extractor `fixture file → exact nodes/edges` | Vitest + snapshot |
| Integration | full pipeline on a fixture repo → soul → index → query | Vitest |
| Contract | soul/index records validate against JSON Schema; MCP req/resp shapes | Vitest + ajv |
| E2E | MCP server answers verbs over stdio on a real repo | MCP test harness |
| Benchmark | token-cut + index-time + p99 latency | custom harness |

## 2. Fixtures
- `fixtures/ts-min/` — tiny TS repo with known call graph (M2/M3 golden).
- `fixtures/docs-linked/` — code + Markdown with **known** doc↔symbol links (M4 precision).
- `fixtures/large/` — generated N-file repo for scale/perf (M1/benchmark).
- Golden expectations stored as committed JSON; ID/hash stability asserted across runs.

## 3. Per-milestone acceptance gates (mirror [build plan](knowledge-crib-build-plan.md))
| M | Gate (must pass to merge) |
|---|---------------------------|
| M0 | round-trip: nodes/edges → JSONL chunks → reload byte-stable; conflict rule unit-tested; all 6 data-model invariants enforced |
| M1 | `IndexStore.buildFromSoul` on a fixture soul; `query` returns expected ids; sqlite fallback parity test |
| M2 | TS extractor golden: `fixtures/ts-min` → exact symbol nodes + intra-file edges; degradation + id-stability tests |
| M3 | resolver: call/import/inherit edges on `ts-min` at **precision ≥ 0.95**; unresolved-call drop verified (no guesses) |
| M4 | linker on `fixtures/docs-linked`: deterministic-signal **precision ≥ 0.9**; semantic recall measured; threshold honored |
| M5 | **E2E wedge:** `impact("AuthService","up")` returns code blast-radius **and** ≥1 `describes` doc with provenance snippet; token-cut benchmark shows reduction |
| M6 | edit 1 file → only its shard-chunks change (diff assertion); merge-driver resolves a synthetic conflict via the rule |
| M7 | clusters render in UI; semantic signal improves recall without dropping precision below M4 |
| M8 | each new language ships with its golden + capability-honesty tests |
| M9 | `soul-reader` reads `.crib/` engine-free and validates against schema (SeeroFlow Tier-1) |

## 4. Link-precision measurement (M4 — the trust gate)
- Hand-label the true doc↔symbol links in `fixtures/docs-linked`.
- precision = correct edges / emitted edges; recall = correct / true.
- Report per `method` (explicit/identifier/path/semantic) and per provenance.
- Gate on **deterministic precision ≥ 0.9**; semantic is recall-only and never lowers deterministic precision (capped ranking).

## 5. Token-cut benchmark (M5 — the headline metric [Q25])
- Task set: N realistic "understand/modify X" prompts.
- Arm A: agent reads files to build context. Arm B: agent uses crib MCP verbs.
- Measure tokens/task + answer quality (rubric). **Gate:** B shows a clear token reduction while
  *adding* doc context. Store results in `bench/REPORT.md`.

## 6. Performance gates (guardrails [Q25])
- Index time on `fixtures/large` within budget; p99 verb latency tracked.
- Incremental update on a 1-file change ≪ full index time.
- Parser timeout (`--worker-timeout`) prevents single-file hangs.

## 7. CI
- On PR: lint + typecheck + unit + golden + integration + contract.
- Nightly: E2E + benchmark + perf on `fixtures/large`.
- Schema changes require a `crib migrate` test (old soul → new schema, round-trip).

## 8. Trust-mode test
`--extracted-only` view returns zero `INFERRED` edges; agents can rely on a deterministic-only graph.
