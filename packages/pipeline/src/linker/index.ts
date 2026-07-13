/**
 * Phase 4 — the deterministic cross-modal linker (the differentiator). Produces `describes` /
 * `references` edges from `doc-section` to `symbol`, each carrying method/provenance/confidence/
 * evidence. Signals 1–3 only (EXTRACTED); the semantic signal (INFERRED, capped) lands at M7 as a
 * separate pass after the vector index exists, so the deterministic core never depends on vectors.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import { parseMarkdownSections } from '@knowledge-crib/parsers';
import { edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge } from '@knowledge-crib/soul-schema';
import { InvertedIndex } from './inverted-index.js';
import { scoreLink } from './score.js';
import { explicitSignal, identifierSignal, pathSignal } from './signals.js';
import type { SignalHit } from './signals.js';

export { InvertedIndex } from './inverted-index.js';
export { runMediaLink } from './media.js';
export type { MediaLinkStats } from './media.js';
export { runSemanticLink } from './semantic.js';
export type { SemanticStats, SemanticMode, SemanticLinkOpts } from './semantic.js';
export { EmbeddingLinkIndex } from './embedding.js';
export { TfidfIndex, tokenize } from './tfidf.js';
// re-exported so the media linker (and future cross-modal passes) reuse the exact same signals + scorer
// as the deterministic doc→symbol linker — one scoring path, no drift.
export { scoreLink } from './score.js';
export type { ScoredLink } from './score.js';
export { explicitSignal, identifierSignal, pathSignal } from './signals.js';
export type { SignalHit } from './signals.js';

export interface LinkStats {
  describes: number;
  references: number;
}

/**
 * Phase 4: link doc-sections to symbols and persist the edges. Returns counts by rel.
 *
 * `docFiles` (optional, M6) scopes the emit to a set of repo-relative doc paths while the InvertedIndex
 * still spans the whole soul — so an incremental update re-links only changed/reverse-dep docs without
 * disturbing the rest. Omitted → link every doc-section (full index).
 */
export function runLink(
  soul: SoulStore,
  root: string,
  threshold?: number,
  docFiles?: string[],
): LinkStats {
  const index = new InvertedIndex(soul);

  // group doc-section nodes by file (optionally restricted to `docFiles`)
  const scope = docFiles ? new Set(docFiles) : undefined;
  const docFilesInScope = new Map<string, true>();
  for (const node of soul.iterate('doc-section')) {
    if (node.file && (!scope || scope.has(node.file))) docFilesInScope.set(node.file, true);
  }

  const edges: Edge[] = [];
  const stats: LinkStats = { describes: 0, references: 0 };

  for (const docFile of docFilesInScope.keys()) {
    let text: string;
    try {
      text = readFileSync(join(root, docFile), 'utf8');
    } catch {
      continue;
    }
    for (const section of parseMarkdownSections(text)) {
      const sectionId = idFor({ kind: 'doc-section', path: docFile, anchor: section.anchor });
      // gather signals, grouped by target symbol id
      const bySymbol = new Map<string, SignalHit[]>();
      const allHits = [
        ...explicitSignal(section, index),
        ...identifierSignal(section, index),
        ...pathSignal(section, docFile, index),
      ];
      for (const hit of allHits) {
        const list = bySymbol.get(hit.symbol.id) ?? [];
        list.push(hit);
        bySymbol.set(hit.symbol.id, list);
      }
      for (const [symbolId, hits] of bySymbol) {
        const scored = scoreLink(hits, threshold);
        if (!scored) continue;
        edges.push({
          id: edgeId(sectionId, symbolId, scored.rel),
          src: sectionId,
          dst: symbolId,
          rel: scored.rel,
          method: scored.method,
          provenance: 'EXTRACTED',
          confidence: scored.confidence,
          evidence: { by: 'deterministic-linker', snippet: section.heading },
        });
        if (scored.rel === 'describes') stats.describes++;
        else stats.references++;
      }
    }
  }

  if (edges.length > 0) soul.putEdges(edges);
  return stats;
}
