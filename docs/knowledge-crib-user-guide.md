# Knowledge-crib — User Guide

> A portable **"project soul"** for AI coding agents: a local-first knowledge graph of a codebase,
> served to any agent (Claude Code, Cursor, GitHub Copilot, Codex) over one MCP server. The agent
> gets full architectural context — call graphs, blast radius, doc↔code links, search — in far fewer
> tokens, and stops making architecture-breaking changes.
>
> This guide covers installation, the per-project workflow, every MCP verb, a worked example on a
> real repo, troubleshooting, and the architecture. Pair it with
> [`knowledge-crib-client-setup.md`](knowledge-crib-client-setup.md) for the IDE wiring.

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Install](#2-install)
3. [The per-project workflow](#3-the-per-project-workflow)
4. [The MCP server + the 12 verbs](#4-the-mcp-server--the-12-verbs)
5. [Worked example: indexing the FTC event-management repo](#5-worked-example-indexing-the-ftc-event-management-repo)
6. [Keeping the soul fresh](#6-keeping-the-soul-fresh)
7. [Exporting the graph](#7-exporting-the-graph)
8. [Troubleshooting](#8-troubleshooting)
9. [Known issues & limits](#9-known-issues--limits)
10. [The LLM semantic-graph layer (the grove plan)](#10-the-llm-semantic-graph-layer-the-grove-plan)
11. [Architecture](#11-architecture)

---

## 1. What it is

AI coding agents burn tokens re-reading files every session because they lack durable architectural
context. Knowledge-crib indexes a project **once** into a queryable graph (the *soul*), then serves
it to any agent over MCP. The agent asks `context`, `impact`, `query`, `describes` and gets a
token-bounded, provenance-tagged answer instead of re-reading the whole codebase.

**The one-sentence model:** parse → graph → persist as a committable "soul" → build a fast index
from it → serve to agents over MCP.

**Two stores:**
- **SoulStore** — chunked JSONL graph committed to git; source of truth; cross-IDE; engine-free.
- **IndexStore** — derived fast-query layer (SQLite + FTS5); gitignored; rebuildable from the soul.

The deterministic core (parse / graph / impact / search) never needs a network. LLM enrichment is
opt-in and off the query hot path.

---

## 2. Install

Requirements: **Node ≥ 22.5** and **pnpm 9.15.0 via Corepack**, macOS/Linux.

```bash
git clone <knowledge-crib repo> ~/Documents/Knowlege-crib
cd ~/Documents/Knowlege-crib
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 build              # builds all 7 packages
corepack pnpm@9.15.0 release:verify     # production release gate

# One-time machine setup: create the global bin directory and add it to PATH
corepack pnpm@9.15.0 setup
# Then restart your terminal (or `source ~/.zshrc`) so `crib` resolves.

# Link the CLI globally so `crib` is on PATH for every project
corepack pnpm@9.15.0 --dir packages/cli link --global
```

Verify:

```bash
which crib                              # /Users/<you>/Library/pnpm/crib
crib --help
```

If `link --global` fails with `ERR_PNPM_NO_GLOBAL_BIN_DIR`, run the `setup` step
above, restart your terminal, and retry.

The link points back at the repo's `dist/`, so to upgrade:
`git pull && corepack pnpm@9.15.0 build` — no reinstall.

The CLI binary is published as two names, `crib` and `knowledge-crib` (identical). This guide uses
`crib`.

---

## 3. The per-project workflow

```bash
cd /path/to/your/project
crib index .                            # 1. build the soul → .crib/
crib status .                           # 2. health + stats
# 3. point your IDE's MCP client at:  crib serve <project-root>
```

### Commands

| Command | Purpose |
|---|---|
| `crib index [path] [--semantic] [--exclude a,b,…]` | Full index → `.crib` soul + derived SQLite index (+ optional INFERRED TF-IDF semantic links) |
| `crib status [path]` | Health + node/edge/cluster counts + VCS anchor |
| `crib query <text>` | BM25 search over code + docs |
| `crib serve [path]` | Run the MCP server on stdio (what IDEs connect to) |
| `crib update [path] [--since <sha>]` | Incremental re-extract since the VCS anchor |
| `crib reindex [path]` | Full re-index (alias for `index`) |
| `crib install-hooks [path]` | Wire post-commit hook + `.gitattributes` merge driver |
| `crib merge-driver %O %A %B %P` | Git custom merge driver for `.crib` chunks |
| `crib export [--format F] [--procedure P]` | Render: `rules` \| `mermaid` \| `graph.json` \| `report` |
| `crib viz [path] [--port N]` | Serve the offline web UI (Cytoscape canvas) + open browser |
| `crib enrich [path] [--status\|--next\|--save <file>\|--overview] [--layer L] [--limit N]` | Drive the LLM semantic-graph loop headlessly: status / next grounded batch / persist a `{batchId, items}` JSON / render the bible (see §10) |
| `crib skill <install\|list> [name] [--dest <dir>]` | Install the bundled `/crib-enrich` skill (the loop driver) into `~/.claude/skills/`, or list bundled skills. Idempotent — skips byte-identical re-installs |
| `crib mcp <install\|list\|remove> [--ide <name\|all>] [--global]` | Auto-wire the MCP server into each IDE config (no hand-editing); `--ide claude --global` = one user-scope entry for every project |

Exit codes: `0` ok · `1` error · `2` bad args · `3` not indexed.

### What gets indexed

| Language | Extensions | Graph produced |
|---|---|---|
| TypeScript | `.ts .tsx .mts .cts` | symbols, `calls`, `imports`, `member-of` |
| Python | `.py .pyi` | symbols, module imports, calls, classes |
| PL/SQL | `.sql .pkb .pks .pck .pls .pkh .typ` | procedures, tables, columns, `executes`, data-flow |
| Markdown | `.md .markdown` | doc-sections, linked to symbols (`describes`/`references`) |

Other files (`.js`, `.jsx`, `.java`, `.kt`, `.go`, `.rs`, …) are discovered as **file nodes** only —
they participate in the structure map but produce no symbols. (`.js`/`.jsx` are intentionally not
symbol-extracted; convert to `.ts`/`.tsx` or extend the registry.)

### Excluding dirs

Default ignores: `.git`, `node_modules`, `.crib`, `dist`, `coverage`, `.next`, `build`, `.yarn`,
`.gradle`, `target`, `out`, `.turbo`, `.parcel-cache`, `.nuxt`, `.svelte-kit`, `.remix`, `.astro`,
`.angular`, `bower_components`, `.cache`, `.idea`, `.vscode`, `.cursor`, `tmp`, `temp`, `logs`.

Add your own with `--exclude` (comma-separated, repeatable):

```bash
crib index . --exclude vendor,third_party,generated
```

### Commit the soul

`.crib/` is meant to be committed. It's chunked JSONL — diff-friendly and engine-free — so the whole
team shares one soul and every agent sees the same graph. Add `.crib/index/` (the derived SQLite) to
`.gitignore`; keep `.crib/*.jsonl`, `.crib/crib.json`, `.crib/schema/`.

### One IDE entry for every project (root resolution)

`crib index` registers the project in `~/.crib/registry.json` — a local pointer table (absolute path
→ `.crib` dir; machine-local, gitignored). `crib serve` then resolves the right soul per workspace
through: explicit arg → `--cwd` → `KCRIB_ROOT` → `CLAUDE_PROJECT_DIR` → upward walk from CWD → CWD,
with the registry as an overlay for custom `.crib` locations. So you can install **one user-scope**
IDE entry (`crib mcp install --ide claude --global`) and it serves every project — no per-project
config. See [`knowledge-crib-client-setup.md`](knowledge-crib-client-setup.md) §3 and the
[CLI spec](knowledge-crib-cli.md) for the full chain.

---

## 4. The MCP server + the 12 verbs (status, context, source, dossier, impact, query, describes, neighbors, shortest_path, detect_changes, extract_rules, gaps)

`crib serve <root>` starts one MCP server over stdio. Every verb is an MCP tool. All results are
**token-bounded** (default `docLimit=3`, `limit=10`, with `truncated` + `cursor`) and
**provenance-tagged** (`method`, `provenance` = `EXTRACTED` | `INFERRED`, `confidence`, `evidence`)
so the agent can filter to deterministic-only (`extractedOnly: true`).

> The 12 verbs below are the **deterministic structural** layer (AST-extracted, no model in the
> loop). A second **LLM-authored semantic** layer adds 5 more verbs — `enrich_status`,
> `enrich_next`, `enrich_save`, `overview`, `llm_neighbors` — described in
> [§10](#10-the-llm-semantic-graph-layer-the-grove-plan).

### `status`
Health + whether indexed. `→ { indexed, schemaVersion, stats{nodes,edges,clusters}, vcsHead, incrementalSince, capabilities }`

### `query` — hybrid BM25 search over code + docs
```jsonc
{ "q": "where is the session token issued?", "limit": 10 }
→ { "hits": [ { "id": "sym:…#TokenService.issue@L88", "kind": "symbol", "score": 0.81,
                "snippet": "issue(userId):Session", "clusterId": "c:auth" } ], "truncated": false }
```

### `context` — 360° for one symbol
```jsonc
{ "id": "sym:src/auth/AuthService.ts#AuthService.login@L42", "docLimit": 3 }
→ { "node": { signature, file, span, clusterId }, "callers": […], "callees": […], "docs": […], "truncated": false }
```
The cheapest "give me everything about this symbol" call. Start here.

### `source` — paged source body for a symbol
```jsonc
{ "id": "sym:…#login@L42", "sourceStartLine": 42, "sourceMaxLines": 120 }
→ { "id": "…", "source": "  login(userId) {\n    …", "startLine": 42, "totalLines": 87,
    "truncated": false }
```
Rehydrates the symbol's source span from the repo on demand. Page a large body into a small model's
window with `sourceStartLine` / `sourceMaxLines`.

### `dossier` — one-call deep context (the migration verb)
```jsonc
{ "id": "sym:loan_engine.pkb#assess_application@L10", "format": "markdown" }
→ { "id": "…", "dossier": "# loan_engine.assess_application\n## Decision table …\n
     ## Raises\n- -20001 application rejected …\n## Exception handlers\n- WHEN NO_DATA_FOUND …\n
     ## Iterates (cursors)\n- c_app …\n## Declares …\n## Source …" }
```
One call returns the **behavior** the refined model captures — decision table, raises (with error
codes + the guard chain that fires them), exception handlers, cursors + their queries, assignment
targets, per-symbol doc comments — folded with the structure. `format: "json" | "markdown"`. The
artifact is **persisted** under `.crib/dossiers/` (sharded by node-id hash, anchored to `node.hash`,
and graph-content-validated to prevent stale callers/callees, with orphan pruning on index/update),
so repeat calls are cache hits. This is the verb a migration analyst or a local LLM
uses instead of `context` + `source` + `extract_rules` + re-reading source. Schema 1.3 (dossier
`shapeVersion:2` carrying a lean framework block — routes/produces for Spring); works across
all 7 languages with capability-honest skips.

### `impact` — blast radius (the wedge verb)
```jsonc
{ "id": "sym:…#login@L42", "dir": "up", "depth": 2, "limit": 10 }
→ { "root": "…", "dir": "up",
   "affected": [ { "id": "…", "rel": "calls", "distance": 1, "risk": "high", "docs": […] } ],
   "relatedDocs": […], "truncated": true, "cursor": "10" }
```
`dir: "up"` = dependents (who calls/imports this), `dir: "down"` = dependencies. `risk` is
`high`/`medium`/`low` by distance. **This is the verb that prevents architecture-breaking changes** —
ask it before any refactor.

### `describes` — the doc-sections linked to a symbol (cheap, high value)
```jsonc
{ "id": "sym:…#login@L42", "minConfidence": 0.4 }
→ { "docs": [ { "sectionId": "doc:docs/auth.md#sessions", "heading": "Sessions",
                "snippet": "…", "edgeType": "describes", "provenance": "EXTRACTED", "confidence": 0.95 } ] }
```

### `neighbors` — raw adjacency (graph-walking primitive)
```jsonc
{ "id": "…", "rel": "calls", "dir": "out", "limit": 50 }
→ { "edges": [ { "src", "dst", "rel", "method", "provenance", "confidence", "evidence" } ], "truncated": false }
```
`dir`: `in` / `out` / `both`.

### `shortest_path`
```jsonc
{ "from": "sym:…", "to": "sym:…", "maxHops": 6 }
→ { "path": [ "sym:…", "sym:…", "sym:…" ], "edges": […], "found": true }
```

### `detect_changes` — dry-run delta since a git ref
```jsonc
{ "since": "<git sha>" }   // defaults to manifest.incrementalSince
→ { "since", "head", "changedPaths": […], "changedSymbols": […], "removedEdges": […] }
```
Read-only. For "what's the impact of this diff?" — review a PR by running it against the base ref.

### `extract_rules` — decision table from a procedure's CFG
```jsonc
{ "procedure": "sym:claims.pkb#process_claim@L10", "includeTables": true }
→ { "rules": [ { "action": "escalate_claim", "conditions": ["v_amt > 10000"],
                 "source": "claims.pkb@L12", "reads": ["CLAIMS.amount"] } ] }
```
Flattens the M11 guard-annotated CFG into a decision table — the migration deliverable. Works for
all 7 languages (PL/SQL, TypeScript, Java, C#, Go, Rust, Python), not just PL/SQL.

### Error shape
`{ "error": { "code": "NOT_FOUND" | "NOT_INDEXED" | "AMBIGUOUS" | "BAD_ARGS" | "INTERNAL", "message" } }`

---

## 5. Worked example: indexing the FTC event-management repo

This is a real walkthrough performed on
`~/Projects/event_management_software` — a polyglot Gradle/Yarn-PnP
monorepo (TypeScript + Java + SQL). It records the exact steps and numbers.

### 5.1 Machine setup (one-time)

```bash
cd ~/Documents/Knowlege-crib
corepack pnpm@9.15.0 install && corepack pnpm@9.15.0 release:verify
corepack pnpm@9.15.0 setup   # one-time; restart terminal after
corepack pnpm@9.15.0 --dir packages/cli link --global
which crib          # ~/Library/pnpm/crib
```

### 5.2 Scope the target

```bash
cd ~/Projects/event_management_software
# Source mix (excluding caches/build):
#   1313 java · 292 tsx · 225 sql · 58 ts · 46 js · 37 jsx · 14 kts · 11 kt · 5 md
```

Knowledge-crib extracts TS/TSX, SQL, Markdown, and Java here; Kotlin becomes file nodes only
(no Kotlin extractor yet — the one language still without a plugin).

### 5.3 First attempt — full repo (failed: slow)

```bash
crib index .
# Hung at 100% CPU, 12+ min, no .crib written.
```

**Root cause #1:** the default discovery ignore set didn't include `.yarn` (Yarn-PnP cache, 9832
files / 261 MB) or `.gradle` (174 MB). Discovery read+hashed every cache file before reaching
source.

**Root cause #2 (historical):** after fixing the ignores, the **PL/SQL extractor hung** on the
repo's 192 SQL migration files (`FTCCloud/src/main/resources/db/migration/V*.sql`). The real bug
was a parser **infinite loop** — `recover()` bailed on a stray `WHEN`/`ELSE`/`EXCEPTION` (a
BLOCK_END keyword) at top level without advancing — **not** an O(n²) path. Fixed in commit
`0961e5b` with a forward-progress guard (`if (this.pos === before) this.pos++` in `parser.ts`) plus
a regression test; the extractor is now O(tokens)/file and the `SqlResolver` runs once over the
soul. This is no longer reproducible.

### 5.4 Fixes applied to Knowledge-crib (so other projects work too)

1. **Extended `DEFAULT_IGNORES`** with package-manager / build caches (`.yarn`, `.gradle`, `target`,
   `out`, `.turbo`, `.parcel-cache`, `.nuxt`, `.svelte-kit`, `.cache`, `.idea`, `.vscode`,
   `.cursor`, …) and exported it. (`packages/pipeline/src/structure.ts`)
2. **Added `--exclude` CLI flag** + `ignores` option through `IndexOpts` so projects can skip
   arbitrary dirs. (`packages/cli/src/cli.ts`, `packages/pipeline/src/pipeline.ts`)
3. **Fixed `crib serve` exiting immediately.** The CLI's `main().then(process.exit)` killed the MCP
   server right after `connect()` resolved, before it could answer any request — no IDE client could
   use it. `serveStdio` now blocks until stdin EOF. (`packages/mcp/src/server.ts`)

The release gate is `corepack pnpm@9.15.0 release:verify`, which runs TypeScript build/tests/lint,
Python worker
tests, package dry-run checks, schema import smoke, and `crib status .`.

### 5.5 Successful index (the demo graph)

Indexing the main TS app (`FTCCloud`) while excluding `resources` (SQL migrations — kept out so the
demo focuses on the TS app; no longer *required* after the parser fix) and `graphify-out` (stale
graphify output):

```bash
cd ~/Projects/event_management_software
crib index FTCCloud --exclude resources,graphify-out
# indexed 786 files → 1576 nodes, 1831 edges (59 describes, 38 references) in 1322ms
```

Status:

```bash
crib status FTCCloud
# {
#   "indexed": true, "schemaVersion": "1.1",
#   "stats": { "nodes": 1576, "edges": 1831, "clusters": 104 },
#   "vcsHead": "41d60f6046b2d0da5b6aa6ddbb02e6b146f206a4",
#   "incrementalSince": "41d60f6046b2d0da5b6aa6ddbb02e6b146f206a4",
#   "capabilities": { "embeddings": false, "multimodal": false, "cypher": false, "vector": false, "llmGraph": false }
# }
```

Graph composition (from `crib export --format report FTCCloud`):

```
nodes by kind:   file 786 · symbol 621 · cluster 104 · doc-section 65
edges by relation: member-of 993 · imports 431 · calls 310 · describes 59 · references 38
```

That's a **detailed knowledge graph: 1576 nodes, 1831 edges, 621 symbols, 65 doc-sections, 97
doc↔code links, 104 structural clusters**, built in 1.3 s.

`llmGraph: false` here because the LLM-graph loop (§10) was not run on this repo — only the
deterministic structural layer. It flips to `true` after the first `enrich_save`.

### 5.6 Query + export

```bash
crib query 'schedule' FTCCloud
# → ScheduleFilterBar.tsx#ScheduleFilterBar@L25, ScheduleStatsCards.tsx#ScheduleStatsCards@L21, …

crib export --format graph.json FTCCloud > ftc_graph.json   # 1.5 MB full graph artifact
crib export --format report FTCCloud                       # human-readable summary (above)
crib export --format mermaid --procedure login FTCCloud    # CFG mermaid for a procedure
```

### 5.7 MCP server verification (the real test)

Drove `crib serve FTCCloud` through a canonical MCP SDK client (`Client` +
`StdioClientTransport`, exactly how an IDE connects):

```
initialize  → serverInfo { name: "knowledge-crib", version: "0.1.0" }
tools/list  → 17 tools: 12 structural (status, context, source, dossier, impact, query, describes,
                        neighbors, shortest_path, detect_changes, extract_rules, gaps) + 5 LLM-graph
                        (enrich_status, enrich_next, enrich_save, overview, llm_neighbors)
status      → { nodes:1576, edges:1831, clusters:104, vcsHead:… }
query "schedule" → ScheduleFilterBar (score -4.01), ScheduleStatsCards, ScheduleItemRequest
context(ScheduleFilterBar) → { signature, file, span {25..95} }
impact(ScheduleFilterBar, up, depth 2) → FllSchedulePage.tsx imports @ distance 1, risk high;
                                          + member-of dependents @ distance 2
neighbors  → imports + member-of edges, provenance EXTRACTED, confidence 1, evidence {by: ts-resolver}
detect_changes → no changes since HEAD (clean working tree)
```

Also verified over raw piped JSON-RPC (`initialize` → `notifications/initialized` →
`tools/call status`) — the server now stays alive and responds; before the §5.4 fix it exited code 0
immediately.

### 5.8 Wiring it to the IDEs

With the soul at `FTCCloud/.crib`, auto-wire each IDE in one command (or hand-edit the configs):

```bash
crib mcp install --ide all                 # project-scope committable configs for all 4 IDEs
crib mcp install --ide claude --global      # one user-scope entry → serves every project via CLAUDE_PROJECT_DIR
```

See [`knowledge-crib-client-setup.md`](knowledge-crib-client-setup.md) for the exact
`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` / `config.toml` blocks and the root-resolution
chain.

---

## 6. Keeping the soul fresh

```bash
# after editing code:
crib update .                          # re-extract only changed files (incremental, M6)

# automatic refresh on every commit:
crib install-hooks .                   # post-commit → crib update; .gitattributes merge driver

# clean rebuild:
crib reindex .
```

`crib update` uses the git HEAD stamped in the manifest as the anchor; if there's no anchor or it's
not a git repo, it falls back to a full re-index. `.crib` chunks are mergeable via the `kcrib`
custom merge driver (`crib merge-driver`), so concurrent index updates across branches don't
conflict.

---

## 7. Exporting the graph

```bash
crib export --format graph.json . > graph.json    # full soul as one JSON (nodes + edges + stats)
crib export --format report .                     # human-readable summary (counts by kind/relation)
crib export --format mermaid --procedure <id|name> .   # CFG mermaid for one procedure
crib export --format rules --procedure <id|name> .    # decision table for one procedure
```

`crib viz .` serves an offline React/canvas graph UI with compound cluster nodes at
`http://127.0.0.1:<port>/` and opens a browser — useful for eyeballing the graph.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `not indexed — run crib index first` | No `.crib/` at that path. Run `crib index <path>`. |
| `crib serve` exits immediately / IDE can't connect | Fixed in this build. If you hit it, you're on an old `dist` — run `corepack pnpm@9.15.0 build` again. |
| IDE says server failed to start / `crib` not found | The IDE didn't inherit your PATH. Use the absolute path `/Users/<you>/Library/pnpm/crib` in the config. |
| Index hangs at 100% CPU | A cache dir isn't ignored, or the PL/SQL extractor hit the known slow path. Re-run with `--exclude <dir>` and/or exclude `resources` for SQL-heavy repos. |
| `query` returns nothing | The symbol may not be extracted (for example, JavaScript `.js`/`.jsx` files currently produce file nodes only). Use a supported symbol language or extend the registry. |
| Tools visible but agent doesn't use them | You're in Copilot "Ask" mode — switch to **Agent** mode (Copilot only). |
| `.cursor` / `.vscode` MCP loads nothing | Wrong root key: Cursor uses `mcpServers`, Copilot uses `servers` + `type: "stdio"`. |
| Codex ignores the server | Use snake_case `[mcp_servers.name]`, not `[mcpServers]` or `[mcp.servers]`. |

Debug the server directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{}}}' \
  | crib serve /path/to/project
```

You should see two JSON-RPC responses (initialize + status).

---

## 9. Known issues & limits

1. **No Kotlin symbol extraction** — Kotlin is the one language still without a plugin; `.kt`/`.kts`
   files are discovered as file nodes only (no symbol graph). Java, C#, Go, and Rust joined
   TS/Python/PL-SQL/Markdown as first-class default extractors in M14 — each emits symbol nodes
   (`qualifiedName`/`span`/`signature`) plus `member-of` and intra-file `calls` edges, with imports,
   cross-file calls, and inheritance handled by their resolvers. The registry remains extensible;
   contribute a Kotlin extractor.
2. **`.js`/`.jsx`/`.cjs`/`.mjs` not symbol-extracted** — intentionally; only file nodes (`.js`/`.jsx`
   get a `javascript` lang tag; `.cjs`/`.mjs` get a bare file node). Symbol extraction covers
   `.ts`/`.tsx`/`.mts`/`.cts` — use those.
3. **No vector embeddings ship** — the deterministic core is zero-embedding / zero-dep (BM25 + FTS5
   only); `capabilities().vector` is hard-coded `false` and there is no `sqlite-vec` dependency. The
   INFERRED "semantic search" layer is the M7 pure-JS **TF-IDF** linker
   (`pipeline/src/linker/semantic.ts`), which emits capped `references` edges (provenance `INFERRED`,
   confidence ≤0.6 — strictly below the `describes` threshold). It is opt-in via the **`--semantic`**
   flag on `crib index` / `crib reindex`; off by default so `--extracted-only` is the pure
   deterministic subset. The **LLM semantic-graph layer** (§10) is the deliberate replacement for
   embeddings: instead of a vector index, the host LLM authors a grounded semantic graph and the
   server merges it at query time via `withLlm` — same "find the code that means X" outcome, no model
   in the server, no ANN dependency. `capabilities().llmGraph` flips `true` once that loop runs.
4. **Multimodal (PDF/image/audio) is opt-in** — the `crib_worker` Python subprocess is never spawned
   on the default `crib index`/`serve` path; it only runs when `indexRepo` is called with an
   explicit `multimodal` option. No `crib` CLI flag exposes it yet (enablement is library-API only).
5. **Framework semantics (schema 1.3) surface in `context`/`dossier`/`gaps`/`viz`** — the Spring
   track is built (stereotypes, routes, DI `injects`, `@Bean` `produces`, JPA `references`/columns,
   `@ExceptionHandler` handlers, `@PreAuthorize`/`@Transactional`/`@Scheduled`/`@Query` method
   meta). `context` gains an opt-in `withFramework` flag (returns `routes`/`produces`/
   `dependencies`/`dependents`/`relations`/`renders`); `dossier` attaches a lean framework block
   (`shapeVersion:2`); `gaps` adds `controllersWithoutRoutes` + `unresolvedInjects`; `viz`
   surfaces `framework`/`stereotype`/`httpMethod`/`routePath` on node data. NestJS/TypeORM, Express,
   and React framework extraction also ship in `0.1.0`; Angular remains planned and will reuse the
   same 1.3 kinds and relationships.
   **There is no `crib migrate` command** — schema evolution is automatic and additive (re-index
   stamps new optional 1.3 fields onto the same id-stable nodes; persisted dossiers rebuild via the
   `shapeVersion`/`schemaVersion` staleness gate).

---

## 10. The LLM semantic-graph layer (the grove plan)

The soul built in §3–§7 is a **deterministic structural graph** — `calls`, `member-of`, `imports`,
doc↔code links — produced by AST extractors with no model in the loop. On top of it sits an
**opt-in LLM-authored semantic graph** (the "bible"): concepts, entities, business rules,
capabilities, flows, and invariants that an agent actually reasons about. That second layer is the
**grove plan**, and it is what makes the difference between "the agent knows the call graph" and
"the agent knows what the system is *for*."

### The hard invariant — the server never calls a model

The MCP server stays 100% deterministic. The **host IDE LLM is the generator.** The server only
(a) hands the LLM grounded work items, (b) validates + persists what the LLM authors, and (c)
reports coverage. Every artifact lives under `.crib/llm/` (committable, diff-friendly JSONL shards,
sharded by node-id hash, hash-anchored to `node.hash` for staleness) and is merged back at query
time. Nothing in the deterministic core changes.

### The layer model — bottom-up

Layers run in order; each synthesizes from the saved layer below it:

```
symbol  →  file  →  cluster  →  system
```

- **symbol** — per-symbol deep analysis (purpose, business rules, invariants, IO, side effects,
  errors, risks) + a small semantic graph (`business-rule` / `invariant` / `concept` nodes +
  `realizes` / `validates` / `enforces` edges to the symbol's own soul id and its callees).
- **file** — composes the file's purpose from its saved child symbol analyses; emits
  `part-of-feature` / `capability` edges. Does **not** re-derive what each symbol does.
- **cluster** — names the module, its responsibility, `capability` nodes + `depends-on-concept`
  edges to other clusters' concepts.
- **system** — the **bible**: architecture, subsystems, **cross-cutting flows** (a `flow` node like
  `flow:loan-approval` chaining symbols across files via `triggers` / `transforms`), a **domain
  glossary** (`entity` nodes: DTI, LTV, AML, KYC…), tech stack, and a risk map. The headline
  artifact; the most reasoning goes here. `overview` renders it once this layer lands.

### The loop

```
s = enrich_status()                                    # coverage per layer + nextLayer + done
while !s.done:
  batch = enrich_next({ layer: s.nextLayer, limit: 4 })  # grounded seed + schema per item
  items = [ author(item) for item in batch.items ]        # YOU (host LLM) author, grounded in seed
  enrich_save({ batchId: batch.batchId, items })          # server validates + persists → {accepted, rejected, droppedEdges}
  s = enrich_status()
overview()                                                # the bible (system layer must be last)
```

The server validates **every edge endpoint** against the soul — it must resolve to a real soul node
id present in the item's `seed` (the target itself, its callers, callees) or to a `localId`
authored in this or a previously-saved item. **Unresolved edges are dropped** and reported in
`enrich_save` → `accepted[].droppedEdges`. This is the anti-hallucination gate: the LLM cannot
invent code facts that aren't grounded in the soul.

`enrich_status.nextLayer` tells you which layer is next; never jump ahead — higher layers'
`lowerLayer` payload carries the saved child analyses you synthesize from. The loop is
**resumable**: interrupt anytime, `enrich_status` reports the first `missing|stale` layer, already-
`fresh` targets are skipped. `limit` (default 4, max 25) bounds tokens per turn — process one batch
per turn.

### The 5 LLM-graph verbs

| Verb | Returns |
|---|---|
| `enrich_status` | Coverage per layer (`missing` / `stale` / `fresh`), `nextLayer`, `done: bool` |
| `enrich_next` | `{ layer?, limit }` → a grounded batch; per item `{ targetId, seed, lowerLayer?, outputSchema, instructions, remaining }` |
| `enrich_save` | `{ batchId, items }` → `{ accepted[], rejected[], droppedEdges }`; validates + persists to `.crib/llm/` |
| `overview` | The rendered bible (system-level synthesis); empty until the system layer lands |
| `llm_neighbors` | `{ id }` → walk the LLM semantic graph around a soul id (rules / features / flows / concepts / capabilities) |

### Query-time merge — `withLlm`

The semantic graph is **off the query hot path by default.** The 12 deterministic verbs are
unchanged. Add `withLlm: true` (alongside `withRules` / `withFramework`) and the server folds the
saved LLM analysis + semantic edges into the response — `query` returns the business rules a hit
`realizes`; `context` returns the symbol's authored `purpose` + `invariants` + `whatToDistrust`.

### The `llmGraph` capability flag

`status.capabilities.llmGraph` flips `true` automatically the moment the loop writes its first
artifact. It is the **only** capability flag the grove plan touches:

| Flag | Meaning | Status |
|---|---|---|
| `llmGraph` | LLM-authored semantic graph present | Flips on after the first `enrich_save`; the one flag the grove moves. |
| `embeddings` | Embedding index | Stays `false` — embeddings need a model (violates the no-model invariant) and `node:sqlite` has no ANN. The LLM graph replaces that need via `withLlm`. |
| `vector` | Vector / ANN search | Stays `false` — same reason; BM25 + the TF-IDF linker are the deterministic recall path. |
| `multimodal` | PDF / image / audio extraction | Opt-in via `crib index --multimodal` (spawns `crib_worker`); not part of the grove. |

### Driving the loop

**From an IDE (recommended).** Install the bundled skill, then run it — the host LLM authors the
whole layer set:

```bash
crib skill install                      # copies the bundled /crib-enrich skill to ~/.claude/skills/ (idempotent)
crib skill list                         # show bundled skills
```

Then in a Claude Code session in the project, type `/crib-enrich` (or say "enrich the crib" /
"build the LLM graph" / "generate the bible"). The skill drives
`enrich_status → enrich_next → author → enrich_save` one batch per turn, bottom-up, and calls
`overview` at the end. The skill is **bundled inside the package** (`packages/cli/skills/`), so
`crib skill install` is the one command that makes LLM-graph generation available in any Claude
Code install — no separate repo to clone.

**Headless / from the CLI** (the same loop without an IDE):

```bash
crib enrich --status                       # coverage + nextLayer + done
crib enrich --next [--layer symbol] [--limit 4]   # prints a grounded batch (seed + schema per item)
# author items to a JSON file shaped {batchId, items} against each item's outputSchema, then:
crib enrich --save ./batch.json            # validates + persists → {accepted, rejected, droppedEdges}
crib enrich --overview                     # the bible (after the system layer)
```

`crib index` / `crib reindex` print a pending-LLM hint after a successful build when targets are
uncovered, e.g.:

```
3 target(s) pending LLM graph generation (next: symbol) — run `/crib-enrich` or `crib enrich --next` to drive the loop.
```

### The author contract (per item)

For each `item` from `enrich_next`, the LLM authors one object against `item.outputSchema`:

```jsonc
{
  "targetId": "<item.targetId — verbatim>",
  "model": "<your model id>",
  "analysis": {
    "purpose": "...", "responsibilities": [...], "businessRules": [{ "rule", "rationale", "sourceRef" }],
    "inputs": [...], "outputs": [...], "sideEffects": [...], "errorBehavior": [...],
    "invariants": [...], "preconditions": [...], "postconditions": [...], "risks": [...],
    "whatToDistrust": ["<truncated span / unresolved call / BODY UNAVAILABLE>"],
    "confidence": 0.0
  },
  "graph": {
    "nodes": [{ "localId": "rule:dti-cap", "kind": "business-rule", "name": "DTI 43% cap" }],
    "edges": [{ "from": "<soul id | localId>", "to": "<soul id | localId>", "rel": "enforces", "confidence": 0.0 }]
  },
  "evidence": [{ "soulId": "<id from seed>", "why": "<line / branch / adjacency>" }]
}
```

**Node kinds:** `concept` | `entity` | `business-rule` | `capability` | `feature` | `flow` |
`invariant` | `decision`. **Edge rels:** `realizes` | `validates` | `governs` | `part-of-feature` |
`transforms` | `depends-on-concept` | `produces` | `consumes` | `enforces` | `triggers`.

### Honesty in the authored layer

The contract is explicit about grounding. **Spec-only / unimplemented symbols** (no body file — e.g.
a `.pks` whose `.pkb` is missing, as for the `PKG_LOAN_RULE_ENGINE` package) get lower `confidence`
(0.3–0.5) and a `whatToDistrust: ["BODY UNAVAILABLE"]` flag; the graph is authored from the
signature + spec context, not a body that doesn't exist. Truncated source spans are flagged in
`whatToDistrust`. The server surfaces all of this back through `overview` and `withLlm`, so
downstream agents know exactly what to trust. If the server rejects an item (`rejected[].reason`),
fix and re-submit it in the next batch — do not silently drop it.

---

## 11. Architecture

```
knowledge-crib/                 # pnpm monorepo
  packages/
    soul-schema/   # JSON Schema + TS types (the contract)
    core/          # SoulStore (chunked JSONL) + IndexStore (SQLite + FTS5)
    parsers/       # TypeScript / Python / PL-SQL / Markdown / Java / C# / Go / Rust extractors (registry)
    pipeline/      # extract → resolve → link → cluster → index (phased)
    mcp/           # the one MCP server (stdio) + 12 deterministic verbs + 5 LLM-graph verbs (pure functions)
    cli/           # crib index|status|query|serve|update|reindex|export|viz|install-hooks|merge-driver|mcp|enrich|skill
      skills/      # bundled /crib-enrich skill (the LLM-graph loop driver) — ships in the package
    ui/            # offline React/canvas graph visualization
  docs/            # the spec + this guide
```

**Data flow:** `discoverFiles → runStructure → runParse → runResolve → runCfg → runLink →
runCluster → (runSemanticLink) → commit soul → buildIndex`. The soul is the source of truth; the
SQLite index is derived and rebuildable. Every MCP verb is a pure function over `{soul, index,
repoRoot, vcs?}` — the server is thin wiring. The LLM-graph layer is a separate, optional pass
driven by the host IDE LLM over the 5 `enrich_*` / `overview` / `llm_neighbors` verbs; it writes to
`.crib/llm/` and never touches the deterministic core.

**Determinism:** the deterministic core never touches the network. Edges carry
`{method, provenance, confidence, evidence}`; `provenance: EXTRACTED` is the deterministic subset,
`INFERRED` (TF-IDF semantic linker) is opt-in (`semantic: true`) and strictly recall-adding. The
LLM-authored layer carries its own `confidence` + `evidence` + `whatToDistrust` and is merged only
when a verb passes `withLlm`.

---

*Knowledge-crib is Apache-2.0, greenfield, all-new. GitNexus and Graphify are design inspiration
only — no code is derived from either.*
