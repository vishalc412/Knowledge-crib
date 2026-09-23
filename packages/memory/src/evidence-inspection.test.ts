import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
/**
 * UI remediation Phase 4 — evidence inspection. Every evidence kind yields a display-safe detail or
 * an explicit unavailable state; receipts are summarized without argv, raw output or `meta`; and an
 * inaccessible record, a missing record and an out-of-range index are indistinguishable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type GateReceipt,
  type MemoryAnchorPort,
  MemoryApi,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  derivePropositionKey,
  memoryRecordId,
  memoryRecordV2Id,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const REPO = 'r-evidence';
const LIVE = 'sym:src/a.ts#A.run@L10';
const MOVED_FROM = 'sym:src/old.ts#A.run@L3';
const GONE = 'sym:src/gone.ts#G.one@L5';
const SECRET = 'SENTINEL-SECRET-do-not-leak';

function node(id: string, file: string, qualifiedName: string, hash: string): Node {
  return {
    id,
    kind: 'symbol',
    name: qualifiedName.split('.').pop() ?? qualifiedName,
    qualifiedName,
    file,
    span: { start: 10, end: 14 },
    lang: 'typescript',
    hash,
  } as unknown as Node;
}

const nodes = [
  node(LIVE, 'src/a.ts', 'A.run', 'blake3:aa11'),
  node('art:docs/policy.md', 'docs/policy.md', 'policy', 'blake3:dd44'),
];

function receipt(id: string, ts: string, passed: boolean): GateReceipt {
  return {
    id,
    schemaVersion: '1',
    policyHash: 'blake3:dd44',
    profileHash: 'blake3:ee55',
    executable: `/usr/bin/${SECRET}`,
    args: ['--token', SECRET],
    head: 'a'.repeat(40),
    worktreeDigest: 'blake3:ff66',
    exitCode: passed ? 0 : 1,
    durationMs: 12,
    outputDigest: 'blake3:0077',
    assertions: [{ name: 'tests-pass', passed }],
    runner: 'cli',
    ts,
    meta: { stdout: SECRET },
  } as GateReceipt;
}

function v1(evidence: MemoryEvidence[], claim = 'A.run validates input'): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: LIVE,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [LIVE],
    evidence,
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: T0,
  };
}

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-evidence-home-'));
  env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: undefined,
    KCRIB_PRINCIPAL_ID: 'principal:me',
  };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

function apiWith(records: unknown[], receipts: GateReceipt[] = []) {
  const local = MemoryStore.local(REPO, { env, now: () => T0 });
  local.upsertEntries('active', records as MemoryRecord[]);
  if (receipts.length) local.upsertEntries('receipts', receipts);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return new MemoryApi({
    stores: { local },
    env,
    now: () => T0,
    soul: {
      getNode: (id: string) => byId.get(id),
      allNodes: () => nodes,
      rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
    } as unknown as MemoryAnchorPort,
  });
}

const quote = (soulId: string, targetHash: string): MemoryEvidence => ({
  kind: 'source-quote',
  verdict: 'valid',
  checkedAt: T0,
  soulId,
  quote: 'validates input',
  targetHash,
  startLine: 11,
});

describe('MemoryApi.inspectEvidence', () => {
  it('source quote: saved quote plus the live location, flagged when the code changed', () => {
    const record = v1([quote(LIVE, 'blake3:aa11'), quote(LIVE, 'blake3:bb22')]);
    const api = apiWith([record]);
    const same = api.inspectEvidence(record.id, 0);
    expect(same).toMatchObject({
      found: true,
      kind: 'source-quote',
      total: 2,
      detail: {
        kind: 'source-quote',
        savedQuote: 'validates input',
        savedStartLine: 11,
        location: {
          ref: LIVE,
          state: 'current',
          readableNodeId: LIVE,
          file: 'src/a.ts',
          changedSinceCheck: false,
        },
      },
    });
    const changed = api.inspectEvidence(record.id, 1);
    expect(
      changed.found && changed.detail.kind === 'source-quote' && changed.detail.location,
    ).toMatchObject({ changedSinceCheck: true });
  });

  it('source quote: a moved node reattaches; a vanished one keeps only the saved quote', () => {
    const record = v1([quote(MOVED_FROM, 'blake3:aa11'), quote(GONE, 'blake3:cc33')]);
    const api = apiWith([record]);
    const moved = api.inspectEvidence(record.id, 0);
    expect(
      moved.found && moved.detail.kind === 'source-quote' && moved.detail.location,
    ).toMatchObject({ state: 'moved', readableNodeId: LIVE });
    const gone = api.inspectEvidence(record.id, 1);
    if (!gone.found || gone.detail.kind !== 'source-quote') throw new Error('expected a quote');
    expect(gone.detail.location?.state).toBe('gone');
    expect(gone.detail.location?.readableNodeId).toBeUndefined();
    expect(gone.detail.savedQuote).toBe('validates input');
  });

  it('execution assertion: a sanitized receipt summary, never argv, raw output or meta', () => {
    const rcpt = receipt('rcpt:0001', T0, true);
    const record = v1([
      {
        kind: 'execution-assertion',
        verdict: 'valid',
        checkedAt: T0,
        receiptId: rcpt.id,
        assertion: 'tests-pass',
      },
      {
        kind: 'execution-assertion',
        verdict: 'invalid',
        checkedAt: T0,
        receiptId: 'rcpt:missing',
        assertion: 'tests-pass',
      },
    ]);
    const api = apiWith([record], [rcpt]);
    const ok = api.inspectEvidence(record.id, 0);
    expect(ok).toMatchObject({
      found: true,
      detail: {
        kind: 'execution-assertion',
        outcome: 'passed',
        receipt: {
          id: rcpt.id,
          ranAt: T0,
          head: 'a'.repeat(40),
          exitCode: 0,
          outputDigest: 'blake3:0077',
        },
      },
    });
    expect(JSON.stringify(ok)).not.toContain(SECRET);
    const missing = api.inspectEvidence(record.id, 1);
    expect(missing).toMatchObject({
      found: true,
      verdict: 'invalid',
      detail: { receipt: null, outcome: 'not-recorded', receiptId: 'rcpt:missing' },
    });
  });

  it('committed policy: resolves an indexed artifact, or says it cannot', () => {
    const record = v1([
      {
        kind: 'committed-policy',
        verdict: 'valid',
        checkedAt: T0,
        artifactId: 'art:docs/policy.md',
        anchor: '#retention',
      },
      {
        kind: 'committed-policy',
        verdict: 'degraded',
        checkedAt: T0,
        artifactId: 'art:docs/removed.md',
      },
    ]);
    const api = apiWith([record]);
    expect(api.inspectEvidence(record.id, 0)).toMatchObject({
      detail: {
        kind: 'committed-policy',
        anchor: '#retention',
        location: { state: 'current', readableNodeId: 'art:docs/policy.md' },
      },
    });
    const removed = api.inspectEvidence(record.id, 1);
    expect(
      removed.found &&
        removed.detail.kind === 'committed-policy' &&
        removed.detail.location?.readableNodeId,
    ).toBeFalsy();
  });

  it('human attestation: who attested and when, marked as attestation not code', () => {
    const record = v1([
      {
        kind: 'human-attestation',
        verdict: 'valid',
        checkedAt: T0,
        actor: 'human:reviewer',
        attestedAt: T0,
        attestationId: 'att:1',
        tty: true,
      },
    ]);
    expect(apiWith([record]).inspectEvidence(record.id, 0)).toMatchObject({
      detail: {
        kind: 'human-attestation',
        attestedBy: 'human:reviewer',
        attestedAt: T0,
        attestationId: 'att:1',
        interactive: true,
      },
    });
  });

  it('receipt pair: both summaries in order, or the missing side named', () => {
    const failing = receipt('rcpt:0002', T0, false);
    const passing = receipt('rcpt:0003', T1, true);
    const record = v1([
      {
        kind: 'receipt-pair',
        verdict: 'valid',
        checkedAt: T1,
        failingReceiptId: failing.id,
        passingReceiptId: passing.id,
      },
      {
        kind: 'receipt-pair',
        verdict: 'degraded',
        checkedAt: T1,
        failingReceiptId: failing.id,
        passingReceiptId: 'rcpt:gone',
      },
    ]);
    const api = apiWith([record], [failing, passing]);
    const both = api.inspectEvidence(record.id, 0);
    expect(both).toMatchObject({
      detail: {
        kind: 'receipt-pair',
        ordered: true,
        failing: { id: failing.id, exitCode: 1 },
        passing: { id: passing.id, exitCode: 0 },
      },
    });
    expect(JSON.stringify(both)).not.toContain(SECRET);
    expect(api.inspectEvidence(record.id, 1)).toMatchObject({
      detail: { passing: null, passingReceiptId: 'rcpt:gone', ordered: null },
    });
  });

  it('missing record, out-of-range index and another principal’s record are the same not-found', () => {
    const mine = v1([quote(LIVE, 'blake3:aa11')]);
    const kind = 'fact' as const;
    const subject = 'topic:foreign';
    const ev: MemoryEvidence[] = [
      { kind: 'human-attestation', verdict: 'valid', checkedAt: T0, actor: 'ci' },
    ];
    const foreign: MemoryRecordV2 = {
      id: memoryRecordV2Id({
        kind,
        subject,
        propositionKey: derivePropositionKey({ subject }),
        claim: 'theirs',
        evidence: ev,
      }),
      schemaVersion: '2',
      visibility: 'workspace',
      kind,
      subject,
      propositionKey: derivePropositionKey({ subject }),
      claim: 'theirs',
      validTime: { from: T0 },
      transactionTime: { observedAt: T0, recordedAt: T0 },
      evidence: ev,
      provenance: {
        principalId: 'principal:someone-else',
        deviceId: 'd',
        actorId: 'a',
        agentId: 'a',
        clientId: 'c',
      },
      lineage: {},
      sensitivity: 'internal',
      retentionPolicyId: 'ret:default',
    };
    const api = apiWith([mine, foreign]);
    expect(api.inspectEvidence(foreign.id, 0)).toEqual({ found: false });
    expect(api.inspectEvidence('mem:does-not-exist', 0)).toEqual({ found: false });
    expect(api.inspectEvidence(mine.id, 1)).toEqual({ found: false });
    expect(api.inspectEvidence(mine.id, -1)).toEqual({ found: false });
    expect(api.inspectEvidence(mine.id, 0.5)).toEqual({ found: false });
  });
});
