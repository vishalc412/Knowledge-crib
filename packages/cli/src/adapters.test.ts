import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_BEGIN,
  ADAPTER_END,
  ALL_CLIENTS,
  type ClientId,
  clientAdapter,
  installInstructions,
  listInstructions,
  neutralProtocolBody,
  removeAdapterBlock,
  removeInstructions,
  skillDestFor,
  spliceAdapterBlock,
} from './adapters.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-adapters-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('CLIENT_ADAPTERS — registry completeness', () => {
  it('has all 7 clients in a stable order', () => {
    expect(ALL_CLIENTS).toEqual([
      'claude',
      'cursor',
      'copilot',
      'vscode',
      'codex',
      'windsurf',
      'gemini',
    ]);
  });

  it('every client resolves a valid project-scope target (except vscode, which has none)', () => {
    for (const id of ALL_CLIENTS) {
      const adapter = clientAdapter(id);
      const targets = adapter.instructionTargets('project', repo);
      if (id === 'vscode') {
        expect(targets, `${id} should have no instruction target`).toBeNull();
      } else {
        expect(targets, `${id} should have a target`).not.toBeNull();
        expect(targets!.length).toBe(1);
        expect(targets![0]!.path.startsWith(repo)).toBe(true);
      }
    }
  });

  it('global scope yields no instruction targets for every client', () => {
    for (const id of ALL_CLIENTS) {
      expect(clientAdapter(id).instructionTargets('global', repo)).toBeNull();
    }
  });

  it('only claude and cursor have a skill destination', () => {
    expect(skillDestFor('claude', '/home/u')).toBe('/home/u/.claude/skills');
    expect(skillDestFor('cursor', '/home/u')).toBe('/home/u/.cursor/rules');
    for (const id of ALL_CLIENTS) {
      if (id !== 'claude' && id !== 'cursor')
        expect(skillDestFor(id, '/home/u'), `${id}`).toBeNull();
    }
  });
});

describe('neutralProtocolBody — vendor-neutral contract', () => {
  it('names the brief tool and the no-self-evaluate + non-destructive rules', () => {
    const body = neutralProtocolBody();
    expect(body).toContain('`brief`');
    expect(body).toMatch(/never self-evaluate/i);
    expect(body).toMatch(/non-destructive/i);
    expect(body).toContain('.crib/memory/');
    expect(body).toMatch(/removing this adapter/i);
  });
});

describe('spliceAdapterBlock — managed-block discipline', () => {
  const block = `${ADAPTER_BEGIN}\nbody\n${ADAPTER_END}`;

  it('appends the block on a fresh file with a separating newline', () => {
    expect(spliceAdapterBlock('hello', block)).toBe(`hello\n${block}\n`);
    expect(spliceAdapterBlock('', block)).toBe(`${block}\n`);
    expect(spliceAdapterBlock('hello\n', block)).toBe(`hello\n${block}\n`);
  });

  it('replaces an existing block in place, preserving sibling content byte-for-byte', () => {
    const before = 'TOP\n';
    const after = '\nBOTTOM\n';
    const existing = `${before}${ADAPTER_BEGIN}\nold\n${ADAPTER_END}${after}`;
    const out = spliceAdapterBlock(existing, block);
    expect(out).toBe(`${before}${block}\n${after.replace(/^\n/, '')}`);
    expect(out).toContain('TOP');
    expect(out).toContain('BOTTOM');
    expect(out).not.toContain('old');
  });

  it('is idempotent — splicing the same block twice yields the same bytes', () => {
    const once = spliceAdapterBlock('sibling\n', block);
    const twice = spliceAdapterBlock(once, block);
    expect(twice).toBe(once);
  });

  it('removeAdapterBlock strips the block and leaves sibling content intact', () => {
    const existing = `TOP\n${ADAPTER_BEGIN}\nbody\n${ADAPTER_END}\nBOTTOM\n`;
    expect(removeAdapterBlock(existing)).toBe('TOP\nBOTTOM\n');
    expect(removeAdapterBlock('no block here')).toBe('no block here');
  });
});

describe('installInstructions — non-destructive writes', () => {
  it('installs all clients (--client all) and reports vscode as a no-target note', () => {
    const results = installInstructions(repo, { client: 'all', scope: 'project' });
    expect(results.length).toBe(ALL_CLIENTS.length);
    // vscode has no instruction target → empty path + note.
    const vscode = results.find((r) => r.client === 'vscode')!;
    expect(vscode.path).toBe('');
    expect(vscode.written).toBe(false);
    expect(vscode.note).toBeDefined();
    // the other six each wrote a file with the managed block present.
    for (const id of ALL_CLIENTS.filter((c) => c !== 'vscode') as ClientId[]) {
      const r = results.find((x) => x.client === id)!;
      expect(r.written, `${id}`).toBe(true);
      expect(existsSync(r.path), `${id} file`).toBe(true);
      expect(readFileSync(r.path, 'utf8')).toContain(ADAPTER_BEGIN);
    }
  });

  it('preserves sibling user content outside the managed block', () => {
    // Pre-existing AGENTS.md with a GitNexus block + user prose must survive.
    const agentsPath = join(repo, 'AGENTS.md');
    writeFileSync(
      agentsPath,
      '# My repo\n\nSome user instructions.\n\n<!-- gitnexus:start -->\nGN\n<!-- gitnexus:end -->\n',
    );
    installInstructions(repo, { client: 'codex', scope: 'project' });
    const out = readFileSync(agentsPath, 'utf8');
    expect(out).toContain('# My repo');
    expect(out).toContain('Some user instructions.');
    expect(out).toContain('<!-- gitnexus:start -->');
    expect(out).toContain('GN');
    expect(out).toContain(ADAPTER_BEGIN);
    // crib block placed AFTER the existing content (append path).
    expect(out.indexOf('gitnexus:end')).toBeLessThan(out.indexOf(ADAPTER_BEGIN));
  });

  it('writes Cursor frontmatter on a fresh .mdc and preserves user frontmatter on refresh', () => {
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const mdc = join(repo, '.cursor', 'rules', 'crib.mdc');
    const out = readFileSync(mdc, 'utf8');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('alwaysApply: true');
    expect(out).toContain(ADAPTER_BEGIN);
    // user-edited frontmatter is preserved on refresh (not overwritten with the crib default).
    writeFileSync(mdc, '---\ndescription: custom\nalwaysApply: false\n---\n\nuser body\n');
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const refreshed = readFileSync(mdc, 'utf8');
    expect(refreshed).toContain('description: custom');
    expect(refreshed).toContain('alwaysApply: false');
    expect(refreshed).toContain('user body');
    expect(refreshed).toContain(ADAPTER_BEGIN);
  });

  it('is idempotent — a second install reports written:false and changes no bytes', () => {
    installInstructions(repo, { client: 'claude', scope: 'project' });
    const p = join(repo, 'CLAUDE.md');
    const first = readFileSync(p, 'utf8');
    const second = installInstructions(repo, { client: 'claude', scope: 'project' });
    expect(second[0]!.written).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(first);
  });
});

describe('removeInstructions — non-destructive removal (memory not in these files)', () => {
  it('removes the managed block and leaves sibling user content', () => {
    const p = join(repo, 'CLAUDE.md');
    writeFileSync(p, `# Mine\n\n${ADAPTER_BEGIN}\nx\n${ADAPTER_END}\n\nKeep me\n`);
    const out = removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(out[0]!.written).toBe(true);
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('# Mine');
    expect(after).toContain('Keep me');
    expect(after).not.toContain(ADAPTER_BEGIN);
  });

  it('deletes a crib-owned file left empty after removal (no user content)', () => {
    installInstructions(repo, { client: 'gemini', scope: 'project' });
    const p = join(repo, 'GEMINI.md');
    expect(existsSync(p)).toBe(true);
    removeInstructions(repo, { client: 'gemini', scope: 'project' });
    expect(existsSync(p), 'empty GEMINI.md should be deleted').toBe(false);
  });

  it('deletes a Cursor rule left frontmatter-only after removal', () => {
    installInstructions(repo, { client: 'cursor', scope: 'project' });
    const mdc = join(repo, '.cursor', 'rules', 'crib.mdc');
    expect(existsSync(mdc)).toBe(true);
    removeInstructions(repo, { client: 'cursor', scope: 'project' });
    // frontmatter-only after block removal → deleted (crib-owned rule, no user body).
    expect(existsSync(mdc)).toBe(false);
  });

  it('removing one client leaves the others + memory intact', () => {
    installInstructions(repo, { client: 'all', scope: 'project' });
    removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    // sibling instruction files untouched.
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(repo, 'GEMINI.md'))).toBe(true);
    expect(existsSync(join(repo, '.github', 'copilot-instructions.md'))).toBe(true);
    // and a second remove of the same client is a no-op.
    const again = removeInstructions(repo, { client: 'claude', scope: 'project' });
    expect(again[0]!.written).toBe(false);
  });
});

describe('listInstructions — status report', () => {
  it('reports absent before install and present after', () => {
    const before = listInstructions(repo, { client: 'all', scope: 'project' });
    expect(before.every((e) => !e.present)).toBe(true);
    installInstructions(repo, { client: 'all', scope: 'project' });
    const after = listInstructions(repo, { client: 'all', scope: 'project' });
    // vscode has no target → not listed; the other six are present.
    expect(after.length).toBe(ALL_CLIENTS.length - 1);
    expect(after.every((e) => e.present)).toBe(true);
  });
});
