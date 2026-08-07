/**
 * W3 Slice 3b — the MCP memory verbs (PRD lines 226–248): `brief` (typed-group one-call retrieval),
 * `memory_recall`, `memory_get`, `memory_status`, `memory_audit`. Covers the three exit-gate
 * invariants (PRD line 338):
 *   #1 normal recall never returns invalid / orphaned / superseded / retracted / pending records;
 *   #2 conflicting claims appear together;
 *   #3 repeat ifHash responses collapse to `{ unchanged: true, hash }` (well under 100 tokens).
 * Plus the degrade-to-`{ memory: 'not configured' }` path when no ledger is wired (mirrors `vcs`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordKind,
  MemoryStore,
  type Verdicts,
  __resetMemoryLockGuardForTest,
  memoryRecordId,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryDeps } from './verbs.js';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-verbs-mem';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;

function evidence(partial: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: BLAKE_A,
    ...partial,
  };
}

function record(opts: {
  subject?: string;
  claim?: string;
  boundary?: 'repo' | 'global';
  repoId?: string;
  appliesTo?: string[];
  trust?: Verdicts['trust'];
  verdicts?: Partial<Verdicts>;
  createdAt?: string;
  kind?: MemoryRecordKind;
  evidenceItems?: MemoryEvidence[];
}): MemoryRecord {
  const kind = opts.kind ?? 'fact';
  const subject = opts.subject ?? 'sym:src/a.ts#A.b';
  const claim = opts.claim ?? 'A.b does the thing';
  const boundary = opts.boundary ?? 'repo';
  const scope =
    boundary === 'global'
      ? { boundary: 'global' as const }
      : { boundary: 'repo' as const, repoId: opts.repoId ?? REPO };
  const appliesTo = opts.appliesTo ?? [subject];
  const ev = opts.evidenceItems ?? [evidence({ soulId: subject, quote: 'does the thing' })];
  const input = {
    kind,
    subject,
    claim,
    scope,
    appliesTo,
    evidence: ev,
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: opts.trust ?? 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
      ...opts.verdicts,
    },
    createdAt: opts.createdAt ?? NOW,
  };
}

let repo: string;
let home: string;
let regDir: string;
let env: NodeJS.ProcessEnv;
let soul: SoulStore;
let index: SqliteIndexStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-mem-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), `${'\n'.repeat(8)}class A { b() { return 1; } }\n`);
  home = mkdtempSync(join(tmpdir(), 'mem-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'mem-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();

  soul = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: NOW }),
  });
  soul.load();
  soul.commit(NOW);
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
});

function teamStore(records: MemoryRecord[]): MemoryStore {
  const crib = mkdtempSync(join(tmpdir(), 'mem-crib-'));
  writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: REPO } }));
  const team = MemoryStore.team(crib, { env, now: () => NOW });
  team.upsertEntries('records', records);
  return team;
}

function verbsWithMemory(team: MemoryStore): Verbs {
  const mem: MemoryDeps = { team };
  return new Verbs({ soul, index, repoRoot: repo, memory: mem });
}

// ─── degrade-to-not-configured ───────────────────────────────────────────────

describe('memory verbs without a configured ledger', () => {
  it('memory_recall / memory_get / memory_status / memory_audit report "not configured"', () => {
    const v = new Verbs({ soul, index, repoRoot: repo });
    // applyIfHash always stamps a `hash`, so check the memory field rather than exact equality.
    expect((v.memoryRecall({}) as Record<string, unknown>).memory).toBe('not configured');
    expect((v.memoryGet({ id: 'mem:whatever' }) as Record<string, unknown>).memory).toBe(
      'not configured',
    );
    expect((v.memoryStatus({}) as Record<string, unknown>).memory).toBe('not configured');
    expect((v.memoryAudit({}) as Record<string, unknown>).memory).toBe('not configured');
  });

  it('brief still returns empty memories (not an error) when no ledger is configured', () => {
    const v = new Verbs({ soul, index, repoRoot: repo });
    const res = v.brief({ q: 'login' }) as Record<string, unknown>;
    expect(Array.isArray(res.memories)).toBe(true);
    expect((res.memories as unknown[]).length).toBe(0);
    expect(Array.isArray(res.codeHits)).toBe(true);
    expect(Array.isArray(res.instructions)).toBe(true);
  });
});

// ─── memory_recall (exit-gate invariant #1 + #2) ─────────────────────────────

describe('memoryRecall', () => {
  it('returns eligible records and excludes invalid / superseded / retracted / orphaned (invariant #1)', () => {
    const ok = record({ subject: 'topic:ok', claim: 'ok-claim' });
    const invalid = record({
      subject: 'topic:bad',
      claim: 'invalid',
      verdicts: { evidence: 'invalid' },
    });
    const superseded = record({
      subject: 'topic:bad',
      claim: 'super',
      verdicts: { lifecycle: 'superseded' },
    });
    const retracted = record({
      subject: 'topic:bad',
      claim: 'retract',
      verdicts: { lifecycle: 'retracted' },
    });
    const orphaned = record({
      subject: 'topic:bad',
      claim: 'orphan',
      verdicts: { applicability: 'orphaned' },
    });
    const v = verbsWithMemory(teamStore([ok, invalid, superseded, retracted, orphaned]));
    const res = v.memoryRecall({}) as Record<string, unknown>;
    const memories = res.memories as Array<{ id: string }>;
    expect(memories.map((m) => m.id)).toEqual([ok.id]);
    const provenance = res.provenance as { counts: { considered: number; eligible: number } };
    expect(provenance.counts.considered).toBe(5);
    expect(provenance.counts.eligible).toBe(1);
  });

  it('conflicting claims appear together (invariant #2)', () => {
    const r1 = record({ subject: 'topic:auth-strategy', claim: 'use oauth' });
    const r2 = record({ subject: 'topic:auth-strategy', claim: 'use saml' });
    const v = verbsWithMemory(teamStore([r1, r2]));
    const res = v.memoryRecall({}) as Record<string, unknown>;
    const memories = (res.memories as Array<{ id: string }>).map((m) => m.id).sort();
    expect(memories).toEqual([r1.id, r2.id].sort());
    const conflicts = res.conflicts as Array<{ subject: string; recordIds: string[] }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.subject).toBe('topic:auth-strategy');
    expect(conflicts[0]?.recordIds.sort()).toEqual([r1.id, r2.id].sort());
  });

  it('respects the default limit of 5 and max 20', () => {
    const recs = Array.from({ length: 8 }, (_, i) =>
      record({ subject: `topic:n${i}`, claim: `claim-${i}` }),
    );
    const v = verbsWithMemory(teamStore(recs));
    const def = v.memoryRecall({}) as Record<string, unknown>;
    expect((def.memories as unknown[]).length).toBe(5);
    expect(def.truncated).toBe(true);
    const big = v.memoryRecall({ limit: 20 }) as Record<string, unknown>;
    expect((big.memories as unknown[]).length).toBe(8);
  });

  it('withEvidence opt-in returns full evidence items; default returns summaries', () => {
    const r = record({
      subject: 'topic:x',
      claim: 'claim',
      evidenceItems: [evidence({ soulId: 'sym:src/a.ts#A.b', quote: 'q1' })],
    });
    const v = verbsWithMemory(teamStore([r]));
    const summary = v.memoryRecall({}) as Record<string, unknown>;
    const sumItems = (summary.memories as Array<{ evidenceItems: unknown[] }>)[0]!.evidenceItems;
    expect(sumItems[0]).toMatchObject({ kind: 'source-quote', verdict: 'valid' });
    // summary view does NOT include the raw quote
    expect(JSON.stringify(sumItems[0])).not.toContain('does the thing');
    const full = v.memoryRecall({ withEvidence: true }) as Record<string, unknown>;
    const fullItems = (full.memories as Array<{ evidenceItems: Array<{ quote?: string }> }>)[0]!
      .evidenceItems;
    expect(fullItems[0]?.quote).toBe('q1');
  });
});

// ─── memory_get ──────────────────────────────────────────────────────────────

describe('memoryGet', () => {
  it('finds a record by id and returns the full record + source', () => {
    const r = record({ subject: 'topic:x', claim: 'the-claim' });
    const v = verbsWithMemory(teamStore([r]));
    const res = v.memoryGet({ id: r.id }) as Record<string, unknown>;
    expect(res.found).toBeUndefined();
    expect(res.id).toBe(r.id);
    expect(res.claim).toBe('the-claim');
    expect(res.source).toBe('team');
  });

  it('returns found:false for an unknown id', () => {
    const v = verbsWithMemory(teamStore([record({ subject: 'topic:x', claim: 'c' })]));
    const res = v.memoryGet({ id: 'mem:does-not-exist' }) as Record<string, unknown>;
    expect(res.found).toBe(false);
  });
});

// ─── memory_status ───────────────────────────────────────────────────────────

describe('memoryStatus', () => {
  it('tallies by trust / evidence / lifecycle / source + eligible + quarantined', () => {
    const ok = record({ subject: 'topic:ok', claim: 'ok', trust: 'team' });
    const degraded = record({
      subject: 'topic:deg',
      claim: 'deg',
      trust: 'team',
      verdicts: { evidence: 'degraded' },
    });
    const superseded = record({
      subject: 'topic:sup',
      claim: 'sup',
      trust: 'team',
      verdicts: { lifecycle: 'superseded' },
    });
    const v = verbsWithMemory(teamStore([ok, degraded, superseded]));
    const res = v.memoryStatus({}) as {
      counts: {
        total: number;
        eligible: number;
        pending: number;
        trust: Record<string, number>;
        evidence: Record<string, number>;
        lifecycle: Record<string, number>;
        source: Record<string, number>;
      };
    };
    expect(res.counts.total).toBe(3);
    expect(res.counts.eligible).toBe(2); // ok + degraded; superseded is ineligible
    expect(res.counts.pending).toBe(0); // no local store ⇒ no candidates
    expect(res.counts.trust.team).toBe(3);
    expect(res.counts.evidence.valid).toBe(2);
    expect(res.counts.evidence.degraded).toBe(1);
    expect(res.counts.lifecycle.active).toBe(2);
    expect(res.counts.lifecycle.superseded).toBe(1);
    expect(res.counts.source.team).toBe(3);
  });
});

// ─── memory_audit ────────────────────────────────────────────────────────────

describe('memoryAudit', () => {
  it('reports drift, conflicts, privacy (0 secrets), and trust distribution', () => {
    const r1 = record({ subject: 'topic:auth-strategy', claim: 'use oauth' });
    const r2 = record({ subject: 'topic:auth-strategy', claim: 'use saml' });
    const v = verbsWithMemory(teamStore([r1, r2]));
    const res = v.memoryAudit({}) as {
      validation: { records: number; drifted: number };
      conflicts: Array<{ subject: string }>;
      privacy: { secretsScannedOnWrite: boolean; secretsFlagged: number };
      trust: Record<string, number>;
    };
    expect(res.validation.records).toBe(2);
    expect(res.validation.drifted).toBe(0); // stamped == fresh (no evaluator configured)
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]?.subject).toBe('topic:auth-strategy');
    expect(res.privacy.secretsScannedOnWrite).toBe(true);
    expect(res.privacy.secretsFlagged).toBe(0);
    expect(res.trust.local).toBe(2);
  });
});

// ─── brief (one-call typed-group retrieval) ──────────────────────────────────

describe('brief', () => {
  it('returns codeHits / instructions / memories as separate typed groups (no score fusion)', () => {
    const r = record({ subject: 'topic:auth', claim: 'auth handles login' });
    const v = verbsWithMemory(teamStore([r]));
    const res = v.brief({ q: 'login' }) as Record<string, unknown>;
    expect(Array.isArray(res.codeHits)).toBe(true);
    expect(Array.isArray(res.instructions)).toBe(true);
    expect(Array.isArray(res.memories)).toBe(true);
    // memories carry a score; codeHits carry a BM25 score — never merged into one array
    expect(res.memories).not.toBe(res.codeHits);
  });

  it('ifHash repeat collapses to { unchanged: true, hash } (invariant #3, < 100 tokens)', () => {
    const r = record({ subject: 'topic:auth', claim: 'auth handles login' });
    const v = verbsWithMemory(teamStore([r]));
    const first = v.brief({ q: 'login' }) as Record<string, unknown>;
    const hash = first.hash as string;
    expect(hash).toBeTruthy();
    const second = v.brief({ q: 'login', ifHash: hash }) as Record<string, unknown>;
    expect(second.unchanged).toBe(true);
    expect(second.hash).toBe(hash);
    // the collapsed response is tiny — well under 100 tokens (the exit-gate invariant #3)
    expect(JSON.stringify(second).length).toBeLessThan(400);
  });
});
