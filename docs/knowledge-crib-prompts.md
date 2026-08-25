# Knowledge-crib — Prompting Guide (how to talk to your local LLM so crib does the work)

> **The one rule that saves the most tokens + compute:** never paste a codebase into the prompt.
> Point the model at a *symbol id* and let crib rehydrate exactly the slice it needs — a dossier, a
> decision table, a blast radius — through one MCP call. The model reasons over crib's structured
> answer, not a wall of source. This is what makes crib work well on **local LLMs** (Claude Code or
> Codex via MCP) with small context windows and tight compute budgets.

This guide assumes crib is installed and wired into your IDE/agent as an MCP server (`crib serve`).
If not, see [client-setup](knowledge-crib-client-setup.md) — one line per client:
- Claude Code: `crib mcp install --ide claude --global`
- Cursor: `crib mcp install --ide cursor --global`
- Codex (local): `codex mcp add knowledge-crib -- crib serve /absolute/path/to/project`

Then `crib index` once per repo. After that the verbs below are available to the model as tools:
`status · context · source · dossier · impact · query · neighbors · brief ·
detect_changes · extract_rules`.

---

## 0. The mental model — what to ask for, when

| You want | Verb | Why it's cheap |
|----------|------|----------------|
| "What is this thing + who uses it + its rules + its error paths" | **`dossier`** | One call returns the *whole* deep context for a callable, persisted on disk so a repeat is a cache hit. The single highest-leverage verb. |
| "Where is X mentioned in code AND docs" | **`query`** | Hybrid BM25+semantic, process-grouped, `truncated` flag stops dumps. |
| "If I change this, what breaks" | **`impact`** | Blast radius up/down with inherited guard chains + affected docs. |
| "The actual source body of one node" | **`source`** | Span-based rehydration, budgeted (`maxChars`/`maxLines`). Only when you need raw text. |
| "The decision table / rule book of a proc" | **`extract_rules`** | Flattens the CFG into condition→action rows. The migration deliverable. |
| "What changed since this commit" | **`detect_changes`** | Scoped to the diff — review/PR sizing. |

**Defaults that keep payloads small:** `docLimit=3`, `limit=10`, every edge carries
`{provenance, confidence}` so you can say "EXTRACTED-only" with `extractedOnly:true` to drop LLM
guesses. `truncated:true` + a cursor means *deliberately pull more* — the model never auto-walks the
whole graph.

---

## 1. Onboarding / "explain this repo to me" — *without reading every file*

❌ Don't: "read the whole codebase and explain the architecture" (huge token burn, stale by the time
it finishes).

✅ Do:
```
Use knowledge-crib. First call `status` to confirm the project is indexed.
Then `query` for "entry point" and "request handling" (limit 8 each).
For the top 3 symbols by cluster size, call `dossier` with format=markdown
and give me a 1-paragraph summary of each + how they call each other.
Don't paste source files — work from the dossiers.
```
**Why it saves compute:** the model pulls ~3 dossiers (each a few hundred lines of structured
context, cached on disk) instead of ingesting the repo. A local 13B-class model handles this fine.

---

## 2. Impact analysis before a change — *the canonical crib prompt*

```
I'm about to change the signature of AuthService.issue (id sym:src/auth/TokenService.ts#TokenService.issue@L88).
Use crib `impact` dir=up depth=4, then `impact` dir=down depth=3.
List the callers that will break (up) and the behavior that changes downstream (down),
each with its inherited guard chain (cfgPath) so I know the *conditions* under which it fires.
Then `describes` on the same id to surface any docs I'd need to update.
Keep it to the EXTRACTED edges only (extractedOnly=true).
```
**Why:** `impact` returns the AND-chain of guards per affected node — you learn *not just* that
`create_review` is reachable but that it's reachable *only when `v_amt > 10000`*. That's the rule,
not a guess. `extractedOnly=true` strips INFERRED edges so a local model isn't misled by heuristic
links.

---

## 3. Migration / rule extraction — *the wedge crib was built for*

For a PL/SQL → Java/.NET/COBOL rule-engine migration, the deliverable is the **decision table**:
```
Use crib `extract_rules` on sym:claims.pkb#process_claim@L10.
Hand me the rule book: for each terminal action, the AND-chain of conditions that reach it,
the source line, and the tables/columns it reads/writes.
Then do the same with no proc arg (whole system) and group rules by cluster.
```
Then prove the rebuild matches:
```
Now point crib at the migrated Java version, `extract_rules` on the equivalent method,
and diff the two decision tables row-by-row. Flag any rule present in PL/SQL but missing in Java.
```
**Why:** rules are deterministic/EXTRACTED — no LLM is in the rule path, so a local model can drive
the *comparison* reliably even though it couldn't reliably *derive* the rules itself.

---

## 4. Deep-dive one symbol — *the dossier prompt (highest leverage)*

The `dossier` verb folds source + callers/callees + decision table + control-flow constructs
(raises, exception handlers, cursors, case-branches, declared cursors) + linked docs into **one**
persisted artifact. For a local LLM this is the difference between "I can reason about this" and "I
ran out of context":
```
Use crib `dossier` id=sym:…#assess_application@L39 format=markdown extractedOnly=true.
Then answer: what error codes can this proc raise, under which conditions, and which
exception handlers catch them? Which cursor does it iterate and what does the decision table say?
```
The markdown comes back with fixed sections — `## Raises`, `## Exception handlers`, `## Iterates
(cursors)`, `## Decision table` — so you can also ask:
```
From the dossier markdown, extract only the "## Raises" and "## Exception handlers" sections
into a runbook entry. Don't include the source body.
```
**Paging a large body** (keep the local model in context budget):
```
Call `dossier` with sourceMaxLines=120 (first page). If the source is truncated,
call again with sourceStartLine=<the nextLine it returned> for the next page.
Don't fetch the whole body at once.
```

---

## 5. Debugging — *let crib narrow the blast radius before the model reads anything*

```
There's a NullPointerException when a loan > 50000 is rejected.
Use crib: `query` "reject loan" → get the candidate symbols.
`dossier` the top candidate (extractedOnly=true, markdown).
From the dossier's Decision table + Raises + Exception handlers, tell me which
raise/error path fires for amount>50000 & credit<700, and which caller feeds it.
Only then, if needed, `source` the exact raising line.
```
**Why:** the model starts from a structured hypothesis (the decision table already encodes
`WHEN v_amt > 50000 AND v_score >= 700 → APPROVE; ELSE → REJECT; IF REJECT → RAISE -20001`) instead
of grepping blindly. Fewer tokens, fewer wrong turns.

---

## 6. Code review / PR sizing

```
Use crib `detect_changes` since=<the PR base sha>.
For each changed symbol, `impact` dir=up depth=2 and report which callers are affected.
Summarize the blast radius in 5 bullets — don't paste diffs, work from the change graph.
```

---

## 7. Codex-specific notes (local OpenAI/Codex CLI)

Codex exposes MCP tools the same way; the only wrinkle is the config is snake_case:
```toml
# ~/.codex/config.toml
[mcp_servers.knowledge-crib]
command = "crib"
args = ["serve", "/absolute/path/to/project"]
```
or `codex mcp add knowledge-crib -- crib serve /abs/path`. Then prompt exactly as above — the verbs
are identical. **Tip for small local models:** always pass `extractedOnly=true` and a small `limit`
(5–8); INFERRED/semantic edges confuse a small model more than they help. Use `dossier` over
`context`+`source` whenever you can — one call replaces three.

---

## 8. Anti-patterns (what burns tokens / misleads a local model)

- **Pasting source into the chat.** Use `source`/`dossier` instead — crib rehydrates the slice.
- **Calling `context` + `source` + `extract_rules` separately** when `dossier` returns all three.
- **Forgetting `extractedOnly:true`** on a local model — INFERRED edges read as fact.
- **Walking the graph manually** with `neighbors` ("give me everything"). Use `impact` (bounded
  depth, inherited guards) or `impact({op:'path'})` (targeted).
- **Ignoring `truncated:true`.** It's a cursor, not an error — page deliberately.
- **Re-indexing mid-session.** `crib index` is a commit-time action; for live edits use `update`
  (incremental, cost ∝ change size).

---

## 9. Prompt skeleton you can keep at the top of a session

```
You have the knowledge-crib MCP tools. Prefer `dossier` (format=markdown, extractedOnly=true)
for any symbol, `impact` for blast radius, `query` for "where is X", and `extract_rules` for
rules. Never paste repo source — rehydrate via crib. If a result is truncated, page with the
returned cursor. Report EXTRACTED edges only unless I ask for inferred.
```
Paste that once, then ask in plain language. crib does the retrieval; the model does the reasoning.