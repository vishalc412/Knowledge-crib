/**
 * Write-time evidence admissibility — a memory that can never be recalled must never be accepted
 * with `ok: true`.
 *
 * Reported from real use. An agent recorded a working convention with:
 *
 *     evidence: [{ type: 'human-attestation', quote: 'User explicitly requested this policy.' }]
 *
 * `observe` validated the kind, subject, claim and actor — and never looked at the evidence. It
 * returned `ok: true`, the agent reported success to the user, and the claim was structurally
 * incapable of ever becoming valid: `type` is not `kind`, and a human attestation additionally
 * requires `tty`/`actor`/`attestedAt`. It could not be activated, could not be recalled, and
 * nothing anywhere said so. The user concluded that crib's memory does not work.
 *
 * Structural admissibility is decidable at write time, which is the only moment the author can
 * still fix it. What is deliberately NOT checked here is whether evidence still holds against the
 * live world — a source quote that has since drifted is a revalidation question, and a claim going
 * stale later is normal, not an authoring error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryApi } from './api.js';
import { admissibilityProblems } from './evaluator.js';
import { MemoryStore } from './store.js';
import type { MemoryEvidence } from './types.js';

const ATTESTED = {
  kind: 'human-attestation',
  tty: true,
  actor: 'user',
  attestedAt: '2026-09-05T00:00:00.000Z',
  quote: 'The user asked for this directly.',
} as unknown as MemoryEvidence;

describe('admissibilityProblems (pure)', () => {
  it('names the `type` vs `kind` mistake explicitly — the one actually made', () => {
    const problems = admissibilityProblems('convention', [
      { type: 'human-attestation', quote: 'x' } as unknown as MemoryEvidence,
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('the field is `kind`');
    expect(problems[0]!.problem).toContain('type: "human-attestation"');
  });

  it('rejects a human attestation missing the fields that make it an attestation', () => {
    // At ADMISSION time (not staged) the attestation fields are what make it one.
    const problems = admissibilityProblems('convention', [
      { kind: 'human-attestation', quote: 'x' } as unknown as MemoryEvidence,
    ]);
    expect(problems[0]!.problem).toMatch(/tty: true/);
    expect(problems[0]!.problem).toMatch(/actor/);
    expect(problems[0]!.problem).toMatch(/attestedAt/);
  });

  it('rejects an evidence kind the claim kind does not admit, and says what IS admitted', () => {
    // A human cannot attest an implementation fact into existence — the PRD matrix says so, and
    // this is the check that surfaces it before the record is written rather than after.
    const problems = admissibilityProblems('fact', [ATTESTED]);
    expect(problems[0]!.problem).toContain("not admissible for a 'fact' claim");
    expect(problems[0]!.problem).toContain('source-quote');
  });

  it('accepts a well-formed attestation for a convention', () => {
    expect(admissibilityProblems('convention', [ATTESTED])).toEqual([]);
  });

  it('lets an agent STAGE a relayed attestation without minting tty/actor/attestedAt', () => {
    // The agent proposes the claim; crib stamps the attestation at admission, from a terminal.
    // Requiring the fields here would make an honest proposal impossible.
    const bare = [
      { kind: 'human-attestation', quote: 'the user said so' } as unknown as MemoryEvidence,
    ];
    expect(admissibilityProblems('convention', bare, { staged: true })).toEqual([]);
    expect(admissibilityProblems('convention', bare)).not.toEqual([]);
  });

  it('accepts EMPTY evidence — episodic capture attaches evidence later', () => {
    expect(admissibilityProblems('convention', [])).toEqual([]);
  });

  it('does not judge whether evidence still HOLDS, only whether it could', () => {
    // A source quote naming a symbol that may or may not exist is well formed. Whether the anchor
    // is still there is revalidation's job; failing it here would reject correct authoring.
    const problems = admissibilityProblems('fact', [
      {
        kind: 'source-quote',
        soulId: 'sym:src/gone.ts#vanished',
        quote: 'anything',
      } as unknown as MemoryEvidence,
    ]);
    expect(problems).toEqual([]);
  });
});

describe('observe refuses un-admissible evidence', () => {
  let dir: string;
  let api: MemoryApi;
  /** The same API as a CLI path that has itself observed `process.stdin.isTTY`. */
  let terminalApi: MemoryApi;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crib-admis-'));
    const env = { ...process.env, KCRIB_MEMORY_DIR: join(dir, 'memory') } as NodeJS.ProcessEnv;
    const local = MemoryStore.local('admis-fixture', { env });
    api = new MemoryApi({ stores: { local }, env });
    terminalApi = new MemoryApi({ stores: { local }, env, attestationSource: 'terminal' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const observeWith = (on: MemoryApi, evidence: MemoryEvidence[]) =>
    on.observe({
      kind: 'convention',
      subject: 'topic:crib-first',
      claim: 'Consult Knowledge Crib before answering repository questions',
      evidence,
      actor: 'user',
      authorKind: 'human',
      scopeBoundary: 'global',
    });
  const observe = (evidence: MemoryEvidence[]) => observeWith(api, evidence);

  it('REFUSES the exact payload that was silently accepted, explaining why', () => {
    const result = observe([
      { type: 'human-attestation', quote: 'User explicitly requested this.' } as never,
    ]);
    expect(result.ok).toBe(false);
    // `error` is present only on the failure arm of the discriminated union.
    const error = result.ok ? '' : result.error;
    expect(error).toContain('could never be recalled');
    expect(error).toContain('the field is `kind`');
  });

  it('REFUSES a caller-minted `tty: true` — an agent never witnessed a terminal', () => {
    // `tty` is the one field separating a human attestation from an agent asserting one, and
    // receipt-free local admission is grounded in it. Accepting it from the caller would let any
    // agent self-grant that trust.
    const result = observe([ATTESTED]);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('stamped by crib');
  });

  it('accepts the same attestation from a path that OBSERVED a real terminal', () => {
    expect(observeWith(terminalApi, [ATTESTED]).ok).toBe(true);
  });

  it('still accepts a claim with NO evidence (the capture path must keep working)', () => {
    expect(observe([]).ok).toBe(true);
  });
});
