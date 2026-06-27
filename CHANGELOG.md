# Changelog

All notable changes to Knowledge-crib are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
