# Post-merge re-audit: evidence inventory

Receipts for the [post-merge launch re-audit](../../post-merge-reaudit.md), 5 September 2026.

**Source baseline:** `3fa52e53b2e4d9e29200e1c621db3a4ecb173bf0`, branch `debug/auditMaster`. **Host:** Apple M4 Max, arm64, 48 GiB, Node v22.23.1, darwin.

Every file here is a diagnostic receipt or the probe that produced it. None is a product fix, and none replaces a permanent regression test. The probes wrote only to temporary stores and synthetic child processes; product code, canonical memory, and the running freshness worker were not modified. Read each row's **limit** before quoting its result.

## Probes (runnable)

| Script | What it exercises | Produces |
|---|---|---|
| [`behavior-probes.mjs`](behavior-probes.mjs) | Migration freshness, native v3 admission, ordinary turn-end hook, outcomes without offsets, generated service definitions, concurrent worker election | `behavior-results.json` |
| [`worker-recovery-probe.mjs`](worker-recovery-probe.mjs) | Eight real OS processes acknowledge and claim refresh tasks, then are killed before revalidation | `worker-recovery.json` |
| [`intake-isolation-probe.mjs`](intake-isolation-probe.mjs) | Foreign-principal read, list, handoff and checkpoint against a private durable intake in a shared store | `intake-isolation.json` |
| [`reader-generation-probe.mjs`](reader-generation-probe.mjs) | Clean branch switch, external `crib update`, connected vs newly started MCP reader | `reader-generation.json` |
| [`full-watch-probe.mjs`](full-watch-probe.mjs) | Save/rename/delete/branch/restart loop on an isolated copy of this repository with a real stdio MCP | `full-watch-results.json` |

## Receipts

| File | Result | Limit |
|---|---|---|
| [`release-evidence.json`](release-evidence.json) | `acceptance.pass: false`; required failures `semantic-model`, `G2`, `G3`. G1 100%, G2 **2.6%** vs ≥80%, G3 **0.520** vs ≥0.75; G4–G8 pass. | Measures *this* installed configuration, whose model manifest failed integrity verification. Not the historical e5-large configuration. Workload: 500 queries over 307 records, scale 1. |
| [`local-status.json`](local-status.json) | Indexed at HEAD, schema 1.6, 39,751 nodes / 92,196 edges; `embeddings: false`, `vector: false`; worker running (pid 44118), 0 pending, 0 dead. | A point-in-time host snapshot. `whisper` absent; PDF and OCR adapters available. |
| [`behavior-results.json`](behavior-results.json) | **R01/R02/R06/R07.** Migration turned a 0-hit missing-source record into `evidence: valid`, `applicability: current`, `freshness.state: fresh`. Native v3 record readable but `trust: candidate`, not returned by exact-subject search. Ordinary hook: `status: checkpoint-requested`, `captured: false`, 0 candidates / 0 pending / 0 intakes. Worker election accepted **5–8 of 8** contenders across 12 trials. | Synthetic records and temporary stores. Service findings come from generated definitions and an injected manager response, not native Linux/Windows installation. |
| [`worker-recovery.json`](worker-recovery.json) | **R01.** 8 contenders elected, 8 tasks acknowledged and claimed; after kill, **1 recovered, 7 absent** from both recovery state and the pending queue. | Synthetic eight-project queue. This is loss of scheduled refresh work — canonical memory records were not deleted. |
| [`intake-isolation.json`](intake-isolation.json) | **R03.** `principal:A` read, listed, received in handoff, and successfully appended a checkpoint to `principal:B`'s `private` intake. | Library API boundary with shared configured stores. Default local stdio remains OS-user scoped; no remote unauthenticated exploit was demonstrated. |
| [`reader-generation.json`](reader-generation.json) | **R04.** Clean branch switch not queryable after 3 s. External update indexed the file and the watcher logged *"canonical soul advanced … overlay resynced"*, yet the connected reader returned **no match** while reporting the new HEAD and `aheadOfVcsHead: false`. A restarted reader returned the symbol immediately. | Minimal two-symbol fixture. Its stderr also records the semantic-tier integrity failure behind R05. |
| [`full-watch-results.json`](full-watch-results.json) | **R04.** 816 tracked files copied, 805 indexed (39,720 nodes / 91,745 edges, ~73 s). Saves **50/50**, p50 1,969 ms, p95 2,116 ms, p99 2,122 ms. Rename, deletion and clean branch switch matched; **`afterRestart` and `afterExplicitUpdate` did not match** (3.0 s / 7.0 s). | 2 warmups, 50 measured saves, 50 ms polling, explicit `--watch`, no service or hooks. The rename check waited on symbol existence, not the new locator — it is not a passing rename acceptance test. |
| [`watch-results.json`](watch-results.json) | One-file diagnostic: 10/10 updates, p95 **424 ms**; without watch the new symbol was absent and the old one still returned after 2.5 s. | Single-file fixture. Do not quote as repository-scale latency; see `full-watch-results.json`. |
| [`probe-results.json`](probe-results.json) | Prior reproductions re-run: producer queue **600/600** retained (3 trials × 8 processes × 25 tasks), 0 errors; foreign-principal record get/history correctly empty; v3 search did not throw. | Confirms the earlier repairs hold. Covers producers, not worker election or recovery — see `worker-recovery.json`. |
| [`sync-soak.json`](sync-soak.json) | 15-minute two-device soak: 875 cycles, 1,000 pushes, 176 pulls, 875 records + 125 tombstones converged on both devices, 0 errors, `pass: true`. | Synthetic file-backend workload on v1 records. Its own `durabilityClaim` excludes power-loss/fsync. Not a v3 cross-platform remote-network suite. |
| [`graph-accuracy.json`](graph-accuracy.json) | Labelled fixture: 5 true positives, 0 false positives, 0 false negatives; precision and recall 1.0. | One small TypeScript fixture labelling 5 positive edges and 2 unresolved calls. Establishes nothing about all-language accuracy. |
| [`graph-gaps-summary.json`](graph-gaps-summary.json) | 5,419 unresolved call sites, 481 unimplemented, `analysisReadiness: incomplete`. | An honesty signal about coverage, **not** a precision denominator for the fixture above. |
| [`dependency-audit.json`](dependency-audit.json) | 0 advisories across 110 production dependencies. | A dated advisory scan. Not a penetration test or reachability analysis. |
| [`memory-home.png`](memory-home.png), [`memory-ui-snapshot.md`](memory-ui-snapshot.md), [`ui-contrast.json`](ui-contrast.json) | **R08.** 8 pending, 0 active, 3 "Work to resume" rendered as counts with no route to act. Lifecycle tabs measured `rgb(230,237,246)` on `rgb(239,239,239)` — **1.025:1**. | The local configured UI at audit time. Contrast is a computed style reading for the tab controls, not a full WCAG audit. |

## Reproducing

Probes are standalone ES modules run with the workspace's Node. They create their own temporary stores; `worker-recovery-probe.mjs` spawns and kills real child processes.

```bash
node docs/audits/2026-09-05/evidence/reaudit/behavior-probes.mjs
```

`full-watch-probe.mjs` copies the tracked tree into an isolated checkout and indexes it — expect roughly 73 s of indexing before its measured saves begin.

## What is not here

No complete `release:verify`, packaged installation on any OS, live all-client matrix, independently authored retrieval benchmark, 100k served semantic workload, native Windows/Linux service acceptance, authenticated remote deployment, real multi-device network trial, power-loss test, or penetration test. Existing user state was never used for fault injection.
