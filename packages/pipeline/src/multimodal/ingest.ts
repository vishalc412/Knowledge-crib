/**
 * M13 — turn worker payloads into soul-schema-conformant `media-seg` nodes + `member-of` edges.
 *
 * `ingestStaging` runs the worker for each media path and writes nodes/edges to the soul WITHOUT
 * committing (the caller commits, so a batch can be staged then atomically committed). Each segment
 * becomes:
 *   node  media-seg  id=`media:<path>#<tStartMs>`  hash=blake3(text)  file=<path>
 *                  meta={text, tStart, tEnd, modality, lang?, page?, confidence, extractor,
 *                        extractedBy, unavailable?}
 *
 * G5.3 — every derived node carries full provenance: `extractor` (identity + version of the
 * extraction code), `extractedBy` (the engine that ran: unpdf/pdf.js, tesseract, whisper, or the
 * legacy crib-worker), a measured `confidence`, and for pdf/ocr the source `page`. Nodes are only
 * emitted for real extracted text — an unavailable adapter yields NO node, never fabricated output.
 *   edge  member-of  media-seg → `file:<path>`  static / EXTRACTED / confidence 1
 *
 * The `file:<path>` node already exists (Phase 1 `runStructure` emits one for every non-ignored
 * file, media extensions included), so member-of edges are never dangling. The worker is best-effort
 * (see worker.ts); a degraded payload yields no segments and no throw.
 */
import { join } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { runAdapter } from './adapters.js';
import { runWorker } from './worker.js';
import type { WorkerOpts } from './worker.js';

export interface MultimodalStats {
  /** media files processed. */
  files: number;
  /** `media-seg` nodes emitted. */
  segments: number;
  /** files that yielded no segments (corrupt / missing dep / missing model / worker absent). */
  dropped: number;
}

/** Media file extensions the multimodal phase targets (the worker infers modality from these). */
export const MEDIA_EXTS = [
  '.pdf',
  '.wav',
  '.mp3',
  '.m4a',
  '.flac',
  '.ogg',
  '.mp4',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
];

export function isMediaPath(p: string): boolean {
  const dot = p.lastIndexOf('.');
  return dot >= 0 && MEDIA_EXTS.includes(p.slice(dot).toLowerCase());
}

/**
 * Run the worker for each media path and stage the resulting `media-seg` nodes + `member-of` edges
 * into the soul. Pure write (no commit). Returns counts. Never throws.
 */
export async function ingestStaging(
  soul: SoulStore,
  root: string,
  mediaPaths: string[],
  opts: WorkerOpts = {},
): Promise<MultimodalStats> {
  const stats: MultimodalStats = { files: mediaPaths.length, segments: 0, dropped: 0 };
  if (mediaPaths.length === 0) return stats;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // process sequentially — the worker is a subprocess; a bounded concurrency could be added, but
  // media extraction is off the hot path and determinism favours a stable order.
  for (const mediaPath of mediaPaths) {
    const abs = join(root, mediaPath);
    // G5.3 routing: injected workerFn (tests) > legacy python backends (fake/pdf/audio/image) >
    // the default `auto` TS-native adapters (adapters.ts). `auto` is in-process for PDF (no
    // subprocess at all) and only shells out for OCR/transcription when the binary is present.
    const payload = opts.workerFn
      ? await opts.workerFn(abs)
      : opts.backend && opts.backend !== 'auto'
        ? await runWorker(abs, opts)
        : await runAdapter(abs, opts);
    if (payload.segments.length === 0) {
      stats.dropped++;
      continue;
    }
    const fileId = idFor({ kind: 'file', path: mediaPath });
    for (const seg of payload.segments) {
      const id = idFor({ kind: 'media-seg', path: mediaPath, tStartMs: seg.tStartMs });
      nodes.push({
        id,
        kind: 'media-seg',
        hash: contentHash(seg.text),
        file: mediaPath,
        name: `seg@${seg.tStartMs}`,
        meta: {
          text: seg.text,
          tStart: seg.tStartMs,
          tEnd: seg.tEndMs,
          modality: payload.modality,
          ...(seg.lang ? { lang: seg.lang } : {}),
          // G5.3 provenance on EVERY derived node: extractor identity/version, a confidence, and
          // (pdf/ocr) the source page. 0.5 is the documented fallback when a producer (legacy
          // python payload) did not measure fidelity — unknown, not claimed good.
          confidence: seg.confidence ?? 0.5,
          extractor: payload.extractor ?? 'crib-worker',
          extractedBy: payload.extractedBy ?? 'crib-worker',
          ...(seg.page !== undefined ? { page: seg.page } : {}),
          ...(payload.unavailable ? { unavailable: payload.unavailable } : {}),
        },
      });
      edges.push({
        id: edgeId(id, fileId, 'member-of'),
        src: id,
        dst: fileId,
        rel: 'member-of',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: payload.extractedBy ?? 'crib-worker', modality: payload.modality },
      });
    }
    stats.segments += payload.segments.length;
  }

  if (nodes.length > 0) soul.putNodes(nodes);
  if (edges.length > 0) soul.putEdges(edges);
  return stats;
}
