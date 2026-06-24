# Knowledge-crib — CLI Spec

> `crib` (also `npx knowledge-crib`). Thin wrapper over `core` + `pipeline`. The CLI builds/maintains
> the soul; `serve` exposes it over MCP. Cross-platform (Node).

---

## Global flags
| Flag | Default | Meaning |
|------|---------|---------|
| `--cwd <path>` | `.` | repo root (where `.crib/` lives) |
| `--json` | off | machine-readable output |
| `--quiet / --verbose` | — | log level |
| `--link-threshold <0..1>` | `0.4` | min confidence to persist a cross-modal edge |

## `crib index [path]`
Full index → writes soul + builds index.
```
crib index .                      # index current repo
crib index . --include "src/**" --exclude "**/*.test.ts"
crib index . --with-embeddings    # also build vectors (semantic search)
```
| Flag | Meaning |
|------|---------|
| `--include/--exclude <glob>` | scope files |
| `--with-embeddings` | build vector index (else BM25-only) |
| `--lang <a,b>` | restrict languages |
| `--worker-timeout <ms>` | per-file parse timeout |

## `crib update [--since <ref>]`
Incremental update from changed files (default: `manifest.incrementalSince`). Rewrites only affected
soul chunks + touched index slice.

## `crib serve`
Start the MCP server (stdio). What an agentic IDE connects to.
```
crib serve                        # stdio MCP for the repo at --cwd
```
| Flag | Meaning |
|------|---------|
| `--transport stdio` | (default; only stdio in v1) |
| `--extracted-only` | serve EXTRACTED edges only (trust mode) |

## `crib reindex`
Rebuild the **index** from the soul (no re-parsing). Use after an index-backend change or corruption.

## `crib export --format <fmt>`
Emit a portable view.
```
crib export --format graph.json   # single flat Graphify-compatible file
crib export --format mermaid      # architecture diagram
crib export --format report       # GRAPH_REPORT.md (clusters, god-nodes, suggested questions)
```

## `crib migrate`
Upgrade an older soul to the current `schemaVersion`/`cribFormatVersion` (round-trip safe).

## `crib status`
Print manifest stats: nodes/edges/clusters, `schemaVersion`, `vcsHead`, capabilities, staleness.

## `crib query "<text>"`
One-shot hybrid query from the terminal (same engine as the MCP `query` verb).
```
crib query "where is the session token issued?" --kinds symbol,doc-section --limit 10
```

## `crib install-hooks`
Install the git **post-commit** hook (auto `crib update`) and the `.crib` **merge driver** (resolves
chunk conflicts via the deterministic conflict rule).

---

## Exit codes
`0` ok · `1` generic error · `2` bad args · `3` not indexed (run `crib index`) · `4` migration required.

## Typical lifecycle
```
crib index .            # once
crib install-hooks      # keep soul fresh on every commit
crib serve              # agents connect
crib export --format graph.json   # share / feed SeeroFlow
```
