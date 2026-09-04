# Launch readiness report — knowledge-crib

Status: DRAFT (auditor-facing). Frozen evidence only; slots marked PENDING close when their gate closes.
Branch: `feature/superset-plan` (pushed to `cmp-remote`). Plan: Gates 0→5 per the revised superset plan.

## 1. What shipped

| Gate | Scope | State |
|------|-------|-------|
| 0 | CLI memory recall, MCP capture, dossier hoist, bench corpus | DONE, pushed (daf21900, abb476a8) |
| 1 | Memory v2 envelope (provenance, bi-temporal, lineage, portable API), 14 tools / 37 ops | DONE, pushed (a7cba393) |
| 2 | Capture lanes + durable outbox + distillation, 14 tools / 38 ops | DONE, pushed (58238e68) |
| 3 | Persistent FTS, embedder tiers, versioned scorer, generation-keyed revalidation, freshness worker, 5s p95 fixture | DONE, pushed (1ac4f6c7, 08c91aa4, 567cac83, aaf10832) |
| 4 | Cross-device sync per ADR-003 (AEAD file backend, D2/D5/D10/D11), MCP read-only sync surface | DONE, pushed (87b01c11, 45597e3a) |
| 5 | G5.1 rename (16 tools / 40 ops), G5.2 PDG/taint, G5.3 multimodal adapters, G5.4 UI ledger inspector | DONE (see §2) |

Per-gate end-to-end product tests (fresh `crib serve` over stdio, real CLI dist): Gate 0 32/32-style surface probe, Gate 3 18/18, Gate 4 32/32. Gate 5 E2E: PENDING.

## 2. Gate 5 detail

- **G5.1 rename**: default dry-run; apply gated on deterministic plan id (`rename:<blake3>`) + per-file content hashes; PLAN_MISMATCH → STALE_PLAN → edit-count arms; atomic apply with rollback; exact/inferred classification; empty-caller set flagged as NOT evidence of disuse. CLI chains a dirty reindex after apply; MCP apply is fail-closed on missing planId and cannot reindex (directs to `crib update --dirty`). 16 tools / 41 operations (manifest-derived, `scripts/capabilities-check.mjs` enforced).
- **G5.2 PDG/taint**: fragment CFG → post-dominators → control dependence; reaching-definitions GEN/KILL may-analysis fixpoint; 19-rule taint table (6 sources / 8 sinks / 2 sanitizers); strictly intra-procedural; absence-of-flows is explicitly NOT proof of safety; opt-in capability flag (`pdg:false` by default, never set by indexing).
- **G5.3 multimodal**: PDF via unpdf (TS-native, lazy import), OCR/whisper gated on PATH detection, backend `auto` default, full provenance meta on media-seg nodes, honest degrade when backends are absent.
- **G5.4 UI ledger**: memory ledger inspector with anchor correlation (current / moved / stale / retracted), pagination caps, evaluator-truth reuse (no new backend projection).

## 3. Launch gates (pre-registered, then measured — `docs/bench/launch-gates.md`)

| Gate | Threshold | Measured | Verdict |
|------|-----------|----------|---------|
| G1 exact recall | R@5 100% | 100% | PASS |
| G2 paraphrase recall | R@5 ≥ 80% | **2.6%** | **FAIL** |
| G3 ranking | MRR ≥ 0.75 | **52%** | **FAIL** |
| G4 temporal + contradiction | ≥ 90% | 100% | PASS |
| G5 stale-as-current | < 1% | 0% | PASS |
| G6 untrusted in normal recall | 0 | 0 | PASS |
| G7 cross-principal | 0 | 0 scoped / **18.7% union leak** | **FIX IN FLIGHT** (principal projection filter) |

Honest negatives recorded: 43 corpus queries that violated the frozen word-disjointness invariant were caught and rewritten BEFORE the deciding run (pre-rewrite 9.2% published alongside). G2/G3 root cause: word-disjoint paraphrase and multilingual queries score BM25 zero under the lexical-only default scorer (`memory-rank-v2:none:bm25:lexical-only`). The lever — a real on-device multilingual embedder via `crib embed install <model-dir>` — is an OPERATOR out-of-band step by design (no network at install or query time; red line #3; MAX_RUNTIME_DEPS=9 / MAX_PACKAGE_BYTES=5MB budget gates). **Launch decision required (not pre-made, not silently demoted): acquire an on-device model out-of-band, or ship lexical-only with a dated commitment.** Closing G2 by code alone is not possible within the dependency budget.

## 4. Security battery — IMPLEMENTED

`pnpm security:battery` executes focused S1–S9 controls for instruction-bearing memory,
cross-principal isolation, untrusted promotion, sync poisoning, secret materialization,
capture-lane injection, path traversal, tombstone precedence, and MCP sync-side-effect refusal.
`release:verify` invokes the battery before the security-document gate. This is control evidence,
not a claim that a downstream LLM is immune to prompt injection.

## 5. Performance and reliability gates — PENDING

Gates + honest method frozen in `docs/bench/perf-gates.md` (warm p95 recall @10k/100k, 5s queryable-update, zero commit tax, failed-refresh readability, sync convergence soak). Baselines from `docs/bench/scale-curve.md`; launch run re-measures on the current build.

## 6. Vendor comparison — BLOCKED (honest)

`scripts/launch-vendor-compare.mjs` adapters for mem0 / Graphiti / Letta are credential-first: env vars or PATH binaries. All three were ABSENT in this environment, so no comparison was run and none is scored as zero. Operator credentials unblock it.

## 7. Known limitations carried (not launch-blocking unless a gate fails)

- v1 memory records have no principal column; principal scoping is enforced at the projection layer for records that carry identity (v2 `provenance.principalId`), with v1 records treated as the caller's own principal — documented limitation of the v1 format.
- On-device embedder model acquisition is an operator out-of-band step; char-ngram fallback is the shipped default and is declared degraded honestly.
- Persistent FTS snapshot size/rotation policy at 10k+ scale — measured, not yet capped.
- Sync-log rotation/compaction — documented operator procedure (D7), not yet automated.
- 18 pre-existing dependabot vulns on cmp-remote's default branch (pre-date this branch).

## 7b. Closed since the beta audit (2026-09-04)

| Item | Was | Now |
|------|-----|-----|
| memory-3 records | Write-only — `migrateToV3` wrote a valid v3 line, then every read refused it as an unsupported version, so `active` read back EMPTY. `LIVE_/SUPPORTED_MEMORY_SCHEMA_VERSIONS` were never extended past `'2'`. | `'3'` is live; `migrations.test.ts` 39/39, memory 711/711. Three `memory.test.ts` cases that used `'3'` as their "unknown version" probe now use `'4'`. |
| `crib memory migrate` | **Crashed on every repo** — it called `persistManifest()` on the team store, which deliberately has none. It never reached its own report, which is why the hardcoded `schemaVersion: '1'` went unnoticed. | Guarded on `store.hasManifest`. Reports the observed `byVersion` tally per store plus `supportedSchemaVersions` from the library constant. 3 e2e tests. |
| `detect_changes` | Reported the commit range `since..HEAD` ONLY, so the pre-commit graph check structurally could not see uncommitted work; with `since === head` it returned bare `[]`, read as "clean". | Reports `changedPaths` + `uncommittedPaths`, both feeding `changedSymbols`/`removedEdges`; an empty range now carries a `note` saying why. 3 regression tests. |
| Third-party code-intelligence coupling | `CLAUDE.md` + `AGENTS.md` carried a committed `<!-- gitnexus:start -->` block making a PolyForm-Noncommercial tool a de-facto dependency of working in this repo. | Removed. Crib's own `impact`/`detect_changes`/`query`/`context`/`rename`/`explain` rules ship as §5–7 of the vendor-neutral adapter protocol, generated into all 6 client instruction files. Attribution stays in NOTICE (design inspiration; no code reused). |
| `budget:check` | Failed: `taint.ts` false-flagged as a network call site (it is a pattern TABLE), and `unpdf` took runtime deps 9 → 10. | `taint.ts` allowlisted alongside `http-client.ts` with rationale. `MAX_RUNTIME_DEPS` raised to 10 with `unpdf` argued on the property the budget protects (pure-JS, no native build, lazy opt-in import); explicitly NOT hidden in `optionalDependencies`. |
| `release:metadata` | Failed: `security:battery` used bare `pnpm`. | All root scripts pin pnpm through corepack. |
| Generated site | Curated-nav descriptions were escaped verbatim, so `**bold**` rendered with its asterisks showing. | Escape-then-render for `**bold**` / `` `code` ``. All generated links verified to resolve. |

## 8. Verification discipline

Every gate closes with: package-level tests → `corepack pnpm@9.15.0 verify` (all 8 packages) →
`detect-changes` scope check → commit (explicit paths) → `release:verify` EXIT 0 (including the
runtime S1–S9 battery, docs-site drift check, budget gates, and serial/parallel determinism) → push
to `cmp-remote`. Negative results are recorded honestly when gates fail (G3.2 fusion
pre-registration; G2/G3 above).
