/**
 * Shared fixtures for the sync module tests: fully-valid memory-1 / memory-2 records, decisions,
 * feedback, and envelopes built from them (ids content-addressed via the real id builders, so every
 * verifyPayloadId / staging gate passes honestly). The test clocks are CONSTANTS — no Date.now()
 * anywhere near an id or a frozen seed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type MemoryDecision,
  type MemoryEntry,
  type MemoryFeedback,
  type MemoryRecord,
  type MemoryRecordV2,
  decisionId,
  derivePropositionKey,
  feedbackId,
  memoryRecordId,
  memoryRecordV2Id,
} from '../index.js';
import { type SyncEvent, buildSyncEvent } from './event.js';

export const NOW = '2026-01-01T00:00:00.000Z';
export const LATER = '2027-01-01T00:00:00.000Z';
export const REPO = 'r-sync';
export const DEVICE = 'device-a';
export const PRINCIPAL = 'principal-vishal';
/** 64 hex chars = 32 bytes — a real key by shape (never a real secret; it is a test constant). */
export const KEY_HEX = 'ab'.repeat(32);

export function evidence(): MemoryRecord['evidence'][number] {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: 'blake3:abc',
  };
}

/** A fully-valid memory-1 record (id content-addressed from the v1 seed). */
export function v1Record(claim = 'A.b does the thing'): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: 'sym:src/a.ts#A.b',
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: ['sym:src/a.ts#A.b'],
    evidence: [evidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  };
}

/** A fully-valid memory-2 record (v2 seed; governance fields settable for the admission matrix). */
export function v2Record(
  over: {
    claim?: string;
    visibility?: MemoryRecordV2['visibility'];
    sensitivity?: MemoryRecordV2['sensitivity'];
    retentionPolicyId?: string;
  } = {},
): MemoryRecordV2 {
  const subject = 'sym:src/a.ts#A.b';
  const claim = over.claim ?? 'A.b does the thing';
  const evidence_ = [evidence()];
  const id = memoryRecordV2Id({
    kind: 'fact',
    subject,
    propositionKey: derivePropositionKey({ subject }),
    claim,
    evidence: evidence_,
  });
  return {
    id,
    schemaVersion: '2',
    visibility: over.visibility ?? 'workspace',
    kind: 'fact',
    subject,
    propositionKey: derivePropositionKey({ subject }),
    claim,
    validTime: { from: NOW, to: LATER },
    transactionTime: { observedAt: NOW, recordedAt: NOW },
    evidence: evidence_,
    provenance: {
      principalId: PRINCIPAL,
      deviceId: DEVICE,
      actorId: 'claude-code',
      clientId: 'claude-code',
    },
    lineage: {},
    sensitivity: over.sensitivity ?? 'internal',
    retentionPolicyId: over.retentionPolicyId ?? 'ret:default',
  };
}

export function decision(
  kind: MemoryDecision['kind'],
  subject = 'mem:x',
  successor?: string,
): MemoryDecision {
  return {
    id: decisionId({ kind, subject, successor, actor: 'ci', reason: 'gate' }),
    schemaVersion: '1',
    kind,
    subject,
    ...(successor !== undefined ? { successor } : {}),
    actor: 'ci',
    reason: 'gate',
    ts: NOW,
  };
}

export function feedback(signal: MemoryFeedback['signal'], subject = 'mem:x'): MemoryFeedback {
  return {
    id: feedbackId({ signal, subject, actor: 'ci' }),
    schemaVersion: '1',
    signal,
    subject,
    actor: 'ci',
    ts: NOW,
  };
}

/** A valid envelope wrapping a payload. Default store = local (repoId attached). The payload is
 *  typed wide (MemoryEntry) so sweep results — whose walk only yields `mem:`/`dec:`/`fb:` entries —
 *  can be passed straight through; the narrowing to the envelope payload union is safe by the walk's
 *  own prefix dispatch. */
export function eventFor(
  payload: MemoryEntry,
  over: {
    kind?: SyncEvent['kind'];
    store?: SyncEvent['store'];
    repoId?: string;
    deviceId?: string;
    ts?: string;
  } = {},
): SyncEvent {
  return buildSyncEvent({
    kind: over.kind ?? 'record.upsert',
    store: over.store ?? 'local',
    repoId: over.store === 'global' ? undefined : (over.repoId ?? REPO),
    deviceId: over.deviceId ?? DEVICE,
    principalId: PRINCIPAL,
    // The walk (and every other producer here) only yields `mem:`/`dec:`/`fb:` payloads, so this
    // narrowing never widens beyond what buildSyncEvent admits.
    payload: payload as SyncEvent['payload'],
    ts: over.ts ?? NOW,
  });
}

/** Test env relocating the memory home + registry into fresh tmpdirs. */
export interface TestHome {
  home: string;
  regDir: string;
  env: NodeJS.ProcessEnv;
}

export function freshTestHome(): TestHome {
  const home = mkdtempSync(join(tmpdir(), 'sync-home-'));
  const regDir = mkdtempSync(join(tmpdir(), 'sync-reg-'));
  return {
    home,
    regDir,
    env: { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir },
  };
}
