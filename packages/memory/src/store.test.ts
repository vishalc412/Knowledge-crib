import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * W2 Slice 2 — the three memory stores: path resolution, atomic writes, repoId resolution +
 * registry fallback, locked/validated/secret-scanned mutations, the no-cross-store-nesting lock
 * guard, manifest recompute, and the team-never-deleted guarantee.
 */
import { CribLock } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LockBusyError,
  type MemoryCandidate,
  type MemoryDecision,
  MemoryLockNestingError,
  type MemoryRecord,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  decisionId,
  globalStoreRoot,
  localStoreRoot,
  memoryCandidateId,
  memoryHome,
  memoryRecordId,
  memoryShard,
  createIntakeRequirement,
  policyPath,
  readRepoId,
  teamStoreRoot,
  writeJsonAtomic,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-test';

function evidence(): MemoryRecord['evidence'][number] {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: 'blake3:abc',
  };
}

function recordInput(claim = 'A.b does the thing') {
  return {
    kind: 'fact' as const,
    subject: 'sym:src/a.ts#A.b',
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: ['sym:src/a.ts#A.b'],
    evidence: [evidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
}

function record(claim = 'A.b does the thing'): MemoryRecord {
  const i = recordInput(claim);
  return {
    id: memoryRecordId(i),
    schemaVersion: '1',
    kind: i.kind,
    subject: i.subject,
    claim: i.claim,
    scope: i.scope,
    appliesTo: i.appliesTo,
    evidence: i.evidence,
    authorship: i.authorship,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  };
}

function candidate(claim = 'A.b might do the thing'): MemoryCandidate {
  const i = recordInput(claim);
  return {
    id: memoryCandidateId(i),
    schemaVersion: '1',
    kind: i.kind,
    subject: i.subject,
    claim: i.claim,
    scope: i.scope,
    appliesTo: i.appliesTo,
    evidence: i.evidence,
    authorship: i.authorship,
    origin: 'observe',
    proposedAt: NOW,
  };
}

function decision(): MemoryDecision {
  return {
    id: decisionId({ kind: 'activate', subject: 'mem:x', actor: 'ci' }),
    schemaVersion: '1',
    kind: 'activate',
    subject: 'mem:x',
    actor: 'ci',
    ts: NOW,
  };
}

let home = '';
let regDir = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'mem-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
});

describe('path resolution', () => {
  it('memoryHome defaults to ~/.crib/memory and respects KCRIB_MEMORY_DIR', () => {
    expect(memoryHome().endsWith(join('.crib', 'memory'))).toBe(true);
    expect(memoryHome(env)).toBe(home);
  });

  it('local/global/team roots + policyPath compose under the home / cribDir', () => {
    expect(localStoreRoot(REPO, env)).toBe(join(home, 'repos', REPO));
    expect(globalStoreRoot(env)).toBe(join(home, 'global'));
    const crib = join(home, 'some-crib');
    expect(teamStoreRoot(crib)).toBe(join(crib, 'memory', 'team'));
    expect(policyPath(crib)).toBe(join(crib, 'memory', 'policy.json'));
  });
});

describe('writeJsonAtomic', () => {
  it('writes content + creates parent dirs, leaving no .tmp behind', () => {
    const path = join(home, 'a', 'b', 'file.json');
    writeJsonAtomic(path, '{"ok":true}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"ok":true}\n');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe('readRepoId', () => {
  it('reads repo.id from <cribDir>/crib.json', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-crib-'));
    try {
      writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: 'manifest-id' } }));
      expect(readRepoId(crib, env)).toBe('manifest-id');
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('falls back to the registry when no manifest is present', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-crib-'));
    try {
      writeFileSync(
        join(regDir, 'registry.json'),
        JSON.stringify({
          version: 1,
          projects: { '/some/root': { repoId: 'reg-id', cribDir: crib, addedAt: NOW } },
        }),
      );
      expect(readRepoId(crib, env)).toBe('reg-id');
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('manifest wins over registry', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-crib-'));
    try {
      writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: 'from-manifest' } }));
      writeFileSync(
        join(regDir, 'registry.json'),
        JSON.stringify({
          version: 1,
          projects: { '/some/root': { repoId: 'from-registry', cribDir: crib, addedAt: NOW } },
        }),
      );
      expect(readRepoId(crib, env)).toBe('from-manifest');
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('returns undefined when neither source has it', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-crib-'));
    try {
      expect(readRepoId(crib, env)).toBeUndefined();
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });
});

describe('MemoryStore factories + shape', () => {
  it('team: team root, .crib/.lock, records/decisions/receipts, no manifest', () => {
    const crib = join(home, 'crib');
    const s = MemoryStore.team(crib, { env, now: () => NOW });
    expect(s.role).toBe('team');
    expect(s.rootDir).toBe(join(crib, 'memory', 'team'));
    expect(s.lockFilePath).toBe(join(crib, '.lock'));
    expect(s.collections).toEqual(['records', 'decisions', 'receipts', 'intakes']);
    expect(s.hasManifest).toBe(false);
    expect(s.manifestPath()).toBeUndefined();
  });

  it('local: home/repos/<id> root, own lock, attempts/candidates/active/feedback/receipts/decisions/outbox/dead, manifest', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    expect(s.role).toBe('local');
    expect(s.rootDir).toBe(join(home, 'repos', REPO));
    expect(s.lockFilePath).toBe(join(home, 'repos', REPO, '.lock'));
    expect(s.collections).toEqual([
      'attempts',
      'candidates',
      'active',
      'feedback',
      'receipts',
      'decisions',
      'outbox',
      'dead',
      'intakes',
    ]);
    expect(s.hasManifest).toBe(true);
    expect(s.manifestPath()).toBe(join(home, 'repos', REPO, 'manifest.json'));
  });

  it('global: home/global root, own lock, records/decisions/feedback, manifest', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    expect(s.role).toBe('global');
    expect(s.rootDir).toBe(join(home, 'global'));
    expect(s.lockFilePath).toBe(join(home, 'global', '.lock'));
    expect(s.collections).toEqual(['records', 'decisions', 'feedback']);
    expect(s.hasManifest).toBe(true);
  });

  it('rejects a collection the role does not hold', () => {
    const team = MemoryStore.team(join(home, 'crib'), { env, now: () => NOW });
    expect(() => team.collectionDir('attempts')).toThrow();
    const global = MemoryStore.global({ env, now: () => NOW });
    expect(() => global.upsertEntry('attempts', record())).toThrow();
  });
});

describe('shard write/read round-trip', () => {
  it('upsert + read back a record (local active), id-sorted + canonical', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    const r = record();
    s.upsertEntry('active', r);
    const shard = memoryShard(r.id);
    const read = s.readShard('active', shard);
    expect(read.errors).toHaveLength(0);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.id).toBe(r.id);
    // canonical: the on-disk line is key-sorted JSON
    const onDisk = readFileSync(s.shardPath('active', shard), 'utf8');
    const keys = Object.keys(JSON.parse(onDisk.trim()) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });

  it('readCollection gathers every shard of a collection', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const a = record('claim a');
    const b = record('claim b');
    s.upsertEntries('records', [a, b]);
    const { entries, errors } = s.readCollection('records');
    expect(errors).toHaveLength(0);
    expect(entries.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('a missing shard/collection reads as empty (not an error)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    expect(s.readShard('active', 'ab')).toEqual({ entries: [], errors: [] });
    expect(s.readCollection('active')).toEqual({ entries: [], errors: [] });
  });
});

describe('upsert dedupe + replace-by-id', () => {
  it('upserting the same id twice yields one entry', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const r = record();
    s.upsertEntry('records', r);
    s.upsertEntry('records', r);
    expect(s.readCollection('records').entries).toHaveLength(1);
  });

  it('upserting two distinct ids yields two entries', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    s.upsertEntries('records', [record('claim a'), record('claim b')]);
    expect(s.readCollection('records').entries).toHaveLength(2);
  });

  it('stores intake entries only in stores that own the intake collection', () => {
    const intake = createIntakeRequirement({
      namespace: { principalId: 'principal-1', projectId: REPO },
      original: 'Resume the parser migration',
      interpretation: {
        outcome: 'Finish the parser migration',
        scope: ['packages/parsers'],
        constraints: [],
        acceptanceCriteria: ['Parser tests pass'],
      },
      sensitivity: 'internal',
      retentionPolicyId: 'default',
      provenance: {
        principalId: 'principal-1',
        deviceId: 'device-1',
        actorId: 'actor-1',
        clientId: 'codex',
      },
      createdAt: NOW,
    });
    const local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    local.upsertEntry('intakes', intake);
    expect(local.readCollection('intakes').entries).toEqual([intake]);

    const team = MemoryStore.team(join(home, 'crib'), { env, now: () => NOW });
    team.upsertEntry('intakes', intake);
    expect(team.readCollection('intakes').entries).toEqual([intake]);

    const global = MemoryStore.global({ env, now: () => NOW });
    expect(() => global.upsertEntry('intakes', intake)).toThrow(/not held by the global store/);
  });

  it('replace-by-id: a second entry with the same id replaces the first', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const r = record();
    s.upsertEntry('records', r);
    // same id, different object (e.g. a verdict flip on a mutable copy — content-addressed id is
    // stable, so this models "re-save the same claim after a verdict re-evaluation")
    const updated: MemoryRecord = { ...r, verdicts: { ...r.verdicts, trust: 'team' } };
    s.upsertEntry('records', updated);
    const entries = s.readCollection('records').entries;
    expect(entries).toHaveLength(1);
    expect((entries[0] as MemoryRecord).verdicts.trust).toBe('team');
  });

  it('cross-kind collections coexist (records + decisions on team)', () => {
    const crib = join(home, 'crib');
    const s = MemoryStore.team(crib, { env, now: () => NOW });
    const r = record();
    const d = decision();
    s.upsertEntry('records', r);
    s.upsertEntry('decisions', d);
    expect(s.readCollection('records').entries).toHaveLength(1);
    expect(s.readCollection('decisions').entries).toHaveLength(1);
  });
});

describe('write gates (validate + secret)', () => {
  it('writeShard rejects an invalid entry and writes nothing', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const bad = record() as unknown as { id: string; kind: string };
    bad.kind = 'rumour';
    expect(() =>
      s.writeShard('records', memoryShard(bad.id), [bad as unknown as MemoryRecord]),
    ).toThrow();
    expect(s.readCollection('records').entries).toHaveLength(0);
  });

  it('upsertEntry rejects a secret in the claim and writes nothing', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const r = record(`the key is sk-${'a'.repeat(30)}`);
    expect(() => s.upsertEntry('records', r)).toThrow();
    expect(s.readCollection('records').entries).toHaveLength(0);
  });
});

describe('locking', () => {
  it('withLock holds the lock file for the duration then releases it', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    let seen = false;
    s.withLock(() => {
      seen = existsSync(s.lockFilePath);
    });
    expect(seen).toBe(true);
    expect(existsSync(s.lockFilePath)).toBe(false);
  });

  it('a write serializes: a held lock makes a second writer throw LockBusyError', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const holder = new CribLock({ cribDir: s.rootDir });
    holder.acquire();
    try {
      expect(() => s.upsertEntry('records', record())).toThrow(LockBusyError);
    } finally {
      holder.release();
    }
    // after release, the write succeeds
    s.upsertEntry('records', record());
    expect(s.readCollection('records').entries).toHaveLength(1);
  });

  it('forbids cross-store lock nesting (repo+global)', () => {
    const team = MemoryStore.team(join(home, 'crib'), { env, now: () => NOW });
    const global = MemoryStore.global({ env, now: () => NOW });
    expect(() => team.withLock(() => global.upsertEntry('records', record()))).toThrow(
      MemoryLockNestingError,
    );
  });

  it('allows same-store re-entrancy (withLock wrapping another locked op)', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const r = record();
    s.withLock(() => {
      s.upsertEntry('records', r); // re-entrant same lock path — must not deadlock/nest-throw
    });
    expect(s.readCollection('records').entries).toHaveLength(1);
    expect(existsSync(s.lockFilePath)).toBe(false);
  });
});

describe('manifest', () => {
  it('local ensureManifest creates + persists a manifest carrying repo', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    const m = s.ensureManifest();
    expect(m.store).toBe('local');
    expect(m.repo?.id).toBe(REPO);
    expect(m.repo?.root).toBe('/r');
    expect(existsSync(s.manifestPath()!)).toBe(true);
    expect(s.readManifest()?.repo?.id).toBe(REPO);
  });

  it('global ensureManifest creates a manifest with no repo', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    const m = s.ensureManifest();
    expect(m.store).toBe('global');
    expect(m.repo).toBeUndefined();
  });

  it('persistManifest recomputes counts from the shards (active counts under records)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    s.upsertEntries('active', [record('a'), record('b')]);
    s.upsertEntries('candidates', [candidate()]);
    const m = s.persistManifest();
    expect(m.counts.records).toBe(2); // active → records
    expect(m.counts.candidates).toBe(1);
    expect(m.counts.attempts).toBe(0);
  });

  it('team has no manifest: ensureManifest/readManifest/persistManifest refuse', () => {
    const s = MemoryStore.team(join(home, 'crib'), { env, now: () => NOW });
    expect(s.readManifest()).toBeUndefined();
    expect(() => s.ensureManifest()).toThrow();
    expect(() => s.persistManifest()).toThrow();
  });

  it('ensureManifest rebuilds a corrupt manifest from the shards (no data loss)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    s.upsertEntry('active', record());
    // corrupt the manifest
    writeFileSync(s.manifestPath()!, '{not valid json', 'utf8');
    expect(() => s.readManifest()).toThrow();
    const rebuilt = s.ensureManifest();
    expect(rebuilt.store).toBe('local');
    // the shard is untouched
    expect(s.readCollection('active').entries).toHaveLength(1);
  });
});

describe('reset + team-never-deleted guarantee', () => {
  it('local clearStore removes the store root', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
    s.upsertEntry('active', record());
    expect(existsSync(s.rootDir)).toBe(true);
    s.clearStore();
    expect(existsSync(s.rootDir)).toBe(false);
  });

  it('global clearStore removes the store root', () => {
    const s = MemoryStore.global({ env, now: () => NOW });
    s.upsertEntry('records', record());
    s.clearStore();
    expect(existsSync(s.rootDir)).toBe(false);
  });

  it('team clearStore is refused (the committed ledger is never bulk-deleted)', () => {
    const crib = join(home, 'crib');
    const s = MemoryStore.team(crib, { env, now: () => NOW });
    s.upsertEntry('records', record());
    expect(() => s.clearStore()).toThrow();
    // the team data survives
    expect(s.readCollection('records').entries).toHaveLength(1);
    expect(existsSync(s.rootDir)).toBe(true);
  });
});
