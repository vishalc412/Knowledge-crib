/**
 * F14 (docs/audits/2026-09-05) — the optional shared HTTP daemon's request boundary.
 *
 * The audit POSTed a JSON-RPC `initialize` to `crib serve --http` carrying
 * `Host: audit-untrusted.example` / `Origin: https://audit-untrusted.example` and got HTTP 200 with
 * a full server handshake. The daemon binds to loopback, so a foreign Host means the request
 * arrived through a name that RESOLVES to loopback — DNS rebinding — which is how a browser page
 * reaches a local daemon "same-origin". The unit tests below pin the header decision; the
 * end-to-end test drives the real server and replays the audit's exact request.
 *
 * Scope note, deliberately narrow: this is a LOCALITY boundary, not authorization. It does not
 * identify which local user is calling, and `verbs` remains shared across requests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_HTTP_REQUEST_BYTES, isAllowedHttpCaller, serveHttp } from './server.js';
import { Verbs } from './verbs.js';

const BOUND = '127.0.0.1';

describe('isAllowedHttpCaller', () => {
  it('accepts loopback hosts with no Origin (the CLI/agent caller)', () => {
    for (const host of ['127.0.0.1:7777', 'localhost:7777', '[::1]:7777', 'localhost']) {
      expect(isAllowedHttpCaller({ host }, BOUND), host).toBe(true);
    }
  });

  it('rejects the foreign Host the audit used for DNS rebinding', () => {
    expect(
      isAllowedHttpCaller(
        { host: 'audit-untrusted.example', origin: 'https://audit-untrusted.example' },
        BOUND,
      ),
    ).toBe(false);
  });

  it('rejects a foreign Host even when no Origin is attached', () => {
    expect(isAllowedHttpCaller({ host: 'evil.example:7777' }, BOUND)).toBe(false);
  });

  it('rejects a loopback Host carrying a foreign Origin (the cross-site browser case)', () => {
    expect(
      isAllowedHttpCaller({ host: '127.0.0.1:7777', origin: 'https://evil.example' }, BOUND),
    ).toBe(false);
  });

  it('accepts a loopback Origin', () => {
    expect(
      isAllowedHttpCaller({ host: '127.0.0.1:7777', origin: 'http://localhost:5173' }, BOUND),
    ).toBe(true);
  });

  it('rejects a missing Host and an unparseable Origin rather than guessing', () => {
    expect(isAllowedHttpCaller({}, BOUND)).toBe(false);
    expect(isAllowedHttpCaller({ host: '127.0.0.1', origin: 'not a url' }, BOUND)).toBe(false);
  });

  it('honors an explicit non-loopback bind without opening loopback-only assumptions', () => {
    // An operator who deliberately binds elsewhere must still be able to reach their own daemon...
    expect(isAllowedHttpCaller({ host: '10.0.0.5:7777' }, '10.0.0.5')).toBe(true);
    // ...but that does not make every other name acceptable.
    expect(isAllowedHttpCaller({ host: 'evil.example' }, '10.0.0.5')).toBe(false);
  });
});

describe('MAX_HTTP_REQUEST_BYTES', () => {
  it('is a bounded cap the daemon can actually enforce', () => {
    expect(MAX_HTTP_REQUEST_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_HTTP_REQUEST_BYTES)).toBe(true);
  });
});

describe('serveHttp request boundary (end to end)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crib-http-boundary-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Minimal real daemon over an empty graph — the boundary runs before any verb dispatch. */
  async function withDaemon<T>(fn: (port: number) => Promise<T>): Promise<T> {
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.commit('2026-01-01T00:00:00.000Z');
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul, dir);
    const daemon = await serveHttp(new Verbs({ soul, index, repoRoot: dir }), { port: 0 });
    try {
      return await fn(daemon.port);
    } finally {
      await daemon.close();
      index.close();
    }
  }

  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'audit-probe', version: '0.0.0' },
    },
  };

  it("refuses the audit's foreign Host/Origin initialize that previously returned 200", async () => {
    const status = await withDaemon(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          // The exact headers recorded in docs/audits/2026-09-05/evidence/http-boundary.json.
          host: 'audit-untrusted.example',
          origin: 'https://audit-untrusted.example',
        },
        body: JSON.stringify(INITIALIZE),
      });
      return res.status;
    });
    expect(status).toBe(403);
  }, 30_000);

  it('still serves a legitimate local caller', async () => {
    const status = await withDaemon(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.status;
    });
    expect(status).toBe(200);
  }, 30_000);

  it('refuses a body over the cap instead of buffering it', async () => {
    const status = await withDaemon(async (port) => {
      const oversized = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { pad: 'x'.repeat(MAX_HTTP_REQUEST_BYTES + 1024) },
      });
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      return res.status;
    });
    expect(status).toBe(413);
  }, 30_000);
});
