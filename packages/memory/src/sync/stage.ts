import type { MemoryStore } from '../store.js';
/**
 * ADR-003 (Gate 4) — the WRITE-SITE staging port. The push sweep (bootstrap.ts derive-and-diff)
 * heals a crash between a store write and its stage on the NEXT push, but a tombstone written
 * between two pushes on device A is invisible to device B until A's next push — and worse, a
 * delete that never syncs resurrects on every other device. The fix is to stage AT the write site,
 * inside the SAME lock hold that writes the entry (D4: the store write and its sidecar stage are
 * one unit over the store's own lock).
 *
 * This helper is the single entry point every non-engine write site uses (supersede, delete,
 * contradicted-feedback suppression, purge tombstone). Gates, honestly:
 *   - team store → skipped (D2: git IS the team backend — its writes ARE the sync);
 *   - un-initialized sync-state → skipped (the push sweep heals the gap; staging needs the state's
 *     deviceId and refuses to invent one);
 *   - local scope without a resolvable repo id → skipped (nothing to derive under);
 *   - otherwise the SAME stageOutboundEvent gates run (payloadId, content-id re-derivation,
 *     envelope re-derivation, schema + secret-scan) — a refusal here THROWS, because the caller is
 *     mid-write and must fail loudly rather than stage nothing silently.
 *
 * Caller MUST hold the store's lock (`MemoryStore.withLock`) — the same convention as
 * stageOutboundEvent. Never opens a second lock.
 */
import type { MemoryDecision, MemoryEntry, MemoryFeedback } from '../types.js';
import { type SyncStoreScope, buildSyncEvent } from './event.js';
import { type SyncState, loadSyncState, stageOutboundEvent } from './queue.js';

/** Context a write site supplies to stage its own write. `now` feeds ONLY the envelope ts
 *  metadata — never an id or a hash. */
export interface SyncStageContext {
  principalId: string;
  /** The env the memory home resolves under (the same env the store was built with). */
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  /** The stable cross-clone sync id override (the sync config's `syncRepoId`), when known. */
  syncRepoId?: string;
}

/** The kinds a write site can stage: a decision append or a feedback append. */
export type StageableKind = 'decision.append' | 'feedback.append';

/** The result of {@link stageSyncableWrite}: `undefined` = honestly skipped (team store,
 *  un-initialized state, or no derivable repo id — the push sweep owns the heal); otherwise the
 *  stage outcome from {@link stageOutboundEvent}. */
export type SyncStageResult = { id: string; staged: boolean; idempotent: boolean } | undefined;

/**
 * Stage the event for an entry THIS caller is about to write (or has just written) under its own
 * lock hold. Pure bookkeeping around {@link stageOutboundEvent}: the caller's write remains the
 * durable result; the stage is bookkeeping that rides the same lock hold.
 */
export function stageSyncableWrite(
  store: MemoryStore,
  kind: StageableKind,
  payload: MemoryEntry,
  ctx: SyncStageContext,
): SyncStageResult {
  if (store.role === 'team') return undefined; // D2 — git IS the team backend
  const state: SyncState | undefined = loadSyncState(store.rootDir);
  if (state === undefined) return undefined; // un-initialized — the push sweep heals (D5)
  const scope: SyncStoreScope = store.role === 'local' ? 'local' : 'global';
  const repoId = scope === 'local' ? (ctx.syncRepoId ?? store.readManifest()?.repo?.id) : undefined; // global events NEVER carry a repoId (deriveEventId refuses)
  if (scope === 'local' && repoId === undefined) return undefined;
  const evt = buildSyncEvent({
    kind,
    store: scope,
    ...(repoId !== undefined ? { repoId } : {}),
    deviceId: state.deviceId,
    principalId: ctx.principalId,
    // The write site only stages decision/feedback payloads (the push sweep covers records); this
    // cast narrows MemoryEntry to the two payload kinds these event kinds admit.
    payload: payload as MemoryDecision | MemoryFeedback,
    ts: (ctx.now ?? (() => new Date().toISOString()))(),
  });
  return stageOutboundEvent(evt, store.rootDir);
}
