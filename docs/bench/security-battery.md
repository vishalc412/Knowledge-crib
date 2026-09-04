# Launch gate — security battery

Status: IMPLEMENTED. Run `pnpm security:battery` to execute the focused S1–S9 battery.
The command is intentionally separate from the documentation control (`pnpm security:check`) so
runtime evidence cannot be confused with a prose-only gate.

## Why

The memory layer is the product's highest-severity attack surface: memory content is
**data written by agents and humans**, and it is **read back into model context**. A record whose
claim text carries instructions is a prompt-injection vector by construction. This battery exists
to prove the surfaces treat memory content as data — never as directives — and that the trust
machinery cannot be talked into promoting untrusted content.

## Threat model

| # | Vector | Entry | Expected behavior |
|---|--------|-------|-------------------|
| S1 | Instruction-bearing memory | claim text contains "ignore previous instructions" / "exfiltrate ~/.ssh" / tool-call syntax | recall returns the text verbatim as DATA; no surface executes or follows it; provenance marks it as memory content |
| S2 | Cross-principal leak | records authored under principal A queried in a principal-B session | ZERO results cross the principal boundary on scoped surfaces |
| S3 | Untrusted promotion attempt | capture with forged/self-asserted "verified" verdict | content-addressed records never mutate stamped verdicts; self-evaluation cannot produce team trust; `isRecallEligible` keeps evidence-invalid records out of normal recall |
| S4 | Sync poisoning | a device pushes events referencing records it does not own / forged decisions | D10 no-poison: local-sourced records never enter the sync pool; pulled events apply only within the shared syncRepoId (D2); foreign-repo events surface as refusals, never applied |
| S5 | Secret materialization | memory text containing an API key/token | the store's secret scanner blocks the write (existing law: validate + secret-scan on every write) — a captured secret never persists, never syncs |
| S6 | Injection through capture lanes | hook payload / MCP capture arguments carrying oversized or malformed input | byte caps enforced (64KB hook stdin), fail-open contract holds, only whitelisted fields cross into storage |
| S7 | Path traversal via sync backend | backend URL / sync-id containing `..`, absolute paths, or shell metacharacters | file backend resolves inside its root or refuses; no shell invocation anywhere in the sync path |
| S8 | Tombstone bypass | purged record re-materialized by replaying an old sync batch | pull is idempotent; a retracted record stays retracted (retract beats supersede in `effectiveVerdicts`); re-pull is a no-op |
| S9 | MCP surface confusion | memory op arguments shaped to trigger network side effects | `memory{op:'sync'}` push/pull are rejected over MCP by design; status is the only sync surface an agent session gets |

## Test mapping

Each vector maps to focused automated tests invoked by `pnpm security:battery`. These are control
tests, not a claim that an LLM itself is immune to prompt injection.

| Vector | Executable evidence |
|---|---|
| S1 | `packages/mcp/src/verbs-memory.test.ts` — instruction-bearing text returns only in the provenance-tagged `claim` field |
| S2 | `packages/memory/src/record-v2.test.ts` — scoped recall excludes another principal |
| S3 | `packages/memory/src/promotion.test.ts` — invalid evidence cannot create a team/activated record |
| S4 | `packages/memory/src/sync/engine.test.ts`, `sync/queue.test.ts` — forged payloads and cross-repo events are refused |
| S5 | `packages/memory/src/store.test.ts`, `sync/queue.test.ts`, `sync/engine.test.ts` — secret-bearing writes and staged sync payloads are blocked |
| S6 | `packages/cli/src/memory-capture-hook.test.ts` — malformed and oversized hook input respects the capture boundary |
| S7 | `packages/memory/src/sync/adapter.test.ts` — file-backed reads, writes, and deletes reject traversal keys |
| S8 | `packages/memory/src/sync/engine.test.ts`, `evaluator.test.ts` — replay is idempotent and retraction outranks supersedence |
| S9 | `packages/mcp/src/verbs-memory-v2.test.ts` — MCP rejects push/pull and keeps sync in the CLI control plane |

## Explicit non-goals

- No fuzzing of third-party vendor adapters (out of product boundary).
- No network exploitation testing of the file backend (it is local-FS by contract; a hosted backend
  would need its own threat model before launch).
