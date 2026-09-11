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
    expect(html).toContain('Work in progress');
    expect(html).toContain('Needs review');
    expect(html).toContain('Retrieval mode');
    expect(html).toContain('focus-visible');
  });

  it('makes pending and resumable memory work actionable from the home tiles', () => {
    expect(html).toContain('data-kc-memory-home-action');
    expect(html).toContain('openMemoryHomeAction');
    expect(html).toContain('Review pending outcomes');
    expect(html).toContain('Continue, finish or cancel saved work');
  });

  it('ships session maintenance: close work, re-check and dismiss pending captures', () => {
    // endpoints the viz server exposes behind the same Origin + CSRF mutation boundary
    expect(html).toContain('/memory/intake/close');
    expect(html).toContain('/memory/pending/recheck');
    expect(html).toContain('/memory/pending/dismiss');
    expect(html).toContain('closeIntake');
    expect(html).toContain('recheckPending');
    expect(html).toContain('dismissCapture');
    // the controls themselves
    expect(html).toContain('data-kc-mem-recheck');
    expect(html).toContain('data-kc-mem-dismiss');
    expect(html).toContain('data-kc-mem-intake-done');
    expect(html).toContain('data-kc-mem-intake-cancel');
    // stale work is labelled, finished work is counted apart instead of crowding the list
    expect(html).toContain("'stale · idle '");
    expect(html).toContain('kept in history.');
    // the old next step named a command needing an LLM provider nobody configured
    expect(code).not.toContain('distill --provider');
  });

  it('opens on the architecture Overview by default, whatever the graph size', () => {
    expect(html).toContain("mode:this.overview.length?'overview':'focus'");
    expect(html).not.toContain("mode:this.largeGraph?'overview':'focus'");
  });

  it('renders a ledger row verdict from evidenceVerdict, never the evidence array', () => {
    expect(html).toContain('v.evidenceVerdict');
  });

  it('ships the pending queue view wired to its read and mutation endpoints (WP6.1–WP6.3)', () => {
    expect(html).toContain('/memory/pending.json');
    expect(html).toContain('/memory/intake.json');
    expect(html).toContain('/memory/admit');
    expect(html).toContain('/memory/resume');
    expect(html).toContain('/memory/mutation-grant.json');
    expect(html).toContain('x-crib-csrf');
    expect(html).toContain('loadMemoryPending');
    expect(html).toContain('admitStagedClaim');
    expect(html).toContain('resumeIntake');
    // the pending queue pages through the same limit the read endpoint defaults to
    expect(html).toContain('PEND_LIMIT=20');
  });

  it('marks only ready rows admissible and names the terminal path honestly (WP6.3)', () => {
    expect(html).toContain("r.standing==='ready'");
    expect(html).toContain('No raw captures waiting.');
    expect(html).toContain('No staged claims waiting.');
    expect(html).toContain('No work in progress.');
    // captured learnings get re-check and dismiss controls — never an external-model distill step
    expect(html).toContain('Captured learnings waiting for review');
    expect(html).toContain('Staged claims awaiting admission');
  });

  it('keeps the resume flow honest — records the decision, never executes it (WP6.4)', () => {
    expect(html).toContain('Records the resume against checkpoint');
    expect(html).toContain('Nothing is executed.');
    expect(html).toContain('leave empty to reuse the saved one');
    expect(html).toContain('The repository moved since the saved checkpoint');
  });

  it('keeps the new views keyboard-usable and announced (WP6.6)', () => {
    expect(html).toContain('data-kc-mem-action-head');
    expect(html).toContain('data-kc-mem-resume-list');
    expect(html).toContain('data-kc-mem-intake-back');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('keepFocus');
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
