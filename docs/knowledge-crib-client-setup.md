# Knowledge-crib — MCP Client Setup Guide

> How to wire the Knowledge-crib MCP server into **Claude Code**, **Cursor**, **GitHub Copilot
> (VS Code)**, and **OpenAI Codex CLI**. One-time machine setup, then a 2-line per-project config.
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
pnpm install
pnpm build                            # builds all 7 packages → dist/
pnpm test                             # optional: confirm 165 tests pass

# Link the CLI globally (crib + knowledge-crib binaries)
cd packages/cli && pnpm link --global
```

Verify:

```bash
which crib                            # /Users/<you>/Library/pnpm/crib
crib --help                           # prints the command list
```

The global link points back at the repo's `dist/`, so `pnpm build` after a `git pull` is all you
need to upgrade — no reinstall.

Requirements: Node ≥ 20 (22+ recommended), pnpm 9.x. macOS/Linux.

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

### Supported languages (extractors shipped by default)

| Language | Extensions | Notes |
|---|---|---|
| TypeScript | `.ts .tsx .mts .cts` | Full symbol graph: calls, imports, member-of |
| Python | `.py .pyi` | Module imports, calls, classes |
| PL/SQL | `.sql .pkb .pks .pck .pls .pkh .typ` | Procedures, tables, columns, data-flow |
| Markdown | `.md .markdown` | Doc sections, linked to symbols (describes/references) |

`.js`/`.jsx` are discovered as file nodes but **not** symbol-extracted (use `.ts`/`.tsx`). Java,
Kotlin, Go, Rust are discovered as file nodes only (extractors not yet shipped).

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

The server speaks MCP over stdio, reads the soul from `<project-root>/.crib/`, and exposes **9
tools** (provenance-tagged + token-bounded so the agent never dumps the whole graph):

| Tool | What it returns |
|---|---|
| `status` | Health + node/edge/cluster counts + VCS anchor |
| `query` | Hybrid BM25 search over code + docs |
| `context` | 360° for one symbol: signature, callers, callees, linked docs |
| `impact` | Blast radius (up=dependents / down=dependencies) + docs |
| `describes` | Doc-sections linked to a symbol (cheap, high value) |
| `neighbors` | Raw adjacency (graph-walking primitive) |
| `shortest_path` | Shortest directed path between two nodes |
| `detect_changes` | Dry-run delta since a git ref (for reviewing diffs) |
| `extract_rules` | Decision table from a procedure's guard-annotated CFG |

The `<project-root>` you pass to `crib serve` **must be the indexed root** (the dir containing
`.crib/`). Every config below uses a workspace variable so the right project soul is served in each
workspace.

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

**Option B — CLI:**

```bash
claude mcp add knowledge-crib -- crib serve /absolute/path/to/project
```

Verify inside a Claude Code session:

```
/mcp          # lists connected servers + tools; knowledge-crib should show 9 tools
```

> The `.` in `args` is resolved by `crib` relative to its own CWD, which Claude Code sets to the
> project root. For an absolute guarantee, use the absolute project path.

---

## 5. Cursor

Cursor reads `.cursor/mcp.json` (project, committable) or `~/.cursor/mcp.json` (global).

Create `.cursor/mcp.json` in the project root:

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

Create `.vscode/mcp.json` in the project root (committable):

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

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.knowledge-crib]
command = "crib"
args = ["serve", "/absolute/path/to/project"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Or via CLI:

```bash
codex mcp add knowledge-crib -- crib serve /absolute/path/to/project
codex mcp list                          # confirm it's registered
```

Inside the Codex TUI, `/mcp` lists active servers and their tools.

> Codex doesn't interpolate `${workspaceFolder}`, so for a portable per-project setup use the
> project-scoped `.codex/config.toml` (after marking the repo as a trusted project) with an
> absolute path, or maintain one global entry per project.

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

## Sources

- Cursor MCP config: <https://cursor.com/docs/mcp.md>
- VS Code / GitHub Copilot MCP config: <https://code.visualstudio.com/docs/copilot/reference/mcp-configuration>
- OpenAI Codex CLI MCP: <https://developers.openai.com/codex/mcp>
- Claude Code MCP: <https://docs.claude.com/en/docs/claude-code/mcp>