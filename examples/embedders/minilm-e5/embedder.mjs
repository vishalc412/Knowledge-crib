/**
 * A WORKING on-device embedder for knowledge-crib's semantic tier.
 *
 * This is the reference adapter. Install it with:
 *
 *   crib embed install examples/embedders/minilm-e5 \
 *     --model-id intfloat/multilingual-e5-large --model-version 1 --entry embedder.mjs
 *
 * See README.md in this directory for the one-time model download.
 *
 * ── Why an adapter at all ────────────────────────────────────────────────────
 * crib ships no model and makes no network call, at install time or query time. That is a product
 * red line (MAX_RUNTIME_DEPS = 9, MAX_PACKAGE_BYTES = 5 MB), so the model is an operator-supplied
 * artifact and this file is the bridge to it. Everything here is plain Node — no crib import.
 *
 * ── The two contracts that are easy to get wrong ─────────────────────────────
 * 1. `embedBatch(texts)[i]` MUST equal `embed(texts[i])`. Batching is a PERFORMANCE variant, never
 *    a semantic one. An earlier version of this adapter applied E5's `query:` prefix in one method
 *    and `passage:` in the other; the ranking then depended on which method a caller reached for,
 *    and switching crib's record loop from `embed` to `embedBatch` silently cost 8 points of
 *    paraphrase recall. Both methods here go through one code path.
 *
 * 2. `id` must change whenever the embedding behaviour changes. It keys crib's persistent vector
 *    cache, so a silent behaviour change under a stable id would serve vectors from the old space.
 *
 * ── Why `query:` on both sides ───────────────────────────────────────────────
 * E5 is trained asymmetrically (`query:` / `passage:`), which is right for question→document
 * retrieval. Memory recall is a SIMILARITY task: a paraphrase and the claim it restates are two
 * ways of saying one thing. E5's own guidance is `query:` on both sides of a symmetric task, and it
 * measures better here — 81.0% paraphrase recall symmetric vs 73.2% asymmetric on the launch corpus.
 *
 * ── Performance ──────────────────────────────────────────────────────────────
 * The `Embedder` contract is synchronous and a transformer is not, so this drives a short-lived
 * Python batch process and memoizes every vector on disk. crib ALSO keeps its own persistent vector
 * store, so in normal operation this is called once per record ever; the disk cache here is a second
 * belt for the case where crib's store is unavailable.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Python with `sentence-transformers` installed. Override for a venv elsewhere. */
const PYTHON = process.env.KCRIB_EMBED_PYTHON ?? 'python3';
const SCRIPT = join(HERE, 'embed_batch.py');
/** Outside the model dir: `crib embed install` hashes every file under it for integrity. */
const CACHE =
  process.env.KCRIB_EMBED_CACHE ?? join(process.env.HOME ?? '/tmp', '.cache', 'crib-embed-vec');

/** Bump with ANY behaviour change — prefix, model, normalisation. It keys crib's vector cache. */
const ID = 'multilingual-e5-large-1024-sym';
const DIM = 1024;

const memo = new Map();
const keyOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const pathOf = (k) => join(CACHE, k.slice(0, 2), `${k}.bin`);

function readCached(text) {
  const hit = memo.get(text);
  if (hit) return hit;
  const p = pathOf(keyOf(text));
  if (!existsSync(p)) return undefined;
  const buf = readFileSync(p);
  const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const copy = new Float32Array(vec); // detach from the file buffer
  memo.set(text, copy);
  return copy;
}

function writeCached(text, vec) {
  const p = pathOf(keyOf(text));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  memo.set(text, vec);
}

function runPython(texts) {
  const out = execFileSync(PYTHON, [SCRIPT], {
    input: JSON.stringify({ texts }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  if (parsed.dim !== DIM) {
    throw new Error(
      `embedder dim ${parsed.dim} != pinned ${DIM} — the installed manifest and the model disagree`,
    );
  }
  return parsed.vectors.map((v) => Float32Array.from(v));
}

class E5Embedder {
  get id() {
    return ID;
  }

  dim() {
    return DIM;
  }

  /** The ONE code path. `embed` delegates here so the two can never diverge (see the header). */
  embedBatch(texts) {
    const out = new Array(texts.length);
    const missing = [];
    const missingIdx = [];
    for (let i = 0; i < texts.length; i++) {
      const hit = readCached(texts[i]);
      if (hit) out[i] = hit;
      else {
        missing.push(texts[i]);
        missingIdx.push(i);
      }
    }
    if (missing.length > 0) {
      // `query:` on BOTH sides — symmetric similarity, see the header.
      const fresh = runPython(missing.map((t) => `query: ${t}`));
      for (let i = 0; i < fresh.length; i++) {
        writeCached(missing[i], fresh[i]);
        out[missingIdx[i]] = fresh[i];
      }
    }
    return out;
  }

  embed(text) {
    return this.embedBatch([text])[0];
  }
}

export default new E5Embedder();
