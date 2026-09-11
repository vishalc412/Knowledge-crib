/**
 * Gated automatic admission (auto-admit.ts).
 *
 * The failure this ends: an agent called `memory_observe`, was told the write succeeded, and recall
 * came back empty — every agent write sat in the candidate tier until someone ran a CLI promotion.
 *
 * What is asserted: agent-cited quotes gain a soul anchor only when they verify; the gate admits a
 * grounded, anchored claim and holds everything it cannot vouch for; admission never exceeds local
 * trust; and `observe` surfaces the decision so the agent knows whether the claim is recallable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdmissionSignals,
  type GroundingPort,
  MemoryApi,
  type MemoryCandidate,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryRecord,
  type MemorySoulPort,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  admitGrounded,
  decideAutoAdmission,
  groundAgentEvidence,
  memoryCandidateId,
} from './index.js';

const T0 = '2026-09-11T00:00:00.000Z';
const REPO = 'r-auto-admit';
const FILE = 'src/team.ts';
const SYMBOL = `sym:${FILE}#Team.displayNumber@L10`;
const STATEMENT = `stmt:${FILE}@L12`;

const NODES: Node[] = [
  {
    id: SYMBOL,
    kind: 'symbol',
    name: 'displayNumber',
    file: FILE,
    span: { start: 10, end: 14 },
    hash: 'blake3:5b01',
  } as Node,
  {
    id: STATEMENT,
    kind: 'statement',
    file: FILE,
    span: { start: 12, end: 12 },
    hash: 'blake3:57a7e0',
  } as Node,
];
const TEXTS = new Map<string, string>([
  [SYMBOL, 'get displayNumber() {\n  return this.cached;\n}'],
  [STATEMENT, 'return this.cached;'],
]);

function port(): GroundingPort & MemorySoulPort {
  return {
    getNode: (id: string) => NODES.find((n) => n.id === id),
    allNodes: () => NODES,
    findByLocator: () => [],
    rehydrate: (n: Node) => ({
      text: TEXTS.get(n.id) ?? '',
      truncated: false,
      totalLines: 1,
      startLine: n.span?.start ?? 1,
    }),
  } as unknown as GroundingPort & MemorySoulPort;
}

/** Evidence the way an agent writes it: a path, a line, the quoted text — no soul id, no verdict. */
function cited(quote: string, line?: number): MemoryEvidence {
  return {
    kind: 'source-quote',
    path: FILE,
    quote,
    ...(line !== undefined ? { line } : {}),
  } as unknown as MemoryEvidence;
}

function signals(over: Partial<AdmissionSignals> = {}): AdmissionSignals {
  return {
    kind: 'fact',
    authorKind: 'agent',
    evidence: 'valid',
    applicability: 'current',
    validItems: 1,
    degradedItems: 0,
    invalidItems: 0,
    unresolvedTargets: 0,
    ...over,
  };
}

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-auto-admit-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

describe('groundAgentEvidence', () => {
  it('pins a cited quote to the narrowest span it verifies against', () => {
    const [ev] = groundAgentEvidence(port(), [cited('return this.cached;', 12)]);
    expect(ev?.soulId).toBe(STATEMENT);
    expect(ev?.targetHash).toBe('blake3:57a7e0');
    expect(ev?.startLine).toBe(12);
  });

  it('widens to the enclosing symbol when the narrow span does not hold the whole quote', () => {
    const [ev] = groundAgentEvidence(port(), [
      cited('get displayNumber() { return this.cached; }', 12),
    ]);
    expect(ev?.soulId).toBe(SYMBOL);
  });

  it('leaves a quote that grounds nowhere unanchored — grounding never invents an anchor', () => {
    const original = cited('return this.fresh;', 12);
    const [ev] = groundAgentEvidence(port(), [original]);
    expect(ev).toEqual(original);
    expect(ev?.soulId).toBeUndefined();
  });

  it('does not touch evidence that already carries a soul id', () => {
    const anchored = { ...cited('return this.cached;', 12), soulId: SYMBOL } as MemoryEvidence;
    expect(groundAgentEvidence(port(), [anchored])).toEqual([anchored]);
  });
});

describe('decideAutoAdmission — the non-negotiables', () => {
  it('admits a grounded, anchored agent fact', () => {
    expect(decideAutoAdmission(signals()).verdict).toBe('admit');
  });

  it('never lets an agent self-admit a decision or convention (human-attested kinds)', () => {
    expect(decideAutoAdmission(signals({ kind: 'decision' })).verdict).toBe('hold');
    expect(decideAutoAdmission(signals({ kind: 'convention' })).verdict).toBe('hold');
  });

  it('holds a claim whose evidence the evaluator found invalid', () => {
    expect(
      decideAutoAdmission(signals({ evidence: 'invalid', validItems: 0, invalidItems: 1 })).verdict,
    ).toBe('hold');
  });

  it('holds a claim whose anchors are orphaned', () => {
    expect(decideAutoAdmission(signals({ applicability: 'orphaned' })).verdict).toBe('hold');
  });

  it('always explains itself', () => {
    for (const s of [signals(), signals({ kind: 'decision' }), signals({ evidence: 'invalid' })]) {
      expect(decideAutoAdmission(s).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('admitGrounded', () => {
  function stagedCandidate(local: MemoryStore): MemoryCandidate {
    const [evidence] = groundAgentEvidence(port(), [cited('return this.cached;', 12)]);
    const body = {
      kind: 'fact' as const,
      subject: SYMBOL,
      claim: 'Team.displayNumber returns the cached value',
      scope: { boundary: 'repo' as const, repoId: REPO },
      appliesTo: [SYMBOL],
      evidence: evidence ? [evidence] : [],
      authorship: { actor: 'claude-code', kind: 'agent' as const },
    };
    const candidate: MemoryCandidate = {
      id: memoryCandidateId(body),
      schemaVersion: '1',
      ...body,
      origin: 'observe',
      proposedAt: T0,
    };
    local.upsertEntry('candidates', candidate);
    return candidate;
  }

  it('writes a local-trust record, retires the candidate, and records why', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const candidate = stagedCandidate(local);
    const evaluation = new MemoryEvaluator().evaluate(
      {
        ...candidate,
        verdicts: {
          trust: 'candidate',
          evidence: 'valid',
          applicability: 'current',
          lifecycle: 'active',
        },
        createdAt: T0,
        schemaVersion: '1',
        id: candidate.id.replace('cand:', 'mem:'),
      } as unknown as MemoryRecord,
      { soul: port() },
    );
    const record = admitGrounded(
      local,
      candidate,
      evaluation,
      { verdict: 'admit', reason: 'grounded' },
      () => T0,
    );
    expect(record.verdicts.trust).toBe('local');
    expect(record.meta).toMatchObject({ admission: 'auto-grounded' });
    expect(local.readCollection('active').entries.map((e) => e.id)).toEqual([record.id]);
    expect(local.readCollection('candidates').entries).toEqual([]);
  });

  it('refuses a hold decision', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const candidate = stagedCandidate(local);
    expect(() =>
      admitGrounded(
        local,
        candidate,
        {
          evidence: 'invalid',
          applicability: 'orphaned',
          items: [],
          reattached: false,
          reasons: [],
        },
        { verdict: 'hold', reason: 'no' },
        () => T0,
      ),
    ).toThrow(/hold/);
  });
});

describe('MemoryApi.observe with the gate wired', () => {
  function api(withEvaluator: boolean) {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const soul = port();
    return {
      local,
      api: new MemoryApi({
        stores: { local },
        env,
        now: () => T0,
        soul,
        ...(withEvaluator ? { evaluator: new MemoryEvaluator(), evalCtx: { soul } } : {}),
      }),
    };
  }

  const input = {
    kind: 'fact' as const,
    subject: SYMBOL,
    claim: 'Team.displayNumber returns the cached value',
    actor: 'claude-code',
    repoId: REPO,
    appliesTo: [FILE],
    evidence: [cited('return this.cached;', 12)],
  };

  it('admits a grounded agent observation in the same call — recallable, not pending', () => {
    const { local, api: memory } = api(true);
    const res = memory.observe(input);
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe('active');
    expect(res.admission?.verdict).toBe('admit');
    expect(res.recordId?.startsWith('mem:')).toBe(true);
    expect(local.readCollection('candidates').entries).toEqual([]);
    const active = local.readCollection('active').entries as MemoryRecord[];
    expect(active).toHaveLength(1);
    expect(active[0]?.verdicts.trust).toBe('local');
    expect(active[0]?.evidence[0]?.soulId).toBe(STATEMENT);
  });

  it('refuses a hallucinated citation loudly, naming where the quote was looked for', () => {
    const { local, api: memory } = api(true);
    const res = memory.observe({ ...input, evidence: [cited('return this.fresh;', 12)] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/src\/team\.ts:12/);
    expect(res.error).toMatch(/not found/);
    expect(local.readCollection('active').entries).toEqual([]);
    expect(local.readCollection('candidates').entries).toEqual([]);
  });

  it('holds a grounded claim whose appliesTo names something the index does not know', () => {
    const { local, api: memory } = api(true);
    const res = memory.observe({ ...input, appliesTo: ['src/gone.ts'] });
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe('pending');
    expect(res.admission?.verdict).toBe('hold');
    expect(res.admission?.reason).toMatch(/not in the index/);
    expect(local.readCollection('active').entries).toEqual([]);
  });

  it('admits a grounded claim that omits appliesTo — the evidence anchors it', () => {
    const { api: memory } = api(true);
    const res = memory.observe({ ...input, appliesTo: [] });
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe('active');
  });

  it('never admits an agent convention, even with grounded evidence', () => {
    const { api: memory } = api(true);
    const res = memory.observe({ ...input, kind: 'convention' as never, evidence: [] });
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe('pending');
    expect(res.admission?.reason).toMatch(/crib memory remember/);
  });

  it('stays pending with no decision when no evaluator is wired (unchanged behaviour)', () => {
    const { api: memory } = api(false);
    const res = memory.observe(input);
    if (!res.ok) throw new Error(res.error);
    expect(res.status).toBe('pending');
    expect(res.admission).toBeUndefined();
  });
});

describe('decideAutoAdmission — the judgement calls', () => {
  it('holds when any citation fails, even if others verified', () => {
    expect(
      decideAutoAdmission(signals({ evidence: 'degraded', validItems: 1, invalidItems: 1 }))
        .verdict,
    ).toBe('hold');
  });

  it('holds a pitfall backed only by quotes — it needs a receipt pair', () => {
    const d = decideAutoAdmission(signals({ kind: 'pitfall', evidence: 'invalid' }));
    expect(d.verdict).toBe('hold');
    expect(d.reason).toMatch(/receipt pair/);
  });

  it('holds a procedure whose promised outcome lacks an execution receipt', () => {
    expect(
      decideAutoAdmission(signals({ kind: 'procedure', evidence: 'degraded', degradedItems: 0 }))
        .verdict,
    ).toBe('hold');
  });

  it('holds evidence that matched only after drift', () => {
    expect(
      decideAutoAdmission(signals({ evidence: 'degraded', validItems: 0, degradedItems: 1 }))
        .verdict,
    ).toBe('hold');
  });

  it('holds needs-review anchors', () => {
    expect(decideAutoAdmission(signals({ applicability: 'needs-review' })).verdict).toBe('hold');
  });

  it('admits exact citations alongside a drifted one, and says so', () => {
    const d = decideAutoAdmission(
      signals({ evidence: 'degraded', validItems: 2, degradedItems: 1 }),
    );
    expect(d.verdict).toBe('admit');
    expect(d.reason).toMatch(/1 drifted/);
  });
});
