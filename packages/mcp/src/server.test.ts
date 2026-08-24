import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { Verbs } from './verbs.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-srv-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MCP server wiring', () => {
  it('builds a server with all verbs registered without throwing', () => {
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.commit('2026-01-01T00:00:00.000Z');
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul, dir);
    const server = buildServer(new Verbs({ soul, index, repoRoot: dir }), '1.2.3');
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
    index.close();
  });
});

/**
 * The `memory` dispatcher replaced four standalone tools (memory_get / memory_status /
 * memory_audit / memory_feedback) to cut fixed tool-list cost. A dispatcher can fail in a way four
 * separate tools cannot: routing an `op` to the wrong verb returns a plausible-looking but wrong
 * payload rather than erroring. These pin each route and its required arguments.
 */
describe('memory dispatcher', () => {
  function server() {
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.commit('2026-01-01T00:00:00.000Z');
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul, dir);
    const built = buildServer(new Verbs({ soul, index, repoRoot: dir }));
    return { built, index };
  }

  async function callMemory(args: Record<string, unknown>): Promise<unknown> {
    const { built, index } = server();
    const tool = (
      built as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools.memory;
    if (!tool) throw new Error('memory tool not registered');
    const res = await tool.handler(args);
    index.close();
    return JSON.parse(res.content[0]!.text);
  }

  it('replaces the four standalone memory tools in the registered surface', () => {
    const { built, index } = server();
    const names = Object.keys(
      (built as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(names).toContain('memory');
    expect(names).toContain('memory_recall'); // named by the installed client protocol
    expect(names).toContain('memory_observe'); // named by the installed client protocol
    for (const gone of ['memory_get', 'memory_status', 'memory_audit', 'memory_feedback']) {
      expect(names).not.toContain(gone);
    }
    index.close();
  });

  it('routes each op to its OWN verb — a dispatcher can mis-route silently', async () => {
    // Without a memory ledger wired, every op degrades to the same `not configured` payload, so a
    // response-shape assertion cannot tell the routes apart. Record which verb each op actually
    // reaches instead: that IS the routing table, and it is the thing a dispatcher gets wrong.
    const calls: string[] = [];
    const spy = {
      memoryGet: (a: { id: string }) => {
        calls.push(`get:${a.id}`);
        return {};
      },
      memoryStatus: () => {
        calls.push('status');
        return {};
      },
      memoryAudit: () => {
        calls.push('audit');
        return {};
      },
      memoryFeedback: (a: { subject: string }) => {
        calls.push(`feedback:${a.subject}`);
        return {};
      },
    } as unknown as Verbs;
    const tool = (
      buildServer(spy) as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools.memory;
    if (!tool) throw new Error('memory tool not registered');

    await tool.handler({ op: 'get', id: 'mem:abc' });
    await tool.handler({ op: 'status' });
    await tool.handler({ op: 'audit' });
    await tool.handler({ op: 'feedback', subject: 'mem:abc', signal: 'useful', actor: 'tester' });

    expect(calls).toEqual(['get:mem:abc', 'status', 'audit', 'feedback:mem:abc']);
  });

  it('rejects an op whose required arguments are missing instead of silently mis-calling', async () => {
    const noId = (await callMemory({ op: 'get' })) as { error?: { code: string; message: string } };
    expect(noId.error?.code).toBe('BAD_REQUEST');
    expect(noId.error?.message).toContain('id');

    const noSubject = (await callMemory({ op: 'feedback', signal: 'useful' })) as {
      error?: { code: string; message: string };
    };
    expect(noSubject.error?.code).toBe('BAD_REQUEST');
    expect(noSubject.error?.message).toContain('subject');
  });
});

/**
 * Routing tables for the `op` dispatchers that replaced 14 standalone tools.
 *
 * A dispatcher fails differently from a set of separate tools: a mis-routed `op` returns a
 * plausible payload from the WRONG verb rather than erroring, and TypeScript cannot catch it
 * (every verb returns the same record type). Recording which verb each op reaches is therefore the
 * only assertion that actually pins the behaviour. Duplicate registration is likewise invisible to
 * the compiler — it only throws at buildServer time — so the surface is asserted too.
 */
describe('op dispatchers', () => {
  function toolsOf(spy: Partial<Record<string, unknown>>) {
    return (
      buildServer(spy as unknown as Verbs) as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools;
  }

  function recorder(names: string[]) {
    const calls: string[] = [];
    const spy: Record<string, unknown> = {};
    for (const n of names) {
      spy[n] = () => {
        calls.push(n);
        return {};
      };
    }
    // `status` reaches getStats().snapshot() rather than a plain verb.
    spy.getStats = () => ({
      snapshot: () => {
        calls.push('getStats');
        return {};
      },
    });
    return { calls, spy };
  }

  it('registers exactly the consolidated surface, with no duplicate names', () => {
    const { spy } = recorder([]);
    const names = Object.keys(toolsOf(spy));
    expect(new Set(names).size).toBe(names.length); // duplicates throw at build, but pin it anyway
    for (const t of ['enrich', 'impact', 'dossier', 'neighbors', 'status', 'memory']) {
      expect(names).toContain(t);
    }
    // Folded away — each of these used to cost a full tool-list entry every session.
    for (const gone of [
      'enrich_status',
      'enrich_next',
      'enrich_save',
      'semantic_delta',
      'audit_llm',
      'federatedImpact',
      'shortest_path',
      'ownership',
      'reconstruct',
      'dossier_by_scope',
      'llm_neighbors',
      'describes',
      'stats',
      'gaps',
    ]) {
      expect(names).not.toContain(gone);
    }
    // Deliberately still standalone: reached for constantly, or named by the installed client
    // protocol / project instructions, where an extra `op` would be friction or breakage.
    for (const kept of [
      'brief',
      'context',
      'query',
      'source',
      'detect_changes',
      'memory_recall',
      'memory_observe',
    ]) {
      expect(names).toContain(kept);
    }
  });

  it('routes every enrich op to its own verb', async () => {
    const { calls, spy } = recorder([
      'enrichStatus',
      'enrichNext',
      'enrichSave',
      'semanticDelta',
      'auditLlm',
    ]);
    const t = toolsOf(spy).enrich;
    if (!t) throw new Error('enrich not registered');
    await t.handler({ op: 'status' });
    await t.handler({ op: 'next', layer: 'file' });
    await t.handler({ op: 'save', batchId: 'b', items: [] });
    await t.handler({ op: 'delta' });
    await t.handler({ op: 'audit' });
    expect(calls).toEqual([
      'enrichStatus',
      'enrichNext',
      'enrichSave',
      'semanticDelta',
      'auditLlm',
    ]);
  });

  it('routes every impact / dossier / neighbors op to its own verb, defaulting correctly', async () => {
    const { calls, spy } = recorder([
      'impact',
      'federatedImpact',
      'shortestPath',
      'ownership',
      'dossier',
      'reconstruct',
      'dossierByScope',
      'neighbors',
      'llmNeighbors',
      'describes',
    ]);
    const tools = toolsOf(spy);
    await tools.impact?.handler({ id: 'x' }); // op omitted -> blast
    await tools.impact?.handler({ op: 'federated', id: 'x' });
    await tools.impact?.handler({ op: 'path', from: 'a', to: 'b' });
    await tools.impact?.handler({ op: 'owners', id: 'x' });
    await tools.dossier?.handler({ id: 'x' }); // op omitted -> one
    await tools.dossier?.handler({ op: 'package', id: 'x' });
    await tools.dossier?.handler({ op: 'scope', id: 'x', scope: 'file' });
    await tools.neighbors?.handler({ id: 'x' }); // op omitted -> edges
    await tools.neighbors?.handler({ op: 'llm', id: 'x' });
    await tools.neighbors?.handler({ op: 'describes', id: 'x' });
    expect(calls).toEqual([
      'impact',
      'federatedImpact',
      'shortestPath',
      'ownership',
      'dossier',
      'reconstruct',
      'dossierByScope',
      'neighbors',
      'llmNeighbors',
      'describes',
    ]);
  });

  it('rejects under-specified ops instead of forwarding a wrong call', async () => {
    const { calls, spy } = recorder(['impact', 'shortestPath', 'dossierByScope', 'enrichSave']);
    const tools = toolsOf(spy);
    const read = async (t: string, a: unknown) =>
      JSON.parse((await tools[t]!.handler(a)).content[0]!.text) as {
        error?: { code: string; message: string };
      };
    expect((await read('impact', { op: 'blast' })).error?.code).toBe('BAD_REQUEST');
    expect((await read('impact', { op: 'path', from: 'a' })).error?.message).toContain('to');
    expect((await read('dossier', { op: 'scope', id: 'x' })).error?.code).toBe('BAD_REQUEST');
    expect((await read('enrich', { op: 'save', batchId: 'b' })).error?.message).toContain('items');
    // Nothing was forwarded to a verb.
    expect(calls).toEqual([]);
  });
});
