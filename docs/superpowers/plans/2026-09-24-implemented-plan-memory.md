# Implemented Plan Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive an explicitly implemented plan and its complete committed Git changes in a separate, searchable memory collection.

**Architecture:** A typed `impl:` record in `MemoryStore` points to a deterministic Markdown archive. A CLI command preflights Git, ownership, audience, and secret safety, writes the archive and record, refreshes the graph for team archives, then completes the intake. Retrieval requires a matching completion checkpoint and verifies archive integrity.

**Tech Stack:** TypeScript, Node.js Git subprocesses, AJV JSON schemas, Vitest, Knowledge Crib MemoryStore and CLI.

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

- [ ] Add a failing store test: an `impl:` record writes to `implementations`, survives reopen, and is rejected from `records`.
- [ ] Run `pnpm --filter @knowledge-crib/memory test -- implemented-plan.test.ts`; expect the new test to fail.
- [ ] Add `ImplementationRecord` to the memory union and JSON schema; register `impl` validation and the `implementations` collection in local/team stores.
- [ ] Run the focused test and memory typecheck; expect both to pass.
- [ ] Commit the contract and persistence slice.

### Task 2: Archive generation and CLI completion

- [ ] Add a failing CLI integration test using a temporary Git repository: a valid plan and committed file change produce an archive with verbatim plan, revision manifest, and `git diff --binary`; a retry returns the same ID.
- [ ] Build CLI and run the focused test; expect failure before implementation.
- [ ] Implement Git ancestor/clean-tree/nonempty-diff checks, containment checks, deterministic Markdown construction, secret preflight, atomic archive write, and implementation record write.
- [ ] Wire `crib intake implement`; complete the intake only after archive, record, and required graph refresh succeed.
- [ ] Build and rerun the focused test; expect pass. Commit the vertical slice.

### Task 3: Audience and failure behavior

- [ ] Add failing tests for private default, second-principal denial, explicit team share prerequisite, dirty tree, missing plan, nonancestor base, empty diff, and secret-containing archive.
- [ ] Run the focused tests; expect failure for new cases.
- [ ] Implement authorization, team path, idempotent recovery, and step-specific nonzero errors. Keep existing `intake complete` semantics.
- [ ] Build and rerun focused tests; expect pass. Commit.

### Task 4: Retrieval and graph integration

- [ ] Add failing tests for `memory implementations list|get|search`, a completed-checkpoint join, integrity degradation for a missing/modified archive, and team Markdown indexing.
- [ ] Run focused tests; expect failure for new cases.
- [ ] Implement authorized API/CLI/MCP retrieval with deterministic lexical ranking and distinct typed result; update help and docs.
- [ ] Build, run focused tests, run `crib update` on the fixture, and verify `crib query` finds the team archive. Commit.

### Task 5: Final verification

- [ ] Run package typechecks and focused suites after rebuilding all changed packages.
- [ ] Run `crib detect-changes` and inspect changed symbols, removed edges, changed paths, and notes.
- [ ] Checkpoint the feature intake with receipts, archive paths, and a next safe action if any.
- [ ] Summarize behavior, tests, limitations, and any remaining work.
