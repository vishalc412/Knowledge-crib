# Adversarial verification: SQLite+FTS5+sqlite-vec "production-viable, 87.6%, ~40x faster" claim

## Verdict: REFUTED (high confidence)

### Claim decomposition
1. "production-viable from Node/TypeScript (via bun:sqlite)" — OVERREACH, refuted
2. "ranking highest in combined score (87.6%)" — supported by source
3. "~40x faster query latency than DuckDB+VSS+FTS" — supported at smallest dim, cherry-picked
4. "~4x faster indexing than LanceDB" — supported at smallest dim, overstates (ranges 2.2-5x)

### Refutation grounds
- **Source quality mismatch (strongest):** Source is lemon07r/vecdb-bench — a 6-commit repo testing **20 documents / 20 queries**. A 20-doc toy benchmark cannot establish "production-viability." The claim's strength far exceeds the source.
- **Source does not endorse production-viability:** The benchmark's own production recommendation reads "Any — quality is identical with reranker; pick based on ecosystem fit" — neutral, not an SQLite endorsement.
- **Contradicted by sqlite-vec's own status:** sqlite-vec is pre-v1 (v0.1.10-alpha.4), README warns "expect breaking changes," and it is **brute-force KNN only** (no HNSW/IVF ANN).
- **Independent scaling benchmark (photostructure/node-vector-bench, 1k–2M vectors)** explicitly states sqlite-vec is "Impractical above ~100k vectors." A "project soul" knowledge graph can easily exceed this.
- **Cherry-picked headline numbers:** ~40x latency and ~4x indexing are the 1024d/0.6B-model figures. At 4096d/8B the gap shrinks to ~22x latency and ~2.6x indexing.
- **bun:sqlite ≠ Node:** bun:sqlite is Bun-specific. sqlite-vec does work with better-sqlite3 and node:sqlite (Node 23.5+), but the claim's "via bun:sqlite" ties viability to Bun.

### What IS supported
- The 87.6% combined score and ~40x/~4x ratios are accurately quoted from the small benchmark.
- sqlite-vec has working Node/Bun bindings and is fine for small exact-search datasets.

### Sources
- https://github.com/lemon07r/vecdb-bench (primary, 20-doc toy benchmark)
- https://github.com/asg017/sqlite-vec (pre-v1 alpha, brute-force)
- https://github.com/photostructure/node-vector-bench (scaling reality: impractical >100k)
- https://duckdb.org/2026/05/21/test-driving-lance (independent: Lance wins cold search at scale)