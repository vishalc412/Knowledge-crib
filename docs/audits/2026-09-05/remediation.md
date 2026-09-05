# Remediation record — 5 September 2026 launch audit

**Companion to** [launch-audit.md](launch-audit.md). The audit is a dated artifact and is not
rewritten here; this file records what has since been repaired, what evidence establishes it, and
what remains open. Evidence labels reuse the audit's convention (**R** reproduced, **S** source).

**Verification baseline:** branch `debug/auditMaster`, macOS, Node 22.23.1, `corepack pnpm@9.15.0`.
Re-run artifacts are in [evidence/remediation](evidence/remediation/).

**Status of the launch decision: unchanged.** Six findings are closed with reproductions; the audit's
broader gates — three-OS installer acceptance, the full-repository 50-sample watch gate, a fresh
machine semantic acceptance run, the sync soak, and an independently authored holdout — were **not**
performed here and still gate a broad launch.

## Whole-suite state

| Check | Audit (5 Sep) | Now | Evidence |
|---|---|---|---|
| `corepack pnpm@9.15.0 verify` | PASS, 2,585 tests | **PASS, 2,622 tests** | [verify-after.log](evidence/remediation/verify-after.log) |
| `capabilities:check` | **FAIL** (docs 41 vs runtime 46) | **PASS** | [capabilities-after.log](evidence/remediation/capabilities-after.log) |
| `pack:check` | PASS, but covered 7 of 8 packages | **PASS, 8/8** | [pack-after.log](evidence/remediation/pack-after.log) |
| `security-doc-check.mjs` | PASS while asserting a false "stdio-only" claim | **PASS against the corrected inventory** | see F14 |
| Production dependency audit | 16 advisories (7 high, 8 moderate, 1 low) | **0 advisories** | [dependency-audit-after.json](evidence/remediation/dependency-audit-after.json) |
| Real stdio MCP smoke | PASS, 16 tools / 29 calls | **PASS, 16 tools / 29 calls, 0 verb errors** | re-run |

## Closed findings

### F01 — P0: memory-3 records broke ordinary search — **closed (R)**

`effectiveVerdicts`, `recordPrincipalId`, and every sibling schema branch recognized only memory-2
before falling into the memory-1 path and reading fields a v3 envelope does not carry. The union
type and its guard (`MemoryRecordVersioned` / `isMemoryRecordVersioned`) are now used across
`packages/memory`, `packages/mcp/src/verbs.ts`, and `packages/cli/src/cli.ts`. Two consequences were
found while propagating it, beyond the reported crash:

- `memoryGet` and `memoryView` emitted a hardcoded `schemaVersion: '2'`; they now report the
  record's own version, so a v3 record is no longer mislabelled to a client.
- The private-visibility leak scan (`cli.ts`) narrowed on v2 only, so a **private v3 record would
  not have been reported by the shard privacy scan**. It now covers both envelopes.

The memory evaluator grounds memory-1 `appliesTo` locators, which v2/v3 do not carry; it is now
explicitly gated to v1 in `gatherAllVerdicts` rather than being handed a record whose fields it
would read as undefined.

**Reproduction:** the audit's own probe, `v3.search.ok: true` and `v3.ownPrincipalSearch.ok: true`
([reproduce-after.json](evidence/remediation/reproduce-after.json)). Regression tests cover get,
search, history, and audit projections for v1/v2/v3, owner and foreign principal.

### F02 — P0: concurrent writers lost acknowledged freshness work — **closed (R)**

The audit measured 44/39/34 acknowledged-but-missing entries across three trials, plus `ENOENT`
failures. The repair has three parts, and the third was the real defect:

1. `writeJsonAtomic` uses a unique temp name, removing the shared `queue.json.tmp` collision.
2. Every queue read-modify-write — `enqueueFreshness`, worker `claim`, retry/dead-letter, **and the
   worker-takeover recovery write that was still unlocked** — now runs inside one lock.
3. **`CribLock` did not actually provide mutual exclusion.** `isStale()` classified a *vanished*
   lock file as stale, and `steal()` then unlinked unconditionally before creating. Two contenders
   racing inside a holder's release window each deleted the other's freshly created lock and both
   entered the critical section. `acquire()` now re-races the atomic create for the vanished case
   and never unlinks there; a genuine stale reclaim removes the file only while it still carries the
   exact holder pid and mtime that was judged stale.

This matters beyond the queue: the same lock serializes the derived SQLite index writers.

**Reproduction:** the audit's probe reports `acknowledgedButMissing: 0` and `errorCount: 0` across
all three trials. A direct lock probe (8 processes × 25 increments of a non-atomic read-modify-write)
returned 195/200 before the fix and 200/200 after, across repeated runs.

**Regression tests:** `packages/core/src/lock-concurrency.test.ts` (asserted to fail — 195/200 — when
the lock fix is reverted) and `packages/cli/src/freshness-concurrency.test.ts`, which asserts both
halves of the contract: no call fails, and nothing acknowledged goes missing.

### F03 — P1: principal enforcement differed between recall and direct access — **closed (R)**

`MemoryApi.get` and `history` returned a foreign principal's private record that `gatherRecall`
excluded. The ownership decision is now applied on the `locate`/gather path shared by get, history,
and audit. The audit probe reports `getFound: false`, `historyCount: 0`, `gatheredCount: 0` for a
caller who is not the record's principal, while the owning principal still reads its own record.

**Scope, unchanged from the audit:** this closes an API isolation defect under a shared-store
configuration. It is not a multi-tenant authorization contract, and the deployment limit the audit
states still stands.

### F07 (part) — capability documentation drift — **closed (S/R)**

`docs/knowledge-crib-mcp-api.md` stated "16 tools / 41 operations" against a manifest deriving 46.
Every operation was checked to be individually documented already — the count alone was stale, so
correcting it to 46 is accurate rather than cosmetic. `capabilities:check` passes.

The broader F07 item — one release evidence manifest binding commit, schema versions, model
identity, scorer, platform and workload to pass/fail results, with required quality gates failing
the release job — **remains open**.

### F10 — package validation omitted the memory package — **closed (R)**

`pack-check` validated a hardcoded list of seven packages while eight are publishable. The set is now
**discovered from workspace metadata** (`scripts/workspace-packages.mjs`); `build-installers` keeps
its hand-ordered list (dependency order is not derivable) but asserts coverage against the same
discovery, so a new package cannot be silently omitted from either gate again.

Widening the gate immediately surfaced a real defect it had never been able to see: **`packages/memory`
declared `LICENSE` and `NOTICE` in its `files` field but contained neither**, so every published
tarball of that package would have shipped without its license texts. Both files are now present and
byte-identical to the other seven packages. `pack:check` reports `8/8 tarballs validated`.

### F13 — P0: the watched graph was not the query index — **closed (R)**

`cmdServe` passed the working overlay for graph reads while `query` still read the committed index,
so a saved edit never became discoverable. `Verbs` now resolves both through `codeSoul()` /
`codeIndex()`, and `crib serve --watch` builds an ephemeral FTS projection over the overlay.

**Reproduction:** the audit's watch probe, unchanged, on the same one-file fixture:

| | Audit | Now |
|---|---|---|
| Updates discovered within the window | **0 / 10** | **10 / 10** |
| Timeouts | 10 | **0** |
| p95 | 7,000 ms (timeout values, not latency) | **422 ms of genuine update latency** |

**This is the audit's diagnostic fixture, not the release gate.** The `<5 s` p95 target over ≥50
updates on a full reference repository, including branch transitions and recovery, is still
unmeasured and remains a launch gate.

### F14 — P1: HTTP transport was outside the security contract — **closed for the request boundary (R)**

`crib serve --http` had no Host/Origin allowlist and buffered request bodies with no cap; the audit
sent `initialize` with `Host: audit-untrusted.example` and received HTTP 200.

`isAllowedHttpCaller` now runs **before routing** (so `/health` cannot be probed cross-origin
either): the `Host` authority must be loopback or the host the operator deliberately bound to, and an
`Origin`, when present at all, must also be loopback — a non-browser client sends none, so a foreign
`Origin` is by construction cross-site. Bodies are capped at 4 MiB and the connection is destroyed
rather than buffered past the cap. `packages/mcp/src/http-boundary.test.ts` replays the audit's exact
request and asserts **403**, plus **413** for an oversized body.

`SECURITY.md` claimed a repo-wide search for `StreamableHTTPServerTransport` "returns zero hits" —
false since the daemon shipped. The network surface inventory now documents three surfaces, and
`security-doc-check.mjs` pins the corrected claims instead of the "stdio-only" assertion that kept it
green while an unguarded listener existed. The gate was verified to fail when the new claims are
removed.

**Explicitly not closed:** this is a **locality** boundary, not authorization. It does not identify
which local user is calling, and `verbs` remains shared across requests. The audit's instruction not
to expose this as a multi-tenant endpoint stands, and is now stated in `SECURITY.md` itself.

### F08 — dependency advisories — **closed for the advisory set; reachability triage still owed (R)**

Production `pnpm audit` went from 16 advisories (7 high, 8 moderate, 1 low) to **0**, via pinned
`pnpm.overrides` for `fast-uri`, `ip-address`, `hono`, `@hono/node-server`, and `qs`. The full suite
and every gate pass on the upgraded tree, so the bumps are behaviour-compatible here.

Worth noting for accuracy: the seven **high** advisories were all `fast-uri`, reached through our own
direct `ajv` dependency, which validates every memory record — a genuinely reachable path, not
unused HTTP middleware. The audit's remaining ask — a documented reachable-versus-unused analysis and
a dated exception register — is **not** delivered by this bump.

### F05 — P1: the semantic result was not the default experience — **closed for the install path; acceptance run still owed (R/S)**

The on-device tier was reachable only through a README ritual whose final step named
`examples/embedders/minilm-e5`, a path inside the git checkout that the published package does not
ship — so for an npm install the documented instructions could not be followed at all, and the
machine silently served the lexical fallback. `crib embed setup` now owns the adapter instead of
pointing at one:

- Python and `sentence-transformers` are verified against the **same interpreter** that will run the
  adapter, and the weights are probed **offline**, so a pass proves a later query needs no network.
- Nothing is downloaded without `--yes`, and `sentence-transformers` is never auto-installed even
  then — consent for a model download is not consent to mutate an interpreter. A stopped run prints
  the exact commands rather than reporting failure.
- Success is **not** reported until the installed model ranks a paraphrase above an unrelated
  sentence in-process. A dimension check passes for a model returning noise, and "installed but
  actually lexical" is the audited failure itself.
- Retrieval mode is stated explicitly on success, on failure, and by `crib serve` at startup.

**A correction made while wiring this up.** The model ladder carried `g2`/`gates` numbers for all
three models attributed to `docs/bench/embed-model-ladder.md` — **a file that does not exist in this
repository** — and two of those numbers disagreed with the figures that *are* committed
(`launch-gates.md` records 43.8% for e5-base; the R1 pre-registration records 45.0% for MiniLM on a
much smaller harness). Printing them in `--help` would have sold a measurement no reader can open.
Provenance is now a structural field: `large` is `gate-verified` with its citation, and the other two
rows are `unverified`, rendered as *"no gate run committed in this repository"*. A test asserts an
unverified row can never render as a measurement, and that the default is a gate-verified model.

**Not closed:** the fresh-machine semantic acceptance run. Completing it requires installing
`sentence-transformers` into the operator's interpreter and downloading ~2.2 GB of weights; both are
the user's decision, and neither was performed here. G2/G3 therefore still fail under the lexical
default, exactly as the audit reports.

### F06 — P1: freshness policy configured nothing — **closed (R)**

`crib serve` decided whether to watch purely from `--watch` in argv, while every generated client
config spawns a bare `crib serve <root>`. Selecting `watch` or `auto` therefore persisted a
preference that configured nothing: the user got a stale-on-save server with no signal, and the F13
repair could not reach a default install.

`serve` now reads the persisted mode (`shouldServeWatch`, extracted so the policy is stated and
tested in one place). `--watch` remains an explicit override for one-off runs and for unregistered
projects. Because the decision moved into the server rather than into generated arguments, **existing
installs pick it up on the next server start with no config regeneration**. Verified directly:

```
$ crib freshness watch
$ crib serve .          # no --watch flag, exactly as a client config spawns it
watch mode active (freshness mode watch) — 0 dirty file(s) overlaid
```

`serve` now also announces `manual` mode, because "why is my saved edit not showing up" is
unanswerable if the server never says it is not watching. `crib freshness <mode>` states what
actually changes and when.

**The "zero commit tax" claim is retired**, as the audit asked. The `auto` post-commit hook does
real, synchronous, now-locked work, so its cost is small but not zero. Measured on this build
**after** the F02 locking change (200 samples): **p50 0.246 ms, p95 0.333 ms, p99 0.397 ms, max
0.485 ms** ([commit-tax-after.json](evidence/remediation/commit-tax-after.json)) — the added locking
costs nothing measurable at commit time. Docs and tests now claim a measured bound rather than zero.

### F11 — P2: confident wrong edges — **closed for the reported defect (R)**

The audit found the `now` **parameter** of `enqueueFreshness` linked at confidence 1 to two unrelated
symbols. Two independent defects produced them:

1. **The TypeScript extractor collapsed call shapes.** `keys = [qualifiedName, name]` registered a
   class member under its bare name, so any `now()` in the file resolved to the property
   `FreshnessWorker.now`. Bare `foo()` and `this.foo()` are not interchangeable: a bare identifier
   can never reach a member, and it can never outrank a local binding. Resolution is now shape-aware,
   and a call whose name is bound locally (parameter, local var, nested function, destructured
   binding, catch variable) resolves to **nothing** — the target is a value this syntactic pass
   cannot follow, so an unresolved call site is the honest answer.

2. **The SQL resolver was not scoped to SQL.** `supports()` gates it on a SQL extension, but
   `resolve()` walked the entire soul — so one `.sql` file anywhere in the repo was enough for it to
   index TypeScript `function` symbols by bare name and emit the cross-file edges the TS resolver had
   deliberately refused to guess at. It is now scoped to SQL files. Its tie-break was also fixed:
   several same-named candidates resolved to `list[0]`, a confident edge chosen by index order;
   ambiguous names are now dropped.

The same query the audit ran now returns only the two real callees, and the unresolved `now` call
site is still recorded so the gap stays visible
([f11-context-after.json](evidence/remediation/f11-context-after.json)):

| | Audit | Now |
|---|---|---|
| Callees of `enqueueFreshness` | 5, incl. `FreshnessWorker.now` and `cmdMemoryDistill.now` at confidence 1 | **2, both correct** |
| `now` call site recorded | yes | **yes** (unresolved, not fabricated) |

Both fixes are pinned by tests asserted to FAIL when reverted. Note that a precision fix **removes**
edges; this is a deliberate trade of recall for honesty, on the audit's reasoning that an openly
unresolved call is safer than a confidently wrong one for blast-radius and rename planning.

**Not closed:** the broader F11 ask — independently labelled fixtures for callbacks, shadowing,
dynamic dispatch, overloads and framework injection, with edge precision/recall published per
resolution method and language. Property calls (`obj.foo()`) remain receiver-blind, which is a known
and separate limitation.

## Open findings

Unchanged from the audit and still gating a broad launch:

- **F04** — lifecycle capture still records event markers, not reusable outcomes.
- **F05 (remainder)** — the fresh-machine semantic acceptance run, and therefore the G2/G3 gates,
  which still fail under the lexical default. The install path is now supported; the measurement is
  not done.
- **F06 (remainder)** — a **supervised service**. `auto` still asks the operator to start the worker
  (or wire a service manager); crib installs no startup/restart/uninstall integration of its own.
- **F07 (remainder)** — the release evidence manifest and required-gate enforcement.
- **F09** — memory lifecycle UX (memory home, empty states, contrast/keyboard acceptance).
- **F11 (remainder)** — labelled precision/recall fixtures per resolution method and language;
  property calls remain receiver-blind.
- **F12** — recovery, retention, key rotation, and the sync soak.

## Honest limits of this record

Every claim above rests on the named re-run artifact. Not established here: a full `release:verify`,
published-package installation, three-OS acceptance, the all-client integration matrix, a
large-model semantic remeasurement, the 100k semantic workload, the full-repository 50-sample watch
gate, a 15-minute sync soak, power-loss durability, or a penetration test. Passing tests and green
gates are evidence about the checks that ran, not a launch certificate.
