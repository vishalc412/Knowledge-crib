import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * ADR-003 (Gate 4) — the sync PROTOCOL ENGINE. The protocol lives here; adapters stay dumb (D6) and
 * the stores stay untouched by it (D8: the engine never writes shard files directly — every apply
 * goes through `MemoryStore.upsertEntries`, so the FTS notices and generation bumps fire by
 * construction).
 *
 * Push (D4/D5): a derive-and-diff reconciliation sweep stages any live syncable entry whose `evt:`
 * id is neither pending nor acked — the crash between a store write and its stage heals on the next
 * push, idempotently — then drains the sidecar outbox: admission → secret-scan on the plaintext
 * (immediately before encryption) → `putObject(ev/<route>)` → the batch manifest `b/<batchId>.json`
 * (content-addressed over the sorted route keys) → acks in sync-state LAST. A secret-scan hit is
 * the ONLY run-aborting condition (D10); an admission refusal skips that event and is reported.
 *
 * Pull (D6/D8/D9): list `b/` → fetch unseen batches → fetch unseen blobs → decrypt → validate +
 * secret-scan (fail closed per object: halt with the cursor unmoved; an operator `--skip`
 * quarantines, never deletes) → the apply law, a TOTAL function — never LWW, never
 * first-writer-wins, never in-place mutation. Pulled batches are recorded LAST, so a crash inside a
 * pull redelivers and every redelivered event is a byte-identical no-op.
 *
 * The sidecar (D3) bypasses the store's write gate by design, so the engine re-runs the gate itself
 * on every pulled payload (`assertValidMemoryEntry` + `assertNoMemorySecrets`) before applying.
 *
 * NO wall-clock read anywhere: `now` is a caller-supplied port and feeds only ENVELOPE metadata and
 * bookkeeping stamps — never an id, hash, or seed (D1).
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { writeJsonAtomic } from '../atomic.js';
import { memoryIdPrefix, memoryShard } from '../ids.js';
import { memoryHome } from '../paths.js';
import { assertNoMemorySecrets } from '../secrets.js';
import { canonicalMemoryJson } from '../serialization.js';
import type { MemoryCollection, MemoryStore } from '../store.js';
import type { MemoryDecision, MemoryEntry } from '../types.js';
import { assertValidMemoryEntry } from '../validate.js';
import type { SyncObjectStore } from './adapter.js';
import { walkSyncableEntries } from './bootstrap.js';
import {
  SyncCryptoError,
  decryptEvent,
  encryptEvent,
  keyFingerprint,
  routeKeyFor,
} from './crypto.js';
import {
  type SyncEvent,
  type SyncEventPayload,
  type SyncStoreScope,
  buildSyncEvent,
  verifyPayloadId,
} from './event.js';
import { admissionForSync } from './policy.js';
import {
  type ConflictRecord,
  type QuarantineRecord,
  SyncStageError,
  type SyncState,
  loadSyncState,
  markEventAcked,
  mergeSyncState,
  readStagedEventIds,
  readStagedEvents,
  saveSyncState,
  stageOutboundEvent,
} from './queue.js';

/** Thrown when the engine is called against a store role that is not a sync participant (team —
 *  git is its backend, D2). */
export class SyncEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncEngineError';
  }
}

/** `manifest.json` on the remote (D7): format + `keyFingerprint` + `keyEpoch`, plaintext. */
export const REMOTE_MANIFEST_KEY = 'manifest.json';

export interface SyncRemoteManifest {
  v: '1';
  format: 'crsy-sync-1';
  keyFingerprint: string;
  keyEpoch: number;
}

/** The identity + key a run needs. `deviceId` comes from the store's seeded sync-state (one source
 *  of device identity); `now` feeds only envelope metadata and bookkeeping stamps. `syncRepoId`
 *  overrides the local-scope derivation/placement id (the sync config's stable `syncRepoId`): the
 *  manifest's `repo.id` is a per-checkout random UUID, so without the override two real clones of
 *  the same repository could never reconcile (every peer event would surface as `different-repo`). */
export interface SyncRunOpts {
  key: Uint8Array;
  principalId: string;
  now: () => string;
  syncRepoId?: string;
}

export interface PushOpts extends SyncRunOpts {
  dryRun?: boolean;
  /** cap the events pushed this run (the rest stay pending — the next push drains them). */
  maxEvents?: number;
  /** D5: stage every live entry even if the baseline acked it (an explicit full re-stage). */
  backfill?: boolean;
}

export interface PullOpts extends SyncRunOpts {
  dryRun?: boolean;
  /** D8 step 1: quarantine an offending (decryptable) event instead of halting — never a delete. */
  skip?: boolean;
}

export interface StatusOpts {
  /** absent → the remote half of the report is an honest "key not supplied" empty shape. */
  key?: Uint8Array;
  backend?: SyncObjectStore;
}

/** One admission refusal (D10): skipped, reported, never applied. */
export interface SyncRefusal {
  eventId: string;
  payloadId: string;
  reason: string;
}

/** The abort shape for the ONLY run-aborting condition (D10): a secret-scan hit on the plaintext,
 *  recorded by id only — never the finding text. */
export interface SecretAbort {
  eventId: string;
  payloadId: string;
  kind: 'secret-scan';
}

export interface SyncPushResult {
  ok: boolean;
  store: SyncStoreScope;
  status:
    | 'pushed'
    | 'dry-run'
    | 'not-initialized'
    | 'no-repo-id'
    | 'backend-unreachable'
    | 'aborted';
  dryRun: boolean;
  /** events the sweep staged THIS run (the derive-and-diff heal, D4/D5). */
  stagedNow: number;
  /** pending events the run planned to push (the `maxEvents` cap applied). */
  planned: number;
  /** pending events left for the next run (beyond the `maxEvents` cap). */
  deferred: number;
  /** events durably pushed this run (0 on a dry-run, which writes nothing). */
  pushed: number;
  /** events acked in sync-state this run (LAST — the D4 ordering law). */
  acked: number;
  /** the batch manifest ids written this run. */
  batches: string[];
  refusals: SyncRefusal[];
  aborted?: SecretAbort;
  /** shard-read errors from the sweep (the caller reports; never a silent skip). */
  errors: string[];
  message?: string;
}

/** One applied pull event (ids + what the apply law decided — never payload bytes). */
export interface SyncApplied {
  eventId: string;
  payloadId: string;
  action:
    | 'upserted'
    | 'noop'
    | 'decision-applied'
    | 'intake-upserted'
    | 'checkpoint-appended'
    | 'purge-mark';
}

/** One surfaced (not applied) event: an unconfigured store role, a different repo, or an
 *  ahead-of-record tombstone (applied AND surfaced, D9). */
export interface SyncSurfaced {
  eventId: string;
  payloadId?: string;
  reason: string;
}

export interface SyncPullResult {
  ok: boolean;
  store: SyncStoreScope;
  status: 'pulled' | 'dry-run' | 'not-initialized' | 'backend-unreachable' | 'halted';
  dryRun: boolean;
  /** batches listed remotely (the batch list IS the cursor, D6). */
  batchesSeen: number;
  /** unseen batches processed this run. */
  batchesApplied: number;
  applied: SyncApplied[];
  surfaced: SyncSurfaced[];
  conflictsAdded: ConflictRecord[];
  quarantined: QuarantineRecord[];
  /** batch manifests or route keys listed remotely whose object was absent (purged, or not yet
   *  visible) — reported, never fatal. */
  missing: string[];
  /** the fail-closed halt (D8 step 1): the cursor was left unmoved. */
  halted?: { reason: string; key?: string; eventId?: string };
  message?: string;
}

export interface SyncStatusResult {
  available: boolean;
  store: SyncStoreScope;
  status: 'initialized' | 'not-initialized';
  deviceId?: string;
  keyEpoch?: number;
  staged: number;
  pending: number;
  acked: number;
  batchesPulled: number;
  conflicts: ConflictRecord[];
  quarantine: QuarantineRecord[];
  purgeAcks: number;
  remote?: {
    reachable: boolean;
    backend: 'file' | 'http';
    batches: number;
    events: number;
    /** true/false when a manifest + key were both available; undefined when either was not. */
    keyFingerprintMatch?: boolean;
    remoteKeyEpoch?: number;
    message?: string;
  };
  message?: string;
}

export interface SyncRotateResult {
  ok: boolean;
  status: 'rotated' | 'dry-run' | 'not-initialized' | 'backend-unreachable' | 'failed';
  /** events re-encrypted + re-pushed under the NEW key. */
  reEncrypted: number;
  batches: string[];
  keyEpoch?: number;
  /** staged-but-unacked events in the outbox (the rotation wedge guard — a non-zero count is a
   *  typed refusal: the operator pushes first, deliberately, never silently mid-rotation). */
  pending?: number;
  /** the actionable remediation for a refused rotation (D7: every device pulls clean BEFORE the
   *  rotate; a device that missed the window re-seeds under the new key). */
  warning?: string;
  message?: string;
}

// ─── per-store sync config file (D7 — a REFERENCE, never key bytes) ──────────

/** `<memoryHome>/sync/<scope>-<id>.json` (D7): keySource REFERENCE + fingerprint + epoch — never
 *  key bytes, never a bearer token. `id` is the repoId for the local scope, 'global' otherwise.
 *  The optional fields are REFERENCES too, written by `crib memory init-sync` so a later
 *  `crib memory sync push|pull` can resolve the key and the backend without re-passing flags:
 *  `keyEnv`/`keyFile` name WHERE the key lives (by env-var name / path — never its value), and
 *  `backend` records the user-owned storage target (D6). An HTTP target's auth env NAME may be
 *  recorded, but the credential itself is read from the env at call time, never stored. */
export interface SyncConfigFile {
  schemaVersion: '1';
  scope: SyncStoreScope;
  id: string;
  keySource: 'env' | 'keyfile';
  keyFingerprint: string;
  keyEpoch: number;
  keyEnv?: string;
  keyFile?: string;
  backend?: { kind: 'file' | 'http'; url: string; authEnv?: string };
  /** The stable cross-clone sync id for the LOCAL scope (init-sync `--sync-id`, D7 reference law —
   *  an id, never key bytes). Overrides the manifest's per-checkout `repo.id` for event
   *  derivation/placement so two real clones of the same repository reconcile. */
  syncRepoId?: string;
}

export function syncConfigPath(scope: SyncStoreScope, id: string, env: NodeJS.ProcessEnv): string {
  return join(memoryHome(env), 'sync', `${scope}-${id}.json`);
}

export function readSyncConfig(
  scope: SyncStoreScope,
  id: string,
  env: NodeJS.ProcessEnv,
): SyncConfigFile | undefined {
  const path = syncConfigPath(scope, id, env);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // The optional reference fields must hold their shape too — a wrong-shape config is an
    // honest "not configured", never a coercion (a malformed backend url would otherwise be
    // silently reused by every later push/pull).
    const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string';
    const backend = parsed.backend as SyncConfigFile['backend'] | undefined;
    const backendOk =
      backend === undefined ||
      (backend !== null &&
        typeof backend === 'object' &&
        (backend.kind === 'file' || backend.kind === 'http') &&
        typeof backend.url === 'string' &&
        optStr(backend.authEnv));
    if (
      parsed.schemaVersion === '1' &&
      parsed.scope === scope &&
      parsed.id === id &&
      typeof parsed.keyFingerprint === 'string' &&
      typeof parsed.keyEpoch === 'number' &&
      optStr(parsed.keyEnv) &&
      optStr(parsed.keyFile) &&
      optStr(parsed.syncRepoId) &&
      backendOk
    ) {
      return parsed as unknown as SyncConfigFile;
    }
    return undefined; // a wrong-shape config is an honest "not configured", never a coercion
  } catch {
    return undefined;
  }
}

/** Persist the config (atomic temp→rename). The caller supplies a fingerprint computed FROM the
 *  key; the BYTES themselves must never appear in the object — the interface is closed (all
 *  fields are references: env names, paths, storage locations), and a key-shaped field here
 *  would be the one mistake this design cannot take back. */
export function writeSyncConfig(config: SyncConfigFile, env: NodeJS.ProcessEnv): void {
  writeJsonAtomic(syncConfigPath(config.scope, config.id, env), `${JSON.stringify(config)}\n`);
}

// ─── remote manifest + batch manifests (D6/D7) ────────────────────────────────

function manifestBytes(manifest: SyncRemoteManifest): Uint8Array {
  return Buffer.from(JSON.stringify(manifest), 'utf8');
}

/** Exported for the CLI's `sync purge-sync --stale-epoch` guard: the manifest is the only proof
 *  the remote has already moved to the current epoch (a purge before every device rotated would
 *  delete a peer's not-yet-re-encrypted objects). */
export function parseRemoteManifest(bytes: Uint8Array): SyncRemoteManifest | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    if (
      parsed.v === '1' &&
      parsed.format === 'crsy-sync-1' &&
      typeof parsed.keyFingerprint === 'string' &&
      typeof parsed.keyEpoch === 'number'
    ) {
      return parsed as unknown as SyncRemoteManifest;
    }
    return undefined;
  } catch {
    return undefined; // an unparseable manifest is reported as a mismatch, never trusted
  }
}

/** The batch manifest IS the cursor (D6): `b/<batchId>.json`, batchId = blake3 over the canonical
 *  sorted route keys, content `{v:'1', count, keys}` plaintext — ONLY route keys, never claims. */
export function batchIdFor(routeKeys: readonly string[]): string {
  return blake3Hex(canonicalMemoryJson([...routeKeys].sort() as unknown as MemoryEntry));
}

function batchBytes(routeKeys: readonly string[]): Uint8Array {
  const keys = [...routeKeys].sort();
  return Buffer.from(JSON.stringify({ v: '1', count: keys.length, keys }), 'utf8');
}

function parseBatchManifest(bytes: Uint8Array): string[] | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    if (
      parsed.v === '1' &&
      typeof parsed.count === 'number' &&
      Array.isArray(parsed.keys) &&
      parsed.keys.every((k) => typeof k === 'string')
    ) {
      return parsed.keys as string[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── push (D4/D5) ─────────────────────────────────────────────────────────────

/** The store scope an engine call targets; team is NEVER a participant (D2). */
function scopeOf(store: MemoryStore): SyncStoreScope {
  if (store.role === 'team') {
    throw new SyncEngineError(
      'the team store is not a sync participant (git is its backend, D2) — sync local + global only',
    );
  }
  return store.role === 'local' ? 'local' : 'global';
}

/** The repoId a local-scope store derives events under (the manifest's `repo.id`). */
function repoIdOf(store: MemoryStore, scope: SyncStoreScope): string | undefined {
  return scope === 'local' ? store.readManifest()?.repo?.id : undefined;
}

/**
 * Push (D4/D5): sweep + stage under ONE lock hold (all sync, no async gap inside the hold), then
 * drain the outbox to the backend — admission → secret-scan on the plaintext → encrypt →
 * `putObject` → batch manifest → acks LAST. `--dry-run` computes everything (sweep, admission,
 * scan) and writes nothing. Requires an initialized sync-state (`init-sync` owns the seed, D5) and
 * a local store with a resolvable repoId.
 */
export async function pushSync(
  store: MemoryStore,
  backend: SyncObjectStore,
  opts: PushOpts,
): Promise<SyncPushResult> {
  const scope = scopeOf(store);
  const dryRun = opts.dryRun === true;
  const state = loadSyncState(store.rootDir);
  const refusalShape = () => ({ refusals: [] as SyncRefusal[], errors: [] as string[] });
  if (state === undefined) {
    return {
      ok: false,
      store: scope,
      status: 'not-initialized',
      dryRun,
      stagedNow: 0,
      planned: 0,
      deferred: 0,
      pushed: 0,
      acked: 0,
      batches: [],
      ...refusalShape(),
      message: 'no sync-state in this store root — run init-sync first (D5)',
    };
  }
  const repoId = opts.syncRepoId ?? repoIdOf(store, scope);
  if (scope === 'local' && repoId === undefined) {
    return {
      ok: false,
      store: scope,
      status: 'no-repo-id',
      dryRun,
      stagedNow: 0,
      planned: 0,
      deferred: 0,
      pushed: 0,
      acked: 0,
      batches: [],
      ...refusalShape(),
      message:
        'the local store manifest carries no repo.id — a local-scope event cannot be derived',
    };
  }
  const probe = await backend.probe();
  if (!probe.ok) {
    return {
      ok: false,
      store: scope,
      status: 'backend-unreachable',
      dryRun,
      stagedNow: 0,
      planned: 0,
      deferred: 0,
      pushed: 0,
      acked: 0,
      batches: [],
      ...refusalShape(),
      ...(probe.message !== undefined ? { message: probe.message } : {}),
    };
  }

  // Phase 1 — the sweep + drain plan, under ONE lock hold. The sweep (unless dry-run) derives,
  // admits, scans, and stages every live entry whose event is neither pending nor acked; the drain
  // plan then reads the FULL pending set from the outbox, so a previous crashed run's staged lines
  // are drained too (D4 heals by redelivery, not by a special case).
  const plan = store.withLock(() => {
    const errors: string[] = [];
    const refusals: SyncRefusal[] = [];
    let stagedNow = 0;
    let abort: SecretAbort | undefined;
    // The sweep runs on EVERY push — dry-run included ("computes everything, writes nothing"):
    // the same admission + scan gates run, but the stage step is skipped and the walked events
    // join the drain plan directly, so `planned` reports what a real push would do.
    const walk = walkSyncableEntries(store, {
      ...(opts.backfill ? { backfill: true } : {}),
      ...(repoId !== undefined ? { repoId } : {}),
    });
    errors.push(...walk.errors);
    const dryPlanned: SyncEvent[] = [];
    for (const walked of walk.entries) {
      const admission = admissionForSync(walked.entry, 'encrypted-remote');
      if (!admission.admitted) {
        refusals.push({
          eventId: walked.eventId,
          payloadId: walked.entry.id,
          reason: admission.reason ?? 'refused',
        });
        continue; // skip-and-report (D10) — the event stays unstaged, reported on every push
      }
      // D10 — scan the plaintext BEFORE anything is staged; a hit aborts the ENTIRE run and is
      // recorded by id only.
      try {
        assertNoMemorySecrets(walked.entry);
      } catch {
        abort = { eventId: walked.eventId, payloadId: walked.entry.id, kind: 'secret-scan' };
        break;
      }
      // The sweep's payload union is exactly the envelope's: records (`mem:`), decisions (`dec:`),
      // and feedback (`fb:`) — the walk's own prefix dispatch guarantees it.
      const evt = buildSyncEvent({
        kind: walked.kind,
        store: walked.store,
        ...(walked.repoId !== undefined ? { repoId: walked.repoId } : {}),
        deviceId: state.deviceId,
        principalId: opts.principalId,
        payload: walked.entry as SyncEventPayload,
        ts: opts.now(),
      });
      if (dryRun) {
        dryPlanned.push(evt);
        continue;
      }
      try {
        if (stageOutboundEvent(evt, store.rootDir).staged) stagedNow += 1;
      } catch (err) {
        // A gate hit at staging (a forged content id, a torn envelope) is a per-event refusal —
        // never an abort, never a silent skip. A scanner hit never reaches here: the pre-scan
        // above catches it first, and the abort law outranks staging.
        if (err instanceof SyncStageError) {
          refusals.push({
            eventId: walked.eventId,
            payloadId: walked.entry.id,
            reason: 'staging-refused',
          });
          continue;
        }
        throw err;
      }
    }
    const staged = readStagedEvents(store.rootDir);
    errors.push(
      ...(staged.malformed > 0 ? [`sync-outbox: ${staged.malformed} malformed line(s)`] : []),
    );
    const allPending = [...staged.events, ...dryPlanned]
      // A backfill run (D5) deliberately re-delivers acked events — the drain plan must not
      // re-filter them out, or the freshly staged lines would sit in the outbox forever.
      .filter((evt) => opts.backfill === true || !state.ackedEvents.includes(evt.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const capped =
      opts.maxEvents !== undefined && opts.maxEvents >= 0
        ? allPending.slice(0, opts.maxEvents)
        : allPending;
    return { errors, refusals, stagedNow, allPending: allPending.length, pending: capped, abort };
  });

  // Phase 2 — the remote loop (no lock held across the awaits; every step is idempotent under
  // at-least-once redelivery). Dry-run evaluates the SAME gates and writes nothing.
  const pushedKeys = new Set<string>();
  const pushedIds: string[] = [];
  const refusals = [...plan.refusals];
  let aborted = plan.abort;
  if (aborted === undefined) {
    for (const evt of plan.pending) {
      const admission = admissionForSync(evt.payload, 'encrypted-remote');
      if (!admission.admitted) {
        refusals.push({
          eventId: evt.id,
          payloadId: evt.payload.id,
          reason: admission.reason ?? 'refused',
        });
        continue;
      }
      // D10 — the second scan covers previously staged lines (a staging-time gate already ran for
      // swept events; this one runs immediately before encryption, per the crash-window law).
      try {
        assertNoMemorySecrets(evt.payload);
      } catch {
        aborted = { eventId: evt.id, payloadId: evt.payload.id, kind: 'secret-scan' };
        break;
      }
      if (dryRun) continue;
      const routeKey = routeKeyFor(evt.id, opts.key);
      await backend.putObject(routeKey, encryptEvent(evt, opts.key));
      pushedKeys.add(routeKey);
      pushedIds.push(evt.id);
    }
    // The remote manifest (D7) is written AFTER the loop and only when bytes actually landed — an
    // aborted run leaves the remote untouched, and a push that had nothing to say touches nothing.
    // An EXISTING manifest is never rewritten by push (rotation owns the keyEpoch bump).
    if (!dryRun && pushedKeys.size > 0) {
      const existingManifest = await backend.getObject(REMOTE_MANIFEST_KEY);
      if (existingManifest === undefined) {
        await backend.putObject(
          REMOTE_MANIFEST_KEY,
          manifestBytes({
            v: '1',
            format: 'crsy-sync-1',
            keyFingerprint: keyFingerprint(opts.key),
            keyEpoch: state.keyEpoch,
          }),
        );
      }
    }
  }

  // Phase 3 — the content-addressed batch manifest over THIS run's route keys (idempotent: the same
  // key set re-derives the same batch id and a re-put is a byte-stable no-op). On an abort nothing
  // more is written: the next successful run re-derives the same events into its own batch.
  const batches: string[] = [];
  if (!dryRun && aborted === undefined && pushedKeys.size > 0) {
    const batchId = batchIdFor([...pushedKeys]);
    await backend.putObject(`b/${batchId}.json`, batchBytes([...pushedKeys]));
    batches.push(batchId);
  }

  // Phase 4 — acks LAST (D4): the durable result (the blobs + the batch manifest) is already on the
  // remote; a crash before any ack is an at-least-once redelivery deduped by the same `evt:` id.
  // The load-modify-save runs under the store's lock (the yellow-fix law: every sidecar save holds
  // it, so a concurrent stage/ack cannot be lost between load and save).
  if (!dryRun && aborted === undefined) {
    store.withLock(() => {
      for (const evtId of pushedIds) markEventAcked(store.rootDir, evtId);
    });
  }

  return {
    ok: aborted === undefined,
    store: scope,
    status: aborted !== undefined ? 'aborted' : dryRun ? 'dry-run' : 'pushed',
    dryRun,
    stagedNow: plan.stagedNow,
    planned: plan.pending.length,
    deferred: Math.max(0, plan.allPending - plan.pending.length),
    pushed: pushedIds.length,
    acked: aborted === undefined && !dryRun ? pushedIds.length : 0,
    batches,
    refusals,
    ...(aborted !== undefined ? { aborted } : {}),
    errors: plan.errors,
  };
}

// ─── pull (D6/D8/D9) ──────────────────────────────────────────────────────────

/**
 * Pull (D6/D8/D9): list `b/` → fetch unseen batches → fetch unseen blobs → decrypt → validate +
 * secret-scan (fail closed per object; `--skip` quarantines) → the apply law → record
 * `pulledBatchIds` in sync-state LAST. A halt leaves the cursor unmoved; a re-pull redelivers and
 * every redelivered event is a byte-identical no-op.
 */
export async function pullSync(
  store: MemoryStore,
  backend: SyncObjectStore,
  opts: PullOpts,
): Promise<SyncPullResult> {
  const scope = scopeOf(store);
  const dryRun = opts.dryRun === true;
  const state = loadSyncState(store.rootDir);
  const base = {
    ok: false,
    store: scope,
    dryRun,
    batchesSeen: 0,
    batchesApplied: 0,
    applied: [] as SyncApplied[],
    surfaced: [] as SyncSurfaced[],
    conflictsAdded: [] as ConflictRecord[],
    quarantined: [] as QuarantineRecord[],
    missing: [] as string[],
  };
  if (state === undefined) {
    return {
      ...base,
      status: 'not-initialized',
      message: 'no sync-state in this store root — run init-sync first (D5)',
    };
  }
  const repoId = opts.syncRepoId ?? repoIdOf(store, scope);
  if (scope === 'local' && repoId === undefined) {
    return {
      ...base,
      status: 'halted',
      halted: {
        reason: 'the local store manifest carries no repo.id — local-scope events cannot be placed',
      },
    };
  }
  const probe = await backend.probe();
  if (!probe.ok) {
    return {
      ...base,
      status: 'backend-unreachable',
      ...(probe.message !== undefined ? { message: probe.message } : {}),
    };
  }

  const listed = await backend.listObjects('b/');
  const batchKeys = listed.keys.filter((k) => k.startsWith('b/') && k.endsWith('.json')).sort();
  const pulled = new Set(state.cursors.pulledBatches);
  const unseen = batchKeys.filter((k) => !pulled.has(k));
  const result: SyncPullResult = {
    ...base,
    ok: false,
    status: 'pulled',
    batchesSeen: batchKeys.length,
  };
  if (unseen.length === 0) {
    return { ...result, ok: true };
  }

  // The state is mutated IN MEMORY and persisted ONCE, LAST (D4/D6): a crash anywhere below leaves
  // the cursor unmoved and the redelivery re-derives every recorded row.
  const next: SyncState = {
    ...state,
    cursors: { pulledBatches: [...state.cursors.pulledBatches] },
    ackedEvents: [...state.ackedEvents],
    conflicts: [...state.conflicts],
    quarantine: [...state.quarantine],
    purgeAcks: [...state.purgeAcks],
  };
  const seen = new Set<string>();

  for (const batchKey of unseen) {
    const bytes = await backend.getObject(batchKey);
    if (bytes === undefined) {
      result.missing.push(batchKey); // a listed-but-absent manifest — reported, never trusted
      continue;
    }
    const routeKeys = parseBatchManifest(bytes);
    if (routeKeys === undefined) {
      // A malformed batch manifest is a foreign object on the wire — fail closed, cursor unmoved.
      return {
        ...result,
        status: 'halted',
        halted: { reason: 'malformed batch manifest', key: batchKey },
      };
    }
    result.batchesApplied += 1;
    for (const routeKey of routeKeys) {
      const blob = await backend.getObject(routeKey);
      if (blob === undefined) {
        result.missing.push(routeKey); // a purged (or not-yet-visible) blob — reported, not fatal
        continue;
      }
      let evt: SyncEvent;
      try {
        evt = decryptEvent(blob, opts.key);
      } catch (err) {
        if (err instanceof SyncCryptoError) {
          // Fail closed (D8 step 1): the cursor is left unmoved. The offending blob cannot be
          // identified by event id without decrypting it, so --skip cannot quarantine it either.
          return {
            ...result,
            status: 'halted',
            halted: { reason: 'decryption failed — wrong key or tampered blob', key: routeKey },
          };
        }
        throw err;
      }
      if (seen.has(evt.id)) continue; // at-least-once redelivery inside the same remote
      seen.add(evt.id);
      if (evt.kind === 'purge.mark') {
        // D11 — a purge mark is an instruction to forget; the engine records the ack (the CLI purge
        // job owns the physical removal) and NEVER applies the payload.
        next.purgeAcks.push(evt.id);
        result.applied.push({ eventId: evt.id, payloadId: evt.payloadId, action: 'purge-mark' });
        continue;
      }
      // The sidecar path bypasses the store's write gate (D3), so the gate runs HERE on the
      // decrypted plaintext — schema first, then the secret scan.
      try {
        assertValidMemoryEntry(evt.payload as unknown as { id: string } & Record<string, unknown>);
      } catch {
        if (opts.skip === true) {
          const row: QuarantineRecord = {
            eventId: evt.id,
            payloadId: evt.payloadId,
            reason: 'invalid-schema',
            seenAt: opts.now(),
          };
          pushQuarantineDeduped(next.quarantine, result.quarantined, row);
          continue;
        }
        return {
          ...result,
          status: 'halted',
          halted: { reason: 'payload failed schema validation', eventId: evt.id, key: routeKey },
        };
      }
      try {
        assertNoMemorySecrets(evt.payload);
      } catch {
        if (opts.skip === true) {
          // Quarantined by id only — never the finding text, and the blob is NEVER deleted (D8/D10).
          const row: QuarantineRecord = {
            eventId: evt.id,
            payloadId: evt.payloadId,
            reason: 'secret-scan',
            seenAt: opts.now(),
          };
          pushQuarantineDeduped(next.quarantine, result.quarantined, row);
          continue;
        }
        return {
          ...result,
          status: 'halted',
          halted: { reason: 'secret-scan hit on a pulled event', eventId: evt.id, key: routeKey },
        };
      }
      applyPulledEvent(store, evt, scope, repoId, next, result, opts.now, dryRun);
    }
  }

  if (dryRun) {
    return { ...result, ok: true, status: 'dry-run' };
  }
  // The cursor advances only over batches whose manifests were actually read — a missing batch
  // manifest stays unseen so the next pull retries it (and keeps reporting it).
  const advanced = unseen.filter((k) => !result.missing.includes(k));
  next.cursors.pulledBatches.push(...advanced);
  // LAST (D4), under the store's lock: the state merged over the LATEST on-disk state (a concurrent
  // writer's acks/purge-acks survive this run's save; ledger rows dedupe on their outcome keys).
  store.withLock(() => {
    const latest = loadSyncState(store.rootDir);
    saveSyncState(store.rootDir, latest === undefined ? next : mergeSyncState(latest, next));
  });
  return { ...result, ok: true };
}

/**
 * The apply law (D8) for ONE decrypted event, as a total function over its four shapes. The event
 * lands in the SAME store role it was pushed from; an event naming a store role (or repo) this
 * machine has not configured is surfaced, never applied. Records/decisions/feedback apply through
 * `upsertEntries` — never a direct shard write, never an in-place mutation. `dryRun` computes the
 * same action for the report but writes nothing (a dry-run pull must not touch the store).
 */
function applyPulledEvent(
  store: MemoryStore,
  evt: SyncEvent,
  scope: SyncStoreScope,
  configuredRepoId: string | undefined,
  next: SyncState,
  result: SyncPullResult,
  now: () => string,
  dryRun: boolean,
): void {
  // Store-role placement (D8): the receiving store must BE the store the event was pushed from, and
  // a local-scope event must belong to THIS repo.
  if (evt.store !== scope) {
    result.surfaced.push({
      eventId: evt.id,
      payloadId: evt.payloadId,
      reason: 'unconfigured-store',
    });
    return;
  }
  if (scope === 'local' && evt.repoId !== configuredRepoId) {
    result.surfaced.push({ eventId: evt.id, payloadId: evt.payloadId, reason: 'different-repo' });
    return;
  }
  const collection = collectionForPayload(evt.payload.id, store);
  if (collection === undefined) {
    result.surfaced.push({
      eventId: evt.id,
      payloadId: evt.payloadId,
      reason: 'unsupported-payload-kind',
    });
    return;
  }
  // D8 step 2 — re-derive the content id from the payload bytes; a mismatch is a forged /
  // hand-edited payload: a hard conflict record, never applied.
  const payloadCheck = verifyPayloadId(evt.payload);
  if (!payloadCheck.ok) {
    const row: ConflictRecord = {
      eventId: evt.id,
      payloadId: evt.payload.id,
      localDigest: localDigestOf(store, collection, evt.payload.id),
      remoteDigest: blake3Hex(canonicalMemoryJson(evt.payload as MemoryEntry)),
      sourceDevice: evt.deviceId,
      seenAt: now(),
    };
    pushConflictDeduped(next.conflicts, result.conflictsAdded, row);
    result.surfaced.push({
      eventId: evt.id,
      payloadId: evt.payloadId,
      reason: 'payload-id-mismatch',
    });
    return;
  }
  // D8 steps 3/4 — absent locally → upsert through the store's own write gate; byte-identical →
  // no-op; same id different bytes → the local copy is retained + a conflict record. NEVER LWW.
  const local = directEntryOf(store, collection, evt.payload.id);
  if (local !== undefined) {
    if (canonicalMemoryJson(local) === canonicalMemoryJson(evt.payload as MemoryEntry)) {
      result.applied.push({
        eventId: evt.id,
        payloadId: evt.payload.id,
        action: 'noop',
      });
      return;
    }
    const row: ConflictRecord = {
      eventId: evt.id,
      payloadId: evt.payload.id,
      localDigest: blake3Hex(canonicalMemoryJson(local)),
      remoteDigest: blake3Hex(canonicalMemoryJson(evt.payload as MemoryEntry)),
      sourceDevice: evt.deviceId,
      seenAt: now(),
    };
    pushConflictDeduped(next.conflicts, result.conflictsAdded, row);
    return;
  }
  // Dry-run computes the action and reports it — the store is never touched (a dry-run pull must
  // not mutate shards, FTS, or the generation counter).
  if (dryRun) {
    result.applied.push({
      eventId: evt.id,
      payloadId: evt.payload.id,
      action: applyActionFor(evt.kind),
    });
    return;
  }
  store.upsertEntries(collection, [evt.payload as MemoryEntry]);
  result.applied.push({
    eventId: evt.id,
    payloadId: evt.payload.id,
    action: applyActionFor(evt.kind),
  });
  // D9 — a pulled retirement decision (the tombstone shape) is APPLIED by the write above; when its
  // subject is not a record this store holds, surface the ahead-of-record case.
  if (evt.kind === 'decision.append' && isRetirement(evt.payload)) {
    if (!recordPresent(store, evt.payload.subject)) {
      result.surfaced.push({
        eventId: evt.id,
        payloadId: evt.payload.id,
        reason: 'applied tombstone for unknown subject',
      });
    }
  }
}

/** Ledger-row append with the redelivery dedupe: a crash-redelivered event re-derives a
 *  byte-identical row (same event id + same outcome), so appending it twice would duplicate the
 *  ledger. The key mirrors queue.ts's merge keys — (eventId, remoteDigest) for conflicts,
 *  (eventId, payloadId, reason) for quarantine. */
function pushConflictDeduped(
  target: ConflictRecord[],
  added: ConflictRecord[],
  row: ConflictRecord,
): void {
  const key = `${row.eventId}|${row.remoteDigest}`;
  if (target.some((r) => `${r.eventId}|${r.remoteDigest}` === key)) return;
  target.push(row);
  added.push(row);
}

function pushQuarantineDeduped(
  target: QuarantineRecord[],
  added: QuarantineRecord[],
  row: QuarantineRecord,
): void {
  const key = `${row.eventId}|${row.payloadId}|${row.reason}`;
  if (target.some((r) => `${r.eventId}|${r.payloadId}|${r.reason}` === key)) return;
  target.push(row);
  added.push(row);
}

function isRetirement(payload: SyncEventPayload): payload is MemoryDecision {
  const kind = (payload as { kind?: unknown }).kind;
  return (
    (kind === 'retract' || kind === 'supersede') &&
    typeof (payload as { subject?: unknown }).subject === 'string'
  );
}

function applyActionFor(kind: SyncEvent['kind']): SyncApplied['action'] {
  if (kind === 'record.upsert') return 'upserted';
  if (kind === 'intake.upsert') return 'intake-upserted';
  if (kind === 'intake-checkpoint.append') return 'checkpoint-appended';
  return kind === 'purge.mark' ? 'purge-mark' : 'decision-applied';
}

/** The collection a payload id lands in for this store (undefined = never synced into this role). */
function collectionForPayload(payloadId: string, store: MemoryStore): MemoryCollection | undefined {
  const prefix = memoryIdPrefix(payloadId);
  if (prefix === 'mem') return store.role === 'local' ? 'active' : 'records';
  if (prefix === 'dec') return 'decisions';
  if (prefix === 'fb') return 'feedback';
  if ((prefix === 'intake' || prefix === 'icp') && store.collections.includes('intakes')) {
    return 'intakes';
  }
  return undefined;
}

/** The entry with EXACTLY this id in the collection (no alias chase — bytes compare against the
 *  direct line; an alias twin is a different address, not a variant of this id). */
function directEntryOf(
  store: MemoryStore,
  collection: MemoryCollection,
  id: string,
): MemoryEntry | undefined {
  const read = store.readShard(collection, memoryShard(id));
  return read.entries.find((e) => e.id === id);
}

/** The blake3 digest of the local entry with this id, or the 'absent' sentinel (a forged payload
 *  may name an id this store has never held). */
function localDigestOf(store: MemoryStore, collection: MemoryCollection, id: string): string {
  const local = directEntryOf(store, collection, id);
  return local === undefined ? 'absent' : blake3Hex(canonicalMemoryJson(local));
}

/** Whether the store physically holds this record id in its record collection. */
function recordPresent(store: MemoryStore, id: string): boolean {
  const collection: MemoryCollection = store.role === 'local' ? 'active' : 'records';
  return directEntryOf(store, collection, id) !== undefined;
}

// ─── status (D12) ─────────────────────────────────────────────────────────────

/**
 * Status (D12): sidecar counts + the conflicts/quarantine ledgers + cursor positions + the
 * keyEpoch, and — when a backend + key are supplied — the remote manifest's keyFingerprint match.
 * Honest empty shapes: an un-initialized store reports `available: false` and nothing else.
 */
export async function syncEngineStatus(
  store: MemoryStore,
  opts: StatusOpts = {},
): Promise<SyncStatusResult> {
  const scope = scopeOf(store);
  const state = loadSyncState(store.rootDir);
  const empty = {
    store: scope,
    staged: 0,
    pending: 0,
    acked: 0,
    batchesPulled: 0,
    conflicts: [] as ConflictRecord[],
    quarantine: [] as QuarantineRecord[],
    purgeAcks: 0,
  };
  if (state === undefined) {
    return {
      available: false,
      ...empty,
      status: 'not-initialized',
      message: 'no sync-state in this store root — run init-sync first (D5)',
    };
  }
  const stagedIds = readStagedEvents(store.rootDir).events.map((e) => e.id);
  const acked = new Set(state.ackedEvents);
  const result: SyncStatusResult = {
    available: true,
    ...empty,
    status: 'initialized',
    deviceId: state.deviceId,
    keyEpoch: state.keyEpoch,
    staged: stagedIds.length,
    pending: stagedIds.filter((id) => !acked.has(id)).length,
    acked: state.ackedEvents.length,
    batchesPulled: state.cursors.pulledBatches.length,
    conflicts: [...state.conflicts],
    quarantine: [...state.quarantine],
    purgeAcks: state.purgeAcks.length,
  };
  if (opts.backend === undefined) return result;
  const probe = await opts.backend.probe();
  const remote: NonNullable<SyncStatusResult['remote']> = {
    reachable: probe.ok,
    backend: opts.backend.kind,
    batches: 0,
    events: 0,
    ...(probe.message !== undefined ? { message: probe.message } : {}),
  };
  if (probe.ok) {
    const batches = await opts.backend.listObjects('b/');
    remote.batches = batches.keys.length;
    const events = await opts.backend.listObjects('ev/');
    remote.events = events.keys.length;
    const raw = await opts.backend.getObject(REMOTE_MANIFEST_KEY);
    const manifest = raw !== undefined ? parseRemoteManifest(raw) : undefined;
    if (manifest !== undefined) {
      remote.remoteKeyEpoch = manifest.keyEpoch;
      if (opts.key !== undefined) {
        remote.keyFingerprintMatch = manifest.keyFingerprint === keyFingerprint(opts.key);
      }
    }
  }
  result.remote = remote;
  return result;
}

// ─── key rotation (D7) ────────────────────────────────────────────────────────

/**
 * Rotate the sync key (D7): verify everything under the OLD key (a full drain — zero pending
 * afterwards, or the rotation fails), then re-encrypt + re-push every acked event under the NEW
 * key, write the new remote manifest, and bump `keyEpoch` in sync-state LAST. The stale-epoch
 * purge of the old-key objects is the CLI's job, never the engine's.
 */
export async function rotateSyncKey(
  store: MemoryStore,
  backend: SyncObjectStore,
  opts: SyncRunOpts & { newKey: Uint8Array; dryRun?: boolean },
): Promise<SyncRotateResult> {
  const dryRun = opts.dryRun === true;
  const state = loadSyncState(store.rootDir);
  if (state === undefined) {
    return {
      ok: false,
      status: 'not-initialized',
      reEncrypted: 0,
      batches: [],
      message: 'no sync-state in this store root — run init-sync first (D5)',
    };
  }
  const probe = await backend.probe();
  if (!probe.ok) {
    return {
      ok: false,
      status: 'backend-unreachable',
      reEncrypted: 0,
      batches: [],
      ...(probe.message !== undefined ? { message: probe.message } : {}),
    };
  }
  // 0. The rotation wedge guard (D7): a device whose outbox still holds staged-but-unacked events
  //    is mid-flight. Re-pushing those silently (as the old drain did) is exactly how a device that
  //    missed the rotation window wedges the fleet — the refusal is typed and actionable instead,
  //    and nothing is re-pushed by this call. The remediation is the amended rotation workflow:
  //    every device pulls clean BEFORE the rotate; a device that missed the window re-seeds under
  //    the new key (init-sync --backfill), never pulls mid-rotation.
  const stagedIds = readStagedEventIds(store.rootDir).ids;
  const ackedBefore = new Set(state.ackedEvents);
  const pending = stagedIds.filter((id) => !ackedBefore.has(id)).length;
  if (pending > 0) {
    return {
      ok: false,
      status: 'failed',
      reEncrypted: 0,
      batches: [],
      pending,
      warning:
        'rotation refused — the outbox still holds staged-but-unacked events. Run sync push until it drains, and ensure every peer device has pulled cleanly BEFORE rotating; a device that missed the window must be re-seeded under the new key (init-sync --backfill), never pull mid-rotation.',
      message: `${pending} staged-but-unacked event(s) in the outbox — push first, rotate second`,
    };
  }
  // 1. Verify everything under the old key: a full push drains the outbox; pending leftovers after
  //    it mean the old-key view is not complete and the rotation must not proceed.
  const drained = await pushSync(store, backend, { ...opts });
  // A refused event never staged and was never acked, so it is NOT part of the old-key roster —
  // only an unfinished drain (or an aborted run) blocks the rotation.
  if (!drained.ok || drained.deferred > 0) {
    return {
      ok: false,
      status: 'failed',
      reEncrypted: 0,
      batches: [],
      message: `the old-key push did not drain cleanly (pushed ${drained.pushed}, ${drained.deferred} deferred) — resolve before rotating`,
    };
  }
  if (dryRun) {
    return { ok: true, status: 'dry-run', reEncrypted: 0, batches: [] };
  }
  // 2. Re-encrypt + re-push every acked event under the NEW key (the outbox retains the staged
  //    lines, so the ack ledger is the roster of what must be re-encrypted).
  const fresh = loadSyncState(store.rootDir);
  if (fresh === undefined) {
    return { ok: false, status: 'failed', reEncrypted: 0, batches: [] };
  }
  const acked = new Set(fresh.ackedEvents);
  const roster = readStagedEvents(store.rootDir).events.filter((e) => acked.has(e.id));
  const newKeys = new Set<string>();
  for (const evt of roster) {
    const routeKey = routeKeyFor(evt.id, opts.newKey);
    await backend.putObject(routeKey, encryptEvent(evt, opts.newKey));
    newKeys.add(routeKey);
  }
  const batches: string[] = [];
  if (newKeys.size > 0) {
    const batchId = batchIdFor([...newKeys]);
    await backend.putObject(`b/${batchId}.json`, batchBytes([...newKeys]));
    batches.push(batchId);
  }
  // 3. The new remote manifest + the epoch bump, LAST (a crash before it re-runs as a repeatable
  //    re-encrypt: the same plaintext under the same new key routes to the same keys).
  const next: SyncState = { ...fresh, keyEpoch: fresh.keyEpoch + 1 };
  await backend.putObject(
    REMOTE_MANIFEST_KEY,
    manifestBytes({
      v: '1',
      format: 'crsy-sync-1',
      keyFingerprint: keyFingerprint(opts.newKey),
      keyEpoch: next.keyEpoch,
    }),
  );
  // The epoch bump is the rotation's durable terminal step — saved under the store's lock, merged
  // over the LATEST on-disk state so a concurrent writer's acks survive (yellow-fix law).
  store.withLock(() => {
    const latest = loadSyncState(store.rootDir);
    const merged = mergeSyncState(latest ?? fresh, next);
    saveSyncState(store.rootDir, { ...merged, keyEpoch: next.keyEpoch });
  });
  return {
    ok: true,
    status: 'rotated',
    reEncrypted: roster.length,
    batches,
    keyEpoch: next.keyEpoch,
    pending: 0,
  };
}
