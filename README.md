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

### The token-cost benefit, concretely
The default `query`/`context`/`dossier` response is deliberately **lightweight**: a one-line
snippet per hit plus, when an LLM analysis exists, a 5-field pointer (`provenance` / `model` /
`stale` / `confidence` / `purpose`) — **not** the multi-KB analysis+graph+evidence blob. On the
self-index a `query` hit carrying an LLM artifact is ~1.3 KB by default vs ~10.3 KB with the full
blob — **~7.7× smaller per hit**, so a 10-hit discovery call costs ~90 KB (~23 K tokens) less than
folding the full brief. The full brief is still one flag away (`--with-llm` / `withLlm: true`) when
you actually want it. This is the difference between "the crib pays for itself" and "the crib adds
cost": lean by default, deep on demand.

### Measured, not projected (run it yourself)
Two reproducible harnesses measure the real token and dollar gap against Knowledge-crib's own
indexed source (18,050 nodes · 32,600 edges · 351 clusters). Prices: input $3, output $15,
cache-write $3.75, cache-read $0.30 per 1M tokens (Sonnet-class list; overridable via env).

**One cross-package task** — "understand the query pipeline" — answered two ways
(`node scripts/crib-ab-task.mjs`):

| path | strategy | context tokens | cold cost (cache cleared) | warm 6-turn cost |
|---|---|---|---|---|
| no-crib | grep + read 3 whole defining files | 26,286 | $0.0789 | $0.591 |
| crib | `query`+`neighbors` (snippets + graph edges) | 1,415 | $0.0042 | $0.0074 |
| **saving** | | **18.58×** | **18.58×** | **79.61×** |

**Six discovery queries across the whole graph** (`node scripts/crib-bench.mjs`):

| | crib default tokens | raw file-read tokens | vs raw | crib $/task | no-crib $/task (churn) | no-crib $/task (cached) |
|---|---|---|---|---|---|---|
| **6 queries total** | 3,339 | 151,072 | **45.24×** leaner | $0.0175 | $3.399 | $0.793 |
| **cost saving** | | | | | **193.91×** cheaper | **45.25×** cheaper |

The "cache cleared" column is the honest floor: every token priced as fresh input, so the dollar
gap equals the token gap exactly — **you can't be billed for tokens you never needed to read.**
Caching only widens it (193.91× vs 45.25×). These same numbers gate CI (`node scripts/budget-check.mjs`
requires ≥3× cost saving) and a cache-stability regression test
(`node scripts/crib-cache-stability.test.mjs`) — both green. Full reports: `pnpm bench` /
`pnpm ab:task` (or pass `--out <path>` for a markdown file).

Two existing tools each prove half and serve as **design inspiration only (no code copied)**:
- **GitNexus** — how to dig deep (impact, call chains, type resolution).
- **Graphify** — how to index broadly and portably (any input → a queryable graph).

## The one-sentence model
**Parse → graph → persist as a committable "soul" → build a fast index from it → serve to agents over MCP.**

## Architecture
- **GraphStore** — `.crib/graph` is sole graph source of truth. `extracted/` holds deterministic
  JSONL; `semantic/` holds grounded model-authored artifacts. Composite view joins both.
- **IndexStore** — derived SQLite + FTS5 query layer; gitignored and rebuildable from GraphStore.
- **SoulStore** — compatibility writer/view for deterministic `graph/extracted` layer.
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
    parsers/       # offline extractors: TS, PL/SQL, Python, Java, C#, Go, Rust, PHP, Markdown
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

# One-time: create the global bin directory and add it to your PATH
corepack pnpm@9.15.0 setup
# Then restart your terminal (or `source ~/.zshrc`) so `crib` resolves.

corepack pnpm@9.15.0 --dir packages/cli link --global
crib --help
```

Do **not** run `pnpm add -g knowledge-crib` from inside the workspace — pnpm may create broken relative symlinks in the global install because the package declares workspace dependencies.

Then, in any project you want indexed:

```bash
crib init .        # index + git hooks + IDE MCP wiring (5-minute onboarding)
crib doctor .      # ✓/✗ setup health check with fix hints
```

New team member? Start with the self-contained
[**Team User Guide (HTML)**](docs/knowledge-crib-user-guide.html) or the full
[user guide](docs/knowledge-crib-user-guide.md).

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
