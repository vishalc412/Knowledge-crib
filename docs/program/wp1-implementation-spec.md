# WP1 Implementation Spec — Freshness, durability, and trust boundaries

Program: Developer Trust (`docs/program/developer-trust-plan.md` §2 WP1).
Status: **COMPLETE** — §1–§4 are plan-derived and fixed; §5–§14 are filled from three parallel read-only
audits of the tree at `a283b104`, re-checked by hand where a claim decides a change, and marked **[V]**
(verified here) or **[R]** (audit-reported, not re-verified). One audit claim is withdrawn in §5.1.
Baseline for this spec: branch `program/developer-trust` @ `a283b104`.

**Before implementing:** §14 D-1, D-2 and D-3 change the shape of the work and three of them are product
decisions about which guarantee is promised. §12.2 step 1 (measure writes-per-mutation and the
update-visibility p95 *before* touching durability) is the input D-1 needs.

## 1. The requirement, verbatim, and what "done" means

The plan states WP1 as four obligations:

1. **Pinned snapshot.** "Make memory evidence resolution and capture anchoring use the request's
   pinned code snapshot. Keep code-reader generation and memory-ledger generation distinct, and
   invalidate cached evaluations when either relevant generation changes."
2. **Durability.** "Extend persistent-write handling to flush file contents before replacement and
   use platform-supported directory durability handling. Surface unsupported guarantees
   explicitly; never report durable success after a persistence failure."
3. **Invariants preserved.** "Preserve append-only history, idempotent writes, lock discipline,
   and recoverable projections."
4. **Ownership and authorization.** "Audit legacy records without principal ownership. Keep
   ambiguous records out of shared trusted recall; provide migration preview, backup, explicit
   ownership assignment, and resumable migration." and "Exercise authorization through search
   results, graph traversal, counts, pagination, history, exports, and diagnostics."

**Exit criteria (plan §2 WP1), which are the gates this spec's work must move:**

- source changes become visible consistently;
- invalidated evidence cannot remain current through a stale cache;
- persistence failures do not produce successful acknowledgements;
- adversarial isolation tests disclose zero foreign records.

## 2. Acceptance and regression rows this work package must satisfy

Taken from plan §4. WP1 owns the first, second and third rows; the fourth and fifth are shared
with other work packages and are re-run here, not re-specified.

| Area | Scenarios this spec must produce evidence for |
| --- | --- |
| Freshness | Save, rename, delete, checkout, merge, rebase, external update, restart; preserve the existing **≤5s p95 convergence** requirement. |
| Durability | Failure before write, during write, flush, and replacement; process interruption; duplicate retries; disk-full and permission errors. **Distinguish process-crash tests from power-loss guarantees** — a test that kills the process proves crash safety only, and must never be described as a power-loss guarantee. |
| Memory trust | Foreign principals, unstamped legacy records, withdrawn evidence, stale generations, unsupported global claims, scope changes during pagination. |
| Connected retrieval | Independent held-out v3 — outside this work package; WP1 must not regress it. |
| Performance | Bounded warm reads ≤500ms p95, context assembly ≤1s, update visibility ≤2s on the specified workload. |

## 3. Interfaces and compatibility this spec must not break

From plan §3, restricted to what WP1 touches:

- Preserve existing CLI commands, MCP tool names, capability registration, and readable historical
  receipt formats.
- **Add** optional evidence-generation provenance so consumers can identify the code snapshot used
  to evaluate a claim — an addition, never a replacement of an existing field.
- **Introduce** an internal request-scoped evidence resolver (new internal surface).
- Keep canonical memory identities stable. Rebuild derived indexes when model or projection
  versions change — do not re-key identities.
- Require explicit preview and backup before ownership migrations; **no automatic assignment of
  ambiguous historical records.**

## 4. Honesty rules for this work package

These bind the evidence for WP1 the way the frozen corpora bound WP2.

- A durability claim states the failure model it was tested under. Crash-safety and power-loss
  safety are different claims and are reported separately; if the platform cannot support
  directory durability, the spec says so and the product surfaces it rather than assuming it.
- "Zero foreign records" is evidenced by adversarial isolation tests per surface — a single
  surface with no test is recorded as a gap, not as covered.
- A stale-cache finding is evidenced by a constructed event sequence that actually reproduces the
  stale read, not by reading the cache's key and inferring.
- Nothing in WP1 is recorded as verified from self-assertion; each row names the command, test, or
  report that produced it.

## 5. Discovery-derived sections

Filled from three parallel read-only audits of the tree at `a283b104`, then re-checked by hand where a
claim decides a change. **Provenance is marked per claim**, because an audit report is testimony, not
evidence:

- **[V]** — verified in this session by reading the source or running the command. The quoted text is
  the current tree's text.
- **[R]** — reported by a discovery audit and *not* independently re-verified. Treated as a lead; the
  implementing change re-confirms it at its own call site before the kill table marks it done.

Sections:

- **D1 — Durability and honest acknowledgement** (§6)
- **D2 — Generations, pinned snapshots, cache invalidation** (§7)
- **D3 — Ownership and authorization surfaces** (§8)
- §9 per-file change list · §10 defect-by-defect kill table · §11 test plan ·
  §12 measurement protocol and acceptance gates · §13 freeze notes · §14 open decisions

### 5.1 One discovery claim is withdrawn

The D3 audit reported that durable intakes still bypass principal enforcement (the 2026-09-05 audit's
findings **R03**). That is **wrong against the current tree, and must not enter the plan as an open
defect.** R03 was repaired by commit `fdfc40bb` *"fix(memory): apply the principal boundary to durable
intakes (R03)"*, which added `MemoryApi.acceptsIntake` (`packages/memory/src/api.ts:2574`) and applied
it inside `intakeEntries()` (`:2596`, filter at `:2623`, checkpoints gated transitively at `:2631`), with
`packages/memory/src/intake-isolation.test.ts` covering both denials and the access that must still work.
**[V]**

The audit's error is instructive and worth recording, because the same misreading could recur: it listed
`api.ts:2574` (`acceptsIntake`) and `:2662` (`search`) as *widening* sites of the default principal. But
`acceptsIntake` **is** the guard — it is called *by* the gather, not a place a principal is invented. The
guard-at-the-gather-point pattern (`acceptsRecord`, and now `acceptsIntake`) means the function that
enforces a boundary and the function that reads an identity have similar shapes; a survey that greps for
`callerPrincipal()`/`principalId` reads will misclassify them. Every "widening site" in §8 below was
therefore re-read at its call site before being written down as a defect.

What *survives* from that finding is narrower and is real: `acceptsIntake` treats an intake carrying **no**
principal as readable (`api.ts:2577`), mirroring `acceptsRecord`'s memory-1 treatment. That is a
deliberate migration-compatibility decision, documented in-source — and it is exactly the ambiguous-record
case WP1 obligation 4 targets ("keep ambiguous records out of shared trusted recall"). It is a scoping
input, not a live defect.

---

## 6. D1 — Durability and honest acknowledgement

### 6.1 The write lanes

Every persistent lane in the tree is temp-file + `renameSync`, with **no `fsync` anywhere**. A tree-wide
search for `fsync|fdatasync|datasync` across `packages/*/src/` returns zero hits in non-test code **[R]**,
and the shared primitive is the six-line function below **[V]**:

```ts
// packages/memory/src/atomic.ts:16-21
export function writeJsonAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
```

| lane | writer | file flush | dir flush | acknowledgement point |
| --- | --- | --- | --- | --- |
| memory shards (all collections) + generation sidecars + manifest | `writeJsonAtomic` / `MemoryStore` | no | no | `renameSync` returns → `void` |
| soul manifest + `.crib/crib.json` | `SoulStore.atomicWrite` (`packages/core/src/soul-store.ts:674-679`) | no | no | rename returns |
| composite materialization / graph-layout migration / dossiers / embed manifest / registry / freshness unit files / enrichment artifacts | staging-dir or temp + rename, one per module | no | no | rename returns |
| backup bundle | `createMemoryBackup` (`packages/memory/src/backup.ts:84-130`) | no | no | rename returns |
| **intelligence journal (append-only)** | `IntelligenceEventJournal.append` (`packages/memory/src/intelligence-events.ts:167`) | no | no | bare `appendFileSync` returns |
| **sync outbox (append-only)** | `stageOutboundEvent` (`packages/memory/src/sync/queue.ts:265`) | no | no | bare `appendFileSync` returns |
| lock file | `CribLock.tryCreate` (`packages/core/src/lock.ts:158-162`) | no | no | `writeSync` returns |
| SQLite lanes (FTS rows, vectors, graph index) | `node:sqlite` | SQLite default | SQLite default | statement returns |

Lane rows are **[R]** except `writeJsonAtomic` **[V]**.

### 6.2 Defects

**D1-a — the acknowledgement promises stability it does not provide.** `writeFileSync` returning means the
bytes are in the kernel page cache; `renameSync` returning means the dirent is in cache. A power loss after
the acknowledgement can lose an acknowledged write, and can leave the *old* name bound. Every memory shard,
generation sidecar and manifest inherits this. This is the defect the requirement names.

The prose in `MemoryStore` asserts the opposite in the word the requirement is about **[R]**:
*"The result is the durable acknowledgement: it is returned only after every `writeJsonAtomic` has
completed, so a faulted persist throws and acknowledges NOTHING"* (`packages/memory/src/store.ts:1350-1353`).
That sentence is **true for a thrown fault and false for an unflushed one**. The code is right; the word
"durable" is doing work the code does not do.

**D1-b — the two append-only lanes make no flush claim at all.** `intelligence-events.ts:167` and
`sync/queue.ts:265` use bare `appendFileSync`. Their recovery story is the torn-trailing-line rule, which is
**process-crash** safety, not power-loss safety (`packages/cli/src/memory-crash-recovery.test.ts:388,416`).
The code does not say which it is claiming. WP1 §4 forbids letting that ambiguity ship.

**D1-c — directory durability is never performed.** No `openSync(dir, 'r')` + `fsync` exists in the tree
**[R]**. The primitives are already imported for other purposes (`packages/core/src/lock.ts:20-28`), so this
is wiring, not new machinery.

**D1-d — one derived lane returns success after rolling back.** `MemoryVectorStore`'s insert catches, runs
`ROLLBACK`, and still `return out` (`packages/memory/src/vector-store.ts:137-145`) **[R]**. A caller cannot
distinguish persist-failed from persisted. This is a *derived* read model (vectors are content-addressed and
rebuildable), so the blast radius is small — but "the write failed and we said fine" is the shape the
requirement forbids, and the fix is one marker or one rethrow.

**D1-e — ENOSPC / EIO / EACCES have no operator-facing handling.** They surface as a raw `Error` carrying a
`code`, with no typed handling anywhere in the memory lanes **[R]**. WP1's acceptance row names disk-full and
permission errors explicitly, so this is in scope.

**Not defects, and recorded as such so they are not "fixed":**

- `PersistentMemoryFts.writeMeta`'s swallowed failure (`packages/memory/src/persistent-fts.ts:336-340`) is
  **deliberate fail-open and documented in-source** **[V]**: the snapshot rows are already correct, only the
  header lags, and a lagging header causes a rebuild rather than a stale serve. Leave it.
- The `sources`-filtered ephemeral FTS rebuild (`verbs.ts:342`) exists to protect a documented
  byte-comparability invariant (§7.5) — it is a correctness feature, not a wasteful copy.
- The non-durable lock file (`lock.ts:161`) fails **safe**: a lost lock file releases the lock, so a power
  loss errs toward *more* concurrency, never toward silent data loss. Worth stating; not worth changing.

### 6.3 Cost, measured — and a platform guarantee the requirement's wording overstates

**Measured on this machine (2026-09-22, APFS, darwin 25.6), before any code was written.** The probe
replicates `atomic.ts:16-21` verbatim as the baseline and the §9 item 1 shape as the durable variant, 300
iterations each, same directory, same 2 KB payload **[V]**:

| | p50 | p95 |
| --- | --- | --- |
| baseline (temp → rename, no flush) | 0.118 ms | 0.193 ms |
| durable (fd write + file flush + rename + **directory flush**) | 9.937 ms | 11.092 ms |
| **overhead** | **+9.82 ms** | **+10.90 ms (58×)** |

**Writes per mutation, counted against a real mutation** — `crib memory observe` on a scratch repo,
admitted to local trust, steady-state, identical cold and warm **[V]**:

```
WRITE-COUNTS {"renameSync":12,"fsyncSync":0,"appendFileSync":1,"writeFileSync":13}
```

`fsyncSync: 0` in the mutation path, and `fsyncSync: 0` across the whole of `crib init` (22 renames, 36
writes) — an independent confirmation of §6.1's tree-wide claim, not a restatement of it.

**So the arithmetic is ~12 flushed writes × 10.90 ms ≈ 130 ms p95 added per mutation.** Against the
`< 2 s` update-visibility gate that is **~6.5% of budget**.

**The alarm recorded earlier in this section was not borne out and is withdrawn.** This spec previously
argued that flush-per-write "can fail a gate that is already 43 ms from failing". At the measured write
count that is wrong: the added cost is affordable, and the group-commit option in D-1 is probably
unnecessary. The gate still has to be re-measured with the change in place — 1956.6 ms is a different code
path (watch → queryable, dominated by index/graph rebuild) than the mutation path measured here — but the
risk is now quantified as headroom, not as a likely breach. The *previous* section's reasoning was the kind
of inference §4 forbids: it multiplied an unmeasured per-call cost by an assumed call count and reported the
product as a risk. Two commands replaced both guesses.

**D1-g — the stronger finding: on macOS, `fsync` does not provide the guarantee the requirement implies.**
`man 2 fsync` on this machine **[V]**:

> Note that while fsync() will flush all data from the host to the drive (i.e. the "permanent storage
> device"), the drive itself may not physically write the data to the platters for quite some time… if the
> drive loses power or the OS crashes, the application may find that only some or none of their data was
> written.

> Applications, such as databases, that require a strict ordering of writes should use F_FULLFSYNC… Mac OS X
> provides the F_FULLFSYNC fcntl.

Obligation 2 says *"flush file contents before replacement"* and *"surface unsupported guarantees
explicitly"*. On darwin, `fsyncSync` is a host-to-device flush, **not** a platter flush, and Node core
exposes no `F_FULLFSYNC` (which needs an `fcntl` binding that would mean a native dependency — unacceptable
for this project). Therefore:

- the capability surfaced by §9 item 2 must be **three-valued, not two**, because "file flush: yes" is
  misleading on its own: `{ fileFlush: true, dirFlush: true, powerLossDurable: false }` on darwin, with
  `powerLossDurable: true` where the platform's fsync is a full flush (Linux ext4).
- the honest product claim becomes *"an acknowledged write survives a **process** crash and is ordered on the
  device"* — which is a **strictly stronger** claim than today's page-cache acknowledgement, and a
  **strictly weaker** claim than power-loss durability. §4 requires exactly this separation, and §11.1 names
  the tests accordingly.

Directory flush **is** supported here (`openSync(dir,'r')` + `fsyncSync` returns 0) **[V]** — the first probe
reported `ENOENT`, which was that probe's own bug (it probed the directory before creating it), and it was
re-run rather than reported. The platform-gated fallback in D-1 is therefore for other filesystems
(network mounts, some FUSE), not for this one.

---

## 7. D2 — Generations, pinned snapshots, cache invalidation

### 7.1 The generations that exist

| generation | written at | read at | scope |
| --- | --- | --- | --- |
| `SoulStore.generation` → `nodeGeneration` | `packages/core/src/soul-store.ts:313` (every node mutation) | `evaluator.ts:168-171`, `cluster-hash.ts` | code |
| `manifest.generation.extracted` | `soul-store.ts:392-393` | `working-overlay.ts:61`, `graph-store.ts:210`, `canonicalFingerprint` | code |
| `manifest.generation.semantic` | `soul-store.ts:457-458` | `sqlite-index.ts:774-792`, `verbs.ts:4879,4912`, `enrichment.ts:552` | code (authored layer) |
| `ReaderBundle.generation` = `bundleGeneration(capture)` | `packages/cli/src/refresh-coordinator.ts:176-186`, assigned `:490` | `freshness()` `:353-366`, `verbs.ts:687`, `cli.ts:3055` | **code + memory, collapsed** |
| `MemoryGraphIndex` `++graphPublication` | `cli.ts:2256` | `graph-index.ts:120` (`status()`) | memory |
| `MemoryFtsGeneration` `store.gen` (+nonce) | `bumpStoreGeneration` `store.ts:726-740` | `readStoreGeneration` `store.ts:677`, `cli.ts:5719`, `verbs.ts:3248` | memory |
| `fts.gen` | `bumpFtsGeneration` `store.ts:~745` | `readFtsGeneration` | memory (records only) |
| `semantic_meta.generation` | `buildSemanticIndex` `sqlite-index.ts:774` | `semanticIndexGeneration` `:789` → `verbs.ts:4912` | code |
| graph-view generation (string) | `computeGraphViewGeneration` `memory-graph.ts:75-81` (WeakMap memo) | `verbs.ts:3068`; cursor binding `memory-graph.ts:150` | memory |

All rows **[R]**.

### 7.2 The two collapse defects

**D2-a — a memory-only change is priced as a code change.** `bundleGeneration(capture)` hashes
`graphSourcePosition` — the memory-ledger position from `memoryGraphSourcePosition()` (`cli.ts:5716-5720`,
built from each store's `store.gen:nonce`) — *together with* the code capture (HEAD, `canonicalFp`,
`dirtyFp`). So a memory-only mutation bumps the **code-reader** generation and forces a full
overlay + FTS + graph candidate rebuild (`refresh-coordinator.ts:410-441`). The consolidation is deliberate
(`:61-63`) **[R]**, but it is consolidation in the wrong direction: the requirement says keep the two
generations **distinct**.

**D2-b — two fields cannot disagree, so they are not signals.** `freshness()` sets
`graphGeneration = served?.graph?.generation ?? served?.generation` and `searchGeneration = served?.generation`
(`:361,:366`), and `DerivedGraphReader.generation` is asserted equal to the bundle generation at build time
(`:492-495`). All three are therefore equal to `readerGeneration` by construction **[R]**. The one genuinely
independent counter — `MemoryGraphIndex`'s `++graphPublication` — is written into `memory_graph_meta` and
never compared against anything. A "source/graph/index generation agreement" acceptance row (audit R04)
cannot be evidenced by fields that are structurally incapable of disagreeing.

### 7.3 Evidence resolution is not pinned to the request's snapshot

- Resolution entry: `MemoryEvaluator.revalidateItem` → `revalidateSourceQuote`
  (`packages/memory/src/evaluator.ts:384-527`). Its **fast path** (`:426-434`) returns `valid/current`
  without touching disk when `ev.targetHash === node.hash`.
- Anchoring at capture **is** a real pin: `MemoryApi.capture` (`api.ts:1694-1711`) stores `soulId`,
  `targetHash`, `quote`, `startLine`.
- **The resolution does not use the request's pinned snapshot.** The anchor port is
  `SoulStoreAnchorPort(this.deps.soul, …)` (`verbs.ts:4505`) and the evaluation context is
  `SoulStoreSoulPort(rt.soul, repoRoot)` (`cli.ts:5696`) — both the **canonical** soul.
  `adoptWorkingSnapshot` swaps only `workingOverlay`/`workingOverlayIndex`/`graph` (`verbs.ts:621-625`); the
  memory evaluation context is never re-pointed. Body text is read from disk at `repoRoot`
  (`packages/core/src/source.ts:104`), so a node's **span and identity can come from the committed graph
  while its text comes from the live file** — a torn read.

All **[R]**; this is the obligation the plan names first, and it is the largest single change in WP1.

### 7.4 The stale-cache window, as a constructed sequence

1. Evidence `E` is captured: `soulId=S`, `targetHash=H`, quote `Q`.
2. Recall binds the evaluation cache at fingerprint `F`; the `code` slot is the canonical
   `nodeGeneration:extracted:semantic`.
3. `E` evaluates via the hash short-circuit → `valid/current`, zero reads. Memoized.
4. The user edits the file in the working tree. The coordinator sees it (`dirtyFp` changed) and publishes a
   new bundle generation; code verbs read the overlay and *do* see the edit.
5. The canonical soul did not move, so the `code` slot is unchanged; the memory evaluation context still
   points at the canonical soul; the fingerprint has **no reader slot and no ledger slot**.
   `GenerationCache.bind` finds `next === this.fingerprint` and serves the cached entry
   (`packages/core/src/generation-cache.ts:132-139`).
6. `E` is reported **`valid/current`** while its anchored span has changed.

**[R]**, and this is the exact shape §4 requires: a constructed event sequence that reproduces the stale
read, not an inference from the key. It is the evidence for the exit criterion *"invalidated evidence cannot
remain current through a stale cache"*. The store's own `store.gen` never enters the key either, so a
ledger change invisible to `decisions`/`feedback` is equally unseen.

### 7.5 The persistent FTS corpus can disagree with the scored pool

`lexicalChannel` (`packages/mcp/src/verbs.ts:336-371`) hands `VersionedLexicalScorer` both the persistent FTS
snapshot `openMemoryFts(stores)` and the caller's authorized `records` pool. `VersionedLexicalScorer` is a
**scoring function, not a retriever**: `score(record, query, targetIds)` (`packages/memory/src/fusion.ts:273`)
only ever scores records already in that pool **[V]**. So **no foreign record can be disclosed through this
channel** — the D3 audit's highest-priority unverified question resolves to *not a leak*.

But the snapshot's corpus is built by `rebuildFromStores()` from `gatherRecall(this.stores)` with **no
principal** (`packages/memory/src/persistent-fts.ts:318-320`) **[V]**, so the corpus is a cross-principal
union while the scored pool is the caller's. The module documents a byte-comparability invariant that
requires corpus and pool to match — that is precisely why a `sources` filter takes the ephemeral-rebuild
path (`verbs.ts:326-328`) **[V]**. So the defect is **ranking correctness**, not disclosure: BM25 IDF is
computed over a corpus that may include or exclude other principals' records, so the same authorized record
can score differently depending on who else shares the store. The *term statistics* of foreign records do
influence a caller's scores, which is a weak cross-principal channel — real, but not a record disclosure,
and it must be described that precisely rather than as "a leak".

### 7.6 Cache inventory

| cache | key | invalidated by a code change? | by a ledger change? | defect |
| --- | --- | --- | --- | --- |
| `GenerationCache` (`generation-cache.ts:110-152`) | `evaluationCacheKey` over `${code\|policy\|receipts\|decisions\|feedback\|embedder\|index}` | only if the **canonical** generation moves — not an overlay-only edit | only via `decisions`/`feedback` entry-set fingerprints | **D2-c: no `reader` slot, no `ledger` slot** |
| `SoulStoreSoulPort` locator scan + memo (`evaluator.ts:141-194`) | `generation()` string | same caveat | no | same cause |
| `storeGenerationCache` (`store.ts:184-717`) | path + `mtimeNs`/`size` | n/a | yes | none |
| shard memo (`store.ts:1126,1184`) | `readStoreGeneration()` | n/a | yes | none |
| `cluster-hash` caches | `nodeGeneration` | yes | no | none |
| `generationMemo` WeakMap (`memory-graph.ts:72-81`) | projection object identity | n/a | n/a | none |
| `semanticHits` projection (`verbs.ts:4890-4915`) | `generation.semantic` | yes | authored layer | none |
| `vcsMemo` (`verbs.ts:4836-4852`) | 2 s wall clock | — | — | by design |
| `readerFreshness` itself | not cached — recomputed per call | — | — | none |

**[R]**. Cross-process verdict caching is explicitly out of scope (`generation-cache.ts:24-26`), so the
window in §7.4 is per-process.

### 7.7 Test coverage: what exists, and the four gaps

Covered **[R]**: `generation-cache.test.ts:130` (any-slot bust), `:298` (changed code generation re-evaluates),
`:355` (locator memo bust on `putNodes`); `refresh-coordinator.test.ts:187,201-207` (diverge/converge),
`:311` (generation-mismatch refusal), `:429` (restart reproduces generation), `:642` (adoption-pending stale),
`:492-660` (freshness verdicts); `freshness.test.ts:594` (queryable-update p95).

**Not tested [R]:** (a) the memory evaluation cache invalidated by a code change visible only through the
working overlay; (b) evidence resolution against a pinned bundle rather than canonical + disk; (c) any case
where `graphGeneration !== readerGeneration` — which, per §7.2, is currently *constructed* to be impossible;
(d) `MemoryGraphIndex.generation` compared to any other counter.

---

## 8. D3 — Ownership and authorization surfaces

### 8.1 How ownership is represented

Ownership is `provenance.principalId` (v2/v3), mirrored on `namespace.principalId` (v3) and pinned equal by
validation (`validate.ts:103`, `:180`, `:208`, `:218`, `:239`; `migrations.ts:216-218` throws on mismatch)
**[R]**. Per schema version, "unowned" means:

- **v1** — no principal field exists. `recordPrincipalId()` returns `undefined` (`recall.ts:277-279`). **This
  is the ambiguous case.**
- **v2/v3** — `principalId` is always present in the type, but the literal `principal:local` marks a record
  stamped by the migration fallback.
- **Foreign** — present and unequal to the caller's.

### 8.2 The default principal, by direction

`DEFAULT_MIGRATION_PRINCIPAL_ID = 'principal:local'` (`migrations.ts:51`), whose own doc says principal is
OWNERSHIP, not an access boundary. The substitutions split by direction **[R]** — and the direction is what
matters:

**Narrowing (can hide a record from its own owner):**

| # | site | consequence |
| --- | --- | --- |
| 1 | `migrations.ts:102-103` stamps the v2 twin | with `KCRIB_PRINCIPAL_ID` unset, **every migrated record is stamped `principal:local`**. A user whose real principal is `principal:alice` then fails `ownedBy !== principal` (`recall.ts:404`) on **her own** records. Migration is the thing that hides records from their owner. |
| 8 | `handoff.ts:281-286` — inverted | the default principal is the *only* identity admitted, making `principal:local` a super-viewer over unscoped lifecycle events. Deliberate (`:279-280`), and it fails closed — the safe direction. |
| 9 | `handoff.ts:371-373` `unscopedVisible` | same inversion for `attempts`/`pending`. |

**Widening (can show a record to someone who should not see it):** `recall.ts:289-293`
(`resolveCallerPrincipal`), `api.ts:4039-4040` (`callerPrincipal`), `api.ts:2506-2508` and `:2662` (search
boundary identity), `api.ts:3186` (sync scope), `verbs.ts:3263`/`:3531`/`:4138` (MCP identity), and the CLI
identity sites (`cli.ts:4612,5856,6059,6400,7806,8011,10022`; `intelligence-events.ts:46`). An env-less call
acts *as* `principal:local`, so it sees every `principal:local` record **and** every unstamped one.

**Site 1 and the widening set #2–#7 are the two ends of a single decision:** what the default principal
means for a record nobody owns. §5.1's withdrawal applies here — sites that merely *read*
`callerPrincipal()` are not substitutions and are excluded from the list above.

### 8.3 The unowned-record decision point, and the dead fix

`recall.ts:392-409` **[R]**, decision verbatim in shape:

```ts
const ownedBy = recordPrincipalId(record);
if (ownedBy === undefined) {
  // unstamped (memory-1). Owner is UNKNOWN, not "the caller" — a strict gather refuses it.
  if (strictPrincipal) { principalExcluded += 1; return false; }
} else if (ownedBy !== principal) { principalExcluded += 1; return false; }
records.push({ record, source });
```

Today: **admitted by default**, eligible if it also clears `isRecallEligible`, attributed nowhere. Only a
`strictPrincipal: true` gather refuses it.

**D3-a — the fix exists and is dead code.** `strictPrincipal` defaults to `false` (`recall.ts:382`) and no
production caller passes it: the parameter occurs in `recall.ts` (option + branch), one doc comment, and
`cli.ts:3317` — inside a doctor *remediation string*, not a call. The sole real pass is `recall.test.ts:611`.
Every production gather passes at most `principal`/`sources`. **The two-store leak the source documents at
`recall.ts:336-343` ("returned all 15 of B's memory-1 records to A") is therefore still open by default,
with the repair sitting unreachable beside it.** `acceptsIntake` has the same legacy-readable shape
(§5.1) — consistent, deliberate, and equally in scope for obligation 4.

### 8.4 Migration capability: the engine is good, the surface is missing

The engine exists and is well-built **[V] for `migrateToV2`'s body; [R] for the rest**: `store.ts:898`
`migrateToV2`, `:920` `migrateToV3`, on `migrations.ts:164-207` / `:211-235` and the `MIGRATE_1_TO_2` step
(`:270-287`), with fail-closed gating (`migrations.ts:298-304`) and content-hashed backup primitives
(`backup.ts:84/133/182`). It is documented non-destructive (`store.ts:874-897`), idempotent, and takes a
single lock hold.

**It is unreachable from any production surface [R].** Outside `store.ts`'s own definitions, every
occurrence of `migrateToV2`/`migrateToV3` is a test, a doc comment, or `dist/`. There is no CLI verb, no MCP
op, no preview, no automatic pre-migration backup, no resumable handle and no explicit
ownership-assignment verb.

**D3-b — the product's own remediation text describes a command that does not do the thing.**
`cmdMemoryMigrate` (`cli.ts:10311-10376`) owns the name but never calls `migrateToV2`: it walks collections,
tallies `byVersion`, validates into `invalid`, persists the manifest, prints counts, and exits non-zero only
when `totalInvalid > 0`. It is contradicted by the doctor's own fix text (`cli.ts:3317`): *"run
`crib memory migrate` to stamp them (memory-1 → memory-2), or pass strictPrincipal on any gather that can
see another principal"* — **neither half is executable.** The check behind it is
`countUnstampedRecords` (`cli.ts:5657`, surfaced `:3305-3319`).

This is the obligation-4 gap, and its shape is encouraging: **preview, backup, explicit assignment and
resumability are wiring onto an engine that already provides the hard parts** (atomic rewrite, alias
binding, idempotence, lock discipline, content-hashed backup). WP1 introduces a surface; it does not
invent a migration.

### 8.5 Authorization surfaces, and which have adversarial evidence

| surface | filter applied | adversarial isolation test |
| --- | --- | --- |
| plain search | yes — record pool (`api.ts:2662` + `recall.ts:392-409`) | unit only, via explicit `strictPrincipal` (`recall.test.ts:565-611`); **none** through `memorySearch` with two principals |
| connected graph / context pack | yes (`graph-projection.ts:222-238`, `:306-308`, `:439-442`; `api.ts:1463`, `:1494-1497`) | yes — `verbs-memory-graph.test.ts` (recall channel cannot seed a foreign-placed record at repo scope) |
| durable intakes / checkpoints / handoff | yes — `acceptsIntake` at the gather (`api.ts:2574`, `:2623`, `:2631`) | **yes — `intake-isolation.test.ts`** (denials *and* the access that must still work) — §5.1 |
| counts / stats | yes (`api.ts:3777`; `graph-projection.ts:558-564`) | none found |
| pagination / cursors | yes — filter precedes `slice` (`api.ts:3769-3786`; `memory-graph.ts:98-112`, `:143-149`) | none found |
| history / bi-temporal | yes (`api.ts:3035` via `gatherAllRecords` `:4002`) | none found |
| exports | inherits `handoff` (`cli.ts:10621-10667`) | none found |
| diagnostics / doctor / status | partial (`cli.ts:3305-3319`; `graph-projection.ts:578`) | none found |
| direct `get` by id | yes — foreign id → `found:false` (`api.ts:3921-3944`) | none found |

All **[R]**.

**Two structural protections worth crediting, and building on:** `acceptsRecord` sits at locate/gather
specifically so a new verb cannot bypass it (`api.ts:4026-4031`), and the graph projection hardcodes
`excludedForeign: 0` (`graph-projection.ts:578`) precisely because a non-zero value would disclose foreign
*presence*. The first is the pattern obligation 4 should extend; the second is the existence-leak discipline
it should copy.

**Existence-leak review:** graph diagnostics are **closed** (foreign decisions filtered *before* the
`deferred` counter increments; assertions skipped before any `unsupported`/`placementInvalidSupporters` list
is built); the graph cursor is **closed** (`graphQueryDigest` includes `principalId`, `memory-graph.ts:98-112`,
so a mismatch yields `CURSOR_STALE`); ledger/status counts are **closed** but only because the filter runs
first — a refactor that counted pre-filter would leak totals. **One low-severity disclosure survives:**
`countUnstampedRecords` publishes the *number* of unattributed records in the local store. Not a foreign
principal's records, but it is a count printed to a caller. **[R]**

### 8.6 Test-coverage gaps

Existing adversarial coverage is concentrated in two places (`recall.test.ts:565-611`, and now
`intake-isolation.test.ts`). Surfaces with **no** adversarial isolation test found: counts/stats histograms,
pagination cursors, history/bi-temporal, exports, diagnostics, direct `get`. `scripts/client-certify.mjs`
and `packages/ui` were **not inspected** — unverified, and named as such in §14 D-5 rather than assumed
covered.

---

## 9. Per-file change list

Ordered by dependency. Each item names the smallest correct change; **none of them reorders a write outside
its lock, changes the temp→rename shape, or re-keys a memory identity** (§3).

### Durability

1. `packages/memory/src/atomic.ts` — extend `writeJsonAtomic`: write via an fd, flush the fd, close, rename,
   then flush the parent directory. Reuse the already-imported `openSync`/`closeSync`/`fsyncSync` primitives
   (`packages/core/src/lock.ts:20-28`).
2. `packages/memory/src/atomic.ts` (+ `store.ts` callers) — export the durability capability as a **returned
   fact**, three-valued: `atomicWriteDurability(): { fileFlush: boolean; dirFlush: boolean; powerLossDurable: boolean }`
   (§6.3, D1-g), so the "durable acknowledgement" prose (`store.ts:1350-1353`) is conditioned on the real
   value instead of asserting it.
3. `packages/core/src/soul-store.ts:674-679` — apply the same treatment to `SoulStore.atomicWrite`.
4. `packages/memory/src/intelligence-events.ts:167`, `packages/memory/src/sync/queue.ts:265` — add
   `appendLineDurable` beside `writeJsonAtomic` (open `'a'`, write, flush, close) rather than changing append
   semantics.
5. `packages/memory/src/vector-store.ts:137-145` — stop returning success after `ROLLBACK`: rethrow, or
   return a `persisted: false` marker.
6. `packages/cli/src/cli.ts` (doctor/capability path) — surface the durability model the platform actually
   provides, so `docs/design/02-lld.md:445`'s documented limit stops being docs-only. This is obligation
   2's "surface unsupported guarantees explicitly".

### Freshness and generations

7. `packages/core/src/generation-cache.ts:39-54` — add `reader` and `ledger` to `DependencyGenerations`; set
   them in `bindEvaluationPass` (`packages/memory/src/api.ts:1372-1388`) from the pinned bundle generation
   and the pinned store generations.
8. `packages/mcp/src/verbs.ts:4552`, `packages/cli/src/cli.ts:8360` — pass the adopted snapshot generation
   into `bindEvaluationPass`, defaulting to `UNVERSIONED` so an unsupplied pin reproduces today's
   fresh-eval behaviour.
9. `packages/memory/src/evaluator.ts:140-171` + `packages/cli/src/cli.ts:5696` — resolve evidence against the
   request's pinned code soul and rehydrate through the overlay instead of reading `repoRoot` from disk.
   **This is the largest diff in WP1** and the one obligation 1 names first.
10. `packages/memory/src/persistent-fts.ts:318-320` — make the persistent FTS corpus and the scored pool
    agree (§7.5). See §14 D-3 for the decision this needs.
11. `packages/cli/src/refresh-coordinator.ts` / `freshness()` — stop collapsing the two generations (§7.2):
    either drop `graphGeneration`/`searchGeneration`, or report `MemoryGraphIndex`'s `++graphPublication`;
    and separate the memory-ledger position from the code capture in `bundleGeneration`.

### Ownership and authorization

12. `packages/cli/src/cli.ts` `cmdMemoryMigrate` (`:10311-10376`) — implement the real verb behind
    `--preview` / `--apply` / `--principal <id>`, calling `store.migrateToV2({principalId})`, with an
    automatic `createMemoryBackup` before apply and a resumable per-store ledger. The engine already exists;
    this is the surface obligation 4 requires.
13. `packages/memory/src/recall.ts:382` — resolve the default of `strictPrincipal` (see §14 D-2), then pass
    it explicitly at the production gathers `api.ts:2662`, `api.ts:2506`, `verbs.ts:2988`, `verbs.ts:4535`,
    `verbs.ts:4611`.
14. `packages/cli/src/cli.ts:3317` — correct the doctor remediation text to match what item 12 actually
    implements. **A product statement that names a non-existent repair is its own defect** and is cheap to
    close.
15. New adversarial test file covering the five untested surfaces (§8.5) with a foreign-principal fixture
    asserting zero foreign rows **and** unchanged totals.

---

## 10. Defect-by-defect kill table

| id | defect | evidence (§) | change | test that must fail before / pass after | exit criterion |
| --- | --- | --- | --- | --- | --- |
| D1-a | acknowledgement = page cache, not stable storage | 6.1, 6.2 | 1, 2 | flush-order test asserting a flush on the temp fd **and** the directory fd precedes the ack | persistence failures do not produce successful acknowledgements |
| D1-b | append-only lanes make no flush claim | 6.2 | 4 | a flush is recorded per appended line; torn-line recovery still passes | same |
| D1-c | no directory durability anywhere | 6.2 | 1, 3 | directory-flush-failure case asserts the previous file survives | same |
| D1-d | vector store returns success after rollback | 6.2 | 5 | injected insert failure is observable to the caller; transaction rolled back | same |
| D1-e | ENOSPC/EIO/EACCES untyped | 6.2 | 1, 6 | fault injection on a shard write asserts throw-not-ack with an operator-facing reason | same |
| D1-f | guarantees are docs-only | 6.2 | 6 | diagnostic output carries the durability line, and is `false/false` where the fsync path is unsupported | persistence failures do not produce successful acknowledgements |
| D1-g | on macOS `fsync` is host-to-device, not a platter flush; `F_FULLFSYNC` is unreachable from Node core | 6.3 | 2, 6 | the reported `powerLossDurable` is `false` on darwin where `fsync` is not a full flush, and the acknowledgement's documented claim matches it | persistence failures do not produce successful acknowledgements |
| D2-a | memory-only change prices a code rebuild | 7.2 | 11 | a memory-only mutation does not bump the code-reader generation | source changes become visible consistently |
| D2-b | `graphGeneration`/`searchGeneration` cannot disagree | 7.2 | 11 | the two fields diverge when only the graph reader is replaced | same |
| D2-c | no `reader`/`ledger` slot in the evaluation cache key | 7.4, 7.6 | 7, 8 | bind at reader gen A, evaluate, bump to B → second bind misses; a working-tree-only edit invalidates a memoized verdict in serve mode | invalidated evidence cannot remain current through a stale cache |
| D2-d | evidence resolves against canonical + disk, not the pin | 7.3 | 9 | a quote changed only in the working tree grades `hash-drift`/`needs-review` **without** a `crib update` | source changes become visible consistently |
| D2-e | persistent FTS corpus ≠ scored pool | 7.5 | 10 | the same authorized record scores identically under a foreign co-tenant | source changes become visible consistently |
| D3-a | the unowned-record guard is dead code | 8.3 | 13 | two principals' stores gathered together return **zero** of the other's records — the `recall.ts:336-343` scenario, asserted | adversarial isolation tests disclose zero foreign records |
| D3-b | `crib memory migrate` does not migrate; doctor names it anyway | 8.4 | 12, 14 | apply twice ⇒ second pass reports 0 migrated; every previously-unstamped record validates with the assigned principal | ambiguous records stay out of shared trusted recall |
| D3-c | five authorization surfaces have no adversarial test | 8.5, 8.6 | 15 | foreign-principal fixture returns zero foreign rows **and** unchanged totals per surface | adversarial isolation tests disclose zero foreign records |

Every row's test must be shown to **fail against the pre-fix code** before it is credited, per WP2's
measured-discrimination lesson (register §3, "Pre-freeze 3") — a test that passes either way is recorded as
covering nothing.

---

## 11. Test plan

### 11.1 Honesty constraints on the tests themselves

- **Process-crash ≠ power-loss.** Every existing "crash" test kills a *process*
  (`memory-crash-recovery.test.ts:1-40` says so explicitly). WP1's new tests assert **flush ordering**, which
  is the strongest available evidence on a running kernel — and they are named and reported as
  *flush-ordering* tests, never as power-loss guarantees (§4).
- **Isolation tests are half a contract.** Every denial is paired with the access that must still work
  (owner reads own; deliberately team-shared reaches a colleague) — the pattern `intake-isolation.test.ts`
  already sets.
- **No test asserts a capability the platform may not have.** The durability test asserts the capability
  *reported* matches the write performed (§9 item 2), which is true on every platform.

### 11.2 New and extended tests

| test file | covers | rows |
| --- | --- | --- |
| `packages/memory/src/atomic.test.ts` (new) | flush order (temp fd, then directory fd) before the ack; directory-flush failure preserves the previous file; ENOSPC/EIO/EACCES throw-not-ack | D1-a, D1-c, D1-e |
| `packages/memory/src/ack-after-persist.test.ts` (extend) | the vector store's rollback is observable; append lanes flush per line | D1-b, D1-d |
| `packages/cli/src/doctor-durability.test.ts` (new) | the reported durability model matches the write performed; `powerLossDurable: false` where `fsync` is not a full flush; `false/false` where unsupported | D1-f, D1-g |
| `packages/core/src/generation-cache.test.ts` (extend) | bind at reader gen A → bump to B → miss; ledger-only change → miss | D2-c |
| `packages/cli/src/refresh-coordinator.test.ts` (extend) | memory-only mutation does not bump the code-reader generation; `graphGeneration` diverges when only the reader is replaced | D2-a, D2-b |
| `packages/memory/src/evaluator-pinned.test.ts` (new) | a working-tree-only quote change grades `hash-drift`/`needs-review` with no `crib update` | D2-d |
| `packages/memory/src/persistent-fts-scope.test.ts` (new) | a record's score is invariant to a foreign co-tenant | D2-e |
| `packages/memory/src/recall.test.ts` (extend) | the two-store leak scenario asserted through the **production** gather path, not via an explicit `strictPrincipal` | D3-a |
| `packages/cli/src/memory-migrate.test.ts` (new) | preview changes nothing; apply twice is idempotent; backup precedes apply; a fault mid-migration resumes | D3-b |
| `packages/memory/src/authorization-surfaces.test.ts` (new) | counts, cursors, history, export, direct `get`: zero foreign rows and unchanged totals | D3-c |

### 11.3 Regression suites that must stay green

`pnpm -r test` in full, with named attention to: `memory-crash-recovery.test.ts` (torn-line recovery must
survive the append-lane change), `intake-isolation.test.ts` and the graph authorization laws in
`verbs-memory-graph.test.ts` (nothing in §9 items 7–11 may widen a boundary), `backup.test.ts`,
`lock-concurrency.test.ts`, `materialize.test.ts` (byte-identical idempotence), and the frozen-corpus graph
evaluation (§13).

---

## 12. Measurement protocol and acceptance gates

### 12.1 Gates that must be re-measured

| gate | threshold | current | note |
| --- | --- | --- | --- |
| graph evidence-path recall, corpus v1 | ≥90% | 95.33% | frozen corpus; WP1 **must not regress** |
| graph evidence-path recall, held-out v2 | ≥90% | 95.42% | frozen corpus; WP1 **must not regress** |
| forbidden / unauthorized / emptiness violations | 0 / 0 / enumerated | 3 / 0 / 3 (v1), 0 / 0 / 3 (v2) | residue unchanged; same enumerated rows |
| one-file watch update → queryable | < 5 s p95 | Gate 3 E2E watch fixture | `docs/bench/perf-gates.md` |
| warm read p95 | ≤ 500 ms | — | plan §4 |
| context assembly | ≤ 1 s | — | plan §4 |
| update visibility | ≤ 2 s | **1956.6 ms (97.8% of budget)** | **re-measure at freeze; §6.3 makes this the risk** |
| **write latency per mutation (NEW)** | ≤ 200 ms p95 added, i.e. ≤10% of the visibility budget | **measured 2026-09-22: ~130 ms p95 added** (12 writes × 10.90 ms) | §6.3; re-measure with the change in place |

### 12.2 Sequence

1. ~~Measure **before** any durability change: writes per mutation, and the update-visibility p95 on the
   specified workload.~~ **DONE 2026-09-22 — §6.3:** 12 writes per mutation, ~10.90 ms p95 per flushed write,
   ~130 ms p95 added per mutation, `fsyncSync: 0` today. The remaining half — the update-visibility p95
   *with the change in place* — is step 3.
2. Land the freshness/generation changes (items 7–11) and re-run the frozen-corpus graph evaluation — a
   generation change that moves a gate value is a retrieval regression, not a freshness win.
3. Land the durability changes (items 1–6) and re-measure write latency and update visibility. If the gate
   breaks, implement the §6.3 fallback rather than relaxing the gate.
4. Land the ownership changes (items 12–15) and run the adversarial matrix.
5. Re-run the full regression suite and produce the register's §2 rows with a named command per row.

### 12.3 What "verified" means here

Nothing in WP1 is recorded as verified from self-assertion (§4). Each register row names the command, test,
or report that produced it; a passing local gate produces a receipt; and the failure model is stated
alongside every durability claim.

---

## 13. Freeze notes

- **Frozen before WP1 starts and untouched by it:** `GRAPH_CORPUS_VERSION = 1`,
  `GRAPH_HELDOUT_CORPUS_VERSION = 2`, `GRAPH_EVAL_HARNESS_VERSION = 3`, the seed scorer string
  `graph-seed-v3:placement-eligible+content-bearing+historical-traversal+pack-completion`, the embedder
  `multilingual-e5-large-1024-sym`, and `reliefLimit = 50`.
- **WP1 is a behavior change, not a measurement-fidelity change** — the inverse of the harness-v3 bump. It
  must therefore re-baseline the graph gates **only if** a gate actually moves, and a moved gate is a
  finding to investigate, never a value to update.
- **The update-visibility p95 1956.6 ms / 2000 ms tightness must be re-measured at freeze** (register §3,
  "Freeze parameters"), because §9 items 1–5 are the first change since that measurement that plausibly
  moves it.
- The register's WP2 pre-freeze sequence is independent and still open — "freeze behavior + retrieval config,
  then corpus v3, then the GO decision" — and WP1 must not be sequenced as if it discharged it.

---

## 14. Open decisions for the principal reviewer

Ordered by how much they change the implementation, not by severity.

- **D-1 — which durability guarantee is promised.** The measured cost (§6.3) makes this smaller than this
  spec first claimed and changes its character: the *engineering* choice is largely settled (flush
  unconditionally; ~130 ms p95 per mutation is affordable, and group-commit is probably unnecessary), and the
  open question is now a **product statement**, not a performance trade. On darwin, `fsync` buys a
  host-to-device flush and not a platter flush, and `F_FULLFSYNC` is unreachable without a native dependency
  (D1-g). Three honest options: **(a)** flush and claim *"survives process crash + device-ordered"*, reporting
  `powerLossDurable: false` on platforms where that is the truth; **(b)** take a native `fcntl` dependency to
  claim real power-loss durability; **(c)** flush and say nothing new. (a) is the recommendation — it is a
  real improvement on today's page-cache acknowledgement, it is honest on every platform, and it costs
  nothing extra. The principal should confirm the wording of the claim, because it is what users will read.
- **D-2 — flipping `strictPrincipal` retroactively hides unstamped records from their current users.** Ship
  it only with a usable migration verb (item 12), or behind an explicit opt-in? The two-store leak is open
  *today*; the cost of closing it is a one-time visibility change for users who never set
  `KCRIB_PRINCIPAL_ID`. There is no free option and the spec will not pretend otherwise.
- **D-3 — the persistent FTS corpus** (§7.5): make it principal-scoped (correct, and pays a rebuild per
  principal), or keep the shared corpus (fast, and accepts that a caller's BM25 term statistics include a
  co-tenant's records)? This is the only place where the honest description is "a weak cross-principal
  channel", so the decision is the principal's to make explicitly.
- **D-4 — the generation fields** (§7.2): drop `graphGeneration`/`searchGeneration` as structurally
  meaningless, or repoint them at `MemoryGraphIndex`'s `++graphPublication`? Dropping is honest and shrinks
  the response contract; repointing keeps a field and gives it meaning. No runtime consumer outside
  `readerFreshness` construction and tests was found, so the blast radius is low either way.
- **D-5 — scope boundary.** WP1 as written covers memory state. There is a second family of bare
  `writeFileSync` calls with **no** temp+rename at all, writing agent/tool config and installed worker
  scripts (`adapters.ts:651,742,989,1106`; `mcp-install.ts:404,589,665,978,1022`;
  `hooks.ts:222,241,314,324,332,408`) **[R]**. They are not memory state, so they are excluded here — but
  they are also not durable, and `scripts/client-certify.mjs` and `packages/ui` were not audited at all.
  Confirm the boundary excludes them, or widen WP1 before implementation rather than after.
- **D-6 — `countUnstampedRecords` discloses the count of unattributed records** (§8.5). Low severity, and
  arguably necessary for the doctor to be useful. Keep, or report only a boolean?
