/**
 * D10 admission-matrix tests: every cell of the filter, checked against the ADR table, plus the
 * id-derivation refusal and the ambiguous-policy refusal (a refusal, never a warning).
 */
import { describe, expect, it } from 'vitest';
import { derivePropositionKey, memoryRecordId, memoryRecordV2Id } from '../ids.js';
import { type SyncAdmissionReason, admissionForSync } from './policy.js';
import { decision, feedback, v1Record, v2Record } from './sync-test-fixtures.js';

function reasonOf(entry: Parameters<typeof admissionForSync>[0]): SyncAdmissionReason {
  const git = admissionForSync(entry, 'git-shard');
  expect(git.admitted).toBe(false);
  return git.reason as SyncAdmissionReason;
}

describe('admissionForSync (D10)', () => {
  it('admits honest memory-1 workspace records to both classes (internal + ret:default)', () => {
    const rec = v1Record();
    expect(admissionForSync(rec, 'git-shard')).toEqual({ admitted: true });
    expect(admissionForSync(rec, 'encrypted-remote')).toEqual({ admitted: true });
  });

  it('refuses private memory from the git shard (the whole point of the gate)', () => {
    const rec = v2Record({ visibility: 'private' });
    expect(admissionForSync(rec, 'git-shard')).toEqual({
      admitted: false,
      reason: 'private-visibility',
    });
    expect(admissionForSync(rec, 'encrypted-remote')).toEqual({ admitted: true });
  });

  it('enforces the sensitivity ceiling per class', () => {
    // confidential: remote-safe, never git
    const conf = v2Record({ sensitivity: 'confidential' });
    expect(admissionForSync(conf, 'encrypted-remote')).toEqual({ admitted: true });
    expect(reasonOf(conf)).toBe('sensitivity');
    // restricted: refused everywhere
    const restricted = v2Record({ sensitivity: 'restricted' });
    expect(reasonOf(restricted)).toBe('sensitivity');
    expect(admissionForSync(restricted, 'encrypted-remote').admitted).toBe(false);
    expect(admissionForSync(restricted, 'encrypted-remote').reason).toBe('sensitivity');
  });

  it('refuses an unknown retention id as ambiguous-policy (never a warning)', () => {
    const unknown = v2Record({ retentionPolicyId: 'ret:uncommitted-draft' });
    expect(admissionForSync(unknown, 'git-shard')).toEqual({
      admitted: false,
      reason: 'ambiguous-policy',
    });
    expect(admissionForSync(unknown, 'encrypted-remote').reason).toBe('ambiguous-policy');
  });

  it('refuses a payload whose content id does not re-derive (id-derivation, first)', () => {
    const rec = v1Record();
    const edited = { ...rec, claim: 'A.b does the OTHER thing' };
    expect(admissionForSync(edited, 'git-shard')).toEqual({
      admitted: false,
      reason: 'id-derivation',
    });
  });

  it('admits a tombstone decision + feedback unconditionally (retraction must sync)', () => {
    expect(admissionForSync(decision('retract', 'mem:x'), 'git-shard')).toEqual({ admitted: true });
    expect(admissionForSync(decision('retract', 'mem:x'), 'encrypted-remote')).toEqual({
      admitted: true,
    });
    expect(admissionForSync(decision('supersede', 'mem:x', 'mem:y'), 'git-shard')).toEqual({
      admitted: true,
    });
    expect(admissionForSync(feedback('unhelpful', 'mem:x'), 'encrypted-remote')).toEqual({
      admitted: true,
    });
  });

  it('memory-1 records derive the documented defaults (workspace / internal / ret:default)', () => {
    // a v1 record carries none of the v2 governance fields, so its admission rides the derivations
    const rec = v1Record();
    expect(rec.id).toBe(memoryRecordId(rec)); // honest baseline: the id re-derives
    expect(rec.schemaVersion).toBe('1');
    expect(admissionForSync(rec, 'git-shard').admitted).toBe(true);
  });

  it('memory-2 ids re-derive over the v2 seed (the check the admission rides on)', () => {
    const rec = v2Record();
    expect(rec.id).toBe(
      memoryRecordV2Id({
        kind: rec.kind,
        subject: rec.subject,
        propositionKey: derivePropositionKey({ subject: rec.subject }),
        claim: rec.claim,
        evidence: rec.evidence,
      }),
    );
  });
});
