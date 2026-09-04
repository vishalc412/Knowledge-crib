# Knowledge-crib — CLI Spec

> `crib` (also `npx knowledge-crib`). Thin wrapper over `core` + `pipeline`. The CLI builds/maintains
> the soul; `serve` exposes it over MCP. Cross-platform (Node).

---

## Global flags
| Flag | Default | Meaning |
|------|---------|---------|
| `--cwd <path>` | (unset) | **Implemented.** Highest-priority explicit root for any command (see Root resolution). May appear before or after the command. |
| `--exclude a,b,…` | (defaults) | Discovery ignore set on top of `DEFAULT_IGNORES`. Repeatable. |
| `--semantic` | off | Run the M7 INFERRED TF-IDF semantic linker after the deterministic linker (adds capped `references` edges, provenance `INFERRED`, confidence ≤0.6). Zero-dep, pure JS. Off by default so `--extracted-only` stays the pure deterministic subset. |
| `--port <N>` | (viz default) | Port for `crib viz`. |
| `--package <name\|all>` | (full walk) | Monorepo only — scope `crib index`/`reindex` discovery to one workspace package (or `all` for the full walk). Repeatable / comma-separated. See `crib index` below. |

> Flags shown as **planned** below (`--json`, `--quiet/--verbose`, `--link-threshold`,
> `--include`, `--lang`, `--worker-timeout`, `--transport`, `--extracted-only`) are in the
> spec but **not yet wired** in `cli.ts`. They are accepted where noted but may be no-ops. This section
> is reconciled with the implemented `printHelp` in `packages/cli/src/cli.ts`.
>
> **No `crib migrate` command exists** (nor is one planned) — see [Schema evolution](#schema-evolution)
> below. Schema evolution is automatic and additive; an old soul loads verbatim and is brought up to
> the current shape by re-indexing.

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
crib index . --semantic            # also run the INFERRED TF-IDF semantic linker (references edges)
crib index . --exclude vendor,third_party,generated
crib index . --package FTCCloud     # monorepo: scope discovery to one package (sibling packages pruned)
crib index . --package all          # monorepo: full walk (explicit)
crib index . --multimodal           # opt in: extract PDF text layers (TS-native), OCR images, transcribe audio
```
| Flag | Status | Meaning |
|------|--------|---------|
| `--semantic` | ✅ | run the INFERRED TF-IDF semantic linker (adds capped `references` edges) |
| `--multimodal` | ✅ | **opt-in media phase** (default OFF — the default index never touches media or spawns a
|       |        | subprocess). Extracts `media-seg` nodes from media files and links them to symbols. PDF
|       |        | text layers extract TS-natively (bundled pure-JS pdf.js, no binary, no Python). Image OCR runs
|       |        | `tesseract` and audio/video transcription `whisper` **only when the binary is on PATH** — an
|       |        | absent binary degrades to an honest `unavailable` report, never fabricated output. |
| `--multimodal-backend <auto\|fake\|pdf\|audio\|image>` | ✅ | backend override (default `auto` = production
|       |        | adapters). `fake` reads `.wav.txt` sidecars via the legacy Python `crib_worker` (tests);
|       |        | `pdf`/`audio`/`image` force the legacy Python backends (requires python3). |
| `--multimodal-model-path <dir>` | ✅ | local whisper model for transcription. Required by `--multimodal` for
|       |        | audio/video — a *named* model would be fetched over the network, which crib never does. |
| `--exclude <a,b,…>` | ✅ | add dirs to the discovery ignore set (repeatable) |
| `--package <name\|all>` | ✅ | **monorepo only.** Scope discovery to one workspace package by name or
|       |        | repo-relative path (e.g. `packages/FTCCloud`), or `all` for the full walk. Repeatable /
|       |        | comma-separated for multiple. With no `--package` on a detected monorepo, the detected
|       |        | packages are listed to stderr and the full repo is indexed. Unknown name → exit 2. |
| `--include <glob>` | planned | scope files (not yet wired) |
| `--lang <a,b>` | planned | restrict languages (not yet wired) |
| `--worker-timeout <ms>` | planned | per-file parse timeout (not yet wired) |

### Monorepo / workspace detection (`--package`)
Before indexing, `crib index` reads the target repo's workspace manifest to detect a monorepo and
enumerate its packages — no extraction, no network. Supported layouts:

| Tool | Detected from |
|------|----------------|
| pnpm | `pnpm-workspace.yaml` (`packages: [...]`) |
| Lerna | `lerna.json` (`packages`) |
| Nx | `nx.json` present + package list inherited from `package.json#workspaces` or `lerna.json` |
| npm/Yarn workspaces | `package.json#workspaces` (array or `{ packages }`) |
| Cargo | root `Cargo.toml` `[workspace].members` |

Glob patterns (`packages/*`, `libs/**`) are expanded to existing dirs; recursive `**` patterns are
filtered to dirs that actually look like a package (have a `package.json` or `Cargo.toml`) so
intermediate parent dirs are not surfaced. A member with no `package.json#name` falls back to the dir
basename — a workspace member is a valid index target even if it isn't a published package.

**One soul per repo is preserved.** `--package` only narrows which package dirs discovery descends
into (root-level files are always kept); the soul stays unified, so cross-package impact / blast-radius
queries still resolve. Splitting into one soul per package would lose cross-package reach — the killer
feature — so we scope extraction, not storage. The detected layout + the package roots actually indexed
are stamped onto the soul manifest's `meta.workspace` and `meta.indexedPackages`.

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

## `crib memory …`

The memory CLI is the human control plane for the same persistent ledger exposed to agents over
MCP. `memory_recall` remains the primary agent read path; these commands make state, provenance,
and recovery visible without copying records between tools.

```sh
crib memory handoff --json                         # resume: work in flight, pending captures, stale claims
crib memory recall "deployment convention" --json  # trusted team + local + applicable-global recall
crib memory events --include-expired --json         # operational event/audit view (not claim content)
crib memory profiles register --key architect \
  --alias codex/thread-123 --alias cursor/agent-456
crib memory profiles list --json
```

`events` reads the append-only operational journal. Its default view honours the 30-day structured
event retention policy; `--include-expired` is an explicit audit/export view. It contains safe
metadata and evidence references, never full claims, transcripts, chain-of-thought, raw command
output, or secrets.

`profiles` maps a vendor/client agent identifier to a durable profile owned by the principal in
`KCRIB_PRINCIPAL_ID` (or the local default). The association is host-controlled provenance, not an
authorization mechanism: a client cannot supply a profile ID to bypass principal, workspace, or
project isolation. Multiple clients can resolve to one profile, so a handoff or capture can survive
a switch between Codex, Cursor, Claude, Copilot, Gemini, Windsurf, or another MCP client.

## `crib reindex [path]`
Full re-index (alias for `crib index`). Re-registers the project. Accepts the same `--semantic`,
`--exclude`, and `--package` flags as `crib index` (see above for monorepo workspace detection).

## `crib rename --from <symbol> --to <name> [--apply --plan-id <id>] [--json] [--depth N]`
Safe symbol rename with a plan/apply lifecycle (G5.1). **The default is a dry run**: it resolves the
symbol against the graph, walks its affected set (same semantics as `crib impact --dir up`, default
depth 2), scans text files for word-boundary occurrences, prints the plan — and writes nothing.

```text
$ crib rename --from verifyToken --to checkToken
rename plan (dry run — nothing written)
  from: verifyToken → to: checkToken
  target: sym:src/auth.ts#verifyToken@L1
  plan id: rename:9f2c…
  sites: 3 exact, 1 inferred (4 edit(s) across 3 file(s))
  affected: 1 resolved, 0 unresolved
    src/auth.ts — 1 edit(s)            # definition file, edge-grounded → exact
    src/caller.ts — 2 edit(s)          # import + call grounded by an EXTRACTED edge → exact
    docs.md — 1 edit(s)                # word-boundary text hit → inferred, flagged
  apply with: crib rename --from verifyToken --to checkToken --apply --plan-id rename:9f2c…
```

The guards:

- **Deterministic plan id** — `rename:<hash>` over the planned edits + affected set (content, never
  wall-clock). The same graph state always yields the same id.
- **Stale-plan rejection** — `--apply` re-derives the plan first and fails closed with
  `PLAN_MISMATCH` if the graph moved; each planned file's content hash is then re-checked
  (`STALE_PLAN`) right before writing.
- **Atomic application** — all files are transformed in memory first; a write failure mid-way rolls
  every already-written file back, so a failed apply leaves nothing changed.
- **Confidence classification** — sites grounded by extracted reference edges are `exact`; text hits
  elsewhere (docs, comments, strings) are `inferred` and flagged. Symbols reached only through
  inferred edges land in the **unresolved** bucket — treat a non-empty bucket as a signal to look
  before applying, not as an automatic blocker. An empty resolved-caller set is *not* evidence the
  symbol is unused.

`--from` accepts a simple name or a node id; the replacement token is always the simple name, so
longer identifiers that merely contain it are never touched. `--json` prints the raw plan (same
shape as the MCP `rename` verb).

On a successful apply the command prints the change summary (`renamed in N file(s), M edit(s) (plan <id>)`) and
then **chains the post-apply reindex** — the same dirty-update path `crib update --dirty` uses —
because the on-disk files just moved and the derived index is now stale. Outside a git repo the
dirty update falls back to a full index. Errors: `PLAN_MISMATCH` / `STALE_PLAN` → exit 1 with a
"re-run the dry run" message; missing `--plan-id` with `--apply` → exit 2; unknown symbol → exit 1.

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
crib query "DTI" --with-source --with-rules      # fold body + decision table per hit
crib query "login" --with-llm                    # upgrade LLM pointer → full analysis blob
```
Flags: `--with-source` `--with-rules` `--with-framework` `--extracted-only` `--with-llm` `--limit N`.
Output shape: `{ hits, llmHits, truncated }`. `hits` are BM25-ranked; by default each carries a
**lightweight LLM pointer** (`provenance`/`confidence`/`purpose`) — not the full analysis blob — so
the default call stays low-token. `llmHits` are semantic discoveries BM25 missed (separate field,
never override BM25 ranking). `--with-llm` upgrades the pointer to the full analysis+graph+evidence.
`truncated: true` means more results existed beyond `--limit`.

## `crib install-hooks [path]`
Install the git **post-commit** hook (auto `crib update`) and the `.crib` **merge driver** (resolves
chunk conflicts via the deterministic conflict rule).

## `crib merge-driver %O %A %B %P`
Git custom merge driver for one `.crib` JSONL chunk.

## Schema evolution

There is **no `crib migrate` command**. The implemented command set is exactly: `index | status |
query | serve | update | reindex | merge-driver | install-hooks | export | viz | mcp` (see
`printHelp` in `packages/cli/src/cli.ts`). Schema evolution is automatic and additive:

> There is NO 'crib migrate' command. Schema evolution is automatic and additive:
>   (1) every 1.0→1.3 field is OPTIONAL + `additionalProperties:true`, so an old soul loads verbatim;
>   (2) re-indexing stamps the new 1.3 fields onto the SAME node (id-stable, hash-stable, in-place);
>   (3) persisted dossiers rebuild via graph-content comparison plus the `shapeVersion` +
>   `schemaVersion` staleness gate in
>       `readDossier` (`shapeVersion` undefined → stale → rebuilt). No rewrite, no data loss.

In practice: run `crib reindex .` (or `crib index .`) to stamp the current `schemaVersion` (`1.3`)
and the 1.3 framework-semantics fields onto the existing nodes; stale persisted dossiers rebuild
during indexing or on the next `dossier` call. The `'crib migrate'` test referenced in
`docs/knowledge-crib-testing.md` §7
is the schema round-trip + forward-compat test in `packages/core/src/validate.test.ts` (1.0/1.2
nodes validate under the 1.3 schema; a 1.2 node → stamped with 1.3 fields → re-validated, id
unchanged) — not a CLI command.

---

## Exit codes
`0` ok · `1` generic error · `2` bad args · `3` not indexed (run `crib index`).

## Typical lifecycle
```
crib index .                       # once (also registers in ~/.crib/registry.json)
crib install-hooks                  # keep soul fresh on every commit
crib mcp install --ide claude --global   # one user-scope entry → serves every project
crib serve                          # agents connect (resolution chain picks the soul)
crib export --format graph.json     # share / feed SeeroFlow
```
