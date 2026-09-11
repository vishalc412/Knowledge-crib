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
  type MemoryAnchorPort,
  MemoryApi,
  type MemoryCandidate,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryScope,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  buildCaptureOutboxEntry,
  memoryCandidateId,
  memoryRecordId,
} from '@knowledge-crib/memory';
import {
  parseMemoryLedgerQuery,
  parseMemoryPendingQuery,
  parseResumeBody,
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
    expect(parseMemoryLedgerQuery(new URLSearchParams(''))).toEqual({ offset: 0, limit: 100 });
    expect(parseMemoryLedgerQuery(new URLSearchParams('limit=5000')).limit).toBe(200);
  });

  it('accepts a known group and rejects bad values with 400', () => {
    expect(parseMemoryLedgerQuery(new URLSearchParams('group=stale&offset=4&limit=2'))).toEqual({
      offset: 4,
      limit: 2,
      group: 'stale',
    });
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('group=nope'))).toThrow(VizHttpError);
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('offset=-1'))).toThrow(VizHttpError);
    expect(() => parseMemoryLedgerQuery(new URLSearchParams('limit=1.5'))).toThrow(VizHttpError);
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
});

describe('memory home endpoint', () => {
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
      expect(q.captures?.rows[0]?.command).toBe('crib memory distill --provider <name>');
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
