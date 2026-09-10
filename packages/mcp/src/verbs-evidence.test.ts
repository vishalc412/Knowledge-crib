import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  IntelligenceEventJournal,
  MemoryStore,
  __resetMemoryLockGuardForTest,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-mcp-evidence';
let repo: string;
let home: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let local: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-mcp-evidence-'));
  home = mkdtempSync(join(tmpdir(), 'crib-mcp-evidence-home-'));
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.commit(NOW);
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  local = MemoryStore.local(REPO_ID, {
    repoRoot: repo,
    env: { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home },
    now: () => NOW,
  });
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * WP2.5 runtime evidence — the `mcp.connection` and `mcp.tool-invoked` journal events are the only
 * proof that a client actually attached to and used the server. Configuration files cannot provide
 * it, so these tests pin the recording path end to end: handshake → journal, tool call → journal,
 * with the coalescing that bounds the write rate.
 */
describe('MCP runtime evidence (WP2.5)', () => {
  function evidence() {
    const journal = new IntelligenceEventJournal({ rootDir: join(home, 'events') });
    const verbs = new Verbs({
      soul,
      index,
      repoRoot: repo,
      memory: { local, eventJournal: journal },
    });
    const built = buildServer(verbs, '1.2.3');
    return { journal, verbs, built };
  }

  /** The low-level Server seam the oninitialized hook reads the handshake from. */
  function handshake(built: unknown, name: string, version: string): void {
    const server = (
      built as {
        server: {
          _clientVersion?: { name: string; version: string };
          oninitialized?: () => void;
        };
      }
    ).server;
    server._clientVersion = { name, version };
    server.oninitialized?.();
  }

  function registeredTool(
    built: unknown,
    name: string,
  ): {
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  } {
    const tool = (
      built as {
        _registeredTools: Record<
          string,
          { handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools[name];
    if (!tool) throw new Error(`${name} tool not registered`);
    return tool;
  }

  it('records an mcp.connection event when the handshake completes (oninitialized → journal)', () => {
    const { journal, built } = evidence();
    handshake(built, 'claude-code', '2.1.150');
    const events = journal.read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'mcp.connection',
      source: { clientId: 'claude-code' },
      payload: { client: 'claude-code', clientVersion: '2.1.150' },
    });
  });

  it('coalesces connection evidence per (server process, client)', () => {
    const { journal, built } = evidence();
    handshake(built, 'claude-code', '2.1.150');
    handshake(built, 'claude-code', '2.1.150'); // same client, same process: one event
    expect(journal.read().filter((e) => e.kind === 'mcp.connection')).toHaveLength(1);
  });

  it('does not attribute tool invocations without a handshake', () => {
    const { journal, verbs, built } = evidence();
    verbs.recordToolInvocation('context'); // no noteInitialized yet: nothing to attribute
    expect(journal.read()).toHaveLength(0);
    handshake(built, 'claude-code', '2.1.150');
    verbs.recordToolInvocation('context');
    const invokes = journal.read().filter((e) => e.kind === 'mcp.tool-invoked');
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({
      source: { clientId: 'claude-code' },
      payload: { tool: 'context' },
    });
  });

  it('records mcp.tool-invoked through the handler wrapper, coalesced per time bucket', async () => {
    const { journal, built } = evidence();
    handshake(built, 'claude-code', '2.1.150');
    const status = registeredTool(built, 'status');
    await status.handler({ op: 'health' });
    await status.handler({ op: 'health' }); // same bucket: the idempotency key coalesces
    const invokes = journal.read().filter((e) => e.kind === 'mcp.tool-invoked');
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({
      source: { clientId: 'claude-code' },
      payload: { tool: 'status' },
    });
  });

  it('fails open: a broken journal never fails a connection or a tool call', async () => {
    const broken = {
      append: () => {
        throw new Error('journal disk gone');
      },
      read: () => [],
    } as unknown as IntelligenceEventJournal;
    const verbs = new Verbs({
      soul,
      index,
      repoRoot: repo,
      memory: { local, eventJournal: broken },
    });
    const built = buildServer(verbs, '1.2.3');
    expect(() => handshake(built, 'claude-code', '2.1.150')).not.toThrow();
    const status = registeredTool(built, 'status');
    const result = await status.handler({ op: 'health' });
    // The call resolves and returns real content — fail-open means the broken journal is invisible.
    expect(result.content[0]?.text).toBeTruthy();
  });
});
