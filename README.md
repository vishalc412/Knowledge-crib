# Knowledge-crib

> A portable **"project soul"** for AI coding agents — a local-first knowledge graph that digs deep
> like GitNexus and indexes broadly like Graphify, persisted as the project's memory: cross-IDE,
> agent-agnostic, incrementally upgraded as the project evolves. Delivered as **one fast MCP server**
> (not a skill). Greenfield, all-new, **Apache-2.0**.

**Status:** implementation in progress — see [the build plan](docs/knowledge-crib-build-plan.md).

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
- **IndexStore** — derived fast-query layer (sqlite + FTS5 + optional sqlite-vec); gitignored;
  rebuildable from the soul. Kùzu/Ladybug is an optional future backend.

The deterministic core (parse / graph / impact / search) **never needs a network**. LLM enrichment is
opt-in, off the query hot path, via direct LLM provider API calls (MCP sampling is deprecated).

## Repo layout
```
knowledge-crib/                 # pnpm monorepo
  packages/
    soul-schema/   # JSON Schema + TS types (the contract)
    core/          # GraphModel, SoulStore, IndexStore
    parsers/       # tree-sitter (WASM) wrappers + ANTLR4 legacy front-end
    pipeline/      # extract → resolve → link → cluster → index
    mcp/           # MCP server (npx knowledge-crib)
    cli/           # crib index|update|export|serve|mcp|viz|install-hooks|merge-driver
    ui/            # web graph viz (later)
    soul-reader/   # engine-free reader for SeeroFlow / external
  docs/            # the spec package
```

## Develop
```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Requires Node >= 20 (22+ recommended), pnpm 9.x.

## Document index (read in order)
See [`docs/README.md`](docs/README.md) for the full 17-doc spec index.

## License
Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). GitNexus and Graphify are credited as design
inspiration only — no code is derived from either.