/**
 * F05 (docs/audits/2026-09-05) — `crib embed setup`, the supported semantic installation path.
 *
 * The audit found the on-device tier reachable only through a README ritual whose final step named
 * a path inside the git checkout (`examples/embedders/minilm-e5`), which the published package does
 * not ship — so for an npm install the documented instructions could not be followed at all, and
 * the machine silently served the lexical fallback.
 *
 * Two properties are pinned here beyond "it runs":
 *   - the ladder never states a quality number this repository cannot source (the previous ladder
 *     cited a `docs/bench/embed-model-ladder.md` that does not exist);
 *   - setup does NOT report success on a model that loads but does not rank, because "installed"
 *     silently meaning "still lexical" is the audited failure itself.
 *
 * The process runner is injected, so every branch is exercised without a Python, a network, or a
 * multi-gigabyte download on the machine running the suite.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBED_ALIAS,
  EMBED_MODELS,
  type RunFn,
  adapterDir,
  describeEvidence,
  resolveModelSpec,
  runEmbedSetup,
} from './embed-setup.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crib-embed-setup-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const spec = resolveModelSpec(DEFAULT_EMBED_ALIAS)!;

/** A runner scripted by substring match on the python snippet, so each step can be steered. */
function scriptedRun(behaviour: {
  python?: boolean;
  sentenceTransformers?: boolean;
  cached?: boolean;
  /** flips `cached` to true once a download has run, modelling a real fetch */
  downloadWorks?: boolean;
}): RunFn {
  let cached = behaviour.cached ?? false;
  return (_cmd, args) => {
    const code = args.join(' ');
    if (code.includes('sys.version')) {
      if (behaviour.python === false) throw new Error('no such file or directory');
      return '3.12.0\n';
    }
    if (code.includes('import sentence_transformers as s')) {
      if (behaviour.sentenceTransformers === false) throw new Error('ModuleNotFoundError');
      return '3.0.1\n';
    }
    if (code.includes('HF_HUB_OFFLINE')) {
      if (!cached) throw new Error('not cached');
      return 'cached\n';
    }
    // the download path (no offline env, constructs the model)
    if (code.includes('SentenceTransformer')) {
      if (behaviour.downloadWorks === false) throw new Error('connection reset');
      cached = true;
      return '';
    }
    return '';
  };
}

const passingSmoke = async () => ({ ok: true, detail: 'paraphrase 0.90 > unrelated 0.10' });
const noopPin = async () => ({});

describe('the model ladder states only sourceable evidence', () => {
  it('marks every row either gate-verified with a citation, or explicitly unverified', () => {
    for (const model of EMBED_MODELS) {
      if (model.evidence.kind === 'gate-verified') {
        expect(model.evidence.source, model.alias).toMatch(/^docs\//);
        expect(model.evidence.g2, model.alias).toBeGreaterThan(0);
      } else {
        expect(model.evidence.reason.length, model.alias).toBeGreaterThan(0);
      }
    }
  });

  it('defaults to a model whose gate run is committed, not merely plausible', () => {
    // Shipping an unverified model as "the semantic tier" would sell a threshold nothing here
    // demonstrates — the exact overreach the audit flagged in the launch claims.
    expect(resolveModelSpec(DEFAULT_EMBED_ALIAS)?.evidence.kind).toBe('gate-verified');
  });

  it('never renders an unverified row as though it carried a measurement', () => {
    const unverified = EMBED_MODELS.filter((m) => m.evidence.kind === 'unverified');
    expect(unverified.length).toBeGreaterThan(0);
    for (const m of unverified) {
      expect(describeEvidence(m.evidence)).toContain('no gate run committed');
      expect(describeEvidence(m.evidence)).not.toMatch(/G2 \d/);
    }
  });
});

describe('runEmbedSetup', () => {
  it('stops with remediation when the interpreter cannot run', async () => {
    const plan = await runEmbedSetup({
      spec,
      pythonPath: 'python3',
      yes: true,
      home,
      run: scriptedRun({ python: false }),
      smoke: passingSmoke,
      pin: noopPin,
    });
    expect(plan.installed).toBe(false);
    expect(plan.steps.map((s) => s.name)).toEqual(['python']);
    expect(plan.remediation.join('\n')).toContain('--python');
  });

  it('refuses to install sentence-transformers itself, even under --yes', async () => {
    // Consent for a model download is NOT consent to mutate the operator's interpreter.
    const plan = await runEmbedSetup({
      spec,
      pythonPath: '/usr/bin/python3',
      yes: true,
      home,
      run: scriptedRun({ sentenceTransformers: false }),
      smoke: passingSmoke,
      pin: noopPin,
    });
    expect(plan.installed).toBe(false);
    expect(plan.needsConsent).toContain('sentence-transformers');
    expect(plan.remediation.join('\n')).toContain('/usr/bin/python3 -m pip install');
    expect(plan.steps.some((s) => s.name === 'download')).toBe(false);
  });

  it('does not download without consent, and says exactly what it would fetch', async () => {
    const plan = await runEmbedSetup({
      spec,
      pythonPath: 'python3',
      yes: false,
      home,
      run: scriptedRun({ cached: false }),
      smoke: passingSmoke,
      pin: noopPin,
    });
    expect(plan.installed).toBe(false);
    expect(plan.needsConsent).toContain(spec.approxDisk);
    expect(plan.steps.some((s) => s.name === 'download')).toBe(false);
  });

  it('installs, pins and proves the tier when the weights are already cached', async () => {
    const plan = await runEmbedSetup({
      spec,
      pythonPath: 'python3',
      yes: false,
      home,
      run: scriptedRun({ cached: true }),
      smoke: passingSmoke,
      pin: noopPin,
    });
    expect(plan.installed).toBe(true);
    expect(plan.steps.map((s) => s.name)).toEqual([
      'python',
      'sentence-transformers',
      'weights',
      'adapter',
      'pin',
      'smoke',
    ]);
    // the generated bridge really is on disk, not merely reported
    const adapter = adapterDir(spec, home);
    expect(existsSync(join(adapter, 'embedder.mjs'))).toBe(true);
    expect(readFileSync(join(adapter, 'embedder.mjs'), 'utf8')).toContain(spec.hfId);
  });

  it('downloads only under consent, then re-verifies the weights load offline', async () => {
    const plan = await runEmbedSetup({
      spec,
      pythonPath: 'python3',
      yes: true,
      home,
      run: scriptedRun({ cached: false, downloadWorks: true }),
      smoke: passingSmoke,
      pin: noopPin,
    });
    expect(plan.installed).toBe(true);
    // The recheck is the point: a download that "succeeds" but leaves nothing offline-loadable
    // must not be pinned as a working tier.
    expect(plan.steps.map((s) => s.name)).toContain('weights (recheck)');
  });

  it('does NOT report success when the model loads but does not rank', async () => {
    // The audited failure was a machine that believed it had a semantic tier while serving
    // lexical results. A dimension check would pass here; the ranking proof must not.
    const plan = await runEmbedSetup({
      spec,
      pythonPath: 'python3',
      yes: false,
      home,
      run: scriptedRun({ cached: true }),
      smoke: async () => ({
        ok: false,
        detail: 'no semantic signal: paraphrase 0.10 <= unrelated 0.40',
      }),
      pin: noopPin,
    });
    expect(plan.installed).toBe(false);
    expect(plan.remediation.join('\n')).toContain('NOT enabled');
  });

  it('does not claim a tier when pinning fails', async () => {
    const plan = await runEmbedSetup({
      spec,
      pythonPath: 'python3',
      yes: false,
      home,
      run: scriptedRun({ cached: true }),
      smoke: passingSmoke,
      pin: async () => {
        throw new Error('manifest write refused');
      },
    });
    expect(plan.installed).toBe(false);
    expect(plan.steps.at(-1)?.result.detail).toContain('pin failed');
  });
});
