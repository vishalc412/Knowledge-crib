# Security Policy

## Supported Versions

Security fixes are accepted for the current `0.1.x` release candidate line. Until the first stable
release, older snapshots are not supported.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting for the repository at:

https://github.com/KnowledgeCrib/knowledge-crib/security

If private reporting is unavailable, open a minimal public issue that says you have a security report
to share, without exploit details or sensitive data.

## Scope

Security-sensitive areas include:

- CLI commands that read or write repository files
- MCP server request handling and path/root resolution
- Package installers and npm publishing artifacts
- Graph ingestion of untrusted source trees
- Optional LLM enrichment input/output handling

## Project Security Principles

- The deterministic indexing and query path should work offline.
- The derived SQLite index is rebuildable and should not be treated as a source of truth.
- MCP responses should be token-bounded and provenance-tagged.
- Generated installer and package artifacts must be verifiable from source.

## Data Classification & the LLM Layer (M1.4)

The knowledge graph has two committed artifacts, and they carry different data classes:

| Path | Committed? | Carries verbatim source? | Class |
|------|-----------|--------------------------|-------|
| `.crib/soul/` | yes | no — names, signatures, spans, hashes only | structural metadata |
| `.crib/llm/` | yes | **yes** — `evidence[].quote` lifts verbatim spans | model-authored + source snippets |
| `.crib/index/`, `.crib/embeddings/` | no (gitignored) | rebuildable derived state | not a source of truth |

Because `evidence[].quote` is verbatim source, a secret in the indexed source could be copied into a
committed `.crib/llm` artifact. Two guards (M1.4) prevent this:

1. **Persist-time secret scan** — `crib enrich --save` (the `enrich_save` verb) scans every
   model-authored string (analysis, graph, evidence) with known-key-prefix + high-entropy detectors
   and rejects the whole item on any hit. A planted canary secret can never reach a committed
   artifact. Run `crib audit-llm` after a refactor to re-verify persisted artifacts.
2. **`crib export --format llm --redact`** (default) — strips every evidence `quote` to a span ref
   `{soulId, file, startLine, endLine}` and masks any secret-pattern substring in analysis/graph
   strings. Use this bundle — never the raw `.crib/llm` tree — when sharing the LLM graph
   externally. `--no-redact` emits verbatim quotes (local debugging only).

**Policy:** never commit `.crib/index/` or `.crib/embeddings/` (already gitignored). Before sharing a
`.crib/llm` bundle outside a trusted enclave, export it with `crib export --format llm --redact` and
verify the output contains no `[REDACTED:*]` markers — a marker means a secret was present and masked;
trace and remove the secret at source before any external share.
