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
 * M2.3 — the similarity backend is pluggable:
 *   - `'embedding'` (default): char-n-gram embedding cosine (linker/embedding.ts). Generalizes across
 *     inflection/case/affix where TF-IDF's exact-token match sees no shared term.
 *   - `'tfidf'`: the M7 TF-IDF cosine (linker/tfidf.ts). Retained for the recall-up gate's baseline
 *     and as a graceful-degrade fallback if an embedder is ever unavailable.
 *
 * Graceful-degrade: pure JS, no network; an empty/short corpus yields no candidates → no edges, and
 * the deterministic linker is unaffected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import { parseMarkdownSections } from '@knowledge-crib/parsers';
import { edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge } from '@knowledge-crib/soul-schema';
import { EmbeddingLinkIndex } from './embedding.js';
import { TfidfIndex } from './tfidf.js';

export interface SemanticStats {
  /** INFERRED references edges added by the semantic pass. */
  added: number;
}

/** Which similarity backend the semantic linker uses. */
export type SemanticMode = 'embedding' | 'tfidf';

/** Options for {@link runSemanticLink}. */
export interface SemanticLinkOpts {
  /** Similarity backend; `'embedding'` (M2.3 default) or `'tfidf'` (M7 baseline). */
  mode?: SemanticMode;
}

/** A link index exposes the same surface the linker loop needs, regardless of backend. */
interface LinkIndex {
  readonly size: number;
  query(queryText: string, floor: number, k: number): Array<{ id: string; score: number }>;
}

/** Minimum similarity to consider a (section, symbol) pair. TF-IDF scores 0 when no term is shared,
 *  so 0.1 is a near-zero floor. char-n-gram cosine has a higher unrelated-text baseline — common
 *  n-grams ("th", "he", "e …") give unrelated short texts ~0.15–0.33 — so the embedding floor is set
 *  just above that band to keep only genuine lexical/inflection overlap. Both floors sit well below
 *  the [0.4, 0.6] confidence cap, so neither backend can promote a pair to `describes`. */
const FLOOR_TFIDF = 0.1;
const FLOOR_EMBEDDING = 0.35;
/** Top-K symbols retrieved per doc-section. */
const TOP_K = 5;
/** Confidence floor/ceiling — capped below the 0.8 describes threshold. */
const CONF_FLOOR = 0.4;
const CONF_CEIL = 0.6;

/**
 * Emit INFERRED `references` edges for doc-sections → symbols via the configured similarity backend,
 * skipping any pair already linked (describes or references) by the deterministic pass. `docFiles`
 * (M6) scopes the emit while the link index still spans the whole soul.
 */
export function runSemanticLink(
  soul: SoulStore,
  root: string,
  docFiles?: string[],
  opts: SemanticLinkOpts = {},
): SemanticStats {
  const mode = opts.mode ?? 'embedding';
  const index: LinkIndex =
    mode === 'tfidf'
      ? new TfidfIndex(soul.iterate('symbol'))
      : new EmbeddingLinkIndex(soul.iterate('symbol'));
  const floor = mode === 'tfidf' ? FLOOR_TFIDF : FLOOR_EMBEDDING;
  if (index.size === 0) return { added: 0 };

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
      for (const hit of index.query(query, floor, TOP_K)) {
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
          evidence: { by: mode, score: round2(hit.score) },
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
