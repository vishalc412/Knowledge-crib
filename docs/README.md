# Knowledge-crib documentation

Start with the [project README](../README.md) for the quick start. Counts that drift (packages,
languages, tests, MCP tools) live in one generated file — [STATS.md](STATS.md) — so no page below
restates them.

## Using crib

| # | Doc | What it covers |
|---|-----|----------------|
| 1 | [User guide](user-guide.md) | Install, the per-project workflow, every verb, troubleshooting |
| 2 | [Client setup](client-setup.md) | Wiring Claude Code, Cursor, VS Code/Copilot, Codex, Windsurf, Gemini |
| 3 | [CLI reference](cli.md) | Every `crib` command and flag |
| 4 | [MCP API](mcp-api.md) | Tool request/response specs and error shapes |
| 5 | [Prompting guide](prompts.md) | Driving crib from an agent to save tokens |
| 6 | [Memory sync](memory-sync.md) | **Encrypted cross-device memory sync** — setup and operations |
| 7 | [Installers](installers.md) | Building and smoke-testing the macOS/Windows installer bundle |
| 8 | [Capability matrix](capability-matrix.md) | What is measured vs unverified, default vs opt-in, known limits |

## How it works

| # | Doc | What it covers |
|---|-----|----------------|
| 9 | [Architecture](architecture.md) | System design and diagrams |
| 10 | [Data model](data-model.md) | Node kinds, edge relations, the ID grammar |
| 11 | [Soul format](soul-format.md) | The committed on-disk graph |
| 12 | [Storage](storage.md) | `SoulStore` and the derived `IndexStore` |
| 13 | [Pipeline](pipeline.md) | Discover → extract → resolve → link → cluster → index |
| 14 | [Deep extraction](deep-extraction.md) | Bodies, SQL, control flow and decision tables |
| 15 | [Extractor plugins](extractor-plugins.md) | Adding a language or format |
| 16 | [PDG and taint](pdg-taint.md) | The `explain` dataflow analysis and its limits |
| 17 | [MuleSoft](mulesoft.md) | Mule 3/4, DataWeave, RAML and MUnit extraction |

## Benchmarks

Measured results and the frozen methodology behind every performance and quality claim live in
[`bench/`](bench/) — for example [perf gates](bench/perf-gates.md),
[launch gates](bench/launch-gates.md), [scale curve](bench/scale-curve.md) and
[review cost](bench/review-cost.md).

A static HTML version of this index is generated at [site/index.html](site/index.html) by
`pnpm docs:build`.
