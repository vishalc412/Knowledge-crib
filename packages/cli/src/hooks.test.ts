import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChunk } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHooks, mergeDriverFiles } from './hooks.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-hooks-'));
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function gitConfig(key: string): string {
  return execFileSync('git', ['-C', repo, 'config', '--get', key], { encoding: 'utf8' }).trim();
}

describe('installHooks', () => {
  it('writes the post-commit managed block, .gitattributes entry, and merge driver config', () => {
    const res = installHooks(repo);
    expect(existsSync(res.postCommitPath)).toBe(true);
    const hook = readFileSync(res.postCommitPath, 'utf8');
    expect(hook).toContain('crib managed');
    expect(hook).toContain('"crib" update');

    expect(existsSync(res.gitattributesPath)).toBe(true);
    expect(readFileSync(res.gitattributesPath, 'utf8')).toContain('.crib/** merge=kcrib');

    expect(gitConfig('merge.kcrib.driver')).toBe('"crib" merge-driver %O %A %B %P');
  });

  it('is idempotent (managed block + attributes appear exactly once)', () => {
    installHooks(repo);
    installHooks(repo); // second run must not duplicate
    const hook = readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    const occurrences = hook.split('>>> kcrib managed >>>').length - 1;
    expect(occurrences).toBe(1);
    const attrs = readFileSync(join(repo, '.gitattributes'), 'utf8');
    expect(attrs.split('>>> kcrib merge >>>').length - 1).toBe(1);
  });

  it('preserves a pre-existing non-managed hook line', () => {
    writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'echo hello\n');
    installHooks(repo);
    const hook = readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).toContain('echo hello');
    expect(hook).toContain('"crib" update');
  });
});

describe('mergeDriverFiles', () => {
  function write(path: string, records: Array<Record<string, unknown>>): void {
    writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  it('unions disjoint additions from both sides into %A, sorted by id', () => {
    const base = join(repo, 'base.jsonl');
    const ours = join(repo, 'ours.jsonl');
    const theirs = join(repo, 'theirs.jsonl');
    write(base, [{ id: 'file:a.ts', kind: 'file' }]);
    write(ours, [
      { id: 'file:a.ts', kind: 'file' },
      { id: 'sym:a.ts#x@L1', kind: 'symbol', rel: undefined },
    ]);
    write(theirs, [
      { id: 'file:a.ts', kind: 'file' },
      { id: 'sym:b.ts#y@L2', kind: 'symbol', rel: undefined },
    ]);

    const { warnings, conflicts } = mergeDriverFiles(base, ours, theirs);
    expect(conflicts).toBe(false);
    expect(warnings).toHaveLength(0);
    const merged = parseChunk(readFileSync(ours, 'utf8'));
    expect([...merged.keys()].sort()).toEqual(
      ['file:a.ts', 'sym:a.ts#x@L1', 'sym:b.ts#y@L2'].sort(),
    );
  });

  it('auto-resolves an edge conflict (no human review needed)', () => {
    const e = (prov: 'EXTRACTED' | 'INFERRED', conf: number) => ({
      id: 'e:1',
      src: 'sym:b.ts#main@L2',
      dst: 'sym:a.ts#greet@L1',
      rel: 'calls',
      method: 'static',
      provenance: prov,
      confidence: conf,
    });
    const base = join(repo, 'base.jsonl');
    const ours = join(repo, 'ours.jsonl');
    const theirs = join(repo, 'theirs.jsonl');
    write(base, [e('EXTRACTED', 0.5)]);
    write(ours, [e('INFERRED', 0.5)]);
    write(theirs, [e('EXTRACTED', 0.9)]);

    const { conflicts } = mergeDriverFiles(base, ours, theirs);
    expect(conflicts).toBe(false); // edges resolve deterministically — never a hard conflict
    const winner = parseChunk(readFileSync(ours, 'utf8')).get('e:1') as unknown as
      | { provenance: string; confidence: number }
      | undefined;
    expect(winner?.provenance).toBe('EXTRACTED');
    expect(winner?.confidence).toBe(0.9);
  });
});
