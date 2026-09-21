# Knowledge Crib — capability matrix

**Dated 15 September 2026.** Branch `debug/auditMaster`. The launch promise is policy version 4 —
seven clients on three native platforms, twenty-one cells, no waivers — and **no cell is certified
yet, so the release is NO-GO**; [Clients](#clients) below says what that does and does not mean. This
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
| Authenticated multi-tenancy | **not implemented** | — | [`SECURITY.md`](../SECURITY.md) |

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
| Vector code search (RRF hybrid BM25 ∪ cosine + deterministic structural rerank) | implemented, opt-in, **measured on a 22-question labelled corpus — no pre-registered gate** | **off** — `crib index --vectors` | [`scripts/eval/code-vector-eval.mjs`](../scripts/eval/code-vector-eval.mjs) |
| Discovery excludes sub-symbol fragments (statements/conditions/assignments) | verified | on (`includeDetail` opts back in) | `verbs.test.ts` "F14 — discovery excludes sub-symbol detail by default" |

The second row is the honest state and the reason it is stated separately. The hybrid path exists in
`SqliteIndexStore.query` and `index/rerank.ts`, and `crib index --vectors` builds the vectors it
needs. What exists now is a **comparison harness** (`node scripts/eval/code-vector-eval.mjs`) that
scores the same labelled corpus through a lexical and a hybrid store over the same sqlite file. What
still does **not** exist is a *pre-registered* gate with a frozen floor, so `--vectors` remains an
opt-in capability rather than a quality claim, and the ONNX ladder above still does not cover it.
Two further limits the harness states itself: it cannot isolate the contribution of body text from
the contribution of having vectors at all (that would need a second embedding recipe kept alive in
production for the harness's benefit), and 22 questions on one repository authored by someone who
knows it is a regression gate, not an external benchmark.

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

**Launch scope (policy version 4, `scripts/launch-policy.json`, frozen 2026-09-15).** The promised
boundary is **seven clients on three native platforms — twenty-one cells, no waivers**. A cell is
Claude Code, GitHub Copilot, Cursor, VS Code, Codex, Windsurf or Gemini on macOS, native Linux or
native Windows, and it is met only by a vendor-client runtime receipt for the exact candidate
package: record → interruption/restart → authorized resume, driven through the real client binary.
Version 4 keeps that boundary unchanged and names the evidence contract it is certified under —
client certification receipts at format version 3 (acceptance receipts at format version 2), with
the correlated protocol and process evidence those schemas require. Receipts from older format
versions stay readable as history but cannot certify a cell.

There is **no preview tier** under version 4. Version 2 had narrowed the promise to Claude Code on
macOS and named the other twenty cells preview; that narrowing and its `uncertified` escape hatch
are gone, and version 3's removal of them stands. A cell that cannot be executed leaves the release
**NO-GO** rather than becoming preview.

**No cell is certified today, so the launch decision is NO-GO**, with a named
`client-cell-uncertified:*` blocker for every cell. That is the correct output and not a defect of
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

Generated under launch policy version 4 (`sha256:2761abf1a666ad4a1f0ccf16dfaa94272f65db0feabeed417aaaa634f26025b1`). Every state below is judged against that exact frozen contract; a receipt naming any other hash is evidence about the run and never a certified cell.

Generated from validated receipts. A client is runtime verified only when a vendor-client receipt proves record → interruption/restart → authorized resume on the listed platform. Four labels say a row is evidence and not a runtime pass: "protocol evidence only (test client)" when the handshake came from a test client rather than the client under test, "runtime evidence only (not a native runtime)" when the run happened somewhere other than the native platform — a WSL run satisfies every leg and still cannot certify native Linux or Windows — "runtime evidence only (legacy receipt schema)" when the receipt predates the certifying schema and is kept as readable history, and "runtime evidence only (collected under a different policy)" when the receipt was collected under a policy hash other than the one named above. No label can promote a row.

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
2. **No authenticated multi-tenancy.** The HTTP boundary is local Host/Origin validation plus a body
   cap. Identity, membership, revocation and scoped audit export do not exist. Do not expose the
   server beyond the local trust model.
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
8. **Graph coverage is partial and says so.** 5,419 unresolved call sites on this repository;
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
