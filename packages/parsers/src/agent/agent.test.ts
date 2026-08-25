/**
 * W1 — unit tests for the pure AI-artifact helpers: bounded frontmatter parsing, artifact
 * classification (path + frontmatter override), name inference (SKILL.md→dir name), and the
 * per-file `extractArtifact` transform (one `agent-artifact` node + governs/requires/invokes refs).
 * These are deterministic + side-effect-free, so they're tested in isolation from the pipeline phase.
 */
import { idFor } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import { artifactName, classifyArtifact, extractArtifact } from './agent-graph.js';
import { parseFrontmatter } from './frontmatter.js';

const hash = `blake3:${'0'.repeat(64)}`;
const idFn = (parts: { path: string; name: string }): string =>
  idFor({ kind: 'agent-artifact', path: parts.path, name: parts.name });

describe('parseFrontmatter', () => {
  it('parses scalars, block lists, and flow lists; returns the body + body start line', () => {
    const text = [
      '---',
      'name: auth-skill',
      'tags: [a, b, c]',
      'appliesTo:',
      '  - AuthService.login',
      '---',
      '',
      '# body',
    ].join('\n');
    const { fields, body, bodyStartLine } = parseFrontmatter(text);
    expect(fields.name).toBe('auth-skill');
    expect(fields.tags).toEqual(['a', 'b', 'c']);
    expect(fields.appliesTo).toEqual(['AuthService.login']);
    expect(body.trim()).toBe('# body');
    expect(bodyStartLine).toBeGreaterThan(0);
  });

  it('never throws on unterminated / missing fence — whole text is the body, fields empty', () => {
    const text = '---\nname: x\nno closing fence';
    const { fields, body } = parseFrontmatter(text);
    expect(Object.keys(fields)).toHaveLength(0);
    expect(body).toBe(text);
  });

  it('no frontmatter → empty fields, whole text as body', () => {
    const { fields, body } = parseFrontmatter('# just a doc\n\nno yaml');
    expect(Object.keys(fields)).toHaveLength(0);
    expect(body).toBe('# just a doc\n\nno yaml');
  });
});

describe('classifyArtifact', () => {
  it('uses a valid frontmatter artifactType override', () => {
    expect(classifyArtifact('any/path.md', { artifactType: 'command' })).toBe('command');
  });
  it('ignores an invalid frontmatter type and falls back to path rules', () => {
    expect(classifyArtifact('docs/skills/x/SKILL.md', { artifactType: 'bogus' })).toBe('skill');
  });
  it('path rules: /skills/→skill, /agents/→agent, /commands/→command, /rules/→rule, .cursor/rules→rule', () => {
    expect(classifyArtifact('.claude/skills/x/SKILL.md', {})).toBe('skill');
    expect(classifyArtifact('docs/agents/r.md', {})).toBe('agent');
    expect(classifyArtifact('.claude/commands/c.md', {})).toBe('command');
    expect(classifyArtifact('docs/rules/r.md', {})).toBe('rule');
    expect(classifyArtifact('.cursor/rules/r.md', {})).toBe('rule');
  });
  it('defaults to instruction for AGENTS.md / unclassified markdown', () => {
    expect(classifyArtifact('AGENTS.md', {})).toBe('instruction');
    expect(classifyArtifact('README.md', {})).toBe('instruction');
  });
});

describe('artifactName', () => {
  it('frontmatter name wins', () => {
    expect(artifactName('docs/skills/x/SKILL.md', { name: 'my-skill' })).toBe('my-skill');
  });
  it('SKILL.md → enclosing dir name (the real artifact identity)', () => {
    expect(artifactName('.claude/skills/auth-skill/SKILL.md', {})).toBe('auth-skill');
  });
  it('AGENTS.md → enclosing dir when nested', () => {
    expect(artifactName('pkg/AGENTS.md', {})).toBe('pkg');
  });
  it('other files → filename stem', () => {
    expect(artifactName('docs/agents/reviewer.md', {})).toBe('reviewer');
  });
});

describe('extractArtifact', () => {
  it('emits one agent-artifact node + frontmatter governs/requires/invokes refs', () => {
    const text = [
      '---',
      'name: auth-skill',
      'artifactType: skill',
      'appliesTo:',
      '  - AuthService.login',
      'requires:',
      '  - other-skill',
      'invokes:',
      '  - mcp:reviewer',
      '---',
      '',
      '# auth-skill',
    ].join('\n');
    const { node, refs } = extractArtifact('.claude/skills/auth-skill/SKILL.md', text, hash, idFn);
    expect(node.kind).toBe('agent-artifact');
    expect(node.artifactType).toBe('skill');
    expect(node.name).toBe('auth-skill');
    expect(node.id).toBe('art:.claude/skills/auth-skill/SKILL.md#auth-skill');
    expect(node.meta?.hasFrontmatter).toBe(true);

    const byRel = (rel: string) => refs.filter((r) => r.rel === rel);
    expect(byRel('governs').map((r) => r.raw)).toContain('AuthService.login');
    expect(byRel('requires').map((r) => r.raw)).toContain('other-skill');
    expect(byRel('invokes').map((r) => r.raw)).toContain('mcp:reviewer');
    // frontmatter refs are method 'frontmatter' + high confidence
    expect(byRel('governs')[0]?.method).toBe('frontmatter');
    expect(byRel('governs')[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('body code refs with . / # → governs explicit; bare words are skipped (the W1 "edges" guard)', () => {
    const text = '# s\n\nSee `AuthService.login` and `edges` and `src/x.ts`.';
    const { refs } = extractArtifact('AGENTS.md', text, hash, idFn);
    const raws = refs.filter((r) => r.method === 'explicit').map((r) => r.raw);
    expect(raws).toContain('AuthService.login');
    expect(raws).toContain('src/x.ts');
    expect(raws).not.toContain('edges'); // bare word, no . / #
  });

  it('body markdown links → governs link (anchor kept, http/mailto excluded)', () => {
    const text =
      '# s\n\n[auth](src/auth.ts) and [sessions](docs/auth.md#sessions) and [ext](https://x.com).';
    const { refs } = extractArtifact('AGENTS.md', text, hash, idFn);
    const links = refs.filter((r) => r.method === 'link').map((r) => r.raw);
    expect(links).toContain('src/auth.ts');
    expect(links).toContain('docs/auth.md#sessions');
    expect(links.some((l) => l.startsWith('https://'))).toBe(false);
  });
});
