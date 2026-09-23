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
const tokens = readFileSync(`${vizAssetsDir()}/tokens.css`, 'utf8');

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
    expect(html).toContain('data-kc-health="{{ signal.key }}"');
    expect(html).toContain('./memory-view-projection.js');
    expect(html).toContain('focus-visible');
  });

  it('wires record Connections and History as keyboard-operable lists (WP-G7)', () => {
    expect(html).toContain('/memory/graph.json');
    expect(html).toContain('data-kc-mem-connections');
    expect(html).toContain('data-kc-mem-history');
    expect(html).toContain('data-kc-mem-detail-back');
    expect(html).toContain('openLinkedWork');
    expect(html).toContain('openLinkedClaim');
    // Linked claims and work are <button>s — reachable and activatable without a pointer.
    expect(html).toMatch(/<button data-kc-mem-connection="\{\{ cn\.ref \}\}"/);
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

  it('ships the supplied design system’s grid workspace and inclusive motion rules', () => {
    expect(html).toContain('data-kc-shell="signal-console"');
    expect(html).toContain('data-kc-navigation-rail');
    expect(html).toContain('data-kc-graph-stage');
    expect(html).toContain('data-kc-inspector');
    expect(html).toContain('data-kc-statusline');
    expect(html).toContain('<link rel="stylesheet" href="./tokens.css">');
    expect(tokens).toContain('--kc-accent-code');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('grid-template-rows:52px minmax(0,1fr) 26px');
    expect(html).toContain(
      'grid-template-columns:var(--kc-rail-width) minmax(0,1fr) var(--kc-inspector-width)',
    );
    expect(html).toContain('grid-area:2 / 2');
    expect(html).toContain('grid-area:2 / 1 / 3 / 4');
    expect(html).toContain('z-index:40 !important');
  });

  it('ships a local token sheet whose light and dark themes define the same tokens', () => {
    // Offline: no remote stylesheet, import or font request.
    expect(tokens).not.toMatch(/@import|url\(/);
    const block = (theme: string) => {
      const start = tokens.indexOf(`[data-kc-theme="${theme}"]`);
      expect(start).toBeGreaterThan(-1);
      return tokens.slice(start, tokens.indexOf('}', start));
    };
    const names = (css: string) => [...css.matchAll(/(--kc-[\w-]+)\s*:/g)].map((m) => m[1]).sort();
    expect(names(block('dark'))).toEqual(names(block('light')));
    for (const token of [
      '--kc-surface-floating',
      '--kc-text-primary',
      '--kc-text-secondary',
      '--kc-text-interactive',
      '--kc-focus',
      '--kc-border-control',
      '--kc-canvas-label',
    ]) {
      expect(names(block('dark'))).toContain(token);
    }
    // Theme choice: system preference first, then the one documented, validated storage key.
    expect(html).toContain("THEME_KEY='knowledge-crib:theme'");
    expect(html).toContain("v==='light'||v==='dark'?v:null");
    expect(html).toContain('(prefers-color-scheme: light)');
  });

  it('turns structural module IDs into readable navigation labels', () => {
    expect(html).toContain('formatRailLabel(value)');
    expect(html).toContain(".replace(/^module:/,'')");
    expect(html).toContain("return 'Workspace';");
    expect(html).toContain("const initialisms={cli:'CLI',mcp:'MCP',ui:'UI'};");
    expect(html).toContain('label:this.formatRailLabel(m.label||m.id)');
    expect(html).toContain('block.isModule?this.formatRailLabel(block.label||block.id)');
    expect(html).toContain('railNodeCount:this.nodes.length.toLocaleString()');
  });

  it('keeps the primary command path contiguous in the reference header', () => {
    const firstFlexibleSpacer = html.indexOf('<div style="flex:1;"></div>');
    expect(firstFlexibleSpacer).toBeGreaterThan(html.indexOf('data-kc-command="blast"'));
  });

  it('implements the supplied command bar instead of the legacy toolbar', () => {
    expect(html).toContain('data-kc-command-segment');
    expect(html).toContain('data-kc-command="overview"');
    expect(html).toContain('data-kc-command="focus"');
    expect(html).toContain('data-kc-command="blast"');
    expect(html).toContain('data-kc-search-shortcut');
    expect(html).toContain('⌘K');
    expect(html).toContain('data-kc-memory-badge');
    expect(html).not.toContain('>Tour\n');
    expect(html).not.toContain('>Blast radius\n');
  });

  it('ships the supplied graph-stage chrome and compact overview geometry', () => {
    expect(html).toContain('data-kc-stage-breadcrumbs');
    expect(html).toContain('data-kc-stage-overflow');
    expect(html).toContain('data-kc-minimap');
    expect(html).toContain('data-kc-stage-zoom');
    expect(html).toContain('const CARD_W=196,CARD_H=118,GAP_X=22,GAP_Y=16;');
    expect(html).not.toContain("ctx.fillText('Architecture overview'");
  });

  it('uses the supplied inspector hierarchy for real graph detail', () => {
    expect(html).toContain('data-kc-inspector-actions');
    expect(html).toContain('data-kc-inspector-summary');
    expect(html).toContain('data-kc-inspector-signature');
    expect(html).toContain('data-kc-inspector-connections');
    expect(html).toContain('data-kc-inspector-source');
    expect(html).toContain('data-kc-inspector-evidence');
    expect(html).toContain('data-kc-inspector-section');
    expect(html).toContain('toggleInspectorSection');
    expect(html).toContain('toggleInspectorSource');
    expect(html).toContain('sourceOpen');
    expect(html).toContain('sec.open');
    expect(html.indexOf('data-kc-inspector-source')).toBeGreaterThan(
      html.indexOf('data-kc-inspector-connections'),
    );
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
