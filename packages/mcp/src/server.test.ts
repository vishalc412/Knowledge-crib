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
      memoryCapture: (a: { subject: string; observation: string; actor: string }) => {
        calls.push(`capture:${a.subject}:${a.observation}:${a.actor}`);
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
    await tool.handler({
      op: 'capture',
      subject: 'topic:x',
      observation: 'loose note',
      actor: 'tester',
    });
    await tool.handler({ op: 'feedback', subject: 'mem:abc', signal: 'useful', actor: 'tester' });

    expect(calls).toEqual([
      'get:mem:abc',
      'status',
      'audit',
      'capture:topic:x:loose note:tester',
      'feedback:mem:abc',
    ]);
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

    const noObservation = (await callMemory({ op: 'capture', subject: 'topic:x' })) as {
      error?: { code: string; message: string };
    };
    expect(noObservation.error?.code).toBe('BAD_REQUEST');
    expect(noObservation.error?.message).toContain('observation');
  });
});

/**
 * Routing tables for the `op` dispatchers that replaced 18 standalone tools.
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
    const args: Record<string, unknown[]> = {};
    const spy: Record<string, unknown> = {};
    for (const n of names) {
      spy[n] = (a: unknown) => {
        calls.push(n);
        if (!args[n]) args[n] = [];
        args[n]!.push(a);
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
    return { calls, args, spy };
  }

  it('pins the visible surface to exactly the 14 names every client session pays for', () => {
    const { spy } = recorder([]);
    const names = Object.keys(toolsOf(spy)).sort();
    expect(names).toEqual([
      'brief',
      'context',
      'detect_changes',
      'dossier',
      'enrich',
      'impact',
      'memory',
      'memory_observe',
      'memory_recall',
      'neighbors',
      'overview',
      'query',
      'source',
      'status',
    ]);
    // The retired standalone names are NOT registered tools either — that is what keeps them out
    // of tools/list. They resolve through the call-level alias shim (pinned in the
    // 'retired alias shim' describe below). extract_rules joined this list when it folded behind
    // dossier{op:'rules'}.
    for (const retired of [
      'memory_get',
      'memory_status',
      'memory_audit',
      'memory_feedback',
      'enrich_status',
      'enrich_next',
      'enrich_save',
      'semantic_delta',
      'audit_llm',
      'shortest_path',
      'ownership',
      'reconstruct',
      'dossier_by_scope',
      'llm_neighbors',
      'describes',
      'stats',
      'gaps',
      'extract_rules',
    ]) {
      expect(names).not.toContain(retired);
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

  it('folds extract_rules into dossier op=rules, preserving its contract', async () => {
    const { calls, args, spy } = recorder(['extractRules']);
    const tools = toolsOf(spy);
    const read = async (a: unknown) =>
      JSON.parse((await tools.dossier!.handler(a)).content[0]!.text) as {
        error?: { code: string; message: string };
      };

    // includeTables stays opt-in and only ever reaches the verb alongside procedure — exactly the
    // arg set the retired standalone tool accepted.
    await tools.dossier?.handler({ op: 'rules', procedure: 'pkg.proc', includeTables: true });
    await tools.dossier?.handler({ op: 'rules', procedure: 'pkg.proc' });
    expect(calls).toEqual(['extractRules', 'extractRules']);
    expect(args.extractRules).toEqual([
      { procedure: 'pkg.proc', includeTables: true },
      { procedure: 'pkg.proc' },
    ]);

    // The procedure guard: under-specified calls must not reach the verb at all.
    const missing = await read({ op: 'rules' });
    expect(missing.error?.code).toBe('BAD_REQUEST');
    expect(missing.error?.message).toContain('procedure');
    expect(calls).toEqual(['extractRules', 'extractRules']);

    // And ops that need id now guard it in the handler (id became schema-optional for op=rules).
    expect((await read({ op: 'one' })).error?.code).toBe('BAD_REQUEST');
    expect((await read({ op: 'package' })).error?.message).toContain('id');
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

/**
 * ONE-RELEASE-ONLY hidden-alias shim (remove with RETIRED_ALIASES in the next release): the 18
 * standalone tool names the dispatchers folded must keep resolving for the six installed clients,
 * without re-inflating tools/list.
 *
 * The shim lives ABOVE the SDK's tool lookup — it rewrites the wire request — so the only honest
 * way to test it is through the protocol's tools/call handler, the way a real client's call
 * arrives. Calling a registered tool's handler directly (as the dispatch tests do) would bypass
 * the shim entirely and prove nothing.
 */
describe('retired alias shim', () => {
  function callWire(
    spy: Partial<Record<string, unknown>>,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const built = buildServer(spy as unknown as Verbs) as unknown as {
      server: {
        _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
      };
    };
    const handler = built.server._requestHandlers.get('tools/call');
    if (!handler) throw new Error('tools/call handler not installed');
    return handler({ method: 'tools/call', params: { name, arguments: args } }, {});
  }

  function recorder(names: string[]) {
    const calls: string[] = [];
    const args: Record<string, unknown[]> = {};
    const spy: Record<string, unknown> = {};
    for (const n of names) {
      spy[n] = (a: unknown) => {
        calls.push(n);
        if (!args[n]) args[n] = [];
        args[n]!.push(a);
        return {};
      };
    }
    // `status` op=stats reaches getStats().snapshot() rather than a plain verb.
    spy.getStats = () => ({
      snapshot: () => {
        calls.push('getStats');
        return {};
      },
    });
    return { calls, args, spy };
  }

  // [retired name, verb it must reach, arguments a legacy client would send]. Kept in the same
  // order as RETIRED_ALIASES in server.ts so a drift between table and shim is visible at a glance.
  const ROUTES: Array<[string, string, Record<string, unknown>]> = [
    ['memory_get', 'memoryGet', { id: 'mem:1' }],
    ['memory_status', 'memoryStatus', {}],
    ['memory_audit', 'memoryAudit', {}],
    ['memory_feedback', 'memoryFeedback', { subject: 'mem:1', signal: 'useful', actor: 'tester' }],
    ['enrich_status', 'enrichStatus', {}],
    ['enrich_next', 'enrichNext', { layer: 'file' }],
    ['enrich_save', 'enrichSave', { batchId: 'b', items: [] }],
    ['semantic_delta', 'semanticDelta', { since: 'HEAD~1' }],
    ['audit_llm', 'auditLlm', {}],
    ['shortest_path', 'shortestPath', { from: 'a', to: 'b' }],
    ['ownership', 'ownership', { id: 'sym:1' }],
    ['reconstruct', 'reconstruct', { id: 'PKG' }],
    ['dossier_by_scope', 'dossierByScope', { id: 'PKG', scope: 'file' }],
    ['llm_neighbors', 'llmNeighbors', { id: 'sym:1' }],
    ['describes', 'describes', { id: 'sym:1' }],
    ['stats', 'getStats', {}],
    ['gaps', 'gaps', { includeBuiltins: true }],
    ['extract_rules', 'extractRules', { procedure: 'pkg.proc', includeTables: true }],
  ];

  it('resolves every retired name to its dispatcher verb+op with the legacy arguments intact', async () => {
    const { calls, args, spy } = recorder(ROUTES.map(([, verb]) => verb));
    for (const [alias, , wireArgs] of ROUTES) {
      await callWire(spy, alias, wireArgs);
    }
    expect(calls).toEqual(ROUTES.map(([, verb]) => verb));
    // Spot-check the cases where routing alone is not enough — the dispatcher's in-flight
    // reshaping (dropping `op`, injecting a default, or narrowing the arg set) is part of the
    // contract legacy callers relied on.
    expect(args.memoryGet).toEqual([{ id: 'mem:1' }]);
    expect(args.dossierByScope).toEqual([{ id: 'PKG', scope: 'file' }]);
    expect(args.extractRules).toEqual([{ procedure: 'pkg.proc', includeTables: true }]);
  });

  it('always applies the alias op — a client-supplied op on a retired name cannot contradict it', async () => {
    const { calls, spy } = recorder(['gaps', 'status']);
    await callWire(spy, 'gaps', { op: 'health' }); // nonsense on the retired name; alias op wins
    await callWire(spy, 'status', { op: 'health' }); // a REAL dispatcher call stays untouched
    expect(calls).toEqual(['gaps', 'status']);
  });

  it('still rejects genuinely unknown names instead of inventing a route', async () => {
    const { spy } = recorder([]);
    // SDK v1.29 converts the unknown-tool McpError into an isError CallToolResult rather than a
    // thrown rejection, so the wire-level assertion is on the payload, not a throw.
    const res = (await callWire(spy, 'no_such_tool')) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Tool no_such_tool not found');
  });

  it('leaves the wire-level required-argument guards in place for aliased calls', async () => {
    const { calls, args, spy } = recorder(['memoryGet', 'extractRules']);
    const payload = async (name: string) => {
      const res = (await callWire(spy, name)) as { content: Array<{ text: string }> };
      return JSON.parse(res.content[0]!.text) as { error?: { code: string; message: string } };
    };
    expect((await payload('memory_get')).error?.code).toBe('BAD_REQUEST');
    const missingProcedure = await payload('extract_rules');
    expect(missingProcedure.error?.code).toBe('BAD_REQUEST');
    expect(missingProcedure.error?.message).toContain('procedure');
    expect(calls).toEqual([]);
    expect(args).toEqual({});
  });
});
