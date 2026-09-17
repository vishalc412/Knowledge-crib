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
  // A file node carries no span — the file IS its span. Without this, a quote from a top-level
  // declaration, an import, or any config/YAML/JSON file (which index as a span-less file node only)
  // could never verify. Redaction and deny policies still apply inside rehydration.
  const anchor =
    node?.kind === 'file' && node.file && !node.span
      ? { ...node, span: { start: 1, end: Number.MAX_SAFE_INTEGER } }
      : node;
  if (!anchor || !anchor.file || !anchor.span) {
    return { verdict: 'unsupported', reason: 'anchor node has no on-disk span' };
  }
  const body = port.rehydrate(anchor, {
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

// ─── hints: what the code says now, and which line is worth quoting ─────────────

/** Minimum Dice similarity for a live line to be offered as "did you mean" for a refused quote. */
const CLOSEST_MIN_SIMILARITY = 0.3;

/** Lower-cased identifier sub-words: `isFllGradeBandK2Only` → is, fll, grade, band, k2, only. */
function subwords(text: string): Set<string> {
  const out = new Set<string>();
  for (const ident of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []) {
    for (const part of ident
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)) {
      if (part) out.add(part.toLowerCase());
    }
  }
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * The current text most similar to a quote that did NOT verify — so a refusal can say what the code
 * says now instead of only "not found". Compares windows as tall as the quote (in non-blank lines)
 * by identifier sub-word overlap; ties go to the window nearest the cited line. Returns undefined
 * when nothing is meaningfully similar. A hint only: it never grounds anything.
 */
export function closestLiveText(
  port: RehydratePort,
  fileNode: Node,
  quote: string,
  near?: number,
): { line: number; text: string } | undefined {
  if (!fileNode.file || !quote.trim()) return undefined;
  const anchor = fileNode.span
    ? fileNode
    : { ...fileNode, span: { start: 1, end: Number.MAX_SAFE_INTEGER } };
  const body = port.rehydrate(anchor, { maxChars: VERIFY_MAX_CHARS });
  if (!body.text) return undefined;
  const lines = body.text.split('\n');
  const first = body.startLine > 0 ? body.startLine : 1;
  const height = Math.max(1, quote.split('\n').filter((l) => l.trim()).length);
  const want = subwords(quote);
  let best: { line: number; text: string; score: number } | undefined;
  for (let i = 0; i + height <= lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const window = lines.slice(i, i + height);
    const score = dice(want, subwords(window.join(' ')));
    if (score < CLOSEST_MIN_SIMILARITY) continue;
    const line = first + i;
    const closer =
      best !== undefined &&
      score === best.score &&
      near !== undefined &&
      Math.abs(line - near) < Math.abs(best.line - near);
    if (!best || score > best.score || closer) {
      best = { line, text: window.map((l) => l.trim()).join('\n'), score };
    }
  }
  return best ? { line: best.line, text: best.text } : undefined;
}

/** Words too generic to decide which line an observation is about. */
const HINT_STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'must',
  'should',
  'when',
  'only',
  'never',
  'always',
  'true',
  'false',
  'return',
  'public',
  'private',
  'static',
  'void',
  'final',
  'class',
  'const',
  'function',
  'there',
  'which',
  'because',
  'into',
  'have',
  'does',
  'will',
  'can',
  'not',
]);

/**
 * The line of `body` most worth quoting for an observation: the one naming the identifiers the
 * observation mentions (longer, more specific names weigh more). A declaration's signature is its
 * most volatile text, so quoting the relevant line keeps evidence valid across unrelated edits.
 * Falls back to the head of the span when the observation names nothing that appears in it.
 */
export function liftRelevantQuote(body: string, hint: string, maxChars: number): string {
  const wanted = new Set(
    (hint.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 4 && !HINT_STOPWORDS.has(w)),
  );
  let best: { text: string; score: number } | undefined;
  for (const raw of body.split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const idents = new Set(
      (text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((w) => w.toLowerCase()),
    );
    let score = 0;
    for (const w of wanted) if (idents.has(w)) score += w.length;
    if (score > 0 && (!best || score > best.score)) best = { text, score };
  }
  return best ? best.text.slice(0, maxChars) : body.trim().slice(0, maxChars);
}
