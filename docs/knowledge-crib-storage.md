# Knowledge-crib — Storage Layer (SoulStore + IndexStore)

> Dual role [Q9]: **SoulStore** = portable source of truth (chunked JSONL, committed); **IndexStore**
> = fast derived cache (shipped: `better-sqlite3 + FTS5`; LadybugDB planned/not-wired, gitignored, rebuildable). On-disk format is in
> [soul-format](knowledge-crib-soul-format.md); this doc is the API + design.

---

## 1. SoulStore (source of truth)
```ts
interface SoulStore {
  load(): Manifest;                         // read .crib/crib.json
  putNodes(ns: Node[]): void;               // upsert by id; routes to shard by source-path hash
  putEdges(es: Edge[]): void;               // upsert by id; applies conflict rule on (src,dst,rel)
  getNode(id: string): Node | undefined;
  iterate(kind?: NodeKind): Iterable<Node>; // streaming, no full load
  iterateEdges(rel?: Rel): Iterable<Edge>;
  removeByFile(path: string): void;         // for incremental: drop a file's nodes + dangling edges
  commit(): void;                           // flush dirty shard-chunks + rewrite manifest stats
}
```
**Design:**
- **Sharding:** `shard = blake3(sourcePath)[:shardHexDigits]`; chunk rolls at `maxChunkLines`. A
  file edit touches one shard → small git diffs, low merge conflict.
- **Encoding:** JSONL (one record/line) → streamable, line-diffable, append/patch-friendly.
- **Upsert + conflict rule:** edges sharing `(src,dst,rel)` collapse per data-model §3 (EXTRACTED >
  INFERRED > higher confidence; drop loser < threshold).
- **Dirty tracking:** only touched chunks are rewritten on `commit()`.
- **Validation:** every record validated against vendored JSON Schema before write.

## 2. IndexStore (derived, fast, swappable)
```ts
interface IndexStore {
  buildFromSoul(soul: SoulStore): void;  // full rebuild; no options (no vector/ANN path ships)
  applyDelta(changed: { nodes: Node[]; edges: Edge[]; removed: string[] }): void; // incremental
  query(q: HybridQuery): Hit[];             // BM25 (no vector index wired; see `--semantic` for the TF-IDF linker)
  impact(id: string, dir: Dir, depth?: number): ImpactResult;  // reverse/forward edge traversal
  neighbors(id: string, rel?: Rel, dir?: Dir): Edge[];
  shortestPath(from: string, to: string, maxHops?: number): PathResult;
  capabilities(): { cypher: boolean; vector: boolean };  // shipped: vector=false (hard-coded)
}
```
**Backends behind one interface [C3]:**
| Backend | Status | Notes |
|---------|--------|-------|
| **better-sqlite3 + FTS5** | **shipped (default)** | pure-Node, zero native-binding risk; `capabilities.cypher=false`, `capabilities.vector=false` |
| **LadybugDB** | planned / not-wired | native graph + Cypher + vector; richest; original planned default, never shipped |
| **sqlite-vec (vector/ANN)** | planned / not-wired | optional vector layer on the sqlite backend; no `sqlite-vec` dependency shipped today |

The pipeline and MCP depend **only on `IndexStore`** — swapping backends touches nothing upstream.
The soul format is backend-agnostic.

## 3. Rebuild & drift guarantee
- The index is **100% derived**. `crib reindex` reconstructs it from the soul.
- Single-writer: only the pipeline writes the soul; the index is written only by `buildFromSoul` /
  `applyDelta`. → **no soul↔index drift possible**; the soul always wins.

## 4. Incremental path (ties to pipeline §incremental)
```
changed files → soul.removeByFile() + soul.putNodes/Edges() → soul.commit()
              → collect delta → index.applyDelta(delta)
```
Cost ∝ change size. Manifest `stats` + `vcsHead` + `incrementalSince` updated on commit.

## 5. Concurrency & safety
- Single-process writer; a lockfile (`.crib/index/.lock`) guards index writes.
- `commit()` is atomic per chunk (write-temp → rename).
- Reads (MCP queries) are lock-free against the index snapshot; a rebuild swaps the snapshot atomically.

## 6. Sizing knobs (set from C4 scale answer)
| Knob | Default | Effect |
|------|---------|--------|
| `shardHexDigits` | 2 (256 shards) | parallelism + diff granularity |
| `maxChunkLines` | 5000 | chunk file size |
| `semantic` | false | pure-JS TF-IDF semantic linker on/off (emits INFERRED `references` edges; not a vector/ANN path) |

## 7. Open confirmations
- **C3:** is LadybugDB embeddable under OSS terms for a TS product? If unresolved at M1, ship the
  sqlite backend as default and add Ladybug later — **does not block** the build.
