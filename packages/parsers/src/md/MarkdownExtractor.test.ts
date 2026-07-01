import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, FileMeta } from '../types.js';
import { MarkdownExtractor } from './MarkdownExtractor.js';
import { parseMarkdownSections } from './markdown.js';

const DOC = [
  '# Guide',
  '',
  'Intro with `AuthService.login` reference and a [link](../src/x.ts).',
  '',
  '## Setup',
  '',
  'Steps here.',
  '',
  '### Detail',
  '',
  'More.',
].join('\n');

function ctx(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('n/a');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

describe('MarkdownExtractor', () => {
  it('emits one doc-section per heading with anchors + levels', async () => {
    const meta: FileMeta = { path: 'docs/guide.md', lang: 'markdown', bytes: DOC.length, mtime: 0 };
    const { nodes, edges } = await new MarkdownExtractor().extract(meta, ctx(DOC));
    expect(nodes.map((n) => n.anchor)).toEqual(['guide', 'setup', 'detail']);
    expect(nodes.map((n) => n.level)).toEqual([1, 2, 3]);
    // member-of hierarchy: detail→setup, setup→guide, guide→file
    const fileId = idFor({ kind: 'file', path: 'docs/guide.md' });
    const parentOf = (anchor: string) => {
      const id = nodes.find((n) => n.anchor === anchor)?.id;
      return edges.find((e) => e.src === id)?.dst;
    };
    expect(parentOf('detail')).toBe(nodes.find((n) => n.anchor === 'setup')?.id);
    expect(parentOf('setup')).toBe(nodes.find((n) => n.anchor === 'guide')?.id);
    expect(parentOf('guide')).toBe(fileId);
  });

  it('captures code refs and links as linker fuel', () => {
    const [intro] = parseMarkdownSections(DOC);
    expect(intro?.codeRefs).toContain('AuthService.login');
    expect(intro?.links).toContain('../src/x.ts');
  });

  it('gives duplicate headings unique anchors', () => {
    const sections = parseMarkdownSections('# A\n\n## Dup\n\ntext\n\n## Dup\n\nmore\n');
    expect(sections.map((s) => s.anchor)).toEqual(['a', 'dup', 'dup-2']);
  });
});
