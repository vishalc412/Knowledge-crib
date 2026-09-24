# Implemented-plan memory: pre-PR evaluation

Date: 2026-09-24. Final code candidate: `8563f56e` on
`codex/implemented-plan-memory`. Evaluation used a clean Git worktree at that
commit and a separate temporary Git project with isolated memory and registry
directories. No production store or remote service was modified by the fixture.

## Acceptance exercised

| Behavior | Observation |
| --- | --- |
| Private completion | The plan Markdown and binary-capable Git patch matched their stored hashes; the implementation record reported `integrity: valid` and `graph: private`. Search found the record, a different principal saw no private record, and a retry returned the original implementation ID. |
| Explicit team publication | Completion was refused until the intake was explicitly shared with the team. The team archive was written under `docs/implemented-plans/`. |
| Graph retrieval | In a fresh project with a real VCS index anchor, completion's update report named the new archive, `query` found it, and a different principal retrieved the valid record with `graph: indexed`. |
| Retry and scope | Repeating team completion returned the same implementation ID. A pipeline test proved an explicitly included untracked archive is indexed while another untracked draft is excluded; an ignored-file test proved that Git-ignored content is rejected. |

The first team fixture against `3434c19f` exposed a real defect: the implementation
record and Markdown archive were valid, but incremental `update --dirty` omitted
the new untracked archive, leaving its graph state stale. The CLI integration
fixture had previously indexed before Git initialization, which forced a full
index fallback and hid the defect. Commit `8563f56e` gives the implementation
command an explicit `--include-path` for the archive and establishes a real
incremental anchor in the test. The fresh fixture then passed all team checks.

## Verification

| Check | Result |
| --- | --- |
| Pipeline `update.test.ts` | 14/14 passed. |
| CLI `intake-cli.test.ts` | 8/8 passed. |
| MCP `verbs-intake.test.ts` and `capabilities.test.ts` in the clean worktree | 13/13 passed. |
| `npm run verify` in the clean worktree | Build and soul-schema 18/18, core 432/432, memory 1173/1173, parsers 506/506, UI 42/42, and MCP 491/491 assertions passed. Vitest reported an unhandled worker `onTaskUpdate` timeout after the MCP assertions, so the command exited 1 before later packages and checks. |
| Serial package test run, `pnpm -r --workspace-concurrency=1 run test` | The same early suites and MCP 491/491 assertions passed; the same Vitest worker timeout made the command exit 1. |
| Independent gates in the clean worktree | Biome checked 726 files; boundaries, credential, and license checks passed. |

The earlier full verification at `3434c19f` reached CLI, where the existing
freshness lock test failed with `LockBusyError (pid 0)` and the post-commit p95
test exceeded its 25 ms threshold under load. Both passed when run in isolation.
The repository's [developer-trust evidence register](../program/evidence-register.md)
records these issues as B13 and B12a, and the MCP worker timeout as B11.
The current candidate's full run stopped at MCP, so it does **not** establish a
green repository-wide gate. CI should be reviewed before merging.

## Decision

The implemented-plan behavior passed the private and team scenarios, including
integrity, access scope, graph retrieval, and idempotency. Open a **draft PR**
with this report and keep the repository-wide test gate visible. This evaluation
does not certify release readiness or resolve the existing test-runner and lock
issues.
