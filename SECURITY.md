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
