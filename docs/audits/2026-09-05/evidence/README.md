# Audit evidence — 5 September 2026

Baseline: `544bb8d3bdd37985dc1fdd74b7a61d986d978b86` on `debug/auditMaster`, macOS, Node 22.23.1. These are audit observations, not trust-engine attestations or a release certificate. Product source was not edited. The graph was rebuilt and the compiled packages refreshed.

## Reproductions

Run from the repository root **after building**:

```sh
node docs/audits/2026-09-05/evidence/reproduce.mjs
node docs/audits/2026-09-05/evidence/watch-probe.mjs
node docs/audits/2026-09-05/evidence/watch-diagnostic.mjs
```

The probes use temporary directories and synthetic data, then remove their own fixtures. No real memory, user configuration, or remote sync backend is modified. Queue counts vary with scheduling; the recorded output is one actual three-trial run. Probe exit 0 means the experiment executed, not that product acceptance passed.

- `reproduce.mjs`: 8 concurrent processes × 25 distinct freshness tasks in each of 3 trials; counts calls that returned successfully and tests whether their task remained. Also persists a valid private v2 record and a valid v3 record, then compares principal-filtered gather, direct get/history and search. `probe-results.json` is the final observed result. An owning-principal v3 search also fails, so the crash does not depend on a mixed-owner store.
- `watch-probe.mjs`: creates a one-file Git project and communicates with the actual CLI over stdio MCP. Confirms stale queries without watch, then attempts 10 updates with watch. All 10 timed out; `observationDurationP95Ms` is the percentile of timeout durations, **not successful update latency**. `successfulUpdateP95Ms` is null. Output labels were normalized after the run to avoid misrepresenting timeouts; individual observations are unchanged.
- `watch-diagnostic.mjs`: one follow-up update captures full empty query results and watcher stderr. This diagnostic runs **one** update with a **3-second** observation window; its description was normalized after the run to match that sample count. It confirms that the overlay refreshed while query stayed empty. See `watch-diagnostic.json`.
- `http-boundary.json`: result of a local JSON-RPC `initialize` POST to the optional loopback HTTP daemon with synthetic foreign Host/Origin headers. Returned HTTP 200. The daemon was stopped afterward. This is request-boundary evidence, not an end-to-end browser exploit.

## Fresh commands and receipts

| Evidence file | Command | Observed exit / result |
|---|---|---|
| `verify.log` | `corepack pnpm@9.15.0 verify` | 0; build, 2,585 tests, lint |
| `release-metadata.log` | `corepack pnpm@9.15.0 release:metadata` | 0 |
| `mcp-smoke.log` | `node scripts/crib-self-hosted-e2e.mjs --skip-index` | 0; 16 tools listed, 29 calls |
| `capabilities.log` | `node scripts/capabilities-check.mjs` | 1; docs 41 versus runtime 46 operations |
| `lexical-launch-gates.json` | `node scripts/launch-vendor-compare.mjs --crib-only --json` | 0 even though G2/G3 fail; no vendor probe or competing tool invoked |
| `dependency-audit.json` | `corepack pnpm@9.15.0 audit --prod --json` | 1; 16 advisory entries |
| `dependency-summary.json` | Summarized from the preceding JSON | Advisory package/severity/ranges/URLs, no reachability claim |
| `graph-gaps.json` | `crib gaps . --json` | 0; analysis readiness incomplete |
| `freshness-graph-context.json` | `crib context 'sym:packages/cli/src/freshness.ts#enqueueFreshness@L201' --json` | 0; example confidence-1 callback edges |

Also run: `pack:check` (0, but omits memory package from its coverage), `security-doc-check.mjs` (0, documentation assertions only), `crib doctor` (initial missing index/model; after repair/build, 11/12), and `crib index` (successful repair). Full pack listings are omitted because they add little evidence beyond the source-reviewed package list and summarized result.

## What was not established

No full release:verify run, published-package install, three-OS acceptance, all-client integration matrix, large-model semantic remeasurement, 100k semantic runtime benchmark, full-repository 50-sample watch gate, 15-minute sync soak, power-loss durability exercise, or full security penetration test. Historic benchmark figures in repository docs remain historic and configuration-specific.

The markdown audit and external research are deliverables. These logs are reviewable artifacts and were not inserted as reusable memory claims. Knowledge Crib checkpoints contain only concise intent, findings, artifact locations and next actions.
