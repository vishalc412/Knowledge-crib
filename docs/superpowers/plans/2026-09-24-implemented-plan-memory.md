# Implemented Plan Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive an explicitly implemented plan and its complete committed Git changes in a separate, searchable memory collection.

**Architecture:** A typed `impl:` record in `MemoryStore` points to a deterministic Markdown archive. A CLI command preflights Git, ownership, audience, and secret safety, writes the archive and record, refreshes the graph for team archives, then completes the intake. Retrieval requires a matching completion checkpoint and verifies archive integrity.

**Tech Stack:** TypeScript, Node.js Git subprocesses, AJV JSON schemas, Vitest, Knowledge Crib MemoryStore and CLI.

**Execution status (2026-09-24):** Implemented and verified in the feature branch. The checklist below preserves the build sequence; the verification record at the end states what was actually run.

---

## File map

- `packages/memory/src/types.ts`, `schema/implementation-record.schema.json`, `schemas.ts`, `validate.ts`, `store.ts`: record contract and dedicated collection.
- `packages/memory/src/api.ts`: authorized implementation reads and completed-checkpoint join.
- `packages/cli/src/implemented-plan.ts`: Git preflight, deterministic archive, integrity and secret checks.
- `packages/cli/src/cli.ts`: `intake implement` and `memory implementations` CLI wiring.
- `packages/mcp/src/verbs.ts`: typed implementation retrieval.
- `packages/cli/src/implemented-plan.test.ts`, `packages/memory/src/implemented-plan.test.ts`: real Git and store tests.
- `docs/implemented-plans/`, `CONTEXT.md`, CLI help: user documentation and graph-indexed team archives.

### Task 1: Record contract and persistence

- [x] Add a failing store test: an `impl:` record writes to `implementations`, survives reopen, and is rejected from `records`.
- [x] Run `pnpm --filter @knowledge-crib/memory test -- implemented-plan.test.ts`; expect the new test to fail.
- [x] Add `ImplementationRecord` to the memory union and JSON schema; register `impl` validation and the `implementations` collection in local/team stores.
- [x] Run the focused test and memory typecheck; expect both to pass.
- [x] Commit the contract and persistence slice.

### Task 2: Archive generation and CLI completion

- [x] Add a failing CLI integration test using a temporary Git repository: a valid plan and committed file change produce an archive with verbatim plan, revision manifest, and `git diff --binary`; a retry returns the same ID.
- [x] Build CLI and run the focused test; expect failure before implementation.
- [x] Implement Git ancestor/clean-tree/nonempty-diff checks, containment checks, deterministic Markdown construction, secret preflight, atomic archive write, and implementation record write.
- [x] Wire `crib intake implement`; complete the intake only after archive, record, and required graph refresh succeed.
- [x] Build and rerun the focused test; expect pass. Include the vertical slice in the final feature commit.

### Task 3: Audience and failure behavior

- [x] Add failing tests for private default, second-principal denial, explicit team share prerequisite, dirty tree, missing plan, nonancestor base, empty diff, and secret-containing archive.
- [x] Run the focused tests; expect failure for new cases.
- [x] Implement authorization, team path, idempotent recovery, and step-specific nonzero errors. Keep existing `intake complete` semantics.
- [x] Build and rerun focused tests; expect pass. Include in the final feature commit.

### Task 4: Retrieval and graph integration

- [x] Add failing tests for `memory implementations list|get|search`, a completed-checkpoint join, integrity degradation for a missing/modified archive, and team Markdown indexing.
- [x] Run focused tests; expect failure for new cases.
- [x] Implement authorized API/CLI/MCP retrieval with deterministic lexical ranking and distinct typed result; update help and docs.
- [x] Build, run focused tests, run `crib update` on the fixture, and verify `crib query` finds the team archive. Include in the final feature commit.

### Task 5: Final verification

- [x] Run package typechecks and focused suites after rebuilding all changed packages.
- [x] Run the graph-backed `crib review` CLI, which calls `detect_changes`, and inspect changed symbols, paths, and scope notes.
- [x] Checkpoint the feature intake with completed steps and the next safe action.
- [x] Summarize behavior, tests, limitations, and any remaining work in the verification record and user report.

### Verification record

- Workspace build: `corepack pnpm@9.15.0 -r run build` passed.
- Memory suite: 75 files and 1,173 tests passed before the final namespace guard; its focused implementation suite passed again after that guard.
- MCP suite: 26 files and 491 tests passed with one Vitest worker; focused implementation and capability suites passed after the retrieval changes.
- CLI implementation integration: 13 tests passed, including a real Git team archive that `crib query` found; the private list/get/search test passed after the final CLI assertion.
- Biome and `git diff --check` passed; `scripts/capabilities-check.mjs` reported 18 tools and 50 operations.
- Graph review was truncated and scoped to uncommitted changes because the incremental anchor equalled HEAD. Treat caller counts as a floor, not a safety certification.
