# Knowledge-crib — MCP Client Setup Guide

> How to wire the Knowledge-crib MCP server into **Claude Code**, **Cursor**, **GitHub Copilot
> (VS Code)**, and **OpenAI Codex CLI**. One-time machine setup, then **one user-scope entry that
> serves every project** — no per-project config needed.
>
> Knowledge-crib is a local-first "project soul": a knowledge graph of a codebase served to any AI
> coding agent over one MCP server. The agent gets full architectural context (call graphs, blast
> radius, doc↔code links, search) in far fewer tokens, and stops making architecture-breaking changes.

---

## 1. One-time machine setup

Knowledge-crib is a pnpm monorepo. Build it once and link the `crib` CLI onto your PATH so every
project can use it.

```bash
cd ~/Documents/Knowlege-crib          # the knowledge-crib repo
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 build            # builds all 7 packages → dist/
corepack pnpm@9.15.0 release:verify   # production release gate

# Link the CLI globally (crib + knowledge-crib binaries)
corepack pnpm@9.15.0 --filter knowledge-crib link --global
```

Verify:

```bash
which crib                            # /Users/<you>/Library/pnpm/crib
crib --help                           # prints the command list
```

The global link points back at the repo's `dist/`, so `corepack pnpm@9.15.0 build` after a
`git pull` is all you
need to upgrade — no reinstall.

Requirements: Node ≥ 20 and pnpm 9.15.0 via Corepack. macOS/Linux.

### PATH gotcha for GUI-launched clients

Some IDEs launched from the Finder/Dock don't inherit your shell PATH, so `command: "crib"` may not
resolve. If a client can't start the server, use the absolute path instead:

```
/Users/<you>/Library/pnpm/crib        # ← use this if "crib" isn't found
```

(`which crib` prints the absolute path on your machine.)

---

## 2. Per-project setup (do this once per project you want indexed)

Knowledge-crib indexes a project into a queryable graph (the **soul**, persisted in `.crib/`),
then serves it. Indexing is a separate step from serving — the client config only points at the
server; you build the graph from the CLI.

```bash
cd /path/to/your/project
crib index .                          # full index → .crib/ (the soul + derived sqlite index)
crib status .                         # confirm: nodes, edges, clusters, vcsHead
```

That's it. The `.crib/` directory is the project's memory. **Commit `.crib/` to git** so the whole
team (and every agent) shares the same soul — it's chunked JSONL, diff-friendly, and engine-free.

`crib index` also **registers the project** in `~/.crib/registry.json` (see §3) — a local pointer
table mapping this project's absolute path to its `.crib/` dir, so the single user-scope IDE entry
below can find the right soul per workspace. The registry is machine-local (absolute paths) and
gitignored; the soul itself stays committed and portable.

### Supported languages (extractors shipped by default)

| Language | Extensions | Notes |
|---|---|---|
| TypeScript | `.ts .tsx .mts .cts` | Full symbol graph: calls, imports, member-of |
| Python | `.py .pyi` | Module imports, calls, classes |
| PL/SQL | `.sql .pkb .pks .pck .pls .pkh .typ` | Procedures, tables, columns, data-flow |
| Java | `.java` | Symbols, member-of, intra-file calls (imports/cross-file via resolver) |
| C# | `.cs` | Symbols, member-of, intra-file calls (imports/cross-file via resolver) |
| Go | `.go` | Symbols, member-of, intra-file calls (imports/cross-file via resolver) |
| Rust | `.rs` | Symbols, member-of, intra-file calls (imports/cross-file via resolver) |
| Markdown | `.md .markdown` | Doc sections, linked to symbols (describes/references) |

`.js`/`.jsx`/`.cjs`/`.mjs` are discovered as file nodes but **not** symbol-extracted — use
`.ts`/`.tsx`/`.mts`/`.cts` (those *are* extracted). Kotlin (`.kt`/`.kts`) is the one language still
without a plugin — file nodes only; the registry is extensible.

### Excluding cache / non-source dirs

Discovery ignores the usual dirs by default (`.git`, `node_modules`, `build`, `dist`, `.yarn`,
`.gradle`, `target`, `out`, `.turbo`, `.parcel-cache`, `.nuxt`, `.svelte-kit`, `.cache`, `.idea`,
`.vscode`, `.cursor`, …). Add project-specific excludes:

```bash
crib index . --exclude vendor,third_party,generated
```

---

## 3. The MCP server the clients connect to

All four clients launch the same thing:

```
crib serve <project-root>
```

The server speaks MCP over stdio, reads the soul from `<project-root>/.crib/`, and exposes **17
tools** (provenance-tagged + token-bounded so the agent never dumps the whole graph). The 11
structural tools:

| Tool | What it returns |
|---|---|
| `status` | Health + node/edge/cluster counts + VCS anchor + capability flags |
| `query` | Hybrid BM25 search over code + docs |
| `context` | 360° for one symbol: signature, callers, callees, linked docs |
| `source` | Paged source body for a symbol (span rehydration) |
| `dossier` | One-call deep context for a symbol: decision table, raises, handlers, cursors, declares, docs (persisted under `.crib/dossiers/`) |
| `impact` | Blast radius (up=dependents / down=dependencies) + docs |
| `describes` | Doc-sections linked to a symbol (cheap, high value) |
| `neighbors` | Raw adjacency (graph-walking primitive) |
| `shortest_path` | Shortest directed path between two nodes |
| `detect_changes` | Dry-run delta since a git ref (for reviewing diffs) |
| `extract_rules` | Decision table from a procedure's guard-annotated CFG |

Plus `gaps` (unimplemented symbols / missing package bodies / unresolved call sites) and the **5
LLM-graph verbs** — `enrich_status`, `enrich_next`, `enrich_save`, `overview`, `llm_neighbors` —
which drive the optional LLM-authored semantic-graph layer. Those are covered in
[user guide §10](knowledge-crib-user-guide.md#10-the-llm-semantic-graph-layer-the-grove-plan); the
wiring to run them from each client is in §10 below.

### Root resolution — one entry, every project

You do **not** have to pass the exact indexed root, and you do **not** need a per-project IDE
entry. `crib serve` resolves the project root through this priority chain (highest wins):

1. **explicit positional arg** — `crib serve /abs/path` (an arg other than `.`)
2. **`--cwd <path>`** flag
3. **`KCRIB_ROOT`** env var
4. **`CLAUDE_PROJECT_DIR`** env var — Claude Code's real workspace signal (its `cwd` field is
   ignored; see Claude Code issue #42883). This is what makes a single user-scope Claude entry
   serve every project.
5. **upward walk from CWD** for `.crib/crib.json` — handles monorepo subdirs
6. **CWD fallback** — preserves pre-REQ-1 behaviour

Then `~/.crib/registry.json` is consulted as an **overlay**: if the discovered root is registered
with a custom `.crib` location, the soul is opened from there; otherwise the standard
`<root>/.crib` is used. The registry is a **pointer layer, not a second store** — the soul stays
committed inside each project's `.crib/`.

**Practical upshot:** a single user-scope IDE entry (`crib serve` with no path arg, or
`crib serve .`) resolves the correct soul per workspace via `CLAUDE_PROJECT_DIR` + the upward walk +
the registry. Existing per-project entries that pass an explicit root keep working unchanged
(explicit always wins).

### `crib mcp` — auto-wire the IDE configs (REQ-2)

Instead of hand-editing JSON/TOML, run one command per IDE (or `--ide all`):

```bash
crib mcp install --ide all               # project-scope: writes committable per-repo configs
crib mcp install --ide claude --global    # user-scope: one machine-wide entry (serves every project)
crib mcp list                             # show which IDEs have the managed entry
crib mcp remove --ide cursor              # strip the managed entry, leaving sibling content intact
```

It is idempotent (re-running is a no-op), preserves sibling servers byte-for-byte, and embeds the
absolute `which crib` path so GUI-launched IDEs that don't inherit the shell PATH still find the
server. See the per-IDE sections below for what each writes, and the [CLI spec](knowledge-crib-cli.md)
for the full flag reference.

---

## 4. Claude Code

Claude Code reads MCP servers from **project-scoped** `.mcp.json` (committed, recommended) or from
`claude mcp add` (user-scoped). Project-scoped is best for Knowledge-crib because each repo gets its
own soul.

**Option A — project-scoped (recommended, committable):**

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "knowledge-crib": {
      "command": "crib",
      "args": ["serve", "."]
    }
  }
}
```

Then in that project: `claude` will prompt you to approve the project MCP server on first use.

**Option B — CLI (project-scope):**

```bash
crib mcp install --ide claude              # writes .mcp.json with ["serve","."] (committable)
```

**Option C — one user-scope entry for every project (recommended):**

```bash
crib mcp install --ide claude --global     # runs `claude mcp add -s user` with `crib serve` (no path)
```

The global entry runs `crib serve` with **no path arg**, so the root-resolution chain in §3
(`CLAUDE_PROJECT_DIR` → upward walk → registry) picks the right soul per workspace. One entry, every
project — no per-project config.

Verify inside a Claude Code session:

```
/mcp          # lists connected servers + tools; knowledge-crib should show 17 tools (12 structural + 5 LLM-graph)
```

> The `.` in `args` is **not** resolved by Claude Code's CWD — Claude Code ignores the `cwd` field
> (issue #42883). It works because `crib`'s resolution chain falls through to `CLAUDE_PROJECT_DIR`
> (Claude Code's real workspace signal) then the upward walk from CWD. That same chain is why the
> global no-arg entry serves every project.

---

## 5. Cursor

Cursor reads `.cursor/mcp.json` (project, committable) or `~/.cursor/mcp.json` (global).

```bash
crib mcp install --ide cursor             # project: .cursor/mcp.json with ${workspaceFolder}
crib mcp install --ide cursor --global     # global: ~/.cursor/mcp.json (one entry, every project)
```

Or create `.cursor/mcp.json` in the project root by hand:

```json
{
  "mcpServers": {
    "knowledge-crib": {
      "command": "crib",
      "args": ["serve", "${workspaceFolder}"]
    }
  }
}
```

Then **Reload Window** (`Cmd+Shift+P` → "Reload Window") and verify in
**Settings → Tools & MCP** — `knowledge-crib` should show a green (connected) status. The MCP tools
appear in Cursor's agent tool list.

`${workspaceFolder}` resolves to the project root, so the same file works in every repo.

---

## 6. GitHub Copilot (VS Code, "ghcp")

GitHub Copilot Chat in VS Code supports MCP via `.vscode/mcp.json` (GA in VS Code 1.102, July 2025).
**Two differences from Cursor/Claude:** the root key is `servers` (not `mcpServers`) and `type:
"stdio"` is **required**. Tools only run in Copilot **Agent mode**.

```bash
crib mcp install --ide vscode              # writes .vscode/mcp.json (servers + type:stdio)
```

> VS Code/Copilot user-scoped MCP config is not documented upstream, so only project-scope is
> offered (the command notes + skips if you pass `--global`).

Or create `.vscode/mcp.json` in the project root by hand (committable):

```json
{
  "servers": {
    "knowledge-crib": {
      "type": "stdio",
      "command": "crib",
      "args": ["serve", "${workspaceFolder}"]
    }
  }
}
```

Reload the VS Code window. In Copilot Chat, switch to **Agent mode** — the Knowledge-crib tools are
available. Verify in the Output panel (`Cmd+Shift+U`) → "MCP Logs".

Common pitfall: using `mcpServers` here silently loads nothing — it must be `servers` with `type`.

---

## 7. OpenAI Codex CLI

Codex CLI reads `~/.codex/config.toml` (user) or `.codex/config.toml` (project, trusted projects
only). The table is **snake_case** `[mcp_servers.<name>]` — `[mcpServers]` / `[mcp.servers]` is
silently ignored.

```bash
crib mcp install --ide codex              # project: .codex/config.toml (managed TOML block)
crib mcp install --ide codex --global      # global: ~/.codex/config.toml
```

Or add to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.knowledge-crib]
command = "crib"
args = ["serve", "/absolute/path/to/project"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Or via Codex CLI:

```bash
codex mcp add knowledge-crib -- crib serve /absolute/path/to/project
codex mcp list                          # confirm it's registered
```

Inside the Codex TUI, `/mcp` lists active servers and their tools.

> **Honest limitation:** Codex does **not** interpolate `${workspaceFolder}`, so a Codex entry
> must embed an absolute project path — one global Codex entry cannot transparently serve multiple
> projects the way the Claude/Cursor user-scope entries can. Options: (a) one project-scoped
> `.codex/config.toml` per repo (committable, after marking the repo trusted), or (b) one global
> entry per project in `~/.codex/config.toml`. The `~/.crib` registry (§3) still resolves a custom
> `.crib` location if the absolute path's `.crib` was moved, but it cannot make a single Codex
> entry path-agnostic. This is the one IDE where the "single entry for every project" goal is not
> fully achievable; the others reach it via `CLAUDE_PROJECT_DIR` / `${workspaceFolder}`.
---

## 8. Verify it works (any client)

Once connected, ask the agent (in any of the four clients) something only the graph can answer:

> "What calls `ScheduleFilterBar`, and what's the blast radius if I change its props?"

The agent should call `query` → `context` → `impact(dir=up)` and return the callers + dependents —
without re-reading your source files. If the agent can't see Knowledge-crib tools, the server didn't
start: check the client's MCP log and the PATH gotcha in §1.

---

## 9. Updating the soul as the project evolves

Knowledge-crib is incremental (M6). After editing code, refresh the graph:

```bash
crib update .                           # re-extract only files changed since the VCS anchor
# or, for a clean rebuild:
crib reindex .
```

Install git hooks so the soul stays fresh automatically:

```bash
crib install-hooks .                    # post-commit → crib update; .gitattributes merge driver
```

---

## 10. The LLM semantic-graph layer (optional — "build the bible")

The soul from §2 is a **deterministic structural graph** (call edges, member-of, doc↔code links) —
enough for `context` / `impact` / `query` to give an agent precise, low-token context. On top of it
sits an **opt-in LLM-authored semantic graph**: the concepts, business rules, capabilities, and
cross-cutting flows an agent reasons about. This is the **grove plan**. The one hard rule: **the
MCP server never calls a model — the host IDE LLM is the generator.** The server only hands it
grounded work, validates + persists what it authors (under `.crib/llm/`), and reports coverage.

`crib index` / `crib reindex` print a hint after a successful build when targets are uncovered:

```
3 target(s) pending LLM graph generation (next: symbol) — run `/crib-enrich` or `crib enrich --next` to drive the loop.
```

### 10.1 Install the bundled skill (one-time, any client machine)

The loop driver ships **inside the knowledge-crib package** as the `/crib-enrich` skill, so you
install it from the CLI — no separate repo to clone:

```bash
crib skill install                      # copies /crib-enrich to ~/.claude/skills/ (idempotent; skips byte-identical re-installs)
crib skill list                         # show bundled skills
```

This makes `/crib-enrich` available in **Claude Code** (the only client with a slash-command skill
system today). Cursor / Copilot / Codex have no equivalent skill loader, so from those clients you
drive the same loop headlessly via the CLI (§10.3).

### 10.2 Run the loop from Claude Code

In a Claude Code session in the indexed project, type `/crib-enrich` (or say "enrich the crib" /
"build the LLM graph" / "generate the codebase bible"). The skill drives
`enrich_status → enrich_next → author → enrich_save` one batch per turn, bottom-up
(`symbol → file → cluster → system`), then calls `overview` to render the bible. It reports
accepted/rejected counts + `droppedEdges` after each batch and a one-line bible summary at the end.
Full detail on the loop, the author contract, and grounding rules is in
[user guide §10](knowledge-crib-user-guide.md#10-the-llm-semantic-graph-layer-the-grove-plan).

### 10.3 Run the loop headlessly (Cursor / Copilot / Codex, or any CLI)

The same loop without an IDE skill:

```bash
crib enrich --status                              # coverage per layer + nextLayer + done
crib enrich --next [--layer symbol] [--limit 4]  # prints a grounded batch (seed + schema per item)
# author items to a JSON file shaped {batchId, items} against each item's outputSchema, then:
crib enrich --save ./batch.json                   # validates + persists → {accepted, rejected, droppedEdges}
crib enrich --overview                            # the bible (after the system layer)
```

### 10.4 Capability flags — what flips, what doesn't

`status.capabilities` reports five flags. After the loop runs:

| Flag | After the loop | Why |
|---|---|---|
| `llmGraph` | **`true`** | Flips on after the first `enrich_save` — the only flag the grove moves. |
| `embeddings` | `false` (always) | Embeddings need a model (violates the no-model invariant) + `better-sqlite3` has no ANN. The LLM graph replaces that need via `withLlm` at query time. |
| `vector` | `false` (always) | Same reason — BM25 + the TF-IDF linker are the deterministic recall path. |
| `multimodal` | `false` unless `--multimodal` | Opt-in via `crib index --multimodal` (spawns `crib_worker`); unrelated to the grove. |
| `cypher` | `false` (always) | No Cypher query layer. |

Commit `.crib/llm/` alongside the rest of the soul — it's the same chunked-JSONL, diff-friendly,
engine-free format, so the whole team shares one authored semantic graph.

---

## Sources

- Cursor MCP config: <https://cursor.com/docs/mcp.md>
- VS Code / GitHub Copilot MCP config: <https://code.visualstudio.com/docs/copilot/reference/mcp-configuration>
- OpenAI Codex CLI MCP: <https://developers.openai.com/codex/mcp>
- Claude Code MCP: <https://docs.claude.com/en/docs/claude-code/mcp>
