# Requirements-to-evidence register — developer launch

Every requirement in the launch plan receives an identifier, the subsystem responsible for it, the
regression scenario that proves it, and the release gate the evidence must be attached to. This
register is the traceability spine of the release: a requirement without a scenario or a gate is an
open blocker, never an assumption.

Conventions:

- **Status** — `done` (evidence exists), `in-progress`, `open` (no evidence), `blocked` (needs an
  environment or dependency).
- **Evidence location** — receipt/artifact paths live OUTSIDE the tracked checkout
  (`~/crib-launch-evidence/<candidate-date>/…`, plus CI run URLs). An evidence run must never dirty
  the source checkout it certifies.
- **Gate names** — `ci-matrix` (`.github/workflows/ci.yml` platform matrix), `release-gate` (canonical
  ubuntu/Node-22 job), `installer` (`.github/workflows/beta-installers.yml` + `scripts/install-smoke*`),
  `retrieval` (frozen G1–G8, see §3 of the plan), `evidence-schema` (`scripts/release-evidence.mjs`,
  WP9), `cert-<client>` (WP8 runtime receipts).
- The frozen retrieval gates G1–G8 are unchanged and apply to every recall-claiming requirement.

## WP0 — Reproducible release candidate

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP0.1 | In-progress adapter changes preserved and verified | `packages/cli/src/adapters.ts`, `adapters.test.ts`, `cli.ts` | `packages/cli` suite green with the changes present (410/410 observed 2026-09-08) | release-gate | in-progress |
| WP0.2 | Durable intake created for launch-plan execution; drift validated | crib memory intakes | `memory handoff` + intake checkpoint at each milestone | — | done |
| WP0.3 | Candidate commit, versions, Node, model state recorded | evidence dir (outside checkout) | `wp0-baseline.txt` regenerated per candidate | evidence-schema | done |
| WP0.4 | Requirements-to-evidence register exists | this file | register reviewed at each milestone exit | evidence-schema | in-progress |
| WP0.5 | Windows `spawnSync npm ENOENT` reproduced + classified | `packages/cli/src/embed-onnx.ts` | `installOnnxRuntime` on a PATH without `npm(.cmd)` shim → structured failure (CI windows cells; unit test with stubbed runner) | ci-matrix (windows 22+24) | reproduced (CI run 34160275908) |
| WP0.6 | Windows installer smoke cannot resolve `crib` reproduced + classified | `scripts/install-smoke.mjs` | installer smoke run on windows-latest | installer (windows) | reproduced (CI run 34160275995) |
| WP0.7 | Ubuntu Node 24 real-PDF regression reproduced + classified | `packages/pipeline/src/multimodal/adapters.ts` | `cli index --multimodal` on a real minimal PDF under Ubuntu/glibc Node 24 | ci-matrix (ubuntu 24) | classified, NOT locally reproduced (CI run 34160275908; 5/5 isolated passes + full-suite pass in the exact Docker cell) |
| WP0.8 | Product vs harness failure separation (captured argv, exit code, sanitized stderr) | evidence dir | per-failure classification notes | evidence-schema | in-progress |
| WP0.9 | Regression workload + measurement procedure frozen before improvement claims | `docs/bench/` + evidence dir | bench procedure doc dated before first improvement measurement | retrieval | open |

## WP1 — Installation and semantic provisioning

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP1.1 | Shared, tested package-manager launcher replaces bare `npm` | `packages/cli/src/pkg-manager.ts` (new) | unit: resolution from `process.execPath`; no shell strings; missing-CLI → repair action | ci-matrix | done (pkg-manager.ts + 13 unit tests; installOnnxRuntime rewired through runNpm) |
| WP1.2 | Launcher supports managed + ordinary Node installs | same | unit: corepack/npm_execpath/bundled-npm resolution matrix | ci-matrix | done (resolution matrix: npm-execpath/bundled/path-npm + pnpm-execpath rejection) |
| WP1.3 | Structured failure taxonomy (discovery/network/install/post-install) | same + `embed-setup.ts` | unit: each failure class distinct + machine-readable | ci-matrix | done (classifyNpmFailure taxonomy + post-install phase with delete-and-reinstall repair) |
| WP1.4 | Windows installer verifies via absolute executable path | `scripts/install-smoke.mjs` | installer smoke on windows-latest | installer (windows) | fix landed (node <prefix> entry via Join-Path, never bare `crib`); windows-latest smoke pending |
| WP1.5 | Windows: process env updated for immediate availability; new-shell discovery verified separately | installer scripts | smoke asserts both env-inheritance and fresh-shell PATH | installer (windows) | fix landed ($env:Path prepend, mac PATH case-guard); windows-latest smoke pending |
| WP1.6 | PATH + client config preserved; spaces/non-ASCII user dir exercised | installer scripts | install/reinstall/upgrade/uninstall under `Users/jöhn doe/`-style dir | installer (all OS) | done (`installer:smoke-userdir` — new `smokeUserDirInstall` mode in scripts/install-smoke.mjs relocates HOME+USERPROFILE+npm prefix to `Users/jöhn doe` (space AND non-ASCII) and runs the full cycle under it: installer script → bin invoked through its spaced path → `crib index`+`status` on a project also under the spaced home → `crib mcp install` whose embedded `command` must carry the spaced bin path verbatim → REINSTALL (bin in place, client config byte-identical) → UNINSTALL (`npm rm -g` leaves no crib files, client config PRESERVED byte-for-byte); unit assertions pin that every scenario path contains a space + non-ASCII byte and the env relocates both homedir sources; wired into beta-installers.yml on both macOS and Windows runners; verified locally on darwin (evidence: ~/crib-launch-evidence/2026-09-08/wp1-6-userdir-smoke.log); Windows leg pending the next CI run) |
| WP1.7 | Semantic model: consent (size, dir, identity) before download; noninteractive consent flags | `packages/cli/src/embed-setup.ts` | noninteractive without flag → `consent required` machine-readable | ci-matrix | done (SetupPlan.status machine-readable; --json consent exits 0; size/dir/identity on both consent stops; unit + CLI e2e test) |
| WP1.8 | Canonical distribution manifest pins model revision, tokenizer, deps, artifact hashes | `embed-setup.ts` + manifest | install verifies hashes; drifted artifact fails | retrieval (G-gates require the pinned model) | done (manifest v2 + optional `provisioning` block: weight cache hashed file-by-file incl. tokenizer, runtime deps pinned by installed version; verify refuses tampered/vanished weights, dep drift, empty pins, v1 manifests; 19 core + 22 cli unit tests; live re-pin of the real 2.1 GB cache verified end-to-end through smoke) |
| WP1.9 | Cache keyed by manifest hash + OS/arch/runtime; staged download published only after integrity + inference checks | embed home layout | interrupted download → old model preserved; bad hash → no publish | ci-matrix | done (download fetches into a throwaway `.download-staging-` dir under the embed home and is published by a single rename only after the dim probe runs AND completeness holds — every file non-empty, ≥1 `.onnx`, `config.json`+`tokenizer.json` present; the previous model dir is moved aside and restored if the rename-in fails, so an interrupted/truncated fetch never half-replaces a working tier; staging is deleted in a `finally` either way; `runtime.platform` = `${platform}-${arch}` recorded in the WP1.8 pin and verified on every load so a copied embed home is refused up-front — "runtime platform drift … re-run crib embed setup" — instead of dying later inside a dlopen; 6 cli staged-download tests + 1 core platform-drift test; full suites 437/437 cli, 339/339 core) |
| WP1.10 | Offline bundle path follows same verification | embed setup | pre-provisioned bundle install offline | installer | done (`adoptOfflineBundle(home, bundle, onnxId)` — setup now passes the onnxId, so a `--from` bundle is copied into staging, run through the SAME `stagedModelProblem` completeness checklist as a network download, and published by the same atomic swap; an incomplete bundle is refused with the previous cache untouched; legacy no-onnxId whole-cache copy retained for cache relocation; 2 new tests — bundle adopted-and-copied, incomplete bundle refused w/ old model preserved) |
| WP1.11 | States `semantic-ready` / `lexical-only` / `installation-incomplete` / `invalid-model` distinct | `crib status`/`doctor` | each state reachable + reported | ci-matrix | done (`EmbedTierReport.status` derived ONCE in core `embedTierReport` (single truth source; renderers never re-derive) from tier + manifest + problems + a new `embedHomeFootprint` check — a manifest-less home with a non-empty runtime/models/adapters subtree is `installation-incomplete`, not `lexical-only`, because its remediation (re-run setup) differs from a fresh machine's; both `crib embed status` (`state:` line) and `crib doctor` (state-specific fix hints) render it; 6 new core tests covering all four states + footprint-vs-empty-dir edge, 1 CLI e2e asserting lexical-only + installation-incomplete through the real dist binary) |
| WP1.12 | Node 24 PDF defect fixed; real-PDF assertion kept | `packages/pipeline/src/multimodal/adapters.ts` | the G5.3 e2e test green on ubuntu Node 24 | ci-matrix (ubuntu 24) | diagnosability hardening landed (child exit+stderr+stdout in failure); deterministic repro absent — watch next CI run |

## WP2 — Adapter repair and truthful onboarding

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP2.1 | Nested hook-matcher shape + legacy migration | `adapters.ts` + `cli.ts` (committed ea997a8f) | install on malformed flat file repairs without duplicates; both shapes listed/removed | release-gate | done (verify runtime) |
| WP2.2 | SessionStart/Stop/PostToolUse exercised in real Claude runtime | live session evidence | lifecycle captures appear (observed this session) | cert-claude-code | done |
| WP2.3 | Idempotent install, selective removal, user-config preserved | adapters | repeated install → no duplicate managed entries | release-gate | done (acceptance e2e in cli.test.ts: second full setup pass reports up-to-date and leaves every file byte-identical; exactly one managed block per instruction file, one capture-hook entry per event bucket, one server table per MCP config) |
| WP2.4 | Malformed crib-owned entries detected + located, never overwritten | adapters | fixture with ambiguous user config → report, no write | release-gate | done (hooks lane: refusal names `hooks.<Event>[<index>]`, marker scan covers every event bucket not just crib's three; instruction lane: orphan begin marker refusal names the line instead of reading as "up to date"; 3 new unit tests, all refusals byte-unchanged-file asserted; verified through built CLI) |
| WP2.5 | Separate states: config-written / client-detected / MCP-connected / runtime-certified | adapters + doctor | install report distinguishes four states | cert-* (all) | open |
| WP2.6 | Doctor: missing binary, invalid config, unavailable model, inactive freshness, pending migration reported independently | `crib doctor` | fixture per condition → distinct diagnosis | release-gate | open |
| WP2.7 | No "instructions say mandatory" treated as runtime proof | doctor/report copy | report shows runtime evidence columns | cert-* | open |

## WP3 — Principal-scoped memory and prior-session recovery

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP3.1 | Principal identity resolved at trusted boundary; one server session ID per process | `packages/mcp` handlers | two clients in one process share session id; caller-supplied ids are provenance only | retrieval G7 | open |
| WP3.2 | Trusted caller context required in handoff projection | mcp memory handoff | missing principal → explicit error, never all-events | retrieval G7 | open |
| WP3.3 | Authorization before projection (filter before counts/pagination/hashes/previews) | mcp + memory ledger | shared-journal fixture: A never sees B's counts/artifacts | retrieval G7 | open |
| WP3.4 | Current server session excluded from `lastSession`; deterministic tie-break | mcp handoff | bootstrap session never returned as previous work | retrieval G7 | open |
| WP3.5 | Legacy unscoped records: default migration principal only | memory ledger | foreign principal sees no unscoped legacy data | retrieval G7 | open |
| WP3.6 | Resume drift comparison (HEAD/branch/dirty digest) + explicit selection | intake resume | drifted checkpoint → caution + selection required | release-gate | open |
| WP3.7 | Completed/cancelled intakes excluded from resume lists/counts; ≤20 changed paths + truncation | intake/handoff | multi-intake fixture; >20-path truncation metadata | release-gate | open |
| WP3.8 | Unreadable journal → explicit degraded state | handoff | corrupt journal fixture | release-gate | open |

## WP4 — Freshness coherence

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP4.1 | One serialized refresh coordinator per serving process | `packages/core` + `pipeline` | concurrent triggers coalesce to one refresh | release-gate | open |
| WP4.2 | Startup compares indexed HEAD vs current; never initializes away mismatch | serve/watch | indexed-behind fixture not silently adopted | release-gate | open |
| WP4.3 | Dirty fingerprint includes file CONTENTS (identical paths, different edits) | freshness worker | same-path-different-content fixture detected | release-gate | open |
| WP4.4 | Candidate snapshot (graph+FTS) invisible until generation agreement + source recheck | snapshot publication | build-across-change → discard + reschedule | release-gate | open |
| WP4.5 | Reader bundle pinned per request; old bundles retired after use | reader | active reader survives publication swap | release-gate | open |
| WP4.6 | Last-good bundle preserved on failure | reader | parse/git/build failure → previous bundle serves | release-gate | open |
| WP4.7 | `ReaderFreshness` interface in CLI JSON, MCP health, Memory Home | status paths | schema field presence + `staleReasons` accuracy | evidence-schema | open |
| WP4.8 | Watch overlay stays ephemeral; watching never dirties committed graph | serve --watch | overlay-only run leaves committed graph clean | release-gate | open |

## WP5 — Renewable leases during synchronous work

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP5.1 | Synchronous revalidation in child process; supervisor owns renewal | worker/queue | child runs longer than busy window; supervisor retains lease | release-gate (subprocess test) | open |
| WP5.2 | Child passes task id + repo state + fencing epoch; publication fenced | worker | lease loss → child result rejected | release-gate (subprocess test) | open |
| WP5.3 | Supervisor death → orphan child cannot activate staged results | worker | kill supervisor → child exits without publishing | release-gate (subprocess test) | open |
| WP5.4 | Recovery at-least-once with idempotent publication; bounded retries + dead-letter | worker | crash mid-task → replay publishes once | release-gate (subprocess test) | open |
| WP5.5 | Cancellation: stuck task cancellable; old task cannot publish afterward | worker | cancel → old task's publish refused | release-gate (subprocess test) | open |
| WP5.6 | launchd / systemd user service / Task Scheduler install, start, restart, status, uninstall | `crib service` | per-OS service receipts (XML encoding, quoting, abs paths) | installer (per OS) | open |

## WP6 — Memory Home workflows

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP6.1 | Paginated authorized pending queue (subject, claim, scope, evidence, trust, blockers) | `packages/ui` + local server | browser test vs isolated backend | browser suite | open |
| WP6.2 | Raw captures vs admission-ready candidates separated; provider consent preserved | ui + distill | browser test | browser suite | open |
| WP6.3 | Admission via same domain services as CLI; no tty fabrication | ui server routes | browser admission of supported candidate; terminal-only → explanation + command | browser suite | open |
| WP6.4 | Intake detail + resume without executing work; History-only completed/cancelled | ui | resume appends event; no shell execution | browser suite | open |
| WP6.5 | Local mutation boundary: CSRF token, origin validation, revision precondition, idempotent duplicates, structured errors, no secrets in URLs/logs | ui server | unauthorized/stale/duplicate submissions | browser suite | open |
| WP6.6 | Accessibility: 390px + desktop, focus management, Escape, keyboard completion, announcements, empty/degraded states | ui | a11y browser checks | browser suite | open |

## WP7 — Persistence, recovery, sync preview

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP7.1 | Durable ack points for capture/admission/checkpoint | memory stores | ack-after-persist asserted | release-gate | open |
| WP7.2 | Crash tests: partial trailing journal write, replay, interrupted projection rebuild | journal + projections | crash-recovery suite (subprocess) | release-gate (recovery suite) | open |
| WP7.3 | Malformed interior records rejected/quarantined explicitly | journal | corrupt-interior fixture | release-gate | open |
| WP7.4 | Derived indexes rebuildable from intact journals; recovery idempotent | rebuild path | repeated recovery no-op | release-gate | open |
| WP7.5 | Backup/export/restore for authorized local + global stores | backup commands | restore round-trip | release-gate | open |
| WP7.6 | Memory survives client removal, uninstall, schema migration | adapters + installers | uninstall-with-memory fixture | installer | open |
| WP7.7 | Sync preview: v3 records, scopes, tombstones, interrupted transfer, replay, divergence, key/scope mismatch fail-closed | sync engine | sync preview suite; no implicit sharing | release-gate | open |

## WP8 — Client certification

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP8.1 | Isolated per-client runtime certification (7 clients × advertised OS cells) | cert harness + receipts | remember → interrupt → restart → authorized resume per client | cert-<client> per cell | open |
| WP8.2 | Receipts: version, commit, package digest, client version, OS/arch/runtime, scenario results, sanitized hashes, separate config/protocol/runtime verdicts | evidence schema | receipt validation passes | evidence-schema | open |
| WP8.3 | Copilot-shaped test client labelled protocol evidence only; WSL labelled WSL | cert harness | labels enforced in matrix generation | evidence-schema | open |

## WP9 — Complete, enforceable release evidence

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP9.1 | Versioned evidence schema, strict validation (dirty===false, valid commit, hashes, schema versions) | `scripts/release-evidence.mjs` | tamper/omission/duplicate → validation fails with diagnostic artifact | evidence-schema | open |
| WP9.2 | Exactly G1–G8 frozen gate set; model revision + scorer identity required | evidence schema | missing gate → fail | evidence-schema | open |
| WP9.3 | Platform/install/native-service/browser/recovery/adapter receipts required | evidence schema | per-receipt-type requirement | evidence-schema | open |
| WP9.4 | Logs uploaded on failed jobs too; matrix aggregated into ONE launch decision | CI workflows | failed-job artifact presence; ubuntu success alone insufficient | evidence-schema | open |
| WP9.5 | Generated capability matrix rendered from receipts; runtime-verified impossible without passing receipt | matrix generation | receipt removal flips state | evidence-schema | open |

## WP10 — Operational readiness and documentation

| ID | Requirement | Subsystem | Regression scenario | Gate | Status |
|---|---|---|---|---|---|
| WP10.1 | Diagnostics: refresh state, adoption lag, retries, dead letters, model readiness, last failure; redacted support bundles | CLI diagnostics | diagnostic output includes all fields; bundle redaction asserted | release-gate | open |
| WP10.2 | Guided repairs (broken config, missing model, stale index, inactive service) | doctor | per-condition repair guidance | release-gate | open |
| WP10.3 | Docs: upgrade/rollback/backup/uninstall-with-memory; precise support matrix; onboarding journey; copy distinctions | docs | docs walkthrough against installed candidate | evidence-schema (docs receipt) | open |
| WP10.4 | Performance: startup, warm query, incremental refresh, idle, peak memory on reference workload; p95 ≤ 5s enforced; leak checks after repeated refresh | bench suite | preregistered procedure (WP0.9) | retrieval (scale gates) | open |
| WP10.5 | Dated, source-linked competitive comparison (Mem0, GitNexus, Letta); no unsupported superiority claims | docs/launch/comparison.md | claims resolve to sources | evidence-schema | open |

## Failure classification (WP0.5–WP0.8 evidence)

Observed 2026-09-07 in CI run 34160275908 (candidate `15e678c3`; current candidate `ea997a8f` is its
direct child and does not touch these paths):

1. **windows-latest Node 22 & 24 — `runtime install failed: spawnSync npm ENOENT`** — PRODUCT
   failure. `installOnnxRuntime` (`packages/cli/src/embed-onnx.ts:358`) invokes the bare command
   `npm` via `execFileSync`; on Windows the executable is `npm.cmd` and spawnSync without
   `shell: true` cannot launch `.cmd` shims. Fix tracked as WP1.1–WP1.3.
2. **ubuntu-latest Node 24 — G5.3 real-PDF e2e, `expected 1 to be +0` at `cli.test.ts:1358`** —
   PRODUCT failure. The failing assertion is `expect(r.status ?? 1).toBe(0)`: the
   `crib index . --multimodal --json` child process exited 1 on ubuntu Node 24, before any report
   assertions ran. The earlier hypothesis (`ingest.dropped === 1`) was wrong — a standalone unpdf
   1.8.1 `extractText` repro extracts both pages fine on Linux Node 24, and `ingestStaging` cannot
   drop a file whose segments were extracted. The full in-container repro (WP0.7) did NOT reproduce
   it: node:24 (Debian bookworm, glibc 2.36) passes the whole 410-test suite; ubuntu:24.04 (glibc
   2.39, the exact CI cell) + official Node 24.20.0 shows 43 failures across 6 files under Rosetta
   emulation, but the G5.3 multimodal test is NOT among them, and the 43 are confounded by
   emulation timing (~2–5× slowdown; CI had exactly 1 failure). A 5× single-test rerun of G5.3 in
   that exact cell (isolated in-container copy, no bind mount) PASSED 5/5, and the G5.3 test is
   green in every faithful-environment attempt made (6 total). Honest classification: NOT a
   deterministic product defect in the ubuntu-24.04/Node-24.20 cell — CI-cell-specific or flaky
   (candidate mechanisms: cross-test interference under CI's parallel vitest workers, runner-specific
   unpdf/uv behaviour under load). Passes on macOS Node 22, macOS Node 24.20, and ubuntu Node 22.
   WP1.12 therefore hardens for diagnosability first: the test now throws the child's exit code,
   stderr and stdout tail on failure, so the next CI occurrence is explainable from the log alone.
3. **windows-latest installer smoke — cannot resolve `crib`** — PRODUCT failure
   (WP0.6, reproduced from the smoke harness by reading `install-smoke.mjs` against the generated
   `install-windows.ps1`): the installer ran the bare command `& crib setup .` at
   `install-windows.ps1:92`, a PATH lookup in the installer's own process. The smoke deliberately
   installs into an isolated npm prefix (`npm_config_prefix` = tmpdir) that is never on the current
   process PATH, so `crib` could not resolve — `The term 'crib' is not recognized`
   (CommandNotFoundException). Any real user with a custom npm prefix hits the same defect. The
   macOS installer carried the identical latent bug but failed SILENTLY (`|| echo` swallowed the
   nonzero exit), so the mac smoke passed while setup never ran. Fix tracked as WP1.4–WP1.5.