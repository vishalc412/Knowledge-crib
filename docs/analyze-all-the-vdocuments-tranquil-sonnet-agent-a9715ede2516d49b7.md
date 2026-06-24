# Adversarial Verification: DuckDB+VSS "disqualified for desktop" claim

## Verdict: NOT REFUTED (refuted=false), confidence high

## Claim parts vs evidence
- MIT Node bindings: CONFIRMED by source (`@duckdb/node-api`, MIT).
- "Aggressive RAM usage": literal phrase from source's TL;DR table.
- OOM exclusion from large profiles: source says "excluded from l/xl/xxl to avoid OOM crashes"; "nearly OOMed a development machine" at 500k/512d.
- SQL array serialization overhead: source cites ~3KB text per query, 39 QPS vs usearch 367 QPS.
- Index bloat: 488MB vs ~200MB at 100k (2.5x).
- "disqualified for desktop": source verbatim — "For a desktop app running on consumer hardware alongside other applications, this is disqualifying."

## Independent corroboration (not from the cited bench)
- Official DuckDB VSS docs: HNSW index is NOT buffer-managed, must fit entirely in RAM, does NOT count toward `memory_limit`, deserialized whole into RAM on first access. This is the structural root cause and is current.
- Kent Danielsson blog (~2026): real OOM incident at ~5M rows; recommends FAISS for million-row scale.
- Icemap/duckdb-vector-index fork (Apr 2026): confirms duckdb-vss must copy float32 codes internally (no external-pointer trick in column store), ~75.8MB RSS at 100k/128d.

## Adversarial angles tried
- Issue #182 (Float32Array binding) was CLOSED May 2025; type inference added in v1.2.2-alpha.19. BUT Float32Array typed arrays still not natively supported (need Array.from / arrayValue()). Plain JS arrays now bind. So the binding limitation is partially stale, but the measured 10x QPS gap and serialization overhead are performance findings, not blocked by this fix. Does not refute core claim.
- Source is a benchmark repo (photostructure) — but it's a primary measurement source, and the central RAM/OOM point is confirmed by OFFICIAL DuckDB docs, so source-quality bar is met.
- Date: page is 2026; HNSW persistence still experimental; RAM-not-buffer-managed limitation is documented as current. Not outdated.

## Nuance preserved
Claim is scale-qualified ("excluded from large profiles") and the source agrees DuckDB VSS is "Best for: Small datasets only." The "disqualified for embedded/desktop" framing is the author's consumer-hardware conclusion, accurately quoted, not an overreach.