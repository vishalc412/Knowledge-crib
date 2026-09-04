import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  OPERATION_COUNT,
  TOOL_COUNT,
  TOOL_NAMES,
  manifestInvariants,
  opSchema,
  opsOf,
} from './capabilities.js';
import { RETIRED_ALIASES, buildServer } from './server.js';
import type { Verbs } from './verbs.js';

/**
 * Gate 1.4 — the capability manifest is the single source of truth for the MCP surface. These tests
 * close the triangle that made the "7-wrong-verb-counts" problem structural:
 *
 *   manifest ↔ server  : the registered tools/list IS the manifest (buildServer also enforces this
 *                        at build time via assertSurfaceMatchesManifest, so a drifted surface
 *                        throws before any test can assert anything).
 *   manifest ↔ routing : every op the manifest declares reaches the verb it declares (driven FROM
 *                        the manifest, not a hand-maintained route list).
 *   manifest ↔ docs    : scripts/capabilities-check.mjs regenerates the "N tools / M operations"
 *                        figures from TOOL_COUNT / OPERATION_COUNT and fails when
 *                        docs/knowledge-crib-mcp-api.md states different numbers.
 */

function toolsOf(spy: Record<string, unknown>) {
  return (
    buildServer(spy as unknown as Verbs) as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }
      >;
    }
  )._registeredTools;
}

/** Minimal per-op arguments that pass the dispatchers' in-handler required-argument guards. The
 *  guards are the contract, so the routing test must satisfy them; anything beyond the minimum
 *  would re-test argument reshaping already pinned in server.test.ts. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  // standalones
  context: { id: 'sym:x' },
  source: { id: 'sym:x' },
  query: { q: 'x' },
  overview: {},
  detect_changes: {},
  brief: { q: 'x' },
  memory_recall: {},
  memory_observe: { kind: 'fact', subject: 's', claim: 'c', actor: 'a' },
  // memory
  'memory:get': { id: 'mem:1' },
  'memory:status': {},
  'memory:audit': {},
  'memory:capture': { subject: 's', observation: 'o', actor: 'a' },
  'memory:feedback': { subject: 'mem:1', signal: 'useful', actor: 'a' },
  // Gate 1.3 — the portable MemoryApi op set.
  'memory:search': {},
  'memory:supersede': { id: 'mem:1', actor: 'a', claim: 'c' },
  'memory:delete': { id: 'mem:1', actor: 'a' },
  'memory:history': { key: 'mem:1' },
  'memory:sync': {},
  // enrich
  'enrich:status': {},
  'enrich:next': {},
  'enrich:save': { batchId: 'b', items: [] },
  'enrich:delta': {},
  'enrich:audit': {},
  // impact
  'impact:blast': { id: 'x' },
  'impact:federated': { id: 'x' },
  'impact:path': { from: 'a', to: 'b' },
  'impact:owners': { id: 'x' },
  // dossier
  'dossier:one': { id: 'x' },
  'dossier:package': { id: 'x' },
  'dossier:scope': { id: 'x', scope: 'file' },
  'dossier:rules': { procedure: 'pkg.proc' },
  // neighbors
  'neighbors:edges': { id: 'x' },
  'neighbors:llm': { id: 'x' },
  'neighbors:describes': { id: 'x' },
  // status
  'status:health': {},
  'status:stats': {},
  'status:gaps': {},
};

describe('capability manifest', () => {
  it('is internally consistent (no duplicate tools/ops, defaults name real ops)', () => {
    expect(manifestInvariants()).toEqual([]);
  });

  it('registers exactly the manifest tools — tools/list is manifest-generated, not hand-listed', () => {
    const names = Object.keys(toolsOf({})).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    // The retired standalone names stay OFF the surface (they resolve via the call-level alias
    // shim instead — that is what keeps tools/list at TOOL_COUNT entries).
    for (const retired of Object.keys(RETIRED_ALIASES)) {
      expect(names).not.toContain(retired);
    }
  });

  it('routes every manifest op to the verb the manifest declares', async () => {
    const calls: string[] = [];
    const verbs = new Set<string>();
    for (const cap of CAPABILITIES) {
      if ('ops' in cap) for (const { verb } of cap.ops) verbs.add(verb);
      else verbs.add(cap.verb);
    }
    const spy: Record<string, unknown> = {};
    for (const verb of verbs) {
      spy[verb] = () => {
        calls.push(verb);
        return {};
      };
    }
    // `status({op:'stats'})` reaches getStats().snapshot(), not a plain verb method.
    spy.getStats = () => ({
      snapshot: () => {
        calls.push('getStats');
        return {};
      },
    });
    const tools = toolsOf(spy);

    const expected: string[] = [];
    for (const cap of CAPABILITIES) {
      if (!('ops' in cap)) {
        expected.push(cap.verb);
        await tools[cap.tool]!.handler(MINIMAL_ARGS[cap.tool]);
        continue;
      }
      for (const { op, verb } of cap.ops) {
        expected.push(verb);
        await tools[cap.tool]!.handler({ op, ...MINIMAL_ARGS[`${cap.tool}:${op}`] });
      }
    }
    // Manifest order in, manifest order out — one call per op, each reaching its declared verb.
    expect(calls).toEqual(expected);
  });

  it('applies each dispatcher defaultOp when `op` is omitted', async () => {
    for (const cap of CAPABILITIES) {
      if (!('ops' in cap) || cap.defaultOp === undefined) continue;
      const calls: string[] = [];
      const verb = cap.ops.find((o) => o.op === cap.defaultOp)!.verb;
      const spy: Record<string, unknown> = {
        [verb]: () => {
          calls.push(verb);
          return {};
        },
      };
      // impact/dossier/neighbors default ops all take `id`; status's health takes nothing.
      const args = cap.tool === 'status' ? {} : { id: 'x' };
      const tools = toolsOf(spy);
      await tools[cap.tool]!.handler(args);
      // Only the default op's verb is instrumented, so reaching it at all pins the default.
      expect(calls, `${cap.tool} default op ${cap.defaultOp}`).toEqual([verb]);
    }
  });

  it("derives op-schema optionality from defaultOp — no default means `op` can't be omitted", () => {
    expect(opSchema('memory').isOptional()).toBe(false);
    expect(opSchema('enrich').isOptional()).toBe(false);
    for (const tool of ['impact', 'dossier', 'neighbors', 'status']) {
      expect(opSchema(tool).isOptional(), tool).toBe(true);
    }
  });

  it('counts operations as: dispatcher ops.length + one per standalone tool', () => {
    const expected = CAPABILITIES.reduce(
      (total, cap) => total + ('ops' in cap ? opsOf(cap.tool).length : 1),
      0,
    );
    expect(OPERATION_COUNT).toBe(expected);
    expect(TOOL_COUNT).toBe(TOOL_NAMES.length);
  });
});
