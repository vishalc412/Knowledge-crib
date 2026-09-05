/**
 * Receipt-free local admission for human-attested claims.
 *
 * The path to a remembered preference used to be: `memory_observe` (stages an untrusted candidate)
 * → `crib memory evaluate --profile <name>` (produces a gate receipt bound to HEAD + worktree
 * digest) → `crib memory activate <id>`. Users recorded a convention, were told it worked, and
 * never saw it again.
 *
 * The receipt is the wrong instrument here. A `convention` or `decision` admits only
 * `human-attestation` and `committed-policy` — there is no execution to gate and no code anchor to
 * drift — so requiring one demanded proof of something the claim never asserted.
 *
 * What keeps this from being a trust hole is asserted below: the attestation fields are ENFORCED
 * (a hollow `{ kind: 'human-attestation' }` is refused), claim kinds that do assert things about
 * code are refused, and trust never exceeds `local`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryRecordKind } from './enums.js';
import { MemoryEvaluator } from './evaluator.js';
import type { MemorySoulPort } from './evaluator.js';
import { memoryCandidateId } from './ids.js';
import { admitAttested } from './promotion.js';
import { MemoryStore } from './store.js';
import type { MemoryCandidate, MemoryEvidence } from './types.js';

const AT = '2026-09-05T00:00:00.000Z';

/** No soul is consulted for an attestation — this port exists to prove that. */
const noSoul = {
  getNode: () => undefined,
  rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
  findByLocator: () => [],
} as unknown as MemorySoulPort;

function attestation(over: Record<string, unknown> = {}): MemoryEvidence {
  return {
    kind: 'human-attestation',
    tty: true,
    actor: 'user',
    attestedAt: AT,
    quote: 'The user asked for this directly.',
    ...over,
  } as unknown as MemoryEvidence;
}

let dir: string;
let local: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-admit-'));
  local = MemoryStore.local('admit-fixture', {
    env: { ...process.env, KCRIB_MEMORY_DIR: join(dir, 'memory') } as NodeJS.ProcessEnv,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function candidate(
  kind: MemoryRecordKind,
  evidence: MemoryEvidence[],
  claim = 'Consult Knowledge Crib before answering repository questions',
): MemoryCandidate {
  const seed = {
    kind,
    subject: 'topic:crib-first',
    claim,
    scope: { boundary: 'repo' as const, repoId: 'admit-fixture' },
    appliesTo: [],
    evidence,
    authorship: { actor: 'user', kind: 'human' as const },
    origin: 'observe' as const,
  };
  const c = {
    ...seed,
    id: memoryCandidateId(seed),
    schemaVersion: '1',
    createdAt: AT,
    proposedAt: AT,
    status: 'pending',
  } as unknown as MemoryCandidate;
  local.upsertEntry('candidates', c);
  return c;
}

/** Admission from a verified terminal — crib stamps the attestation itself. */
const admit = (c: MemoryCandidate) =>
  admitAttested(local, c, {
    evaluator: new MemoryEvaluator(),
    soul: noSoul,
    now: () => AT,
    attestedBy: 'user',
  });

/** Admission with NO human present — nothing stamps the attestation. */
const admitWithoutHuman = (c: MemoryCandidate) =>
  admitAttested(local, c, { evaluator: new MemoryEvaluator(), soul: noSoul, now: () => AT });

describe('admitAttested', () => {
  it('admits a human-attested convention to LOCAL trust with no gate receipt', () => {
    const result = admit(candidate('convention', [attestation()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.verdicts.trust).toBe('local');
    expect(result.record.verdicts.evidence).toBe('valid');
    expect(result.record.verdicts.applicability).toBe('current');
    // The candidate is consumed, not duplicated.
    expect(result.cleanedUp).toBe(true);
    expect(local.readCollection('active').entries).toHaveLength(1);
    expect(local.readCollection('candidates').entries).toHaveLength(0);
  });

  it('stamps evidence with verdict + checkedAt so the record passes schema validation', () => {
    // Regression: building the record from RAW candidate evidence threw MemorySchemaError on write
    // (`verdict` and `checkedAt` are required), which surfaced as a stack trace to the user.
    const result = admit(candidate('convention', [attestation()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.evidence[0]).toMatchObject({ verdict: 'valid', checkedAt: AT });
  });

  it('REFUSES a bare attestation when NO human stamped it', () => {
    // The staged proposal is legitimate; admitting it without a terminal is not. This is the case
    // that would let an agent grant itself local trust if the stamp were caller-supplied.
    const bare = candidate('convention', [
      { kind: 'human-attestation', quote: 'trust me' } as unknown as MemoryEvidence,
    ]);
    const result = admitWithoutHuman(bare);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/did not validate/);
  });

  it('ADMITS that same staged proposal once a human stamps it at a terminal', () => {
    const result = admit(
      candidate('convention', [
        { kind: 'human-attestation', quote: 'trust me' } as unknown as MemoryEvidence,
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.evidence[0]).toMatchObject({ verdict: 'valid' });
    expect(result.record.verdicts.trust).toBe('local');
  });

  it('REFUSES a claim kind whose evidence asserts something about code', () => {
    // A `fact` needs a source quote or an execution assertion, and those are exactly what a gate
    // receipt exists to verify. Redirected, never admitted under the weaker rule.
    const result = admit(candidate('fact', [attestation()]));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/crib memory evaluate/);
  });

  it('REFUSES a mixed evidence set containing anything code-anchored', () => {
    const result = admit(
      candidate('convention', [
        attestation(),
        { kind: 'source-quote', soulId: 'sym:a.ts#x', quote: 'q' } as unknown as MemoryEvidence,
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/every evidence item/);
  });

  it('REFUSES a claim with no evidence at all', () => {
    const result = admit(candidate('convention', []));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/no evidence/);
  });

  it('never grants more than LOCAL trust — team promotion stays gated', () => {
    const result = admit(candidate('decision', [attestation()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.verdicts.trust).toBe('local');
    // Nothing was written to any team collection by this path.
    expect(local.collections).not.toContain('records');
  });
});
