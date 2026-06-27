# Contributing to Knowledge-crib

Thanks for helping make Knowledge-crib better. This project is a local-first CLI/MCP server for
building a portable project knowledge graph, so contributions should preserve determinism,
offline-first behavior, and clear provenance.

## Development Setup

Requirements:

- Node.js 20 or newer
- pnpm 9.15.0 via Corepack
- Python 3 for the optional worker tests

```bash
corepack enable
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 build
corepack pnpm@9.15.0 release:verify
```

## Before Opening a Pull Request

Run the release gate:

```bash
corepack pnpm@9.15.0 release:verify
```

That gate builds every package, runs Vitest and Python tests, checks formatting/linting, verifies
package tarballs, exercises a recursive publish dry-run, builds the beta installer bundle,
smoke-installs the packaged CLI, checks schema subpath exports, and indexes a temporary project
through the built CLI.

## Contribution Guidelines

- Keep the deterministic core offline. Do not add network calls to indexing, querying, or MCP read
  paths.
- Preserve provenance. Extracted graph facts should be distinguishable from inferred or LLM-authored
  facts.
- Add or update tests for parser, resolver, CLI, index, MCP, or packaging behavior changes.
- Keep generated artifacts out of commits unless they are intentionally part of the portable soul.
- Do not vendor third-party source without an explicit license review and NOTICE update.

## Reporting Issues

Use GitHub issues for reproducible bugs, feature requests, and documentation gaps. Include:

- Knowledge-crib version or commit SHA
- Node and pnpm versions
- Operating system
- Command run and full error output
- A small reproduction when possible

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
