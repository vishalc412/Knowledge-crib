import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { vizAssetsDir } from './viz.js';

/**
 * G5.4 — the memory ledger panel ships inside the static viz asset (packages/ui/web/index.html),
 * which the viz server serves VERBATIM — there is no build step, so these assertions pin the
 * asset's content contract directly:
 *
 *   - the panel + its two endpoints are wired (`/memory.json`, `/memory/record.json`);
 *   - no new external scripts (the asset system is self-contained and offline — every script is a
 *     bundled or relative path, never a CDN);
 *   - the Gate-0 user-facing vocabulary law: no banned word survives into the shipped asset. The
 *     check strips JS comments first (a code comment is not user-facing text) and matches on word
 *     boundaries, so the backend field identifier `trustedRef` (an API field ACCESS, rendered as
 *     "ref <value>") does not count as a hit.
 */

const html = readFileSync(`${vizAssetsDir()}/index.html`, 'utf8');

/** The asset with JS comments removed (string literals and markup stay). */
const code = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('viz web asset: memory ledger panel (G5.4)', () => {
  it('ships the memory panel wired to both ledger endpoints', () => {
    expect(html).toContain('Memory ledger panel (G5.4)');
    expect(html).toContain('/memory.json');
    expect(html).toContain('/memory/record.json');
    expect(html).toContain('/memory/home.json');
    expect(html).toContain('Work to resume');
    expect(html).toContain('Needs review');
    expect(html).toContain('Retrieval mode');
    expect(html).toContain('focus-visible');
  });

  it('stays self-contained — no external (CDN) scripts', () => {
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src.startsWith('http')).toBe(false);
    }
  });

  it('carries no banned user-facing vocabulary (comments excluded)', () => {
    expect(code).not.toMatch(/\bcandidate\b/i);
    expect(code).not.toMatch(/\btrust\b/i);
  });
});
