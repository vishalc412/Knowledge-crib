import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBED_ALIAS,
  EMBED_MODELS,
  type RunFn,
  adapterDir,
  checkPython,
  checkSentenceTransformers,
  checkWeights,
  embedderIdFor,
  renderEmbedBatchPy,
  renderEmbedderMjs,
  resolveModelSpec,
  writeAdapter,
} from './embed-setup.js';

/**
 * `crib embed setup` — the one command that replaces a three-step README ritual whose last step
 * named a path (`examples/embedders/minilm-e5`) that does not exist in the published package.
 *
 * What these tests defend, in order of how expensive the bug was:
 *   1. the model table cannot claim a gate it did not pass;
 *   2. the generated adapter has ONE code path for embed/embedBatch;
 *   3. the adapter is written OUTSIDE the repo and cleanly, because every file under it is hashed;
 *   4. each precondition step fails with something the operator can act on.
 */

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'crib-embed-setup-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the model table cannot overstate a model', () => {
  it('claims 8/8 only for a model that actually clears the 80% G2 threshold', () => {
    // The gate that stops "ship the small one, it is basically as good". Measured numbers live in
    // docs/bench/embed-model-ladder.md; this asserts the table stays consistent with the threshold.
    for (const m of EMBED_MODELS) {
      expect(m.gates === 8, `${m.alias}: gates=${m.gates} g2=${m.g2}`).toBe(m.g2 >= 0.8);
    }
  });

  it('defaults to the only model measured to pass every gate', () => {
    const def = EMBED_MODELS.find((m) => m.alias === DEFAULT_EMBED_ALIAS);
    expect(def?.gates).toBe(8);
    expect(EMBED_MODELS.filter((m) => m.gates === 8)).toHaveLength(1);
  });

  it('records a download size for every model, so the cost is never hidden', () => {
    for (const m of EMBED_MODELS) expect(m.approxDisk).toMatch(/\d/);
  });
});

describe('resolveModelSpec', () => {
  it('resolves by alias and by full HuggingFace id', () => {
    expect(resolveModelSpec('large')?.hfId).toBe('intfloat/multilingual-e5-large');
    expect(resolveModelSpec('intfloat/multilingual-e5-large')?.alias).toBe('large');
  });

  it('returns undefined for an unlisted model rather than guessing its dimension', () => {
    // A guessed dim would turn a typo into silent mis-scoring; the pin re-checks dim on every load,
    // so refusing here keeps the failure loud.
    expect(resolveModelSpec('intfloat/not-a-real-model')).toBeUndefined();
  });
});

describe('embedderIdFor — the key of the persistent vector cache', () => {
  it('encodes the dimension and whether a prefix is applied', () => {
    const large = resolveModelSpec('large')!;
    const small = resolveModelSpec('small')!;
    expect(embedderIdFor(large)).toBe('multilingual-e5-large-1024-sym');
    expect(embedderIdFor(small)).toBe('all-MiniLM-L6-v2-384-raw');
  });

  it('gives two models with different behaviour two different ids', () => {
    const ids = new Set(EMBED_MODELS.map(embedderIdFor));
    expect(ids.size).toBe(EMBED_MODELS.length);
  });
});

describe('the generated adapter', () => {
  it('routes embed() through embedBatch() — ONE code path', () => {
    // The regression this encodes: an earlier hand-written adapter applied E5's `query:` prefix in
    // embed and `passage:` in embedBatch. Ranking then depended on which method the caller reached
    // for, and switching crib's record loop from one to the other cost 8 points of paraphrase
    // recall with no error anywhere.
    const mjs = renderEmbedderMjs(resolveModelSpec('large')!, '/usr/bin/python3');
    expect(mjs).toContain('return this.embedBatch([text])[0];');
    // exactly one place applies the prefix
    expect([...mjs.matchAll(/PREFIX \+ t/g)]).toHaveLength(1);
  });

  it('pins the dimension and fails loudly when the model disagrees', () => {
    const mjs = renderEmbedderMjs(resolveModelSpec('small')!, '/usr/bin/python3');
    expect(mjs).toContain('const DIM = 384;');
    expect(mjs).toContain("'embedder dim '");
  });

  it('carries the symmetric prefix for E5 and no prefix for the others', () => {
    expect(renderEmbedderMjs(resolveModelSpec('large')!, 'p')).toContain(
      'const PREFIX = "query: ";',
    );
    expect(renderEmbedderMjs(resolveModelSpec('small')!, 'p')).toContain('const PREFIX = "";');
  });

  it('keeps its vector cache OUTSIDE the hashed adapter directory', () => {
    // Every file under the adapter dir is hashed at install; a cache written there would
    // invalidate the integrity check on first use.
    const mjs = renderEmbedderMjs(resolveModelSpec('small')!, 'p');
    expect(mjs).toContain(".cache', 'crib-embed-vec'");
    expect(mjs).not.toContain("join(HERE, 'cache')");
  });

  it('runs the Python side offline, so a query never reaches the network', () => {
    const py = renderEmbedBatchPy(resolveModelSpec('base')!);
    expect(py).toContain('HF_HUB_OFFLINE');
    expect(py).toContain('TRANSFORMERS_OFFLINE');
    expect(py).toContain('intfloat/multilingual-e5-base');
    expect(py).toContain('normalize_embeddings=True');
  });

  it('bakes the resolved interpreter in, while still honouring KCRIB_EMBED_PYTHON', () => {
    const mjs = renderEmbedderMjs(resolveModelSpec('small')!, '/opt/venv/bin/python3');
    expect(mjs).toContain('process.env.KCRIB_EMBED_PYTHON ?? "/opt/venv/bin/python3"');
  });

  it('is valid JavaScript that Node can parse', () => {
    const d = tmp();
    const f = join(d, 'gen.mjs');
    writeFileSync(f, renderEmbedderMjs(resolveModelSpec('large')!, '/usr/bin/python3'));
    // --check parses without executing: catches a template that produced broken syntax.
    expect(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('writeAdapter', () => {
  it('writes both halves of the bridge', () => {
    const d = join(tmp(), 'adapter');
    writeAdapter(resolveModelSpec('small')!, '/usr/bin/python3', d);
    expect(existsSync(join(d, 'embedder.mjs'))).toBe(true);
    expect(existsSync(join(d, 'embed_batch.py'))).toBe(true);
  });

  it('clears a stale file rather than leaving it to be hashed into the pin', () => {
    const d = join(tmp(), 'adapter');
    writeAdapter(resolveModelSpec('small')!, '/usr/bin/python3', d);
    writeFileSync(join(d, 'leftover.py'), 'print("from an older install")');
    writeAdapter(resolveModelSpec('large')!, '/usr/bin/python3', d);
    expect(existsSync(join(d, 'leftover.py'))).toBe(false);
    expect(readFileSync(join(d, 'embedder.mjs'), 'utf8')).toContain('const DIM = 1024;');
  });

  it('regenerates byte-identically for the same inputs', () => {
    const a = join(tmp(), 'a');
    const b = join(tmp(), 'b');
    writeAdapter(resolveModelSpec('base')!, '/usr/bin/python3', a);
    writeAdapter(resolveModelSpec('base')!, '/usr/bin/python3', b);
    expect(readFileSync(join(a, 'embedder.mjs'), 'utf8')).toBe(
      readFileSync(join(b, 'embedder.mjs'), 'utf8'),
    );
  });
});

describe('adapterDir', () => {
  it('lives under the embed home, never in the repo — the npm-install case', () => {
    const home = tmp();
    const d = adapterDir(resolveModelSpec('large')!, home);
    expect(d.startsWith(home)).toBe(true);
    expect(d).not.toContain('examples');
  });

  it('sanitises the model id into a single safe path segment', () => {
    const home = tmp();
    const d = adapterDir({ hfId: 'org/name../with spaces' }, home);
    expect(d.slice(home.length)).not.toContain('..');
    expect(d.slice(home.length)).not.toContain(' ');
  });
});

describe('precondition steps report something the operator can act on', () => {
  const ok: RunFn = () => '3.11.9\n';
  const boom: RunFn = () => {
    throw new Error('spawnSync /nope ENOENT');
  };

  it('reports the interpreter it actually ran', () => {
    const r = checkPython('/opt/venv/bin/python3', ok);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('/opt/venv/bin/python3');
    expect(r.detail).toContain('3.11.9');
  });

  it('names the interpreter that could not be run', () => {
    const r = checkPython('/nope/python3', boom);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('/nope/python3');
  });

  it('checks sentence-transformers against THAT interpreter, not whatever is on PATH', () => {
    const seen: string[] = [];
    const spy: RunFn = (cmd) => {
      seen.push(cmd);
      return '5.5.1\n';
    };
    expect(checkSentenceTransformers('/opt/venv/bin/python3', spy).ok).toBe(true);
    expect(seen).toEqual(['/opt/venv/bin/python3']);
  });

  it('probes the weights OFFLINE, so a pass proves no query will need the network', () => {
    let script = '';
    const spy: RunFn = (_c, args) => {
      script = args[1] ?? '';
      return 'cached\n';
    };
    const r = checkWeights(resolveModelSpec('large')!, 'python3', spy);
    expect(r.ok).toBe(true);
    expect(script).toContain('HF_HUB_OFFLINE');
    expect(script).toContain('intfloat/multilingual-e5-large');
  });

  it('states the download size when the weights are missing', () => {
    const r = checkWeights(resolveModelSpec('large')!, 'python3', boom);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('~2.2 GB');
  });
});
