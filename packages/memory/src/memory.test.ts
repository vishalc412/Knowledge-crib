/**
 * W2 Slice 1 — the memory-1 schema, content-addressed ids, validators, manifest, migrations, strict
 * loader, serialization, and secret scanner. Proves the W2 exit-gate primitives:
 *   - unknown schema versions fail closed (record + manifest);
 *   - content-addressed ids dedupe repeated observations (same semantic content ⟹ same id),
 *     excluding mutable verdicts/timestamps/meta;
 *   - every record kind validates against its vendored JSON Schema; unknown kinds/prefixes reject;
 *   - authored prose is secret-scanned (a secret anywhere is a hard reject);
 *   - canonical serialization is byte-stable across insertion order.
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import {
  type MemoryEntry,
  type MemoryRecord,
  assertNoMemorySecrets,
  assertSupportedMemorySchemaVersion,
  assertValidMemoryEntry,
  assertValidMemoryManifest,
  assertValidMemoryRecord,
  attemptEventId,
  attemptGroupId,
  canonicalMemoryJson,
  decisionId,
  feedbackId,
  isSupportedMemorySchemaVersion,
  loadMemoryManifestJson,
  memoryCandidateId,
  memoryRecordId,
  memoryShard,
  migrateMemoryRecord,
  newMemoryManifest,
  normalizeClaim,
  parseMemoryShard,
  receiptId,
  scanEntrySecrets,
  scanSecrets,
  serializeMemoryShard,
} from './index.js';
import { MemorySchemaVersionError } from './migrations.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-123';

interface RecordInput {
  claim?: string;
  subject?: string;
  evidence?: MemoryRecord['evidence'];
  appliesTo?: string[];
  authorship?: MemoryRecord['authorship'];
}

function evidence(
  over: Partial<MemoryRecord['evidence'][number]> = {},
): MemoryRecord['evidence'][number] {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/auth.ts#AuthService.login',
    quote: 'issues a JWT',
    targetHash: 'blake3:abcdef',
    ...over,
  };
}

function recordInput(over: RecordInput = {}): Parameters<typeof memoryRecordId>[0] {
  return {
    kind: 'fact',
    subject: over.subject ?? 'sym:src/auth.ts#AuthService.login',
    claim: over.claim ?? 'AuthService.login issues a JWT',
    scope: { boundary: 'repo', repoId: REPO },
    appliesTo: over.appliesTo ?? ['sym:src/auth.ts#AuthService.login'],
    evidence: over.evidence ?? [evidence()],
    authorship: over.authorship ?? { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
  };
}

/** Build a fully-valid MemoryRecord (id + verdicts + createdAt stamped). */
function validRecord(over: RecordInput = {}): MemoryRecord {
  const input = recordInput(over);
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    kind: input.kind,
    subject: input.subject,
    claim: input.claim,
    scope: input.scope,
    appliesTo: input.appliesTo,
    evidence: input.evidence,
    authorship: input.authorship,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  };
}

describe('content-addressed ids', () => {
  it('repeated observations of the same claim dedupe to one id', () => {
    expect(memoryRecordId(recordInput())).toBe(memoryRecordId(recordInput()));
  });

  it('a different claim produces a different id', () => {
    const a = memoryRecordId(recordInput({ claim: 'AuthService.login issues a JWT' }));
    const b = memoryRecordId(recordInput({ claim: 'AuthService.login issues a session cookie' }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^mem:[0-9a-f]+$/);
  });

  it('excludes mutable status: verdicts/timestamps/meta do NOT affect the id', () => {
    // The id function only consumes semantic content; verdicts/createdAt live on the record, not
    // the id input, so this is structural — but confirm the id is stable across evidence VERDICT
    // flips (the verdict is a mutable check result that must not change the content id).
    const withValid = memoryRecordId(recordInput({ evidence: [evidence({ verdict: 'valid' })] }));
    const withDegraded = memoryRecordId(
      recordInput({ evidence: [evidence({ verdict: 'degraded' })] }),
    );
    expect(withValid).toBe(withDegraded);
  });

  it('evidence order is irrelevant (sorted fingerprints)', () => {
    const a = memoryRecordId(
      recordInput({ evidence: [evidence({ quote: 'a' }), evidence({ quote: 'b' })] }),
    );
    const b = memoryRecordId(
      recordInput({ evidence: [evidence({ quote: 'b' }), evidence({ quote: 'a' })] }),
    );
    expect(a).toBe(b);
  });

  it('appliesTo order is irrelevant (sorted)', () => {
    const a = memoryRecordId(recordInput({ appliesTo: ['x', 'y'] }));
    const b = memoryRecordId(recordInput({ appliesTo: ['y', 'x'] }));
    expect(a).toBe(b);
  });

  it('a candidate and its promoted record share the blake3 body (different prefix)', () => {
    const input = recordInput();
    const memId = memoryRecordId(input);
    const candId = memoryCandidateId(input);
    expect(memId).toMatch(/^mem:/);
    expect(candId).toMatch(/^cand:/);
    expect(memId.slice('mem:'.length)).toBe(candId.slice('cand:'.length));
  });

  it('normalizeClaim collapses whitespace + trims', () => {
    expect(normalizeClaim('  foo   bar\n\t baz ')).toBe('foo bar baz');
  });

  it('attempt/receipt/decision/feedback ids are content-addressed + prefixed', () => {
    expect(attemptGroupId({ actor: 'a', startedAt: NOW, origin: 'attempt' })).toMatch(/^attgrp:/);
    expect(attemptEventId({ attemptId: 'attgrp:x', phase: 'start', subject: 's' })).toMatch(
      /^att:/,
    );
    expect(
      receiptId({
        policyHash: 'blake3:p',
        profileHash: 'blake3:q',
        executable: 'crib',
        args: ['memory', 'check'],
        head: 'abc',
        worktreeDigest: 'blake3:w',
        exitCode: 0,
        outputDigest: 'blake3:o',
        assertions: [{ name: 'passes', passed: true }],
        runner: 'ci',
      }),
    ).toMatch(/^rcpt:/);
    expect(
      decisionId({ kind: 'supersede', subject: 'mem:x', successor: 'mem:y', actor: 'ci' }),
    ).toMatch(/^dec:/);
    expect(feedbackId({ signal: 'useful', subject: 'mem:x', actor: 'a' })).toMatch(/^fb:/);
  });

  it('memoryShard is a 2-hex-char shard key over the id', () => {
    expect(memoryShard('mem:abc')).toMatch(/^[0-9a-f]{2}$/);
  });
});

describe('validators', () => {
  it('a valid record passes assertValidMemoryRecord', () => {
    expect(() => assertValidMemoryRecord(validRecord())).not.toThrow();
  });

  it('rejects an unknown claim kind (closed enum)', () => {
    const r = validRecord();
    (r as unknown as { kind: string }).kind = 'rumour';
    expect(() => assertValidMemoryRecord(r)).toThrow();
  });

  it('rejects an id with the wrong prefix (must be mem:)', () => {
    const r = validRecord();
    r.id = `cand:${blake3Hex('x')}`;
    expect(() => assertValidMemoryRecord(r)).toThrow();
  });

  it('rejects an unknown verdict value', () => {
    const r = validRecord();
    (r.verdicts as unknown as { trust: string }).trust = 'world';
    expect(() => assertValidMemoryRecord(r)).toThrow();
  });

  it('rejects a missing required field (subject)', () => {
    const r = validRecord();
    // Omit `subject` via a shallow copy (biome: noDelete) — AJV's `required` + `type:string`
    // both reject an absent-or-undefined subject.
    const { subject: _omit, ...withoutSubject } = r;
    void _omit;
    expect(() => assertValidMemoryRecord(withoutSubject as MemoryRecord)).toThrow();
  });

  it('assertValidMemoryEntry dispatches by id prefix and rejects unknown prefixes', () => {
    expect(() =>
      assertValidMemoryEntry(validRecord() as unknown as { id: string } & Record<string, unknown>),
    ).not.toThrow();
    expect(() => assertValidMemoryEntry({ id: 'unknown:abc', schemaVersion: '1' })).toThrow();
  });
});

describe('migrations + version gate (fail closed)', () => {
  it('memory-1 is supported', () => {
    expect(isSupportedMemorySchemaVersion('1')).toBe(true);
    expect(isSupportedMemorySchemaVersion('2')).toBe(false);
  });

  it('assertSupportedMemorySchemaVersion throws on unknown versions', () => {
    expect(() => assertSupportedMemorySchemaVersion('1')).not.toThrow();
    expect(() => assertSupportedMemorySchemaVersion('2')).toThrow(MemorySchemaVersionError);
    expect(() => assertSupportedMemorySchemaVersion(undefined)).toThrow(MemorySchemaVersionError);
  });

  it('migrateMemoryRecord is the identity for memory-1 (no older versions yet)', () => {
    const raw = { id: 'mem:abc', schemaVersion: '1', kind: 'fact' };
    expect(migrateMemoryRecord(raw as Record<string, unknown>, '1')).toEqual(raw);
  });

  it('migrateMemoryRecord refuses an unknown from-version', () => {
    expect(() => migrateMemoryRecord({ id: 'mem:abc' }, '0')).toThrow(MemorySchemaVersionError);
  });
});

describe('manifest', () => {
  it('local store carries repo; global store does not', () => {
    const local = newMemoryManifest({ store: 'local', repoId: REPO, repoRoot: '/r', now: NOW });
    expect(local.store).toBe('local');
    expect(local.repo?.id).toBe(REPO);
    expect(local.counts.records).toBe(0);
    assertValidMemoryManifest(local);

    const global = newMemoryManifest({ store: 'global', now: NOW });
    expect(global.repo).toBeUndefined();
    assertValidMemoryManifest(global);
  });

  it('loadMemoryManifestJson validates + version-gates', () => {
    const m = newMemoryManifest({ store: 'team', repoId: REPO, now: NOW });
    expect(loadMemoryManifestJson(m).store).toBe('team');
    expect(() => loadMemoryManifestJson({ ...m, schemaVersion: '2' })).toThrow(
      MemorySchemaVersionError,
    );
    expect(() => loadMemoryManifestJson('not an object')).toThrow();
  });
});

describe('strict loader (parseMemoryShard)', () => {
  it('parses a clean shard with no errors', () => {
    const r = validRecord();
    const text = serializeMemoryShard([r]);
    const parsed = parseMemoryShard(text, 'team/records/00.jsonl');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.id).toBe(r.id);
  });

  it('records a malformed JSON line as an error (never silently skipped)', () => {
    const parsed = parseMemoryShard('{not json\n', 'x.jsonl');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('x.jsonl:1');
  });

  it('records a missing-id line as an error', () => {
    const parsed = parseMemoryShard('{"schemaVersion":"1"}\n', 'x.jsonl');
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("missing or non-string 'id'");
  });

  it('fails closed on an unknown schemaVersion line', () => {
    const parsed = parseMemoryShard(
      '{"id":"mem:abc","schemaVersion":"2","kind":"fact"}\n',
      'x.jsonl',
    );
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('unsupported memory schemaVersion');
  });

  it('rejects a structurally-invalid memory-1 line', () => {
    const parsed = parseMemoryShard('{"id":"mem:abc","schemaVersion":"1"}\n', 'x.jsonl');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
  });
});

describe('secret scanner', () => {
  it('detects known token shapes', () => {
    expect(scanSecrets(`token=sk-${'a'.repeat(30)}`).length).toBeGreaterThan(0);
    expect(scanSecrets(`ghp_${'a'.repeat(36)}`).length).toBeGreaterThan(0);
    expect(scanSecrets(`AKIA${'A'.repeat(16)}`).length).toBeGreaterThan(0);
    expect(scanSecrets(`xoxb-${'a'.repeat(20)}`).length).toBeGreaterThan(0);
  });

  it('detects a secret-keyword assignment with a long value', () => {
    expect(scanSecrets('api_key = "abcdefghij1234"').length).toBeGreaterThan(0);
  });

  it('skips structural values (hashes, ids, timestamps, enum tokens)', () => {
    expect(scanSecrets(`blake3:${'0'.repeat(64)}`)).toHaveLength(0);
    expect(scanSecrets(`mem:${'0'.repeat(64)}`)).toHaveLength(0);
    expect(scanSecrets('2026-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(scanSecrets('fact')).toHaveLength(0);
  });

  it('scanEntrySecrets walks the whole record and assertNoMemorySecrets rejects', () => {
    const r = validRecord({ claim: `the key is sk-${'a'.repeat(30)}` });
    expect(scanEntrySecrets(r).length).toBeGreaterThan(0);
    expect(() => assertNoMemorySecrets(r)).toThrow();
  });

  it('a clean record passes assertNoMemorySecrets', () => {
    expect(() => assertNoMemorySecrets(validRecord())).not.toThrow();
  });
});

describe('canonical serialization', () => {
  it('is byte-stable across insertion order', () => {
    const a = validRecord({ claim: 'a' });
    const b = validRecord({ claim: 'b' });
    const one = serializeMemoryShard([a, b]);
    const two = serializeMemoryShard([b, a]);
    expect(one).toBe(two);
    // id-sorted: the lexicographically-smaller id's line comes first
    const ids = [a.id, b.id].sort();
    expect(one.indexOf(ids[0]!)).toBeLessThan(one.indexOf(ids[1]!));
  });

  it('empty input → empty string', () => {
    expect(serializeMemoryShard([])).toBe('');
  });

  it('canonicalMemoryJson is key-sorted', () => {
    const r = validRecord();
    const json = canonicalMemoryJson(r as unknown as MemoryEntry);
    // Verify the TOP-LEVEL key order by parsing (a substring indexOf would false-match nested
    // `kind` fields inside the evidence array, which serialize before the top-level `id`).
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
    expect(keys.indexOf('id')).toBeLessThan(keys.indexOf('kind'));
    expect(keys.indexOf('kind')).toBeLessThan(keys.indexOf('schemaVersion'));
  });
});
