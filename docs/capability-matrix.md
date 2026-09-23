# Knowledge Crib — capability matrix

**Dated 16 September 2026.** Branch `debug/auditMaster`. The launch promise is policy version 5 —
seven clients on three native platforms, twenty-one cells, no waivers, plus the connected memory
graph — and **no cell is certified yet and the graph gate fails, so the release is NO-GO**; [Clients](#clients) below says what that does and does not mean. This
page states what has been MEASURED, on what, and what has not. It is the support boundary: if a
capability is not listed as verified here, treat it as unverified regardless of what any other
document claims.

Every row names its evidence. Rows about in-repo artifacts link to them; the client certification
grid names each cell's receipt file instead — receipts are release artifacts published **outside
the candidate source tree**, so a repo-relative link would point at a path this repository does
not carry. A row with no evidence named is a claim, and there are none of those here by design.

## What was tested, and on what

| | |
|---|---|
| Host | Apple M4 Max, arm64, 48 GiB |
| OS | macOS (darwin) — **the only platform exercised** |
| Node | v22.23.1 |
| Packages | 8 workspace packages @ 0.1.0 |
| MCP surface | 17 tools / 47 operations |
| Test suite | full suite green, `pnpm verify` exit 0 — counts in [`STATS.md`](STATS.md) |
| Language extractors | 10 — [`STATS.md`](STATS.md) reports **11 parser languages**, a count of extractor subdirectories, of which 10 are exercised by the deep-fuzz set |

Nothing below has been exercised on Linux or Windows. That is not a hedge — no run exists.

## Core capabilities

| Capability | State | Default? | Evidence |
|---|---|---|---|
| Deterministic code graph (index, query, context, impact) | verified | on | [`STATS.md`](STATS.md), full suite green |
| `review` — change review from the graph | verified | on | [`bench/review-cost.md`](bench/review-cost.md) |
| Always-fresh reads while editing (`serve --watch`) | verified, 805-file scale | opt-in | [reference watch run](audits/2026-09-05/evidence/repair/full-watch-results.json) |
| Durable agent memory (record → admit → recall) | verified | opt-in (`crib memory init`) | [audit §R02/R03](audits/2026-09-05/post-merge-reaudit.md) |
| Session resume after an IDE timeout | protocol verified; runtime certification in progress | on when memory is initialised | [audit §R06](audits/2026-09-05/post-merge-reaudit.md) |
| On-device semantic recall | verified | **opt-in** (`crib embed setup`) | [`bench/onnx-model-ladder.md`](bench/onnx-model-ladder.md) |
| Background freshness worker (`auto` mode) | verified with caveats | opt-in | [worker recovery](audits/2026-09-05/evidence/repair/worker-recovery.json) |
| Memory home (web UI) | verified | opt-in (`crib viz`) | [audit §R08](audits/2026-09-05/post-merge-reaudit.md) |
| Encrypted cross-device sync | synthetic soak only | opt-in | [sync soak](audits/2026-09-05/evidence/reaudit/sync-soak.json) |
| Team memory over Git | implemented; not multi-user tested | opt-in | — |
| Authenticated multi-tenancy | **out of scope, permanently** — a decided product boundary, enforced by refusing any non-loopback bind | — | [`SECURITY.md`](../SECURITY.md), `http-boundary.test.ts` |

## Semantic retrieval — the numbers, what they cost, and WHAT THEY MEASURE

**Scope, stated first because it is the easiest row on this page to misread.** Every number in this
section measures **memory-ledger recall** — the ranking of `MemoryRecord`s by `MemoryScorer`
(`packages/memory/src/fusion.ts`), reached through `crib memory recall` / the `brief` and `memory`
verbs. The corpus is 500 labelled queries over **307 memory records**. **None of it measures code
search.** Code retrieval is a different index (`SqliteIndexStore` over the code graph), a different
corpus, and a different default — see the two rows below the ladder.

Measured through the launch gate on the frozen 500-query corpus
([`bench/onnx-model-ladder.md`](bench/onnx-model-ladder.md)). **No Python.**

| Tier | G2 paraphrase (≥80%) | G3 MRR (≥0.75) | Gates | Download |
|---|---:|---:|---:|---:|
| none — char-ngram fallback | 2.6% | 0.520 | 6/8 | 0 |
| `--model small` | 66.0% | 0.672 | 6/8 | 97 MB |
| `--model base` | 69.9% | 0.841 | 7/8 | 1.1 GB |
| **`--model large`** (default) | **81.1%** | **0.881** | **8/8** | 2.1 GB |

The advertised semantic tier is `large` and nothing else clears every gate. **A machine that has not
run `crib embed setup` serves the char-ngram fallback** and is at the top row — `crib doctor` and
`crib embed status` both say so rather than implying otherwise.

### Code retrieval — a separate index, a separate default, a separate measurement

| Capability | State | Default? | Evidence |
|---|---|---|---|
| Lexical code search (FTS5 BM25 over names/signatures/headings/files/bodies + static synonym table) | verified | **on** | full suite green; `crib query` |
| Vector code search (RRF hybrid BM25 ∪ cosine + deterministic structural rerank) | **measured: MRR 0.057 → 0.286 vs lexical** on a 20-question labelled corpus; opt-in, no pre-registered gate | **off** — `crib index --vectors` | [`scripts/eval/code-vector-eval.mjs`](../scripts/eval/code-vector-eval.mjs) |
| Discovery excludes sub-symbol fragments (statements/conditions/assignments) | verified | on (`includeDetail` opts back in) | `verbs.test.ts` "F14 — discovery excludes sub-symbol detail by default" |
| Second-stage cross-encoder reranker | **implemented and MEASURED AS A LOSS on both surfaces** — do not enable | **off**, `crib rerank setup` | [`scripts/eval/memory-rerank-eval.mjs`](../scripts/eval/memory-rerank-eval.mjs), `code-vector-eval.mjs --rerank` |

The second row is the honest state and the reason it is stated separately. The hybrid path exists in
`SqliteIndexStore.query` and `index/rerank.ts`, and `crib index --vectors` builds the vectors it
needs. What exists now is a **comparison harness** (`node scripts/eval/code-vector-eval.mjs`) that
scores the same labelled corpus through a lexical and a hybrid store over the same sqlite file. What
still does **not** exist is a *pre-registered* gate with a frozen floor, so `--vectors` remains an
opt-in capability rather than a quality claim, and the ONNX ladder above still does not cover it.
Two further limits the harness states itself: it cannot isolate the contribution of body text from
the contribution of having vectors at all (that would need a second embedding recipe kept alive in
production for the harness's benefit), and 20 questions on one repository authored by someone who
knows it is a regression gate, not an external benchmark.

**Its exit code is a three-outcome gate, and it names the arm it graded** (H-6, 2026-09-23). Before
this the harness could report a lexical number under a hybrid framing: with the vector channel
refused, `--min-mrr` silently graded the LEXICAL MRR and printed nothing about which arm it used.
Now: `PASS (0)` when the run measured what it claims and any `--min-mrr` floor was met; `FAIL (1)`
when the graded arm fell below it; **`UNAVAILABLE (2)`** when the channel could not be measured at
all — the case where an embedder is installed but the index withheld the vectors, which is
actionable and so is never a silent pass. With no embedder installed the run states it is
lexical-only and prints no hybrid column. A CI gate that means "the hybrid arm must have run" passes
`--require-hybrid` and gets UNAVAILABLE rather than a green light from the wrong arm.

### The measured code-retrieval numbers

`node scripts/eval/code-vector-eval.mjs` on this repository, 2026-09-21, same 20-question labelled
corpus as `semantic-retrieval-eval.mjs`, both columns reading the SAME sqlite file so only the
retrieval path varies:

| path | top-1 | top-3 | found@10 | MRR |
|---|---:|---:|---:|---:|
| lexical (BM25, the default) | 0/20 (0%) | 1/20 (5%) | 6/20 (30%) | 0.057 |
| hybrid (`--vectors`, e5-large) | **4/20 (20%)** | **7/20 (35%)** | **9/20 (45%)** | **0.286** |

**Read the absolute numbers, not only the ratio.** MRR improves 5×, and 9 of 20 questions rank
better — but 3 REGRESS (secret indexing, cross-repo blast radius, response bounding each fall out of
the top 10), and top-1 at 20% means the right file is usually still not first. This is a real
improvement over a weak baseline, not a solved problem, and it is why the row above says "no
pre-registered gate": there is no frozen floor yet, and a corpus of 20 questions on one repository
authored by someone who knows it cannot carry one.

**What it costs**, measured on the same tree (`/usr/bin/time -l`):

| index | wall | peak RSS | vectors written |
|---|---:|---:|---:|
| `crib index` (lexical) | 86 s | 0.81 GB | — |
| `crib index --vectors` (surface only, v1 recipe, all node kinds) | 421 s | 4.87 GB | 48,459 |
| `crib index --vectors` (surface + body, v2 recipe, discovery kinds only) — COLD cache | **1,444 s** | 4.83 GB | 10,185 |
| the same build with a WARM embedding cache | **202 s** | — | 10,185 |

v2 embeds 4.8× FEWER nodes than v1 and still takes 3.4× longer, because each embedding carries ~15×
more tokens — 24 minutes for a 185K-LOC repository on a COLD cache, and 16.8× the lexical build.

**The warm number is the one most users will see, and it is much better.** The generated embedder
caches each vector by content hash under `~/.cache/crib-embed-vec/<embedder-id>`, so a re-index only
embeds what changed: the same build repeated took **202 s** (7.1× faster) with 20,611 cached vectors on
disk. The cold figure is the honest first-run cost and the warm figure the honest steady-state one;
quoting only one of them misleads in one direction or the other.

### The reranker: implemented, measured, and NOT enabled

A cross-encoder second stage exists (`crib rerank setup`, `packages/core/src/rerank/`) because
`packages/memory/src/fusion.ts` had declared a `Reranker` port on the back of a measured precision
gap. Measured against both corpora on 2026-09-21, it is a **loss on both**:

| surface | first stage | + cross-encoder |
|---|---|---|
| memory (frozen 500-query gate) | gates 8/8, G2 81.0%, MRR 0.881, 0.4 s | gates 7/8, **G2 44.4%**, **MRR 0.762**, 207 s |
| code (20-question corpus) | MRR 0.287, top-3 7/20 | MRR 0.267, top-3 5/20 (found@10 rose 9→10) |

**Why, and it is not a bug in the reranker.** The 43.8%-top-5 gap that motivated the port was measured
with `multilingual-e5-base`, and [`bench/launch-gates.md`](bench/launch-gates.md) records that it was
closed *without* a second stage — the larger bi-encoder took G2 to 71.9% and embedding the claim alone
took it to 81.0%. A second stage helps a weak first stage and damages a strong one, and the first stage
is now strong. `fusion.ts` carried the superseded motivation as if it were current; it is now annotated.

So the tier ships **off**, nothing wires a reranker in by default, and the model choice is still
recorded because it mattered: `ms-marco-MiniLM` (~90 MB) could not separate relevant code from
irrelevant code at all (it scored an unrelated `renderMarkdown` above the relevant `withLock`), while
`bge-reranker-base` (~1.1 GB) ordered the same probe correctly — and even that one loses on the corpora.
Re-measure with `node scripts/eval/memory-rerank-eval.mjs` before enabling it; a future first-stage
regression is the only condition under which the arithmetic changes.

A machine that has not run `crib embed setup` cannot build vectors at all: `crib index --vectors`
refuses rather than silently embedding with the char-ngram fallback, which R1 measured as worse than
pure lexical. Building vectors is also not free — see the cost note in
[`audits/2026-09-20`](audits/2026-09-20/graph-memory-rag-audit.md) — and the embedded text recipe is
versioned, so an index built by an older recipe is refused on reopen rather than ranked across two
different vector spaces.

The ONNX path reproduces the previous Python configuration on all three models measured both ways
(81.0/81.05, 69.9/69.93, 66.0/66.01), which is the evidence the toolchain swap changed the install
and not the ranking.

## Clients

**Launch scope (policy version 5, `scripts/launch-policy.json`, frozen 2026-09-16).** The promised
boundary is **seven clients on three native platforms — twenty-one cells, no waivers**. A cell is
Claude Code, GitHub Copilot, Cursor, VS Code, Codex, Windsurf or Gemini on macOS, native Linux or
native Windows, and it is met only by a vendor-client runtime receipt for the exact candidate
package: record → connect and supersede in the memory graph → interruption/restart → authorized
resume and connected-history retrieval, driven through the real client binary. Version 5 keeps that
boundary and certifies it under client certification receipts at format version 4 — nine legs, the
ninth (`connectedMemory`) proving `graph_propose` and `memory_graph` on the wire — with acceptance
receipts at format version 2 and the correlated protocol and process evidence those schemas
require. Receipts from older format versions stay readable as history but cannot certify a cell.

There is **no preview tier** under version 5. Version 2 had narrowed the promise to Claude Code on
macOS and named the other twenty cells preview; that narrowing and its `uncertified` escape hatch
are gone, and version 3's removal of them stands. A cell that cannot be executed leaves the release
**NO-GO** rather than becoming preview.

**No cell is certified today, so the launch decision is NO-GO**, with a named
`client-cell-uncertified:*` blocker for every cell. **As of 2026-09-21 that no longer holds a release**
(F17): `scripts/launch-decision.mjs` reports certification and release as two verdicts. `decision`
keeps its exact meaning — `GO` only when every advertised cell is certified — and a second verdict,
`release`, reads `RELEASABLE` when every gate, receipt, model and tree check passed and the *only*
outstanding items are client cells with no vendor receipt. A release on that basis must publish the
per-cell support table below, which reads `not certified` for exactly those cells.

The split is narrow on purpose, and the line is between an absence and a falsehood: a missing receipt
(`client-cell-uncertified:*`) is release-permissible, while a manifest CLAIMING a runtime pass its
receipts do not support (`certification-summary-unsupported:*`) still blocks — a release may ship with a
cell uncertified, never with a manifest that lies about one. Every gate failure, stale or foreign
receipt, dirty tree, missing model and absent global receipt still blocks too. The exit status of the
script continues to track certification, so no existing caller silently inherits the weaker verdict.

That is the correct output and not a defect of
this page: the twenty-one real cells need a signed-in vendor client on a native host of each
platform, and where that combination is unavailable the policy requires the release to stay NO-GO
until it becomes executable — or until the promise itself is changed by a new policy hash.

WSL is **not** a native runtime. A run inside WSL reports `process.platform` `linux` from a Windows
host and can never satisfy a native Linux or Windows cell; the table below shows such a run as
failing the cell, and labels it.

`crib setup` (and `crib init`) wires every supported client. The following support state is generated
from strict certification receipts; configuration or protocol probes cannot be promoted to a runtime
claim by editing this document.

The committed block below is the **contract view**: it is regenerated bare — with no receipt
directory — by the same generator the release gate runs, so every cell reads `not certified` until
receipts exist, and the committed block can never go stale against evidence that lives outside the
tree. The receipt-backed matrix is a **published release artifact**, generated beside the receipts
with `client-certification-matrix.mjs --receipts <dir> --stdout` and never committed here: a receipt
certifies a commit, so committing it into the tree it certifies would change the commit the
evidence names. When a certified run exists, read the published support matrix for its states; the
committed grid below stays the promise, not the record.

<!-- client-certification:generated:start -->
## Client certification evidence

Generated under launch policy version 5 (`sha256:4fd72a8ca07db4115f8a40f3589eee22e2994ebe720047932f44652fface2a00`). Every state below is judged against that exact frozen contract; a receipt naming any other hash is evidence about the run and never a certified cell.

Generated from validated receipts. A client is runtime verified only when a vendor-client receipt proves record → connected memory → interruption/restart → authorized resume on the listed platform. Four labels say a row is evidence and not a runtime pass: "protocol evidence only (test client)" when the handshake came from a test client rather than the client under test, "runtime evidence only (not a native runtime)" when the run happened somewhere other than the native platform — a WSL run satisfies every leg and still cannot certify native Linux or Windows — "runtime evidence only (legacy receipt schema)" when the receipt predates the certifying schema and is kept as readable history, and "runtime evidence only (collected under a different policy)" when the receipt was collected under a policy hash other than the one named above. No label can promote a row.

| Client | Highest verified evidence | Strongest certified cell |
|---|---|---|
| Claude Code | not certified | — |
| GitHub Copilot | not certified | — |
| Cursor | not certified | — |
| Codex | not certified | — |
| Windsurf | not certified | — |
| Gemini | not certified | — |
| VS Code | not certified | — |

### Cells — every client on every native platform

One row per advertised cell. A cell is certified only by a vendor-client receipt for that exact client on that native platform; the summary above is per client and can read stronger than any single cell.

| Client | Platform | Runtime status | Client version | Host | Candidate commit | Package digest | Certified | Receipt |
|---|---|---|---|---|---|---|---|---|
| Claude Code | macOS | not certified | — | — | — | — | — | — |
| Claude Code | Linux | not certified | — | — | — | — | — | — |
| Claude Code | Windows | not certified | — | — | — | — | — | — |
| GitHub Copilot | macOS | not certified | — | — | — | — | — | — |
| GitHub Copilot | Linux | not certified | — | — | — | — | — | — |
| GitHub Copilot | Windows | not certified | — | — | — | — | — | — |
| Cursor | macOS | not certified | — | — | — | — | — | — |
| Cursor | Linux | not certified | — | — | — | — | — | — |
| Cursor | Windows | not certified | — | — | — | — | — | — |
| Codex | macOS | not certified | — | — | — | — | — | — |
| Codex | Linux | not certified | — | — | — | — | — | — |
| Codex | Windows | not certified | — | — | — | — | — | — |
| Windsurf | macOS | not certified | — | — | — | — | — | — |
| Windsurf | Linux | not certified | — | — | — | — | — | — |
| Windsurf | Windows | not certified | — | — | — | — | — | — |
| Gemini | macOS | not certified | — | — | — | — | — | — |
| Gemini | Linux | not certified | — | — | — | — | — | — |
| Gemini | Windows | not certified | — | — | — | — | — | — |
| VS Code | macOS | not certified | — | — | — | — | — | — |
| VS Code | Linux | not certified | — | — | — | — | — | — |
| VS Code | Windows | not certified | — | — | — | — | — | — |

<!-- client-certification:generated:end -->

<!-- connected-memory-graph:generated:start -->
## Connected memory graph

**Not certified.** No validated `connected-memory-graph` receipt was supplied. Judged under launch policy version 5 (`sha256:4fd72a8ca07db4115f8a40f3589eee22e2994ebe720047932f44652fface2a00`).
<!-- connected-memory-graph:generated:end -->

Each cell's receipt is produced by **one harness**, `scripts/client-certify.mjs`:

```
node scripts/client-certify.mjs --client <id> --package <tarball> \
  --candidate-commit <sha> --out <receipts-dir>
```

It installs the exact candidate package into an isolated prefix, generates the config through the
shipped installer, then drives the real vendor binary through eight legs: configuration, handshake,
tool use, record, a SIGKILL interruption, a restart that recovers the recorded intake, an authorized
resume, and a foreign-principal exclusion check. `client-certify-claude.mjs` is a thin forwarder that
delegates the run and re-implements no leg — a second copy of the leg logic would be two receipts
that mean different things.

Two rules the harness enforces by refusing rather than by documenting. `--package` describes bytes
that already exist and never rebuilds them, because `pnpm pack` orders dependency keys
non-deterministically and a rebuild mid-pass would silently re-point every receipt at unverified
bytes; the artifact is re-hashed before and after each check. And the restart leg requires a real
answer to the handoff query — a client that exits 0 without answering has proven no session, which
is the same error as reading a handshake out of an exit code.

It must be run from a terminal where that client is logged in; a nested non-interactive launch cannot
authenticate, and an unauthenticated client certifies nothing.

A Copilot-shaped test client is protocol evidence only; it is never a vendor-runtime certification,
and neither is a config file that parses.

## SCIP interop — what crosses the boundary, and what does not

Knowledge-crib reads and writes the [SCIP Code Intelligence Protocol](https://github.com/sourcegraph/scip),
the format compiler-backed indexers emit (scip-typescript, scip-java, scip-go, scip-python,
rust-analyzer). `crib scip import <index.scip>` folds one into the extracted graph;
`crib scip export --out index.scip` emits the graph for tools that read the standard. No protobuf
runtime is added — the wire subset SCIP uses is decoded in `packages/core/src/scip/wire.ts`, which
keeps the packaged CLI inside its dependency budget.

**Importing MERGES with the native graph; it does not shadow it.** Imported symbols are given ids in
crib's own grammar (`sym:<path>#<qualifiedName>@L<line>`), reconstructed from SCIP descriptors, so a
symbol crib already parses lands on the SAME node. Measured on this repository, re-importing crib's
own export matched 6,949 of 6,952 ids (100.0%); the three misses are nodes two extractors emit with a
zero start line, which the 1-based id grammar does not permit.

| direction | carried | not carried |
|---|---|---|
| import | definitions (as `symbol` nodes), file membership, references (as `references`), `is_implementation` (as `implements`), `enclosing_symbol` (as `member-of`), the indexer's `Kind` and `display_name` | `calls` (SCIP does not distinguish invoking a symbol from naming it), cross-package targets (counted, not minted), `local` symbols, `signature_documentation`, diagnostics |
| export | definitions with `SymbolRole.Definition`, declaration extents via `enclosing_range`, `Kind`, display names, `implements`/`inherits` as relationships | **references** (see below), doc sections, clusters, tables, owners, sub-symbol detail |

**Two model gaps, both structural.**

1. **Crib spans are lines; SCIP ranges are characters.** The extractors never retain column offsets, so
   an exported occurrence starts at character 0. Go-to-definition lands on the right line; a
   name-width highlight cannot be produced.
2. **A crib edge has no call site.** `Edge` records `src`, `dst`, `rel`, `method`, `confidence` and
   `evidence` — no line. A SCIP reference *is* a position, and the only position available for a
   `references` edge is the referencing symbol's own declaration line, which would put demonstrably
   wrong positions into a file other tools read. The export therefore omits references entirely:
   go-to-definition and type hierarchy work over a crib-exported index, find-references does not.

Both commands print these qualifications on every run; they are not behind a verbose flag.

**Not yet established.** No live indexer has been executed against a fixture and imported end to end.
The decoder is tested against hand-assembled wire bytes (including the deprecated packed `range` field
that every deployed indexer still writes) and against descriptor runs taken verbatim from the SCIP
project's committed snapshot outputs. Run a first import from an unfamiliar indexer with `--dry-run`
and read the counts it reports before committing it.

## Known limits — read this before adopting

These are open, disclosed rather than fixed. None is a surprise waiting to be found.

1. **The shipped package is not byte-reproducible.** Building the same clean commit twice produces
   two different tarball digests. The contents are identical — 88 of 88 files match — but `pnpm
   pack` resolves `workspace:*` to a concrete version at pack time and rewrites the dependency keys
   in a non-deterministic ORDER, so the packed `package.json` differs and the digest with it. Three
   consecutive builds of one commit produced three distinct hashes.

   What this does NOT undermine: the release chain never rebuilds. One artifact is built, verified,
   carried through as a workflow artifact, and the publish step checks the downloaded bytes against
   the digest the decision approved. Evidence stays bound to the artifact it describes. That digest
   is a **checksum** — it says which bytes a receipt examined — and nothing more: no provenance
   attestation of how those bytes were produced exists, so none is claimed.

   What it DOES mean: you cannot independently rebuild this commit and confirm you got the published
   bytes, and any rebuild mid-collection invalidates every receipt already gathered — which is why
   `scripts/collect-acceptance-receipts.mjs` builds once, up front, and prints the digest the whole
   pass describes. Fixing it properly means normalising the packed manifest's key order.

1. **macOS only.** Service supervision (`crib freshness service`) generates Linux systemd and
   Windows Task Scheduler definitions that have never been installed or started on those platforms.
   The Windows task declares UTF-16 while the writer emits UTF-8, and the Linux unit does not quote
   a CLI path containing spaces. Both are known-wrong and unfixed.
2. **No authenticated multi-tenancy — by decision, not by omission.** The HTTP boundary is local
   Host/Origin validation plus a body cap; identity, membership, revocation and scoped audit export do
   not exist and are not planned. As of 2026-09-21 this is enforced rather than advised:
   `serveHttp` refuses to bind anywhere but loopback, because the Host check validates against the
   bound address and would otherwise start approving remote callers. Reaching the graph from another
   machine means an authenticating proxy in front of a loopback bind, or stdio.
3. **CI semantic evidence is expensive.** CI and tagged release jobs provision the supported model
   on macOS, Linux and Windows and cache it by the pinned setup inputs. A cold cache downloads the
   model independently on each platform before `release:evidence --require-pass` can pass.
4. **A busy worker lease is bounded.** Synchronous parsing can block the normal heartbeat. An active
   task therefore gets a ten-minute grace window; epoch fencing still prevents a late owner from
   publishing after takeover, and a live task that exceeds the grace may be repeated.
5. **Memory home actions remain local guidance.** Pending and resumable tiles expose the relevant
   queue or saved work, but memory admission and intake execution remain explicit CLI or agent actions.
6. **Only watched readers overlay a clean checkout.** A fresh manual reader still serves the last
   indexed commit until `crib update`; status reports `aheadOfVcsHead: true` rather than hiding it.
7. **Cross-device sync is synthetic.** A two-device file-backend soak over v1 records, with no
   power-loss or fsync claim. Not a cross-platform network trial.
8. **The lexical index curve is linear to 200K LOC; the VECTOR build is 16.8× the lexical cost.**
   Re-measured 2026-09-21 ([`bench/scale-curve.md`](bench/scale-curve.md)): 50K→100K→200K LOC costs
   2.01× then 2.05× the time for 2× the corpus, with throughput flat within 4.5% and MB/kLOC falling.
   An earlier published curve showed a throughput collapse; it was stale and is superseded. Still
   unmeasured: the 1M-LOC point, and any scale point at all for `--vectors`, whose build cost is a
   different curve (1,444 s vs 86 s on this repository). Vector search is also a full-table cosine
   scan — no ANN ships, so query cost grows linearly with the vector count.

9. **Graph coverage is partial and says so.** 5,419 unresolved call sites on this repository;
   `status({op:'gaps'})` reports `analysisReadiness: incomplete`. An empty `impact` result is not
   evidence a symbol is unused.

## What would change these rows

- Linux/Windows: a native install/start/restart/uninstall run per platform.
- Multi-tenancy: an identity-bound authorization contract, then a penetration test.
- CI receipt: provision the model in the workflow and archive the receipt per release.
- Clients: twenty-one vendor receipts — each client driven through remember → SIGKILL timeout →
  authorized resume on a native host of each platform. A protocol probe, a WSL run or a receipt for
  a different candidate package closes none of them.

Until those exist, this page stays as written. Historical audit reports under
[`audits/2026-09-05/`](audits/2026-09-05/) remain immutable — they record what was true on their own
date; this page is the current companion to them.
