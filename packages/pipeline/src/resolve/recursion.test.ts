import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stampRecursion } from './index.js';

/**
 * stampRecursion is the language-agnostic backstop that surfaces self-recursion as
 * `meta.recursive = true` (self-call EDGES are never emitted — cycle avoidance). Every extractor
 * records call sites on `meta.calls` as `{ callee, line }` and retains the self-call site, so one
 * pass catches both intra-file (`this.m()` / bare `m()` / `self.m`) and cross-file self-recursion
 * for all 6 languages. These tests cover TS / Java / C# / Go / Rust / Python intra + a cross-file
 * case, plus a non-recursive control and a same-name-different-proc guard against false positives.
 */

let cribDir: string;
let soul: SoulStore;

function sym(path: string, q: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: q, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: q.split(/[.:]/).filter(Boolean).pop() ?? q,
    qualifiedName: q,
    file: path,
    span: { start: line, end: line + 1 },
    hash: contentHash(q),
    ...extra,
  };
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-recur-'));
  soul = new SoulStore(cribDir, {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('stampRecursion — language-agnostic self-recursion flag', () => {
  it('flags intra-file self-recursion across TS / Java / C# / Go / Rust / Python call shapes', () => {
    const procs: Node[] = [
      // TS: `this.factorial(n-1)` inside `factorial` → callee recorded as `factorial`.
      sym('src/ts.ts', 'Math.factorial', 5, {
        type: 'method',
        lang: 'typescript',
        meta: { calls: [{ callee: 'factorial', line: 8 }] },
      }),
      // Java: bare `fib(n-1)` self-call.
      sym('src/Fib.java', 'Fib.fib', 3, {
        type: 'method',
        lang: 'java',
        meta: { calls: [{ callee: 'fib', line: 6 }] },
      }),
      // C#: `this.Power` self-call (qualified callee shape).
      sym('src/Power.cs', 'Calc.Power', 4, {
        type: 'method',
        lang: 'csharp',
        meta: { calls: [{ callee: 'Calc.Power', line: 7 }] },
      }),
      // Go: bare `walk` self-call.
      sym('src/tree.go', 'walk', 12, {
        type: 'function',
        lang: 'go',
        meta: { calls: [{ callee: 'walk', line: 15 }] },
      }),
      // Rust: `self::descend` self-call (`::` separators).
      sym('src/node.rs', 'descend', 20, {
        type: 'function',
        lang: 'rust',
        meta: { calls: [{ callee: 'self::descend', line: 24 }] },
      }),
      // Python: `self.visit` self-call.
      sym('src/visitor.py', 'Visitor.visit', 8, {
        type: 'method',
        lang: 'python',
        meta: { calls: [{ callee: 'self.visit', line: 11 }] },
      }),
    ];
    soul.putNodes(procs);

    const stamped = stampRecursion(soul);
    expect(stamped).toBe(6);
    for (const p of procs) {
      const live = soul.getNode(p.id);
      expect(live?.meta?.recursive).toBe(true);
    }
  });

  it('flags cross-file self-recursion (qualified callee resolves to the same proc in another file)', () => {
    // The proc lives in a.lib.sql but is referenced by its package-qualified name from a caller file.
    const target = sym('a/lib.sql', 'PKG.DO_WORK', 10, {
      type: 'procedure',
      lang: 'plsql',
      meta: { calls: [{ callee: 'PKG.DO_WORK', line: 14 }] },
    });
    soul.putNodes([target]);
    expect(stampRecursion(soul)).toBe(1);
    expect(soul.getNode(target.id)?.meta?.recursive).toBe(true);
  });

  it('does NOT flag a proc that calls a different same-named proc (no false positive)', () => {
    // A.foo calls B.foo — both method name `foo`, same file, but different procs.
    const aFoo = sym('src/x.ts', 'A.foo', 3, {
      type: 'method',
      lang: 'typescript',
      meta: { calls: [{ callee: 'B.foo', line: 5 }] },
    });
    const bFoo = sym('src/x.ts', 'B.foo', 9, { type: 'method', lang: 'typescript' });
    soul.putNodes([aFoo, bFoo]);
    expect(stampRecursion(soul)).toBe(0);
    expect(soul.getNode(aFoo.id)?.meta?.recursive).toBeUndefined();
    expect(soul.getNode(bFoo.id)?.meta?.recursive).toBeUndefined();
  });

  it('leaves a non-recursive caller (calls a leaf, not itself) unflagged', () => {
    const caller = sym('src/c.ts', 'App.run', 3, {
      type: 'method',
      lang: 'typescript',
      meta: { calls: [{ callee: 'helper', line: 5 }] },
    });
    const leaf = sym('src/h.ts', 'helper', 1, { type: 'function', lang: 'typescript' });
    soul.putNodes([caller, leaf]);
    expect(stampRecursion(soul)).toBe(0);
    expect(soul.getNode(caller.id)?.meta?.recursive).toBeUndefined();
  });

  it('is idempotent (re-stamping a proc already flagged by an extractor does not double-count)', () => {
    const p = sym('src/p.ts', 'A.loop', 3, {
      type: 'method',
      lang: 'typescript',
      meta: { recursive: true, calls: [{ callee: 'loop', line: 5 }] },
    });
    soul.putNodes([p]);
    expect(stampRecursion(soul)).toBe(0); // already flagged → no new stamp
    expect(soul.getNode(p.id)?.meta?.recursive).toBe(true);
  });
});
