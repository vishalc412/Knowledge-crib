import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VizHttpError, isAllowedHost, readVizNodeSource, resolveVizAsset } from './viz-server.js';

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
  type MemoryAnchorPort,
  MemoryApi,
  type MemoryEvidence,
  type MemoryRecord,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  memoryRecordId,
} from '@knowledge-crib/memory';
import {
  parseMemoryLedgerQuery,
  readMemoryHome,
  readMemoryLedger,
  readMemoryLedgerDetail,
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
