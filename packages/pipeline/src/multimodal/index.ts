/**
 * M13 — the multimodal phase orchestrator. Runs the offline `crib_worker` subprocess for every media
 * file in the repo (PDF / image / whisper audio), stages `media-seg` nodes + `member-of` edges
 * ({@link ingestStaging}), then links those segments to code symbols via the deterministic media
 * linker ({@link runMediaLink}), and flips `capabilities.multimodal` on in the manifest.
 *
 * Pure-TS safety: this phase is OFF by default (`indexRepo` only runs it when `opts.multimodal` is
 * set; `crib index` / `serve` never spawn a subprocess). A missing worker, missing model, or corrupt
 * media all degrade to an empty segment list — the phase never aborts the pipeline.
 */
import type { SoulStore } from '@knowledge-crib/core';
import { runMediaLink } from '../linker/index.js';
import type { MediaLinkStats } from '../linker/index.js';
import { discoverFiles } from '../structure.js';
import { adapterStatuses } from './adapters.js';
import type { AdapterStatus } from './adapters.js';
import { ingestStaging, isMediaPath } from './ingest.js';
import type { MultimodalStats } from './ingest.js';
import type { WorkerOpts } from './worker.js';

// G5.3 — public surface for the production adapters (doctor/status report availability; the CLI
// passes backend opts through). The legacy fake/python surface stays on worker.ts.
export {
  adapterForPath,
  adapterStatuses,
  inferModality,
  runAdapter,
  TRANSCRIBE_EXTRACTOR,
  OCR_EXTRACTOR,
  PDF_TEXT_EXTRACTOR,
} from './adapters.js';
export type {
  AdapterId,
  AdapterOpts,
  AdapterPayload,
  AdapterSegment,
  AdapterStatus,
} from './adapters.js';

export interface MultimodalPhaseOpts extends WorkerOpts {
  /** run the media→symbol linker after ingest (default true). */
  link?: boolean;
  /** media→symbol persist threshold (default 0.4, same as the doc linker). */
  linkThreshold?: number;
}

export interface MultimodalReport {
  ingest: MultimodalStats;
  link: MediaLinkStats;
  /** G5.3: which production adapters were usable on this machine during the run (honest why-not). */
  availability: AdapterStatus[];
}

/**
 * Run the multimodal phase: ingest media segments then link them to symbols. Pure write + manifest
 * mutation (caller commits). `mediaPaths` may be supplied by a caller that already walked the repo
 * (the pipeline does); omitted → this walks via {@link discoverFiles}.
 */
export async function runMultimodal(
  soul: SoulStore,
  root: string,
  opts: MultimodalPhaseOpts = {},
  mediaPaths?: string[],
): Promise<MultimodalReport> {
  const paths =
    mediaPaths ??
    discoverFiles(root)
      .filter((f) => isMediaPath(f.path))
      .map((f) => f.path);
  const { link = true, linkThreshold, ...workerOpts } = opts;
  const ingest = await ingestStaging(soul, root, paths, workerOpts);
  const linkStats = link
    ? runMediaLink(soul, linkThreshold, paths)
    : { describes: 0, references: 0 };
  // flip the capability only when we actually produced segments — a fully-degraded run (no worker,
  // no models) leaves the manifest honest: no media nodes, capability stays false.
  if (ingest.segments > 0) soul.setCapabilities({ multimodal: true });
  return { ingest, link: linkStats, availability: adapterStatuses() };
}
