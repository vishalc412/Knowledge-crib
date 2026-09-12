/**
 * Gated automatic admission — how an agent observation becomes recallable WITHOUT a manual
 * `crib memory evaluate` + `crib memory activate`, and without handing the agent the power to
 * trust itself.
 *
 * WHY
 * `memory_observe` staged every agent write as an untrusted candidate that normal recall withholds,
 * and the only way out was a CLI promotion nobody runs mid-session. Agents told users "recorded",
 * recall came back empty, and the store looked write-only.
 *
 * WHAT KEEPS THIS GATED
 * The agent never supplies a verdict. Crib re-derives every one itself: agent-cited source quotes
 * are re-grounded against the live code ({@link groundAgentEvidence}), the independent evaluator
 * aggregates them under the admissibility matrix ({@link evaluateForAdmission}), and
 * {@link decideAutoAdmission} admits only what that evaluation supports. Admission grants LOCAL
 * trust only — team trust still needs CI plus a trusted ref — and an admitted record that later
 * drifts is downgraded by the same freshness engine as every other record.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import type { MemoryRecordKind } from './enums.js';
import type { MemoryEvalContext, MemoryEvaluator, RecordEvaluation } from './evaluator.js';
import { type RehydratePort, verifyQuote } from './grounding.js';
import { buildRecord } from './promotion.js';
import type { MemoryStore } from './store.js';
import type { MemoryCandidate, MemoryEvidence, MemoryRecord } from './types.js';

// ─── grounding agent-cited quotes ────────────────────────────────────────────

/** The soul view grounding needs: every node (to find the span holding a cited line) + rehydrate. */
export interface GroundingPort extends RehydratePort {
  allNodes(): readonly Node[];
}

/** How many spans (narrowest first) one cited quote is tried against before giving up. */
const GROUNDING_MAX_SPANS = 8;

/**
 * Anchor agent-cited source quotes to the soul. Agents cite code the way people do — a path, a line,
 * the quoted text — but the evaluator can only verify a quote pinned to a soul id + content hash, so
 * that evidence was `anchor-gone` on arrival and the claim could never be admitted.
 *
 * For each source-quote carrying a `path` and no `soulId`, the spanned nodes of that file holding
 * the cited `line` (every spanned node of the file when no line is cited) are tried NARROWEST FIRST;
 * the first span the quote verifies `grounded` against stamps `soulId` / `targetHash` / `startLine`.
 * A quote that grounds nowhere is returned unchanged, so the evaluator still rejects it: grounding
 * adds an anchor, never a verdict.
 */
export function groundAgentEvidence(
  port: GroundingPort,
  evidence: readonly MemoryEvidence[],
): MemoryEvidence[] {
  let nodes: readonly Node[] | undefined;
  return evidence.map((ev) => {
    if (ev.kind !== 'source-quote' || ev.soulId || typeof ev.path !== 'string' || !ev.quote) {
      return ev;
    }
    nodes ??= port.allNodes();
    const line =
      typeof ev.line === 'number'
        ? ev.line
        : typeof ev.startLine === 'number'
          ? ev.startLine
          : undefined;
    for (const node of spansAt(nodes, ev.path, line)) {
      if (verifyQuote(port, node, ev.quote).verdict !== 'grounded') continue;
      return {
        ...ev,
        soulId: node.id,
        targetHash: node.hash,
        ...(node.span ? { startLine: node.span.start } : {}),
      };
    }
    // No declaration span holds the quote — a top-level constant, an import, a config or YAML line.
    // Anchor to the file node itself: its hash is the file's content hash, so drift is still caught.
    const fileNode = nodes.find((n) => n.kind === 'file' && n.file === ev.path);
    if (fileNode) {
      const startLine = line !== undefined ? Math.max(1, line - FILE_QUOTE_WINDOW) : 1;
      if (verifyQuote(port, fileNode, ev.quote, startLine).verdict === 'grounded') {
        return { ...ev, soulId: fileNode.id, targetHash: fileNode.hash, startLine };
      }
    }
    return ev;
  });
}

/** Lines above a cited line that file-level grounding still searches (agents' line numbers drift). */
const FILE_QUOTE_WINDOW = 20;

/** True when the index holds any node in `path` — separates "not indexed yet" from "quote not found". */
export function isIndexedFile(port: GroundingPort, path: string): boolean {
  return port.allNodes().some((n) => n.file === path);
}

/** Spanned nodes of `path` that hold `line` (all spanned nodes when absent), narrowest first. */
function spansAt(nodes: readonly Node[], path: string, line: number | undefined): Node[] {
  const width = (n: Node): number => (n.span ? n.span.end - n.span.start : Number.MAX_SAFE_INTEGER);
  return nodes
    .filter(
      (n) =>
        n.file === path &&
        n.span !== undefined &&
        (line === undefined || (line >= n.span.start && line <= n.span.end)),
    )
    .sort((a, b) => width(a) - width(b) || a.id.localeCompare(b.id))
    .slice(0, GROUNDING_MAX_SPANS);
}

/** How many `appliesTo` targets are neither a soul node id nor a file the soul indexes. */
export function unresolvedTargetsIn(port: GroundingPort, appliesTo: readonly string[]): number {
  if (appliesTo.length === 0) return 0;
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const n of port.allNodes()) {
    ids.add(n.id);
    if (n.file) files.add(n.file);
  }
  return appliesTo.filter((target) => !ids.has(target) && !files.has(target)).length;
}

// ─── evaluation + the gate ───────────────────────────────────────────────────

/**
 * Evaluate a staged candidate FRESH for admission. The pass/cache slots of the serving context are
 * deliberately dropped: an admission decision must be computed against the live soul, never served
 * from a recall-pass memo bound to an earlier generation.
 */
export function evaluateForAdmission(
  evaluator: MemoryEvaluator,
  ctx: MemoryEvalContext,
  candidate: MemoryCandidate,
  now: () => string,
): RecordEvaluation {
  const provisional = buildRecord(
    candidate,
    { trust: 'candidate', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    candidate.evidence,
    now(),
  );
  return evaluator.evaluate(provisional, {
    soul: ctx.soul,
    ...(ctx.receipts ? { receipts: ctx.receipts } : {}),
    ...(ctx.policy ? { policy: ctx.policy } : {}),
  });
}

export type AdmissionVerdict = 'admit' | 'hold';

export interface AdmissionDecision {
  verdict: AdmissionVerdict;
  /** a short, stable reason — surfaced to the agent verbatim, so it must say what to do next. */
  reason: string;
}

/** Everything the gate may look at — derived by crib from its OWN evaluation, never from the caller. */
export interface AdmissionSignals {
  kind: MemoryRecordKind;
  authorKind: 'agent' | 'human';
  /** the evaluator's aggregate evidence verdict over the grounded evidence. */
  evidence: RecordEvaluation['evidence'];
  /** the evaluator's aggregate applicability verdict. */
  applicability: RecordEvaluation['applicability'];
  /** evidence items the evaluator verified `valid` (inadmissible `ignored` items excluded). */
  validItems: number;
  /** evidence items the evaluator found `degraded` — reattached, hash drift, no quote. */
  degradedItems: number;
  /** evidence items the evaluator found `invalid` — quote not found, anchor gone. */
  invalidItems: number;
  /** `appliesTo` targets the index does not know (0 when every target resolves, or none given). */
  unresolvedTargets: number;
  /** human attestations an agent relayed and no person has confirmed yet (`relayed-unconfirmed`). */
  relayedItems?: number;
}

export function admissionSignals(
  candidate: MemoryCandidate,
  evaluation: RecordEvaluation,
  unresolvedTargets: number,
): AdmissionSignals {
  const count = (verdict: string): number =>
    evaluation.items.filter((item) => item.evidence === verdict).length;
  return {
    kind: candidate.kind,
    authorKind: candidate.authorship.kind,
    evidence: evaluation.evidence,
    applicability: evaluation.applicability,
    validItems: count('valid'),
    degradedItems: count('degraded'),
    invalidItems: count('invalid'),
    unresolvedTargets,
    relayedItems: evaluation.items.filter((item) => item.reason === 'relayed-unconfirmed').length,
  };
}

/**
 * THE GATE. Decide whether a staged observation is admitted to local trust right now, or held as a
 * pending candidate (still readable via `includePending`, still promotable by the CLI).
 *
 * The rule is "admit what crib itself can vouch for, hold the rest — and say what would change the
 * answer". Holds, checked in order:
 *   1. `decision` / `convention` WITHOUT the user's relayed words — those kinds admit only human
 *      attestation or committed policy. When the agent relays what the user said (a
 *      `relayed-unconfirmed` attestation) the claim IS admitted locally, labelled unconfirmed; a
 *      person makes it verified with `crib memory remember`.
 *   2. any citation that does not match the code — the author's picture of the code is off, and
 *      admitting the matching rest would launder that confusion into trusted memory.
 *   3. nothing verifiable at all — no evidence item crib could check.
 *   4. the claim asks for more than its citations show — a pitfall without a receipt pair or
 *      reproduction, a procedure promising an outcome without an execution receipt.
 *   5. anchors that are orphaned or need review.
 *   6. no citation matched exactly — only after reattachment or hash drift.
 *   7. `appliesTo` naming something the index does not know — a typo or stale path whose graph
 *      edge would silently vanish.
 * Everything else — at least one exact grounded citation, no failures, current anchors, resolvable
 * targets — is admitted. Omitting `appliesTo` is allowed: the grounded evidence anchors the claim.
 */
export function decideAutoAdmission(s: AdmissionSignals): AdmissionDecision {
  const hold = (reason: string): AdmissionDecision => ({ verdict: 'hold', reason });
  if (s.kind === 'decision' || s.kind === 'convention') {
    // The user's own words, relayed by the agent: admitted locally so they are REMEMBERED, labelled
    // unconfirmed so nobody mistakes them for a verified record. Escalation still needs a person.
    if ((s.relayedItems ?? 0) > 0 && s.invalidItems === 0 && s.evidence !== 'invalid') {
      return {
        verdict: 'admit',
        reason: `relayed: kept as the user's stated ${s.kind} (unconfirmed) — recallable on this device; the user can confirm it with \`crib memory remember\` to make it verified and team-shareable`,
      };
    }
    return hold(
      `a ${s.kind} needs the user's own words — relay them as evidence { kind: 'human-attestation', quote: '<what they said>' }, or ask the user to record it with \`crib memory remember\``,
    );
  }
  if (s.invalidItems > 0) {
    return hold(
      `${s.invalidItems} citation(s) do not match the current code — fix or drop them and observe again`,
    );
  }
  if (s.validItems + s.degradedItems === 0) {
    return hold('no evidence crib could verify — cite the code as path + line + exact quote');
  }
  if (s.evidence === 'invalid' || (s.evidence === 'degraded' && s.degradedItems === 0)) {
    return hold(
      `the citations check out, but a ${s.kind} claims more than quotes can show (a pitfall needs a failing+passing receipt pair; a promised outcome needs an execution receipt)`,
    );
  }
  if (s.applicability !== 'current') {
    return hold(
      `its code anchors are ${s.applicability} — re-read the code and observe against its current state`,
    );
  }
  if (s.validItems === 0) {
    return hold(
      'evidence matched only after reattachment or drift — re-cite the current code exactly',
    );
  }
  if (s.unresolvedTargets > 0) {
    return hold(
      `${s.unresolvedTargets} appliesTo target(s) are not in the index — use a symbol id or an indexed file path`,
    );
  }
  return {
    verdict: 'admit',
    reason:
      s.degradedItems > 0
        ? `grounded: ${s.validItems} exact citation(s), ${s.degradedItems} drifted`
        : `grounded: ${s.validItems} exact citation(s)`,
  };
}

// ─── the write ───────────────────────────────────────────────────────────────

/**
 * Write an ADMITTED candidate as a local-trust record and retire the candidate. Mirrors
 * `admitAttested`: per-item verdicts are stamped (the record schema requires `verdict`/`checkedAt`),
 * the record id is content-addressed (`cand:<h>` ↔ `mem:<h>`, so a re-run is a no-op upsert), and
 * the decision rides in `meta` (excluded from the id) so audit can tell auto-admitted records apart.
 */
export function admitGrounded(
  local: MemoryStore,
  candidate: MemoryCandidate,
  evaluation: RecordEvaluation,
  decision: AdmissionDecision,
  now: () => string,
): MemoryRecord {
  if (decision.verdict !== 'admit') {
    throw new Error(
      `admitGrounded called with a '${decision.verdict}' decision: ${decision.reason}`,
    );
  }
  const stampedAt = now();
  const evidence = candidate.evidence.map((ev, i) => {
    const item = evaluation.items[i];
    if (!item) return ev;
    return {
      ...ev,
      verdict: item.evidence === 'ignored' ? ('invalid' as const) : item.evidence,
      checkedAt: stampedAt,
      reason: item.reason,
    };
  });
  const record: MemoryRecord = {
    ...buildRecord(
      candidate,
      {
        trust: 'local',
        evidence: evaluation.evidence,
        applicability: evaluation.applicability,
        lifecycle: 'active',
      },
      evidence,
      stampedAt,
    ),
    meta: { admission: 'auto-grounded', admissionReason: decision.reason },
  };
  local.upsertEntry('active', record);
  local.removeEntry('candidates', candidate.id);
  return record;
}
