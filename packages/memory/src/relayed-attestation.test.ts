/**
 * Relayed preferences — the everyday memory a person expects an agent to keep.
 *
 * Found by a real MCP run: "the user prefers pnpm over npm" was staged and never recalled, because a
 * `convention` admits only a human attestation and an agent speaking over MCP cannot mint the
 * terminal signal (`tty`) that makes one valid. Mem0-style tools store exactly this kind of memory,
 * so crib looked like it forgot what the user said.
 *
 * The fix keeps the trust model intact: crib stamps who RELAYED the statement, the evaluator scores a
 * relayed attestation `degraded` (never `valid`), the gate admits it to LOCAL trust only, and every
 * path that would escalate it — team proposal, receipt-free attested admission — refuses until a
 * person confirms it at a terminal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdmissionSignals,
  type GateReceipt,
  MemoryApi,
  type MemoryCandidate,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryRecord,
  type MemorySoulPort,
  MemoryStore,
  ProposalRefusedError,
  __resetMemoryLockGuardForTest,
  admitAttested,
  buildRecord,
  decideAutoAdmission,
  isRecallEligible,
  memoryCandidateId,
  proposeTeam,
} from './index.js';

const T0 = '2026-09-11T00:00:00.000Z';
const REPO = 'r-relayed';

const noSoul = {
  getNode: () => undefined,
  allNodes: () => [],
  rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
  findByLocator: () => [],
} as unknown as MemorySoulPort;

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-relayed-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

function attestation(over: Record<string, unknown> = {}): MemoryEvidence {
  return {
    kind: 'human-attestation',
    quote: 'Always use pnpm, never npm.',
    ...over,
  } as unknown as MemoryEvidence;
}

function evaluate(evidence: MemoryEvidence[]) {
  const body = {
    kind: 'convention' as const,
    subject: 'topic:package-manager',
    claim: 'Use pnpm for every install command',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [],
    evidence,
    authorship: { actor: 'claude-code', kind: 'agent' as const },
  };
  const candidate: MemoryCandidate = {
    id: memoryCandidateId(body),
    schemaVersion: '1',
    ...body,
    origin: 'observe',
    proposedAt: T0,
  };
  const record = buildRecord(
    candidate,
    { trust: 'candidate', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    evidence,
    T0,
  );
  return {
    candidate,
    record,
    evaluation: new MemoryEvaluator().evaluate(record, { soul: noSoul }),
  };
}

describe('evaluator — a relayed attestation is degraded, never valid', () => {
  it('scores an attestation crib stamped as relayed `degraded` / relayed-unconfirmed', () => {
    const { evaluation } = evaluate([attestation({ relayedBy: 'claude-code', relayedAt: T0 })]);
    expect(evaluation.items[0]).toMatchObject({
      evidence: 'degraded',
      reason: 'relayed-unconfirmed',
    });
    expect(evaluation.evidence).toBe('degraded');
  });

  it('keeps a hollow attestation (no relay stamp, no terminal) invalid', () => {
    const { evaluation } = evaluate([attestation()]);
    expect(evaluation.items[0]).toMatchObject({ evidence: 'invalid', reason: 'not-attested' });
  });

  it('keeps a terminal attestation valid', () => {
    const { evaluation } = evaluate([attestation({ tty: true, actor: 'user', attestedAt: T0 })]);
    expect(evaluation.items[0]).toMatchObject({ evidence: 'valid', reason: 'ok' });
  });
});

describe('decideAutoAdmission — relayed conventions and decisions', () => {
  const base: AdmissionSignals = {
    kind: 'convention',
    authorKind: 'agent',
    evidence: 'degraded',
    applicability: 'current',
    validItems: 0,
    degradedItems: 1,
    invalidItems: 0,
    unresolvedTargets: 0,
    relayedItems: 1,
  };

  it('admits a relayed convention locally and says how to confirm it', () => {
    const d = decideAutoAdmission(base);
    expect(d.verdict).toBe('admit');
    expect(d.reason).toMatch(/relayed/);
    expect(d.reason).toMatch(/crib memory remember/);
  });

  it('admits a relayed decision the same way', () => {
    expect(decideAutoAdmission({ ...base, kind: 'decision' }).verdict).toBe('admit');
  });

  it('still holds a convention with no relayed or terminal attestation', () => {
    expect(
      decideAutoAdmission({ ...base, evidence: 'invalid', degradedItems: 0, relayedItems: 0 })
        .verdict,
    ).toBe('hold');
  });
});

describe('MemoryApi.observe — an agent relays what the user said', () => {
  function api() {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    return {
      local,
      api: new MemoryApi({
        stores: { local },
        env,
        now: () => T0,
        evaluator: new MemoryEvaluator(),
        evalCtx: { soul: noSoul },
      }),
    };
  }

  it('is recallable at local trust, stamped with who relayed it, labelled degraded', () => {
    const { local, api: memory } = api();
    const res = memory.observe({
      kind: 'convention',
      subject: 'topic:package-manager',
      claim: 'Use pnpm for every install command',
      evidence: [attestation()],
      actor: 'claude-code',
      repoId: REPO,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe('active');
    const [record] = local.readCollection('active').entries as MemoryRecord[];
    expect(record?.verdicts).toMatchObject({ trust: 'local', evidence: 'degraded' });
    expect(record?.evidence[0]).toMatchObject({ relayedBy: 'claude-code' });
    expect(record?.evidence[0]?.tty).toBeUndefined();
    expect(
      isRecallEligible({ ...record!.verdicts, quarantined: false } as Parameters<
        typeof isRecallEligible
      >[0]),
    ).toBe(true);
  });

  it('still refuses a caller-forged terminal attestation', () => {
    const { api: memory } = api();
    const res = memory.observe({
      kind: 'convention',
      subject: 'topic:package-manager',
      claim: 'Use pnpm for every install command',
      evidence: [attestation({ tty: true })],
      actor: 'claude-code',
      repoId: REPO,
    });
    expect(res.ok).toBe(false);
  });
});

describe('escalation paths refuse a relayed attestation', () => {
  it('team proposal refuses it until a person confirms', () => {
    const { record, evaluation } = evaluate([
      attestation({ relayedBy: 'claude-code', relayedAt: T0 }),
    ]);
    expect(() =>
      proposeTeam(
        {} as MemoryStore,
        { record, evaluation },
        {} as GateReceipt,
        'claude-code',
        () => T0,
      ),
    ).toThrow(ProposalRefusedError);
  });

  it('receipt-free attested admission refuses it without a terminal confirmation', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const { candidate } = evaluate([attestation({ relayedBy: 'claude-code', relayedAt: T0 })]);
    local.upsertEntry('candidates', candidate);
    const res = admitAttested(local, candidate, {
      evaluator: new MemoryEvaluator(),
      soul: noSoul,
      now: () => T0,
    });
    expect(res.ok).toBe(false);
  });

  it('a terminal confirmation turns the relayed claim into a valid attestation', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const { candidate } = evaluate([attestation({ relayedBy: 'claude-code', relayedAt: T0 })]);
    local.upsertEntry('candidates', candidate);
    const res = admitAttested(local, candidate, {
      evaluator: new MemoryEvaluator(),
      soul: noSoul,
      now: () => T0,
      attestedBy: 'user',
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.record.verdicts.evidence).toBe('valid');
  });
});
