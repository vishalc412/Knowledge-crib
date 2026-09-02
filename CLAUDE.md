<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **knowledge-crib** (16315 symbols, 47597 relationships, 500 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/knowledge-crib/context` | Codebase overview, check index freshness |
| `gitnexus://repo/knowledge-crib/clusters` | All functional areas |
| `gitnexus://repo/knowledge-crib/processes` | All execution flows |
| `gitnexus://repo/knowledge-crib/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
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
