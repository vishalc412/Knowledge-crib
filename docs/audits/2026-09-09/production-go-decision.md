# Production developer-launch decision — candidate `01ac6103`

**Decision: NO-GO — one blocker.** `client-cell-uncertified:claude/darwin`.

Everything else the launch policy requires is proven. The single remaining condition is a vendor
runtime receipt for Claude Code on macOS, which needs a terminal where Claude Code is signed in — a
nested non-interactive `claude` reports "Not logged in", and an unauthenticated client certifies
nothing. The command is at the bottom of this page.

This report describes candidate **`01ac610384ef0c9d12a272006ec6cca38cc94c98`** (clean tree). The
commit that adds this file is not that candidate. Receipts live outside tracked source in
`~/crib-launch-evidence/2026-09-09-go/`.

| Identity | Value |
|---|---|
| Source commit | `01ac610384ef0c9d12a272006ec6cca38cc94c98`, `dirty=false` |
| Shipped package | `sha256:f53108f0e208bed7eee57fc35eb937fe6f2e9a3dc231cb69ae7fe255dc5e4308` |
| Launch policy | `sha256:44da0cce45cf15c81b191de992344e21e6c7883dd0d156b3d12a4d9fbbcbcbdf` (version 2) |
| Scorer | `memory-rank-v2:multilingual-e5-large-1024-sym:cosine:semantic-only` |
| Evidence schema | 2 (certifying) |

## The promise this decides

**Policy version 2 narrows the advertised scope to what the evidence reaches.** Certified:
**Claude Code on macOS**. Preview — wired, protocol-tested, documented, and *not supported*:
Copilot, Cursor, Codex, Windsurf, Gemini, VS Code, and every client on native Linux and Windows.
Cross-device sync stays preview.

Version 1 advertised 7 clients × 3 platforms. The evidence reached one of those 21 cells, so the
promise moved to the evidence rather than the reverse — a deliberate product decision, taken with
the operator's authorization, which is why the policy hash changed and every receipt collected under
version 1 was recollected. Widening it back reinstates each cell as a hard requirement.

A GO here approves **the candidate against that narrowed promise**. Publishing additionally requires
the tag workflow's aggregate over `macos-latest/22` and `macos-latest/24` on real CI runners.

## What passes

| Condition | Result |
|---|---|
| A01–A09 audit findings | all repaired, each with a regression test that failed first |
| Workspace tests | 3,017 passed across 8 packages |
| Frozen gates G1–G8 | all pass: G1 1.0000, **G2 0.8105** (≥0.80), **G3 0.8814** (≥0.75), G4 1.0000, G5 0, G6 0, G7 0, G8 1.0000 |
| **Freshness** | **PASS — p95 2022ms against the preregistered 5000ms target**, 80 samples, 0 incorrect transitions |
| Install cycle | install → configure → uninstall → reinstall → authorized recall under `Users/jöhn doe`, exit 0, config and memory bytes preserved |
| Native service | real launchd cycle on this host: uninstall (launchctl confirms absence) → install (`state = running`) → restart → machine restored, plus lease and interrupted-worker suites |
| Browser acceptance | 8/8 against a real backend, desktop and 390px |
| Recovery | crash-recovery and portability suites pass |
| Security/privacy | battery, checks, and the support-bundle sentinel sweep pass |
| Adapter health | pass |

### On the freshness number

The first run of the frozen workload **failed**: p95 6113ms. The target was not moved. The harness
was wrong — it drove the `external-update` transition with a full `crib index` (the *initial*
indexer, 2.2s on this workload) when the coordinator itself names the external-update signal as an
external `crib update` (the incremental refresh, 0.8s) in three places. With the correct command the
same frozen workload measures 2022ms. The full-reindex numbers are archived beside the receipt as
`freshness-FULL-REINDEX-fail.json` rather than deleted, and the receipt carries a per-transition
decomposition separating adoption from the mutation's own runtime.

| Transition | p95 total | adoption | mutation |
|---|---|---|---|
| save | 936ms | 936ms | 0ms |
| rename / delete / clean-checkout / merge / rebase | 660–1150ms | ~660–1100ms | 2–95ms |
| external-update | ~2300ms | ~1150ms | ~1380ms |
| restart | ~1850ms | ~370ms | ~1490ms |

## The one blocker

**`client-cell-uncertified:claude/darwin`.** `scripts/client-certify-claude.mjs` performs the whole
cell: it installs the exact candidate tarball into an isolated prefix, generates the config through
the shipped installer, then drives the real `claude` binary through handshake and tool use, a
uniquely tagged authorized intake, a SIGKILL interruption, a restart that recovers that intake, and
a foreign-principal exclusion planted through a second principal's config. Every leg writes to a
transcript the receipt hashes, and a leg that cannot run fails the cell rather than being skipped.

It runs to completion up to the vendor's own authentication. From an authenticated terminal:

```bash
node scripts/client-certify-claude.mjs --out ~/crib-launch-evidence/2026-09-09-go/client-receipts
```

Then re-run the decision:

```bash
node scripts/release-evidence.mjs --out ~/crib-launch-evidence/2026-09-09-go/release-evidence-final.json --package dist/installers/knowledge-crib-0.1.0/knowledge-crib-0.1.0.tgz --receipts ~/crib-launch-evidence/2026-09-09-go/receipts --certification-receipts ~/crib-launch-evidence/2026-09-09-go/client-receipts --require-runtime-certification --certification-platforms darwin && node scripts/launch-decision.mjs --evidence ~/crib-launch-evidence/2026-09-09-go/release-evidence-final.json --candidate-commit 01ac610384ef0c9d12a272006ec6cca38cc94c98
```

If the vendor legs pass, that prints GO. If any leg fails, it prints NO-GO naming the leg — which is
the outcome the whole apparatus exists to make possible.

## Evidence

`~/crib-launch-evidence/2026-09-09-go/`:

| Artifact | sha256 |
|---|---|
| `release-evidence-final.json` | `cab700980c40924d47ed428e230ae1436c9d524482ab43cef7604bfceff61397` |
| `freshness.samples.json` (raw per-transition samples) | `4b2d235a8309a4c92c4b1fe779ef01118504cb4d91f1b77f9b7a896aa5b249b5` |

Seven typed receipts under `receipts/`, each `pass`, each bound to commit `01ac6103` and policy
`44da0cce`, each referencing at least one artifact by digest: `install`, `native-service`, `browser`,
`recovery`, `security-privacy`, `freshness`, `adapter`. Raw logs beside them: `install-cycle.log`,
`browser-acceptance.log`, `freshness-final.log`, `recovery.log`, `adapter.log`,
`security-privacy.log`, `native-service.log`, `support-bundle-darwin.json`, `workflow-rehearsal.log`.

## After GO

A GO on this candidate is not a publication. The tag workflow still requires `macos-latest/22` and
`macos-latest/24` to run on real CI runners, each writing its own typed receipts and cell manifest;
the aggregate binds them to one candidate, and the release job re-hashes the downloaded package
against the digest the decision approved before anything ships.
