/**
 * M13 — the cross-modal media linker: `media-seg` → `symbol` `describes` / `references` edges.
 *
 * A media segment (transcript line / OCR page) is plain prose, but transcripts and OCR of technical
 * content frequently name symbols by their qualified name (`AuthService.login`, `util.parseConfig`).
 * To pick those up with the *same* deterministic signals as the doc linker, each segment is turned into
 * a pseudo-{@link MdSection}: dotted refs in the text become `codeRefs` (→ explicit signal, conf 0.95),
 * the full text becomes `prose` (→ identifier signal, conf 0.6/0.8 sibling-boosted), and the same
 * {@link scoreLink} decides `describes` (conf ≥ 0.8, explicit/identifier) vs `references`.
 *
 * No path signal — transcripts carry no Markdown links. Provenance EXTRACTED; evidence names the
 * linker + a text snippet. Pure write (caller commits).
 */
import type { SoulStore } from '@knowledge-crib/core';
import type { MdSection } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge } from '@knowledge-crib/soul-schema';
import { InvertedIndex } from './inverted-index.js';
import { scoreLink } from './score.js';
import { explicitSignal, identifierSignal } from './signals.js';
import type { SignalHit } from './signals.js';

export interface MediaLinkStats {
  describes: number;
  references: number;
}

/** A qualified-name-shaped token: `Foo.bar`, `Foo.bar.baz` (≥2 dotted parts). Bare names are left to
 *  the identifier signal; a trailing `()` is stripped by `explicitSignal`, so we don't capture it. */
const DOTTED_REF = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;

/** Pull dotted qualified-name refs out of prose so the explicit signal can match them. */
export function extractDotted(text: string): string[] {
  return [...new Set((text.match(DOTTED_REF) ?? []).map((t) => t.trim()))];
}

/**
 * Link every `media-seg` to symbols via the deterministic signals. Returns counts by rel.
 * `mediaFiles` (optional) scopes the emit to a set of repo-relative media paths while the InvertedIndex
 * still spans the whole soul — so an incremental re-ingest re-links only refreshed segments.
 */
export function runMediaLink(
  soul: SoulStore,
  threshold?: number,
  mediaFiles?: string[],
): MediaLinkStats {
  const index = new InvertedIndex(soul);
  const scope = mediaFiles ? new Set(mediaFiles) : undefined;

  const edges: Edge[] = [];
  const stats: MediaLinkStats = { describes: 0, references: 0 };

  for (const seg of soul.iterate('media-seg')) {
    if (seg.file && scope && !scope.has(seg.file)) continue;
    const text = String(seg.meta?.text ?? '');
    if (!text) continue;

    // synthesize an MdSection so the existing signals + scorer apply unchanged
    const section: MdSection = {
      heading: seg.name ?? 'media-seg',
      level: 1,
      anchor: seg.id,
      startLine: 1,
      endLine: 1,
      parent: -1,
      codeRefs: extractDotted(text),
      links: [],
      prose: text,
    };

    const bySymbol = new Map<string, SignalHit[]>();
    const allHits = [...explicitSignal(section, index), ...identifierSignal(section, index)];
    for (const hit of allHits) {
      const list = bySymbol.get(hit.symbol.id) ?? [];
      list.push(hit);
      bySymbol.set(hit.symbol.id, list);
    }

    for (const [symbolId, hits] of bySymbol) {
      const scored = scoreLink(hits, threshold);
      if (!scored) continue;
      edges.push({
        id: edgeId(seg.id, symbolId, scored.rel),
        src: seg.id,
        dst: symbolId,
        rel: scored.rel,
        method: scored.method,
        provenance: 'EXTRACTED',
        confidence: scored.confidence,
        evidence: { by: 'media-linker', snippet: snippet(text) },
      });
      if (scored.rel === 'describes') stats.describes++;
      else stats.references++;
    }
  }

  if (edges.length > 0) soul.putEdges(edges);
  return stats;
}

/** A short, deterministic snippet of the segment text for edge evidence. */
function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}
