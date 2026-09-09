# Production developer-launch decision — candidate `536d9ea6`

**Decision: NO-GO.** Recomputed by `scripts/launch-decision.mjs` from
`scripts/launch-policy.json` and validated schema-2 evidence. 23 blockers, each named below.

This report describes candidate **`536d9ea6b20627dae72779b7cbd1d4846ceea099`** (clean tree). The
commit that adds this file is *not* that candidate — a decision cannot be part of the thing it
decides. Receipts live outside tracked source in `~/crib-launch-evidence/2026-09-09-go/` so
collecting them cannot dirty the candidate.

| Identity | Value |
|---|---|
| Source commit | `536d9ea6b20627dae72779b7cbd1d4846ceea099`, `dirty=false` |
| Shipped package | `sha256:f1999ca8bfd5a99668d4beb9acb682696184b0c38f5fb8877af457505b3f5fe2` |
| Launch policy | `sha256:0c80d28573155a1a5f540a42bb765b173eb8321b6ab5a609d14b0f2687019618` (pinned by `scripts/launch-policy.test.mjs`) |
| Scorer | `memory-rank-v2:multilingual-e5-large-1024-sym:cosine:semantic-only` |
| Evidence schema | 2 (certifying) |

## What the audit found, and what changed

All nine audit findings are repaired, each with a regression test that failed first.

| Finding | Repair | Commit |
|---|---|---|
| A04 install can overwrite client config | three-state config read (missing / ok / malformed); malformed is refused byte-for-byte with a located, actionable message; VS Code JSONC edited in place preserving comments | `b8e9372b` |
| A09 doctor misses a missing entry point | the generated `node <abs>/cli.js` launcher is validated on both halves and reported separately; client-owned launch args are never inspected or executed | `b8e9372b` |
| A05 freshness claims current while unknown | a failed VCS read on a VCS-backed project is stale; published-vs-reader generation identity is compared directly, and a release-driven adoption schedules one convergence scan | `07d66b84` |
| A08 superseded bundles not disposed | one owner for disposal with an exactly-once guard across all four exit routes | `07d66b84` |
| A07 malformed FTS metadata escapes recovery | the snapshot header is validated whole before any field is compared; invalid means rebuild from canonical shards | `2e3089c1` |
| A06 installer proof not Windows-safe | digest keys normalized to `/` at serialization; installer matrix extended to both advertised Node majors | `741fe052` |
| A01 decision accepts incomplete evidence | requirements moved into a hashed policy outside every artifact; the decision recomputes gates, receipts, model proof and identity from validated measurements | `c8dfa476` |
| A02 certification not bound to the candidate | a receipt covers a cell only for this exact commit, package and policy, with a vendor-client runtime pass and an operator/host attestation | `c8dfa476` |
| A03 publication independent of approval | the release job needs verification **and** the aggregate decision, runs only on an explicit GO, and re-hashes the downloaded package against the approved digest | `9b253efc` |

Rehearsed non-publishing against the real aggregation CLI with the workflow's own artifact layout:
complete matrix → GO; one manifest removed → blocked (`missing-evidence:windows-latest/24`); mixed
candidates → blocked (`candidate-commit-mismatch`); a failed install receipt → blocked
(`receipt-not-passing:install:fail`). The rehearsal itself caught a defect — with only the commit
pinned, the aggregate published an empty package digest, which would have blocked a legitimate GO.

## What passes

| Check | Result |
|---|---|
| Workspace tests | 3,017 passed (8 packages), exit 0 |
| Frozen gates G1–G8 | all pass on real measurements: G1 1.0000, **G2 0.8105** (≥0.80), **G3 0.8814** (≥0.75), G4 1.0000, G5 0, G6 0, G7 0, G8 1.0000 |
| Browser acceptance (real backend, Chromium) | 8/8, desktop and 390px |
| Install cycle under `Users/jöhn doe` | install → configure → uninstall → reinstall → authorized recall, exit 0, client config and memory bytes preserved |
| Recovery (crash + portability) | pass |
| Security/privacy | battery + checks + support-bundle sentinel redaction, pass |
| Adapter health | pass |
| Docs consistency + generated matrix | pass |

## The 23 blockers

### 1. Freshness misses its preregistered target — `receipt-not-passing:freshness:fail`

Measured against the workload frozen *before* the run: **p95 6113ms against a 5000ms target** over
80 samples. **All eight transitions are correct; zero misses, zero timeouts.** The target was not
retuned.

| Transition | p95 total | of which adoption | of which the mutation itself |
|---|---|---|---|
| save | 745ms | 745ms | 0ms |
| rename | 1415ms | 1414ms | 2ms |
| delete | 708ms | 708ms | 3ms |
| clean-checkout | 1033ms | 1018ms | 15ms |
| merge | 1046ms | 1027ms | 20ms |
| rebase | 1186ms | 1097ms | 89ms |
| **external-update** | **6317ms** | 1870ms | **4610ms** |
| restart | 1846ms | 366ms | 1485ms |

The excess is one transition, and within it the majority is the external `crib index` process's own
runtime (4.6s), not crib's adoption of the result (1.9s). Server boot dominates `restart` the same
way. Two legitimate resolutions, both product decisions:

- **optimize** the external-update adoption path and server boot, and rerun the same workload; or
- **revise the clock definition** in the policy — start it when the mutation completes on disk —
  which is a deliberate change producing a new policy hash and requiring every receipt to be
  recollected under it.

What is *not* legitimate, and was not done: adjusting the target after seeing the number.

### 2. Native service acceptance was never run — `receipt-not-passing:native-service:not-run`

Installing a launchd/systemd/Windows service agent changes the operator's machine, so it was not
performed unprompted. The OS-level install/start/restart/stop cycle with interrupted workers, long
synchronous revalidation and no-lease-takeover assertions remains open on all three platforms.

### 3. Twenty-one client/platform cells have no vendor runtime evidence

`client-cell-uncertified:` × {claude, copilot, cursor, codex, windsurf, gemini, vscode} ×
{darwin, linux, win32}.

Every one requires the vendor application, an account, and a host of that platform: install the
candidate package in an isolated profile, launch the real client, prove the MCP handshake and tool
use, record a uniquely tagged authorized memory, interrupt and restart, recover the session, and
verify foreign-principal exclusion. **No amount of code closes these** — the plan says so explicitly,
and protocol harnesses, config files and firing hooks do not substitute for a vendor run. WSL does
not satisfy a native Linux or Windows cell.

### Not a blocker in this report, but still unexecuted

The six CI OS/Node cells (`ubuntu|macos|windows-latest` × Node 22/24) are wired and their contract is
tested, but they have not run on real runners from this machine — this local evidence covers
darwin/arm64/Node 22 only. The aggregate decision requires all six by name, so a tag build will
block until they exist.

## Evidence

`~/crib-launch-evidence/2026-09-09-go/` (outside tracked source):

| Artifact | sha256 |
|---|---|
| `release-evidence-final.json` | `a32cf5228cfef183c52e0599c855013a997f4fe5beb51f77a5cd80051be9dbef` |
| `receipts/install.json` | `a4256f23ac4e8a585d65d8faa0bd188b7eedfd9147be31778f3f897fd7897383` |
| `receipts/browser.json` | `fa90c3119246c58d2b8079ac40fc4b9f59390fa6f27cad1c7a7462055eff37e0` |
| `receipts/freshness.json` | `c4a379ef9e8926ead2c01df5aa870b4fdd50fb91c5ad29a1662d250950ebba52` |
| `receipts/recovery.json` | `7c015108bddd96e7cb14e942944ed2a4ae16f1bcddad8351814a641a476d02c5` |
| `receipts/security-privacy.json` | `99e3a3cd1077aaf29936ca9a76381fcc1b8bf95e63e399e95d9bad4c306057c7` |
| `receipts/adapter.json` | `0cf26798e83ed38bb3811bdf1322bad0339c43fa838e169472ca04ecb50bbaa7` |
| `receipts/native-service.json` | `0aaf28e2524591f39c1a0ca4a86faf276d0454ca3a7cf2f44d759e8a67a340c0` |
| `launch-decision-final.json` | the decision printed above |

Plus the raw logs each receipt hashes: `install-cycle.log`, `browser-acceptance.log`,
`freshness-final.log`, `recovery.log`, `adapter.log`, `security-privacy.log`,
`workspace-tests.log`, `workflow-rehearsal.log`, `support-bundle-darwin.json`.

Reproduce:

```bash
node scripts/release-evidence.mjs --out /tmp/e.json \
  --package dist/installers/knowledge-crib-0.1.0/knowledge-crib-0.1.0.tgz \
  --receipts ~/crib-launch-evidence/2026-09-09-go/receipts \
  --require-runtime-certification --certification-platforms darwin,linux,win32
node scripts/launch-decision.mjs --evidence /tmp/e.json \
  --candidate-commit 536d9ea6b20627dae72779b7cbd1d4846ceea099
```

## The path to GO

1. Run the six CI OS/Node cells on real runners; each writes its own typed receipts and its cell
   manifest, and the aggregate binds them to one candidate.
2. Decide the freshness question — optimize, or revise the clock with a new policy hash and
   recollect. Either way, rerun the frozen workload on macOS, Linux and Windows.
3. Run the native-service cycle on each supported OS.
4. Certify the 21 vendor cells on real hosts with real client applications.
5. Re-run this decision. It prints GO only when every mandatory condition is proven, and it has been
   demonstrated to fail on each one individually.

Until then the honest state is **NO-GO**, and the machinery that says so is now the part that cannot
be talked out of it.
