# Knowledge-crib — CLI Spec

> `crib` (also `npx knowledge-crib`). Thin wrapper over `core` + `pipeline`. The CLI builds/maintains
> the soul; `serve` exposes it over MCP. Cross-platform (Node).

---

## Global flags
| Flag | Default | Meaning |
|------|---------|---------|
| `--cwd <path>` | (unset) | **Implemented.** Highest-priority explicit root for any command (see Root resolution). May appear before or after the command. |
| `--exclude a,b,…` | (defaults) | Discovery ignore set on top of `DEFAULT_IGNORES`. Repeatable. |
| `--with-embeddings` | off | Build the vector index (else BM25-only). |
| `--port <N>` | (viz default) | Port for `crib viz`. |

> Flags shown as **planned** below (`--json`, `--quiet/--verbose`, `--link-threshold`,
> `--include`, `--lang`, `--worker-timeout`, `--transport`, `--extracted-only`, `migrate`) are in the
> spec but **not yet wired** in `cli.ts`. They are accepted where noted but may be no-ops. This section
> is reconciled with the implemented `printHelp` in `packages/cli/src/cli.ts`.

## Root resolution (REQ-1)
Path-taking commands (`serve`, `status`, `update`, `export`, `viz`, `query`) resolve the project
root through a priority chain — **explicit positional arg (not `.`) → `--cwd` → `KCRIB_ROOT` →
`CLAUDE_PROJECT_DIR` → upward walk from CWD for `.crib/crib.json` → CWD** — then consult
`~/.crib/registry.json` as an overlay for a custom `.crib` location. This lets one user-scope IDE
entry serve every project. `crib index`/`reindex` target the exact given dir (no upward walk) and
register the project in `~/.crib/registry.json`. `crib query`'s positionals are the search text, not
a root — use `--cwd`/env/CWD for the root.

## `crib index [path]`
Full index → writes soul + builds the derived index. Targets the exact given dir (no upward walk).
Registers the project in `~/.crib/registry.json`.
```
crib index .                      # index current repo
crib index . --with-embeddings    # also build vectors (semantic search)
crib index . --exclude vendor,third_party,generated
```
| Flag | Status | Meaning |
|------|--------|---------|
| `--with-embeddings` | ✅ | build vector index (else BM25-only) |
| `--exclude <a,b,…>` | ✅ | add dirs to the discovery ignore set (repeatable) |
| `--include <glob>` | planned | scope files (not yet wired) |
| `--lang <a,b>` | planned | restrict languages (not yet wired) |
| `--worker-timeout <ms>` | planned | per-file parse timeout (not yet wired) |

## `crib update [--since <ref>]`
Incremental update from changed files (default: `manifest.incrementalSince`). Rewrites only affected
soul chunks + touched index slice. Registers/refreshes the project in `~/.crib/registry.json`.

## `crib serve [path]`
Start the MCP server (stdio). What an agentic IDE connects to. Root resolved per the chain above.
```
crib serve                        # stdio MCP; root from --cwd/KCRIB_ROOT/CLAUDE_PROJECT_DIR/walk/cwd
crib serve /abs/path               # explicit root (wins)
```
| Flag | Status | Meaning |
|------|--------|---------|
| `--transport stdio` | planned | only stdio in v1 (flag accepted, no-op) |
| `--extracted-only` | planned | serve EXTRACTED edges only (not yet wired) |

## `crib reindex [path]`
Full re-index (alias for `crib index`). Re-registers the project.

## `crib mcp <install|list|remove> [--ide <name|all>] [--global] [--bin <path>] [path]`  (REQ-2)
Auto-wire the MCP server into each IDE's config file — no hand-editing JSON/TOML. Idempotent,
non-clobbering (sibling servers preserved), embeds the absolute `which crib` path by default.
```
crib mcp install --ide all               # project-scope: committable per-repo configs for all 4 IDEs
crib mcp install --ide claude --global   # user-scope: one machine-wide entry (serves every project)
crib mcp list                            # present/absent per IDE + scope
crib mcp remove --ide cursor             # strip only the managed entry, keep siblings
```
| Flag | Meaning |
|------|---------|
| `--ide <claude\|cursor\|vscode\|codex\|all>` | IDE target (default `all` for install/list) |
| `--global` | write the user-scope config instead of the project-scope one |
| `--bin <path>` | override the embedded `command` (default: absolute `which crib`) |

Per-IDE behavior:
- **claude** — project: `.mcp.json` (`mcpServers`, `["serve","."]`); global: shells out to
  `claude mcp add -s user` with `["serve"]` (no path → resolution chain serves every project).
- **cursor** — project: `.cursor/mcp.json` (`mcpServers`, `${workspaceFolder}`); global:
  `~/.cursor/mcp.json`.
- **vscode** — project: `.vscode/mcp.json` (`servers` + `type:"stdio"`, `${workspaceFolder}`); global
  unsupported (notes + skips).
- **codex** — project: `.codex/config.toml` (`[mcp_servers.knowledge-crib]`, absolute path — Codex has
  no interpolation); global: `~/.codex/config.toml`.

## `crib export [--format <fmt>] [--procedure <id|name>]`
Emit a portable view.
```
crib export --format graph.json   # single flat Graphify-compatible file
crib export --format mermaid       # architecture / CFG diagram
crib export --format report        # GRAPH_REPORT.md (clusters, god-nodes, suggested questions)
crib export --format rules --procedure <id|name>   # decision table for a procedure
```

## `crib viz [path] [--port <N>]`
Serve the offline web UI (Claude Design DC-runtime canvas) over the soul graph and open a browser.

## `crib status [path]`
Print manifest stats: nodes/edges/clusters, `schemaVersion`, `vcsHead`, capabilities, staleness.

## `crib query <text>`
One-shot hybrid query from the terminal (same engine as the MCP `query` verb). Positionals are the
query text — **not** a root; root comes from `--cwd`/env/CWD.
```
crib query "where is the session token issued?"
```

## `crib install-hooks [path]`
Install the git **post-commit** hook (auto `crib update`) and the `.crib` **merge driver** (resolves
chunk conflicts via the deterministic conflict rule).

## `crib merge-driver %O %A %B %P`
Git custom merge driver for one `.crib` JSONL chunk.

## `crib migrate`  (planned)
Upgrade an older soul to the current `schemaVersion`/`cribFormatVersion` (round-trip safe). Spec'd,
not yet wired.

---

## Exit codes
`0` ok · `1` generic error · `2` bad args · `3` not indexed (run `crib index`) · `4` migration required.

## Typical lifecycle
```
crib index .                       # once (also registers in ~/.crib/registry.json)
crib install-hooks                  # keep soul fresh on every commit
crib mcp install --ide claude --global   # one user-scope entry → serves every project
crib serve                          # agents connect (resolution chain picks the soul)
crib export --format graph.json     # share / feed SeeroFlow
```
