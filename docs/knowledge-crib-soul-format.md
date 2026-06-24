# Knowledge-crib — The Soul Format (v1.0 spec)

> The **soul** is the project's portable memory: chunked, git-committable files that are the
> **source of truth** [Q9]. The fast index (LadybugDB/swappable) is derived from it and
> rebuildable. Any agentic IDE — and SeeroFlow [Q38] — can read the soul **cold, without the
> engine**. This spec is the contract everything else hangs off.

---

## 1. Design goals → choices
| Goal | Choice |
|------|--------|
| Cross-IDE, agent-agnostic | Plain files + published JSON Schema + format version. Engine optional. |
| Git-committable, small diffs | **JSONL** (one record/line) + **sharded chunks** keyed by source path → a one-file edit touches one chunk. |
| Incremental upgrade as project evolves | Per-node content hash (blake3); rewrite only affected chunks; manifest tracks `incrementalSince`. |
| Source of truth, index derived | Soul holds structure; index is a cache built from soul. Single-writer, one direction. |
| Lean (no repo duplication) | Code/doc nodes store **references** (`file` + `span` + `hash`), **not copied text**. Rehydrate from source on demand. |
| Portable + scalable | Chunked soul scales past Graphify's single 512 MiB `graph.json`; `crib export` still emits one flat `graph.json` for compat. |

---

## 2. On-disk layout
```
.crib/                         # COMMITTED to git (the soul travels with the repo)
  crib.json                    # manifest (versions, repo id, chunking, stats, capabilities)
  nodes/<shard>/<chunk>.jsonl  # node records, sharded by source-path hash
  edges/<shard>/<chunk>.jsonl  # edge records
  clusters/clusters.jsonl      # community detection output
  schema/                      # vendored JSON Schema for nodes/edges/manifest (self-describing)
  .gitignore                   # ignores index/ and embeddings/ by default
  index/                       # GITIGNORED — derived LadybugDB/sqlite + ANN; rebuildable
    ladybug.db
  embeddings/<shard>/*.f16     # GITIGNORED — vectors (large, regenerable)
```
**Why `.crib/` is committed** (unlike `.git`): it *is* the memory. Derived/heavy bits (`index/`,
`embeddings/`) are gitignored and rebuilt locally.

**Sharding:** `shard = first 2 hex of blake3(sourcePath)`; within a shard, roll a new chunk file at
`maxChunkLines` (default 5000). One file's records cluster into one shard → minimal merge conflicts.

---

## 3. Record schemas (JSON Schema, abridged)

### Node
```jsonc
{
  "id": "sym:src/auth/AuthService.ts#AuthService.login@L42",  // stable, deterministic, human-readable
  "kind": "symbol",            // symbol | file | doc-section | media-seg | explanation | cluster
  "type": "method",            // AST type (class|function|method|interface|…) or doc level (h2…)
  "name": "login",
  "qualifiedName": "AuthService.login",
  "file": "src/auth/AuthService.ts",
  "span": { "start": 42, "end": 58 },   // line range — text is referenced, NOT copied
  "lang": "typescript",
  "signature": "login(email: string, pw: string): Promise<Session>",
  "clusterId": "c:auth",
  "hash": "blake3:9f2c…",      // content hash → change detection + dedup
  "meta": {}                   // extensible; unknown keys preserved on round-trip
}
```
**ID grammar (stable across runs — critical for git diffs + cross-tool refs + SeeroFlow):**
- symbol → `sym:<file>#<qualifiedName>@L<startLine>`
- file   → `file:<path>`
- doc    → `doc:<file>#<anchor>`
- media  → `media:<file>#<tStart>` · cluster → `c:<slug>`

### Edge
```jsonc
{
  "id": "e:blake3(src|dst|rel)",
  "src": "sym:src/auth/AuthService.ts#AuthService.login@L42",
  "dst": "sym:src/auth/TokenService.ts#TokenService.issue@L88",
  "rel": "calls",              // calls|imports|inherits|implements|describes|references|derived-from
  "method": "static",          // static|explicit|identifier|semantic|inferred (HOW it was derived)
  "provenance": "EXTRACTED",   // EXTRACTED (deterministic) | INFERRED (LLM/heuristic)   [Q35]
  "confidence": 1.0,           // 0..1
  "evidence": { "snippet": "return tokenService.issue(...)", "by": "ts-call-resolver" },
  "meta": {}
}
```

### Conflict / merge rule (deterministic — embed in spec, not code-only)
When two edges share `(src,dst,rel)`:
1. **EXTRACTED/static wins** over INFERRED.
2. Among same provenance → higher `confidence` wins.
3. Loser kept only if `confidence ≥ link-threshold` (default 0.4), else dropped.
This rule is what the `.crib` git **merge driver** applies on chunk conflicts (union + rule).

---

## 4. Manifest — `crib.json`
```jsonc
{
  "cribFormatVersion": "1.0",
  "schemaVersion": "1.0",
  "repo": { "id": "<uuid>", "root": ".", "vcsHead": "<git sha at last full index>" },
  "generator": { "tool": "knowledge-crib", "version": "x.y.z" },
  "chunking": { "shardHexDigits": 2, "maxChunkLines": 5000, "format": "jsonl" },
  "stores": { "soul": "jsonl-chunked", "index": ".crib/index/ladybug.db (derived, gitignored)" },
  "stats": { "nodes": 0, "edges": 0, "clusters": 0, "lastUpdated": "ISO-8601",
             "incrementalSince": "<git sha>" },
  "capabilities": { "embeddings": false, "multimodal": false }   // grows as features land
}
```

---

## 5. Incremental update protocol (the "upgrades as project evolves" part)
1. Detect changed files (git diff / watcher) since `stats.incrementalSince`.
2. For each changed file: re-extract → new node/edge records.
3. Compare by `hash`; rewrite **only the affected shard chunks**.
4. Prune edges referencing deleted nodes (dangling-ref sweep, scoped to touched shards).
5. Update manifest `stats` + `vcsHead` + `incrementalSince`.
6. Rebuild only the touched slice of the derived index.
Cost ∝ change size, not repo size.

---

## 6. Versioning & migration
- `cribFormatVersion` (file layout) + `schemaVersion` (record shape) in the manifest.
- Engine runs `crib migrate` to upgrade an old soul forward.
- **Round-trip safety:** unknown fields are preserved, so a newer soul stays readable by an older
  reader (forward-compatible) for additive changes.

---

## 7. SeeroFlow read contract [Q38] (and any external consumer)
Two tiers — both stable, versioned:

**Tier 1 — engine-free (universal):** read `.crib/` directly.
- Discover `crib.json` → check `cribFormatVersion`.
- Stream `nodes/**.jsonl` + `edges/**.jsonl` (JSONL → line-by-line, no full load).
- Resolve by ID grammar (§3); look up clusters in `clusters/clusters.jsonl`.
- Validate against vendored `schema/`. A tiny reader lib ships as `@knowledge-crib/soul-reader`.

**Tier 2 — engine/MCP (rich):** call Knowledge-crib MCP verbs (`context`, `impact`, `query`) for
ranked/hybrid results. Needs the server running.

**Compat export:** `crib export --format graph.json` flattens chunks → one Graphify-style
`graph.json` for tools that expect it.

> SeeroFlow integration = a Tier-1 reader in a flow node (no engine dependency) for context load,
> with optional Tier-2 MCP calls when richer queries are needed. Contract is frozen at
> `schemaVersion` so flows don't break on engine upgrades.

---

## 8. Privacy / git hygiene
- Committed: structure (nodes/edges/clusters/manifest) — derived from code already in the repo, so
  no new secret exposure; text is referenced, not duplicated.
- Gitignored by default: `index/` (rebuildable) and `embeddings/` (large, regenerable).
- LLM-`INFERRED` edges are clearly tagged → a reviewer can filter to `EXTRACTED`-only for a
  trust-only view.
