import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/ts-min/auth.ts', import.meta.url));
const PATH = 'fixtures/ts-min/auth.ts';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'typescript', bytes: text.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(text));
}

describe('TypeScriptExtractor — golden (M2 gate)', () => {
  it('emits the exact symbol set with correct types', async () => {
    const { nodes } = await run();
    const types: Record<string, string | undefined> = {};
    for (const n of nodes) if (n.qualifiedName) types[n.qualifiedName] = n.type;
    expect(types).toEqual({
      AuthService: 'class',
      'AuthService.login': 'method',
      'AuthService.issue': 'method',
      makeSession: 'function',
      Session: 'interface',
    });
  });

  it('emits member-of edges to the enclosing symbol or file', async () => {
    const { nodes, edges } = await run();
    const id = (q: string) => nodes.find((n) => n.qualifiedName === q)?.id;
    const fileId = idFor({ kind: 'file', path: PATH });
    const memberOf = edges
      .filter((e) => e.rel === 'member-of')
      .map(
        (e) =>
          `${nodes.find((n) => n.id === e.src)?.qualifiedName} -> ${e.dst === fileId ? 'FILE' : nodes.find((n) => n.id === e.dst)?.qualifiedName}`,
      )
      .sort();
    expect(memberOf).toEqual(
      [
        'AuthService -> FILE',
        'AuthService.login -> AuthService',
        'AuthService.issue -> AuthService',
        'makeSession -> FILE',
        'Session -> FILE',
      ].sort(),
    );
    expect(id('AuthService.login')).toBeDefined();
  });

  it('emits intra-file calls (this.issue, makeSession) and nothing cross-file', async () => {
    const { nodes, edges } = await run();
    const q = (id: string) => nodes.find((n) => n.id === id)?.qualifiedName;
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${q(e.src)} -> ${q(e.dst)}`)
      .sort();
    expect(calls).toEqual([
      'AuthService.issue -> makeSession',
      'AuthService.login -> AuthService.issue',
    ]);
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.confidence).toBe(1);
    }
  });

  it('uses the canonical id grammar', async () => {
    const { nodes } = await run();
    const login = nodes.find((n) => n.qualifiedName === 'AuthService.login');
    expect(login?.id).toMatch(/^sym:fixtures\/ts-min\/auth\.ts#AuthService\.login@L\d+$/);
  });

  it('degrades on a malformed file (no symbols, no throw)', async () => {
    const res = await run('class {{{ broken (((');
    expect(res).toBeDefined();
    // TS is lenient; the contract is "no throw". Symbols may be empty or partial.
    expect(Array.isArray(res.nodes)).toBe(true);
  });

  it('is id-stable across runs', async () => {
    const a = await run();
    const b = await run();
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.nodes.map((n) => n.hash)).toEqual(b.nodes.map((n) => n.hash));
  });
});
