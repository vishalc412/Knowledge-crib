import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_BODY_MAX_LINES,
  rehydrate,
  rehydrateBody,
} from './snippet.js';

// A 6-line proc body so we can assert full vs truncated rehydration.
const SRC = [
  'function login(user, pass) {', // 1
  '  if (!user) {', // 2
  '    throw new Error("no user");', // 3
  '  }', // 4
  '  return issue(user, pass);', // 5
  '}', // 6
].join('\n');

let repo: string;

function node(span: { start: number; end: number }): Node {
  return { id: 'sym:test', kind: 'symbol', file: 'src/auth.ts', span, hash: 'x' };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-snippet-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'auth.ts'), SRC, 'utf8');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('rehydrate (one-line, list depth)', () => {
  it('returns the first non-blank line, ≤160 chars', () => {
    expect(rehydrate(repo, node({ start: 1, end: 6 }))).toBe('function login(user, pass) {');
  });
  it('returns "" when the node has no file/span', () => {
    expect(rehydrate(repo, { id: 'x', kind: 'symbol', hash: 'x' })).toBe('');
  });
});

describe('rehydrateBody (full span, deep depth)', () => {
  it('returns the FULL span text, not just the first line', () => {
    const b = rehydrateBody(repo, node({ start: 1, end: 6 }));
    expect(b.truncated).toBe(false);
    expect(b.totalLines).toBe(6);
    expect(b.text).toBe(SRC);
  });

  it('truncates by line budget and signals it', () => {
    const b = rehydrateBody(repo, node({ start: 1, end: 6 }), { maxLines: 2 });
    expect(b.truncated).toBe(true);
    expect(b.totalLines).toBe(6);
    expect(b.text).toBe('function login(user, pass) {\n  if (!user) {');
  });

  it('truncates by char budget and signals it', () => {
    const b = rehydrateBody(repo, node({ start: 1, end: 6 }), { maxChars: 10 });
    expect(b.truncated).toBe(true);
    expect(b.text.length).toBe(10);
  });

  it('returns empty + truncated:false when the file is missing', () => {
    const b = rehydrateBody(repo, {
      id: 'x',
      kind: 'symbol',
      file: 'nope.ts',
      span: { start: 1, end: 2 },
      hash: 'x',
    });
    expect(b.text).toBe('');
    expect(b.truncated).toBe(false);
  });

  it('returns empty when the node has no file/span', () => {
    const b = rehydrateBody(repo, { id: 'x', kind: 'symbol', hash: 'x' });
    expect(b.text).toBe('');
    expect(b.truncated).toBe(false);
  });

  it('defaults are exported and finite', () => {
    expect(DEFAULT_BODY_MAX_CHARS).toBeGreaterThan(0);
    expect(DEFAULT_BODY_MAX_LINES).toBeGreaterThan(0);
  });
});

describe('rehydrateBody (line-offset paging)', () => {
  it('opens a page window at startLine and reports the window start', () => {
    const b = rehydrateBody(repo, node({ start: 1, end: 6 }), { startLine: 3, maxLines: 2 });
    expect(b.startLine).toBe(3);
    expect(b.truncated).toBe(true); // lines 3-4 of a 6-line span; more remain
    expect(b.totalLines).toBe(6); // whole span, independent of paging
    expect(b.text).toBe('    throw new Error("no user");\n  }');
    expect(b.nextLine).toBe(5); // absolute line after the last returned (4) → 5
  });

  it('nextLine is the paging cursor: feeding it back as startLine continues the body', () => {
    const page1 = rehydrateBody(repo, node({ start: 1, end: 6 }), { maxLines: 2 });
    expect(page1.startLine).toBe(1);
    expect(page1.nextLine).toBe(3);
    const page2 = rehydrateBody(repo, node({ start: 1, end: 6 }), {
      maxLines: 2,
      startLine: page1.nextLine,
    });
    expect(page2.startLine).toBe(3);
    expect(page2.text).toBe('    throw new Error("no user");\n  }');
    expect(page2.nextLine).toBe(5);
    const page3 = rehydrateBody(repo, node({ start: 1, end: 6 }), {
      maxLines: 2,
      startLine: page2.nextLine,
    });
    expect(page3.startLine).toBe(5);
    expect(page3.truncated).toBe(false); // lines 5-6 reach the span end
    expect(page3.nextLine).toBeUndefined();
    expect(page3.text).toBe('  return issue(user, pass);\n}');
    // concatenating the paged windows reconstructs the whole body
    expect([page1.text, page2.text, page3.text].join('\n')).toBe(SRC);
  });

  it('clamps a startLine beyond the span end into the span (empty page, not an error)', () => {
    const b = rehydrateBody(repo, node({ start: 1, end: 6 }), { startLine: 99, maxLines: 2 });
    expect(b.startLine).toBe(6); // clamped to spanEnd
    expect(b.text).toBe('}');
    expect(b.truncated).toBe(false);
    expect(b.nextLine).toBeUndefined();
  });

  it('char-budget truncation within a window cuts at a line boundary and still yields nextLine', () => {
    const b = rehydrateBody(repo, node({ start: 1, end: 6 }), { maxLines: 6, maxChars: 45 });
    expect(b.truncated).toBe(true);
    expect(b.startLine).toBe(1);
    expect(b.nextLine).toBeGreaterThanOrEqual(2);
    // text never exceeds the char budget
    expect(b.text.length).toBeLessThanOrEqual(45);
  });
});
