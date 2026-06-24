# Knowledge-crib — Architecture & System Design

> Greenfield TypeScript [Q36]. Storage = **soul (truth) + index (derived)** [Q9]. One MCP server
> [Q33], one UI [Q34]. Deterministic core; LLM opt-in [Q19]. See [decisions](knowledge-crib-decisions.md).

---

## 1. Design principles
1. **Soul is the source of truth; index is a rebuildable cache.** Single writer, one direction.
2. **Deterministic core never needs the network.** Parse/graph/impact/search are offline & free. LLM is opt-in enrichment only.
3. **Everything is a plugin at the edges.** Extractors (languages/formats) and the index backend are swappable behind interfaces.
4. **Token-frugal by construction.** Agents query the graph; payloads are bounded + provenance-tagged.
5. **Portable & cross-IDE.** The soul is plain committed files with a published schema; the MCP server is the fast path, raw files the universal path.

---

## 2. System context (who talks to what)
```mermaid
flowchart LR
  dev([Developer]) --> ide[Agentic IDE\nClaude Code / Cursor / Copilot]
  ide -- MCP stdio --> mcp[Knowledge-crib\nMCP Server]
  cli[crib CLI] --> eng
  mcp --> eng[Knowledge-crib Engine]
  eng --> soul[(SOUL\n.crib/ committed files)]
  eng --> index[(INDEX\nLadybug/sqlite — derived, gitignored)]
  repo[Project repo\ncode + docs] --> eng
  soul -. engine-free read .-> seero[SeeroFlow\nflows]
  mcp -. rich read .-> seero
```

## 3. Component view (monorepo packages)
```mermaid
flowchart TB
  subgraph contract
    schema[soul-schema\nJSON Schema + types]
  end
  subgraph engine
    core[core\nGraphModel · SoulStore · IndexStore]
    parsers[parsers\ntree-sitter WASM]
    pipeline[pipeline\nextract→resolve→link→cluster→index]
  end
  subgraph surfaces
    mcp[mcp server]
    cli[cli]
    ui[ui viz]
  end
  reader[soul-reader\nengine-free]

  schema --> core
  schema --> reader
  parsers --> pipeline
  core --> pipeline
  pipeline --> core
  core --> mcp
  core --> cli
  core --> ui
  mcp --> cli
```

## 4. Data flow — indexing pipeline
```mermaid
flowchart LR
  files[repo files] --> structure[1 structure map]
  structure --> parse[2 parse\ntree-sitter]
  parse --> resolve[3 resolve\nimports/calls/types]
  files --> docx[3b doc-extract\nMarkdown]
  resolve --> linker[4 cross-modal linker\ndoc ↔ symbol]
  docx --> linker
  linker --> cluster[5 cluster\nLeiden/Louvain]
  cluster --> soulw[(write SOUL)]
  soulw --> idx[6 build INDEX\nBM25 + vector]
  idx --> ready((ready to serve))
```
All structure lands in the **soul first**; the index is built from the soul.

## 5. Sequence — an `impact` query
```mermaid
sequenceDiagram
  participant A as Agent (IDE)
  participant M as MCP Server
  participant I as IndexStore
  participant S as SoulStore
  A->>M: impact(symbol="AuthService", dir="up")
  M->>I: traverse reverse edges (calls/imports/describes)
  I-->>M: affected symbols + linked doc-sections (top-N by confidence)
  M->>S: resolve spans/snippets for evidence (lazy)
  S-->>M: provenance snippets
  M-->>A: { affected[], relatedDocs[], truncated } (token-bounded)
```

## 6. Soul ↔ index lifecycle (incremental)
```mermaid
flowchart LR
  change[file change\ngit diff / watcher] --> reextract[re-extract changed files]
  reextract --> chunks[rewrite affected\nsoul shard-chunks]
  chunks --> manifest[update manifest stats]
  chunks --> rebuild[rebuild touched\nindex slice]
  rebuild --> served((served))
```
Cost ∝ change size, not repo size. The index is always reconstructable from the soul → no drift.

## 7. Layering (dependency direction)
```
soul-schema  ◄── core ◄── pipeline ◄── mcp / cli / ui
soul-schema  ◄── soul-reader (no engine deps)
parsers ──► pipeline
```
- Nothing depends on a concrete index backend — only on the `IndexStore` interface.
- `soul-reader` depends only on `soul-schema` (so SeeroFlow can read without pulling the engine).

## 8. Key technical choices (and why)
| Choice | Why |
|--------|-----|
| TypeScript/Node [Q36] | best MCP SDK, `npx` cross-IDE distribution, tree-sitter WASM, embeddable store |
| tree-sitter WASM | one parser path for CLI + future browser UI; ~20 langs |
| JSONL sharded soul | git-diffable, streamable, small incremental writes (see soul-format) |
| `IndexStore` interface | swap LadybugDB ↔ sqlite+FTS5+sqlite-vec without touching soul or pipeline [C3] |
| MCP-first [Q22] | the agent is the primary consumer; UI is secondary |
| Deterministic core [Q19] | fast, free, offline, trustworthy; LLM only enriches |
| LLM via MCP **sampling** [Q18] | enrichment borrows the host IDE's model — no bundled provider/key, cross-IDE; fallback Ollama/cloud, else skip |

## 9. Non-goals (v1)
Multimodal ingestion (PDF/image/audio/video), Google Workspace, hosted multi-tenant SaaS, cloud
LLM by default. All deferred [Q24, Q32].
