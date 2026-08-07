/**
 * Grounding validator (M1.3 — the moat).
 *
 * Every claim an LLM-authored artifact makes must be traceable to a real on-disk span. An evidence
 * item carries a `soulId` (the anchor node) and a verbatim `quote` lifted from that node's rehydrated
 * source span. The validator rehydrates the anchor span and requires the quote to overlap the text;
 * a quote that does not appear is a hallucination signal. Evidence without a quote is "unsupported"
 * (cannot be verified, downgrades the artifact) but is not itself a hallucination — it preserves
 * backward compatibility with pre-M1.3 artifacts.
 *
 * The validator is PURE over the soul + repoRoot (no network, no model): `rehydrateBody` reads the
 * file from disk deterministically. The same check runs at `enrich_save` time (rejects/drops) and at
 * `crib audit-llm` time (re-verifies persisted artifacts), so a post-refactor re-verify is identical to
 * the original save-time verdict.
 */
import type { SoulStore } from '@knowledge-crib/core';
import { rehydrateBody } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import type { LlmArtifact, LlmEvidence } from './enrichment.js';

/** The verdict for a single evidence item. */
export type EvidenceVerdict = 'grounded' | 'ungrounded' | 'unsupported';

/** Per-evidence result from {@link verifyEvidence}. */
export interface EvidenceCheck {
  soulId: string;
  verdict: EvidenceVerdict;
  /** present when the verdict is `ungrounded` — why the quote did not overlap the span. */
  reason?: string;
}

/** The grounding verdict for one artifact. */
export interface GroundingResult {
  /** fraction of evidence that is grounded (0–1). `unsupported` evidence counts against this. */
  score: number;
  grounded: number;
  ungrounded: number;
  unsupported: number;
  /** true iff at least one quoted evidence was verified (the artifact is traceable to disk). */
  verified: boolean;
  checks: EvidenceCheck[];
}

/**
 * The largest span the validator will rehydrate to look for a quote. A real procedure/section body
 * fits well under this; a span larger than this is "too big to verify" and its quoted evidence is
 * treated as unsupported (honest, not a false-positive rejection).
 */
const VERIFY_MAX_CHARS = 256 * 1024;

/** Collapse runs of whitespace so formatting drift between quote and source still overlaps. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Verify a single evidence item against the rehydrated anchor span. PURE over the soul + repoRoot.
 *
 *   • no `quote` → `unsupported` (legacy or a model that skipped grounding; downgrades, not a reject)
 *   • anchor node missing or has no span/file → `unsupported` (the anchor itself is unverifiable)
 *   • span larger than {@link VERIFY_MAX_CHARS} → `unsupported` (too big to verify fairly)
 *   • quote (normalized) is a substring of the span text (normalized) → `grounded`
 *   • quote present but not found → `ungrounded` (the hallucination signal)
 */
export function verifyEvidence(
  soul: SoulStore,
  repoRoot: string,
  evidence: LlmEvidence,
): EvidenceCheck {
  const base: Pick<EvidenceCheck, 'soulId'> = { soulId: evidence.soulId };
  if (!evidence.quote || !evidence.quote.trim()) {
    return { ...base, verdict: 'unsupported', reason: 'no quote' };
  }
  const node: Node | undefined = soul.getNode(evidence.soulId);
  if (!node || !node.file || !node.span) {
    return { ...base, verdict: 'unsupported', reason: 'anchor node has no on-disk span' };
  }
  const body = rehydrateBody(repoRoot, node, {
    maxChars: VERIFY_MAX_CHARS,
    maxLines: Number.MAX_SAFE_INTEGER,
    ...(evidence.startLine ? { startLine: evidence.startLine } : {}),
  });
  if (!body.text) {
    return { ...base, verdict: 'unsupported', reason: 'anchor span rehydrated empty' };
  }
  // The char cap is generous (256 KiB). If the span still overflowed it, the quote may live in the
  // un-paged tail — treat as unsupported rather than risk a false hallucination flag.
  if (body.truncated && body.totalLines > 0 && body.text.length >= VERIFY_MAX_CHARS) {
    return { ...base, verdict: 'unsupported', reason: 'span exceeds verify budget' };
  }
  const hay = normalize(body.text);
  const needle = normalize(evidence.quote);
  if (needle && hay.includes(needle)) {
    return { ...base, verdict: 'grounded' };
  }
  return { ...base, verdict: 'ungrounded', reason: 'quote not found in anchor span' };
}

/** Verify every evidence item on an artifact. PURE over the soul + repoRoot. */
export function verifyArtifact(
  soul: SoulStore,
  repoRoot: string,
  artifact: LlmArtifact,
): GroundingResult {
  let grounded = 0;
  let ungrounded = 0;
  let unsupported = 0;
  const checks: EvidenceCheck[] = [];
  for (const ev of artifact.evidence ?? []) {
    const check = verifyEvidence(soul, repoRoot, ev);
    checks.push(check);
    if (check.verdict === 'grounded') grounded++;
    else if (check.verdict === 'ungrounded') ungrounded++;
    else unsupported++;
  }
  const total = (artifact.evidence ?? []).length;
  const score = total > 0 ? grounded / total : 0;
  return {
    score,
    grounded,
    ungrounded,
    unsupported,
    verified: grounded > 0,
    checks,
  };
}
