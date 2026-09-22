# Knowledge-crib design documents

HLD and LLD for Knowledge-crib as built at commit `034c3853` (branch `debug/auditMaster`). The Markdown files are the source of truth. The Word copies in `dist/` are built from them with `project-doc-set` and are not committed (`commit_docx: false` in [doc-set.config.yaml](doc-set.config.yaml)).

| # | Document | Reader | Owner | Word |
|---|---|---|---|---|
| 01 | [HLD — Knowledge-crib](01-hld.md) | An architect judging fit: context, containers, key flows, data, NFRs with measured numbers, decisions, risks | Vishal Chawla (maintainer) | `dist/01-hld.docx` |
| 02 | [LLD — Knowledge-crib](02-lld.md) | Whoever changes or debugs the internals: package by package interfaces, schemas, core code excerpts, failure behaviour, tests | Vishal Chawla (maintainer) | `dist/02-lld.docx` |

## Reading order

1. HLD §1–§3 give the mental model: one engine, a committed soul (the source of truth), a derived SQLite index, and memory with its own trust model.
2. HLD §4 covers the four flows that matter: indexing, a tool call, observe → admit → recall, and connected memory graph retrieval.
3. LLD §1 is the dependency rule. After that, read the package you are about to touch: §3 core, §5 pipeline, §6 memory, §7 mcp, §8 cli.
4. HLD §8 records the decisions, and HLD §9 plus LLD §11 list what is still undecided.

## Traceability: design to tests and evidence

| Concern | Design | Enforced / measured by |
|---|---|---|
| Soul determinism, edge conflict rule | HLD D1 · LLD §3.4 | `packages/core/src/conflict-rule.test.ts`, `soul-store.test.ts` |
| Incremental update closure | HLD §4.1 · LLD §5.3 | `packages/pipeline/src/update.test.ts` |
| Memory admissibility and recall eligibility | HLD §4.3, D3 · LLD §6.4–§6.6 | `packages/memory/src/evaluator.test.ts`, `recall.test.ts`, `docs/bench/memory.md` |
| Connected memory graph | HLD §4.4, D5 · LLD §6.7 | graph acceptance corpus, `docs/bench/graph-gates.md` (held-out 86.94%, NO-GO) |
| Token budgets, ifHash, pins | HLD §4.2 · LLD §7 | `packages/mcp/src/token-budget.test.ts`, `docs/bench/review-cost.md` |
| Freshness modes | HLD §6 · LLD §8.3 | `packages/cli/src/freshness*.test.ts`, `docs/bench/perf-gates.md` |

## Open questions (all documents)

| # | Question | Source | Owner |
|---|---|---|---|
| 1 | Index time grows super-linearly (4.8× LOC → 17× wall time) and there is no 100k+ LOC data point. Re-run `scripts/scale-bench.mjs` before making any scale claim. | HLD R1 | maintainer |
| 2 | Connected retrieval on held-out data is 86.94%, below the 90% gate, and corpus v2 is spent. Decide the decoy semantics for a principal's own global claims, then author corpus v3. | HLD R2 · LLD Q3 | maintainer |
| 3 | Migrate the 38 memory-1 records that have no principal stamp (`crib memory migrate`) in the live stores? | HLD R3 · LLD Q4 | maintainer |
| 4 | Vendor client certification: all 21 client/platform cells are uncertified. | HLD R4 | maintainer |
| 5 | Wire the installed embedder into `openIndex` so code search is hybrid, after measuring the index-time cost. | HLD R5 · LLD Q1 | maintainer |
| 6 | Memory evidence resolution in a running MCP server should adopt the reader generation, as graph reads already do. | HLD R6 | maintainer |
| 7 | Should `writeJsonAtomic` fsync the file and directory before rename, and what does that cost in write latency? | LLD Q2 | maintainer |

## Rebuild

```bash
python3 ~/.claude/skills/project-doc-set/scripts/docset.py build docs/design/01-hld.md docs/design/02-lld.md --out-dir docs/design/dist --verify
```
