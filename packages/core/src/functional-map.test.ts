import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, buildFunctionalMap, newManifest } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';

let dir: string | undefined;

function sym(path: string, qname: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: qname, startLine: line }),
    kind: 'symbol',
    type: 'function',
    name: qname.split('.').pop() ?? qname,
    qualifiedName: qname,
    file: path,
    span: { start: line, end: line },
    lang: 'typescript',
    hash: contentHash(`${path}:${qname}`),
    ...extra,
  };
}
function edge(src: string, dst: string, rel: Edge['rel']): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
  };
}

function newSoul(now = '2026-01-01T00:00:00.000Z'): SoulStore {
  const soul = new SoulStore(join(dir!, '.crib'), { manifest: newManifest({ now }) });
  soul.load();
  return soul;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('buildFunctionalMap', () => {
  it('segments by workspace packages when stamped, naming modules from the package name', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-ws-'));
    const soul = newSoul();
    soul.getManifest().meta = {
      workspace: {
        tool: 'pnpm',
        packages: [
          { name: 'core', rel: 'packages/core' },
          { name: 'cli', rel: 'packages/cli' },
        ],
      },
    };
    const coreA = sym('packages/core/src/a.ts', 'core.A', 1);
    const cliB = sym('packages/cli/src/b.ts', 'cli.B', 1);
    soul.putNodes([coreA, cliB]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const map = buildFunctionalMap(soul);
    expect(map.source).toBe('workspace');
    const byId = new Map(map.modules.map((m) => [m.id, m]));
    expect(byId.get('module:packages/core')?.name).toBe('core');
    expect(byId.get('module:packages/cli')?.name).toBe('cli');
    expect(byId.get('module:packages/core')?.counts.symbols).toBe(1);
    expect(byId.get('module:packages/cli')?.counts.symbols).toBe(1);
  });

  it('falls back to directory prefixes when no workspace is stamped', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-dir-'));
    const soul = newSoul();
    const a = sym('src/a.ts', 'A.run', 1);
    const b = sym('lib/b.ts', 'B.go', 1);
    soul.putNodes([a, b]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const map = buildFunctionalMap(soul);
    expect(map.source).toBe('directory');
    const prefixes = map.modules.map((m) => m.pathPrefix).sort();
    expect(prefixes).toContain('src');
    expect(prefixes).toContain('lib');
  });

  it('descends one level when a single first-component bucket holds >80% of symbols', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-descent-'));
    const soul = newSoul();
    // 9 symbols under packages/*/  and 1 under src/ — `packages` holds 90% → descend to depth 2.
    const nodes: Node[] = [];
    for (let i = 0; i < 4; i++) nodes.push(sym(`packages/core/src/f${i}.ts`, `core.f${i}`, 1));
    for (let i = 0; i < 5; i++) nodes.push(sym(`packages/cli/src/g${i}.ts`, `cli.g${i}`, 1));
    nodes.push(sym('src/x.ts', 'X.run', 1));
    soul.putNodes(nodes);
    soul.commit('2026-01-01T00:00:00.000Z');

    const map = buildFunctionalMap(soul);
    const prefixes = map.modules.map((m) => m.pathPrefix);
    expect(prefixes).toContain('packages/core');
    expect(prefixes).toContain('packages/cli');
    expect(prefixes).not.toContain('packages'); // descended past the useless single bucket
  });

  it('ranks top symbols by importance desc and pushes test helpers to the back', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-rank-'));
    const soul = newSoul();
    soul.getManifest().meta = {
      workspace: { tool: 'pnpm', packages: [{ name: 'cli', rel: 'packages/cli' }] },
    };
    // low-degree production fn with an alphabetical-earlier id than the test helper.
    const prod = sym('packages/cli/src/run.ts', 'cli.run', 1);
    const testHelper = sym('packages/cli/src/run.test.ts', 'cli.helper', 1);
    // three callers into prod → importance 3; testHelper has no callers → importance 0 (absent).
    const c1 = sym('packages/cli/src/c1.ts', 'cli.c1', 1);
    const c2 = sym('packages/cli/src/c2.ts', 'cli.c2', 1);
    const c3 = sym('packages/cli/src/c3.ts', 'cli.c3', 1);
    soul.putNodes([prod, testHelper, c1, c2, c3]);
    soul.putEdges([
      edge(c1.id, prod.id, 'calls'),
      edge(c2.id, prod.id, 'calls'),
      edge(c3.id, prod.id, 'calls'),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const map = buildFunctionalMap(soul);
    const mod = map.modules.find((m) => m.id === 'module:packages/cli')!;
    expect(mod).toBeDefined();
    const ids = mod.topSymbols.map((s) => s.id);
    // prod ranks first despite the test helper having an earlier file/symbol id; helper is last.
    expect(ids[0]).toBe(prod.id);
    expect(ids[ids.length - 1]).toBe(testHelper.id);
  });

  it('resolves a heuristic purpose when no LLM layer is present', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-purpose-'));
    const soul = newSoul();
    soul.getManifest().meta = {
      workspace: { tool: 'pnpm', packages: [{ name: 'auth', rel: 'packages/auth' }] },
    };
    const fn = sym('packages/auth/src/login.ts', 'auth.login', 1, { stereotype: 'controller' });
    soul.putNodes([fn]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const map = buildFunctionalMap(soul);
    const mod = map.modules.find((m) => m.id === 'module:packages/auth')!;
    expect(mod.purpose?.source).toBe('heuristic');
    expect(mod.purpose?.text).toContain('auth');
    expect(mod.purpose?.text).toContain('controller');
  });

  it('is byte-identical across two runs over the same soul', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-det-'));
    const soul = newSoul();
    soul.getManifest().meta = {
      workspace: {
        tool: 'pnpm',
        packages: [
          { name: 'core', rel: 'packages/core' },
          { name: 'cli', rel: 'packages/cli' },
        ],
      },
    };
    const a = sym('packages/core/src/a.ts', 'core.A', 1);
    const b = sym('packages/cli/src/b.ts', 'cli.B', 1);
    soul.putNodes([a, b]);
    soul.putEdges([edge(b.id, a.id, 'calls')]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const first = buildFunctionalMap(soul);
    const second = buildFunctionalMap(soul);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('sorts modules by summed importance desc, id tie-break', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-sort-'));
    const soul = newSoul();
    soul.getManifest().meta = {
      workspace: {
        tool: 'pnpm',
        packages: [
          { name: 'a', rel: 'packages/a' },
          { name: 'b', rel: 'packages/b' },
        ],
      },
    };
    const aHub = sym('packages/a/src/hub.ts', 'a.hub', 1);
    const aCaller = sym('packages/a/src/c.ts', 'a.c', 1);
    const bLonely = sym('packages/b/src/x.ts', 'b.x', 1);
    soul.putNodes([aHub, aCaller, bLonely]);
    soul.putEdges([edge(aCaller.id, aHub.id, 'calls')]); // a has summed importance 1, b has 0
    soul.commit('2026-01-01T00:00:00.000Z');

    const map = buildFunctionalMap(soul);
    // `packages/a` (importance 1) before `packages/b` (importance 0); root sorts by id after.
    const ids = map.modules.map((m) => m.id);
    expect(ids.indexOf('module:packages/a')).toBeLessThan(ids.indexOf('module:packages/b'));
  });

  it('assigns every cross-module cluster to one deterministic owner even on a tie', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-fm-owner-'));
    const soul = newSoul();
    soul.getManifest().meta = {
      workspace: {
        tool: 'pnpm',
        packages: [
          { name: 'a', rel: 'packages/a' },
          { name: 'b', rel: 'packages/b' },
        ],
      },
    };
    const a = sym('packages/a/src/a.ts', 'a.run', 1);
    const b = sym('packages/b/src/b.ts', 'b.run', 1);
    const cluster: Node = {
      id: 'c:shared',
      kind: 'cluster',
      label: 'Shared functionality',
      members: [a.id, b.id].sort(),
      hash: contentHash('shared'),
    };
    soul.putNodes([a, b]);
    soul.replaceClusters(
      [cluster],
      [edge(a.id, cluster.id, 'member-of'), edge(b.id, cluster.id, 'member-of')],
    );
    soul.commit();

    const map = buildFunctionalMap(soul);
    const owners = map.modules.filter((module) => module.clusterIds.includes(cluster.id));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.id).toBe('module:packages/a');
  });
});
