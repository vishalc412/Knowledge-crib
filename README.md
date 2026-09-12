# Knowledge-crib

> A portable **"project soul"** for AI coding agents — a local-first knowledge graph that digs deep
> like GitNexus and indexes broadly like Graphify, persisted as the project's memory: cross-IDE,
> agent-agnostic, incrementally upgraded as the project evolves. Delivered as **one fast MCP server**
> (not a skill). Greenfield, all-new, **Apache-2.0**.

**Status:** implemented and release-gated, `0.1.0` — not yet tagged/published. Before adopting, read
the dated [capability matrix](docs/capability-matrix.md): what is measured vs unverified, what is
default vs opt-in, and the known limits carried into launch. Drift-prone counts (packages,
languages, test surface, MCP tool count) live in one generated source —
[docs/STATS.md](docs/STATS.md) — refreshed by `pnpm docs:stats`; reference it instead of restating
a number here.

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
indexed source (current self-index topology: `crib status` — the numbers below were measured on
2026-07-16; re-running the harness reprints them against today's tree). Prices: input $3, output
$15, cache-write $3.75, cache-read $0.30 per 1M tokens (Sonnet-class list; overridable via env).

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
- **GraphStore** — `.crib/graph` is the sole graph source of truth. `extracted/` holds deterministic
  JSONL; `semantic/` holds grounded model-authored artifacts. The composite view joins both; a
  working overlay + materialized layers keep large graphs fast to open without changing the store.
- **Memory** — `@knowledge-crib/memory`: a durable agent-memory ledger (observe → evaluate/admit →
  recall, bi-temporal so records can be superseded, not silently edited), team memory over Git,
  and opt-in encrypted cross-device sync. Sessions can resume after an IDE timeout via intake
  checkpoints.
- **IndexStore** — derived SQLite + FTS5 query layer; gitignored and rebuildable from GraphStore.
- **Semantic recall** — on-device ONNX embeddings behind `crib embed setup` (opt-in): the default
  `large` model reaches 81.1% paraphrase recall / 0.881 MRR with no Python and no network after
  download; a machine without it serves the char-ngram fallback (~2.6% paraphrase recall). The
  measured ladder is in [docs/bench/onnx-model-ladder.md](docs/bench/onnx-model-ladder.md).
- **Freshness** — `crib serve --watch` re-indexes on save (verified at 805-file scale) and a
  background `--auto` worker keeps the soul fresh while you work.

The deterministic core (parse / graph / impact / search) **never needs a network**, and the server
itself **makes no model calls** — LLM enrichment is opt-in and authored by the host agent through
the bundled `/crib-enrich` skill, so the server stays provider-neutral.

## Repo layout
```
knowledge-crib/                 # pnpm workspace — 8 packages (canonical counts: docs/STATS.md)
  packages/
    soul-schema/   # JSON Schema + TS types (the contract)
    core/          # GraphStore, SoulStore, materialize, manifest, validation
    memory/        # durable agent memory: ledger, admission, team-over-Git, encrypted sync
    parsers/       # offline extractors — 11 incl. TS, Java, Python, C#, Go, Rust, PHP, PL/SQL, Markdown, Mule, agent artifacts
    pipeline/      # discover → extract → resolve → link → cluster → index
    mcp/           # the MCP server (17 tools / 47 operations)
    cli/           # 36 verbs: index | setup | doctor | update | serve | embed | memory | viz | …
    ui/            # offline graph visualization + memory home (`crib viz`)
  docs/            # the spec package; START with docs/capability-matrix.md
```

## Install

### One command, nothing left to do

```bash
git clone https://github.com/KnowledgeCrib/knowledge-crib.git && cd knowledge-crib
corepack pnpm@9.15.0 bootstrap          # or: node scripts/bootstrap.mjs <your-repo>
```

That installs workspace dependencies, builds every package, puts `crib` on your PATH, and then runs
`crib setup` against the target repository — which indexes it, wires the git hooks, writes the MCP
server config for **every** client, writes the mandatory agent protocol into **every** client's
instruction file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.windsurfrules`,
`.github/copilot-instructions.md`, `.cursor/rules/crib.mdc`), downloads and integrity-pins the
on-device embedding model, creates the team + local memory stores, and finishes with the health
check. There is no second step.

Two things are worth knowing before you run it, because both are downloads:

| flag | what it changes |
|---|---|
| *(default)* | installs the `large` embedding model — **~2.1 GB**, one time, offline afterwards |
| `--embed-model small` | a ~97 MB model instead (lower paraphrase recall; see the ladder above) |
| `--no-embed` (or `KCRIB_NO_EMBED=1`) | no model at all — recall stays lexical (~2.6% on paraphrases) |
| `--embed-from <dir>` | adopt a pre-fetched bundle instead of downloading (air-gapped hosts) |

The model weights are **not** committed to this repository — they are ~2.1 GB of third-party
artifacts under their own licences. `crib setup` fetches them for you on first run and pins them
through crib's integrity manifest; after that every query is offline.

### In an already-installed environment

```bash
crib setup .       # the whole thing: index + hooks + MCP + protocol + model + memory + doctor
crib doctor .      # ✓/✗ setup health check with fix hints
```

`crib init .` is the subset that stops before the memory stores and the health check, and
`crib init --ide detected` narrows the wiring to the clients this machine appears to run.

### Manual workspace install

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
crib setup .       # everything: index + hooks + MCP + protocol + model + memory + doctor
crib doctor .      # ✓/✗ setup health check with fix hints
```

New team member? Start with the self-contained
[**Team User Guide (HTML)**](docs/knowledge-crib-user-guide.html) or the full
[user guide](docs/knowledge-crib-user-guide.md).

Beta installer bundles for macOS and Windows can be built with
`corepack pnpm@9.15.0 installer:build`; see
[`docs/knowledge-crib-beta-installers.md`](docs/knowledge-crib-beta-installers.md). The generated
`install.sh` / `install.ps1` finish the same way `bootstrap` does: if you run them from inside a git
repository they install the CLI **and** run `crib setup` on it. `KCRIB_NO_SETUP=1` installs the
binary only.

## Develop
```bash
corepack pnpm@9.15.0 install
corepack pnpm@9.15.0 release:verify
```

Requires Node >= 22.5 and pnpm 9.15.0 via Corepack.

## Document index (read in order)
See [`docs/README.md`](docs/README.md) for the complete specification and guide index, and
[`docs/capability-matrix.md`](docs/capability-matrix.md) for the dated support boundary.

## Community

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License
Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). GitNexus and Graphify are credited as design
inspiration only — no code is derived from either.