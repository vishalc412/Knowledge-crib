# Memory sync — the operator guide (Gate 4, ADR-003)

Cross-device sync for the crib memory stores: an immutable, content-addressed event
protocol pushed to **your own storage**, encrypted at rest, with no service operated by
crib. This doc is the operator-facing contract behind
[ADR-003](adr/ADR-003-cross-device-sync.md); the decisions it cites (D1–D12) live there.

```
crib memory init-sync   # configure a store + seed the baseline (syncs NOTHING)
crib memory sync        # push | pull | status | compact | rotate-key | purge-sync
crib memory purge       # logical tombstone + physical rewrite + remote delete
crib memory conflicts   # read-only conflict report
crib memory resolve     # append-only conflict resolution
```

## What syncs — and what deliberately does not

Two stores participate:

| store | scope | syncs collection |
| --- | --- | --- |
| local | per-repo (`--scope repo`) | `active`, `intakes` |
| global | per-machine (`--scope global`) | `records` |

The **team store is not a sync participant** (D2). Git *is* its backend: team memory
lives in `.crib/memory/team/**/*.jsonl` and is reviewed in PRs through the
`kcrib-memory` merge driver. Folding an encrypted, unreviewable channel over it would
create two divergent team truths, so team memory stays exactly where review can see it.
To share a team record across devices, commit and push it — that is the feature, not a
limitation.

Intake continuation follows the same boundary. `crib intake share <id> --audience devices`
marks the immutable history for the configured encrypted local channel. `--audience team` is a
separate explicit promotion that secret-scans and copies the complete history into
`.crib/memory/team/intakes`; commit that Git-visible change to share it with collaborators.

The sync unit is the **event envelope** (D1): `evt:<blake3>` over the canonical entry
JSON. The id is derived from content alone — no sequence numbers, no device ids in the
seed — so two devices that independently derive the same event get the same id and the
protocol is idempotent by construction. Everything below follows from that: every
re-push and re-pull of an already-applied event is a byte-stable no-op.

## Threat model — what the storage host sees, and what it cannot

You point sync at storage you own (a directory, an S3-compatible bucket, a WebDAV
mount, or a local proxy — see [the http backend](#the-http-backend-contract)). Be
honest about what that host can observe:

- **Event blobs are opaque.** Each `ev/<hmac>` object is `AES-256-GCM` encrypted with
  your key; the full event — claim text, evidence, ids — is inside the ciphertext.
  Nothing about a blob's content class is inferable from its name.
- **Routing is plaintext by necessity** (D6): `manifest.json` and `b/<batchId>.json`
  batch manifests carry only format, key fingerprint, key epoch, counts, and HMAC
  digests of event ids. This leaks **activity patterns and object counts** to the
  storage host. This is a documented, accepted side-channel — routing without
  decryption requires plaintext digests, and plaintext blake3 ids on the wire would be
  a claim-confirmation oracle, which is why routing keys are HMACs of the id, not the
  id itself.
- **The key is the boundary.** Whoever holds the sync key decrypts every event. It
  lives on your devices only (env var or 0600 keyfile); the config on disk stores a
  *fingerprint* of it, never the bytes. Rotate it if a device is lost (below).
- **Secrets never leave the device.** The engine runs the memory secret scanner on
  plaintext before encryption at staging and again immediately before upload; a hit
  aborts the entire push run and records the finding by id and location only.
- **Conflicts are not silently adjudicated.** A forged or hand-edited payload whose
  content id does not re-derive from its bytes is refused into the conflicts ledger,
  never applied (D8). A peer's verdicts are carried as content, never re-stamped — a
  dangled foreign evidence anchor degrades honestly on your device, it is not
  accepted because another device vouched for it.

## Key setup (D7)

Three ways to give the key — exactly one, fail-closed:

| flag | source | notes |
| --- | --- | --- |
| `--key-env <NAME>` | environment variable | 64 hex chars (or 44-char base64) |
| `--keyfile <path>` | file | chmod 0600 expected |
| `--gen-key` | minted | 32 random bytes written to `<memoryHome>/sync-key` (0600) |

Omitting all three falls back to `KCRIB_SYNC_KEY`, then `<memoryHome>/sync-key`. The
config file (`<memoryHome>/sync/<scope>-<id>.json`) stores only the **reference**
(`keySource`), the **fingerprint** (`blake3(key)`), and the **key epoch** — never key
bytes, never bearer tokens. HTTP credentials go in `--secret-env <NAME>` and are read
at call time only.

Two sharp edges worth knowing:

- An explicit `--keyfile` overrides an ambient `KCRIB_SYNC_KEY` (env is checked first
  otherwise — the CLI blanks it for the explicit-key paths so a stale env var cannot
  shadow the file you asked for).
- Every sync run re-resolves the key and compares its fingerprint against the config.
  A mismatch is a refusal with the fingerprint named — this is what catches "rotated
  on one device, forgot on the other" before it corrupts anything.

## `crib memory init-sync` — the baseline, not a sync

```
crib memory init-sync --scope repo --backend file --url /mnt/usb/crib-sync --gen-key
crib memory init-sync --scope global --backend http --url https://sync.example.com/crib --key-env KCRIB_SYNC_KEY --secret-env CRIB_BEARER
```

init-sync probes the backend (an unreachable target is a refusal, not a config that
heals later), then seeds `sync-state.json` with **every current entry marked acked**
(D5). It syncs **nothing** — the command's own output says so. Only changes after
init-sync are pushed, which is what prevents a full remote rewrite of a mature store
the first time you configure a second device.

Use `--backfill` to override the baseline and stage the full history on the next push
(use this when the remote is new or was lost and you want the whole store uploaded).

## Durable intake continuation across devices

Create and checkpoint resumable work locally:

```bash
crib intake create --from "Finish the parser migration" --outcome "Parser migration is complete" \
  --scope packages/parsers --accept "Parser tests pass" --json
crib intake checkpoint intake:<id> --phase executing --summary "Core changes landed" \
  --next "Run the MCP integration tests" --json
crib session bootstrap --json
```

Configure each device with the same stable sync id, user-owned backend, and key reference, then
push on the source and pull on the destination:

```bash
crib memory init-sync --scope repo --backend file --url /path/to/user-owned-sync \
  --keyfile /path/to/sync-key --sync-id my-project
crib intake share intake:<id> --audience devices --json
crib memory sync push --json

# On the second device, after init-sync with the same --sync-id/key/backend:
crib memory sync pull --json
crib session bootstrap --json
```

The bootstrap reports repository drift when saved HEAD, branch, dirty state, or changed-path digest
no longer matches. Revalidate the next action before continuing. Multiple active intakes are
returned as choices with no guessed primary. Restricted intake is refused by encrypted sync;
secret-pattern hits abort before upload. Use `crib memory conflicts --json` for content collisions.

## `crib memory sync push|pull|status`

`status` is the default action and is read-only: staged/pending/acked counts, pull
cursor, conflicts, quarantined events, purge acks, and — when the remote is reachable
— batch/blob counts plus whether the remote manifest's fingerprint matches your key.
A key-resolution failure degrades only the report's remote half (a warning on stderr;
the sidecar counts still print).

`push` runs a **derive-and-diff reconciliation sweep**, not a queue drain: it re-derives
`evt:` ids from the store's live entries and stages any entry with no pending-or-acked
event. That one routine is also the heal after a crash, a lost outbox, or a corrupt log
(D4) — crash windows close as idempotent re-deliveries because the acked mark is
written LAST, after the object upload. Flags: `--backfill` (stage the full history),
`--max-events N`, `--dry-run`.

`pull` lists `b/` batches, fetches unseen blobs, decrypts, validates, secret-scans,
re-derives ids, and applies through the store's own write gate — the cursor advances
LAST. Re-delivery is a no-op; losing `sync-state.json` costs a no-op storm, never
duplication. Flags: `--dry-run`, `--skip` (see [quarantine](#quarantine-and---skip)).

Exit codes: push/pull exit 0 when every **configured** scope succeeded and at least one
ran. A scope without config is a stated skip (`not run — no local sync config — run
crib memory init-sync ...`), not a silent one; if nothing at all is configured, or a
configured scope fails, the run exits 1.

### Outbox compaction

`crib memory sync compact [--dry-run] [--json]` removes only outbox events whose ids are already in
the durable ack ledger. Pending events retain their order; ack ids remain so the reconciliation
sweep does not re-stage the live corpus. A malformed/torn outbox refuses compaction and leaves the
original bytes unchanged. Replacement is atomic temp→rename under the store lock. This controls
payload-log growth without weakening at-least-once recovery.

## Verified backup and restore

Use `crib memory backup create|verify|restore` for local/global canonical stores and their sync
sidecars. The bundle is plaintext and should inherit the same filesystem protection as the memory
home. It deliberately excludes lock/temp artifacts and the separate sync key. Team memory remains
Git-backed and is restored with the repository.

Restore verifies size and SHA-256 for every listed regular file before staging. Non-empty targets
require `--force`; stop active agents and the freshness service before replacing a live store. A
failed multi-store activation rolls already activated targets back. These guarantees cover process
interruption and tested disk-write failures; Knowledge Crib does not claim power-loss durability
until an fsync/filesystem contract is established.

## Conflicts and `crib memory resolve` (D8)

Apply is never last-write-wins. On pull, four shapes:

1. absent locally → upsert (through the store's write gate — the engine never writes
   shard files directly);
2. byte-identical → no-op;
3. same id, different bytes → **your local copy stays**, the peer variant is recorded
   in the conflicts ledger and surfaced in `status` and `crib memory audit`;
4. id does not re-derive from the payload bytes → refused as forged, ledgered.

Decision-level conflicts (two devices superseding one subject toward different
successors, or supersede vs retract) surface via `conflictGroups` plus the pure
`decisionConflicts()` fold. Inspect and resolve:

```
crib memory conflicts [--json]
crib memory resolve <record-id> --successor <id> --actor <id> [--reason <text>]
crib memory resolve <record-id> --retract --actor <id> [--reason <text>]
```

Resolution is **append-only** — a resolving decision that itself syncs and converges.
Nothing is rewritten; the ledger keeps the disagreement until a human appends the
decision.

## Key rotation: `rotate-key` + `purge-sync --stale-epoch` (D7)

Rotation is verify-then-replace, in this order:

```
crib memory sync rotate-key --gen-key            # or --key-env / --keyfile
# on the second device: pull clean under the NEW key
crib memory sync purge-sync --stale-epoch [--dry-run]
```

**Every device pulls clean BEFORE any device rotates.** A device that misses the
window must be re-seeded under the new key (`init-sync --backfill` after rotation) —
never pull mid-rotation: an old-key device pulling after the epoch bump refuses the
new-epoch blobs, and re-pushing its own staged events under the old key after other
devices have rotated would wedge the outbox.

`rotate-key` refuses to rotate at all while the local outbox still holds
staged-but-unacked events (the typed refusal names the count and the remediation:
run `sync push` until the outbox drains, then rotate). It verifies everything under
the old key, re-encrypts and re-pushes each event under the new one, bumps the key
epoch, and rewrites the config's key reference (source + env/file), fingerprint +
epoch. `--dry-run` computes without writing. `purge-sync --stale-epoch` then deletes
remote blobs that no longer decrypt under the **current** key (i.e. the previous
epoch's objects). It refuses unless the remote manifest already names your device's
epoch — a peer that has not rotated yet would lose its not-yet-re-encrypted objects.
**Do not run purge-sync until every device has rotated and pulled clean**; the command
prints that reminder and the epoch check enforces what it can.

## `crib memory purge` — the physical purge workflow (D11)

`crib memory delete` is a tombstone: append-only, synced, reversible in effect only by
another decision. When the bytes themselves must go:

```
crib memory purge mem:<id>... --confirm mem:<id>... [--stores local,global] \
  [--dry-run] [--history-scan] [--actor <id>] [--json]
```

- **The exact id list must be repeated in `--confirm`** — no wildcards, no fuzzy
  matches; a mismatch refuses the run.
- Per id: append the tombstone retract decision (the synced, replayable part) →
  physically rewrite the affected shards through the store (FTS/BM25 stay correct) →
  sweep same-seed `cand:` staging twins, feedback, and capture-queue entries → resolve
  legacy aliases so the twin is purged with the v2 record (**alias lines are retained**
  as audit history).
- When the local scope is configured and the key resolves, the routed remote blobs are
  deleted too; otherwise the run completes locally and the report says the remote was
  not touched.
- **The hard constraint:** once memory content is committed to git, git history cannot
  provide irreversible deletion. `--history-scan` runs the read-only equivalent of
  `git log -S<id> -- .crib/memory/` and reports the commits that still contain the
  content. Rewriting history is a git operation crib does not perform. The team store
  participates only via the appended retract decision (visible in a PR); its shard
  bytes are never rewritten by sync.

## Quarantine and `--skip`

A pulled event that fails validation or the secret scan halts the pull with the cursor
unmoved — nothing is applied past it, nothing is deleted. Fix or reject the source,
then re-run. `--skip` quarantines the offending event instead of halting: it is
recorded in sync-state, surfaced in `status` (`quarantined N`), and never applied.
Quarantine is a holding state, not a deletion; a later engine release or operator
decision can still act on it.

## The http backend contract (D6)

The `http` backend speaks the smallest generic blob interface — S3/R2
(ListObjectsV2) and WebDAV (PROPFIND) both map onto it; a thin server-side proxy
covers day one, and sigv4 signing is a follow-on rather than a dependency:

| op | wire shape |
| --- | --- |
| `probe()` | GET `manifest.json` (404 = empty backend, OK) |
| `putObject` | PUT (idempotent; same bytes, same key) |
| `getObject` | GET (404 = absent) |
| `listObjects(prefix)` | GET `?list&prefix=<p>` → `{keys: [...], nextAfter?}` |
| `deleteObject` | DELETE (physical purge / stale-epoch purge only) |

Auth: a single bearer token read from the env var named by `--secret-env` at call
time — the config stores the env var **name**, never the token. Remote layout:
`manifest.json` + `ev/<hmac>` blobs + `b/<batchId>.json` manifests; the batch manifest
is the cursor, so correctness never depends on remote ordering or list-after-put
visibility.

## MCP posture — read-only by design

The MCP server exposes sync **status only**. A `request` of `push` or `pull` is
rejected with an honest message: sync writes run only via the CLI, so an agent session
cannot cause network side effects. No new MCP operations were added for sync; purge is
CLI-only entirely — an agent-reachable irreversible purge would let a confused session
destroy memory across devices. `OPERATION_COUNT` is unchanged (14 tools / 38
operations).

## Supersede visibility note (D10)

`crib memory supersede <id> --claim <text>` publishes the successor with **workspace**
visibility by default so a team-store supersede succeeds (private records are refused
at the team store — private memory never enters git). Pass `--visibility private`
explicitly for a private successor on a local/global record; the same default keeps
team-lane supersede working without a mandatory extra flag.

## Scope cuts (deliberate, not oversights)

- **Receipts are not synced** — `GLOBAL_COLLECTIONS` cannot hold them and their
  evidence anchors are device-bound; a pulled record citing a foreign receipt
  revalidates degraded honestly.
- **A git-shard sync adapter is deferred** — it must run plaintext to stay reviewable,
  which is a second admission class through the filter and the merge driver; it gets a
  dedicated gate, not a rider on this one.
- **sigv4/signed uploads are a follow-on** — the generic blob interface works with a
  user-side proxy today.
- **Ack-ledger archival is deferred** — acknowledged ids remain in sync-state so a compacted event
  is not re-staged by reconciliation. The payload outbox itself is compacted with
  `crib memory sync compact`.
- **Per-device recipient envelopes (age-style) are deferred** — the symmetric key is
  the user's own asset on their own devices; topology-heavy envelopes are a documented
  follow-up, not a v1 requirement.
