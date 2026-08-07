/**
 * Pure quote-overlap grounding for memory evidence (PRD §2 admissibility: "The existing quote-overlap
 * grounding logic in grounding.ts is reused for source evidence").
 *
 * Reimplemented HERE in the memory package — depending only on `@knowledge-crib/core`'s
 * `rehydrateBody` + `@knowledge-crib/soul-schema`'s `Node` — so the freshness engine (Slice 3) NEVER
 * depends on `mcp` (the serving layer). The check is PURE over the soul + repoRoot: no network, no
 * model. The logic is identical to `mcp/grounding.ts` `verifyEvidence` so a memory revalidation
 * verdict matches the original save-time grounding verdict (a post-refactor re-verify is identical).
 *
 * Three states (mirrors `mcp/grounding.ts` `EvidenceVerdict`):
 *   - `grounded`    — the normalized quote is a substring of the normalized rehydrated span.
 *   - `ungrounded`  — a quote is present but not found in the anchor span (the hallucination signal).
 *   - `unsupported` — no quote, or the anchor has no on-disk span, or the span exceeds the verify
 *                     budget (cannot verify fairly; downgrades, not a hallucination flag).
 */
import type { RehydratedBody } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';

/** The verdict for one source-quote evidence item. */
export type QuoteVerdict = 'grounded' | 'ungrounded' | 'unsupported';

/** Per-item result from {@link verifyQuote}. */
export interface QuoteCheck {
  verdict: QuoteVerdict;
  /** present when the verdict is not `grounded` — why the quote did not overlap the span. */
  reason?: string;
}

/**
 * The largest span the validator will rehydrate to look for a quote. A real procedure/section body
 * fits well under this; a span larger than this is "too big to verify" and its quoted evidence is
 * treated as unsupported (honest, not a false-positive rejection). Mirrors `mcp/grounding.ts`.
 */
const VERIFY_MAX_CHARS = 256 * 1024;

/** Collapse runs of whitespace so formatting drift between quote and source still overlaps. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The rehydrate port the evaluator depends on. A thin adapter wraps `SoulStore` + `rehydrateBody`
 * (see {@link SoulStoreSoulPort} in `evaluator.ts`); tests fake it so the freshness engine is
 * verified without a full soul index. PURE contract: rehydrate reads disk deterministically.
 */
export interface RehydratePort {
  rehydrate(node: Node, opts?: { maxChars?: number; startLine?: number }): RehydratedBody;
}

/**
 * Verify a source-quote evidence item against a rehydrated anchor span. PURE over the soul + repoRoot.
 *
 *   • no `quote` → `unsupported` (a model that skipped grounding; downgrades, not a reject)
 *   • anchor node missing or has no span/file → `unsupported` (the anchor itself is unverifiable)
 *   • span larger than {@link VERIFY_MAX_CHARS} → `unsupported` (too big to verify fairly)
 *   • quote (normalized) is a substring of the span text (normalized) → `grounded`
 *   • quote present but not found → `ungrounded` (the hallucination signal)
 */
export function verifyQuote(
  port: RehydratePort,
  node: Node | undefined,
  quote: string | undefined,
  startLine?: number,
): QuoteCheck {
  if (!quote || !quote.trim()) return { verdict: 'unsupported', reason: 'no quote' };
  if (!node || !node.file || !node.span) {
    return { verdict: 'unsupported', reason: 'anchor node has no on-disk span' };
  }
  const body = port.rehydrate(node, {
    maxChars: VERIFY_MAX_CHARS,
    ...(startLine ? { startLine } : {}),
  });
  if (!body.text) return { verdict: 'unsupported', reason: 'anchor span rehydrated empty' };
  // The char cap is generous (256 KiB). If the span still overflowed it, the quote may live in the
  // un-paged tail — treat as unsupported rather than risk a false hallucination flag.
  if (body.truncated && body.totalLines > 0 && body.text.length >= VERIFY_MAX_CHARS) {
    return { verdict: 'unsupported', reason: 'span exceeds verify budget' };
  }
  const hay = normalize(body.text);
  const needle = normalize(quote);
  if (needle && hay.includes(needle)) return { verdict: 'grounded' };
  return { verdict: 'ungrounded', reason: 'quote not found in anchor span' };
}
