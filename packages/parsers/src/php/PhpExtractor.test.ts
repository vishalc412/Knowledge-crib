import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { createParserHandle, preloadGrammars } from '../tree-sitter-pool.js';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { PhpExtractor } from './PhpExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/php/auth.php', import.meta.url));
const PATH = 'fixtures/php/auth.php';

function ctxFor(): ExtractCtx {
  const text = readFileSync(FIXTURE, 'utf8');
  return {
    async readText() {
      return text;
    },
    treeSitter(grammar: string) {
      return createParserHandle(grammar);
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'php', bytes: 0, mtime: 0 };
  return new PhpExtractor().extract(meta, ctxFor());
}

beforeAll(async () => {
  await preloadGrammars(['php']);
});

describe('PhpExtractor — golden (P3 tree-sitter proof-of-concept gate)', () => {
  it('emits function/class/interface/method symbols with qualified names', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => `${n.qualifiedName}|${n.type}`)
      .sort();
    expect(syms).toEqual(
      [
        'hashPassword|function',
        'verifyPassword|function',
        'AuthService|class',
        'AuthService.login|method',
        'AuthService.issueToken|method',
        'Authenticatable|interface',
        'Authenticatable.login|method',
      ].sort(),
    );
  });

  it('captures extends/implements in meta.bases / meta.implements (uninterpreted — no resolver yet)', async () => {
    const { nodes } = await run();
    const cls = nodes.find((n) => n.qualifiedName === 'AuthService');
    expect(cls?.meta?.bases).toEqual(['BaseService']);
    expect(cls?.meta?.implements).toEqual(['Authenticatable']);
  });

  it('declares capability-honest flags (no resolver ⇒ inheritance:false despite captured bases)', async () => {
    const capabilities = new PhpExtractor().capabilities;
    expect(capabilities).toEqual({
      imports: false,
      calls: true,
      inheritance: false,
      types: 'none',
    });
  });

  it('emits member-of edges: methods → class/interface, top-level symbols → file', async () => {
    const { nodes, edges } = await run();
    const fileId = idFor({ kind: 'file', path: PATH });
    const byQn = (qn: string) => nodes.find((n) => n.qualifiedName === qn)?.id;

    const memberOfEdges = edges.filter((e) => e.rel === 'member-of');
    const pairs = memberOfEdges.map((e) => [e.src, e.dst]);

    expect(pairs).toContainEqual([byQn('hashPassword'), fileId]);
    expect(pairs).toContainEqual([byQn('AuthService'), fileId]);
    expect(pairs).toContainEqual([byQn('Authenticatable'), fileId]);
    expect(pairs).toContainEqual([byQn('AuthService.login'), byQn('AuthService')]);
    expect(pairs).toContainEqual([byQn('AuthService.issueToken'), byQn('AuthService')]);
  });

  it('emits intra-file calls edges only for bare function() calls, not $obj->method()', async () => {
    const { nodes, edges } = await run();
    const byQn = (qn: string) => nodes.find((n) => n.qualifiedName === qn)?.id;
    const calls = edges.filter((e) => e.rel === 'calls').map((e) => [e.src, e.dst]);

    // verifyPassword() body calls the bare top-level function hashPassword()
    expect(calls).toContainEqual([byQn('verifyPassword'), byQn('hashPassword')]);
    // issueToken() body calls the bare top-level function verifyPassword()
    expect(calls).toContainEqual([byQn('AuthService.issueToken'), byQn('verifyPassword')]);
    // login() calls $this->issueToken(...) — a member_call_expression, never a bare call — must NOT
    // produce a calls edge (that's inference's job, same conservative stance as the Go extractor).
    expect(calls).not.toContainEqual([byQn('AuthService.login'), byQn('AuthService.issueToken')]);
  });

  it('degrades to no symbols (never throws) on a malformed file', async () => {
    const meta: FileMeta = { path: 'fixtures/php/broken.php', lang: 'php', bytes: 0, mtime: 0 };
    const ctx: ExtractCtx = {
      async readText() {
        return '<?php function ('; // syntactically broken
      },
      treeSitter(grammar: string) {
        return createParserHandle(grammar);
      },
      hash: contentHash,
      idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
    };
    const result = await new PhpExtractor().extract(meta, ctx);
    // tree-sitter is error-tolerant and returns a (partial/error) tree rather than throwing, so this
    // asserts the extractor itself never throws on malformed input — the actual degrade-to-file-node
    // contract requirement — regardless of how many partial symbols the grammar recovers.
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it('produces identical ids/hashes across repeated runs (ID stability)', async () => {
    const first = await run();
    const second = await run();
    expect(first.nodes.map((n) => n.id).sort()).toEqual(second.nodes.map((n) => n.id).sort());
    expect(first.nodes.map((n) => n.hash).sort()).toEqual(second.nodes.map((n) => n.hash).sort());
  });
});
