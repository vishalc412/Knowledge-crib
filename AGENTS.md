> **Memory tool policy:** knowledge-crib is the only memory / code-context tool for this repository. Graphify, GitNexus, gstack/gbrain, claude-mem, Context7, Remember, Greptile, Sourcegraph, and Hermes RAG are disabled here — do not install, invoke, or suggest them for this project; use the crib protocol below instead.
> **Default for context:** before reading files or grepping to understand code, run `crib query`/`context`/`brief` first — it is local, deterministic, and far cheaper in tokens and turns than exploring by hand. Fall back to file reads only for what the graph can't answer.

<!-- crib:start -->
## Knowledge-crib is MANDATORY in this repository

Knowledge-crib is the single source of truth for this repository’s memory and code context. It is not one option among several, and it is not decided per session: every agent, in every IDE, on every task, follows the protocol below. The sections after this one say HOW; this one says that none of them are optional.

- **Every session starts here.** Restore durable work (§1) and recall (§2) BEFORE planning, reading files, or editing. Do not rebuild project understanding by re-reading the tree when the graph already holds it.
- **Structural questions go to the graph first.** `query`, `context`, `impact`, `review`, `explain` and `detect_changes` come before grep and before opening files (§6–§9). Read specific files only for what the graph cannot answer, and say which part that was.
- **Every reusable learning is recorded here** (§3) with admissible evidence (§4). A learning that lives only in a transcript is lost at the end of the session.
- **No substitute and no side-store.** Do not use another memory, RAG, or code-context tool in place of this one for this repository, and do not keep private project knowledge outside it. One substrate is what makes every agent and every IDE read and write the same memory.
- **Mandatory is not the same as infallible.** The honesty signals in §6–§9 still govern. Crib reports what it can see; it never certifies that an edit is safe. An empty result, a `truncated` walk, or a `note`-qualified report is a limit of the index — never an all-clear.

## Knowledge-crib agent memory protocol (vendor-neutral)

This repository uses knowledge-crib as a shared, vendor-neutral memory substrate. Every agent session — Claude, Cursor, Copilot/VS Code, Codex, Windsurf, Gemini, or any MCP-capable tool — follows this protocol. It does not change your tool; it tells you how to use memory safely.

### 1. Restore durable work before acting
- Run handoff before relying on prior project context: call the `memory` MCP tool with `op: "handoff"` (or run `crib session bootstrap --json`). Read its `continuation` block: it states the question, the selectable options (each `resume:<intakeId>`, plus `fresh`), and any `cautions` on an option. Take `recommended` when it is present; when it is absent, ASK the user to choose rather than picking one — an absent recommendation means several intakes are resumable, or the only one needs a deliberate look (repository drift, blockers, conflicts).
- Act on the choice explicitly: `crib session resume <intakeId> --next "<next step>"` records the resume so a later session can tell resumed work from abandoned work, and `crib session fresh` starts new work while leaving every unfinished intake open and resumable. Starting fresh never closes anything; retire an intake with `crib intake complete` or `crib intake cancel`.
- Create or match a durable intake for meaningful user work before planning or editing. Preserve the sanitized original request, interpreted outcome, scope, constraints, and acceptance criteria; never store full transcripts or chain-of-thought.
- Checkpoint unfinished intake work at meaningful boundaries: after selecting a plan, after material progress, when blocked, and before ending a session. Record completed step IDs, artifacts/receipts, and one concrete next safe action.
- Validate repository drift from the saved checkpoint before resuming. If HEAD, branch, or the dirty-path digest changed, re-check the plan and next action against the current tree rather than blindly continuing.
- Never share or sync an intake implicitly. Device sync requires configured encrypted sync plus an explicit devices audience; team visibility requires an explicit team share into Git-backed memory.

### 2. Recall before you act
- Before relying on a reusable claim, call the `brief` MCP tool (or the `memory_recall` MCP tool, or `crib memory recall "<query>"`) to surface team + local memory for this repository. Memory is the source of truth across sessions — do not assume last session’s state still holds.
- `brief` returns typed groups: team before local, valid before degraded, current before needs-review. Never mix memory results with BM25 code-search results into one opaque list.
- Recall and handoff read DIFFERENT stores, and neither answers for the other. `brief` and `memory_recall` read the CLAIM LEDGER (distilled reusable claims); `memory` with `op: "handoff"` reads INTAKES (durable work in progress, §1). An empty recall is evidence about the ledger alone — it is never evidence that there is no unfinished work, so do not report "no memory for this repository" on a recall alone. Check both stores before concluding either is empty.
- Recall deliberately excludes untrusted records. `memory_recall` never returns pending, invalid, superseded or retracted records, so a claim captured but not yet distilled is absent by design, not missing. Pass `includePending: true` to see those as a separate, explicitly untrusted group — leads, never facts.

### 3. Record only reusable learnings
- Persist a memory (via `memory_observe`, or `crib memory propose/attest`) ONLY when it is reusable beyond the current task: a non-obvious fact, a verified procedure, a decision with rationale, a pitfall and its fix, or a convention.
- NEVER persist ephemeral state, full transcripts, chain-of-thought, raw command output, or secrets. Default `brief` stays within 2,000 tokens; default recall within 1,200.

### 4. Provide evidence — never self-evaluate
- Every memory must carry admissible evidence grounded in the repository: source-quote, execution-assertion, committed-policy, human-attestation, or receipt-pair. An agent NEVER self-asserts a pass: a passing local gate produces a receipt; team trust requires both CI success AND presence on a configured trusted Git ref.
- Never claim a memory is verified, trusted, or current on your own authority. State what you observed; the freshness engine derives those verdicts from the evidence.

### 5. Non-destructive
- Memory lives in `.crib/memory/` (team) and `~/.crib/memory/` (local/global) — NOT in this file. Removing this adapter (or this client) removes only this managed block; it does not delete memory. On disagreement do not delete team memory; supersede or quarantine it with admissible counter-evidence instead.

## Knowledge-crib code intelligence protocol

The same MCP server that serves memory also serves this repository’s code graph. Use the graph, not a text search, to answer structural questions — and read its honesty signals rather than assuming a clean result.

### 6. Analyse blast radius before you edit
- Before changing a function, class, or method, call `impact({ id: "<symbol>", dir: "up" })` (`op` defaults to `blast`; `dir: "up"` = dependents, `dir: "down"` = dependencies). Report the affected symbols before editing.
- `risk` on each affected node is DISTANCE-derived, not a judgement: `high` at distance 1, `medium` at 2, `low` beyond. It ranks proximity — it never certifies that an edit is safe.
- An empty `affected` list is NOT evidence the symbol is unused. It can equally mean the edges are not resolvable by the index (dynamic dispatch, plain-object property access, cross-language calls, reflection). Confirm with a text search before treating a symbol as dead.
- `truncated: true` means the walk was cut at a limit — the result is a page, not the blast radius. Raise `limit`/`depth` or page with `cursor` before drawing a conclusion.

### 7. Analyse graph changes before you commit
- Run `detect_changes({})` (optionally `{ since: "<ref>" }`) and review `changedSymbols`, `removedEdges`, `changedPaths` (committed since the anchor) and `uncommittedPaths` (still in the working tree). Both path sets feed `changedSymbols`, so the check works BEFORE you commit.
- A `note` QUALIFIES the report — it is degraded or narrowed in scope, never a clean bill of health. `vcs adapter not configured`, `not a git work tree` and `no incremental anchor` all return empty arrays; `no commits since the anchor …` means the commit range was empty by construction. Never read an empty result carrying a `note` as "nothing changed".

### 8. Review a change with `review`, not by reading the files
- Asked to review, diff, or assess a change, call `review({})` FIRST. It returns what changed, each changed DECLARATION with its signature, who calls it, and prior trusted decisions about it — in one bounded call.
- This is not a style preference, it is a budget. On a real commit in this repository, reading every touched file costs ~212,000 tokens while `review` costs ~2,000 (docs/bench/review-cost.md). A review that reads files does not fit, so it degrades into skimming a few lines and guessing — which is the failure this verb exists to remove.
- Pair it with the diff: the diff says WHAT changed, `review` says who it affects and what was already decided. Read specific files only for what neither answers.
- An empty `callers` list is labelled and is NOT evidence a symbol is unused; a `note` means the change set itself is degraded, so every count is a floor.

### 9. Prefer graph verbs over grep
- Explore unfamiliar code with `query({ q: "<concept>" })`; get callers, callees, and docs for one symbol with `context({ id: "<symbol>" })`; find owning files/modules with `impact({ op: "owners", id })`; find how two symbols connect with `impact({ op: "path", from, to })`.
- Rename through `rename({ from, to })` — it plans across the call graph and is dry-run by default; apply only with the returned `planId`. Never rename with find-and-replace.
- `explain({ id })` reports taint/dataflow findings for one callable. `status({ op: "gaps" })` reports what the graph does NOT cover — read it before claiming coverage.
- If the index is stale, refresh it with `crib index` (or `crib update`). A stale graph answers confidently and wrongly.
<!-- crib:end -->
