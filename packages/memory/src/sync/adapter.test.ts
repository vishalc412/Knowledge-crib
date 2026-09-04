import { mkdtempSync, rmSync } from 'node:fs';
/**
 * D6 adapter tests: the file backend (atomic put, list paging, probe, delete) and the generic http
 * blob contract against a local node:http server (PUT/GET/404/LIST/DELETE + the Authorization
 * header read at CALL time from process.env — never stored on the instance).
 */
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSyncObjectStore, HttpSyncObjectStore } from './adapter.js';

let dirs: string[] = [];
let server: Server | undefined;
let baseUrl = '';

const AUTH_ENV = 'KCRIB_SYNC_TEST_AUTH';

afterEach(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  delete process.env[AUTH_ENV];
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sync-adapter-'));
  dirs.push(d);
  return d;
}

/** A minimal in-memory blob server speaking exactly the D6 http contract. Records the
 *  Authorization headers it saw, and answers 500 for any key containing 'boom' (failure path). */
async function startBlobServer(): Promise<string[]> {
  const blobs = new Map<string, Uint8Array>();
  const authSeen: string[] = [];
  server = createServer((req, res) => {
    authSeen.push(req.headers.authorization ?? '(none)');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = decodeURIComponent(url.pathname.slice(1));
    if (key.includes('boom')) {
      res.writeHead(500).end('storage host exploded');
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        blobs.set(key, new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === 'GET') {
      if (url.searchParams.has('list')) {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys }));
        return;
      }
      const blob = blobs.get(key);
      if (blob === undefined) {
        res.writeHead(404).end('absent');
        return;
      }
      res.writeHead(200).end(Buffer.from(blob));
      return;
    }
    if (req.method === 'DELETE') {
      const existed = blobs.delete(key);
      if (!existed) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server!.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return authSeen;
}

describe('FileSyncObjectStore', () => {
  it('put/get round-trips bytes; an absent key reads as undefined', async () => {
    const store = new FileSyncObjectStore(tmpDir());
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await store.putObject('ev/abcd', bytes);
    expect(await store.getObject('ev/abcd')).toEqual(bytes);
    expect(await store.getObject('ev/missing')).toBeUndefined();
  });

  it('lists nested keys sorted (posix separators) and pages lexically via after/limit', async () => {
    const root = tmpDir();
    const store = new FileSyncObjectStore(root);
    for (const key of ['ev/b2', 'ev/a1', 'manifest.json', 'b/batch.json']) {
      await store.putObject(key, new TextEncoder().encode(key));
    }
    const all = await store.listObjects('');
    expect(all.keys).toEqual(['b/batch.json', 'ev/a1', 'ev/b2', 'manifest.json']);
    const evs = await store.listObjects('ev/');
    expect(evs.keys).toEqual(['ev/a1', 'ev/b2']);
    const page = await store.listObjects('', { limit: 2 });
    expect(page.keys).toEqual(['b/batch.json', 'ev/a1']);
    expect(page.nextAfter).toBe('ev/a1');
    const next = await store.listObjects('', { after: page.nextAfter, limit: 2 });
    expect(next.keys).toEqual(['ev/b2', 'manifest.json']);
    expect(next.nextAfter).toBeUndefined();
    expect(root).toBeTruthy();
  });

  it('probe reports writability; delete is idempotent', async () => {
    const root = tmpDir();
    const store = new FileSyncObjectStore(root);
    const probe = await store.probe();
    expect(probe.ok).toBe(true);
    expect(probe.backend).toBe('file');
    await store.putObject('gone', new Uint8Array([1]));
    await store.deleteObject('gone');
    await store.deleteObject('gone'); // 404-equivalent: still a success
    expect(await store.getObject('gone')).toBeUndefined();
  });

  it('rejects traversal keys for reads, writes, and deletes', async () => {
    const store = new FileSyncObjectStore(tmpDir());
    const escapedKey = '../outside-the-sync-root';

    await expect(store.getObject(escapedKey)).rejects.toThrow(
      'object key escapes the backend root',
    );
    await expect(store.putObject(escapedKey, new Uint8Array([1]))).rejects.toThrow(
      'object key escapes the backend root',
    );
    await expect(store.deleteObject(escapedKey)).rejects.toThrow(
      'object key escapes the backend root',
    );
  });
});

describe('HttpSyncObjectStore', () => {
  it('speaks the D6 blob contract: PUT/GET/DELETE/LIST + probe', async () => {
    await startBlobServer();
    const store = new HttpSyncObjectStore(baseUrl);
    const probe = await store.probe();
    expect(probe.ok).toBe(true);
    expect(probe.backend).toBe('http');
    const bytes = new Uint8Array([9, 8, 7]);
    await store.putObject('ev/aa', bytes);
    expect(await store.getObject('ev/aa')).toEqual(bytes);
    expect(await store.getObject('ev/absent')).toBeUndefined();
    const listed = await store.listObjects('ev/');
    expect(listed.keys).toEqual(['ev/aa']);
    await store.deleteObject('ev/aa');
    await store.deleteObject('ev/aa'); // 404 on delete is a success (idempotent)
    expect(await store.getObject('ev/aa')).toBeUndefined();
  });

  it('reads the Authorization header from env at CALL time (the instance stores nothing)', async () => {
    const authSeen = await startBlobServer();
    const store = new HttpSyncObjectStore(baseUrl, { authEnvName: AUTH_ENV });
    process.env[AUTH_ENV] = 'Bearer test-token-not-real';
    await store.putObject('ev/bb', new Uint8Array([1]));
    process.env[AUTH_ENV] = 'Bearer rotated-token';
    await store.putObject('ev/cc', new Uint8Array([2]));
    delete process.env[AUTH_ENV];
    await store.probe();
    // the header tracked the env AT EACH CALL — a rotation applies without rebuilding the store
    expect(authSeen[0]).toBe('Bearer test-token-not-real');
    expect(authSeen[1]).toBe('Bearer rotated-token');
  });

  it('throws SyncObjectStoreError with op/key/status on a server failure', async () => {
    await startBlobServer();
    const store = new HttpSyncObjectStore(baseUrl);
    await expect(store.getObject('boom')).rejects.toMatchObject({
      name: 'SyncObjectStoreError',
      status: 500,
    });
    // the thrown detail never carries the auth header value
    try {
      process.env[AUTH_ENV] = 'Bearer secret-value-never-echoed';
      await store.getObject('boom');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-value-never-echoed');
    } finally {
      delete process.env[AUTH_ENV];
    }
  });
});
