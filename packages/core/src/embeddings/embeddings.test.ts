/**
 * M2.1 embedder module tests — the pure-JS offline default + storage codec.
 *
 * The recall gate (≥+30% conceptual recall vs BM25) is measured by the eval harness after the
 * vectors are wired into the derived index; these tests pin the embedder's correctness invariants:
 * determinism, case/affix generalization, unit normalization, and the float32 BLOB round-trip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CharNgramEmbedder, cosine, decodeVec, encodeVec } from './char-ngram.js';
import { isDefaultProvider, resolveEmbedder } from './provider.js';
import { DEFAULT_DIM } from './types.js';

afterEach(() => {
  // `process.env.X = undefined` sets the literal string "undefined" (not a delete) and corrupts
  // provider resolution; delete is the canonical env-var removal. noDelete targets plain-object perf.
  // biome-ignore lint/performance/noDelete: env-var removal requires the delete operator
  delete process.env.KCRIB_EMBEDDER;
});

function norm(v: Float32Array): number {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) * (v[i] ?? 0);
  return Math.sqrt(n);
}

describe('CharNgramEmbedder — determinism', () => {
  it('same text yields byte-identical vectors across instances', () => {
    const a = new CharNgramEmbedder();
    const b = new CharNgramEmbedder();
    const va = a.embed('assess_application');
    const vb = b.embed('assess_application');
    expect(Array.from(va)).toEqual(Array.from(vb));
  });

  it('dimensionality is fixed by construction', () => {
    expect(new CharNgramEmbedder().dim()).toBe(DEFAULT_DIM);
    expect(new CharNgramEmbedder({ dim: 256 }).dim()).toBe(256);
  });

  it('reports a stable id reflecting dim + n-gram window', () => {
    expect(new CharNgramEmbedder().id).toBe(`char-ngram-3-6-${DEFAULT_DIM}`);
  });
});

describe('CharNgramEmbedder — generalization (the whole point)', () => {
  it('case-insensitive: "Assess" ≈ "assess" (cosine ≈ 1)', () => {
    const e = new CharNgramEmbedder();
    expect(cosine(e.embed('Assess'), e.embed('assess'))).toBeGreaterThan(0.99);
  });

  it('affix/inflection: "assessed" is closer to "assess" than to an unrelated word', () => {
    const e = new CharNgramEmbedder();
    const near = cosine(e.embed('assessed'), e.embed('assess'));
    const far = cosine(e.embed('assessed'), e.embed('banana'));
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0.3); // substantial shared n-grams
  });

  it('paraphrase: "loan application assessed" is closer to "assess_application" than to "validate_claim"', () => {
    const e = new CharNgramEmbedder();
    const q = e.embed('how is a loan application assessed');
    const good = cosine(q, e.embed('assess_application'));
    const bad = cosine(q, e.embed('validate_claim'));
    expect(good).toBeGreaterThan(bad);
  });
});

describe('CharNgramEmbedder — normalization', () => {
  it('every non-empty embed is a unit vector', () => {
    const e = new CharNgramEmbedder();
    for (const t of ['assess', 'validate_claim', 'a b c d', 'TOKENS-ngrams']) {
      const n = norm(e.embed(t));
      expect(n).toBeGreaterThan(0.999);
      expect(n).toBeLessThan(1.001);
    }
  });

  it('empty / whitespace-only text yields a zero vector (no false signal)', () => {
    const e = new CharNgramEmbedder();
    expect(norm(e.embed(''))).toBe(0);
    expect(norm(e.embed('   '))).toBe(0);
  });

  it('batch embed equals per-text embed', () => {
    const e = new CharNgramEmbedder();
    const texts = ['assess', 'validate', 'process'];
    const batch = e.embedBatch(texts);
    for (let i = 0; i < texts.length; i++) {
      expect(Array.from(batch[i]!)).toEqual(Array.from(e.embed(texts[i]!)));
    }
  });
});

describe('vector codec — float32 BLOB round-trip', () => {
  it('encode then decode reproduces the vector exactly', () => {
    const e = new CharNgramEmbedder();
    const v = e.embed('assess_application');
    const round = decodeVec(encodeVec(v), v.length);
    expect(Array.from(round)).toEqual(Array.from(v));
  });
});

describe('provider resolution', () => {
  it('default resolves to the char-ngram embedder with the canonical id', async () => {
    const e = await resolveEmbedder();
    expect(e.id).toBe(`char-ngram-3-6-${DEFAULT_DIM}`);
  });

  it('isDefaultProvider true for unset / char-ngram / builtin:char-ngram', () => {
    expect(isDefaultProvider()).toBe(true);
    expect(isDefaultProvider({ provider: 'char-ngram' })).toBe(true);
    expect(isDefaultProvider({ provider: 'builtin:char-ngram' })).toBe(true);
    expect(isDefaultProvider({ provider: './external.mjs' })).toBe(false);
  });

  it('KCRIB_EMBEDDER=char-ngram still resolves the default', async () => {
    process.env.KCRIB_EMBEDDER = 'char-ngram';
    const e = await resolveEmbedder();
    expect(e.id).toBe(`char-ngram-3-6-${DEFAULT_DIM}`);
  });

  it('explicit opts.provider overrides the env var', async () => {
    process.env.KCRIB_EMBEDDER = 'char-ngram';
    const e = await resolveEmbedder({ provider: 'char-ngram', dim: 256 });
    expect(e.dim()).toBe(256);
  });
});
