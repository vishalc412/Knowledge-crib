# Production readiness re-audit — 2026-09-09

**Decision: NO-GO for the promised production developer launch.**

Candidate: `9da78653a3b2e52dbc6899b5a1a532567dfa4533`, branch `debug/auditMaster`, clean at verification. Product-change comparison: `cd3b3262...9da78653` (47 files). The audit also probed pre-existing code on critical launch paths. No product code was modified.

Launch scope remains one owner's local/global memory across supported repositories and agents on one device. Cross-device sync remains preview. Hosted tenancy, SSO and team management are excluded. No scope reduction is assumed to obtain GO.

## Fresh verification

| Check | Actual result | Limit |
|---|---|---|
| Workspace build | PASS | macOS arm64, Node 22.23.1 |
| All workspace tests | 2,976 passed across 208 test files | Existing tests do not cover all probes below |
| Biome | PASS, 594 files checked | Prior to adding audit documents |
| Real-backend browser suite | 8/8 passed | Chromium, desktop and 390px; not all vendor-client UIs |
| Focused persistence/session/sync | 92/92 passed | Included in workspace total; not additional unique tests |
| Focused watch/coordinator/child/crash | 44/44 passed | Included in workspace total |
| Evidence/schema/matrix tests | PASS | Negative audit probes expose missing assertions |
| Docs-site and generated client matrix checks | PASS | Generated consistency does not establish runtime certification |
| Strict semantic release evidence | **FAIL: runtime-certification** | All G1–G8 passed; 21 client/platform cells absent |
| Current-candidate remote matrix | **Not established** | Latest inspected CI run is for older `f606f3e1` |

Fresh semantic measurements: G1=1; G2=0.8104575163 against ≥0.80; G3=0.8814 against ≥0.75; G4=1; G5=0; G6=0; G7=0; G8=1. Supported scorer: `memory-rank-v2:multilingual-e5-large-1024-sym:cosine:semantic-only`.

Evidence archived at `/Users/vishalchawla/crib-launch-evidence/2026-09-09/`: `crib-reaudit-strict-evidence.json`, `crib-reaudit-semantic.log`, `crib-reaudit-build.log`, `crib-reaudit-tests.log`, `crib-reaudit-browser.log`, `crib-reaudit-lint.log`.

The strict collector and decision CLI returned NO-GO. Their blocker list contains all seven clients × darwin/linux/win32. A prior local release-green checkpoint does not supply these receipts. [Latest inspected remote CI](https://github.com/vishalc412/Knowledge-crib/actions/runs/34240835403) failed on older docs statistics; current docs consistency now passes locally, so that old failure is not reported as a current regression.

## Confirmed findings

### A01 — P1: the decision reader accepts incomplete or inconsistent evidence

`scripts/release-evidence.mjs:215` checks red entries and a nonempty failure list, but does not require the exact G1–G8 set on read or revalidate clean-commit/model prerequisites. `scripts/launch-decision.mjs:7` makes certification conditional on the manifest's own `required` switch.

Independent in-memory probes through `buildReleaseEvidence`, `validateReleaseEvidence` and `evaluateLaunchDecision` returned **GO** for: ordinary non-certifying evidence; a green manifest with `gates=[]`; a green manifest changed to `git.dirty=true`; and a green manifest with `retrieval.model={}`. Each probe used a fresh cloned fixture. This does not mean the honest collector creates those malformed cases; it means the reader fails its stated adversarial/omission checks and ordinary verification can be mistaken for launch approval.

Required repair: derive launch eligibility from validated facts and an external release policy. Missing, unknown, skipped, stale or mismatched requirements must block. A non-certifying verification result must never be called production GO.

### A02 — P1: certification is not bound to the candidate artifact

`scripts/client-certification-evidence.mjs:244` counts only client/OS runtime-pass pairs. `scripts/release-evidence.mjs:73` accepts this coverage without comparing receipt product commit/package digest with the candidate. A builder probe with all 21 receipt summaries for commit B produced GO for candidate A. This probe targets candidate matching after receipt loading; artifact existence/hash checks in the loader are separate and do not close the mismatch.

Required repair: require the exact candidate commit, package digest, supported client version, platform and trusted evidence origin. Preserve enough receipt information in the manifest to revalidate rather than trusting a precomputed missing-cell list.

### A03 — P1: release publication does not depend on aggregate approval

`.github/workflows/release.yml:126` declares `release.needs: verify`, not the aggregate `launch-decision`. Publishing can proceed while aggregation fails. At line 122 the aggregator is invoked without expected cells; a one-cell green fixture produces aggregate GO. It also does not bind all supplied manifests to one candidate.

Required repair: enforce required OS/Node cells and shared artifact identity; make publication depend on both verification and successful aggregate decision. A failed/missing aggregate must prevent publishing in workflow-level tests.

### A04 — P1: installation can overwrite existing client configuration

`packages/cli/src/mcp-install.ts:114` returns `{}` when an existing JSON config cannot be parsed; lines 329–331 merge and write over it. Isolated reproduction: an existing `.mcp.json` containing another server plus a JSON comment was diagnosed as unparseable, then replaced with a Knowledge Crib-only configuration. This is a pre-existing defect still contradicting the launch non-clobber guarantee.

Required repair: distinguish missing from malformed files; refuse malformed/unsupported content without writing. For client formats supporting JSONC, use a preserving parser/editor. Assert byte-for-byte preservation on every refusal.

### A05 — P1: freshness can claim current while state is unknown or generations differ

`packages/cli/src/refresh-coordinator.ts:114` and `:285` append `source-detection-unavailable` without setting stale. A missing-source probe returned `currentHead:null`, `stale:false`, and that reason.

The live reporter at `:252` never compares published and reader generation IDs. Reproduction: retain reader A, publish edited B, revert source to A before releasing the request. Health reports idle, stale=false, no reasons, while the two generations differ. This violates the explicit generation invariant.

Required repair: unavailable source state is unknown/stale; generation mismatch is stale until adoption. Test both API output and live health consumers.

### A06 — P1: new installer assertions are not Windows-safe

`scripts/install-smoke.test.mjs:188` and `:192` require `records/…jsonl`. `scripts/install-smoke.mjs:325` uses native `path.relative`, producing `records\…jsonl` on Windows. A deterministic `path.win32.relative` probe fails the regex. This is a concrete cross-platform harness defect, not an observed failure from a current Windows runner.

Required repair: normalize digest keys to a portable separator or compare components; run actual Windows Node 22/24 tests and installer cycles.

### A07 — P2: malformed FTS metadata escapes recovery

`packages/memory/src/persistent-fts.ts:248` reads `Object.keys(meta.stores)` without validating its shape. Replacing a valid snapshot's metadata with `{"formatVersion":1}` causes reopening/search to throw `Cannot convert undefined or null to object`, instead of rebuilding disposable state from canonical shards.

Required repair: validate the whole metadata shape before reuse; rebuild on invalid shape; assert canonical memory stays intact and searchable.

### A08 — P2: superseded pending reader bundles are not disposed

`packages/cli/src/refresh-coordinator.ts:399` replaces the published bundle without closing a previously published but unadopted index. Reproduction with instrumented close calls: retain A, publish B then C, release and close coordinator → A closed, B unclosed, C closed. Native resources remain undisposed until garbage collection; this audit does not claim a measured long-run leak rate.

Required repair: close superseded unowned bundles while retaining pinned/current bundles until their readers finish. Stress-test bounded resource ownership.

### A09 — P2: doctor misses a missing MCP JavaScript entry point

The fallback at `packages/cli/src/mcp-install.ts:237` stores Node as command and `cli.js` in args. The doctor check at `:522` verifies only the command. An existing Node binary plus nonexistent `cli.js` yields no audit errors. Moving/removing a checkout can leave an unusable adapter marked usable.

Required repair: validate both interpreter and the generated entry-point argument; preserve client-owned launch commands.

## Evidence and operational gaps

- **Runtime certification:** no accepted vendor-client receipts in the configured directory. All 21 advertised cells remain open. Protocol simulators, hooks firing, and config files do not certify record→interruption→authorized resume.
- **Freshness acceptance:** current convergence tests often invoke the coordinator directly. The existing six-sample p95 test overrides fallback to 250ms instead of production 2000ms and checks dirty-path capture, not successful query/FTS/context adoption. A default-configuration, preregistered workload gate is still needed.
- **Receipt completeness:** WP9.3 does not require distinct install, native-service, browser, recovery and adapter evidence. A release manifest currently does not prove the entire release workflow completed after its generation.
- **Operations:** redacted support bundles, full guided-repair acceptance and installed-candidate documentation walkthrough remain incomplete. The register is an input to review, not evidence by itself.
- **Cross-device durability:** passing v3/scoping/tombstone tests supports preview development; it does not establish production offline-divergence and interrupted-transfer behavior across devices.
- **Local project state:** status reports freshness mode explicitly manual, worker last-known-good behind current HEAD, and 103 stale plus one ungrounded semantic graph artifact. The canonical index HEAD matches the candidate. These are distinct states; neither semantic recall PASS nor canonical HEAD agreement certifies all optional enrichment current.

## Competitive positioning

The existing `docs/launch/comparison.md` still makes broad “only tool” and superiority statements. Its memory table lacks current per-claim citations and omits GitNexus from the required comparison. These are launch-copy defects, not retrieval defects.

- Mem0 documents self-hosted and offline/local options; presenting it as categorically requiring hosted service/API keys is incomplete. [Mem0 OSS overview](https://docs.mem0.ai/open-source/overview), [local companion configuration](https://docs.mem0.ai/cookbooks/essentials/building-ai-companion).
- GitNexus documents graph-based code intelligence, MCP tools, editor setup and hooks. MCP plus local code graphs alone does not establish a unique advantage. [GitNexus primary repository](https://github.com/abhigyanpatwari/GitNexus).
- Letta documents persistent editable memory blocks that agents can share. Broad neutrality/persistence superiority needs narrower evidence. [Letta SDK memory documentation](https://docs.letta.com/api/typescript).

Knowledge Crib's credible positioning is the combination of a repository-grounded memory ledger, explicit evidence/freshness semantics, local/global scope and code context. This audit establishes no head-to-head performance superiority. Sources were checked on 2026-09-09; no competitor tool was installed or used for repository context.

## Exit decision

Keep **NO-GO** until A01–A09 are resolved and the required candidate-specific evidence is complete. The existing clean local suites are a useful foundation. They do not waive functional defects or external acceptance tests. Execute the companion [actual-GO implementation plan](../../superpowers/plans/2026-09-09-actual-production-go.md).
