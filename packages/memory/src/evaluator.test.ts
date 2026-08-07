/**
 * W2 Slice 3 — the independent `MemoryEvaluator`: claim-level admissibility matrix, source-quote
 * grounding + reattachment (unique vs ambiguous vs gone), execution/policy/human/receipt-pair
 * evidence, the four-axis verdict, recall eligibility + ranking, conflict groups, and quarantine.
 *
 * A fake {@link MemorySoulPort} (in-memory node map + configured rehydrate text) + a fake receipt
 * port exercise the engine WITHOUT a real soul index — the engine is PURE over the ports. The
 * `SoulStoreSoulPort` adapter (real soul) is not tested here; it is a thin wrapper over `SoulStore`
 * + `rehydrateBody` and is covered by the package build + the integration path.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import {
  type EvalReceipt,
  MemoryEvaluator,
  type MemoryReceiptPort,
  type MemorySoulPort,
  conflictGroups,
  effectiveVerdicts,
  isRecallEligible,
  quarantineDecision,
  rankRecall,
  supersedeDecision,
} from './evaluator.js';
import { memoryRecordId } from './ids.js';
import type {
  EvidenceKind,
  EvidenceVerdict,
  MemoryDecision,
  MemoryEvidence,
  MemoryRecord,
  MemoryRecordKind,
  Verdicts,
} from './index.js';
import type { StableLocator } from './locator.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-test';

// ─── fakes ───────────────────────────────────────────────────────────────────

function node(partial: Partial<Node> & { id: string; kind: string }): Node {
  // Default `file` + `span` so verifyQuote (which requires an on-disk span) can run; the rehydrate
  // text comes from the per-test `texts` map, not disk, so the file path value is irrelevant.
  return {
    hash: 'blake3:live',
    file: 'src/a.ts',
    span: { start: 1, end: 100 },
    ...partial,
  } as Node;
}

interface FakeSoulOpts {
  nodes?: Node[];
  /** rehydrate text per node id (defaults to the node's `name` so a quote of the name grounds). */
  texts?: Map<string, string>;
  /** override the locator search (defaults to scanning `nodes` via bestLocatorMatches). */
  findByLocator?: (locator: StableLocator) => Node[];
}

function fakeSoul(opts: FakeSoulOpts = {}): MemorySoulPort {
  const nodes = opts.nodes ?? [];
  const texts = opts.texts ?? new Map<string, string>();
  return {
    getNode: (id) => nodes.find((n) => n.id === id),
    rehydrate: (n) => ({
      text: texts.get(n.id) ?? n.name ?? '',
      truncated: false,
      totalLines: 1,
      startLine: n.span?.start ?? 1,
    }),
    findByLocator: opts.findByLocator ?? (() => []),
  };
}

function fakeReceipts(map: Map<string, EvalReceipt>): MemoryReceiptPort {
  return { getReceipt: (id) => map.get(id) };
}

function receipt(partial: Partial<EvalReceipt> & { id: string }): EvalReceipt {
  return {
    policyHash: 'blake3:policy',
    profileHash: 'blake3:profile',
    exitCode: 0,
    assertions: [{ name: 'passes', passed: true }],
    runner: 'ci',
    ts: NOW,
    ...partial,
  };
}

// ─── record builders ─────────────────────────────────────────────────────────

function evidence(partial: Partial<MemoryEvidence> & { kind: EvidenceKind }): MemoryEvidence {
  return {
    verdict: 'valid',
    checkedAt: NOW,
    ...partial,
  };
}

function record(opts: {
  kind?: MemoryRecordKind;
  subject?: string;
  claim?: string;
  evidence?: MemoryEvidence[];
  trust?: Verdicts['trust'];
  verdicts?: Partial<Verdicts>;
  createdAt?: string;
  scopeRepoId?: string;
}): MemoryRecord {
  const kind = opts.kind ?? 'fact';
  const subject = opts.subject ?? 'sym:src/a.ts#A.b';
  const claim = opts.claim ?? 'A.b does the thing';
  const ev = opts.evidence ?? [
    evidence({
      kind: 'source-quote',
      soulId: subject,
      quote: 'does the thing',
      targetHash: 'blake3:live',
    }),
  ];
  const input = {
    kind,
    subject,
    claim,
    scope: { boundary: 'repo' as const, repoId: opts.scopeRepoId ?? REPO },
    appliesTo: [subject],
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

// ─── admissibility matrix ────────────────────────────────────────────────────

describe('admissibility matrix (per claim kind)', () => {
  const ev = MemoryEvaluator;

  function evalWith(
    kind: MemoryRecordKind,
    evidenceItems: MemoryEvidence[],
    soul: MemorySoulPort,
  ): EvidenceVerdict {
    const e = new ev();
    const r = record({ kind, evidence: evidenceItems, subject: 'sym:src/a.ts#A.b', claim: 'x' });
    return e.evaluate(r, { soul }).evidence;
  }

  it('fact: a verified source quote is valid', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol', name: 'does the thing' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'function that does the thing']]),
    });
    expect(
      evalWith(
        'fact',
        [
          evidence({
            kind: 'source-quote',
            soulId: 'sym:src/a.ts#A.b@L1',
            quote: 'does the thing',
            targetHash: 'blake3:live',
          }),
        ],
        soul,
      ),
    ).toBe('valid');
  });

  it('fact: human-attestation is ignored (human evidence cannot establish implementation facts)', () => {
    const soul = fakeSoul();
    expect(
      evalWith(
        'fact',
        [evidence({ kind: 'human-attestation', tty: true, actor: 'vishal', attestedAt: NOW })],
        soul,
      ),
    ).toBe('invalid');
  });

  it('fact: execution-assertion with a passing receipt is valid', () => {
    const soul = fakeSoul();
    const ctx = {
      soul,
      receipts: fakeReceipts(new Map([['rcpt:1', receipt({ id: 'rcpt:1' })]])),
      policy: { policyHash: () => 'blake3:policy', profileHash: () => 'blake3:profile' },
    };
    const e = new ev();
    const r = record({
      kind: 'fact',
      evidence: [
        evidence({ kind: 'execution-assertion', receiptId: 'rcpt:1', assertion: 'passes' }),
      ],
    });
    expect(e.evaluate(r, ctx).evidence).toBe('valid');
  });

  it('decision: human TTY attestation is valid; source-quote is ignored', () => {
    const soul = fakeSoul();
    expect(
      evalWith(
        'decision',
        [evidence({ kind: 'human-attestation', tty: true, actor: 'vishal', attestedAt: NOW })],
        soul,
      ),
    ).toBe('valid');
    expect(
      evalWith(
        'decision',
        [
          evidence({
            kind: 'source-quote',
            soulId: 'sym:src/a.ts#A.b@L1',
            quote: 'x',
            targetHash: 'blake3:live',
          }),
        ],
        soul,
      ),
    ).toBe('invalid');
  });

  it('convention: committed-policy is valid', () => {
    const soul = fakeSoul({
      nodes: [
        node({
          id: 'art:.claude/rules/x.md#x',
          kind: 'agent-artifact',
          artifactType: 'rule',
          hash: 'blake3:live',
        }),
      ],
    });
    expect(
      evalWith(
        'convention',
        [
          evidence({
            kind: 'committed-policy',
            artifactId: 'art:.claude/rules/x.md#x',
            targetHash: 'blake3:live',
          }),
        ],
        soul,
      ),
    ).toBe('valid');
  });

  it('procedure: source-quote valid; promises-outcome without execution → degraded', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol', name: 'will return ok' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'this will return ok']]),
    });
    const e = new ev();
    const r = record({
      kind: 'procedure',
      claim: 'A.b will return ok',
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'will return ok',
          targetHash: 'blake3:live',
        }),
      ],
    });
    expect(e.evaluate(r, { soul }).evidence).toBe('degraded');
  });

  it('procedure: promises-outcome WITH a passing execution-assertion → valid', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'will return ok']]),
    });
    const ctx = {
      soul,
      receipts: fakeReceipts(new Map([['rcpt:1', receipt({ id: 'rcpt:1' })]])),
      policy: { policyHash: () => 'blake3:policy', profileHash: () => 'blake3:profile' },
    };
    const e = new ev();
    const r = record({
      kind: 'procedure',
      claim: 'A.b will return ok',
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'will return ok',
          targetHash: 'blake3:live',
        }),
        evidence({ kind: 'execution-assertion', receiptId: 'rcpt:1', assertion: 'passes' }),
      ],
    });
    expect(e.evaluate(r, ctx).evidence).toBe('valid');
  });
});

// ─── pitfall combo rule ──────────────────────────────────────────────────────

describe('pitfall two-path evidence', () => {
  it('a receipt-pair (failing then subsequent passing) is valid', () => {
    const soul = fakeSoul();
    const ctx = {
      soul,
      receipts: fakeReceipts(
        new Map([
          [
            'rcpt:fail',
            receipt({
              id: 'rcpt:fail',
              exitCode: 1,
              assertions: [{ name: 'passes', passed: false }],
              ts: '2026-01-01T00:00:00.000Z',
            }),
          ],
          [
            'rcpt:pass',
            receipt({
              id: 'rcpt:pass',
              exitCode: 0,
              assertions: [{ name: 'passes', passed: true }],
              ts: '2026-01-01T01:00:00.000Z',
            }),
          ],
        ]),
      ),
      policy: { policyHash: () => 'blake3:policy', profileHash: () => 'blake3:profile' },
    };
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'pitfall',
      evidence: [
        evidence({
          kind: 'receipt-pair',
          failingReceiptId: 'rcpt:fail',
          passingReceiptId: 'rcpt:pass',
        }),
      ],
    });
    expect(e.evaluate(r, ctx).evidence).toBe('valid');
  });

  it('a reproduction (source-quote + human-attestation) is valid', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'throws on null']]),
    });
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'pitfall',
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'throws on null',
          targetHash: 'blake3:live',
        }),
        evidence({ kind: 'human-attestation', tty: true, actor: 'vishal', attestedAt: NOW }),
      ],
    });
    expect(e.evaluate(r, { soul }).evidence).toBe('valid');
  });

  it('source-quote ALONE (no human reproduction) is invalid for a pitfall', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'throws on null']]),
    });
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'pitfall',
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'throws on null',
          targetHash: 'blake3:live',
        }),
      ],
    });
    expect(e.evaluate(r, { soul }).evidence).toBe('invalid');
  });

  it('a non-subsequent receipt-pair (passing before failing) is invalid', () => {
    const soul = fakeSoul();
    const ctx = {
      soul,
      receipts: fakeReceipts(
        new Map([
          ['rcpt:fail', receipt({ id: 'rcpt:fail', exitCode: 1, ts: '2026-01-02T00:00:00.000Z' })],
          ['rcpt:pass', receipt({ id: 'rcpt:pass', exitCode: 0, ts: '2026-01-01T00:00:00.000Z' })],
        ]),
      ),
    };
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'pitfall',
      evidence: [
        evidence({
          kind: 'receipt-pair',
          failingReceiptId: 'rcpt:fail',
          passingReceiptId: 'rcpt:pass',
        }),
      ],
    });
    expect(e.evaluate(r, ctx).evidence).toBe('invalid');
  });
});

// ─── source-quote grounding + reattachment ───────────────────────────────────

describe('source-quote revalidation + reattachment', () => {
  it('exact id + hash match + grounded quote → valid / current', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'does the thing']]),
    });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'does the thing',
          targetHash: 'blake3:live',
        }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.evidence).toBe('valid');
    expect(res.applicability).toBe('current');
  });

  it('hash drifted but the quote re-grounds on the new content → degraded / current', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol', hash: 'blake3:new' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'does the thing now']]),
    });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'does the thing',
          targetHash: 'blake3:old',
        }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.evidence).toBe('degraded');
    expect(res.applicability).toBe('current');
  });

  it('node gone → unique reattachment + re-grounded → degraded / current / reattached', () => {
    const moved = node({
      id: 'sym:src/moved.ts#A.b@L9',
      kind: 'symbol',
      qualifiedName: 'A.b',
      file: 'src/moved.ts',
      hash: 'blake3:moved',
    });
    const soul = fakeSoul({
      nodes: [moved],
      texts: new Map([['sym:src/moved.ts#A.b@L9', 'does the thing']]),
      findByLocator: () => [moved],
    });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'does the thing',
          targetHash: 'blake3:old',
        }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.evidence).toBe('degraded');
    expect(res.applicability).toBe('current');
    expect(res.reattached).toBe(true);
    expect(res.items[0]?.reattachedTo).toBe('sym:src/moved.ts#A.b@L9');
  });

  it('node gone → multiple locator matches → needs-review (excluded from recall)', () => {
    const a = node({
      id: 'sym:src/a.ts#A.b@L1',
      kind: 'symbol',
      qualifiedName: 'A.b',
      file: 'src/a.ts',
    });
    const b = node({
      id: 'sym:src/b.ts#A.b@L2',
      kind: 'symbol',
      qualifiedName: 'A.b',
      file: 'src/b.ts',
    });
    const soul = fakeSoul({ nodes: [a, b], findByLocator: () => [a, b] });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/old.ts#A.b@L1',
          quote: 'x',
          targetHash: 'blake3:old',
        }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.applicability).toBe('needs-review');
    expect(res.evidence).toBe('degraded');
    expect(isRecallEligible(effectiveVerdicts(r, [], res))).toBe(false);
  });

  it('node gone → no locator match → invalid / orphaned', () => {
    const soul = fakeSoul({ nodes: [], findByLocator: () => [] });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/old.ts#A.b@L1',
          quote: 'x',
          targetHash: 'blake3:old',
        }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.evidence).toBe('invalid');
    expect(res.applicability).toBe('orphaned');
  });

  it('node present but the quote is not found → invalid / needs-review', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'totally different text']]),
    });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'does the thing',
          targetHash: 'blake3:live',
        }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.evidence).toBe('invalid');
    expect(res.applicability).toBe('needs-review');
  });
});

// ─── execution-assertion + policy drift ──────────────────────────────────────

describe('execution-assertion revalidation', () => {
  it('receipt missing → invalid / orphaned', () => {
    const soul = fakeSoul();
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({ kind: 'execution-assertion', receiptId: 'rcpt:gone', assertion: 'passes' }),
      ],
    });
    const res = e.evaluate(r, { soul, receipts: fakeReceipts(new Map()) });
    expect(res.evidence).toBe('invalid');
    expect(res.applicability).toBe('orphaned');
  });

  it('assertion did not pass → invalid', () => {
    const soul = fakeSoul();
    const ctx = {
      soul,
      receipts: fakeReceipts(
        new Map([
          ['rcpt:1', receipt({ id: 'rcpt:1', assertions: [{ name: 'passes', passed: false }] })],
        ]),
      ),
      policy: { policyHash: () => 'blake3:policy', profileHash: () => 'blake3:profile' },
    };
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({ kind: 'execution-assertion', receiptId: 'rcpt:1', assertion: 'passes' }),
      ],
    });
    expect(e.evaluate(r, ctx).evidence).toBe('invalid');
  });

  it('policy hash drifted → degraded / needs-review (execution-backed drift)', () => {
    const soul = fakeSoul();
    const ctx = {
      soul,
      receipts: fakeReceipts(
        new Map([['rcpt:1', receipt({ id: 'rcpt:1', policyHash: 'blake3:old' })]]),
      ),
      policy: { policyHash: () => 'blake3:new', profileHash: () => 'blake3:profile' },
    };
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({ kind: 'execution-assertion', receiptId: 'rcpt:1', assertion: 'passes' }),
      ],
    });
    const res = e.evaluate(r, ctx);
    expect(res.evidence).toBe('degraded');
    expect(res.applicability).toBe('needs-review');
  });
});

// ─── human-attestation (no code anchor) ──────────────────────────────────────

describe('human-attestation', () => {
  it('tty attestation → valid / current (no code target to revalidate)', () => {
    const soul = fakeSoul();
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'decision',
      evidence: [
        evidence({ kind: 'human-attestation', tty: true, actor: 'vishal', attestedAt: NOW }),
      ],
    });
    const res = e.evaluate(r, { soul });
    expect(res.evidence).toBe('valid');
    expect(res.applicability).toBe('current');
  });

  it('missing tty → invalid (not a TTY attestation)', () => {
    const soul = fakeSoul();
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'decision',
      evidence: [evidence({ kind: 'human-attestation', actor: 'vishal', attestedAt: NOW })],
    });
    expect(e.evaluate(r, { soul }).evidence).toBe('invalid');
  });
});

// ─── applicability aggregation ───────────────────────────────────────────────

describe('applicability aggregation', () => {
  it('human-attestation only (no code anchor) → current', () => {
    const soul = fakeSoul();
    const e = new MemoryEvaluator();
    const r = record({
      kind: 'decision',
      evidence: [evidence({ kind: 'human-attestation', tty: true, actor: 'x', attestedAt: NOW })],
    });
    expect(e.evaluate(r, { soul }).applicability).toBe('current');
  });

  it('a present anchor whose quote is not found → needs-review', () => {
    const soul = fakeSoul({
      nodes: [node({ id: 'sym:src/a.ts#A.b@L1', kind: 'symbol' })],
      texts: new Map([['sym:src/a.ts#A.b@L1', 'totally different text']]),
    });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'does the thing',
          targetHash: 'blake3:live',
        }),
      ],
    });
    expect(e.evaluate(r, { soul }).applicability).toBe('needs-review');
  });

  it('all anchors gone with no locator match → orphaned', () => {
    const soul = fakeSoul({ nodes: [], findByLocator: () => [] });
    const e = new MemoryEvaluator();
    const r = record({
      evidence: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/gone.ts#A.b@L1',
          quote: 'x',
          targetHash: 'blake3:old',
        }),
      ],
    });
    expect(e.evaluate(r, { soul }).applicability).toBe('orphaned');
  });
});

// ─── four-axis: effective verdicts + lifecycle overlay ───────────────────────

describe('effectiveVerdicts + lifecycle overlay', () => {
  const r = record({
    verdicts: { trust: 'team', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
  });

  it('no decisions → as-evaluated, active, not quarantined', () => {
    const v = effectiveVerdicts(r, [], {
      evidence: 'valid',
      applicability: 'current',
      items: [],
      reattached: false,
      reasons: [],
    });
    expect(v.lifecycle).toBe('active');
    expect(v.quarantined).toBe(false);
    expect(v.trust).toBe('team');
  });

  it('a supersede decision → lifecycle superseded', () => {
    const dec: MemoryDecision = {
      id: 'dec:1',
      schemaVersion: '1',
      kind: 'supersede',
      subject: r.id,
      successor: 'mem:new',
      actor: 'ci',
      ts: NOW,
    };
    expect(effectiveVerdicts(r, [dec]).lifecycle).toBe('superseded');
  });

  it('a retract decision → lifecycle retracted (wins over a prior supersede)', () => {
    const decs: MemoryDecision[] = [
      {
        id: 'dec:1',
        schemaVersion: '1',
        kind: 'supersede',
        subject: r.id,
        successor: 'mem:new',
        actor: 'ci',
        ts: NOW,
      },
      { id: 'dec:2', schemaVersion: '1', kind: 'retract', subject: r.id, actor: 'ci', ts: NOW },
    ];
    expect(effectiveVerdicts(r, decs).lifecycle).toBe('retracted');
  });

  it('a quarantine decision → quarantined (excluded from recall, NOT deleted)', () => {
    const dec: MemoryDecision = {
      id: 'dec:q',
      schemaVersion: '1',
      kind: 'quarantine',
      subject: r.id,
      actor: 'ci',
      ts: NOW,
    };
    const v = effectiveVerdicts(r, [dec]);
    expect(v.quarantined).toBe(true);
    expect(isRecallEligible(v)).toBe(false);
  });

  it('falls back to the record stamped verdicts when no evaluation is supplied', () => {
    const v = effectiveVerdicts(r, []);
    expect(v.evidence).toBe('valid');
    expect(v.applicability).toBe('current');
  });
});

// ─── recall eligibility + ranking ────────────────────────────────────────────

describe('isRecallEligible + rankRecall', () => {
  function eff(
    partial: Partial<Verdicts> & { quarantined?: boolean },
  ): ReturnType<typeof effectiveVerdicts> {
    return {
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
      quarantined: false,
      reasons: [],
      ...partial,
    };
  }

  it('local+valid+current+active is eligible; degraded is eligible; invalid/orphaned/needs-review are not', () => {
    expect(isRecallEligible(eff({}))).toBe(true);
    expect(isRecallEligible(eff({ evidence: 'degraded' }))).toBe(true);
    expect(isRecallEligible(eff({ evidence: 'invalid' }))).toBe(false);
    expect(isRecallEligible(eff({ applicability: 'orphaned' }))).toBe(false);
    expect(isRecallEligible(eff({ applicability: 'needs-review' }))).toBe(false);
    expect(isRecallEligible(eff({ lifecycle: 'superseded' }))).toBe(false);
    expect(isRecallEligible(eff({ trust: 'candidate' }))).toBe(false);
    expect(isRecallEligible(eff({ quarantined: true }))).toBe(false);
  });

  it('ranks valid before degraded, then newest-first', () => {
    const valid = record({ claim: 'v', createdAt: '2026-01-01T00:00:00.000Z' });
    const degraded = record({ claim: 'd', createdAt: '2026-01-02T00:00:00.000Z' });
    const ranked = rankRecall([
      { record: degraded, verdicts: eff({ evidence: 'degraded' }) },
      { record: valid, verdicts: eff({ evidence: 'valid' }) },
    ]);
    // valid before degraded, regardless of input order / createdAt
    expect(ranked.map((x) => x.record.claim)).toEqual(['v', 'd']);
  });

  it('rankRecall filters out non-eligible records', () => {
    const ok = record({ claim: 'ok' });
    const bad = record({ claim: 'bad' });
    const ranked = rankRecall([
      { record: ok, verdicts: eff({ evidence: 'valid' }) },
      { record: bad, verdicts: eff({ evidence: 'invalid' }) },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.record.claim).toBe('ok');
  });
});

// ─── conflict groups ─────────────────────────────────────────────────────────

describe('conflictGroups', () => {
  it('≥2 eligible records sharing subject+scope form a conflict group', () => {
    const a = record({ claim: 'A.b does X', subject: 'sym:src/a.ts#A.b' });
    const b = record({ claim: 'A.b does Y', subject: 'sym:src/a.ts#A.b' });
    const groups = conflictGroups([
      { record: a, verdicts: effectiveVerdicts(a, []) },
      { record: b, verdicts: effectiveVerdicts(b, []) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.records).toHaveLength(2);
    expect(groups[0]?.subject).toBe('sym:src/a.ts#A.b');
  });

  it('a single record on a subject is not a conflict group', () => {
    const a = record({ claim: 'A.b does X' });
    expect(conflictGroups([{ record: a, verdicts: effectiveVerdicts(a, []) }])).toHaveLength(0);
  });

  it('records in different scopes do not conflict', () => {
    const a = record({ claim: 'X', scopeRepoId: 'r1' });
    const b = record({ claim: 'Y', scopeRepoId: 'r2' });
    expect(
      conflictGroups([
        { record: a, verdicts: effectiveVerdicts(a, []) },
        { record: b, verdicts: effectiveVerdicts(b, []) },
      ]),
    ).toHaveLength(0);
  });

  it('non-eligible (quarantined) records do not enter conflict groups', () => {
    const a = record({ claim: 'X' });
    const b = record({ claim: 'Y' });
    const dec: MemoryDecision = {
      id: 'dec:q',
      schemaVersion: '1',
      kind: 'quarantine',
      subject: a.id,
      actor: 'ci',
      ts: NOW,
    };
    expect(
      conflictGroups([
        { record: a, verdicts: effectiveVerdicts(a, [dec]) },
        { record: b, verdicts: effectiveVerdicts(b, []) },
      ]),
    ).toHaveLength(0);
  });
});

// ─── quarantine + supersede decisions ────────────────────────────────────────

describe('quarantineDecision + supersedeDecision', () => {
  it('quarantineDecision builds an immutable quarantine event (not a deletion)', () => {
    const r = record({ claim: 'bad' });
    const d = quarantineDecision(r, 'ci', 'evidence unsupported', NOW);
    expect(d.kind).toBe('quarantine');
    expect(d.subject).toBe(r.id);
    expect(d.actor).toBe('ci');
    expect(d.id).toMatch(/^dec:/);
    expect(d.ts).toBe(NOW);
  });

  it('supersedeDecision links the old record to its successor', () => {
    const oldR = record({ claim: 'old' });
    const newR = record({ claim: 'new' });
    const d = supersedeDecision(oldR, newR, 'ci', 'reattached anchor changed', NOW);
    expect(d.kind).toBe('supersede');
    expect(d.subject).toBe(oldR.id);
    expect(d.successor).toBe(newR.id);
  });
});
