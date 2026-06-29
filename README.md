# Knowledge-crib

> A portable **"project soul"** for AI coding agents — a local-first knowledge graph that digs deep
> like GitNexus and indexes broadly like Graphify, persisted as the project's memory: cross-IDE,
> agent-agnostic, incrementally upgraded as the project evolves. Delivered as **one fast MCP server**
> (not a skill). Greenfield, all-new, **Apache-2.0**.

**Status:** `0.1.0` release candidate. Run the full release gate before tagging or publishing; see
[production readiness](docs/knowledge-crib-production-readiness.md) and the
[build plan](docs/knowledge-crib-build-plan.md).

---

## Why
AI coding agents break things and burn tokens because they lack durable, architectural context.
They re-read files every session to rebuild understanding. Knowledge-crib indexes a project **once**
into a queryable graph (the *soul*), then serves it to any agent over MCP — so the agent gets full
project context **fast**, with **far fewer tokens**, and stops making architecture-breaking changes.

Two existing tools each prove half and serve as **design inspiration only (no code copied)**:
- **GitNexus** — how to dig deep (impact, call chains, type resolution).
- **Graphify** — how to index broadly and portably (any input → a queryable graph).

## The one-sentence model
**Parse → graph → persist as a committable "soul" → build a fast index from it → serve to agents over MCP.**

## Architecture (dual store)
- **SoulStore** — chunked JSONL graph committed to git; source of truth; cross-IDE; engine-free
  (readable by SeeroFlow with zero dependencies).
- **IndexStore** — derived SQLite + FTS5 query layer; gitignored and rebuildable from the soul.
  Vector search and alternate graph backends do not ship in `0.1.0`.

The deterministic core (parse / graph / impact / search) **never needs a network**. LLM enrichment is
opt-in and off the query hot path: the bundled `/crib-enrich` skill lets the host agent author a
grounded semantic graph, while the server remains provider-neutral.

## Repo layout
```
knowledge-crib/                 # pnpm monorepo
  packages/
    soul-schema/   # JSON Schema + TS types (the contract)
    core/          # GraphModel, SoulStore, IndexStore
    parsers/       # offline extractors: TS, PL/SQL, Python, Java, C#, Go, Rust, Markdown
    pipeline/      # extract → resolve → link → cluster → index
    mcp/           # MCP server (npx knowledge-crib)
    cli/           # crib index|update|export|serve|mcp|viz|install-hooks|merge-driver
    ui/            # offline React/canvas graph visualization
  docs/            # the spec package
```

## Install

Knowledge-crib is a pnpm workspace. The recommended way to make the `crib` CLI available globally is to link the workspace `cli` package, not to install a separate copy from a registry. Linking keeps the global binary pointing at your local checkout so workspace dependencies resolve correctly.

```bash
cd knowledge-crib
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 build
corepack pnpm@9.15.0 release:verify
corepack pnpm@9.15.0 --filter knowledge-crib link --global
crib --help
```

Do **not** run `pnpm add -g knowledge-crib` from inside the workspace — pnpm may create broken relative symlinks in the global install because the package declares workspace dependencies.

Beta installer bundles for macOS and Windows can be built with
`corepack pnpm@9.15.0 installer:build`; see
[`docs/knowledge-crib-beta-installers.md`](docs/knowledge-crib-beta-installers.md).

## Develop
```bash
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 release:verify
```

Requires Node >= 22.5 and pnpm 9.15.0 via Corepack.

## Document index (read in order)
See [`docs/README.md`](docs/README.md) for the complete specification and guide index.

## Community

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License
Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). GitNexus and Graphify are credited as design
inspiration only — no code is derived from either.
