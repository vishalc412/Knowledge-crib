import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { ReaderFreshness } from '@knowledge-crib/mcp';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VizHttpError,
  VizMutationError,
  createCsrfToken,
  isAllowedHost,
  mutationErrorPayload,
  parseAdmissionBody,
  readVizNodeSource,
  resolveVizAsset,
} from './viz-server.js';

let root: string;
let outside: string;
let soul: SoulStore;

function sourceNode(file: string, start = 2, end = 3): Node {
  return {
    id: idFor({ kind: 'symbol', path: file, qualifiedName: 'demo.run', startLine: start }),
    kind: 'symbol',
    type: 'function',
    name: 'run',
    qualifiedName: 'demo.run',
    file,
    span: { start, end },
    lang: 'typescript',
    hash: contentHash(file),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-viz-source-'));
  outside = mkdtempSync(join(tmpdir(), 'crib-viz-outside-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  soul = new SoulStore(join(root, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('viz source endpoint helpers', () => {
  it('returns exact UTF-8 source span through indexed node id', async () => {
    writeFileSync(join(root, 'src', 'demo.ts'), 'zero\nconst café = 1;\nreturn café;\nlast\n');
    const node = sourceNode('src/demo.ts');
    soul.putNodes([node]);

    await expect(readVizNodeSource(soul, root, node.id)).resolves.toEqual({
      nodeId: node.id,
      file: 'src/demo.ts',
      span: { start: 2, end: 3 },
      excerpt: { start: 2, end: 3, text: 'const café = 1;\nreturn café;', truncated: false },
    });
  });

  it('rejects indexed traversal and symlink escape', async () => {
    writeFileSync(join(outside, 'secret.ts'), 'secret\n');
    // Platform-correct path that ESCAPES root: path.relative gives `../<outside>/secret.ts`
    // (posix) or `..\<outside>\secret.ts` (win32). The earlier `../${outside.split('/').pop()}`
    // form was posix-only — on win32 `outside` has backslashes so split('/').pop() returned the
    // whole `C:\Users\…` path, embedding a drive letter after `../` → resolve treated it as a
    // relative segment with a literal `C:` → nonexistent path → 404 (not the expected 403).
    const traversal = sourceNode(relative(root, join(outside, 'secret.ts')), 1, 1);
    soul.putNodes([traversal]);
    await expect(readVizNodeSource(soul, root, traversal.id)).rejects.toMatchObject({
      status: 403,
    });

    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'linked.ts'));
    const linked = sourceNode('src/linked.ts', 1, 1);
    soul.putNodes([linked]);
    await expect(readVizNodeSource(soul, root, linked.id)).rejects.toMatchObject({ status: 403 });
  });

  it('reports unavailable and missing source distinctly', async () => {
    const noLocation: Node = {
      id: 'sym:no-location',
      kind: 'symbol',
      hash: contentHash('none'),
    };
    soul.putNodes([noLocation]);
    await expect(readVizNodeSource(soul, root, noLocation.id)).rejects.toMatchObject({
      status: 422,
    });
    await expect(readVizNodeSource(soul, root, 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('caps long previews and reports deleted indexed files', async () => {
    writeFileSync(
      join(root, 'src', 'long.ts'),
      Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n'),
    );
    const long = sourceNode('src/long.ts', 1, 250);
    const deleted = sourceNode('src/deleted.ts', 1, 1);
    soul.putNodes([long, deleted]);

    const preview = await readVizNodeSource(soul, root, long.id);
    expect(preview.excerpt.start).toBe(1);
    expect(preview.excerpt.end).toBe(200);
    expect(preview.excerpt.text.split('\n')).toHaveLength(200);
    expect(preview.excerpt.truncated).toBe(true);
    await expect(readVizNodeSource(soul, root, deleted.id)).rejects.toMatchObject({ status: 404 });
  });

  it('contains static assets and rejects traversal', async () => {
    const assets = join(root, 'assets');
    mkdirSync(assets);
    writeFileSync(join(assets, 'index.html'), 'ok');
    writeFileSync(join(root, 'src', 'demo.ts'), 'outside asset root');
    // Compare via fs.promises.realpath on BOTH sides. resolveVizAsset returns
    // `await realpath(...)` (promise API); the earlier assertion compared it to realpathSync
    // (sync API). On win32 the two APIs canonicalize 8.3 short names differently (the GH Actions
    // `runneradmin` profile is registered as `RUNNER~1`): promises.realpath returns the long form
    // (`runneradmin`), realpathSync returns the short form (`RUNNER~1`) → Object.is mismatch even
    // though both resolve the SAME file. Funneling both through the promise API makes the
    // canonical form identical on every platform.
    const expectedAsset = await realpath(join(assets, 'index.html'));
    await expect(resolveVizAsset(assets, '/')).resolves.toBe(expectedAsset);
    await expect(resolveVizAsset(assets, '/../src/demo.ts')).rejects.toBeInstanceOf(VizHttpError);
    await expect(resolveVizAsset(assets, '/%2e%2e/src/demo.ts')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('isAllowedHost (DNS-rebinding guard)', () => {
  it('accepts loopback hosts with and without a port', () => {
    expect(isAllowedHost('127.0.0.1')).toBe(true);
    expect(isAllowedHost('127.0.0.1:3939')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('localhost:3939')).toBe(true);
    expect(isAllowedHost('[::1]')).toBe(true);
    expect(isAllowedHost('[::1]:3939')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowedHost('LOCALHOST:3939')).toBe(true);
    expect(isAllowedHost('127.0.0.1')).toBe(true);
  });

  it('rejects attacker-controlled and missing hosts', () => {
    expect(isAllowedHost('evil.example')).toBe(false);
    expect(isAllowedHost('evil.example:443')).toBe(false);
    expect(isAllowedHost('192.168.1.5')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
    expect(isAllowedHost('[::1')).toBe(false); // malformed bracket
  });
});

// ─── memory ledger endpoints (G5.4) ──────────────────────────────────────────
//
// The endpoints own NO projections: readMemoryLedger must return exactly what MemoryApi.ledger
// returns (the memory package tests pin that projection), and readMemoryLedgerDetail must be a
// pure get+audit composition. These tests pin the SERVER's contract: query validation (400s, the
// hard cap), the honest not-configured shape, and the lazy detail fetch.

import {
  type CaptureOutboxEntry,
  DEFAULT_MIGRATION_PRINCIPAL_ID,
  type MemoryAnchorPort,
  MemoryApi,
  type MemoryCandidate,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryScope,
  type MemorySoulPort,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  buildCaptureOutboxEntry,
  createGraphAssertion,
  decisionId,
  memoryCandidateId,
  memoryRecordId,
} from '@knowledge-crib/memory';
import {
  CONCERN_RECORDED_MESSAGE,
  MAX_CONCERN_REASON,
  type VizMemoryHomeOperations,
  graphRefKind,
  parseEvidenceQuery,
  parseFeedbackBody,
  parseMemoryLedgerQuery,
  parseMemoryPendingQuery,
  parseResumeBody,
  projectVizHealth,
  readMemoryEvidence,
  readMemoryGraphDetail,
  readMemoryHome,
  readMemoryIntakeDetail,
  readMemoryLedger,
  readMemoryLedgerDetail,
  readMemoryPending,
  readMutationBody,
  requireCsrfToken,
  validateMutationOrigin,
} from './viz-server.js';

const MEM_T0 = '2026-01-01T00:00:00.000Z';
const MEM_REPO = 'r-viz-ledger';
const MEM_LIVE = 'sym:src/demo.ts#demo.run@L2';

function memRecord(over: { subject?: string; claim?: string } = {}): MemoryRecord {
  const subject = over.subject ?? MEM_LIVE;
  const evidence: MemoryEvidence[] = [
    {
      kind: 'source-quote',
      verdict: 'valid',
      checkedAt: MEM_T0,
      soulId: subject,
      quote: 'runs',
      targetHash: 'blake3:abcd',
    },
  ];
  const input = {
    kind: 'fact' as const,
    subject,
    claim: over.claim ?? 'demo.run handles the request',
    scope: { boundary: 'repo' as const, repoId: MEM_REPO },
    appliesTo: [subject],
    evidence,
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1' as const,
    ...input,
    verdicts: {
      trust: 'local' as const,
      evidence: 'valid' as const,
      applicability: 'current' as const,
      lifecycle: 'active' as const,
    },
    createdAt: MEM_T0,
  };
}

function memApi(home: string): MemoryApi {
  const env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: undefined,
  };
  const local = MemoryStore.local(MEM_REPO, { env, now: () => MEM_T0 });
  local.upsertEntries('active', [memRecord()]);
  const live = {
    id: MEM_LIVE,
    kind: 'symbol',
    name: 'run',
    qualifiedName: 'demo.run',
    file: 'src/demo.ts',
    span: { start: 2, end: 3 },
    lang: 'typescript',
    hash: 'blake3:live',
  };
  return new MemoryApi({
    stores: { local },
    env,
    now: () => MEM_T0,
    soul: {
      getNode: (id: string) => (live.id === id ? live : undefined),
      allNodes: () => [live],
      rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
    } as unknown as MemoryAnchorPort,
  });
}

describe('parseMemoryLedgerQuery', () => {
  it('defaults the page and caps the limit', () => {
    expect(parseMemoryLedgerQuery(new URLSearchParams(''))).toEqual({
      offset: 0,
      limit: 100,
      revalidate: true,
    });
    expect(parseMemoryLedgerQuery(new URLSearchParams('limit=5000')).limit).toBe(200);
  });

  it('accepts a known group and rejects bad values with 400', () => {
    expect(parseMemoryLedgerQuery(new URLSearchParams('group=stale&offset=4&limit=2'))).toEqual({
      offset: 4,
      limit: 2,
      group: 'stale',
      revalidate: true,
    });
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('group=nope'))).toThrow(VizHttpError);
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('offset=-1'))).toThrow(VizHttpError);
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('limit=1.5'))).toThrow(VizHttpError);
  });

  // WP5 §7.1 Step B — the re-check is ON unless a caller explicitly turns it off. Asserted as a
  // DEFAULT and not merely as a flag, because the default is the entire fix: an absent param that
  // read the stamp would leave `/memory.json` reporting verdicts nobody checked, which is the silent
  // transition U1 is about. The opt-out stays available, and stays the minority case.
  it('re-checks evidence by default and only the literal "0" turns it off', () => {
    expect(parseMemoryLedgerQuery(new URLSearchParams('')).revalidate).toBe(true);
    expect(parseMemoryLedgerQuery(new URLSearchParams('revalidate=1')).revalidate).toBe(true);
    expect(parseMemoryLedgerQuery(new URLSearchParams('revalidate=0')).revalidate).toBe(false);
    // Not a falsy-string test: `revalidate=false` must NOT quietly mean "off", because a caller who
    // wrote that believes the opposite of what they would get.
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('revalidate=false'))).toThrow(
      VizHttpError,
    );
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('revalidate=maybe'))).toThrow(
      VizHttpError,
    );
  });

  it('accepts a working view and rejects unknown views or a view combined with a group', () => {
    expect(parseMemoryLedgerQuery(new URLSearchParams('view=needs-review&limit=50'))).toEqual({
      offset: 0,
      limit: 50,
      revalidate: true,
      view: 'needs-review',
    });
    expect(parseMemoryLedgerQuery(new URLSearchParams('view=active')).view).toBe('active');
    const status = (query: string) => {
      try {
        parseMemoryLedgerQuery(new URLSearchParams(query));
        return 200;
      } catch (err) {
        return err instanceof VizHttpError ? err.status : 500;
      }
    };
    expect(status('view=history')).toBe(400);
    expect(status('view=active&group=stale')).toBe(400);
    expect(status('view=needs-review&group=current')).toBe(400);
  });
});

describe('memory ledger endpoints', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crib-viz-memory-'));
    __resetMemoryLockGuardForTest();
  });

  afterEach(() => {
    __resetMemoryLockGuardForTest();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the honest not-wired shape when no memory api is bound', () => {
    expect(readMemoryLedger(undefined, parseMemoryLedgerQuery(new URLSearchParams('')))).toEqual({
      configured: false,
    });
  });

  it('serves the api projection verbatim — the server adds validation, never fields', () => {
    // The record anchors a live node, so it lands in `current`; the group filter narrows rows
    // while `counts` still covers the whole ledger.
    const result = readMemoryLedger(
      memApi(home),
      parseMemoryLedgerQuery(new URLSearchParams('group=current')),
    );
    expect(result.configured).toBe(true);
    if (!result.configured) return; // narrowing for the union
    expect(result.counts.current).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.subject).toBe(MEM_LIVE);
    expect(result.rows[0]?.group).toBe('current');
  });

  it('serves working views additively: views counts and typed review reasons on every row', () => {
    const api = memApi(home);
    const history = readMemoryLedger(api, parseMemoryLedgerQuery(new URLSearchParams('')));
    const active = readMemoryLedger(
      api,
      parseMemoryLedgerQuery(new URLSearchParams('view=active')),
    );
    if (!history.configured || !active.configured) throw new Error('memory not configured');
    expect(history.views).toEqual({ active: 1, needsReview: 0 });
    expect(active.total).toBe(history.views.active);
    expect(active.rows[0]?.reviewReasons).toEqual([]);
    // Existing History callers keep the unfiltered ledger and its group counts.
    expect(history.total).toBe(1);
    expect(history.counts.current).toBe(1);
  });

  it('composes detail from get + audit and 404s unknown ids', () => {
    const api = memApi(home);
    const record = memRecord();
    const detail = readMemoryLedgerDetail(api, record.id);
    expect(detail.found).toBe(true);
    expect(detail.id).toBe(record.id);
    expect(detail.verdicts?.lifecycle).toBe('active');
    expect(detail.audit.found).toBe(true);
    expect(detail.audit.requested).toBe(record.id);

    expect(() => readMemoryLedgerDetail(api, 'mem:nope')).toThrow(VizHttpError);
    try {
      readMemoryLedgerDetail(api, 'mem:nope');
    } catch (err) {
      expect((err as VizHttpError).status).toBe(404);
    }
  });

  // ─── WP5 §7.1 Step B — the route re-checks by default, and the route's default is the fix ────────
  //
  // `memApi` above wires NO evaluator, so the opt-in is inert there (T13's second case: both ports or
  // neither). This fixture wires the pair, against a node that EXISTS but no longer contains the
  // quoted text — so a read that actually re-checks overturns the stamp and one that does not reports
  // it as healthy. That asymmetry is the whole test.
  //
  // The point is not that `api.ledger({revalidate:true})` works — T13b pins that in the memory
  // package. It is that `/memory.json` gets it WITHOUT the caller asking, because the surface a person
  // opens to ask "why is my memory not answering" must not be the one surface that answers from a
  // stamp nobody checked. §7.4's exclusion panel renders `reasons`; this is what puts them there.

  it('re-checks the code by default, so an excluded row carries the evaluator’s reason', () => {
    const api = driftedApi(home);

    const served = readMemoryLedger(api, parseMemoryLedgerQuery(new URLSearchParams('')));
    expect(served.configured).toBe(true);
    if (!served.configured) return;
    const row = served.rows[0];
    if (!row) throw new Error('expected one row');

    // The stamp said healthy. The route did not take its word for it.
    expect(row.evidenceVerdict).toBe('invalid');
    expect(row.eligible).toBe(false);
    // The clause and the reason are the evaluator's own, not the server's copy of them.
    expect(row.excludedBy).toBe('evidence');
    expect(row.reasons).toContain('hash-drift');
    // §7.1's asymmetry, at the route: the row still reads `current` while being excluded from recall.
    // So the ONLY thing that tells an operator it is out is the panel built from these fields.
    expect(row.group).toBe('current');
    expect(served.counts.current).toBe(1);

    // The deliberate opt-out still exists and still reports the stamp — the cheap read is available,
    // it is simply not the default.
    const stamped = readMemoryLedger(
      api,
      parseMemoryLedgerQuery(new URLSearchParams('revalidate=0')),
    );
    expect(stamped.configured).toBe(true);
    if (!stamped.configured) return;
    expect(stamped.rows[0]?.evidenceVerdict).toBe('valid');
    expect(stamped.rows[0]?.eligible).toBe(true);
    expect(stamped.rows[0]?.excludedBy).toBeUndefined();
    expect(stamped.rows[0]?.reasons).toEqual([]);
  });

  // The seam between WP5 §7.1 and UI Phase 2: the working views read `eligible` and the evidence
  // verdict, which the default re-check can overturn. A home tile folded from stamps would count a
  // claim as Active while the list it opens — `/memory.json?view=…`, re-checked by default — files
  // it under Needs review. Each tile must equal the total of the view it opens, as that view is served.
  it('counts each home tile from the same re-checked verdicts its destination list is served with', () => {
    const api = driftedApi(home);
    const served = (view: string) => {
      const r = readMemoryLedger(api, parseMemoryLedgerQuery(new URLSearchParams(`view=${view}`)));
      if (!r.configured) throw new Error('memory not configured');
      return r.total;
    };
    const result = readMemoryHome(api, {});
    if (!result.configured) throw new Error('memory not configured');
    // The drifted claim is out of recall once re-checked: not Active, needs review.
    expect(served('active')).toBe(0);
    expect(served('needs-review')).toBe(1);
    expect(result.sections.active.count).toBe(served('active'));
    expect(result.sections.needsReview.count).toBe(served('needs-review'));
  });
});

/** A node that exists but no longer contains the quoted text, and a record that cites it. */
function driftedApi(home: string): MemoryApi {
  const env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: undefined,
  };
  const evidence: MemoryEvidence[] = [
    {
      kind: 'source-quote',
      verdict: 'valid',
      checkedAt: MEM_T0,
      soulId: MEM_LIVE,
      quote: 'the text that used to be here',
      // A well-formed hash that cannot equal the live node's — the schema pins the `blake3:<hex>`
      // shape, so the fixture has to be a real digest and not the word "stale".
      targetHash: `blake3:${'a'.repeat(64)}`,
    },
  ];
  const input = {
    kind: 'fact' as const,
    subject: MEM_LIVE,
    claim: 'demo.run handles the request',
    scope: { boundary: 'repo' as const, repoId: MEM_REPO },
    appliesTo: [MEM_LIVE],
    evidence,
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  const local = MemoryStore.local(MEM_REPO, { env, now: () => MEM_T0 });
  local.upsertEntries('active', [
    {
      id: memoryRecordId(input),
      schemaVersion: '1' as const,
      ...input,
      // Stamped healthy — the claim a fresh evaluation is allowed to overturn.
      verdicts: {
        trust: 'local' as const,
        evidence: 'valid' as const,
        applicability: 'current' as const,
        lifecycle: 'active' as const,
      },
      createdAt: MEM_T0,
    },
  ]);
  const live = {
    id: MEM_LIVE,
    kind: 'symbol',
    name: 'run',
    qualifiedName: 'demo.run',
    file: 'src/demo.ts',
    span: { start: 2, end: 3 },
    lang: 'typescript',
    // Differs from the evidence's `targetHash` → drift, never a clean grounding.
    hash: 'blake3:live',
  };
  const soul = {
    getNode: (id: string) => (live.id === id ? live : undefined),
    allNodes: () => [live],
    // The rehydrated span does NOT contain the cited quote, so source-quote revalidation fails.
    rehydrate: () => ({
      text: 'return value;',
      truncated: false,
      totalLines: 1,
      startLine: 2,
    }),
    findByLocator: () => [],
  } as unknown as MemoryAnchorPort;
  return new MemoryApi({
    stores: { local },
    env,
    now: () => MEM_T0,
    soul,
    evaluator: new MemoryEvaluator(),
    evalCtx: { soul: soul as unknown as MemorySoulPort },
  });
}

describe('record connections endpoint (WP-G7)', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crib-viz-graph-'));
    __resetMemoryLockGuardForTest();
  });

  afterEach(() => {
    __resetMemoryLockGuardForTest();
    rmSync(home, { recursive: true, force: true });
  });

  function edge(
    predicate: 'about' | 'supersedes' | 'applies-to',
    subject: string,
    object: string,
    supporter: string,
    principalId = DEFAULT_MIGRATION_PRINCIPAL_ID,
  ) {
    return createGraphAssertion({
      predicate,
      subject,
      object,
      namespace: { principalId },
      scope: { boundary: 'global' },
      validAt: MEM_T0,
      knownAt: MEM_T0,
      supportedBy: [supporter],
      provenance: { principalId, deviceId: 'device:viz', actorId: 'agent:viz', clientId: 'vitest' },
    });
  }

  it('answers configured:false without a memory api', () => {
    expect(readMemoryGraphDetail(undefined, 'mem:x')).toEqual({ configured: false });
  });

  it('lists authorized connections, history, replacements and linked work — never foreign edges', () => {
    const env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
    const api = memApi(home);
    const record = memRecord();
    const retired = memRecord({ claim: 'demo.run used to retry forever' });
    const local = MemoryStore.local(MEM_REPO, { env, now: () => MEM_T0 });
    local.upsertEntries('active', [retired]);
    const supersede = {
      kind: 'supersede' as const,
      subject: retired.id,
      successor: record.id,
      actor: 'human:op',
    };
    local.upsertEntry('decisions', {
      id: decisionId(supersede),
      schemaVersion: '1',
      ...supersede,
      ts: MEM_T0,
    });
    const about = edge('about', record.id, MEM_LIVE, record.id);
    const work = edge('about', 'intake:abc', record.id, record.id);
    const replaced = edge('supersedes', record.id, retired.id, record.id);
    const old = edge('applies-to', record.id, 'sym:src/demo.ts#demo.legacy', retired.id);
    const foreign = edge('about', record.id, 'topic:beta-secret', record.id, 'principal:beta');
    local.submitGraphEntries([about, work, replaced, old, foreign]);

    const body = readMemoryGraphDetail(api, record.id);
    expect(body.configured).toBe(true);
    if (!body.configured) return;
    expect(body.state).toBe('current');
    expect(body.connections.map((c) => [c.predicate, c.direction, c.ref, c.kind]).sort()).toEqual(
      [
        ['about', 'incoming', 'intake:abc', 'work'],
        ['about', 'outgoing', MEM_LIVE, 'code'],
        ['supersedes', 'outgoing', retired.id, 'claim'],
      ].sort(),
    );
    expect(body.history.map((h) => h.assertionId)).toEqual([old.id]);
    expect(body.replaces).toEqual([retired.id]);
    expect(body.replacedBy).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('beta');

    const retiredBody = readMemoryGraphDetail(api, retired.id);
    if (!retiredBody.configured) throw new Error('expected configured');
    expect(retiredBody.state).toBe('historical');
    expect(retiredBody.replacedBy).toEqual([record.id]);
  });

  it('names ref kinds from the id grammar', () => {
    expect(graphRefKind('mem:a')).toBe('claim');
    expect(graphRefKind('intake:a')).toBe('work');
    expect(graphRefKind('sym:a')).toBe('code');
    expect(graphRefKind('entity:a')).toBe('entity');
    expect(graphRefKind('rcpt:a')).toBe('evidence');
    expect(graphRefKind('topic:a')).toBe('topic');
    expect(graphRefKind('x:a')).toBe('other');
  });
});

describe('memory home endpoint', () => {
  it('reports the published revision independently from the loaded reader snapshot', () => {
    const currentHead = 'a'.repeat(40);
    const oldHead = 'b'.repeat(40);
    const cold = {
      indexedHead: currentHead,
      currentHead,
      publishedGeneration: null,
      readerGeneration: null,
      graphSourcePosition: null,
      codeRevision: currentHead,
      graphGeneration: null,
      searchGeneration: null,
      refreshState: 'idle',
      stale: false,
      staleReasons: [],
      lastSuccessfulRefreshAt: '2026-09-22T10:00:00.000Z',
      lastRefreshError: null,
    } satisfies ReaderFreshness;
    const result = projectVizHealth(
      {
        behindHead: false,
        lastKnownGood: {
          head: currentHead,
          publishedAt: '2026-09-22T10:00:00.000Z',
        },
      },
      cold,
      { head: oldHead, lastSuccessfulAt: '2026-09-21T09:00:00.000Z' },
    );
    expect(result.codeIndex).toMatchObject({
      checkedRevision: currentHead,
      lastSuccessfulAt: '2026-09-22T10:00:00.000Z',
      behindHead: false,
    });
    expect(result.readerFreshness).toMatchObject({
      indexedHead: oldHead,
      stale: true,
      lastSuccessfulRefreshAt: '2026-09-21T09:00:00.000Z',
    });
  });

  it('projects lifecycle sections and independent health signals', () => {
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-home-'));
    try {
      const result = readMemoryHome(memApi(home), {
        retrieval: { mode: 'on-device-semantic', modelId: 'intfloat/multilingual-e5-large' },
        capture: { lastSuccessfulAt: MEM_T0 },
        codeIndex: { lastSuccessfulAt: MEM_T0, behindHead: false },
        sync: { configured: false },
        // WP4.7 — the viz process's (cold) reader freshness passes through to the home view
        // verbatim, so the operator can see whether the graph they are browsing matches the tree.
        readerFreshness: {
          indexedHead: 'a'.repeat(40),
          currentHead: 'a'.repeat(40),
          publishedGeneration: null,
          readerGeneration: null,
          graphSourcePosition: null,
          codeRevision: null,
          graphGeneration: null,
          searchGeneration: null,
          refreshState: 'idle',
          stale: false,
          staleReasons: [],
          lastSuccessfulRefreshAt: MEM_T0,
          lastRefreshError: null,
        } satisfies ReaderFreshness,
      });
      expect(result).toMatchObject({
        configured: true,
        sections: {
          active: { count: 1 },
          pending: { count: 0 },
          needsReview: { count: 0 },
          history: { count: 1 },
          resume: { count: 0 },
        },
        health: {
          retrieval: { mode: 'on-device-semantic' },
          sync: { configured: false },
          readerFreshness: { refreshState: 'idle', stale: false, staleReasons: [] },
        },
      });
      expect(result.nextAction.toLowerCase()).toContain('capture');
      // Every tile count is the total of the ledger view the tile opens.
      const api = memApi(home);
      if (!result.configured) throw new Error('memory not configured');
      expect(result.sections.active.count).toBe(api.ledger({ view: 'active' }).total);
      expect(result.sections.needsReview.count).toBe(api.ledger({ view: 'needs-review' }).total);
      expect(result.sections.history.count).toBe(api.ledger().total);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // ─── WP5 §7.3 / T12 — the recovery ladder reaches every state U3 names ──────────
  //
  // U3 names states a person is meant to be able to REPAIR: a stale index, an unavailable model,
  // blocked extraction, failed persistence. The endpoint received `health` and never read it, so
  // each one was DISPLAYED in a tile while the one line that says what to do about it ignored them
  // — a dashboard that reports a fault and cannot name a step. §7.3 made the ladder consult
  // `health`; T12 pins that it still does.
  //
  // The assertions are about the COMMAND named, not the sentence around it: the wording may
  // improve, the reachable-without-extra-setup property may not (§4.3 — the old pending hint named
  // `crib memory distill --provider <name>`, an LLM provider nobody had configured).

  it('gives a repairable step for each U3 state, and never calls a broken state "nothing needs you"', () => {
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-home-ladder-'));
    try {
      const api = memApi(home);
      // One active claim, one history entry, no captures: the ONLY thing that can give the ladder a
      // reason to speak is the health state under test.
      const healthy: VizMemoryHomeOperations = {
        retrieval: { mode: 'on-device-semantic', modelId: 'intfloat/multilingual-e5-large' },
        capture: { lastSuccessfulAt: MEM_T0 },
        codeIndex: { lastSuccessfulAt: MEM_T0, behindHead: false },
        sync: { configured: false },
      };
      const stepFor = (health: VizMemoryHomeOperations) => readMemoryHome(api, health).nextAction;

      // The control. Without it the test could pass by making EVERY state emit a step, which would
      // be a different defect (an operator nagged on a healthy repository) rather than a fix.
      expect(stepFor(healthy)).toContain('Nothing needs you');

      const deadLetter: VizMemoryHomeOperations = {
        ...healthy,
        capture: { lastSuccessfulAt: MEM_T0, pending: 0, dead: 2 },
      };
      const staleIndex: VizMemoryHomeOperations = {
        ...healthy,
        codeIndex: { lastSuccessfulAt: MEM_T0, behindHead: true },
      };
      const noModel: VizMemoryHomeOperations = {
        ...healthy,
        retrieval: { mode: 'lexical-fallback', reason: 'installed tier is missing' },
      };

      const cases: Array<[string, VizMemoryHomeOperations, string]> = [
        ['blocked extraction / failed persistence', deadLetter, 'memory_observe'],
        ['a stale code index', staleIndex, 'crib update'],
        ['an unavailable on-device model', noModel, 'crib embed status'],
      ];
      for (const [state, health, named] of cases) {
        const step = stepFor(health);
        expect(step, state).toBeTruthy();
        expect(step, state).toContain(named);
        // §4.2 — a condition that needs repair must never be dressed as an all-clear.
        expect(step, state).not.toContain('Nothing needs you');
      }

      // §4.2 again, from the other side: the step must carry the REASON the tile shows, or the
      // operator is told to repair something with no account of what actually broke.
      expect(stepFor(noModel)).toContain('installed tier is missing');

      // The tile the ladder reads is the tile the operator sees — one `health` object, passed
      // through verbatim, so a count can never steer a step the page does not display.
      expect(readMemoryHome(api, deadLetter)).toMatchObject({
        health: { capture: { lastSuccessfulAt: MEM_T0, pending: 0, dead: 2 } },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('binds a repair line to each health tile, and only where the tile reports a fault', () => {
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-home-recovery-'));
    try {
      const api = memApi(home);
      const base: VizMemoryHomeOperations = {
        retrieval: { mode: 'on-device-semantic', modelId: 'intfloat/multilingual-e5-large' },
        capture: { lastSuccessfulAt: MEM_T0, pending: 0, dead: 0 },
        codeIndex: { lastSuccessfulAt: MEM_T0, behindHead: false },
        sync: { configured: false },
      };
      // A healthy home carries NO lines at all. This is the half that keeps the feature honest: a
      // tile that always has something to say trains the operator to ignore all of them, and a
      // reassurance the server did not measure is exactly the fabrication §4.2 forbids.
      expect(readMemoryHome(api, base)).toMatchObject({ recovery: {} });

      const broken: VizMemoryHomeOperations = {
        ...base,
        retrieval: { mode: 'lexical-fallback', reason: 'installed tier is missing' },
        capture: { lastSuccessfulAt: MEM_T0, pending: 0, dead: 3 },
        codeIndex: { lastSuccessfulAt: MEM_T0, behindHead: true },
      };
      // One line per faulted tile, each naming a real step — not "healthy"/"ok" filler, and not a
      // single general line copied across tiles (which would leave "what do I do about THIS?" open).
      expect(readMemoryHome(api, broken)).toMatchObject({
        recovery: {
          capture: expect.stringContaining('memory_observe'),
          codeIndex: expect.stringContaining('crib update'),
          retrieval: expect.stringContaining('crib embed status'),
        },
      });

      // Dead letters outrank waiting ones in the capture tile for the same reason they outrank the
      // pending branch in the ladder: a waiting capture still has an automatic path.
      const deadAndWaiting: VizMemoryHomeOperations = {
        ...base,
        capture: { lastSuccessfulAt: MEM_T0, pending: 4, dead: 1 },
      };
      const recovery = readMemoryHome(api, deadAndWaiting);
      if (!recovery.configured) throw new Error('expected configured');
      expect(recovery.recovery.capture).toContain('dead letters');
      expect(recovery.recovery.capture).not.toContain('Re-check');

      // A waiting capture with nothing dead still gets its line — the tile is not silent just
      // because the worst case is absent.
      const waitingOnly: VizMemoryHomeOperations = {
        ...base,
        capture: { lastSuccessfulAt: MEM_T0, pending: 4, dead: 0 },
      };
      const waiting = readMemoryHome(api, waitingOnly);
      if (!waiting.configured) throw new Error('expected configured');
      expect(waiting.recovery.capture).toContain('Re-check');

      // `sync` has no line and cannot have one: nothing populates its pending/dead counts, so its
      // only reachable states are `local only` and `configured; no run yet`, neither a fault.
      // Pinned so a future repair line for it has to arrive with a real signal behind it.
      expect(Object.keys(recovery.recovery)).not.toContain('sync');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ranks a repair state above routine work when both are present', () => {
    // The priority order the ladder's comment claims: a state that means "the material you are
    // about to act on may be wrong or missing" speaks BEFORE work that is merely waiting. Pinned
    // here so a future reorder is a deliberate change with a failing test, not a silent shuffle.
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-home-priority-'));
    try {
      // This API genuinely holds one pending capture, so the routine branch is live and losing.
      const api = pendingApi(home);
      const step = readMemoryHome(api, {
        capture: { lastSuccessfulAt: MEM_T0, pending: 1, dead: 1 },
        codeIndex: { lastSuccessfulAt: MEM_T0, behindHead: true },
      }).nextAction;
      // Dead letters outrank a stale index: the index can be caught up automatically, a dead
      // capture cannot, and only a person can decide whether the learning is still worth keeping.
      expect(step).toContain('memory_observe');
      expect(step).not.toContain('crib update');
      expect(step).not.toContain('Nothing needs you');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns an honest not-configured shape', () => {
    expect(readMemoryHome(undefined, {})).toEqual({
      configured: false,
      nextAction: 'Run `crib memory init` to configure memory for this repository.',
    });
  });
});

// ─── pending queue + intake detail endpoints (WP6.1–WP6.4) ─────────────────────
//
// Same law as the ledger tests: the endpoints own NO projections. readMemoryPending must return
// exactly what MemoryApi.pending returns (the memory package tests pin the classification), and
// readMemoryIntakeDetail must be a pure getIntake+listIntakes composition. These tests pin the
// SERVER's contract: query validation, the hard cap, the honest not-configured shape, the 404,
// and the resumable fold that gates which intakes the UI may offer resume actions for.

const MEM_SCOPE: MemoryScope = { boundary: 'repo', repoId: MEM_REPO };

function stagedCandidate(
  over: { claim?: string; evidence?: MemoryEvidence[] } = {},
): MemoryCandidate {
  const seed = {
    kind: 'fact' as const,
    subject: MEM_LIVE,
    claim: over.claim ?? 'demo.run normalizes input before hashing',
    scope: MEM_SCOPE,
    appliesTo: [MEM_LIVE],
    evidence: over.evidence ?? [],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
    origin: 'observe' as const,
  };
  const candidate: MemoryCandidate = {
    ...seed,
    id: memoryCandidateId(seed),
    schemaVersion: '1',
    proposedAt: MEM_T0,
  };
  return candidate;
}

/** An API whose local store holds one pending capture, one ready staged claim, and one intake. */
function pendingApi(home: string): MemoryApi {
  const env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: undefined,
  };
  const local = MemoryStore.local(MEM_REPO, { env, now: () => MEM_T0 });
  local.upsertEntries('active', [memRecord()]);
  const capture: CaptureOutboxEntry = buildCaptureOutboxEntry(
    {
      kind: 'fact',
      subject: MEM_LIVE,
      claim: 'demo.run hashes before writing',
      scope: MEM_SCOPE,
      appliesTo: [MEM_LIVE],
      evidence: [],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
      origin: 'observe',
    },
    MEM_T0,
  );
  local.upsertEntry('outbox', capture);
  const evidence: MemoryEvidence[] = [
    {
      kind: 'source-quote',
      verdict: 'valid',
      checkedAt: MEM_T0,
      soulId: MEM_LIVE,
      quote: 'normalizes input',
      targetHash: 'blake3:abcd',
    },
  ];
  local.upsertEntry('candidates', stagedCandidate({ evidence }));
  const api = new MemoryApi({
    stores: { local },
    env,
    now: () => MEM_T0,
    soul: {
      getNode: () => undefined,
      allNodes: () => [],
      rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
    } as unknown as MemoryAnchorPort,
  });
  return api;
}

function intakeApi(home: string): MemoryApi {
  const env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: undefined,
  };
  const local = MemoryStore.local(`${MEM_REPO}-intake`, { env, now: () => MEM_T0 });
  const api = new MemoryApi({
    stores: { local },
    env,
    now: () => MEM_T0,
    soul: {
      getNode: () => undefined,
      allNodes: () => [],
      rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
    } as unknown as MemoryAnchorPort,
  });
  return api;
}

describe('parseMemoryPendingQuery', () => {
  it('defaults the page and caps the limit', () => {
    expect(parseMemoryPendingQuery(new URLSearchParams(''))).toEqual({ offset: 0, limit: 100 });
    expect(parseMemoryPendingQuery(new URLSearchParams('limit=5000')).limit).toBe(200);
    expect(parseMemoryPendingQuery(new URLSearchParams('section=staged'))).toEqual({
      offset: 0,
      limit: 100,
      section: 'staged',
    });
  });

  it('rejects bad values loudly, never silently clamping', () => {
    expect(() => parseMemoryPendingQuery(new URLSearchParams('section=nope'))).toThrow(
      VizHttpError,
    );
    expect(() => parseMemoryPendingQuery(new URLSearchParams('offset=-1'))).toThrow(VizHttpError);
    expect(() => parseMemoryPendingQuery(new URLSearchParams('limit=2.5'))).toThrow(VizHttpError);
    try {
      parseMemoryPendingQuery(new URLSearchParams('section=nope'));
    } catch (err) {
      expect((err as VizHttpError).status).toBe(400);
    }
  });
});

describe('memory pending queue endpoint', () => {
  beforeEach(() => __resetMemoryLockGuardForTest());
  afterEach(() => __resetMemoryLockGuardForTest());

  it('returns an honest not-configured shape when no memory is wired', () => {
    expect(readMemoryPending(undefined, parseMemoryPendingQuery(new URLSearchParams('')))).toEqual({
      configured: false,
    });
  });

  it('serves the two sections with whole-queue counts, banned-word-free', () => {
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-pending-'));
    try {
      const api = pendingApi(home);
      const q = readMemoryPending(api, parseMemoryPendingQuery(new URLSearchParams('')));
      // the configured literal discriminates the union — after this guard the queue is narrowed
      if (!q.configured) throw new Error('expected a configured pending queue');
      expect(q.counts).toEqual({ captures: 1, staged: 1, ready: 1, terminal: 0, blocked: 0 });
      expect(q.captures?.rows[0]?.command).toBe('crib memory recheck');
      expect(q.staged?.rows[0]?.standing).toBe('ready');
      // section filter narrows rows but never hides counts
      const staged = readMemoryPending(
        api,
        parseMemoryPendingQuery(new URLSearchParams('section=staged')),
      );
      if (!staged.configured) throw new Error('expected a configured pending queue');
      expect(staged.captures).toBeUndefined();
      expect(staged.counts.captures).toBe(1);
      // the Gate-0 vocabulary law holds on the wire payload, commands included
      expect(JSON.stringify(q)).not.toMatch(/candidate|trust/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('memory intake detail endpoint', () => {
  beforeEach(() => __resetMemoryLockGuardForTest());
  afterEach(() => __resetMemoryLockGuardForTest());

  it('serves requirement + checkpoint history + folded brief, and marks non-resumable work', () => {
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-intake-'));
    try {
      const api = intakeApi(home);
      const requirement = api.createIntake({
        namespace: { principalId: 'principal:local' },
        original: 'Ship the WP6 read side',
        interpretation: {
          outcome: 'Pending queue and intake detail endpoints',
          scope: ['packages/cli/src/viz-server.ts'],
          constraints: ['no browser-side admission logic'],
          acceptanceCriteria: ['endpoint tests pass'],
        },
        sensitivity: 'internal',
        retentionPolicyId: 'default',
        provenance: {
          principalId: 'principal:local',
          deviceId: 'device-1',
          actorId: 'claude-code',
          clientId: 'claude-code',
        },
        createdAt: MEM_T0,
      });
      api.checkpointIntake({
        intakeId: requirement.id,
        kind: 'progress',
        phase: 'executing',
        nextSafeAction: 'write the endpoint tests',
        summary: 'helpers landed',
        repository: { dirty: false },
        actor: 'claude-code',
        recordedAt: MEM_T0,
      });
      const detail = readMemoryIntakeDetail(api, requirement.id, { dirty: false });
      expect(detail.requirement.id).toBe(requirement.id);
      expect(detail.requirement.original).toBe('Ship the WP6 read side');
      expect(detail.checkpoints).toHaveLength(1);
      expect(detail.checkpoints[0]?.kind).toBe('progress');
      expect(detail.brief.intakeId).toBe(requirement.id);
      expect(detail.brief.status).toBe('active');
      // WP6.4 — resumable gates the UI's resume actions; nothing here executes the work
      expect(detail.resumable).toBe(true);

      // a completed intake stays readable (History) but is never offered for resume. The terminal
      // checkpoint must be the LATEST event — the projection folds status from it.
      api.checkpointIntake({
        intakeId: requirement.id,
        kind: 'completed',
        phase: 'complete',
        summary: 'done',
        repository: { dirty: false },
        actor: 'claude-code',
        recordedAt: '2026-01-02T00:00:00.000Z',
      });
      const done = readMemoryIntakeDetail(api, requirement.id, { dirty: false });
      expect(done.checkpoints).toHaveLength(2);
      expect(done.resumable).toBe(false);
      expect(done.brief.status).toBe('completed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('404s on unknown intake ids', () => {
    const home = mkdtempSync(join(tmpdir(), 'crib-viz-intake-'));
    try {
      const api = intakeApi(home);
      expect(() => readMemoryIntakeDetail(api, 'in:nope')).toThrow(VizHttpError);
      try {
        readMemoryIntakeDetail(api, 'in:nope');
      } catch (err) {
        expect((err as VizHttpError).status).toBe(404);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('mutation boundary helpers (WP6.5)', () => {
  it('accepts only the server own loopback origin, 403 otherwise', () => {
    expect(() =>
      validateMutationOrigin({ host: '127.0.0.1:7331', origin: 'http://127.0.0.1:7331' }),
    ).not.toThrow();
    expect(() =>
      validateMutationOrigin({ host: '127.0.0.1:7331', origin: 'http://evil.example' }),
    ).toThrow(VizMutationError);
    expect(() => validateMutationOrigin({ host: '127.0.0.1:7331' })).toThrow(VizMutationError);
    try {
      validateMutationOrigin({ host: '127.0.0.1:7331', origin: 'http://localhost:7331' });
      expect.unreachable('a different origin must be refused');
    } catch (err) {
      expect((err as VizMutationError).status).toBe(403);
      expect((err as VizMutationError).code).toBe('unauthorized');
    }
  });

  it('requires the per-server CSRF token, 403 on absent or wrong', () => {
    const token = createCsrfToken();
    expect(() => requireCsrfToken(token, token)).not.toThrow();
    for (const bad of [undefined, '', 'nope', token.slice(0, 63)]) {
      expect(() => requireCsrfToken(bad, token)).toThrow(VizMutationError);
    }
    try {
      requireCsrfToken('nope', token);
    } catch (err) {
      expect((err as VizMutationError).status).toBe(403);
      // the failure message never contains the token value (no secrets in logs)
      expect((err as VizMutationError).message).not.toContain(token);
    }
  });

  it('mints a fresh 64-hex token per call (rotated on server restart)', () => {
    const a = createCsrfToken();
    const b = createCsrfToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('reads one bounded JSON body: 413 oversize, 400 non-JSON, 400 empty', async () => {
    const req = Readable.from([Buffer.from('{"id":"cand:x","profile":"p"}')]);
    expect(await readMutationBody(req)).toEqual({ id: 'cand:x', profile: 'p' });
    await expect(readMutationBody(Readable.from([Buffer.from('not json')]))).rejects.toThrow(
      VizMutationError,
    );
    await expect(readMutationBody(Readable.from([]))).rejects.toThrow(VizMutationError);
    await expect(readMutationBody(Readable.from([Buffer.alloc(70_000, 'a')]))).rejects.toThrow(
      VizMutationError,
    );
    try {
      await readMutationBody(Readable.from([Buffer.alloc(70_000, 'a')]));
      expect.unreachable('an oversize body must be refused');
    } catch (err) {
      expect((err as VizMutationError).status).toBe(413);
      expect((err as VizMutationError).code).toBe('payload-too-large');
    }
  });

  it('parses an admission body: staged ids only, profile required', () => {
    expect(parseAdmissionBody({ id: 'cand:abc', profile: 'ci' })).toEqual({
      id: 'cand:abc',
      profile: 'ci',
    });
    for (const bad of [
      {},
      { id: 'mem:abc', profile: 'ci' },
      { id: 'cand:abc' },
      { id: '', profile: 'ci' },
      { id: 'cand:abc', profile: '' },
      { id: `cand:${'x'.repeat(3000)}`, profile: 'ci' },
      [],
      'nope',
    ]) {
      expect(() => parseAdmissionBody(bad)).toThrow(VizMutationError);
    }
  });

  it('parses a resume body: empty expectedCheckpointId means "never checkpointed"', () => {
    expect(parseResumeBody({ intakeId: 'in:1', expectedCheckpointId: 'ck:9' })).toEqual({
      intakeId: 'in:1',
      expectedCheckpointId: 'ck:9',
    });
    expect(
      parseResumeBody({ intakeId: 'in:1', expectedCheckpointId: '', next: '  do it  ' }),
    ).toEqual({ intakeId: 'in:1', next: '  do it  ', expectedCheckpointId: '' });
    for (const bad of [
      {},
      { expectedCheckpointId: 'ck:9' },
      { intakeId: '', expectedCheckpointId: '' },
      { intakeId: 'in:1', expectedCheckpointId: 5 },
    ]) {
      expect(() => parseResumeBody(bad)).toThrow(VizMutationError);
    }
  });

  it('serializes structured errors with a code, and no banned words on the wire', () => {
    const fromMutation = mutationErrorPayload(
      new VizMutationError('invalid-evidence', 422, 'not admissible yet'),
    );
    expect(fromMutation).toEqual({
      error: { code: 'invalid-evidence', message: 'not admissible yet' },
    });
    // a non-mutation error reaching a mutation route collapses to `internal`, shape stays
    const fromPlain = mutationErrorPayload(new VizHttpError(500, 'boom'));
    expect(fromPlain.error.code).toBe('internal');
    expect(fromPlain.error.message).toBe('boom');
    // vocabulary law: no internal admission words anywhere on the mutation error surface
    expect(JSON.stringify(fromMutation)).not.toMatch(/candidate|trust/i);
    expect(JSON.stringify(fromPlain)).not.toMatch(/candidate|trust/i);
  });
});

// ─── evidence inspection + concern reporting (UI remediation Phase 4) ─────────

describe('evidence and concern request parsing', () => {
  it('accepts a record id and a non-negative integer index, never a path', () => {
    expect(parseEvidenceQuery(new URLSearchParams('recordId=mem:a&index=2'))).toEqual({
      recordId: 'mem:a',
      index: 2,
    });
    for (const bad of [
      'recordId=mem:a',
      'index=0',
      'recordId=mem:a&index=-1',
      'recordId=mem:a&index=1.5',
      'recordId=mem:a&index=x',
    ]) {
      expect(() => parseEvidenceQuery(new URLSearchParams(bad))).toThrow(VizHttpError);
    }
  });

  it('requires a nonblank reason of at most 500 characters and ignores any client actor', () => {
    expect(
      parseFeedbackBody({ recordId: 'mem:a', reason: '  wrong since v2  ', actor: 'human:spoof' }),
    ).toEqual({
      recordId: 'mem:a',
      reason: 'wrong since v2',
    });
    expect(() => parseFeedbackBody({ recordId: 'mem:a', reason: '   ' })).toThrow(
      /reason is required/,
    );
    expect(() => parseFeedbackBody({ recordId: 'mem:a' })).toThrow(/reason is required/);
    expect(() =>
      parseFeedbackBody({ recordId: 'mem:a', reason: 'x'.repeat(MAX_CONCERN_REASON + 1) }),
    ).toThrow(/at most 500/);
    expect(() => parseFeedbackBody({ reason: 'x' })).toThrow(VizMutationError);
    expect(CONCERN_RECORDED_MESSAGE).toBe(
      'Recorded for review; this does not automatically retract or quarantine the claim.',
    );
  });
});

describe('readMemoryEvidence', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crib-viz-evidence-'));
    __resetMemoryLockGuardForTest();
  });
  afterEach(() => {
    __resetMemoryLockGuardForTest();
    rmSync(home, { recursive: true, force: true });
  });

  it('shows the saved quote beside a current excerpt read by indexed node id', async () => {
    writeFileSync(join(root, 'src', 'demo.ts'), 'zero\nexport function run() {\n  return 1;\n}\n');
    const node = sourceNode('src/demo.ts');
    expect(node.id).toBe(MEM_LIVE);
    soul.putNodes([node]);
    const record = memRecord();
    const inspected = await readMemoryEvidence(memApi(home), soul, root, {
      recordId: record.id,
      index: 0,
    });
    expect(inspected.kind).toBe('source-quote');
    expect(inspected.detail).toMatchObject({
      kind: 'source-quote',
      location: { state: 'current' },
    });
    expect(inspected.current).toMatchObject({
      status: 'ready',
      file: 'src/demo.ts',
      excerpt: { text: 'export function run() {\n  return 1;' },
    });
  });

  it('explains an unreadable source instead of presenting the saved quote as current', async () => {
    const record = memRecord();
    // The index knows the node, but this checkout has no file behind it.
    const inspected = await readMemoryEvidence(memApi(home), soul, root, {
      recordId: record.id,
      index: 0,
    });
    expect(inspected.current).toMatchObject({ status: 'unavailable' });
  });

  it('answers 404 for a missing record or index without saying which', async () => {
    const record = memRecord();
    const status = async (recordId: string, index: number) => {
      try {
        await readMemoryEvidence(memApi(home), soul, root, { recordId, index });
        return 200;
      } catch (err) {
        return err instanceof VizHttpError ? `${err.status} ${err.message}` : 'other';
      }
    };
    expect(await status(record.id, 9)).toBe('404 evidence not found');
    expect(await status('mem:missing', 0)).toBe('404 evidence not found');
  });
});
