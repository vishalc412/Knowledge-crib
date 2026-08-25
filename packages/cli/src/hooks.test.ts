import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChunk } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkKindForPath, installHooks, mergeDriverFiles } from './hooks.js';

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
    const attrs = readFileSync(res.gitattributesPath, 'utf8');
    // soul chunks → kcrib; memory chunks → kcrib-memory; JSON manifests get no merge= attr.
    expect(attrs).toContain('.crib/**/*.jsonl merge=kcrib');
    expect(attrs).toContain('.crib/memory/team/**/*.jsonl merge=kcrib-memory');
    // memory line must come AFTER the broad soul line so last-match-wins resolves memory paths.
    expect(attrs.indexOf('.crib/memory/team/**/*.jsonl merge=kcrib-memory')).toBeGreaterThan(
      attrs.indexOf('.crib/**/*.jsonl merge=kcrib'),
    );

    expect(gitConfig('merge.kcrib.driver')).toBe('"crib" merge-driver %O %A %B %P');
    expect(gitConfig('merge.kcrib-memory.driver')).toBe('"crib" merge-driver %O %A %B %P');
  });

  it('routes team-memory JSONL to kcrib-memory and leaves JSON manifests unattributed', () => {
    installHooks(repo);
    // A canonical extracted shard maps to kcrib; a team-memory shard maps to kcrib-memory; a
    // JSON manifest matches neither merge pattern → normal git text merge (unspecified).
    const checkAttr = (p: string): string => {
      const out = execFileSync('git', ['-C', repo, 'check-attr', 'merge', '--', p], {
        encoding: 'utf8',
      }).trim();
      const line = out.split('\n')[0] ?? '';
      return line.includes(': ') ? (line.split(': ').slice(-1)[0] ?? 'unspecified') : 'unspecified';
    };
    mkdirSync(join(repo, '.crib', 'graph', 'extracted', 'nodes'), { recursive: true });
    mkdirSync(join(repo, '.crib', 'memory', 'team', 'records'), { recursive: true });
    writeFileSync(join(repo, '.crib', 'graph', 'extracted', 'nodes', '00.jsonl'), '');
    writeFileSync(join(repo, '.crib', 'memory', 'team', 'records', '00.jsonl'), '');
    writeFileSync(join(repo, '.crib', 'crib.json'), '{}');
    expect(checkAttr('.crib/graph/extracted/nodes/00.jsonl')).toBe('kcrib');
    expect(checkAttr('.crib/memory/team/records/00.jsonl')).toBe('kcrib-memory');
    expect(checkAttr('.crib/crib.json')).toBe('unspecified');
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

describe('chunkKindForPath', () => {
  it('classifies memory-team paths as memory and everything else as soul', () => {
    expect(chunkKindForPath('.crib/memory/team/records/00.jsonl')).toBe('memory');
    expect(chunkKindForPath('.crib/memory/team/decisions/01.jsonl')).toBe('memory');
    expect(chunkKindForPath('.crib/memory/team/receipts/ff.jsonl')).toBe('memory');
    expect(chunkKindForPath('/abs/repo/.crib/memory/team/records/00.jsonl')).toBe('memory');
    expect(chunkKindForPath('.crib/graph/extracted/nodes/00.jsonl')).toBe('soul');
    expect(chunkKindForPath('.crib/nodes/00.jsonl')).toBe('soul');
    expect(chunkKindForPath(undefined)).toBe('soul');
  });

  it('treats windows-style backslash paths correctly', () => {
    expect(chunkKindForPath('repo\\.crib\\memory\\team\\records\\00.jsonl')).toBe('memory');
  });
});

describe('mergeDriverFiles (memory dispatch)', () => {
  function write(path: string, records: Array<Record<string, unknown>>): void {
    writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  const memPath = '.crib/memory/team/records/00.jsonl';

  it('unions disjoint memory records by content id (no conflict)', () => {
    const base = join(repo, 'base.jsonl');
    const ours = join(repo, 'ours.jsonl');
    const theirs = join(repo, 'theirs.jsonl');
    write(base, [{ id: 'mem:aaa', kind: 'fact' }]);
    write(ours, [
      { id: 'mem:aaa', kind: 'fact' },
      { id: 'mem:bbb', kind: 'pitfall' },
    ]);
    write(theirs, [
      { id: 'mem:aaa', kind: 'fact' },
      { id: 'mem:ccc', kind: 'convention' },
    ]);

    const { warnings, conflicts } = mergeDriverFiles(base, ours, theirs, memPath);
    expect(conflicts).toBe(false);
    expect(warnings).toHaveLength(0);
    const merged = parseChunk(readFileSync(ours, 'utf8'));
    expect([...merged.keys()].sort()).toEqual(['mem:aaa', 'mem:bbb', 'mem:ccc'].sort());
  });

  it('hard-conflicts on same id with different content (writes conflict markers)', () => {
    const base = join(repo, 'base.jsonl');
    const ours = join(repo, 'ours.jsonl');
    const theirs = join(repo, 'theirs.jsonl');
    write(base, [{ id: 'mem:aaa', kind: 'fact', claim: 'same' }]);
    write(ours, [{ id: 'mem:aaa', kind: 'fact', claim: 'ours-version' }]);
    write(theirs, [{ id: 'mem:aaa', kind: 'fact', claim: 'theirs-version' }]);

    const { warnings, conflicts } = mergeDriverFiles(base, ours, theirs, memPath);
    expect(conflicts).toBe(true);
    expect(warnings.some((w) => w.includes('mem:aaa') && w.includes('hard conflict'))).toBe(true);
    const out = readFileSync(ours, 'utf8');
    expect(out).toContain('<<<<<<< ours (mem:aaa)');
    expect(out).toContain('ours-version');
    expect(out).toContain('>>>>>>> theirs (mem:aaa)');
    expect(out).toContain('theirs-version');
  });

  it('fails (does not silently skip) on a malformed memory line', () => {
    const base = join(repo, 'base.jsonl');
    const ours = join(repo, 'ours.jsonl');
    const theirs = join(repo, 'theirs.jsonl');
    writeFileSync(base, '{"id":"mem:aaa","kind":"fact"}\n');
    writeFileSync(ours, '{"id":"mem:aaa","kind":"fact"}\nnot-json-at-all\n');
    writeFileSync(theirs, '{"id":"mem:aaa","kind":"fact"}\n');

    const { warnings, conflicts } = mergeDriverFiles(base, ours, theirs, memPath);
    expect(conflicts).toBe(true);
    expect(warnings.some((w) => w.includes('malformed') && w.includes('not-json'))).toBe(true);
    const out = readFileSync(ours, 'utf8');
    expect(out).toContain('malformed input');
  });

  it('surfaces a logical conflict when ours supersedes and theirs retracts the same subject', () => {
    const base = join(repo, 'base.jsonl');
    const ours = join(repo, 'ours.jsonl');
    const theirs = join(repo, 'theirs.jsonl');
    write(base, [{ id: 'mem:rec', kind: 'fact' }]);
    write(ours, [
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-ours', kind: 'supersede', subject: 'mem:rec' },
    ]);
    write(theirs, [
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-theirs', kind: 'retract', subject: 'mem:rec' },
    ]);

    const { warnings, conflicts } = mergeDriverFiles(base, ours, theirs, memPath);
    // both decision events survive (distinct ids) — NOT a hard conflict, but a logical one.
    expect(conflicts).toBe(false);
    expect(warnings.some((w) => w.includes('logical conflict') && w.includes('mem:rec'))).toBe(
      true,
    );
    const merged = parseChunk(readFileSync(ours, 'utf8'));
    expect([...merged.keys()].sort()).toEqual(['mem:dec-ours', 'mem:dec-theirs', 'mem:rec'].sort());
  });
});
