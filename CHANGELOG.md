# Changelog

All notable changes to Knowledge-crib are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Overview v2 — module-segmented, importance-ranked, lean by default.** `overview` now returns
  `modules` (always present, works at 0% enrichment), lean `analyses` pointers (production symbols
  first, test helpers last), and the system bible in its own slot (full preferred over a draft
  skeleton). The old v1 dump of every fresh artifact as a full analysis+graph+evidence blob sorted
  alphabetically is gone — it surfaced test helpers first and megabytes of scaffolding before the
  bible. v1 `overview.json` caches auto-rebuild via a `version === 2` gate. `withLlm:true` opts into
  the full blobs (computed live, never cached).
- **Functional map (`buildFunctionalMap`) + shared importance ranking** in `@knowledge-crib/core`:
  segments the soul into modules (workspace packages, else directory prefixes with a >80% monorepo
  descent rule) and ranks every node by architectural in-degree. Consumed by `ui` and `mcp` without
  crossing the dependency graph. No `module` NodeKind; `SCHEMA_VERSION` stays 1.3.
- **Importance-ranked enrich queue (new default):** `enrich_next` orders targets tests-last →
  importance desc (cluster = summed member importance) → id asc, replacing the alphabetical sort.
  `batchId` is unchanged for the same pending set (the reordering only affects which targets a small
  batch hits).
- **System-skeleton-first pass (Phase 0.5):** `enrich_next({layer:'system', skeleton:true})` returns
  a single draft-bible work item (functional map + top READMEs + top symbols seed) under a distinct
  `llm:system-skeleton:` batchId; `enrich_save` stamps `mode:'skeleton'` server-side. A skeleton
  never satisfies the system layer — the full pass is still offered and overwrites it.
  `enrich_status.systemSkeleton:{present,fresh}` gates the skill.
- **Heuristic cluster labels:** `<commonDirPrefix> · <dominantStereotypeOrType>`, falling back to
  the highest-degree member's qualified name when members span roots. Cluster `id`/`hash` untouched
  (no artifact-staleness cascade). LLM cluster names surface via a read-time overlay (no soul
  write-back — preserves `cache:stability`).
- **`crib viz` overview pane:** `/overview.json` route + module cards (name + purpose + counts) with
  per-module cluster drill-down and a back affordance. Null-guarded — an old server degrades to the
  existing cluster-card view.
- **M2.1 — local embeddings + RRF hybrid retrieval.** A pure-JS char 3–6-gram hashing embedder
  (FNV-1a → signed hashing trick → float32[512] → L2-norm) backs an opt-in hybrid path: BM25 ∪
  char-n-gram vectors fused by reciprocal-rank fusion (k=60). Vectors live only in the gitignored
  derived index, so the soul and `--extracted-only` stay byte-identical with or without embeddings.
  `semantic:check` gates conceptual-recall recovery of BM25 misses on the eval pack.
- **M2.2 — graph-aware rerank.** A deterministic structural prior (centrality × stereotype match ×
  per-intent kind prior) multiplies the RRF score on the hybrid path only — pure BM25 is returned
  untouched. `rerank:check` gates overall conceptual MRR strictly up + recall no-regress + 2-run
  determinism (overall MRR +2.76pp, recall 0.9132 → 0.9468 on the eval pack).
- **M2.3 — embedding-cosine semantic linker.** The M7 TF-IDF semantic linker's similarity kernel is
  pluggable: `'embedding'` (default, char-n-gram cosine) generalizes across inflection/case where
  TF-IDF's exact-token match sees no shared term; `'tfidf'` is retained as the baseline/fallback.
  Same [0.4, 0.6] confidence cap, same INFERRED `references` contract, deterministic-only subset
  untouched. `linker:check` gates a strict inflection catch TF-IDF misses + recall-up + precision
  held + 2-run determinism on the docs-semantic fixture.
- **M2.4 — alias dictionary + query rewrite.** A committed, per-repo, agent-authorable alias
  dictionary at `.crib/llm/aliases.json` maps domain shorthand ("DTI" → "debt to income") to a
  phrase that shares a token-prefix with the implementing symbol's surface, and a deterministic
  rewrite pass appends the expansion to `query` / `ask` before the text reaches the index. This
  resolves the camelCase acronym case (`DebtToIncomeCalculator` tokenizes to one FTS token
  `debttoincomecalculator`; "DTI" prefix-matches nothing, "debt to income" does). The index stays
  alias-agnostic; an absent/empty dictionary is a pure no-op so queries without aliases are
  byte-identical (zero regression). `alias:check` gates a strict miss → resolve → no-op →
  determinism chain through the real `Verbs.query` surface.

### Fixed

- `clusterSummary` read `c.name` (cluster nodes carry `label`, not `name`) → always undefined. Now
  reads `c.label ?? c.id` and surfaces LLM cluster names via the overlay.

## [0.1.0] - 2026-06-26

### Added

- Local-first project indexing into a portable, git-committable soul and rebuildable SQLite index.
- TypeScript, PL/SQL, Python, Markdown, and framework-aware extraction and resolution.
- Token-bounded MCP verbs for search, context, impact, explain, detect, gaps, and project status.
- `crib` workflows for indexing, updating, exporting, serving MCP, visualization, dossiers, hooks,
  merge drivers, and optional enrichment.
- macOS and Windows beta installer bundles with checksums and local smoke installation.
- Open-source governance, security, package metadata, and automated release-readiness checks.

### Fixed

- Persisted dossiers now refresh when graph relationships change without a source hash change, and
  orphan dossier files are pruned after full or incremental indexing.

### Security

- Repository-root resolution, generated-file filtering, package artifact checks, atomic derived
  index replacement, installer checksum enforcement, and immutable CI action pins are covered by the
  release gate.
- Every package tarball includes the canonical Apache license and project notice.
- Installer smoke tests exercise indexing and status through the installed package, including the
  packaged native SQLite runtime.
- A tag-triggered workflow verifies Linux, macOS, and Windows before creating the GitHub release.
- The release gate exercises pnpm's recursive publish lifecycle in dry-run mode.

[0.1.0]: https://github.com/KnowledgeCrib/knowledge-crib/releases/tag/v0.1.0
