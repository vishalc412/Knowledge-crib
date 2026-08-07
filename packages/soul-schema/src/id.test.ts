import { describe, expect, it } from 'vitest';
import { edgeId, idFor, idPrefix, slugify } from './id.js';

describe('idFor — all 11 grammars', () => {
  it('file', () => {
    expect(idFor({ kind: 'file', path: 'src/a.ts' })).toBe('file:src/a.ts');
  });
  it('symbol', () => {
    expect(
      idFor({
        kind: 'symbol',
        path: 'src/auth/AuthService.ts',
        qualifiedName: 'AuthService.login',
        startLine: 42,
      }),
    ).toBe('sym:src/auth/AuthService.ts#AuthService.login@L42');
  });
  it('doc-section', () => {
    expect(idFor({ kind: 'doc-section', path: 'docs/auth.md', anchor: 'sessions' })).toBe(
      'doc:docs/auth.md#sessions',
    );
  });
  it('media-seg', () => {
    expect(idFor({ kind: 'media-seg', path: 'm/talk.mp4', tStartMs: 1200 })).toBe(
      'media:m/talk.mp4#1200',
    );
  });
  it('explanation', () => {
    expect(idFor({ kind: 'explanation', path: 'src/a.ts', startLine: 10 })).toBe(
      'expl:src/a.ts@L10',
    );
  });
  it('cluster', () => {
    expect(idFor({ kind: 'cluster', slug: 'auth' })).toBe('c:auth');
  });
  it('table', () => {
    expect(idFor({ kind: 'table', schema: 'HR', name: 'EMP' })).toBe('table:HR.EMP');
  });
  it('column — uses col: prefix, column kind', () => {
    expect(idFor({ kind: 'column', schema: 'HR', table: 'EMP', column: 'SALARY' })).toBe(
      'col:HR.EMP.SALARY',
    );
  });
  it('statement', () => {
    expect(idFor({ kind: 'statement', file: 'p.sql', line: 5 })).toBe('stmt:p.sql@L5');
  });
  it('condition', () => {
    expect(idFor({ kind: 'condition', file: 'p.sql', line: 7 })).toBe('cond:p.sql@L7');
  });
});

describe('idFor — 1.6 AI-artifact grammar', () => {
  it('agent-artifact — art:<path>#<name>', () => {
    expect(
      idFor({ kind: 'agent-artifact', path: '.claude/skills/foo/SKILL.md', name: 'foo' }),
    ).toBe('art:.claude/skills/foo/SKILL.md#foo');
  });
  it('agent-artifact is keyed by path + name (a renamed body keeps the id)', () => {
    const a = idFor({ kind: 'agent-artifact', path: '.claude/agents/bar.md', name: 'bar' });
    const b = idFor({ kind: 'agent-artifact', path: '.claude/agents/bar.md', name: 'bar' });
    expect(a).toBe(b);
    expect(a).toBe('art:.claude/agents/bar.md#bar');
  });
  it('agent-artifact differs by path (a moved file is a new id)', () => {
    expect(
      idFor({ kind: 'agent-artifact', path: '.claude/skills/foo/SKILL.md', name: 'foo' }),
    ).not.toBe(idFor({ kind: 'agent-artifact', path: 'docs/skills/foo.md', name: 'foo' }));
  });
});

describe('edgeId', () => {
  it('is deterministic and prefixed e:', () => {
    const a = edgeId('sym:x', 'sym:y', 'calls');
    const b = edgeId('sym:x', 'sym:y', 'calls');
    expect(a).toBe(b);
    expect(a.startsWith('e:')).toBe(true);
  });
  it('differs by rel', () => {
    expect(edgeId('sym:x', 'sym:y', 'calls')).not.toBe(edgeId('sym:x', 'sym:y', 'references'));
  });
  it('differs by direction', () => {
    expect(edgeId('sym:x', 'sym:y', 'calls')).not.toBe(edgeId('sym:y', 'sym:x', 'calls'));
  });
});

describe('idPrefix', () => {
  it('extracts the prefix', () => {
    expect(idPrefix('sym:src/a.ts#A@L1')).toBe('sym');
    expect(idPrefix('col:HR.EMP.SALARY')).toBe('col');
    expect(idPrefix('malformed')).toBeUndefined();
  });
});

describe('slugify', () => {
  it('normalizes to a clean slug', () => {
    expect(slugify('Auth Service!! ')).toBe('auth-service');
    expect(slugify('Data  --  Flow')).toBe('data-flow');
  });
});
