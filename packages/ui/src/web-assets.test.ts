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
 *
 * WP3-H4 — the law is scoped to every asset the viz server SERVES, not to one filename. Extraction
 * moves logic between these files, and a law that covers only `index.html` is a law code can be
 * walked out of: a banned word in `graph-model.js` reaches the user exactly as one in the markup
 * would. The assertions themselves are unchanged; only the set of files they run over is.
 */

/** Every asset `viz-server` serves to the browser. `support.js` is the generated DC runtime. */
const SERVED_ASSETS = ['index.html', 'graph-model.js', 'support.js'] as const;

/**
 * One served asset with JS comments removed. String literals and markup are deliberately NOT
 * stripped — those are exactly what reaches the user — while comments are, because a code comment
 * is not user-facing text.
 *
 * The line-based `//` rule has a measured limit: a `//` inside a string literal eats the rest of
 * that line, so a banned word later on the same line goes unseen. Verified directly — the source
 * `var u = "https://x"; var t = "trust";` yields no hit, while the same text without the `//`
 * yields one. The error is therefore always UNDER-reporting, never a false alarm, and it is
 * dormant today: no served asset has a line carrying both an inline `//` and a banned word, so the
 * guarantee holds for this tree even though the rule cannot be trusted to hold for a future one.
 * Stated here because it bounds the guarantee below.
 */
function strippedSource(name: (typeof SERVED_ASSETS)[number]): string {
  return readFileSync(`${vizAssetsDir()}/${name}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const html = readFileSync(`${vizAssetsDir()}/index.html`, 'utf8');

/** The asset with JS comments removed (string literals and markup stay). */
const code = strippedSource('index.html');

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

  it('carries no banned user-facing vocabulary in any served asset (comments excluded)', () => {
    // Scope is SERVED_ASSETS, not index.html: this is the same law, applied to everything the
    // browser receives. See the header note — narrowing it back to one file would let extraction
    // move a banned word out of the check's sight without changing what the user sees.
    for (const name of SERVED_ASSETS) {
      const src = strippedSource(name);
      expect(src, `${name}: banned word "candidate"`).not.toMatch(/\bcandidate\b/i);
      expect(src, `${name}: banned word "trust"`).not.toMatch(/\btrust\b/i);
    }
  });

  it('keeps the extracted render helpers in the module, never re-inlined (WP3-H4)', () => {
    // `hex`, `esc`, `ellipsize` and `rr` were methods on the component class in this asset, where
    // the only thing able to assert them was a string match — the logic of the ellipsize search or
    // the channel extraction could regress unobserved. They now live in graph-model.js, covered
    // behaviourally by graph-model.test.ts. This pins the direction: re-inlining one would quietly
    // move it back outside test reach, and every call site would still work.
    for (const helper of ['hex', 'esc', 'ellipsize', 'rr']) {
      expect(html, `${helper} re-defined on the component`).not.toMatch(
        new RegExp(`this\\.${helper}\\(`),
      );
      expect(html, `${helper} not called through the module`).toMatch(
        new RegExp(`KCGraphModel\\.${helper}\\(`),
      );
    }
  });
});

/**
 * WP5 T15 — the exclusion-reason vocabulary is COMPLETE in both directions.
 *
 * WP5 §7.4 renders a row's `ItemReason` codes as words; §10 freezes the evaluator's union as the
 * exclusion vocabulary and forbids inventing a second one. Both halves of that are unenforced by
 * types, because the union is declared in `@knowledge-crib/memory` and the map that renders it is
 * in a served asset — no compiler spans that boundary, and no runtime path makes an unrendered code
 * fail. It just... shows the raw code to the user, or nothing at all.
 *
 * So this test spans the boundary deliberately, and it reads the union out of its DECLARATION
 * instead of re-typing it: a re-typed list is a second copy that passes while the real union grows,
 * which is exactly the failure being guarded. Direction matters both ways — a union member with no
 * rendering is an invisible reason, and a rendering for a code the evaluator cannot emit is a
 * second vocabulary growing quietly in the UI.
 */
describe('viz web asset: the exclusion-reason vocabulary (WP5 T15)', () => {
  /** The `ItemReason` union, parsed from its declaration in the evaluator source. */
  function evaluatorReasons(): string[] {
    const src = readFileSync(new URL('../../memory/src/evaluator.ts', import.meta.url), 'utf8');
    const body = /export type ItemReason =([\s\S]*?);/.exec(src)?.[1];
    if (body === undefined) {
      throw new Error('ItemReason declaration not found in memory/src/evaluator.ts');
    }
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  }

  /** The codes `memReason` maps, parsed from the served asset (one entry per line). */
  function renderedReasons(): string[] {
    const region = /memReason\(code\)\{[\s\S]*?const M=\{([\s\S]*?)\};/.exec(html)?.[1];
    if (region === undefined) throw new Error('memReason map not found in the served asset');
    return [...region.matchAll(/^\s*'([a-z-]+)':/gm)].map((m) => m[1] as string);
  }

  it('parses both vocabularies (a guard against the extraction silently returning nothing)', () => {
    // Without this, a rename in either file would make both lists empty and every cross-check below
    // would pass vacuously. The floors are deliberately well under the real counts.
    expect(evaluatorReasons().length).toBeGreaterThanOrEqual(10);
    expect(renderedReasons().length).toBeGreaterThanOrEqual(10);
    expect(evaluatorReasons()).toContain('hash-drift');
    expect(renderedReasons()).toContain('hash-drift');
  });

  it('renders every reason the evaluator can emit — no reason is silently invisible', () => {
    const missing = evaluatorReasons().filter((code) => !renderedReasons().includes(code));
    expect(missing, `ItemReason members with no rendering: ${missing.join(', ')}`).toEqual([]);
  });

  it('invents no reason the evaluator cannot emit — the vocabulary is not forked', () => {
    const union = evaluatorReasons();
    const invented = renderedReasons().filter((code) => !union.includes(code));
    expect(invented, `rendered codes absent from ItemReason: ${invented.join(', ')}`).toEqual([]);
  });

  it('keeps the evaluator code in the DOM and falls back to it rather than to prose', () => {
    // G-U1: the reason a row was excluded must be the EVALUATOR's verdict, not UI copy. The code
    // rides on the element, so a test asserts the evaluator's word and not our sentence.
    expect(html).toContain('data-kc-mem-reason="{{ why.code }}"');
    // An unrecognised code renders as itself. Smoothing it into a reassuring phrase is how a new
    // evaluator reason would become invisible while the cross-checks above still passed.
    expect(html).toContain('return M[code]||String(code);');
  });
});
