import { describe, expect, it } from 'vitest';
import { createParserHandle, grammarsNeededFor, preloadGrammars } from './tree-sitter-pool.js';
import type { FileMeta } from './types.js';

function file(path: string): FileMeta {
  return { path, lang: undefined, bytes: 0, mtime: 0 };
}

describe('grammarsNeededFor (lazy pool — never pay for a grammar a repo never uses)', () => {
  it('returns [] for a file set with no PHP files', () => {
    expect(grammarsNeededFor([file('src/a.ts'), file('src/b.go')])).toEqual([]);
  });

  it('returns ["php"] when any file has a .php extension', () => {
    expect(grammarsNeededFor([file('src/a.ts'), file('src/legacy/login.php')])).toEqual(['php']);
  });
});

describe('createParserHandle (sync accessor over the async-preloaded pool)', () => {
  it('throws a clear error when the grammar was never preloaded', () => {
    expect(() => createParserHandle('not-a-real-grammar')).toThrow(/was not preloaded/);
  });

  it('returns a working handle after preloadGrammars resolves', async () => {
    await preloadGrammars(['php']);
    const handle = createParserHandle('php');
    const tree = handle.parse('<?php function f() { return 1; }') as {
      rootNode: { type: string; namedChildren: Array<{ type: string }> };
    };
    expect(tree.rootNode.type).toBe('program');
    expect(tree.rootNode.namedChildren.some((c) => c.type === 'function_definition')).toBe(true);
  });

  it('preloadGrammars([]) is a true no-op (does not throw, does not require a grammar)', async () => {
    await expect(preloadGrammars([])).resolves.toBeUndefined();
  });
});
