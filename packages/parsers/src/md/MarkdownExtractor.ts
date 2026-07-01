/**
 * MarkdownExtractor (Phase 3b) — splits a Markdown file into `doc-section` nodes (one per heading
 * subtree) with `member-of` edges following the heading hierarchy. Code spans + link targets are
 * carried in `meta` as fuel for the cross-modal linker (Phase 4). Text is referenced by span, never
 * copied.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { parseMarkdownSections } from './markdown.js';

export class MarkdownExtractor implements Extractor {
  name = 'doc:markdown';

  private static readonly EXTS = ['.md', '.markdown'];

  supports(file: FileMeta): boolean {
    return MarkdownExtractor.EXTS.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    const text = await ctx.readText();
    const fileId = ctx.idFor('file', { path: file.path });
    const sections = parseMarkdownSections(text);
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const idByIndex: string[] = [];

    for (const s of sections) {
      const id = ctx.idFor('doc-section', { path: file.path, anchor: s.anchor });
      idByIndex.push(id);
      nodes.push({
        id,
        kind: 'doc-section',
        file: file.path,
        heading: s.heading,
        level: s.level,
        anchor: s.anchor,
        span: { start: s.startLine, end: s.endLine },
        lang: 'markdown',
        hash: ctx.hash(`${s.heading}@${s.startLine}-${s.endLine}`),
        meta: { codeRefs: s.codeRefs, links: s.links },
      });
    }

    sections.forEach((s, i) => {
      const childId = idByIndex[i];
      if (!childId) return;
      const parentId = s.parent >= 0 ? idByIndex[s.parent] : fileId;
      if (!parentId) return;
      edges.push({
        id: edgeId(childId, parentId, 'member-of'),
        src: childId,
        dst: parentId,
        rel: 'member-of',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name },
      });
    });

    return { nodes, edges };
  }
}
