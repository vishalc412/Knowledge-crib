/**
 * G5.3 — production multimodal adapters: TS-native PDF text-layer extraction (the DEFAULT backend),
 * the adapter-availability matrix (fake backend stays available for tests; OCR/transcription gated
 * on binary presence), and the G5.3 provenance meta stamped on every derived media-seg node.
 *
 * Honest-failure law: a corrupt PDF or an absent binary yields an `unavailable` payload and ZERO
 * segments — never fabricated content. The PDF test runs the REAL adapter (in-process, no python);
 * OCR/transcription availability is only reported, since the binaries themselves are environment-
 * dependent (their tests are skipped/gated accordingly).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMinimalPdf } from '../../../../scripts/fixtures/minimal-pdf.mjs';
import { adapterForPath, adapterStatuses, inferModality, runAdapter } from './adapters.js';
import { ingestStaging } from './ingest.js';

const NOW = '2026-01-01T00:00:00.000Z';

let crib: string;
beforeEach(() => {
  crib = mkdtempSync(join(tmpdir(), 'crib-mm-adapters-'));
});
afterEach(() => rmSync(crib, { recursive: true, force: true }));

function soulAt(): SoulStore {
  const s = new SoulStore(join(crib, '.crib'), { manifest: newManifest({ now: NOW, root: '.' }) });
  s.load();
  return s;
}

describe('G5.3 production adapters — routing + availability matrix', () => {
  it('routes each media extension to its production adapter (pdf is the TS-native default)', () => {
    expect(adapterForPath('docs/guide.pdf')).toBe('pdf');
    expect(adapterForPath('scan.png')).toBe('image-ocr');
    expect(adapterForPath('scan.TIFF')).toBe('image-ocr');
    expect(adapterForPath('talk.wav')).toBe('transcribe');
    expect(adapterForPath('talk.mp4')).toBe('transcribe'); // video → whisper too
    expect(adapterForPath('src/auth.ts')).toBeNull();
  });

  it('inferModality distinguishes audio from video (meta modality stays truthful)', () => {
    expect(inferModality('a.mp4')).toBe('video');
    expect(inferModality('a.wav')).toBe('audio');
    expect(inferModality('a.pdf')).toBe('pdf');
    expect(inferModality('a.txt')).toBeNull();
  });

  it('adapterStatuses answers for every adapter with an honest reason (count-agnostic)', () => {
    const statuses = adapterStatuses();
    expect(statuses.map((s) => s.id)).toEqual(['pdf', 'image-ocr', 'transcribe']);
    expect(statuses.every((s) => typeof s.available === 'boolean')).toBe(true);
    expect(statuses.every((s) => s.reason.length > 0)).toBe(true);
    // pdf is bundled — usable on every machine, no binary needed
    expect(statuses.find((s) => s.id === 'pdf')!.available).toBe(true);
    // binary-backed adapters report the binary verdict honestly, whatever this machine has
    for (const s of statuses.filter((x) => x.id !== 'pdf')) {
      if (s.available) expect(s.reason).toMatch(/on PATH/);
      else expect(s.reason).toMatch(/not found on PATH/);
    }
  });
});

describe('G5.3 PDF adapter (TS-native, unpdf/pdf.js — the default for "index my docs")', () => {
  it('extracts one segment per page with text, page span, and full provenance meta', async () => {
    const pdf = join(crib, 'docs.pdf');
    writeFileSync(
      pdf,
      buildMinimalPdf([
        ['AuthService.login validates credentials', 'page one body'],
        ['The util.parseConfig helper runs second', 'page two body'],
      ]),
    );

    const payload = await runAdapter(pdf);
    expect(payload.modality).toBe('pdf');
    expect(payload.segments).toHaveLength(2);
    expect(payload.extractor).toBe('pdf-text@1.0.0');
    expect(payload.extractedBy).toBe('unpdf (pdf.js)');
    expect(payload.unavailable).toBeUndefined();

    const [p0, p1] = payload.segments;
    expect(p0!.page).toBe(0);
    expect(p0!.tStartMs).toBe(0);
    expect(p0!.tEndMs).toBe(1000);
    expect(p0!.text).toContain('AuthService.login');
    expect(p0!.confidence).toBeGreaterThan(0.5);
    expect(p0!.confidence).toBeLessThanOrEqual(1);
    expect(p1!.page).toBe(1);
    expect(p1!.text).toContain('util.parseConfig');
  });

  it('degrades honest on a corrupt PDF (unavailable reason, zero segments, no throw)', async () => {
    const bad = join(crib, 'corrupt.pdf');
    writeFileSync(bad, Buffer.from('%PDF-1.4\nnot-a-real-pdf-body'));
    const payload = await runAdapter(bad);
    expect(payload.segments).toEqual([]);
    expect(payload.unavailable).toBeTruthy();
    expect(payload.extractor).toBe('pdf-text@1.0.0');
  });
});

describe('G5.3 ingest stamps full provenance meta on every media-seg node', () => {
  it('carries extractor/extractedBy/confidence/page when the adapter provides them', async () => {
    const soul = soulAt();
    const stats = await ingestStaging(soul, crib, ['docs/guide.pdf'], {
      workerFn: () =>
        Promise.resolve({
          schemaVersion: '1.1',
          file: '',
          modality: 'pdf',
          dropped: 0,
          extractor: 'pdf-text@1.0.0',
          extractedBy: 'unpdf (pdf.js)',
          segments: [
            {
              tStartMs: 0,
              tEndMs: 1000,
              text: 'AuthService.login validates credentials',
              page: 0,
              confidence: 0.95,
            },
          ],
        }),
    });
    expect(stats.segments).toBe(1);
    const seg = [...soul.iterate('media-seg')][0]!;
    expect(seg.meta?.modality).toBe('pdf');
    expect(seg.meta?.page).toBe(0);
    expect(seg.meta?.confidence).toBe(0.95);
    expect(seg.meta?.extractor).toBe('pdf-text@1.0.0');
    expect(seg.meta?.extractedBy).toBe('unpdf (pdf.js)');
    // the member-of edge names the real engine, not the generic worker
    const edge = [...soul.iterateEdges('member-of')][0]!;
    expect(edge.evidence?.by).toBe('unpdf (pdf.js)');
  });

  it('falls back to crib-worker identity + documented 0.5 confidence for legacy payloads', async () => {
    const soul = soulAt();
    await ingestStaging(soul, crib, ['talk.wav'], {
      workerFn: () =>
        Promise.resolve({
          schemaVersion: '1.1',
          file: '',
          modality: 'audio',
          dropped: 0,
          segments: [{ tStartMs: 0, tEndMs: 1000, text: 'legacy payload', lang: 'en' }],
        }),
    });
    const seg = [...soul.iterate('media-seg')][0]!;
    expect(seg.meta?.confidence).toBe(0.5); // unknown fidelity — never claimed good
    expect(seg.meta?.extractor).toBe('crib-worker');
    expect(seg.meta?.extractedBy).toBe('crib-worker');
    expect(seg.meta?.page).toBeUndefined();
    const segId = idFor({ kind: 'media-seg', path: 'talk.wav', tStartMs: 0 });
    expect(seg.id).toBe(segId);
  });
});
