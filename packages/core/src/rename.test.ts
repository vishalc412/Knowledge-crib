import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from './manifest.js';
import { applyRenamePlan, buildRenamePlan } from './rename.js';
import { SoulStore } from './soul-store.js';

let root: string;
let soul: SoulStore;
let greet: Node;
let main: Node;

/** A minimal symbol node anchored to a real file under the temp repo root. */
function symbolNode(path: string, name: string, startLine: number): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: name, startLine }),
    kind: 'symbol',
    type: 'function',
    name,
    qualifiedName: name,
    file: path,
    span: { start: startLine, end: startLine + 2 },
    lang: 'typescript',
    hash: contentHash(`${path}#${name}`),
  };
}

function callEdge(src: Node, dst: Node, provenance: 'EXTRACTED' | 'INFERRED'): Edge {
  return {
    id: edgeId(src.id, dst.id, 'calls'),
    src: src.id,
    dst: dst.id,
    rel: 'calls',
    method: 'static',
    provenance,
    confidence: provenance === 'EXTRACTED' ? 1 : 0.4,
    evidence: { by: 'test' },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-rename-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src/auth.ts'),
    ['export function verifyToken(t: string): boolean {', '  return t.length > 0;', '}', ''].join(
      '\n',
    ),
    'utf8',
  );
  writeFileSync(
    join(root, 'src/caller.ts'),
    [
      'import { verifyToken } from "./auth.js";',
      'export function main(t: string): boolean {',
      '  return verifyToken(t);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(root, 'docs.md'),
    ['# docs', '', 'verifyToken is the token check (a text hit, not a code reference).', ''].join(
      '\n',
    ),
    'utf8',
  );
  soul = new SoulStore(join(root, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
  greet = symbolNode('src/auth.ts', 'verifyToken', 1);
  main = symbolNode('src/caller.ts', 'main', 2);
  soul.putNodes([greet, main]);
  soul.putEdges([callEdge(main, greet, 'EXTRACTED')]);
  soul.commit('2026-01-01T00:00:00.000Z');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function planFor(from: string, to: string, scanFiles?: string[]) {
  const outcome = buildRenamePlan({
    soul,
    repoRoot: root,
    from,
    to,
    ...(scanFiles !== undefined ? { scanFiles } : {}),
  });
  if (!outcome.ok) throw new Error(`plan failed: ${outcome.code} ${outcome.message}`);
  return outcome.plan;
}

describe('buildRenamePlan (G5.1)', () => {
  it('rejects an unknown symbol and identical from/to', () => {
    const missing = buildRenamePlan({ soul, repoRoot: root, from: 'nope', to: 'other' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');
    const same = buildRenamePlan({ soul, repoRoot: root, from: 'verifyToken', to: 'verifyToken' });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.code).toBe('INVALID');
  });

  it('dry-run plan classifies the definition + edge-grounded caller as exact and the doc hit as inferred', () => {
    const plan = planFor('verifyToken', 'checkToken', ['src/auth.ts', 'src/caller.ts', 'docs.md']);
    const byPath = new Map(plan.files.map((f) => [f.path, f]));
    // definition file: exact
    expect(byPath.get('src/auth.ts')?.edits).toBe(1);
    expect(byPath.get('src/auth.ts')?.sites[0]?.kind).toBe('definition');
    expect(byPath.get('src/auth.ts')?.sites[0]?.confidence).toBe('exact');
    // resolved caller file: exact reference grounded by the EXTRACTED edge
    expect(byPath.get('src/caller.ts')?.edits).toBe(2); // import + call
    expect(byPath.get('src/caller.ts')?.sites.every((s) => s.confidence === 'exact')).toBe(true);
    // doc hit: inferred, flagged
    expect(byPath.get('docs.md')?.edits).toBe(1);
    expect(byPath.get('docs.md')?.sites[0]?.confidence).toBe('inferred');
    expect(byPath.get('docs.md')?.sites[0]?.kind).toBe('text');
    expect(plan.counts).toEqual({ exact: 3, inferred: 1, files: 3, edits: 4 });
    expect(plan.unresolved).toHaveLength(0);
  });

  it('plan id is deterministic and changes when any planned file changes', () => {
    const a = planFor('verifyToken', 'checkToken', ['src/auth.ts', 'src/caller.ts']);
    const b = planFor('verifyToken', 'checkToken', ['src/auth.ts', 'src/caller.ts']);
    expect(a.planId).toBe(b.planId);
    expect(a.planId.startsWith('rename:')).toBe(true);
    // a changed file → a different plan body → a different id (the stale-plan basis)
    writeFileSync(
      join(root, 'src/auth.ts'),
      'export function verifyToken(t: string): boolean {\n  return t !== "";\n}\n',
      'utf8',
    );
    const c = planFor('verifyToken', 'checkToken', ['src/auth.ts', 'src/caller.ts']);
    expect(c.planId).not.toBe(a.planId);
  });

  it('an inferred-only dependent lands in the unresolved bucket with the risk note', () => {
    const phantom = symbolNode('src/phantom.ts', 'phantom', 1);
    soul.putNodes([phantom]);
    soul.putEdges([callEdge(phantom, greet, 'INFERRED')]);
    soul.commit('2026-01-01T00:00:00.000Z');
    const plan = planFor('verifyToken', 'checkToken', ['src/auth.ts']);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0]?.id).toBe(phantom.id);
    expect(plan.unresolved[0]?.riskNote).toContain('risk unresolved');
    expect(plan.notes.some((n) => n.includes('unresolved'))).toBe(true);
  });

  it('an empty resolved-caller set is flagged as NOT evidence the symbol is unused', () => {
    soul.putNodes([symbolNode('src/solo.ts', 'solo', 1)]);
    soul.commit('2026-01-01T00:00:00.000Z');
    writeFileSync(join(root, 'src/solo.ts'), 'export function solo(): void {}\n', 'utf8');
    const plan = planFor('solo', 'renamedSolo', ['src/solo.ts']);
    expect(plan.affected).toHaveLength(0);
    expect(plan.notes.some((n) => n.includes('NOT evidence the symbol is unused'))).toBe(true);
  });

  it('resolves a node-id --from but rewrites the simple name', () => {
    const plan = planFor(greet.id, 'checkToken', ['src/auth.ts']);
    expect(plan.target.id).toBe(greet.id);
    expect(plan.notes.some((n) => n.includes('simple name'))).toBe(true);
    expect(plan.files[0]?.edits).toBe(1);
  });

  it('word-boundary matching never touches a longer identifier', () => {
    writeFileSync(
      join(root, 'src/wide.ts'),
      'const verifyToken = 1;\nconst verifyTokenEx = 2;\nconst myverifyToken = 3;\n',
      'utf8',
    );
    const plan = planFor('verifyToken', 'checkToken', ['src/wide.ts']);
    // bare verifyToken hits once; verifyTokenEx and myverifyToken are boundary-guarded out
    expect(plan.files[0]?.edits).toBe(1);
  });
});

describe('applyRenamePlan (G5.1)', () => {
  it('applies all planned files, keeps --to literal ($-safe), and is word-boundary exact', () => {
    const plan = planFor('verifyToken', '$check', ['src/auth.ts', 'src/caller.ts']);
    const result = applyRenamePlan(plan, root, plan.planId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filesChanged).toBe(2);
    expect(result.edits).toBe(3);
    const auth = readFileSync(join(root, 'src/auth.ts'), 'utf8');
    expect(auth).toContain('export function $check(');
    const caller = readFileSync(join(root, 'src/caller.ts'), 'utf8');
    expect(caller).toContain('import { $check }');
    expect(caller).toContain('$check(t)');
    // the literal replacement: a naive replace would have corrupted $check via $-group semantics
    expect(auth).toContain('$check');
  });

  it('rejects a stale plan when a file hash differs and a mismatched plan id', () => {
    const plan = planFor('verifyToken', 'checkToken', ['src/auth.ts', 'src/caller.ts']);
    // wrong id first
    const mismatch = applyRenamePlan(plan, root, 'rename:deadbeef');
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.code).toBe('PLAN_MISMATCH');
    expect(mismatch.message).toContain('re-run the dry run');
    // then a genuinely changed file
    writeFileSync(
      join(root, 'src/auth.ts'),
      'export function verifyToken(t: string): boolean {\n  return true;\n}\n',
      'utf8',
    );
    const stale = applyRenamePlan(plan, root, plan.planId);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('STALE_PLAN');
    expect(stale.message).toContain('changed since the plan');
    expect(stale.message).toContain('re-run the dry run');
    // nothing was written by either failure
    expect(readFileSync(join(root, 'src/caller.ts'), 'utf8')).toContain('verifyToken');
  });

  it('rolls back atomically when one write fails — the net effect is nothing changed', () => {
    const plan = planFor('verifyToken', 'checkToken', ['src/auth.ts', 'src/caller.ts']);
    // files apply in sorted order: src/auth.ts < src/caller.ts. Make the LAST one unwritable AFTER
    // the plan was taken (phase 1 only needs read access, so the stale check still passes).
    chmodSync(join(root, 'src/caller.ts'), 0o444);
    try {
      const result = applyRenamePlan(plan, root, plan.planId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('IO');
      expect(result.rolledBack).toContain('src/auth.ts');
      // every byte is back exactly as the plan found it
      expect(readFileSync(join(root, 'src/auth.ts'), 'utf8')).toContain('verifyToken');
      expect(readFileSync(join(root, 'src/caller.ts'), 'utf8')).toContain('verifyToken');
      expect(readFileSync(join(root, 'src/auth.ts'), 'utf8')).not.toContain('checkToken');
    } finally {
      chmodSync(join(root, 'src/caller.ts'), 0o644);
    }
  });

  it('refuses when the file no longer yields the planned edit count', () => {
    const plan = planFor('verifyToken', 'checkToken', ['src/auth.ts']);
    // Drive the count arm directly: keep the plan id and the (matching) content hash, tamper only
    // with the planned edit count — apply must notice the mismatch rather than silently writing.
    const tampered = { ...plan, files: plan.files.map((f) => ({ ...f, edits: f.edits + 1 })) };
    const result = applyRenamePlan(tampered, root, plan.planId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('STALE_PLAN');
    expect(result.message).toContain('no longer yields');
    expect(readFileSync(join(root, 'src/auth.ts'), 'utf8')).toContain('verifyToken');
  });
});
