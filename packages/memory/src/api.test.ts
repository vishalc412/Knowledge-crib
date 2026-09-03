import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
/**
 * G1.3 — the portable API core (api.ts). One test per contract clause:
 *
 *   - `capture`: candidate tier, auto-anchoring (id → qualified → simple, AMBIGUITY reported never
 *     guessed), self-checked source-quote evidence, scope resolution, idempotence by content id;
 *   - `search`: the RICH response contract (visibility, effective verdicts + evidence summaries,
 *     freshness, validity interval, lineage, score + ranking version, conflicts, superseded
 *     alternatives, storage placement) — REUSING the recall projection, never re-ranking;
 *   - `get`: legacy v1 id resolution through the alias map (as-believed state + resolved twin);
 *   - `supersede`: lineage on both sides + the lifecycle decision, history preserved;
 *   - `delete`: tombstone — excluded from search, PRESENT in history/audit;
 *   - `history`: point-in-time projection (asOf overlays decisions, validTime half-open);
 *   - `sync`: honest not-available naming Gate 4;
 *   - `audit`: verdict transitions, promotions, supersessions, quarantines.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MemoryAnchorPort,
  MemoryApi,
  type MemoryCandidate,
  type MemoryDecision,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryFeedback,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  RANKING_VERSION,
  __resetMemoryLockGuardForTest,
  believedLifecycle,
  decisionId,
  derivePropositionKey,
  feedbackId,
  memoryRecordId,
  memoryRecordV2Id,
  syncNotAvailable,
  validTimeHoldsAt,
  validTimeWindowOf,
  validityOf,
  visibilityOf,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';
const T3 = '2026-04-01T00:00:00.000Z';
const REPO = 'r-api';
const SUBJECT = 'sym:src/a.ts#A.b';

// ─── fixtures ────────────────────────────────────────────────────────────────

function evidence(over: Record<string, unknown> = {}): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId: SUBJECT,
    quote: 'does the thing',
    targetHash: 'blake3:abcd1234',
    ...over,
  };
}

function v1Record(
  over: {
    claim?: string;
    subject?: string;
    createdAt?: string;
    verdicts?: MemoryRecord['verdicts'];
    evidence?: MemoryEvidence[];
  } = {},
): MemoryRecord {
  const subject = over.subject ?? SUBJECT;
  const input = {
    kind: 'fact' as const,
    subject,
    claim: over.claim ?? 'A.b does the thing',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: over.evidence ?? [evidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: over.verdicts ?? {
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: over.createdAt ?? T0,
  };
}

/** A fully-formed memory-2 record (passes the v2 write gate when persisted). */
function v2Record(over: Partial<MemoryRecordV2> & { id?: string }): MemoryRecordV2 {
  const subject = over.subject ?? SUBJECT;
  const kind = over.kind ?? 'fact';
  const claim = over.claim ?? 'A.b does the thing';
  const ev = over.evidence ?? [evidence()];
  const base: MemoryRecordV2 = {
    id:
      over.id ??
      memoryRecordV2Id({
        kind,
        subject,
        propositionKey: derivePropositionKey({ subject }),
        claim,
        evidence: ev,
      }),
    schemaVersion: '2',
    visibility: 'workspace',
    kind,
    subject,
    propositionKey: derivePropositionKey({
      subject,
      ...(over.propositionKey ? { propositionKey: over.propositionKey } : {}),
    }),
    claim,
    validTime: { from: T0 },
    transactionTime: { observedAt: T0, recordedAt: T0 },
    evidence: ev,
    provenance: {
      principalId: 'principal:local',
      deviceId: 'device:local',
      actorId: 'claude-code',
      agentId: 'claude-code',
      clientId: 'claude-code',
    },
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
    ...over,
  };
  return base;
}

function decisionOn(
  subject: string,
  kind: MemoryDecision['kind'],
  over: { actor?: string; ts?: string; successor?: string; reason?: string } = {},
): MemoryDecision {
  const actor = over.actor ?? 'ci';
  return {
    id: decisionId({
      kind,
      subject,
      ...(over.successor ? { successor: over.successor } : {}),
      actor,
      ...(over.reason ? { reason: over.reason } : {}),
    }),
    schemaVersion: '1',
    kind,
    subject,
    ...(over.successor ? { successor: over.successor } : {}),
    actor,
    ...(over.reason ? { reason: over.reason } : {}),
    ts: over.ts ?? T0,
  };
}

function feedbackOn(subject: string, signal: MemoryFeedback['signal']): MemoryFeedback {
  return {
    id: feedbackId({ signal, subject, actor: 'ci' }),
    schemaVersion: '1',
    signal,
    subject,
    actor: 'ci',
    ts: T0,
  };
}

/** A fake anchor port (node lookup + full scan + span rehydrate from a text map). */
function fakePort(nodes: Node[], texts = new Map<string, string>()): MemoryAnchorPort {
  return {
    getNode: (id) => nodes.find((n) => n.id === id),
    allNodes: () => nodes,
    rehydrate: (n) => ({
      text: texts.get(n.id) ?? n.name ?? '',
      truncated: false,
      totalLines: 1,
      startLine: n.span?.start ?? 1,
    }),
  };
}

function anchorNode(partial: Partial<Node> & { id: string }): Node {
  return {
    hash: 'blake3:abcd1234',
    file: 'src/a.ts',
    span: { start: 1, end: 100 },
    ...partial,
  } as Node;
}

// ─── harness ──────────────────────────────────────────────────────────────────

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-api-home-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

/** A local store + API over it with a mutable deterministic clock. */
function setup(opts: { soul?: MemoryAnchorPort; repoId?: string } = {}) {
  const local = MemoryStore.local(REPO, { env, now: () => T0 });
  let clock = T0;
  const api = new MemoryApi({
    stores: { local },
    env,
    now: () => clock,
    ...(opts.soul ? { soul: opts.soul } : {}),
  });
  return {
    local,
    api,
    tick: (t: string) => {
      clock = t;
    },
  };
}

/** A TEAM + LOCAL pair with the API over both (cross-store / no-poison fixtures). */
function setupMulti() {
  const crib = mkdtempSync(join(tmpdir(), 'mem-api-team-'));
  const team = MemoryStore.team(crib, { env, now: () => T0 });
  const local = MemoryStore.local(REPO, { env, now: () => T0 });
  let clock = T0;
  const api = new MemoryApi({
    stores: { team, local },
    env,
    now: () => clock,
  });
  return {
    team,
    local,
    api,
    tick: (t: string) => {
      clock = t;
    },
  };
}

/** A minimal soul port for the fresh evaluator: every lookup misses (nothing is fabricated). */
function evalSoulPort(): {
  getNode: (id: string) => undefined;
  rehydrate: () => { text: string; truncated: boolean; totalLines: number; startLine: number };
  findByLocator: () => [];
} {
  return {
    getNode: () => undefined,
    rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
    findByLocator: () => [],
  };
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('validTimeHoldsAt is half-open [from, to)', () => {
    const window = { from: T1, to: T3 };
    expect(validTimeHoldsAt(window, T0)).toBe(false); // before from
    expect(validTimeHoldsAt(window, T1)).toBe(true); // from inclusive
    expect(validTimeHoldsAt(window, T2)).toBe(true);
    expect(validTimeHoldsAt(window, T3)).toBe(false); // to exclusive
    expect(validTimeHoldsAt({ from: T1 }, T3)).toBe(true); // open-ended
  });

  it('believedLifecycle gives retract precedence over supersede and tracks quarantine', () => {
    expect(believedLifecycle([decisionOn('mem:x', 'supersede')])).toEqual({
      lifecycle: 'superseded',
      quarantined: false,
    });
    // order-independent: a later supersede never un-retracts
    expect(
      believedLifecycle([
        decisionOn('mem:x', 'retract', { ts: T2 }),
        decisionOn('mem:x', 'supersede', { ts: T3 }),
      ]),
    ).toEqual({ lifecycle: 'retracted', quarantined: false });
    expect(believedLifecycle([decisionOn('mem:x', 'quarantine')])).toEqual({
      lifecycle: 'active',
      quarantined: true,
    });
  });

  it('believedLifecycle folds from the stamped base lifecycle, keeping retract precedence', () => {
    // the base is the record's stamped lifecycle (v1 verdicts / v2 conservative snapshot) — the
    // same base effectiveVerdicts starts from — so a hand-stamped shard projects coherently.
    expect(believedLifecycle([], 'superseded')).toEqual({
      lifecycle: 'superseded',
      quarantined: false,
    });
    expect(believedLifecycle([], 'retracted')).toEqual({
      lifecycle: 'retracted',
      quarantined: false,
    });
    expect(believedLifecycle([decisionOn('mem:x', 'quarantine')], 'superseded')).toEqual({
      lifecycle: 'superseded', // a quarantine never changes the lifecycle
      quarantined: true,
    });
    // a supersede never un-retracts — the precedence holds from ANY stamped base
    expect(believedLifecycle([decisionOn('mem:x', 'supersede', { ts: T3 })], 'retracted')).toEqual({
      lifecycle: 'retracted',
      quarantined: false,
    });
    // and a retract still wins over a supersede regardless of base
    expect(
      believedLifecycle(
        [decisionOn('mem:x', 'supersede', { ts: T2 }), decisionOn('mem:x', 'retract', { ts: T3 })],
        'superseded',
      ),
    ).toEqual({ lifecycle: 'retracted', quarantined: false });
  });

  it('validityOf/visibilityOf derive the v1 axes through the documented mapping', () => {
    const r = v1Record();
    expect(validityOf(r)).toEqual({
      validTime: { from: T0 },
      transactionTime: { observedAt: T0, recordedAt: T0 },
    });
    expect(visibilityOf(r)).toBe('workspace');
    expect(visibilityOf(v2Record({ visibility: 'private' }))).toBe('private');
    expect(validityOf(v2Record({ validTime: { from: T1, to: T3 } })).validTime).toEqual({
      from: T1,
      to: T3,
    });
  });

  it('syncNotAvailable names Gate 4 and echoes the request untouched', () => {
    const res = syncNotAvailable({ direction: 'push' });
    expect(res.ok).toBe(false);
    expect(res.available).toBe(false);
    expect(res.capability).toBe('sync');
    expect(res.status).toBe('not-implemented');
    expect(res.gate).toBe('Gate 4');
    expect(res.request).toEqual({ direction: 'push' });
    expect(res.message).toContain('Gate 4');
  });
});

// ─── capture ──────────────────────────────────────────────────────────────────

describe('capture', () => {
  it('writes a pending candidate to the local store with repo scope', () => {
    const { local, api } = setup();
    const res = api.capture({
      subject: SUBJECT,
      observation: 'A.b returns 42',
      kind: 'fact',
      actor: 'claude-code',
      scopeBoundary: 'repo',
      repoId: REPO,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.id.startsWith('cand:')).toBe(true);
    expect(res.status).toBe('pending');
    expect(res.origin).toBe('observe');
    expect(res.scope).toEqual({ boundary: 'repo', repoId: REPO });
    expect(res.anchorStatus).toBe('unanchored');
    expect(res.evidenceAttached).toBe(false);
    expect(res.duplicate).toBe(false);
    const read = local.readCollection('candidates');
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.id).toBe(res.id);
    const cand = read.entries[0] as MemoryCandidate;
    expect(cand.claim).toBe('A.b returns 42');
    expect(cand.meta?.anchorStatus).toBe('unanchored');
  });

  it('is idempotent by content id — a repeat capture upserts the same candidate', () => {
    const { local, api } = setup();
    const input = {
      subject: SUBJECT,
      observation: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
    };
    const first = api.capture(input);
    const second = api.capture(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(local.readCollection('candidates').entries).toHaveLength(1);
  });

  it('anchors loose symbol names and attaches self-checked source-quote evidence', () => {
    const port = fakePort(
      [anchorNode({ id: SUBJECT, name: 'A.b', qualifiedName: 'A.b' })],
      new Map([[SUBJECT, 'does the thing']]),
    );
    const { local, api } = setup({ soul: port });
    const res = api.capture({
      subject: SUBJECT,
      observation: 'A.b does the thing',
      actor: 'claude-code',
      repoId: REPO,
      symbols: ['A.b'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchorStatus).toBe('anchored');
    expect(res.anchors).toEqual([SUBJECT]);
    expect(res.evidenceAttached).toBe(true);
    expect(res.ambiguous).toEqual([]);
    const cand = local.readCollection('candidates').entries[0] as MemoryCandidate;
    expect(cand.appliesTo).toEqual([SUBJECT]);
    expect(cand.evidence).toHaveLength(1);
    expect(cand.evidence[0]?.kind).toBe('source-quote');
    expect(cand.evidence[0]?.verdict).toBe('valid'); // earned via verifyQuote, never assumed
    expect(cand.evidence[0]?.quote).toBe('does the thing');
  });

  it('reports ambiguous and unresolvable names without failing the capture', () => {
    const port = fakePort([
      anchorNode({ id: 'sym:x1', name: 'dup' }),
      anchorNode({ id: 'sym:x2', name: 'dup' }),
    ]);
    const { api } = setup({ soul: port });
    const res = api.capture({
      subject: SUBJECT,
      observation: 'something happened',
      actor: 'claude-code',
      repoId: REPO,
      symbols: ['dup', 'nope'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchorStatus).toBe('ambiguous'); // nothing resolved, ambiguity reported
    expect(res.anchors).toEqual([]);
    expect(res.ambiguous).toEqual(['dup']);
    expect(res.unresolvable).toEqual(['nope']);
  });

  it('fails closed on invalid input', () => {
    const { api } = setup();
    const base = { subject: SUBJECT, observation: 'x', actor: 'a', repoId: REPO };
    expect(api.capture({ ...base, kind: 'vibe' }).ok).toBe(false);
    expect(api.capture({ ...base, kind: 'vibe' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('invalid kind') as unknown,
    });
    expect(api.capture({ ...base, subject: '' }).ok).toBe(false);
    expect(api.capture({ ...base, observation: '' }).ok).toBe(false);
    expect(api.capture({ ...base, actor: '' }).ok).toBe(false);
  });

  it('refuses repo scope without a resolvable repoId, admits global scope', () => {
    const { api } = setup();
    const repo = api.capture({
      subject: SUBJECT,
      observation: 'x',
      actor: 'a',
      scopeBoundary: 'repo',
    });
    expect(repo).toMatchObject({
      ok: false,
      error: expect.stringContaining('repoId') as unknown,
    });
    const global = api.capture({
      subject: SUBJECT,
      observation: 'x',
      actor: 'a',
      scopeBoundary: 'global',
    });
    expect(global.ok).toBe(true);
    if (!global.ok) return;
    expect(global.scope).toEqual({ boundary: 'global' });
  });

  it('refuses loose refs when no anchor port is wired (never pretends to resolve)', () => {
    const { api } = setup();
    const res = api.capture({
      subject: SUBJECT,
      observation: 'x',
      actor: 'a',
      repoId: REPO,
      symbols: ['A.b'],
    });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('soul port') as unknown,
    });
  });
});

// ─── search ───────────────────────────────────────────────────────────────────

describe('search', () => {
  it('returns the rich hit contract on every result', () => {
    const { local, api } = setup();
    const rec = v1Record({ claim: 'A.b does the thing' });
    local.upsertEntry('active', rec);
    const res = api.search(SUBJECT, { codeHead: 'abcd1234' });
    expect(res.query).toBe(SUBJECT);
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0];
    if (!hit) throw new Error('no hit');
    expect(hit.id).toBe(rec.id);
    expect(hit.schemaVersion).toBe('1');
    expect(hit.kind).toBe('fact');
    expect(hit.record).toEqual(rec);
    expect(hit.visibility).toBe('workspace'); // derived through the documented v1 mapping
    expect(hit.scope).toEqual({ boundary: 'repo', repoId: REPO }); // SEMANTIC scope
    expect(hit.placement).toEqual(['local']); // STORAGE placement — separate axis
    expect(hit.verdicts.trust).toBe('local');
    expect(hit.verdicts.quarantined).toBe(false);
    expect(hit.evidence[0]).toMatchObject({ kind: 'source-quote', verdict: 'valid' });
    expect(hit.freshness).toEqual({
      state: 'unevaluated',
      evaluatedAt: null,
      codeHead: 'abcd1234',
    });
    expect(hit.validity).toEqual({
      validTime: { from: T0 },
      transactionTime: { observedAt: T0, recordedAt: T0 },
    });
    expect(hit.lineage).toEqual({});
    expect(hit.score).toMatchObject({ lexical: expect.any(Number) as unknown, sourceTier: 2 });
    expect(hit.rankingVersion).toBe(RANKING_VERSION);
    expect(hit.conflicts).toEqual([]);
    expect(hit.supersededBy).toEqual([]);
    expect(res.provenance.rankingVersion).toBe(RANKING_VERSION);
    expect(res.provenance.counts.eligible).toBe(1);
    expect(res.provenance.fresh).toBe(false);
  });

  it('reuses the recall projection ranking (valid evidence outranks degraded)', () => {
    const { local, api } = setup();
    const good = v1Record({ claim: 'A.b does the thing' });
    const bad = v1Record({
      claim: 'A.b does another thing',
      verdicts: {
        trust: 'local',
        evidence: 'degraded',
        applicability: 'current',
        lifecycle: 'active',
      },
    });
    local.upsertEntries('active', [good, bad]);
    const res = api.search(SUBJECT);
    expect(res.hits.map((h) => h.id)).toEqual([good.id, bad.id]);
    expect(res.hits[0]?.score.evidenceQuality).toBe(2);
    expect(res.hits[1]?.score.evidenceQuality).toBe(1);
  });

  it('excludes a tombstoned record', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    expect(api.search(SUBJECT).hits).toHaveLength(1);
    const del = api.delete(rec.id, { actor: 'ci', reason: 'stale' });
    expect(del.ok).toBe(true);
    expect(api.search(SUBJECT).hits).toHaveLength(0);
  });

  it('surfaces contradicts pairs as conflicts and complementary v2 facts as none', () => {
    const { local, api } = setup();
    const prop = derivePropositionKey({ subject: SUBJECT });
    const a = v2Record({ claim: 'A.b returns 42', lineage: { contradicts: [] } });
    const b = v2Record({ claim: 'A.b returns 7' });
    // mutual contradiction: a declares against b's id
    a.lineage = { contradicts: [b.id] };
    b.lineage = { contradicts: [a.id] };
    local.upsertEntries('active', [a, b]);
    const conflicted = api.search(SUBJECT);
    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.conflicts[0]?.propositionKey).toBe(prop);
    expect(new Set(conflicted.conflicts[0]?.recordIds)).toEqual(new Set([a.id, b.id]));

    // complementary: same proposition key, no contradicts edge → NOT a conflict (G1.1)
    const c = v2Record({ claim: 'A.b is cached' });
    const d = v2Record({ claim: 'A.b logs on error' });
    local.upsertEntries('active', [c, d]);
    const complementary = api.search(SUBJECT);
    const keys = complementary.conflicts.map((g) => g.key);
    expect(keys).toEqual([prop]); // only the contradicts pair — the complementary facts never group
  });

  it('surfaces a v2 successor that declares it retires a hit (via lineage)', () => {
    const { local, api } = setup();
    const old = v1Record({ claim: 'A.b returns 42' });
    local.upsertEntry('active', old);
    const successor = v2Record({
      claim: 'A.b returns 43',
      lineage: { supersedes: [old.id] },
      validTime: { from: T2 },
      transactionTime: { observedAt: T2, recordedAt: T2 },
    });
    local.upsertEntry('active', successor);
    const res = api.search(SUBJECT);
    // the OLD record still ranks (no decision event), but the retirement declaration is surfaced
    const hit = res.hits.find((h) => h.id === old.id);
    expect(hit).toBeDefined();
    expect(hit?.supersededBy).toEqual([
      {
        id: successor.id,
        via: 'lineage',
        found: true,
        subject: SUBJECT,
        claim: 'A.b returns 43',
      },
    ]);
  });

  it('scopes supersede decisions to the hit source in supersededBy (no-poison)', () => {
    // A LOCAL supersede decision retires the record's LOCAL copy only. The team-sourced hit's
    // VERDICTS already come from the projection (which holds the line — lifecycle stays active);
    // its supersededBy must agree: it may never list a successor the team store never accepted.
    // The retired local copy leaves ranking, so the local view surfaces through get() — locate is
    // local-first and get() folds local decisions into the local-sourced view, which keeps the link.
    const { team, local, api } = setupMulti();
    const rec = v1Record();
    team.upsertEntry('records', rec);
    local.upsertEntry('active', rec);
    const successor = v1Record({ claim: 'A.b returns 43', createdAt: T1 });
    local.upsertEntry('active', successor);
    local.upsertEntry(
      'decisions',
      decisionOn(rec.id, 'supersede', { successor: successor.id, ts: T1 }),
    );

    const hits = api.search(SUBJECT).hits;
    const teamHit = hits.find((h) => h.source === 'team');
    expect(teamHit?.id).toBe(rec.id);
    expect(teamHit?.verdicts.lifecycle).toBe('active'); // the projection holds no-poison…
    expect(teamHit?.supersededBy).toEqual([]); // …and the successor list must not poison either
    // the local successor itself still ranks (local-sourced, nothing retires it)
    const successorHit = hits.find((h) => h.id === successor.id);
    expect(successorHit?.source).toBe('local');
    expect(successorHit?.supersededBy).toEqual([]);
    // the LOCAL view keeps the successor link — the same pool a local-sourced fold uses
    const got = api.get(rec.id);
    expect(got.source).toBe('local');
    expect(got.supersededBy).toEqual([
      { id: successor.id, via: 'decision', found: true, subject: SUBJECT, claim: 'A.b returns 43' },
    ]);
  });

  it('honours the sources filter', () => {
    const { local, api } = setup();
    local.upsertEntry('active', v1Record());
    const res = api.search(SUBJECT, { sources: ['global'] });
    expect(res.hits).toHaveLength(0);
    expect(res.provenance.sources).toEqual([]);
  });

  it('labels each hit with the EFFECTIVE store the projection resolved it from', () => {
    // the same record id physically held by team AND local: the projection yields one entry per
    // source, and each hit must report the store its governing verdicts came from — the same
    // `source` field memoryRecall reports — never the raw placement list (which is local-first).
    const { team, local, api } = setupMulti();
    const rec = v1Record();
    team.upsertEntry('records', rec);
    local.upsertEntry('active', rec);
    const hits = api.search(SUBJECT).hits;
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.source).sort()).toEqual(['local', 'team']);
    for (const hit of hits) {
      expect(hit.placement).toEqual(['local', 'team']); // STORAGE placement, local-first
    }
  });

  it('is ifHash-stable: two FRESH searches are byte-identical even as the clock ticks', () => {
    // The MCP verb hashes the full response (BLAKE3 over key-sorted JSON); a wall-clock
    // `evaluatedAt` stamped anywhere in it makes {unchanged:true} unreachable — recall.ts's
    // provenance carries NO timestamps for exactly this reason. A fresh (evaluator-wired) search
    // must be byte-equal across two calls with a moved clock.
    const { local, api, tick } = setup();
    local.upsertEntry('active', v1Record());
    const evaluator = new MemoryEvaluator();
    const evalCtx = { soul: evalSoulPort() };
    const first = api.search(SUBJECT, { evaluator, evalCtx });
    expect(first.provenance.fresh).toBe(true); // the fresh path is what we are gating
    tick(T3); // the wall clock moved
    const second = api.search(SUBJECT, { evaluator, evalCtx });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('resolves a direct id with placement and effective verdicts', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    const res = api.get(rec.id);
    expect(res.found).toBe(true);
    expect(res.id).toBe(rec.id);
    expect(res.record).toEqual(rec);
    expect(res.placement).toEqual(['local']);
    expect(res.source).toBe('local');
    expect(res.legacyIds).toEqual([]);
    expect(res.legacy).toEqual([]);
    expect(res.verdicts?.trust).toBe('local');
    expect(res.visibility).toBe('workspace');
  });

  it('resolves a legacy v1 id through the alias map after migration', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    const migration = local.migrateToV2({});
    expect(migration.migrated).toHaveLength(1);
    const twinId = migration.migrated[0];
    const res = api.get(rec.id); // the LEGACY id
    expect(res.found).toBe(true);
    expect(res.requestedId).toBe(rec.id);
    expect(res.id).toBe(twinId);
    expect(res.resolvedViaAlias?.legacyId).toBe(rec.id);
    expect(res.resolvedViaAlias?.resolvedId).toBe(twinId);
    expect(res.legacyIds).toEqual([rec.id]);
    // the as-believed v1 state survives in the binding
    expect(res.legacy[0]?.scope).toEqual({ boundary: 'repo', repoId: REPO });
    expect(res.legacy[0]?.appliesTo).toEqual([SUBJECT]);
    // the conservative verdict snapshot restores the v1 axes (not candidate-trust)
    expect(res.verdicts?.trust).toBe('local');
    expect(res.propositionKey).toBeDefined();
  });

  it('reports not-found without throwing', () => {
    const { api } = setup();
    const res = api.get('mem:doesnotexist');
    expect(res.found).toBe(false);
    expect(res.legacyIds).toEqual([]);
    expect(res.placement).toEqual([]);
  });

  it('folds a quarantine decision into the effective verdicts', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    local.upsertEntry('decisions', decisionOn(rec.id, 'quarantine'));
    const res = api.get(rec.id);
    expect(res.verdicts?.quarantined).toBe(true);
  });

  it('surfaces a lineage-declared successor (via lineage), consistent with search', () => {
    // a v2 record's lineage.supersedes declaration is a retirement the ranking never reads —
    // search surfaces it (the via:'lineage' contract); get must surface the SAME declaration,
    // never silently drop it because its gathered-records pool was empty.
    const { local, api } = setup();
    const old = v1Record({ claim: 'A.b returns 42' });
    local.upsertEntry('active', old);
    const successor = v2Record({
      claim: 'A.b returns 43',
      lineage: { supersedes: [old.id] },
      validTime: { from: T2 },
      transactionTime: { observedAt: T2, recordedAt: T2 },
    });
    local.upsertEntry('active', successor);
    const res = api.get(old.id);
    expect(res.found).toBe(true);
    expect(res.supersededBy).toEqual([
      { id: successor.id, via: 'lineage', found: true, subject: SUBJECT, claim: 'A.b returns 43' },
    ]);
  });
});

// ─── supersede ────────────────────────────────────────────────────────────────

describe('supersede', () => {
  it('creates the v2 successor with lineage, appends the decision, preserves history', () => {
    const { local, api, tick } = setup();
    tick(T2);
    const old = v1Record({ claim: 'A.b returns 42' });
    local.upsertEntry('active', old);
    const res = api.supersede(
      old.id,
      { claim: 'A.b returns 43' },
      { actor: 'ci', reason: 'measured again' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.supersededId).toBe(old.id);
    expect(res.successorCreated).toBe(true);
    expect(res.decisionSource).toBe('local');
    const successor = api.get(res.successorId);
    expect(successor.found).toBe(true);
    expect((successor.record as MemoryRecordV2).schemaVersion).toBe('2');
    expect((successor.record as MemoryRecordV2).lineage.supersedes).toEqual([old.id]);
    // the old line survives (append-only) but is retired from search
    expect(local.readCollection('active').entries.some((e) => e.id === old.id)).toBe(true);
    expect(api.search(SUBJECT).hits.find((h) => h.id === old.id)).toBeUndefined();
    // the decision is on disk, keyed on the resolved id, carrying the successor link
    const dec = local.readCollection('decisions').entries[0] as MemoryDecision;
    expect(dec.kind).toBe('supersede');
    expect(dec.subject).toBe(old.id);
    expect(dec.successor).toBe(res.successorId);
    expect(dec.ts).toBe(T2);
  });

  it('is idempotent — the same inputs re-derive the same ids', () => {
    const { local, api } = setup();
    const old = v1Record();
    local.upsertEntry('active', old);
    const first = api.supersede(old.id, { claim: 'A.b returns 43' }, { actor: 'ci' });
    const second = api.supersede(old.id, { claim: 'A.b returns 43' }, { actor: 'ci' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.successorId).toBe(first.successorId);
    expect(second.successorCreated).toBe(false);
    expect(local.readCollection('decisions').entries).toHaveLength(1);
  });

  it('stamps lineage onto an existing v2 successor (byId) without moving its id', () => {
    const { local, api } = setup();
    const old = v1Record({ claim: 'A.b returns 42' });
    const successor = v2Record({ claim: 'A.b returns 43', lineage: {} });
    local.upsertEntries('active', [old, successor]);
    const res = api.supersede(old.id, successor.id, { actor: 'ci', reason: 'link' });
    expect(res.ok).toBe(true);
    const after = api.get(successor.id);
    expect((after.record as MemoryRecordV2).id).toBe(successor.id); // id stable (lineage not in seed)
    expect((after.record as MemoryRecordV2).lineage.supersedes).toEqual([old.id]);
    expect(api.search(SUBJECT).hits.find((h) => h.id === old.id)).toBeUndefined();
  });

  it('fails closed on unknown ids and a missing actor', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    expect(api.supersede('mem:missing', { claim: 'x' }, { actor: 'ci' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found') as unknown,
    });
    expect(api.supersede(rec.id, 'mem:missing', { actor: 'ci' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('successor') as unknown,
    });
    expect(api.supersede(rec.id, { claim: 'x' }, { actor: '' })).toMatchObject({
      ok: false,
      error: 'actor is required',
    });
  });
});

// ─── delete (tombstone) ───────────────────────────────────────────────────────

describe('delete', () => {
  it('tombstones: excluded from search, PRESENT in history and audit', () => {
    const { local, api, tick } = setup();
    tick(T2);
    const rec = v1Record();
    local.upsertEntry('active', rec);
    const del = api.delete(rec.id, { actor: 'ci', reason: 'obsolete' });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.id).toBe(rec.id);
    expect(del.mode).toBe('tombstone');
    expect(del.decisionSource).toBe('local');
    // excluded from search…
    expect(api.search(SUBJECT).hits).toHaveLength(0);
    // …but the record line + the decision survive
    expect(local.readCollection('active').entries.some((e) => e.id === rec.id)).toBe(true);
    expect(local.readCollection('decisions').entries).toHaveLength(1);
    // history still shows the belief (retracted), audit shows the transition
    const history = api.history(rec.id);
    expect(history.records[0]?.lifecycle).toBe('retracted');
    const audit = api.audit(rec.id);
    expect(audit.found).toBe(true);
    expect(audit.records[0]?.transitions).toEqual([
      expect.objectContaining({ kind: 'lifecycle', from: 'active', to: 'retracted', at: T2 }),
    ]);
    // idempotent: the same actor+reason re-derives the same decision id
    const again = api.delete(rec.id, { actor: 'ci', reason: 'obsolete' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.decisionId).toBe(del.decisionId);
    expect(local.readCollection('decisions').entries).toHaveLength(1);
  });

  it('fails closed on an unknown id', () => {
    const { api } = setup();
    expect(api.delete('mem:missing', { actor: 'ci' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found') as unknown,
    });
  });
});

// ─── history ─────────────────────────────────────────────────────────────────

describe('history', () => {
  it('returns the full belief timeline without asOf', () => {
    const { local, api, tick } = setup();
    tick(T2);
    const old = v1Record({ claim: 'A.b returns 42', createdAt: T0 });
    local.upsertEntry('active', old);
    const sup = api.supersede(
      old.id,
      { claim: 'A.b returns 43' },
      { actor: 'ci', reason: 'again' },
    );
    expect(sup.ok).toBe(true);
    const res = api.history(SUBJECT);
    expect(res.records.map((r) => r.claim).sort()).toEqual(['A.b returns 42', 'A.b returns 43']);
    const oldBelief = res.records.find((r) => r.claim === 'A.b returns 42');
    expect(oldBelief?.lifecycle).toBe('superseded');
    expect(res.events.map((e) => e.type)).toEqual(['recorded', 'recorded', 'supersede']);
    const supEvent = res.events[2];
    expect(supEvent).toMatchObject({ type: 'supersede', recordId: old.id, actor: 'ci' });
  });

  it('projects what was believed at asOf — live before the supersede, retired after', () => {
    const { local, api, tick } = setup();
    const old = v1Record({ claim: 'A.b returns 42', createdAt: T0 });
    local.upsertEntry('active', old);
    tick(T2); // the supersede lands at T2
    const sup = api.supersede(old.id, { claim: 'A.b returns 43' }, { actor: 'ci' });
    expect(sup.ok).toBe(true);
    // before the supersede: the old claim was LIVE and no successor existed yet
    const before = api.history(SUBJECT, { asOf: T1 });
    expect(before.records).toHaveLength(1);
    expect(before.records[0]?.claim).toBe('A.b returns 42');
    expect(before.records[0]?.lifecycle).toBe('active');
    expect(before.events.map((e) => e.type)).toEqual(['recorded']);
    // after: the old claim was believed superseded and the successor is on the timeline
    const after = api.history(SUBJECT, { asOf: T3 });
    const oldAfter = after.records.find((r) => r.claim === 'A.b returns 42');
    expect(oldAfter?.lifecycle).toBe('superseded');
    expect(after.records.some((r) => r.claim === 'A.b returns 43')).toBe(true);
    expect(after.events.map((e) => e.type)).toEqual(['recorded', 'recorded', 'supersede']);
  });

  it('reports validTimeHolds against the half-open window at asOf', () => {
    const { local, api } = setup();
    const seasonal = v2Record({
      claim: 'A.b is under maintenance',
      validTime: { from: T1, to: T3 },
    });
    local.upsertEntry('active', seasonal);
    const inWindow = api.history(seasonal.id, { asOf: T2 });
    expect(inWindow.records[0]?.validTimeHolds).toBe(true);
    const atFrom = api.history(seasonal.id, { asOf: T1 });
    expect(atFrom.records[0]?.validTimeHolds).toBe(true); // from is inclusive
    const atTo = api.history(seasonal.id, { asOf: T3 });
    expect(atTo.records[0]?.validTimeHolds).toBe(false); // to is exclusive
    const before = api.history(seasonal.id, { asOf: T0 });
    expect(before.records[0]?.validTimeHolds).toBe(false);
  });

  it('recovers the as-believed v1 state for a migrated record', () => {
    const { local, api } = setup();
    const rec = v1Record({ createdAt: T0 });
    local.upsertEntry('active', rec);
    const migration = local.migrateToV2({});
    const twinId = migration.migrated[0];
    // look up by the LEGACY id: the twin is found through the alias, the v1 state rides the binding
    const res = api.history(rec.id, { asOf: T1 });
    expect(res.records).toHaveLength(1);
    const belief = res.records[0];
    expect(belief?.id).toBe(twinId);
    expect(belief?.schemaVersion).toBe('2');
    expect(belief?.legacy[0]?.legacyId).toBe(rec.id);
    expect(belief?.legacy[0]?.scope).toEqual({ boundary: 'repo', repoId: REPO });
    expect(belief?.legacy[0]?.appliesTo).toEqual([SUBJECT]);
    expect(belief?.recordedAt).toBe(T0); // migration preserves the v1 createdAt as recordedAt
  });

  it('includes feedback events on the timeline', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    local.upsertEntry('feedback', feedbackOn(rec.id, 'useful'));
    const res = api.history(rec.id);
    expect(res.events.map((e) => e.type)).toEqual(['recorded', 'feedback']);
  });

  // ─── adversarial-verify finding 1: history/audit must honour the no-poison rule ───

  it('belief fields honour the no-poison rule — a local decision never rewrites team belief', () => {
    // get()/search() fold LOCAL decisions into local-SOURCED records only (a local quarantine
    // must not retract the same-id team record). history()/audit() must agree: the DERIVED belief
    // fields (lifecycle/quarantined, audit's effective verdicts) match get/search, while the RAW
    // event lists keep every recorded decision (event visibility is correct and stays).
    const { team, local, api } = setupMulti();
    const rec = v1Record({
      verdicts: { trust: 'team', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    });
    team.upsertEntry('records', rec);
    local.upsertEntries('decisions', [
      decisionOn(rec.id, 'quarantine', { ts: T1 }),
      decisionOn(rec.id, 'retract', { ts: T2 }),
    ]);

    // get + search already honour the rule (team-sourced record, local decisions excluded)
    const got = api.get(rec.id);
    expect(got.source).toBe('team');
    expect(got.verdicts?.quarantined).toBe(false);
    expect(got.verdicts?.lifecycle).toBe('active');
    const hit = api.search(SUBJECT).hits[0];
    expect(hit?.id).toBe(rec.id);
    expect(hit?.verdicts.quarantined).toBe(false);
    expect(hit?.verdicts.lifecycle).toBe('active');

    // history: the projected belief must agree with get/search
    const history = api.history(rec.id);
    const belief = history.records[0];
    expect(belief?.quarantined).toBe(false);
    expect(belief?.lifecycle).toBe('active');
    // …while the RAW event list still shows every recorded decision, tagged with its store
    const decisionEvents = history.events.filter((e) => e.type !== 'recorded');
    expect(decisionEvents.map((e) => e.type).sort()).toEqual(['quarantine', 'retract']);
    for (const e of decisionEvents) {
      expect(e.source).toBe('local'); // event visibility — the events are real and stay visible
    }

    // audit: the computed verdicts must agree with get/search…
    const audit = api.audit(rec.id);
    const view = audit.records[0];
    expect(view?.verdicts.quarantined).toBe(false);
    expect(view?.verdicts.lifecycle).toBe('active');
    // …while the raw transition/quarantine lists keep the local events
    expect(view?.quarantines).toHaveLength(1);
    expect(view?.quarantines[0]?.source).toBe('local');
    expect(
      view?.transitions.some(
        (t) => t.kind === 'lifecycle' && t.to === 'retracted' && t.source === 'local',
      ),
    ).toBe(true);
  });

  it('folds belief from the stamped lifecycle — one lifecycle across get/audit/history', () => {
    // No first-party writer stamps a non-active v1 lifecycle (promotion always stamps 'active';
    // supersede/delete append decisions without re-stamping), but a hand-edited shard can.
    // history's belief projection must start from the SAME stamped base effectiveVerdicts starts
    // from (record.verdicts.lifecycle for v1, the conservative alias snapshot for v2) — otherwise
    // a hand-stamped superseded record yields a three-way disagreement: get/audit say 'superseded',
    // history says 'active', search excludes it.
    const { local, api } = setup();
    const rec = v1Record({
      verdicts: {
        trust: 'team',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'superseded',
      },
    });
    local.upsertEntry('active', rec);
    const h = api.history(rec.id);
    expect(h.records[0]?.lifecycle).toBe('superseded'); // agrees with…
    expect(api.get(rec.id).verdicts?.lifecycle).toBe('superseded'); // …get…
    expect(api.audit(rec.id).records[0]?.verdicts.lifecycle).toBe('superseded'); // …and audit
    expect(api.search(SUBJECT).hits.find((hit) => hit.id === rec.id)).toBeUndefined(); // excluded
  });

  // ─── adversarial-verify finding 3: asOf cuts must compare PARSED instants, not raw strings ───

  it('cuts second-precision asOf against millisecond-precision events on the correct side', () => {
    // a retract at 00:00:00.999 is AFTER the 00:00:00 instant — not yet believed at asOf
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    local.upsertEntry(
      'decisions',
      decisionOn(rec.id, 'retract', { ts: '2026-03-01T00:00:00.999Z' }),
    );
    const at = api.history(rec.id, { asOf: '2026-03-01T00:00:00Z' });
    expect(at.records[0]?.lifecycle).toBe('active'); // the raw string compare includes it
    const after = api.history(rec.id, { asOf: '2026-03-01T00:00:00.999Z' });
    expect(after.records[0]?.lifecycle).toBe('retracted'); // at the instant itself it IS believed
  });

  it('excludes records recorded after the parsed asOf instant (millisecond precision)', () => {
    const { local, api } = setup();
    const rec = v1Record({ createdAt: '2026-01-01T00:00:00.500Z' });
    local.upsertEntry('active', rec);
    const at = api.history(rec.id, { asOf: '2026-01-01T00:00:00Z' });
    expect(at.records).toHaveLength(0); // the raw string compare admits it ('.' < 'Z')
  });

  it('treats non-canonical asOf forms as their parsed instant (date-only, ±offsets)', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    local.upsertEntry(
      'decisions',
      decisionOn(rec.id, 'retract', { ts: '2026-03-01T00:00:00.000Z' }),
    );
    // every form below is the SAME instant the decision landed at → believed retracted
    for (const asOf of [
      '2026-03-01', // date-only
      '2026-03-01T05:30:00+05:30', // positive offset
      '2026-02-28T18:30:00-05:30', // negative offset (previous local day)
    ]) {
      const at = api.history(rec.id, { asOf });
      expect(at.records[0]?.lifecycle).toBe('retracted');
    }
    // a form one SECOND before the decision excludes it
    const before = api.history(rec.id, { asOf: '2026-02-28T23:59:59.000Z' });
    expect(before.records[0]?.lifecycle).toBe('active');
  });

  it('rejects an unparseable asOf with a clear error (never a silent mis-filter)', () => {
    const { api } = setup();
    expect(() => api.history(SUBJECT, { asOf: 'not-a-date' })).toThrow(/asOf/);
  });

  // ─── adversarial-verify finding 5: the validTime window state is explicit, never silent ───

  it('surfaces the validTime window state alongside validTimeHolds at asOf', () => {
    const { local, api } = setup();
    const seasonal = v2Record({
      claim: 'A.b is under maintenance',
      validTime: { from: T1, to: T3 },
    });
    local.upsertEntry('active', seasonal);
    const inWindow = api.history(seasonal.id, { asOf: T2 });
    expect(inWindow.records[0]?.validTimeHolds).toBe(true);
    expect(inWindow.records[0]?.validTimeWindow).toBe('valid');
    const outside = api.history(seasonal.id, { asOf: T0 });
    expect(outside.records[0]?.validTimeHolds).toBe(false);
    expect(outside.records[0]?.validTimeWindow).toBe('valid'); // false because OUTSIDE, not broken
  });

  it('validTimeWindowOf distinguishes broken windows from mere non-coverage (pure)', () => {
    expect(validTimeWindowOf({ from: T1, to: T3 })).toBe('valid');
    expect(validTimeWindowOf({ from: T1 })).toBe('valid'); // open-ended
    expect(validTimeWindowOf({ from: T3, to: T1 })).toBe('inverted');
    expect(validTimeWindowOf({ from: T1, to: T1 })).toBe('inverted'); // empty is not a window
    expect(validTimeWindowOf({ from: 'not-a-date' })).toBe('unparseable');
    expect(validTimeWindowOf({ from: T1, to: 'whenever' })).toBe('unparseable');
  });
});

// ─── sync ─────────────────────────────────────────────────────────────────────

describe('sync', () => {
  it('is a declared capability that honestly reports not-available, naming Gate 4', () => {
    const { api } = setup();
    const res = api.sync({ stores: ['local', 'team'] });
    expect(res.ok).toBe(false);
    expect(res.available).toBe(false);
    expect(res.capability).toBe('sync');
    expect(res.status).toBe('not-implemented');
    expect(res.gate).toBe('Gate 4');
    expect(res.request).toEqual({ stores: ['local', 'team'] });
    // nothing was written: no store directory beyond what the harness created
    const { local } = setup();
    expect(existsSync(join(local.rootDir, 'records'))).toBe(false);
  });
});

// ─── audit ───────────────────────────────────────────────────────────────────

describe('audit', () => {
  it('reports verdict transitions, promotions, supersessions and quarantines', () => {
    const { local, api } = setup();
    const rec = v1Record();
    local.upsertEntry('active', rec);
    local.upsertEntries('decisions', [
      decisionOn(rec.id, 'accept', { actor: 'reviewer', ts: T1 }),
      decisionOn(rec.id, 'quarantine', { actor: 'ci', reason: 'evidence failed', ts: T2 }),
      decisionOn(rec.id, 'supersede', { actor: 'ci', successor: 'mem:next', ts: T3 }),
    ]);
    const res = api.audit(rec.id);
    expect(res.found).toBe(true);
    expect(res.records).toHaveLength(1);
    const view = res.records[0];
    if (!view) throw new Error('no view');
    expect(view.stamped?.trust).toBe('local'); // the as-of-save stamp
    expect(view.verdicts.quarantined).toBe(true); // effective
    expect(view.transitions).toEqual([
      expect.objectContaining({ kind: 'trust', from: 'local', to: 'team', at: T1 }),
      expect.objectContaining({ kind: 'quarantine', from: 'false', to: 'true', at: T2 }),
      expect.objectContaining({ kind: 'lifecycle', from: 'active', to: 'superseded', at: T3 }),
    ]);
    expect(view.promotions).toEqual([
      expect.objectContaining({ to: 'team', actor: 'reviewer', at: T1 }),
    ]);
    expect(view.quarantines).toEqual([
      expect.objectContaining({ reason: 'evidence failed', at: T2 }),
    ]);
    expect(view.supersessions).toEqual([
      expect.objectContaining({ successor: 'mem:next', at: T3 }),
    ]);
  });

  it('audits by subject key and lists legacy aliases', () => {
    const { local, api } = setup();
    const a = v1Record({ claim: 'A.b does the thing' });
    const b = v1Record({ claim: 'A.b does another thing' });
    local.upsertEntries('active', [a, b]);
    const res = api.audit(SUBJECT);
    expect(res.found).toBe(true);
    expect(res.records.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    // after migration the twin carries the legacy binding
    local.migrateToV2({});
    const twinAudit = api.audit(a.id);
    expect(twinAudit.records[0]?.legacy[0]?.legacyId).toBe(a.id);
    expect(twinAudit.records[0]?.stamped?.trust).toBe('local');
  });

  it('reports not-found for an unknown key', () => {
    const { api } = setup();
    const res = api.audit('mem:missing');
    expect(res.found).toBe(false);
    expect(res.records).toEqual([]);
  });
});
