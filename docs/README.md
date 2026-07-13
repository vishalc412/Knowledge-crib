# Knowledge-crib

> A portable **"project soul"** for AI coding agents — a local-first knowledge graph that digs
> deep like GitNexus and indexes broadly like Graphify, persisted as the project's memory:
> cross-IDE, agent-agnostic, incrementally upgraded as the project evolves. Delivered as **one fast
> MCP server** (not a skill). Greenfield, all-new, **Apache-2.0**.

**Status:** implemented — the foundation + retrieval + enterprise + distribution milestones
landed (see [knowledge-crib-build-plan.md](knowledge-crib-build-plan.md) and
[knowledge-crib-m6-m13-build-plan.md](knowledge-crib-m6-m13-build-plan.md)), with schema behavior
nodes + persisted dossiers, served over one MCP server. This repo holds the spec + the
implementation. Counts (packages, languages, test surface) drift when stated in prose, so they live
in one generated source — see [STATS.md](STATS.md) (regenerated from the real tree by
`scripts/docs-stats.mjs`; reference it instead of restating a number here).

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
| — | [knowledge-crib-changelog-req1-req2.md](knowledge-crib-changelog-req1-req2.md) | Changelog: single-entry root resolution + `crib mcp` auto-wiring (REQ-1, REQ-2) |
| — | [knowledge-crib-user-guide.md](knowledge-crib-user-guide.md) | User guide (install, workflow, 12 verbs, worked example) |
| — | [knowledge-crib-client-setup.md](knowledge-crib-client-setup.md) | IDE MCP wiring (Claude Code, Cursor, VS Code/Copilot, Codex) |
| — | [knowledge-crib-prompts.md](knowledge-crib-prompts.md) | **Prompting guide** — how to drive crib from a local LLM (Claude Code / Codex) to save tokens + compute |
| — | [knowledge-crib-refined-vs-existing-assessment.md](knowledge-crib-refined-vs-existing-assessment.md) | **Refined vs existing comparison + six-role judgment** on detailed-level analysis (plan review) |
| — | [knowledge-crib-m6-m13-build-plan.md](knowledge-crib-m6-m13-build-plan.md) | Milestones M6→M13 (post-foundation build plan) |
| — | [knowledge-crib-production-readiness.md](knowledge-crib-production-readiness.md) | Release gate, packaging fixes, and remaining production gaps |
| — | [knowledge-crib-beta-installers.md](knowledge-crib-beta-installers.md) | macOS and Windows beta installer bundle build/install guide |

## Launch assets (M4.6)

Drafts for the launch — human-reviewed before posting/recording. Grounded in
[knowledge-crib-technical-pitch.md](knowledge-crib-technical-pitch.md); do not contradict its honest
limits section. Counts reference [STATS.md](STATS.md) (generated, not hardcoded).

| Asset | What it is |
|---|---|
| [launch/comparison.md](launch/comparison.md) | The 7-column capability matrix vs GraphRAG / SCIP / Joern / CodeQL / Aider / Glean — the moat is the intersection |
| [launch/show-hn.md](launch/show-hn.md) | Show HN post draft (technical tone, reproducible proof, honest limits) |
| [launch/linkedin-series.md](launch/linkedin-series.md) | 5-post LinkedIn arc: problem → mechanism → moat → proof → ask |
| [launch/demo-recipe.md](launch/demo-recipe.md) | Demo GIF/video shot list + exact commands (the capture itself is a user action) |
| [launch/publish-runbook.md](launch/publish-runbook.md) | **M4.1 — USER-ONLY.** npm publish 0.1.0 runbook (prereqs, changelog cut, publish order, clean-machine verify, rollback). Prep complete; needs `npm login` + explicit go |
| [launch/repo-identity-decision.md](launch/repo-identity-decision.md) | **M4.5 — USER-ONLY.** KnowledgeCrib org vs vishalc412 (npm scope `@knowledge-crib` is locked either way). Recommendation + alignment checklist |
| [launch/signing-deferral-adr.md](launch/signing-deferral-adr.md) | **M4.7 — USER-ONLY approval.** ADR deferring installer signing in favor of npm-first distribution (the plan's gate is "signed OR ADR deferring") |

## Open-Source Release Files

| File | Purpose |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution workflow, release gate, and project principles |
| [../SECURITY.md](../SECURITY.md) | Supported versions and private vulnerability reporting |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community participation expectations |

## Repo layout
```
knowledge-crib/                 # pnpm monorepo
  packages/
    soul-schema/   # JSON Schema + TS types (the contract)
    core/          # GraphModel, SoulStore, IndexStore
    parsers/       # offline extractors (TS/PL-SQL/Python/Java/C#/Go/Rust/Markdown)
    pipeline/      # extract → resolve → link → cluster → index
    mcp/           # MCP server (npx knowledge-crib)
    cli/           # crib index|update|export|serve|mcp|viz|install-hooks|merge-driver
    ui/            # offline React/canvas graph visualization
  docs/            # these specs
```

## Runtime & licensing
- **TypeScript / Node** [Q36]. Compiler-API and hand-rolled extractors are offline and deterministic.
  The `0.1.0` index is `node:sqlite` + FTS5.
- **Apache-2.0** [Q37]. `NOTICE` credits GitNexus + Graphify as inspiration. No code reused.

## Vision quickstart (target UX)
```bash
npx knowledge-crib index .      # build the soul + index for this repo
npx knowledge-crib serve        # start the MCP server (any agentic IDE connects)
# agent: "what breaks if I change AuthService?" → code blast-radius + the docs describing it
```
