/**
 * G5.3 — production extraction adapters (TS-native, offline). The default multimodal backend
 * (`auto`) routes each media file to one of three adapters, all of which fail HONEST: a missing
 * binary, an unconfigured model, or a decode failure produces an empty segment list plus an
 * `unavailable` reason — never fabricated content.
 *
 *   pdf         in-process pure-JS text-layer extraction (unpdf → pdf.js, bundled dep, no binary).
 *   image-ocr   the `tesseract` CLI when present on PATH; absent → unavailable.
 *   transcribe  the `whisper` CLI (openai-whisper) when present on PATH AND a local model dir is
 *               configured (a named model would be fetched over the network — never allowed).
 *
 * Availability is separately surfaced via {@link adapterStatuses} (consumed by `crib doctor` and
 * `crib status`). The multimodal phase itself stays default OFF (safety: the default index/serve
 * path must never touch media or spawn a subprocess) — these adapters only run under the explicit
 * `--multimodal` opt-in.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { WorkerPayload } from './worker.js';

/** One extracted segment; extends the python-worker segment with TS-adapter provenance. */
export interface AdapterSegment {
  tStartMs: number;
  tEndMs: number;
  text: string;
  lang?: string | null;
  /** pdf: 0-based page index — the source span for text-layer extraction (no byte offsets exist). */
  page?: number;
  /** 0..1 extractor self-assessed fidelity; every derived node must carry one (see per-adapter docs). */
  confidence: number;
}

/** What an adapter returns: a WorkerPayload plus the provenance stamped onto every node's meta. */
export interface AdapterPayload extends WorkerPayload {
  /** extractor identity + version, e.g. `pdf-text@1.0.0` (our extraction code, versioned independently). */
  extractor: string;
  /** the concrete engine that ran, e.g. `unpdf (pdf.js)` / `tesseract` / `whisper`. */
  extractedBy: string;
  /** honest reason nothing was extracted (binary absent, model unconfigured, decode failed). */
  unavailable?: string;
}

/** The three production adapters (the `fake` backend and the legacy python worker live in worker.ts). */
export type AdapterId = 'pdf' | 'image-ocr' | 'transcribe';

/** Per-adapter availability for `crib doctor` / `crib status` — count-agnostic, always answerable. */
export interface AdapterStatus {
  id: AdapterId;
  available: boolean;
  /** why usable, or the honest why-not. */
  reason: string;
}

export interface AdapterOpts {
  /** local whisper model dir/file for the transcribe adapter; never fetched over the network. */
  modelPath?: string;
  /** per-file hard backstop for subprocess adapters (default: OCR 60s, whisper 10min). */
  timeoutMs?: number;
  /** OCR language pack (default `eng`). */
  ocrLang?: string;
}

/** Extractor identities — versioned independently of the package so a meta change is detectable. */
export const PDF_TEXT_EXTRACTOR = 'pdf-text@1.0.0';
export const OCR_EXTRACTOR = 'tesseract-ocr@1.0.0';
export const TRANSCRIBE_EXTRACTOR = 'whisper-json@1.0.0';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'];
const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg'];

/** Modality for a media path (mirrors the python worker's inference; the ingest meta stamps it). */
export function inferModality(p: string): 'pdf' | 'image' | 'audio' | 'video' | null {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = p.slice(dot).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === '.mp4') return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return null;
}

/** Which adapter handles a media path (null → no production adapter; the phase drops the file). */
export function adapterForPath(p: string): AdapterId | null {
  switch (inferModality(p)) {
    case 'pdf':
      return 'pdf';
    case 'image':
      return 'image-ocr';
    case 'audio':
    case 'video':
      return 'transcribe';
    default:
      return null;
  }
}

/**
 * Availability of every production adapter on THIS machine. Spawns `--version`/`--help` probes —
 * cheap, offline, and only called by doctor/status/report paths, never the default index.
 */
export function adapterStatuses(): AdapterStatus[] {
  const tesseract = detectBinary('tesseract', ['--version']);
  const whisper = detectBinary('whisper', ['--help']);
  return [
    {
      id: 'pdf',
      available: true,
      reason: 'bundled pure-JS pdf.js text-layer extraction (unpdf) — no external binary',
    },
    tesseract
      ? { id: 'image-ocr', available: true, reason: `tesseract ${tesseract} on PATH` }
      : { id: 'image-ocr', available: false, reason: 'tesseract not found on PATH' },
    whisper
      ? {
          id: 'transcribe',
          available: true,
          reason: `whisper ${whisper} on PATH (needs a local --multimodal-model-path; a named model would be fetched over the network)`,
        }
      : { id: 'transcribe', available: false, reason: 'whisper not found on PATH' },
  ];
}

/**
 * Run the production adapter for one absolute media path. Always resolves (never rejects): any
 * failure → an honest payload with `unavailable` set and zero segments, mirroring runWorker's
 * degrade-don't-throw contract.
 */
export async function runAdapter(
  mediaAbsPath: string,
  opts: AdapterOpts = {},
): Promise<AdapterPayload> {
  try {
    switch (adapterForPath(mediaAbsPath)) {
      case 'pdf':
        return await extractPdfText(mediaAbsPath);
      case 'image-ocr':
        return ocrImage(mediaAbsPath, opts);
      case 'transcribe':
        return transcribe(mediaAbsPath, opts);
      default:
        return {
          schemaVersion: '1.1',
          file: mediaAbsPath,
          modality: 'unknown',
          segments: [],
          dropped: 1,
          extractor: 'none',
          extractedBy: 'none',
          unavailable: 'no production adapter for this extension',
        };
    }
  } catch (err) {
    // defensive: a bug in one adapter must never abort the phase (same posture as runWorker)
    return {
      schemaVersion: '1.1',
      file: mediaAbsPath,
      modality: inferModality(mediaAbsPath) ?? 'unknown',
      segments: [],
      dropped: 1,
      extractor: 'none',
      extractedBy: 'none',
      unavailable: `adapter crashed: ${(err as Error).message}`,
    };
  }
}

/** Probe a binary with cheap args; returns its version string, or null when absent/broken. */
function detectBinary(bin: string, args: string[]): string | null {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0) return null;
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const m = /(?:tesseract|whisper)\s+v?(\d[\w.\-+]*)/.exec(out);
  return m?.[1] ?? 'unknown';
}

/** Unavailable-payload helper (keeps each adapter under 50 lines). */
function unavail(
  file: string,
  modality: string,
  extractor: string,
  extractedBy: string,
  reason: string,
): AdapterPayload {
  return {
    schemaVersion: '1.1',
    file,
    modality,
    segments: [],
    dropped: 1,
    extractor,
    extractedBy,
    unavailable: reason,
  };
}

/**
 * PDF text-layer extraction — the TS-native default for "index my docs". unpdf (MIT, zero runtime
 * deps, bundles pdf.js) decodes the text each page EMBEDS; one segment per page, tStartMs = page
 * index × 1000ms (same convention as the legacy python pdf backend). Confidence 0.95: the text is
 * the document's own layer (not OCR), but CMap/encoding quirks can garble it — not claimed perfect.
 * Scanned-image-only PDFs yield no text (honest empty), no OCR fallback by design.
 */
async function extractPdfText(abs: string): Promise<AdapterPayload> {
  const PAGE_MS = 1000;
  try {
    // lazy import — keeps pdf.js (a few MB) off the default index/serve import path entirely
    const { extractText } = await import('unpdf');
    const { totalPages, text } = await extractText(new Uint8Array(readFileSync(abs)), {
      mergePages: false,
    });
    const segments: AdapterSegment[] = [];
    for (let i = 0; i < totalPages; i++) {
      const body = (text[i] ?? '').trim();
      if (body) {
        segments.push({
          tStartMs: i * PAGE_MS,
          tEndMs: (i + 1) * PAGE_MS,
          text: body,
          lang: 'en',
          page: i,
          confidence: 0.95,
        });
      }
    }
    return {
      schemaVersion: '1.1',
      file: abs,
      modality: 'pdf',
      segments,
      dropped: segments.length === 0 ? 1 : 0,
      extractor: PDF_TEXT_EXTRACTOR,
      extractedBy: 'unpdf (pdf.js)',
    };
  } catch (err) {
    return unavail(
      abs,
      'pdf',
      PDF_TEXT_EXTRACTOR,
      'unpdf (pdf.js)',
      `decode failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Image OCR via the `tesseract` CLI when present. One TSV call serves both text and confidence: word
 * rows (level 5) group into lines, and confidence is the mean word confidence (0..1) — measured, not
 * invented. tStartMs/tEndMs stay 0 (an image has no timeline); `page` carries the TSV page number.
 */
function ocrImage(abs: string, opts: AdapterOpts): AdapterPayload {
  const EXTRACTOR = OCR_EXTRACTOR;
  const BY = 'tesseract';
  const version = detectBinary('tesseract', ['--version']);
  if (!version) {
    return unavail(abs, 'image', EXTRACTOR, BY, 'tesseract not found on PATH');
  }
  // outputbase `stdout` + the `tsv` config file → TSV on stdout (level/page/line/conf/text columns)
  const r = spawnSync(
    'tesseract',
    [abs, 'stdout', '-l', opts.ocrLang ?? 'eng', '--psm', '3', 'tsv'],
    { encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? `exit ${r.status}`;
    return unavail(abs, 'image', EXTRACTOR, BY, `tesseract failed: ${why}`);
  }
  const lines = parseTesseractTsv(r.stdout ?? '');
  if (lines.length === 0) {
    return {
      schemaVersion: '1.1',
      file: abs,
      modality: 'image',
      segments: [],
      dropped: 1,
      extractor: EXTRACTOR,
      extractedBy: BY,
      unavailable: 'tesseract ran but detected no text',
    };
  }
  return {
    schemaVersion: '1.1',
    file: abs,
    modality: 'image',
    segments: lines.map((l) => ({
      tStartMs: 0,
      tEndMs: 0,
      text: l.text,
      lang: opts.ocrLang ?? 'eng',
      page: l.page,
      confidence: l.confidence,
    })),
    dropped: 0,
    extractor: EXTRACTOR,
    extractedBy: `tesseract ${version}`,
  };
}

/** One grouped OCR line from the TSV: page index, joined words, mean word confidence. */
interface OcrLine {
  page: number;
  text: string;
  confidence: number;
}

/**
 * Parse tesseract TSV output. Rows are `level page block par line word … conf text`; level 5 rows
 * are words, grouped by their (page, block, par, line) key in file order. Confidence = mean of the
 * non-negative word confs (tesseract uses −1 for structural rows) scaled to 0..1.
 */
function parseTesseractTsv(tsv: string): OcrLine[] {
  const rows = tsv.split('\n').map((line) => line.split('\t'));
  const header = rows[0] ?? [];
  const col = (name: string): number => header.indexOf(name);
  const levelCol = col('level');
  const pageCol = col('page_num');
  const lineCol = col('line_num');
  const confCol = col('conf');
  const textCol = col('text');
  if (levelCol < 0 || pageCol < 0 || lineCol < 0 || confCol < 0 || textCol < 0) return [];
  const groups = new Map<string, { page: number; words: string[]; confs: number[] }>();
  for (const row of rows.slice(1)) {
    if (row[levelCol] !== '5') continue; // non-word rows (page/block/par headers)
    const key = `${row[pageCol]}|${row[lineCol]}`;
    let g = groups.get(key);
    if (!g) {
      g = { page: Number.parseInt(row[pageCol] ?? '1', 10) - 1, words: [], confs: [] };
      groups.set(key, g);
    }
    const word = row[textCol] ?? '';
    if (word.trim()) g.words.push(word.trim());
    const conf = Number.parseFloat(row[confCol] ?? '-1');
    if (conf >= 0) g.confs.push(conf);
  }
  return [...groups.values()]
    .filter((g) => g.words.length > 0)
    .map((g) => ({
      page: g.page,
      text: g.words.join(' '),
      confidence:
        g.confs.length === 0
          ? 0.5
          : Math.round((g.confs.reduce((a, c) => a + c, 0) / g.confs.length) * 10) / 1000,
    }));
}

/**
 * Audio/video transcription via the `whisper` CLI (openai-whisper) writing per-segment JSON. Two
 * honest gates before anything runs: the binary must be on PATH, and a LOCAL model must be
 * configured — `--model tiny` etc. would fetch weights over the network, which crib never does.
 * Confidence per segment = exp(avg_logprob), whisper's own per-segment log-probability.
 */
function transcribe(abs: string, opts: AdapterOpts): AdapterPayload {
  const modality = inferModality(abs) === 'video' ? 'video' : 'audio';
  const version = detectBinary('whisper', ['--help']);
  if (!version) {
    return unavail(abs, modality, TRANSCRIBE_EXTRACTOR, 'whisper', 'whisper not found on PATH');
  }
  if (!opts.modelPath) {
    return unavail(
      abs,
      modality,
      TRANSCRIBE_EXTRACTOR,
      'whisper',
      'whisper found but no local model configured — pass --multimodal-model-path (a named model would be fetched over the network)',
    );
  }
  const outDir = mkdtempSync(join(tmpdir(), 'crib-whisper-'));
  try {
    const r = spawnSync(
      'whisper',
      [
        abs,
        '--model',
        opts.modelPath,
        '--task',
        'transcribe',
        '--output_format',
        'json',
        '--output_dir',
        outDir,
      ],
      { encoding: 'utf8', timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.error || r.status !== 0) {
      const why = r.error?.message ?? `exit ${r.status}`;
      return unavail(abs, modality, TRANSCRIBE_EXTRACTOR, 'whisper', `whisper failed: ${why}`);
    }
    return parseWhisperJson(
      readFileSync(join(outDir, `${stripExt(basename(abs))}.json`), 'utf8'),
      abs,
      modality,
      version,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Map a whisper JSON output (`segments[{start,end,text,avg_logprob}]` + `language`) to AdapterPayload. */
function parseWhisperJson(
  json: string,
  abs: string,
  modality: string,
  version: string,
): AdapterPayload {
  let parsed: {
    language?: string;
    segments?: { start?: number; end?: number; text?: string; avg_logprob?: number }[];
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    return unavail(
      abs,
      modality,
      TRANSCRIBE_EXTRACTOR,
      'whisper',
      'whisper JSON output unparseable',
    );
  }
  const lang = parsed.language ?? null;
  const segments: AdapterSegment[] = (parsed.segments ?? [])
    .map((s) => {
      const logprob = typeof s.avg_logprob === 'number' ? s.avg_logprob : -1;
      // exp(avg_logprob) ∈ (0,1] is whisper's own per-segment probability — measured, not invented
      const confidence = Math.min(1, Math.max(0.01, Math.exp(logprob)));
      return {
        tStartMs: Math.round((s.start ?? 0) * 1000),
        tEndMs: Math.round((s.end ?? 0) * 1000),
        text: (s.text ?? '').trim(),
        lang,
        confidence: Number.parseFloat(confidence.toFixed(3)),
      };
    })
    .filter((s) => s.text.length > 0);
  return {
    schemaVersion: '1.1',
    file: abs,
    modality,
    segments,
    dropped: segments.length === 0 ? 1 : 0,
    extractor: TRANSCRIBE_EXTRACTOR,
    extractedBy: `whisper ${version}`,
  };
}

function stripExt(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot > 0 ? p.slice(0, dot) : p;
}
