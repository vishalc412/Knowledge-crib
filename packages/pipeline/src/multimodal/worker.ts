/**
 * M13 — the subprocess contract with the offline `crib_worker` (a sibling `python/` project). The TS
 * side spawns `python3 -m crib_worker.cli`, parses one JSON payload from stdout, and turns it into
 * soul-schema-conformant nodes/edges (see ingest.ts). The worker is a pure segment producer; the TS
 * side owns the node id (`media:<path>#<tStartMs>`) + blake3 hash so hashing stays deterministic +
 * soul-side.
 *
 * Safety: a missing worker (not installed), a non-zero exit, or a malformed payload ALL degrade to
 * an empty segment list — `runWorker` never throws, so the pipeline never aborts on a media file
 * (pure-TS safety: default index/serve never call this; `crib multimodal` / `indexRepo{multimodal}`
 * do, and a worker absence is a graceful no-op, not a crash).
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One transcript/OCR segment from the worker. */
export interface WorkerSegment {
  tStartMs: number;
  tEndMs: number;
  text: string;
  lang?: string | null;
  /** pdf: 0-based page index — the source span (TS adapters only; see adapters.ts). */
  page?: number;
  /** 0..1 extractor self-assessed fidelity; absent → ingest stamps a documented 0.5 fallback. */
  confidence?: number;
}

/** The worker → TS JSON envelope (see python/crib_worker/emit.py `build_payload`). */
export interface WorkerPayload {
  schemaVersion: string;
  file: string;
  modality: string;
  segments: WorkerSegment[];
  dropped: number;
  /** G5.3 provenance (TS adapters always set it; legacy python payloads omit it). */
  extractor?: string;
  /** G5.3 provenance: the concrete engine that ran (unpdf/pdf.js, tesseract, whisper, crib-worker). */
  extractedBy?: string;
  /** G5.3 honest-degradation note: why nothing (or only some) was extracted. */
  unavailable?: string;
}

/** Options for spawning the worker. */
export interface WorkerOpts {
  /**
   * `auto` (default, G5.3) → the TS-native production adapters (adapters.ts: bundled pdf.js text
   * layer, tesseract OCR, whisper transcription — each failing honest when absent).
   * `fake` → the legacy python sidecar reader (tests/fixtures). `pdf`/`audio`/`image` → the legacy
   * python crib_worker backends (unchanged behaviour; python3 required).
   */
  backend?: 'auto' | 'fake' | 'pdf' | 'audio' | 'image';
  /** Path to a local model dir for audio/image backends; never fetched over the network. */
  modelPath?: string;
  /** Override the worker entry (default: the monorepo's `python/crib_worker` via `-m`). */
  workerPath?: string;
  /** Override the python interpreter (default: `python3`). */
  python?: string;
  /** Per-file timeout ms (the worker degrades internally; this is a hard backstop). */
  timeoutMs?: number;
  /** Inject a worker implementation (tests) — bypasses the subprocess entirely. When set,
   *  `ingestStaging` calls this instead of spawning, so the TS node/edge/link logic is testable with
   *  deterministic payloads and no python3 on PATH. */
  workerFn?: (mediaAbsPath: string) => Promise<WorkerPayload>;
}

/**
 * Default worker location: the monorepo's `python/` dir, resolved from this module's location so it
 * works whether vitest runs the TS source or the built `dist/` is used. The worker is invoked as
 * `python3 -m crib_worker.cli` with `cwd=<pythonDir>` (relative imports require package context).
 */
export function defaultWorkerDir(): string {
  // src/multimodal/worker.ts  → 4 ups  →  monorepo root; dist/multimodal/worker.js → same depth.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'python');
}

const EMPTY: WorkerPayload = {
  schemaVersion: '1.1',
  file: '',
  modality: 'audio',
  segments: [],
  dropped: 0,
};

/**
 * Spawn the worker for one absolute media path and return its payload. Always resolves (never
 * rejects): any failure → an empty payload, so callers can treat media extraction as best-effort.
 */
export function runWorker(mediaAbsPath: string, opts: WorkerOpts = {}): Promise<WorkerPayload> {
  const python = opts.python ?? 'python3';
  const workerDir = opts.workerPath ?? defaultWorkerDir();
  const args = ['-m', 'crib_worker.cli', '--backend', opts.backend ?? 'fake', mediaAbsPath];
  if (opts.modelPath) {
    args.push('--model-path', opts.modelPath);
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, args, { cwd: workerDir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ...EMPTY, file: mediaAbsPath });
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (payload: WorkerPayload): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ ...EMPTY, file: mediaAbsPath, dropped: 1 });
    }, opts.timeoutMs ?? 30_000);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => finish({ ...EMPTY, file: mediaAbsPath, dropped: 1 }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ...EMPTY, file: mediaAbsPath, dropped: 1 });
        return;
      }
      try {
        const payload = JSON.parse(stdout) as WorkerPayload;
        finish({ ...EMPTY, ...payload, file: mediaAbsPath });
      } catch {
        finish({ ...EMPTY, file: mediaAbsPath, dropped: 1 });
      }
    });
  });
}
