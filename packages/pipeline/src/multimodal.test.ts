/**
 * M13 gate — the offline multimodal phase: subprocess contract, ingest → media-seg/member-of,
 * media→symbol linking, capability flip, and graceful degradation.
 *
 * The TS node/edge/link logic is tested hermetically via an injected `workerFn` (no python3 needed).
 * One test exercises the REAL `python3 -m crib_worker.cli` fake backend and is skipped when python3
 * is absent; another forces a spawn failure to prove degradation never throws.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractDotted, runMediaLink } from './linker/media.js';
import { runMultimodal } from './multimodal/index.js';
import { ingestStaging, isMediaPath } from './multimodal/ingest.js';
import type { WorkerPayload } from './multimodal/worker.js';
import { runWorker } from './multimodal/worker.js';
import { indexRepo } from './pipeline.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'media-linked');
const NOW = '2026-01-01T00:00:00.000Z';

// Real-subprocess tests need python3 on PATH + the crib_worker module at the monorepo's python/ dir.
let HAS_PYTHON = false;
try {
  execFileSync('python3', ['-V'], { stdio: 'ignore' });
  HAS_PYTHON = true;
} catch {
  HAS_PYTHON = false;
}

let crib: string;
beforeEach(() => {
  crib = mkdtempSync(join(tmpdir(), 'crib-mm-'));
});
afterEach(() => rmSync(crib, { recursive: true, force: true }));

function soulAt(): SoulStore {
  const s = new SoulStore(join(crib, '.crib'), { manifest: newManifest({ now: NOW, root: '.' }) });
  s.load();
  return s;
}

/** Index the fixture (structure + parse → symbols) WITHOUT multimodal, so media linking has targets. */
async function indexedSoul(): Promise<SoulStore> {
  const soul = soulAt();
  await indexRepo(soul, FIXTURE, { now: NOW, cluster: false });
  return soul;
}

/** A deterministic 2-segment payload shaped like the fake backend's output for talk.wav. */
function fakePayload(): WorkerPayload {
  return {
    schemaVersion: '1.1',
    file: join(FIXTURE, 'talk.wav'),
    modality: 'audio',
    dropped: 0,
    segments: [
      {
        tStartMs: 0,
        tEndMs: 1000,
        text: 'The AuthService.login method handles authentication.',
        lang: 'en',
      },
      { tStartMs: 1000, tEndMs: 2000, text: 'A second line about the log helper.', lang: 'en' },
    ],
  };
}

describe('M13 multimodal phase', () => {
  it('extractDotted pulls qualified-name refs (not bare names) out of prose', () => {
    const refs = extractDotted(
      'The AuthService.login method and util.parseConfig call, plus log()',
    );
    expect(refs).toContain('AuthService.login');
    expect(refs).toContain('util.parseConfig');
    // bare class name + bare method are NOT dotted refs (those flow through the identifier signal)
    expect(refs).not.toContain('AuthService');
    expect(refs).not.toContain('log');
  });

  it('isMediaPath recognizes audio/image/pdf extensions', () => {
    expect(isMediaPath('talk.wav')).toBe(true);
    expect(isMediaPath('scan.PNG')).toBe(true); // case-insensitive
    expect(isMediaPath('doc.pdf')).toBe(true);
    expect(isMediaPath('src/auth.ts')).toBe(false);
    expect(isMediaPath('README.md')).toBe(false);
  });

  it('ingestStaging emits media-seg nodes + member-of edges to the existing file node (no danglers)', async () => {
    const soul = await indexedSoul();
    const fileId = idFor({ kind: 'file', path: 'talk.wav' });
    expect([...soul.iterate('file')].some((n) => n.id === fileId)).toBe(true); // structure emitted it

    const stats = await ingestStaging(soul, FIXTURE, ['talk.wav'], {
      workerFn: () => Promise.resolve(fakePayload()),
    });
    expect(stats.segments).toBe(2);
    expect(stats.dropped).toBe(0);

    const segs = [...soul.iterate('media-seg')];
    expect(segs).toHaveLength(2);
    expect(segs[0]!.id).toBe(idFor({ kind: 'media-seg', path: 'talk.wav', tStartMs: 0 }));
    expect(segs[0]!.meta?.modality).toBe('audio');
    expect(segs[0]!.meta?.text).toContain('AuthService.login');

    const memberOf = [...soul.iterateEdges('member-of')].filter((e) => e.src.startsWith('media:'));
    expect(memberOf).toHaveLength(2);
    expect(memberOf.every((e) => e.dst === fileId)).toBe(true); // every seg → its file node
    expect(memberOf.every((e) => e.provenance === 'EXTRACTED' && e.confidence === 1)).toBe(true);
  });

  it('runMediaLink emits a describes edge media-seg → AuthService.login (explicit, conf≥0.8)', async () => {
    const soul = await indexedSoul();
    await ingestStaging(soul, FIXTURE, ['talk.wav'], {
      workerFn: () => Promise.resolve(fakePayload()),
    });
    const stats = runMediaLink(soul, undefined, ['talk.wav']);

    const login = [...soul.iterate('symbol')].find((n) => n.qualifiedName === 'AuthService.login');
    expect(login).toBeTruthy();
    const describes = [...soul.iterateEdges('describes')].find(
      (e) => e.src.startsWith('media:') && e.dst === login!.id,
    );
    expect(describes).toBeTruthy();
    expect(describes!.method).toBe('explicit');
    expect(describes!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(describes!.provenance).toBe('EXTRACTED');
    expect(stats.describes).toBeGreaterThanOrEqual(1);
  });

  it('runMultimodal flips capabilities.multimodal=true when segments are ingested', async () => {
    const soul = await indexedSoul();
    expect(soul.getManifest().capabilities.multimodal).toBe(false); // default
    const report = await runMultimodal(
      soul,
      FIXTURE,
      { workerFn: () => Promise.resolve(fakePayload()) },
      ['talk.wav'],
    );
    expect(report.ingest.segments).toBe(2);
    expect(report.link.describes).toBeGreaterThanOrEqual(1);
    expect(soul.getManifest().capabilities.multimodal).toBe(true);
  });

  it('runMultimodal leaves the capability false on a fully-degraded (empty) run', async () => {
    const soul = await indexedSoul();
    const empty: WorkerPayload = {
      schemaVersion: '1.1',
      file: '',
      modality: 'audio',
      segments: [],
      dropped: 1,
    };
    const report = await runMultimodal(soul, FIXTURE, { workerFn: () => Promise.resolve(empty) }, [
      'talk.wav',
    ]);
    expect(report.ingest.segments).toBe(0);
    expect(report.ingest.dropped).toBe(1);
    expect(soul.getManifest().capabilities.multimodal).toBe(false); // honest: no media nodes
  });

  it('runWorker degrades gracefully (no throw, empty payload) when the python interpreter is missing', async () => {
    const payload = await runWorker(join(FIXTURE, 'talk.wav'), {
      python: 'python3-does-not-exist-xyz',
    });
    expect(payload.segments).toEqual([]);
    expect(payload.dropped).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!HAS_PYTHON)(
    'runWorker (real fake backend) reads the .wav.txt sidecar → 2 audio segments via python3 -m crib_worker',
    async () => {
      const payload = await runWorker(join(FIXTURE, 'talk.wav'), { backend: 'fake' });
      expect(payload.modality).toBe('audio');
      expect(payload.segments).toHaveLength(2);
      expect(payload.segments[0]!.text).toContain('AuthService.login');
      expect(payload.segments[0]!.tStartMs).toBe(0);
      expect(payload.segments[1]!.tStartMs).toBe(1000);
    },
  );
});
