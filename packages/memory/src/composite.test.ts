/**
 * W3 Slice 3 — the memory composite projection (PRD lines 212–224). `memoryComposite` is PURE over a
 * {@link RecallProjection}: it must (a) emit one `mem:` node per recall-eligible record, (b) emit
 * `applies-to` edges to each target, (c) emit `supported-by` edges to evidence `soulId`s, (d) emit
 * pairwise `conflicts-with` edges within each conflict group, and (e) OMIT superseded records (they
 * are recall-ineligible, so they never become nodes). The output must be deterministic over the same
 * projection (content-stable node + edge ids) so the merged composite graph is ifHash-stable.
 */
import { describe, expect, it } from 'vitest';
import { memoryComposite } from './composite.js';
import type { MemoryCompositeEdge } from './composite.js';
import { memoryRecordId } from './ids.js';
import type {
  MemoryDecision,
  MemoryEvidence,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordKind,
  Verdicts,
} from './index.js';
import { type MemorySource, type RecallProjection, recallProjection } from './recall.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-composite';
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

function gathered(
  tagged: { record: MemoryRecord; source: MemorySource }[],
  decisions: MemoryDecision[] = [],
  fb: MemoryFeedback[] = [],
) {
  return { records: tagged, decisions, localDecisions: [], feedback: fb, errors: [] };
}

function compositeOf(
  tagged: { record: MemoryRecord; source: MemorySource }[],
  decisions: MemoryDecision[] = [],
): ReturnType<typeof memoryComposite> {
  const p: RecallProjection = recallProjection(gathered(tagged, decisions));
  return memoryComposite(p);
}

describe('memoryComposite nodes', () => {
  it('emits one mem: node per recall-eligible record, tagged origin memory / kind memory', () => {
    const r1 = record({ subject: 'topic:x', claim: 'claim-1' });
    const r2 = record({ subject: 'topic:y', claim: 'claim-2' });
    const c = compositeOf([
      { record: r1, source: 'team' },
      { record: r2, source: 'local' },
    ]);
    expect(c.nodes).toHaveLength(2);
    const ids = c.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([r1.id, r2.id].sort());
    for (const n of c.nodes) {
      expect(n.origin).toBe('memory');
      expect(n.kind).toBe('memory');
      expect(typeof n.claim).toBe('string');
      expect(typeof n.trust).toBe('string');
      expect(typeof n.source).toBe('string');
    }
  });

  it('is deterministic: the same projection yields byte-identical nodes + edges', () => {
    const r1 = record({ subject: 'topic:x', claim: 'claim-1' });
    const r2 = record({ subject: 'topic:x', claim: 'claim-2' });
    const a = compositeOf([
      { record: r1, source: 'team' },
      { record: r2, source: 'team' },
    ]);
    const b = compositeOf([
      { record: r1, source: 'team' },
      { record: r2, source: 'team' },
    ]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('omits superseded records (recall-ineligible ⇒ no node)', () => {
    const live = record({ subject: 'topic:x', claim: 'live-claim' });
    const dead = record({
      subject: 'topic:x',
      claim: 'dead-claim',
      verdicts: { lifecycle: 'superseded' },
    });
    const c = compositeOf([
      { record: live, source: 'team' },
      { record: dead, source: 'team' },
    ]);
    expect(c.nodes.map((n) => n.id)).toEqual([live.id]);
  });
});

describe('memoryComposite applies-to edges', () => {
  it('emits one applies-to edge per appliesTo target', () => {
    const r = record({
      subject: 'topic:auth',
      claim: 'auth notes',
      appliesTo: ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d'],
    });
    const c = compositeOf([{ record: r, source: 'team' }]);
    const applies = c.edges.filter((e) => e.rel === 'applies-to') as MemoryCompositeEdge[];
    expect(applies).toHaveLength(2);
    expect(applies.every((e) => e.src === r.id)).toBe(true);
    expect(applies.map((e) => e.dst).sort()).toEqual(
      ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d'].sort(),
    );
    expect(applies.every((e) => e.origin === 'memory' && e.provenance === 'INFERRED')).toBe(true);
  });
});

describe('memoryComposite supported-by edges', () => {
  it('emits a supported-by edge to each evidence soulId', () => {
    const r = record({
      subject: 'topic:x',
      claim: 'claim',
      evidenceItems: [
        evidence({ soulId: 'sym:src/a.ts#A.b', quote: 'q1' }),
        evidence({ soulId: 'sym:src/b.ts#C.d', quote: 'q2' }),
        // an evidence item WITHOUT a soulId is skipped (no anchor to link)
        {
          kind: 'source-quote',
          verdict: 'valid',
          checkedAt: NOW,
          quote: 'q3',
          targetHash: BLAKE_A,
        },
      ],
    });
    const c = compositeOf([{ record: r, source: 'team' }]);
    const supported = c.edges.filter((e) => e.rel === 'supported-by') as MemoryCompositeEdge[];
    expect(supported).toHaveLength(2);
    expect(supported.map((e) => e.dst).sort()).toEqual(
      ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d'].sort(),
    );
  });
});

describe('memoryComposite conflicts-with edges', () => {
  it('emits pairwise conflicts-with edges within a conflict group', () => {
    const r1 = record({ subject: 'topic:auth-strategy', claim: 'use oauth' });
    const r2 = record({ subject: 'topic:auth-strategy', claim: 'use saml' });
    const c = compositeOf([
      { record: r1, source: 'team' },
      { record: r2, source: 'team' },
    ]);
    const conflicts = c.edges.filter((e) => e.rel === 'conflicts-with') as MemoryCompositeEdge[];
    // one group of 2 ⇒ exactly one pair
    expect(conflicts).toHaveLength(1);
    const e = conflicts[0];
    expect(e).toBeDefined();
    expect([e?.src, e?.dst].sort()).toEqual([r1.id, r2.id].sort());
    expect(e?.origin).toBe('memory');
  });

  it('emits all pairs for a 3-record conflict group', () => {
    const r1 = record({ subject: 'topic:x', claim: 'c1' });
    const r2 = record({ subject: 'topic:x', claim: 'c2' });
    const r3 = record({ subject: 'topic:x', claim: 'c3' });
    const c = compositeOf([
      { record: r1, source: 'team' },
      { record: r2, source: 'team' },
      { record: r3, source: 'team' },
    ]);
    const conflicts = c.edges.filter((e) => e.rel === 'conflicts-with');
    // 3 choose 2 = 3 pairs
    expect(conflicts).toHaveLength(3);
  });

  it('does not emit conflicts-with for records in different scopes (no conflict group)', () => {
    const repo = record({
      subject: 'topic:x',
      claim: 'repo-claim',
      boundary: 'repo',
      repoId: REPO,
    });
    const glob = record({ subject: 'topic:x', claim: 'global-claim', boundary: 'global' });
    const c = compositeOf([
      { record: repo, source: 'team' },
      { record: glob, source: 'global' },
    ]);
    expect(c.edges.filter((e) => e.rel === 'conflicts-with')).toHaveLength(0);
  });
});

describe('memoryComposite edge ids are content-stable', () => {
  it('an applies-to edge id is memedge:applies-to:<src>:<dst> (no per-process counter)', () => {
    const r = record({
      subject: 'sym:src/a.ts#A.b',
      claim: 'claim',
      appliesTo: ['sym:src/a.ts#A.b'],
    });
    const c = compositeOf([{ record: r, source: 'team' }]);
    const applies = c.edges.find((e) => e.rel === 'applies-to') as MemoryCompositeEdge | undefined;
    expect(applies?.id).toBe(`memedge:applies-to:${r.id}:sym:src/a.ts#A.b`);
  });
});
