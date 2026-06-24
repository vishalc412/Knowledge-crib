# Knowledge-crib

> A portable **"project soul"** for AI coding agents — a local-first knowledge graph that digs
> deep like GitNexus and indexes broadly like Graphify, persisted as the project's memory:
> cross-IDE, agent-agnostic, incrementally upgraded as the project evolves. Delivered as **one fast
> MCP server** (not a skill). Greenfield, all-new, **Apache-2.0**.

**Status:** design/spec phase. This repo is the spec package handed to dev agents.

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

## Document index (read in order)
| # | Doc | What it covers |
|---|-----|----------------|
| — | [README.md](README.md) | This overview + index |
| 0 | [knowledge-crib-prd.md](knowledge-crib-prd.md) | Product vision, users, scope, metrics |
| 1 | [knowledge-crib-architecture.md](knowledge-crib-architecture.md) | System design + **diagrams** |
| 2 | [knowledge-crib-data-model.md](knowledge-crib-data-model.md) | Ontology: node kinds, edge rels, ID grammar |
| 2b | [knowledge-crib-deep-extraction.md](knowledge-crib-deep-extraction.md) | Deep code/SQL extraction + CFG/conditions (migration wedge) |
| 3 | [knowledge-crib-soul-format.md](knowledge-crib-soul-format.md) | The on-disk soul (the spine) |
| 4 | [knowledge-crib-storage.md](knowledge-crib-storage.md) | `SoulStore` + `IndexStore` design |
| 5 | [knowledge-crib-pipeline.md](knowledge-crib-pipeline.md) | Extract→resolve→link→cluster→index + algorithms |
| 6 | [knowledge-crib-extractor-plugins.md](knowledge-crib-extractor-plugins.md) | Plugin contract; add a language/format |
| 7 | [knowledge-crib-mcp-api.md](knowledge-crib-mcp-api.md) | MCP verb request/response specs |
| 8 | [knowledge-crib-cli.md](knowledge-crib-cli.md) | CLI commands |
| 9 | [knowledge-crib-build-plan.md](knowledge-crib-build-plan.md) | Milestones M0→M9 (agent tasks) |
| 10 | [knowledge-crib-testing.md](knowledge-crib-testing.md) | Test strategy + acceptance gates |
| 11 | [knowledge-crib-interview-guide.md](knowledge-crib-interview-guide.md) | User research plan |
| — | [knowledge-crib-decisions.md](knowledge-crib-decisions.md) | Locked decisions (Q1–Q38) — the why |
| — | [knowledge-crib-questionnaire.md](knowledge-crib-questionnaire.md) | The full decision questionnaire |

## Repo layout (target)
```
knowledge-crib/                 # pnpm monorepo
  packages/
    soul-schema/   # JSON Schema + TS types (the contract)
    core/          # GraphModel, SoulStore, IndexStore
    parsers/       # tree-sitter (WASM) wrappers
    pipeline/      # extract → resolve → link → cluster → index
    mcp/           # MCP server (npx knowledge-crib)
    cli/           # crib index|update|export|migrate|serve
    ui/            # web graph viz (later)
    soul-reader/   # engine-free reader for SeeroFlow / external
  docs/            # these specs
```

## Runtime & licensing
- **TypeScript / Node** [Q36]. tree-sitter via WASM. Index = LadybugDB or `better-sqlite3`+FTS5 fallback.
- **Apache-2.0** [Q37]. `NOTICE` credits GitNexus + Graphify as inspiration. No code reused.

## Vision quickstart (target UX)
```bash
npx knowledge-crib index .      # build the soul + index for this repo
npx knowledge-crib serve        # start the MCP server (any agentic IDE connects)
# agent: "what breaks if I change AuthService?" → code blast-radius + the docs describing it
```
