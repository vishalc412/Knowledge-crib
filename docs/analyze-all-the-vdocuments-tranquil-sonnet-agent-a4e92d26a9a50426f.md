# Adversarial Claim Verification: sqlite-vec claim

## Claim
"sqlite-vec is a disk-backed brute-force/exact-search SQLite extension with MIT license, usable from Node, that achieves 100% recall but becomes impractical above ~100k vectors due to slow query speed at scale."

## Verdict: NOT REFUTED (refuted=false, confidence high)

## Component-by-component check

1. **Disk-backed via SQLite pager** — Supported by source (node-vector-bench) and consistent with upstream.
2. **Brute-force/exact search** — Confirmed by upstream author Alex Garcia's v0.1.0 blog: "Only brute-force search for now — no ANN indexes" (issue #25 tracks future ANN). Still current.
3. **MIT license** — Upstream asg017/sqlite-vec is **MIT/Apache-2.0 dual-licensed**. Saying "MIT license" is accurate (MIT is one of the two available licenses; usable under MIT terms). Minor incompleteness, not a refutation.
4. **Usable from Node** — Confirmed: upstream lists Node bindings alongside Python/Ruby/Go/Rust.
5. **100% recall** — Accurate for the exact/float path. (Quantized paths are lower: ~92% binary, ~99.8% int8, per Ninad Pathak benchmark — but the claim scopes to "exact-search", so 100% holds.)
6. **Impractical above ~100k due to slow query speed** — This is the source's characterization. Cross-checked against the OFFICIAL author benchmarks: at 100k float vectors, 3072-dim = 214ms and 1536-dim = 105ms, both exceeding the author's own 100ms target. So ~100k is exactly where high-dim embeddings cross the practical latency wall — the official author's data corroborates the source's "~100k" threshold for realistic embedding dimensions.

## Attempted refutations and why they fail
- "Official benchmarks show 1M vectors at 17ms" → only for LOW-dim (128-dim sift1m). For high-dim embeddings (1536/3072) used in AI code context, 1M = 8.52s (3072-dim) — genuinely impractical. The ~100k threshold is dimension-dependent but correct for the realistic use case.
- "License is Apache not MIT" → it's dual MIT/Apache; MIT claim is valid.
- "Outdated, ANN may have shipped" → no evidence ANN shipped; brute-force-only remains current per search results.

## Source quality
node-vector-bench runs actual measurements (primary-ish). Corroborated by Alex Garcia's official v0.1.0 benchmarks and the Ninad Pathak WASM benchmark. Quality matches claim strength.

## Conclusion
Claim is well-supported by the quoted source, current, and corroborated by the upstream author's own benchmarks for the realistic high-dimensionality embedding case. Not refuted.