<!-- crib:start -->
## Knowledge-crib agent memory protocol (vendor-neutral)

This repository uses knowledge-crib as a shared, vendor-neutral memory substrate. Every agent session — Claude, Cursor, Copilot/VS Code, Codex, Windsurf, Gemini, or any MCP-capable tool — follows this protocol. It does not change your tool; it tells you how to use memory safely.

### 1. Recall before you act
- Before relying on a reusable claim, call the `brief` MCP tool (or `crib memory recall "<query>"`) to surface team + local memory for this repository. Memory is the source of truth across sessions — do not assume last session’s state still holds.
- `brief` returns typed groups: team before local, valid before degraded, current before needs-review. Never mix memory results with BM25 code-search results into one opaque list.

### 2. Record only reusable learnings
- Persist a memory (via `memory_observe`, or `crib memory propose/attest`) ONLY when it is reusable beyond the current task: a non-obvious fact, a verified procedure, a decision with rationale, a pitfall and its fix, or a convention.
- NEVER persist ephemeral state, full transcripts, chain-of-thought, raw command output, or secrets. Default `brief` stays within 2,000 tokens; default recall within 1,200.

### 3. Provide evidence — never self-evaluate
- Every memory must carry admissible evidence grounded in the repository: source-quote, execution-assertion, committed-policy, human-attestation, or receipt-pair. An agent NEVER self-asserts a pass: a passing local gate produces a receipt; team trust requires both CI success AND presence on a configured trusted Git ref.
- Never claim a memory is verified, trusted, or current on your own authority. State what you observed; the freshness engine derives those verdicts from the evidence.

### 4. Non-destructive
- Memory lives in `.crib/memory/` (team) and `~/.crib/memory/` (local/global) — NOT in this file. Removing this adapter (or this client) removes only this managed block; it does not delete memory. On disagreement do not delete team memory; supersede or quarantine it with admissible counter-evidence instead.
<!-- crib:end -->
