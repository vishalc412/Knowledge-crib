# ADR-003 — Gate 4 cross-device sync: immutable event protocol, encrypted outbox, user-owned backends

- **Status:** Accepted (design wave: 3 independent designers + completeness critic, run wf_0da08fe1-0ac)
- **Date:** 2026-09-03
- **Milestone:** Gate 4 (superset plan)
- **Supersedes:** the honest `syncNotAvailable()` placeholder in `packages/memory/src/api.ts` (which names this gate) and Gate 3's follow-up note that on-device model/sync concerns might land here.

## The plan requirement (verbatim, hard constraints)

> Local-first: one immutable event protocol, no multi-tenant service.
> - Local **append-only event log** + encrypted outbox.
> - **Idempotent push/pull** via event ids and server cursors.
> - Immutable records merge by content id; concurrent incompatible decisions remain explicit conflicts, never last-write-wins.
> - **Private memory never enters Git.** Git-projected workspace memory stays reviewable.
> - **Logical tombstones + a documented physical purge workflow.** Git history cannot provide irreversible deletion.
> - Sync backend is **user-owned storage** (their own remote), not a service crib operates.

## Converged design

The three design axes converged under the critic's rulings. Where axes contradicted, the ruling is recorded with the reason.

### D1 — Event envelope and id seed (the ruling that collapses four downstream specs)

One envelope, in the existing ids.ts grammar — no parallel id universe:

```
evt:<blake3Hex(canonical({ kind, store, repoId?, body }))>
```

where `body` is the **canonical entry JSON** (the same `canonicalMemoryJson` the shards store — the event is a wrapper, never a re-encoding). `deviceId`, `principalId`, `ts` are **envelope metadata only — never in the seed**; there is **no seq and no prev-chaining** (chaining makes two devices' independently-derived events for one claim distinct and unreconcilable, reintroducing the merge problem the content-addressed id already solved; the belief model answers ordering bi-temporally via validTime/transactionTime). The frozen-seed law applies: the seed is frozen once landed.

Event kinds: `record.upsert` · `decision.append` · `feedback.append` · `purge.mark` · (tombstones ride `decision.append` as retract/supersede — see D6). Never shipped: `candidates`, `outbox`, `dead`, `attempts`, `aliases` (device-local queue/staging/migration state), and **`receipts` are excluded from v1** — `GLOBAL_COLLECTIONS` cannot hold them (store.ts:85) and their evidence anchors are device-bound (gate executables, worktree digests); a pulled record citing a foreign receiptId revalidates degraded honestly, which the evaluator already does.

Envelope line (own JSON schema `sync-event.schema.json`, Ajv dispatch on the `evt:` prefix in validate.ts/loader.ts):

```json
{ "id": "evt:<blake3>", "schemaVersion": "1", "kind": "record.upsert",
  "store": "local" | "global", "repoId": "<id, present iff store==='local'>",
  "deviceId": "<uuid>", "principalId": "<id>", "payloadId": "<entry id>",
  "payload": <canonical entry>, "ts": "<iso>", "meta": { "origin": "write" | "bootstrap" | "pull" } }
```

Unknown `schemaVersion`/format fails closed (loader.ts MemorySchemaVersionError pattern).

### D2 — Sync scope: local + global stores only; team stays git-only

The engine syncs the repo-scoped **local** store and the machine **global** store. The **team store is NOT a sync participant**: git **is** its backend (`.crib/memory/team/**/*.jsonl` via the `kcrib-memory` strict merge driver) and must stay reviewable in PRs — folding an encrypted, unreviewable channel over it would create two divergent team truths. Backfill source per store (the one-line clause that prevents an entire silent-no-op bug class): local ⇒ the **`active`** collection, global ⇒ **`records`** (mirrors recall.ts:316-336 `gatherRecall` sources).

**Amendment (completion implementation, accepted):** `repo.id` is a per-checkout `randomUUID` and `.crib/` is gitignored, so the manifest id can never match across two real clones — every local-scope peer event would be rejected as `different-repo`. Local-scope sync therefore keys on an explicit **`syncRepoId`** stored in the sync config (`crib memory init-sync --sync-id <id>`; generated once if omitted) and threaded identically through event derivation, `seedSyncBaseline`, push, pull, and the purge remote leg. Global-scope sync is unaffected (no repoId in its seed).

### D3 — Store representation: store-root sidecars, NOT new MemoryCollections

The outbound queue is `<storeRoot>/sync-outbox.jsonl` + `<storeRoot>/sync-state.json` (cursors, acked/seen event ids, conflicts ledger, purge ledger) — the same class of sidecar as `fts.gen` and `distill-state.json`, deliberately **outside the closed `MemoryCollection` union** (no manifest count-key churn, no BM25 corpus pollution, no FTS `isRecordCollection` hazard) and outside the merge driver's `*.jsonl` claim. Because the sidecar path bypasses the store's write gate, the engine MUST invoke `assertValidMemoryEntry` + `assertNoMemorySecrets` itself; a single `stageOutboundEvent()` helper is the ONLY sidecar writer, and a test pins that no other writer exists.

### D4 — Crash-ordering law (outbox.ts's law table, lifted)

The store has no transaction primitive and gains none — the unit is **one store `withLock` hold**. On a user-facing write: store upsert (durable result) FIRST, sync-outbox stage LAST, same lock hold, no async gap. Push: stage → `putObject` → mark acked in sync-state LAST (crash between = at-least-once redelivery; same `evt:` id dedupes). Pull: decrypt → validate → secret-scan → apply → cursor advance LAST. Every crash window heals as an idempotent no-op because push runs a **derive-and-diff reconciliation sweep**: it re-derives `evt:` ids from the store's live entries and enqueues any entry with no pending-or-acked event — so the law is derivable, not hand-encoded per call site.

### D5 — Bootstrap: derive-and-diff, never timestamped snapshots

`crib memory init-sync` walks the syncable collections, derives `evt:` ids from each entry, and appends only events not already in the log (membership test = id derivation). The same routine is the steady-state push heal and the repair path after a lost/corrupt log. **Initial baseline:** first init seeds sync-state with "all current entries acked" so only post-init changes sync; full backfill is an explicit `--backfill` flag (prevents a full remote rewrite on a mature store).

### D6 — Wire format and cursors: dumb blob store, HMAC routing, content-addressed batches

Adapter port (memory stays pure; the port injects the driver, mirroring MemorySoulPort):

```ts
SyncObjectStore { kind: 'file' | 'http';
  probe(): Promise<ProbeResult>;
  putObject(key: string, bytes: Uint8Array): Promise<void>;   // idempotent
  getObject(key: string): Promise<Uint8Array | undefined>;
  listObjects(prefix: string, opts?): Promise<{ keys: string[]; nextAfter?: string }>;
  deleteObject(key: string): Promise<void>;                   // physical-purge only
}
```

v1 backends: **`file`** (a user-owned directory/mounted volume, temp→rename atomic) and **`http`** (generic blob PUT/GET/LIST — S3/R2 ListObjectsV2 and WebDAV PROPFIND map onto it; sigv4 signing is a thin follow-on; a user-side proxy covers day one). **git-shard adapter deferred** (it must run plaintext to be reviewable → a second admission class through the filter and the merge driver — a dedicated later gate, not a rider).

Remote layout: `manifest.json` (format, `keyFingerprint`, `keyEpoch`) · `ev/<hex(HMAC-SHA-256(syncKey, evtId))>` — one encrypted blob per event, key derived from the shared key so push/pull route identically **without decryption** and no plaintext id/claim ever sits on the wire (plaintext blake3 ids would be a claim-confirmation oracle) · `b/<batchId>.json` — batch manifests where `batchId = blake3(canonical(sorted route keys))`, content-addressed so re-push reproduces identical batches; plaintext but carrying ONLY `{v, count, keys: string[]}`. **The batch manifest IS the cursor:** pull = list `b/` → fetch unseen batches → fetch unseen blobs → decrypt → apply → record pulledBatchIds LAST. Correctness never depends on remote ordering or list-after-put visibility (LIST is a paging hint and the backfill repair path only); every re-delivery is a byte-stable no-op. Cursor loss is harmless (re-pull from zero is a no-op storm, never duplication).

### D7 — Encryption: AES-256-GCM per event blob, symmetric key, fail-closed resolution

`node:crypto` `aes-256-gcm`, no new deps. Key resolution, fail-closed (`SyncKeyError` when none): (1) `KCRIB_SYNC_KEY` env (64 hex or 44-char base64); (2) keyfile `<memoryHome>/sync-key` chmod 0600 (`--gen-key` mints 32 random bytes; randomness never feeds an id or hash). Fresh random 12-byte nonce per blob, plaintext in the envelope header (standard GCM; the nonce never feeds an id). **AAD = the canonical plaintext header** `{v, alg, route}` — header tampering breaks the auth tag. Blob = magic `crsy1` + nonce + tag + ciphertext of the event JSON. **Amendment (foundation implementation, accepted):** the literal layout above is internally inconsistent — `route` derives from `evtId`, which is only recoverable after decryption, so the AAD header can neither be absent from the blob nor precede the magic. Shipped layout: `crsy1` (5 bytes) | nonce(12) | headerLen(u16be) | header | tag(16) | ciphertext, with header = canonical `{v, alg, route}` as the AAD (tamper breaks the tag); documented in `crypto.ts`. The **full event payload is encrypted** — nothing about a blob's content class is inferable from its name. Config (`<memoryHome>/sync/<scope>-<id>.json`, KCRIB_MEMORY_DIR-relocatable) stores only a **reference** (`{keySource:'env'|'keyfile'}`) + `keyFingerprint: blake3(key)` + `keyEpoch` — never key bytes, never a bearer token (HTTP credentials: `--secret-env <NAME>`, read at call time). Rotation: `crib memory sync rotate-key` = verify-everything-under-old-key → re-encrypt/re-push under new key → bump `keyEpoch` → operator verifies a second device pulls clean → `--stale-epoch` purge deletes old-key objects. **Operator procedure (accepted, completion implementation):** pull is deliberately fail-closed on an undecryptable blob (D8: an undecryptable blob is indistinguishable from a tampered one without decrypting it — skipping would be trusting the sender). Therefore rotation REQUIRES every device to pull clean **before** `rotate-key` runs; `rotate-key` refuses (typed error) while the local outbox still holds staged-but-unacked events and reports the pending count. A device that missed the window must be re-seeded (`init-sync --backfill` under the new key), not pointed at mid-rotation batches. At-rest plaintext on the remote: manifest + batch digests only. Documented, accepted side-channel: batch manifests leak activity patterns and object counts to the storage host (routing requires plaintext digests) — a decision, not an oversight.

### D8 — Apply law on pull: a total function, never LWW, never in-place mutation

All four input shapes, deterministic and order-independent:

1. **Validate → secret-scan** (fail-closed per object; pull halts at the offending event with the cursor unmoved; an explicit operator `--skip` quarantines it, never deletes).
2. **Re-derive the content id from the payload bytes** with the ids.ts builder for the entry kind — on push AND pull. A mismatch = forged/hand-edited content → hard conflict record, never applied. (Without this, `upsertEntries`' silent replace-by-id would let a corrupt payload overwrite a real claim.)
3. **Absent locally → upsert** through the store's own write gate (`upsertEntries` → FTS write listener → generation bumps — both derived models invalidate **by construction**; the one law: *the sync engine never writes shard files directly*).
4. **Byte-identical → no-op.** **Same id, different bytes → the local copy is retained**, the peer variant recorded in the conflicts ledger `{eventId, payloadId, localDigest, remoteDigest, sourceDevice, seenAt}`, surfaced in sync status and `crib memory audit` until a human resolves by appending an explicit supersede/retract decision. **Never** first-writer-wins, never overwrite by transactionTime, never silent skip.

Same-id-different-bytes is the git merge driver's rule 2/3 posture lifted to sync. Decision-level conflicts (two devices appending incompatible supersede/retract for one subject) surface via the already-shipped `conflictGroups` machinery plus a new pure `decisionConflicts()` (supersede-vs-retract, two different successors on one subject); resolution is **append-only** via `crib memory resolve` — a resolving decision that itself syncs and converges. Pull placement: events land in the **same store role they were pushed from** (`store` field); pulled records keep the pushing device's stamped verdicts (content-addressing forbids re-stamping) and are revalidated against the receiving device's checkout at read time — a dangled foreign anchor degrades honestly, it is never trusted because another device said so.

### D9 — Tombstones and retirement vocabulary (one shape)

Sync deletion is a **`retract` decision event with `subject = recordId`** — the established delete-as-tombstone semantics (api.ts:24-25) and a RETIRING kind (memory-merge.ts:36). Applied by appending the identical `dec:` line into the SAME store role as the subject record, so the W5 no-poison law holds: a pulled repo tombstone suppresses the pulled/own local copy but can never retract a same-id team record (recall's decision pool is team+global only, tombstone.ts:18-27). Ahead-of-record tombstones apply silently but are surfaced in the pull response ("applied tombstone for unknown subject"). Team lines are never deleted — `removeEntry`/`clearStore` refuse team outright and no sync path bypasses them.

### D10 — The hard constraint: private memory never enters Git

The real, code-verified hole today: `supersede` with a payload successor defaults `visibility` to `'private'` (api.ts:1568) and routes the successor via `decisionStoreFor` (api.ts:1524), which **prefers the team store** (api.ts:1911-1918) — a private successor can already reach the git-projected shard today. Fix at the only unbypassable layer: **`MemoryStore.assertWritable` gains a fail-closed guard — for `role === 'team'`, any v2 entry with `visibilityOf(record) === 'private'` is refused**, for ALL writers. `proposeTeam` gains the same guard (prophylactic; today it writes only v1 records, implicitly workspace). Pull-apply never routes private payloads to team. The same commit audits existing committed team shards for private-visibility v2 lines. **Implementation (accepted):** the audit ships as a read-only `teamPrivateLines` section in `crib memory audit` — it walks committed `.crib/memory/team/**/*.jsonl` for v2 entries with `visibility === 'private'` and reports file+line; it reports the shard count scanned and uses "no instances present" (not "clean") when there were no shards to scan. **Consequence (accepted):** because the `supersede` successor default stays `private` per this decision, every DEFAULTED supersede at the team store is now refused — callers performing a team-lane supersede must pass `visibility:'workspace'` explicitly; operator docs must say so. `admissionForSync(entry, targetClass)` (pure, in the engine): `git-shard` admits only workspace + non-restricted sensitivity + known retention id; `encrypted-remote` admits private/workspace + up to `confidential`; unknown retentionPolicyId or id re-derivation mismatch → refuse with a typed reason (ambiguous policy is a refusal, not a warning). A refusal skips that event and is reported; the ONLY run-aborting condition is a secret-scan hit — `assertNoMemorySecrets` runs on plaintext BEFORE encryption at staging and immediately pre-`putObject`, and a hit aborts the entire push run with the finding recorded by id+location only.

### D11 — Physical purge (logical tombstone FIRST, store-mediated rewrite, honest limits)

`crib memory purge <memId>… --confirm <memId>… [--stores local,global] [--dry-run] [--history-scan]`. No wildcards; the exact id must be repeated in `--confirm`. Per id, per store (one store at a time — the no-cross-store-nesting guard): (1) append the logical tombstone retract decision (the synced, replayable part); (2) physically rewrite affected shards via `writeShard`/`removeEntry` — NEVER raw file writes — so the FTS removed-id notices fire and BM25's IDF stays correct; (3) sweep same-seed staging twins (`cand:`), feedback, and capture outbox/dead entries; (4) follow `resolveId` so the legacy twin is purged with the v2 record, while **alias lines are RETAINED** as deliberate audit history. Remote side: `DELETE` the routed blob keys, then record the purge-ack in sync-state (terminal state first, bookkeeping last — a crash heals as a repeatable run). Team store: refused unless explicitly opted-in with a clean working tree, and even then crib only appends the retract decision (visible in a PR) — `--history-scan` runs the read-only equivalent of `git log -S<id> -- .crib/memory/` and REPORTS commits that still contain the content: the honest statement that irreversible deletion is impossible once committed. Dangling lineage after purge is expected and audit-visible. docs/memory-sync.md documents all of it as part of the gate.

### D12 — Surfaces

- **API:** `MemoryApi.sync()` replaces the placeholder with a port-injected engine: `{op:'push'|'pull', backend: SyncObjectStore, stores?, dryRun?, maxEvents?}` / `{op:'status'}`. Unconfigured → still the honest not-configured shape (reworded from "Gate 4").
- **CLI:** `crib memory init-sync` · `crib memory sync [push|pull|status] [--dry-run] [--backfill] [--json]` · `crib memory sync rotate-key` · `crib memory sync purge-sync` · `crib memory purge` · `crib memory conflicts` (read-only fold) · `crib memory resolve` (append-only).
- **MCP:** **no push/pull, no network side effects behind an agent session**; `memory{op:'sync'}` becomes a read-only status/dry-run report. **No new MCP ops** — `resolve` is already registered; conflicts are surfaced via `audit` + sync status. `OPERATION_COUNT` is unchanged. Purge is deliberately CLI-only (an agent-reachable irreversible purge would let a confused session destroy memory across devices — the promotion.ts no-execution posture extended to sync).

## Rejected alternatives (recorded because they recur)

- prev-event chaining / seq-in-seed (breaks cross-device dedupe and every derived spec), sender-side merge (cannot work two-way; order-dependent), LWW in any form (plan-forbidden), first-writer-wins at apply (concedes it "cannot adjudicate" — that concession is the violation), server-side cursors (no service), thick adapters (every backend re-implements the protocol), plaintext event ids on the wire (claim-confirmation oracle), new MemoryCollections for queue state (closed-union inflation), age-style per-device recipient envelopes (better topology, heavier — **deferred**, documented as the follow-up; the symmetric key is the user's own asset on their own devices), syncing receipts (mechanically impossible for global; revalidates degraded honestly), trust-the-sender pull, ambiguous-policy-warn-and-push.

## Scope cuts (deliberate, not oversights)

Receipts out of v1 sync · git-shard adapter deferred · sigv4 in-process signing deferred (proxy covers day one) · remote log compaction deferred (documented follow-up; per-event blobs make purge cheap, which is why compaction can wait) · age envelope crypto deferred · MCP push/pull deferred (durable-worker-driven sync scheduling is a generalization of Gate 3's worker, not a v1 need) · **no standalone `purge.mark` producer** (the synced, replayable purge artifact is the retract `decision.append` per D9/D11; the `purge.mark` kind remains in the envelope schema for forward compatibility but no code path emits it).