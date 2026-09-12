/**
 * File-level grounding. Found by a real MCP run on this repository: an agent quoted
 * `const VERIFY_MAX_CHARS = 256 * 1024;` exactly, at the right line, and crib refused it as
 * "not found" — no indexed declaration span covered a top-level constant, and config/YAML/JSON
 * files index as a span-less file node only. So any quote outside a function or class could never
 * verify. A file node now counts as spanning its own file.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import {
  type GroundingPort,
  type MemoryEvidence,
  groundAgentEvidence,
  isIndexedFile,
  verifyQuote,
} from './index.js';

const PATH = '.github/workflows/ci.yml';
const FILE_NODE = {
  id: `file:${PATH}`,
  kind: 'file',
  file: PATH,
  hash: `blake3:${'d'.repeat(64)}`,
} as Node;
const LINES = [
  'name: ci',
  'on: [push]',
  'jobs:',
  '  release-gate:',
  '    runs-on: ubuntu-latest',
  '  verify-matrix:',
  '    needs: release-gate',
];

type Call = { id: string; span?: { start: number; end: number }; startLine?: number };

function port(nodes: Node[] = [FILE_NODE]): GroundingPort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    allNodes: () => nodes,
    rehydrate: (n: Node, opts?: { maxChars?: number; startLine?: number }) => {
      calls.push({
        id: n.id,
        ...(n.span ? { span: n.span } : {}),
        ...(opts?.startLine ? { startLine: opts.startLine } : {}),
      });
      if (!n.span) return { text: '', truncated: false, totalLines: 0, startLine: 0 };
      const from = Math.max(opts?.startLine ?? n.span.start, n.span.start);
      return {
        text: LINES.slice(from - 1).join('\n'),
        truncated: false,
        totalLines: LINES.length,
        startLine: from,
      };
    },
  };
}

function cited(quote: string, line?: number): MemoryEvidence {
  return {
    kind: 'source-quote',
    path: PATH,
    quote,
    ...(line !== undefined ? { line } : {}),
  } as unknown as MemoryEvidence;
}

describe('verifyQuote — a span-less file node spans its own file', () => {
  it('grounds a quote from a config file', () => {
    const p = port();
    expect(verifyQuote(p, FILE_NODE, 'runs-on: ubuntu-latest').verdict).toBe('grounded');
    expect(p.calls[0]?.span?.start).toBe(1);
  });

  it('still reports a quote that is not in the file as ungrounded', () => {
    expect(verifyQuote(port(), FILE_NODE, 'runs-on: windows-latest').verdict).toBe('ungrounded');
  });

  it('does not invent a span for a non-file node that lacks one', () => {
    const symbol = { id: 'sym:x', kind: 'symbol', file: PATH } as Node;
    expect(verifyQuote(port([symbol]), symbol, 'jobs:').verdict).toBe('unsupported');
  });
});

describe('groundAgentEvidence — file-level fallback', () => {
  it('anchors a quote no declaration span holds to the file node, windowed above the cited line', () => {
    const [ev] = groundAgentEvidence(port(), [cited('needs: release-gate', 7)]);
    expect(ev?.soulId).toBe(FILE_NODE.id);
    expect(ev?.targetHash).toBe(FILE_NODE.hash);
    expect(ev?.startLine).toBe(1); // max(1, 7 - 20)
  });

  it('prefers a narrower declaration span when one holds the quote', () => {
    const job = {
      id: 'sym:ci#verify-matrix',
      kind: 'symbol',
      file: PATH,
      span: { start: 6, end: 7 },
      hash: `blake3:${'e'.repeat(64)}`,
    } as Node;
    const [ev] = groundAgentEvidence(port([FILE_NODE, job]), [cited('needs: release-gate', 7)]);
    expect(ev?.soulId).toBe(job.id);
  });

  it('leaves a quote from an unindexed file unanchored', () => {
    const original = { ...cited('jobs:', 3), path: 'not/indexed.yml' } as MemoryEvidence;
    expect(groundAgentEvidence(port(), [original])).toEqual([original]);
  });

  it('isIndexedFile tells "not indexed" apart from "quote not found"', () => {
    expect(isIndexedFile(port(), PATH)).toBe(true);
    expect(isIndexedFile(port(), 'not/indexed.yml')).toBe(false);
  });
});
