# Actual Production GO Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. Checkpoint through Knowledge Crib. Follow the repository's graph-first and evidence protocol before edits.

**Goal:** Produce a defensible production developer-launch GO for one exact candidate, with no skipped requirements silently treated as passed.

**Architecture:** Retain the TypeScript/SQLite/journal/MCP architecture and frozen retrieval thresholds. Separate test execution results from release approval: an immutable release policy defines requirements, receipts prove them, and a fail-closed decision recomputes eligibility. Preserve the one-owner, one-device scope and preview-only cross-device sync.

**Tech stack:** TypeScript, Node 22/24, SQLite, Vitest, Playwright, pnpm, GitHub Actions, filesystem evidence artifacts.

Baseline: `9da78653a3b2e52dbc6899b5a1a532567dfa4533`. [Audit and reproductions](../../audits/2026-09-09/production-readiness.md). Current verdict: NO-GO. Build, 2,976 tests, lint, 8 browser cases and G1–G8 pass locally; runtime certification and the audit defects remain blockers.

## Non-negotiable GO contract

GO requires all conditions below, evaluated from evidence for the same clean source commit and shipped package digest:

1. No unresolved A01–A09 findings.
2. All required CI OS/Node cells, install/native-service/recovery/browser checks complete successfully.
3. Exact frozen G1–G8 set passes, including G2 ≥0.80 and G3 ≥0.75, under a supported pinned semantic model.
4. Every advertised client/platform cell has genuine vendor runtime evidence.
5. Default-configuration freshness reaches query/FTS/context/health convergence within the preregistered five-second p95 target.
6. Security/privacy, recovery, operations and documentation acceptance have candidate-bound receipts.
7. Aggregate approval itself gates release publication.

Absent, skipped, not-run, unknown, invalid, mismatched and stale evidence all mean NO-GO. No percentage-complete score overrides a failed mandatory condition. Verification may report PASS for a subset, but only the strict aggregate may print production GO.

## Execution order and file ownership

| Phase | Tasks | Primary files | Exit |
|---|---|---|---|
| 1 — Safe product behavior | 1–4 | MCP installer, refresh coordinator, FTS, installer assertions | All reproduced defects have failing-then-passing regression tests |
| 2 — Trustworthy release decision | 5–6 | Evidence validator, certification loader, decision CLI, workflows | Incomplete or mismatched evidence cannot produce GO or publish |
| 3 — End-to-end acceptance | 7–9 | Watch harness, installer/service/recovery receipts, diagnostics/browser | Real default-path behavior measured on clean runners |
| 4 — External certification | 10 | Vendor-client runner instructions and receipt artifacts | All 21 declared cells certified for candidate |
| 5 — Launch closure | 11–12 | Docs, policy, final aggregation | One auditable GO; publication consumes its verified package |

For each code task: add the specified failing case, run it to confirm the failure, implement the bounded repair, rerun affected tests, inspect `crib detect_changes`/`review`, and commit only that task. Record commands, exit codes and artifact hashes outside tracked source. Later product changes invalidate candidate-specific receipts; rerun affected suites and recollect final evidence.

## Task 1 — Preserve client configuration and diagnose launchers (A04/A09)

Files: modify `packages/cli/src/mcp-install.ts`; test `packages/cli/src/mcp-install.test.ts` and `packages/cli/src/cli.test.ts`.

- [ ] Add cases for absent config, malformed existing JSON, supported JSONC, sibling MCP entries, and valid unrelated fields. Every refused install must preserve the original bytes.
- [ ] Replace the missing-or-unparseable `{}` collapse with distinct outcomes. Missing means create; malformed means a structured refusal with file/location/repair action. Support comments only for formats whose clients accept them, using a preserving edit strategy.
- [ ] Test generated Node-plus-cli launchers with missing interpreter, missing entry point, spaces and Unicode paths. Validate the first argument only when it is the known generated script launcher; do not execute arbitrary config commands during doctor.
- [ ] Run `corepack pnpm@9.15.0 --filter knowledge-crib test -- mcp-install.test.ts cli.test.ts`.
- [ ] Exit: no user-config loss; unusable generated launchers are diagnosed with a safe repair action. Commit `fix(mcp): preserve malformed configs and validate generated launchers`.

## Task 2 — Make freshness and bundle ownership truthful (A05/A08)

Files: modify `packages/cli/src/refresh-coordinator.ts`; test `packages/cli/src/refresh-coordinator.test.ts` and `packages/cli/src/watch.test.ts`.

- [ ] Add cold/live source-unavailable tests requiring stale=true and a reason.
- [ ] Add retain A → publish B → revert source to A test requiring stale=true while generation IDs differ; releasing the request must adopt the appropriate current bundle and restore truthful health.
- [ ] Add retain A → publish B → publish C → release → close test instrumenting every index close. Require B closed once when superseded, A after release, C at shutdown; never close an index still in use.
- [ ] Compute stale from both source-state validity and publication/adoption identity. Keep indexed HEAD lag separate from a compensating live overlay's status.
- [ ] Dispose of superseded unadopted bundles explicitly and test shutdown/error paths for exactly-once disposal.
- [ ] Run `corepack pnpm@9.15.0 --filter knowledge-crib test -- refresh-coordinator.test.ts watch.test.ts freshness-child.test.ts`.
- [ ] Exit: no generation mismatch or unknown-source false-fresh result; all native indexes have bounded ownership. Commit `fix(freshness): enforce adoption state and dispose pending bundles`.

## Task 3 — Recover malformed derived metadata (A07)

Files: modify `packages/memory/src/persistent-fts.ts`; test `packages/memory/src/persistent-fts.test.ts`.

- [ ] Add metadata cases: null, empty object, missing stores, null stores, invalid role entries, invalid version, interrupted DB rebuild. Seed canonical memory before corruption.
- [ ] Validate the complete snapshot metadata structure before comparing generations. Invalid disposable metadata means rebuild, preserving canonical journal/shards and yielding the seeded memory in search.
- [ ] Run `corepack pnpm@9.15.0 --filter @knowledge-crib/memory test -- persistent-fts.test.ts`.
- [ ] Exit: every malformed snapshot recovers or returns a classified canonical-storage failure; no unclassified TypeError. Commit `fix(memory): validate derived snapshot metadata before reuse`.

## Task 4 — Repair Windows proof and run the real installation cycle (A06)

Files: modify `scripts/install-smoke.mjs`, `scripts/install-smoke.test.mjs`; verify `.github/workflows/beta-installers.yml` and `.github/workflows/ci.yml`.

- [ ] Add a deterministic win32 path case proving the existing records regex fails.
- [ ] Normalize relative digest keys to `/` at serialization, or use component comparisons consistently. Do not change the file-content hashing semantics.
- [ ] Run `node scripts/install-smoke.test.mjs`; then run the actual Windows Node 22/24 jobs. A POSIX test is not Windows certification.
- [ ] Run actual package install → seed local/global memory → uninstall → reinstall → authorized recall under a spaced/non-ASCII home. Verify sibling client config and memory bytes survive; record package hash, OS and process exit codes.
- [ ] Exit: green Windows tests plus genuine install-cycle artifacts on all advertised installer platforms. Commit `fix(installer): normalize portable memory evidence paths`.

## Task 5 — Build a fail-closed candidate-bound evidence contract (A01/A02)

Files: modify `scripts/release-evidence.mjs`, `scripts/release-evidence.test.mjs`, `scripts/client-certification-evidence.mjs`, `scripts/client-certification-evidence.test.mjs`, `scripts/launch-decision.mjs`, `scripts/launch-decision.test.mjs`; create `scripts/launch-policy.json` and `scripts/launch-policy.mjs`.

- [ ] Freeze required gate IDs, thresholds/directions, OS/Node cells, client/platform cells, receipt types and freshness workload in a versioned policy. Archive its hash before candidate testing.
- [ ] Introduce evidence schema version 2. Required identity: source commit, dirty=false, shipped package SHA-256, policy SHA-256, model manifest/revision, platform/arch/Node, client versions, runner provenance, command, exit code, start/end timestamps and artifact paths/hashes.
- [ ] Model install, native-service, browser, recovery, security/privacy, freshness and adapter receipts explicitly. Missing receipt types are actionable blockers, never inferred from a unit-test total.
- [ ] Add negative cases for empty/missing/duplicate/unknown gates, altered threshold/direction, contradictory pass flags, nonfinite measurements, dirty/missing commit, missing model proof, wrong policy, missing receipt type and missing artifact.
- [ ] Add exact-candidate checks for client receipts. A valid receipt for another commit, package, platform or unsupported client version must not cover this candidate. Verify artifact digests and trusted run origin; a hashed self-authored log alone is not proof of a vendor run.
- [ ] Recompute gate outcomes and required coverage from policy and validated measurements. Treat embedded `acceptance.pass` and missing-cell summaries as derived output only. Remove the ability of evidence's own `certification.required=false` to select production launch requirements.
- [ ] Preserve diagnostic loading of honest failed evidence, but label historical schema evidence non-certifying until upgraded/recollected.
- [ ] Run `node scripts/release-evidence.test.mjs`, `node scripts/client-certification-evidence.test.mjs`, and `node scripts/launch-decision.test.mjs`.
- [ ] Exit: every A01/A02 probe returns NO-GO with the exact reason; a complete independent fixture returns GO; changing any mandatory fact returns NO-GO. Commit `fix(release): derive launch eligibility from candidate-bound evidence`.

## Task 6 — Make aggregate approval mandatory for publishing (A03)

Files: modify `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `scripts/launch-decision.mjs`, `scripts/launch-decision.test.mjs`, `scripts/ci-workflow.test.mjs`.

- [ ] Require the exact expected cell set from the committed launch policy; reject missing cells, duplicates, mixed commits/packages/policies and mismatched declared platform names.
- [ ] Make the release job depend on both verification and aggregate decision. Only the successful decision's package digest may be published; verify downloaded bytes against it.
- [ ] Wire browser acceptance and required artifact receipts into tag verification, not just PR CI. Publish the final receipt only after all mandatory commands finish; upload failure diagnostics separately.
- [ ] Test removal of one downloaded OS manifest, aggregation exit 1, mixed-candidate evidence and a post-evidence installer failure. Each must leave publication blocked.
- [ ] Run `node scripts/launch-decision.test.mjs && node scripts/ci-workflow.test.mjs` and an isolated nonpublishing workflow rehearsal.
- [ ] Exit: no release job can execute after a failed/missing decision. Commit `fix(ci): gate publication on complete release approval`.

## Task 7 — Prove automatic freshness end to end

Files: extend `packages/cli/src/watch.test.ts` and `packages/cli/src/freshness.test.ts`; create `scripts/freshness-adoption-check.mjs`; wire `scripts/release-verify.mjs` and launch policy.

- [ ] Preregister a representative repository workload, machine envelope, sample count, warmup, failure treatment and five-second p95 target. Freeze before measuring; do not retune it to pass.
- [ ] Launch the built server with production default watch/debounce/fallback settings. Drive save, rename, delete, clean checkout, merge, rebase, external update and restart via filesystem/Git/process operations.
- [ ] For each transition poll actual graph queries, FTS search, context and health. Confirm new content appears, removed content disappears, and reader/published generations converge without manual `crib update`.
- [ ] Exercise retained async requests and unavailable source detection. Time from the source mutation to correct queryable adoption, not capture bookkeeping. Count missed transitions/timeouts as failures.
- [ ] Run on macOS/Linux/Windows; archive raw per-transition samples, p95, configuration and resource measurements as a freshness receipt.
- [ ] Exit: all transitions correct and p95 ≤5 seconds for the frozen workload. If performance fails, optimize measured hot paths and rerun the same workload; do not shorten fallback solely in tests.

## Task 8 — Close durability, service and preview-sync acceptance

Files: extend `packages/cli/src/memory-crash-recovery.test.ts`, `packages/cli/src/memory-portable.test.ts`, existing service tests and `packages/memory/src/sync/engine.test.ts`; connect evidence collection to task 5's schema.

- [ ] Preserve the current acknowledgement-after-persist and subprocess crash tests. Add A07 recovery fixtures and candidate-specific backup/restore/migration/uninstall receipts.
- [ ] Run native service install/start/restart/stop on each supported OS with interrupted workers and long synchronous revalidation; assert no lease takeover while the owner is alive.
- [ ] Re-run owner/foreign-principal isolation across handoff, counts, exports, restore and recovery; planted foreign session/path markers must never appear in owner output.
- [ ] Run preview sync with v3 records, explicit device audience, tombstones, interrupted transfer, replay and offline divergence; document merge outcomes and unresolved conflicts.
- [ ] Exit: local/global durability and service receipts pass. Sync remains labelled preview even if its tests pass; production sync promotion requires a separate decision and scope authorization.

## Task 9 — Finish operational support and usable recovery

Files: `packages/cli/src/cli.ts`, `packages/cli/src/viz-server.ts`, `packages/ui/web/index.html`, `packages/cli/test/browser/memory-home.browser.ts`; create a bounded diagnostics module and its tests rather than expanding CLI business logic indefinitely.

- [ ] Produce diagnostics for refresh/adoption state, retries/dead letters, model readiness, last classified error and adapter command health. Keep unavailable and absent distinct.
- [ ] Add an allowlisted support bundle: exclude raw memories, prompts, credentials, environment dumps and personal absolute paths. Plant sentinel secrets in each source and assert no bundle member contains them.
- [ ] Verify guided repairs for corrupt config, missing script/model, stale index and inactive service. Refusals preserve user-owned files; repair outcomes refresh the displayed health.
- [ ] Extend real-backend browser tests for desktop/390px keyboard entry, contrast, Escape/focus return, pending admission and authorized resume after failure. Record actual browser version and artifact hashes.
- [ ] Exit: failures are diagnosable and safely recoverable; a redacted support bundle and browser receipt validate against task 5's schema.

## Task 10 — Certify real clients on the candidate

Clients: Claude Code, Copilot, Cursor, Codex, Windsurf, Gemini and VS Code. Required platforms under the current promise: macOS, native Linux and Windows. WSL does not silently satisfy native Linux/Windows cells. If a vendor does not support a cell, record it as unsupported and leave the present promise NO-GO; changing the promise is an explicit product decision.

- [ ] Install the exact candidate package in isolated user/profile directories on actual supported hosts. Record vendor app version, OS/arch/Node, candidate commit/package and launch-policy hash.
- [ ] For every cell: generate config; launch the actual vendor app; prove MCP handshake/tool use; record a uniquely tagged authorized memory/intake; interrupt/timeout; restart the client; recover the prior authorized session; verify foreign-principal exclusion.
- [ ] Capture sanitized vendor logs/transcripts and run metadata from that execution. Hash and archive them; distinguish protocol harness evidence from vendor evidence.
- [ ] Validate all receipts, then regenerate `docs/capability-matrix.md`. The matrix must list actual platform/version scope and the candidate it certifies.
- [ ] Exit: 21 accepted candidate-bound cells, zero missing/unknown results. Requires available vendor applications/accounts and hosts; code changes alone cannot satisfy it.

## Task 11 — Align documentation and claims with proof

Files: `docs/launch/comparison.md`, `docs/launch/developer-launch-decision.md`, `docs/launch/publish-runbook.md`, `docs/launch/requirements-register.md`, `docs/capability-matrix.md` and public launch copy.

- [ ] Replace categorical “only tool”/superiority claims with dated, source-linked dimensions for Mem0 OSS and hosted, GitNexus and Letta. Keep local measured numbers separate from competitor documentation and unrun comparisons.
- [ ] Walk a clean installed candidate through onboarding, semantic consent/setup, upgrade, rollback, backup/restore, uninstall-with-memory and resume. Record exact commands and observed outputs as a docs receipt.
- [ ] Clarify lexical vs semantic readiness, code graph vs optional enrichment freshness, single-owner scope, versioned client certification and preview sync.
- [ ] Run `node scripts/docs-site-check.mjs && node scripts/client-certification-matrix.mjs --check` after approved regeneration.
- [ ] Exit: every advertised capability maps to current evidence; every remaining preview/unsupported dimension is explicit.

## Task 12 — Produce the actual release decision

- [ ] Commit the final candidate and record source/package/policy hashes before final runs. Store receipts outside tracked source so collection cannot dirty the candidate.
- [ ] Run `corepack pnpm@9.15.0 release:verify` and the full OS/Node matrix plus required browser/install/service/recovery/freshness acceptance. Recollect exact-candidate client evidence as needed.
- [ ] Validate all raw receipts and aggregate required cells. Require zero mandatory failures and zero unresolved audit findings. Archive raw commands, exit codes, run URLs, sanitized artifacts and checksums.
- [ ] Perform an independent read-only review of the final diff and evidence. A changed package, failed rerun or missing artifact invalidates the previous decision.
- [ ] Generate the final GO/NO-GO report. Only an actual complete GO unlocks publication of the matching package; a missing vendor run remains NO-GO with its exact cell name.

## Completion ledger

Track each task in Knowledge Crib with commit, tests, artifacts, unresolved conditions and next safe action. Complete the implementation intake only after the actual acceptance contract is met. Completing this audit/plan does not complete the launch implementation.
