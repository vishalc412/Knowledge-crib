/**
 * M7 semantic linker pass — the INFERRED counterpart to the deterministic linker (Phase 4). Runs ONLY
 * when `IndexOpts.semantic` is set, AFTER {@link runLink}, and emits `references` edges (never
 * `describes`) for (doc-section, symbol) pairs the deterministic signals missed.
 *
 * Contract vs the deterministic core:
 *   - method `'semantic'` (rank 4, weakest) + provenance `'INFERRED'` — so `--extracted-only` is the
 *     pure deterministic subset and deterministic precision is untouched;
 *   - confidence capped to [0.4, 0.6] — strictly below the 0.8 `describes` threshold, so a semantic
 *     hit can never promote a pair to `describes` or override a stronger deterministic method;
 *   - never duplicates an existing describes/references edge for the same (section, symbol).
 *
 * Graceful-degrade: pure JS TF-IDF, no network; an empty/short corpus yields no candidates → no edges,
 * and the deterministic linker is unaffected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import { parseMarkdownSections } from '@knowledge-crib/parsers';
import { edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge } from '@knowledge-crib/soul-schema';
import { TfidfIndex } from './tfidf.js';

export interface SemanticStats {
  /** INFERRED references edges added by the semantic pass. */
  added: number;
}

/** Minimum cosine similarity to consider a (section, symbol) pair. */
const FLOOR = 0.1;
/** Top-K symbols retrieved per doc-section. */
const TOP_K = 5;
/** Confidence floor/ceiling — capped below the 0.8 describes threshold. */
const CONF_FLOOR = 0.4;
const CONF_CEIL = 0.6;

/**
 * Emit INFERRED `references` edges for doc-sections → symbols via TF-IDF similarity, skipping any pair
 * already linked (describes or references) by the deterministic pass. `docFiles` (M6) scopes the emit
 * while the TF-IDF index still spans the whole soul.
 */
export function runSemanticLink(soul: SoulStore, root: string, docFiles?: string[]): SemanticStats {
  const tfidf = new TfidfIndex(soul.iterate('symbol'));
  if (tfidf.size === 0) return { added: 0 };

  // existing (sectionId, symbolId) pairs — skip duplicates so semantic only fills gaps.
  const existing = new Set<string>();
  for (const rel of ['describes', 'references'] as const) {
    for (const e of soul.iterateEdges(rel)) existing.add(`${e.src}|${e.dst}`);
  }

  const scope = docFiles ? new Set(docFiles) : undefined;
  const docFilesInScope = new Map<string, true>();
  for (const node of soul.iterate('doc-section')) {
    if (node.file && (!scope || scope.has(node.file))) docFilesInScope.set(node.file, true);
  }

  const edges: Edge[] = [];
  for (const docFile of docFilesInScope.keys()) {
    let text: string;
    try {
      text = readFileSync(join(root, docFile), 'utf8');
    } catch {
      continue;
    }
    for (const section of parseMarkdownSections(text)) {
      const sectionId = idFor({ kind: 'doc-section', path: docFile, anchor: section.anchor });
      const query = `${section.heading} ${section.prose} ${section.codeRefs.join(' ')}`;
      for (const hit of tfidf.query(query, FLOOR, TOP_K)) {
        if (existing.has(`${sectionId}|${hit.id}`)) continue; // deterministic already linked this pair
        const confidence = Math.min(CONF_CEIL, CONF_FLOOR + (CONF_CEIL - CONF_FLOOR) * hit.score);
        edges.push({
          id: edgeId(sectionId, hit.id, 'references'),
          src: sectionId,
          dst: hit.id,
          rel: 'references',
          method: 'semantic',
          provenance: 'INFERRED',
          confidence: round2(confidence),
          evidence: { by: 'tfidf', score: round2(hit.score) },
        });
      }
    }
  }

  if (edges.length > 0) soul.putEdges(edges);
  return { added: edges.length };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
