/**
 * The memory freshness engine (PRD W2 Slice 3) — an INDEPENDENT `MemoryEvaluator`.
 *
 * CRITICAL (PRD line 66): "Never alter `EnrichmentStore.isStale` for memory … Introduce an
 * independent `MemoryEvaluator`." This module does NOT touch `EnrichmentStore.isStale` (the soul
 * enrichment-staleness path, ~30 symbols / 13 processes); it is a parallel, memory-only evaluator
 * that recomputes the four-axis verdict (Trust / Evidence / Applicability / Lifecycle) from
 * admissibility + grounding + reattachment + decision events.
 *
 * Three PRD §2 concerns implemented here:
 *   1. **Claim-level admissibility** (lines 146–164): a per-claim-kind minimum-evidence matrix; an
 *      agent assertion is never evidence; human evidence cannot establish implementation facts;
 *      every claim is checked independently; invalid evidence is quarantined, not deleted; conflicting
 *      active records sharing `subject + scope` are returned together.
 *   2. **Freshness / refactor survival** (lines 166–181): revalidation order — exact id+hash → stable
 *      reattachment by locator → require exactly one candidate → re-run quote/policy verification →
 *      multiple ⇒ `needs-review`, none ⇒ `orphaned`/`invalid`. Automatic reattachment affects ONLY
 *      the read projection; persisting a changed anchor creates a new immutable record that
 *      supersedes the old one (a caller applies that via a `supersede` decision, not by mutating).
 *   3. **Four-axis verdict** (lines 133–142): only `local|team + valid|degraded + current + active`
 *      records enter normal recall; degraded records rank below valid records.
 *
 * PURE over the supplied ports (soul + optional receipts + optional policy): no network, no model,
 * no MCP. `mcp`'s `grounding.ts` quote-overlap check is reimplemented in `./grounding.js` so this
 * module never imports `mcp`.
 */
import { type SoulStore, rehydrateBody } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import {
  type ApplicabilityVerdict,
  EVIDENCE_KINDS,
  type EvidenceKind,
  type EvidenceVerdict,
  type MemoryRecordKind,
  type Verdicts,
  isEvidenceKind,
} from './enums.js';
import { type QuoteCheck, type RehydratePort, verifyQuote } from './grounding.js';
import { decisionId } from './ids.js';
import { type StableLocator, bestLocatorMatches, buildLocatorFromEvidence } from './locator.js';
import {
  type MemoryDecision,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordVersioned,
  isMemoryRecordVersioned,
} from './types.js';

// ─── ports (the evaluator's PURE read contract) ─────────────────────────────

/** The soul read-port: node lookup, span rehydration, and locator-based reattachment search. */
export interface MemorySoulPort extends RehydratePort {
  getNode(id: string): Node | undefined;
  /** Find live nodes matching a locator (best-first). The adapter feeds `soul.iterate()`. */
  findByLocator(locator: StableLocator): Node[];
  /**
   * G3.3 — a monotonic fingerprint of the node/code dependency generation (in-process node
   * mutations + the persisted manifest generation counters), when the adapter can supply one. The
   * serving layer's locator hoist keys its materialized node array + locator-match memo on this
   * (unchanged generation ⇒ the O(all-nodes) scan is paid once, not per evidence item). Absent —
   * the unit fakes — the adapter must NOT cache and re-scans per call, the pre-G3.3 behaviour.
   */
  generation?(): string;
}

/** A sanitized gate receipt (the subset the evaluator reads). Mirrors {@link GateReceipt}. */
export interface EvalReceipt {
  id: string;
  policyHash: string;
  profileHash: string;
  exitCode: number;
  assertions: { name: string; passed: boolean }[];
  runner: 'cli' | 'ci';
  ts: string;
}

/** The receipt read-port: resolves `execution-assertion` / `receipt-pair` evidence. */
export interface MemoryReceiptPort {
  getReceipt(id: string): EvalReceipt | undefined;
  /**
   * G3.3 — the receipt-store dependency generation, when the port can version itself. Absent ⇒ the
   * generation cache binds `unversioned` and the pass evaluates FRESH: receipt drift could not be
   * detected, and a stale verdict is never served in place of a detectable one.
   */
  generation?(): string;
}

/** The trusted-base policy read-port: the live policy + runner-profile hashes (drift detection). */
export interface MemoryPolicyPort {
  policyHash(): string | undefined;
  profileHash(): string | undefined;
}

/**
 * G3.3 — the generation-keyed evaluation cache port (implemented by `GenerationCache` in
 * `generation-cache.ts`). A record's {@link RecordEvaluation} is a pure function of (record content
 * · code/node generation · policy generation · receipt generation · decision/feedback/embedder/index
 * dependency slots), so while ALL of those are unchanged the last evaluation IS the evaluation —
 * returned WITHOUT re-reading a single evidence item (red line #1: never revalidate every record to
 * answer one query). The port is bound per recall call by the serving layer; `generation()` naming
 * `unversioned` (a dependency that cannot be versioned) means the port is NOT bound at all — a
 * pass either evaluates fresh or serves a verdict proven current at a full dependency fingerprint.
 */
export interface EvaluationCachePort {
  /** the dependency-generation fingerprint the CURRENT pass is bound to. */
  generation(): string;
  get(key: string): RecordEvaluation | undefined;
  set(key: string, evaluation: RecordEvaluation): void;
}

/** One recall pass's scratch memos — created per search/recall call, discarded with it. */
export interface EvaluationPassContext {
  /** per-pass locator→candidates memo (the port may hoist further per generation). */
  locatorMatches: Map<string, Node[]>;
  /** per-pass quote-verification memo, keyed `nodeId|hash|quote|startLine` (rehydrate reads disk). */
  quoteChecks: Map<string, QuoteCheck>;
}

/** Everything the evaluator needs to revalidate one record. Receipts + policy are optional. */
export interface MemoryEvalContext {
  soul: MemorySoulPort;
  receipts?: MemoryReceiptPort;
  policy?: MemoryPolicyPort;
  /** G3.3 — the per-pass scratch memos (locator matches + quote verifications). */
  pass?: EvaluationPassContext;
  /** G3.3 — the generation-keyed evaluation cache port bound for this pass. */
  cache?: EvaluationCachePort;
}

/**
 * Adapter wrapping a `SoulStore` + `repoRoot` as a {@link MemorySoulPort}. The rehydrate path uses
 * `rehydrateBody` from `core` (the same function `mcp/grounding.ts` uses, so verdicts match); the
 * locator path scans `soul.iterate()` via `bestLocatorMatches` — G3.3 hoisted: the O(all-nodes)
 * `Array.from(iterate())` materialization is paid ONCE per node generation and the per-locator
 * matches are memoized against it, instead of once per ORPHANED evidence item per record per call
 * (the fresh-eval cost that dominated the 10k-recall p50 in docs/bench/memory.md). Both caches are
 * keyed on {@link generation} — every node mutation path in `SoulStore` bumps `nodeGeneration`, so
 * a changed soul re-materializes; nothing can silently desynchronise.
 */
export class SoulStoreSoulPort implements MemorySoulPort {
  /** The materialized node array + the generation it was built at (null = never built). */
  private locatorScan: { generation: string; nodes: Node[] } | null = null;
  /** Per-locator match memo — valid only while `locatorScan.generation` is current. */
  private readonly locatorMatches = new Map<string, Node[]>();

  constructor(
    private readonly soul: SoulStore,
    private readonly repoRoot: string,
  ) {}

  getNode(id: string): Node | undefined {
    return this.soul.getNode(id);
  }

  rehydrate(node: Node, opts?: { maxChars?: number; startLine?: number }) {
    return rehydrateBody(this.repoRoot, node, {
      maxLines: Number.MAX_SAFE_INTEGER,
      ...(opts?.maxChars ? { maxChars: opts.maxChars } : {}),
      ...(opts?.startLine ? { startLine: opts.startLine } : {}),
    });
  }

  /**
   * G3.3 — the code/node dependency-generation fingerprint: the in-process mutation counter (every
   * putNodes/removeByFile/load path bumps it — the same signal `cluster-hash.ts` keys off) plus the
   * persisted manifest generation counters, so a semantic bump invalidates too.
   */
  generation(): string {
    const gen = this.soul.getManifest().generation;
    return `${this.soul.nodeGeneration}:${gen?.extracted ?? 0}:${gen?.semantic ?? 0}`;
  }

  findByLocator(locator: StableLocator): Node[] {
    // Materialize FIRST: the generation check inside invalidates the locator memo when the node
    // set changed — checking the memo before it would serve a stale match across a mutation
    // (exactly what the generation key exists to prevent).
    const nodes = this.materializedNodes();
    const key = JSON.stringify(locator);
    const memo = this.locatorMatches.get(key);
    if (memo) return memo;
    const matches = bestLocatorMatches(nodes, locator);
    this.locatorMatches.set(key, matches);
    return matches;
  }

  /** Materialize the node array once per generation (the pre-G3.3 code did this per call). */
  private materializedNodes(): Node[] {
    const generation = this.generation();
    const cached = this.locatorScan;
    if (cached && cached.generation === generation) return cached.nodes;
    const nodes = Array.from(this.soul.iterate());
    this.locatorScan = { generation, nodes };
    this.locatorMatches.clear(); // the old memo answers against the OLD node set — drop it
    return nodes;
  }

  /**
   * Explicit invalidation surface: drop the materialized array + locator memo. Not normally needed
   * (the generation key self-invalidates), but the serving layer may call it after swapping the
   * underlying store's contents through a path that does not bump the generation counters.
   */
  invalidateLocatorCache(): void {
    this.locatorScan = null;
    this.locatorMatches.clear();
  }
}

// ─── per-item revalidation result ────────────────────────────────────────────

/** Why an item's verdict is what it is (human-readable; surfaced in `needs-review` diagnostics). */
export type ItemReason =
  | 'no-quote'
  | 'anchor-gone'
  | 'hash-drift'
  | 'reattached'
  | 'ambiguous-reattach'
  | 'quote-not-found'
  | 'receipt-missing'
  | 'assertion-failed'
  | 'policy-drift'
  | 'not-attested'
  | 'inadmissible-kind'
  | 'not-applicable'
  | 'ok'
  | 'ignored';

/** One evidence item's revalidation: its Evidence + Applicability contribution + the reason. */
export interface EvidenceRevalidation {
  kind: EvidenceKind;
  /** `ignored` = the evidence kind is not admissible for this claim kind — it does not count. */
  evidence: EvidenceVerdict | 'ignored';
  applicability: ApplicabilityVerdict;
  reason: ItemReason;
  /** the soul id the item reattached to, when reattachment moved the anchor (read-projection only). */
  reattachedTo?: string;
}

// ─── admissibility matrix (PRD §2 lines 148–154) ─────────────────────────────

/**
 * The evidence kinds admissible for each claim kind (PRD §2 admissibility matrix). `pitfall` is
 * special: it admits `receipt-pair` alone, OR `source-quote` + `human-attestation` together (a
 * reproduction) — handled in {@link aggregateEvidence}, not by this set, because the combo rule is
 * cross-item. For non-pitfall kinds, an item whose kind is not in this set is `ignored`.
 */
const ADMISSIBLE: Record<MemoryRecordKind, EvidenceKind[]> = {
  fact: ['source-quote', 'execution-assertion'],
  procedure: ['source-quote', 'execution-assertion', 'committed-policy'],
  decision: ['human-attestation', 'committed-policy'],
  convention: ['human-attestation', 'committed-policy'],
  pitfall: ['receipt-pair', 'source-quote', 'human-attestation'],
};

/**
 * True iff `kind` is an admissible evidence kind for a claim of `claimKind` (PRD §2 admissibility
 * matrix). PURE — the same matrix {@link aggregateEvidence} enforces per item. Re-exported so the
 * W5 Slice 3 contradicted-feedback suppression (`feedback.ts`) can test whether counter-evidence is
 * admissible WITHOUT re-duplicating the matrix (and drifting from it).
 */
export function admissibleFor(kind: EvidenceKind, claimKind: MemoryRecordKind): boolean {
  return ADMISSIBLE[claimKind].includes(kind);
}

/** The default outcome-promise heuristic for procedures (PRD: "execution required if the claim
 *  promises an outcome"). Overridable via {@link MemoryEvaluatorOpts.promisesOutcome}. */
export function defaultPromisesOutcome(claim: string): boolean {
  return /\b(?:will|must|shall|should|always|never|guarantee[s]?|ensures?|returns?|throws?|fails?|succeeds?)\b/i.test(
    claim,
  );
}

// ─── record-level evaluation result ──────────────────────────────────────────

/** The recomputed verdicts + the per-item detail + whether any anchor reattached (read projection). */
export interface RecordEvaluation {
  evidence: EvidenceVerdict;
  applicability: ApplicabilityVerdict;
  items: EvidenceRevalidation[];
  /** true iff at least one anchor reattached to a different id (the read projection moved; persisting
   *  it would create a new superseding record — PRD line 181). */
  reattached: boolean;
  /** why the record landed on this evidence verdict, in priority order. */
  reasons: ItemReason[];
}

// ─── the evaluator ───────────────────────────────────────────────────────────

export interface MemoryEvaluatorOpts {
  /** Override the procedure outcome-promise heuristic. */
  promisesOutcome?: (claim: string) => boolean;
}

/**
 * The independent memory freshness evaluator. Stateless over records — construct once, call
 * {@link evaluate} per record. Does NOT touch `EnrichmentStore.isStale` (PRD line 66).
 */
export class MemoryEvaluator {
  private readonly promisesOutcome: (claim: string) => boolean;

  constructor(opts: MemoryEvaluatorOpts = {}) {
    this.promisesOutcome = opts.promisesOutcome ?? defaultPromisesOutcome;
  }

  /**
   * Revalidate one record's evidence + applicability against the live soul/receipts/policy. Trust is
   * NOT recomputed here (it is as-authored; promotion is a W4 concern via a new record/decision).
   * Lifecycle is overlaid separately by {@link effectiveVerdicts} from decision events.
   *
   * SCHEMA-INDEPENDENT (R02). Revalidation reads only `id`, `kind`, `claim` and `evidence` — fields
   * every supported schema carries — so a v2/v3 envelope is revalidated by exactly the same rules
   * as a memory-1 record. The audited defect was that recall never CALLED this for a versioned
   * record: a migrated record kept the evidence verdict snapshotted at migration time, so a claim
   * whose source symbol had since been deleted came back `valid`/`current`/`fresh`. Evidence
   * validity is a property of the world now, never of the schema the claim happens to be stored in.
   *
   * G3.3 — when the context carries a generation-keyed cache port (bound by the serving layer for
   * this pass), a memoized evaluation for the SAME record content at the SAME dependency generation
   * is returned verbatim (frozen — treat it as read-only): no evidence item is re-read. Anything
   * that could flip a verdict is a dependency slot, and a changed slot re-fingerprints the whole
   * cache (see `generation-cache.ts`).
   */
  evaluate(record: MemoryRecord | MemoryRecordVersioned, ctx: MemoryEvalContext): RecordEvaluation {
    const cacheKey = ctx.cache ? evaluationCacheKey(record) : undefined;
    const cached = cacheKey && ctx.cache ? ctx.cache.get(cacheKey) : undefined;
    if (cached) return cached;
    const items: EvidenceRevalidation[] = record.evidence.map((ev) =>
      this.revalidateItem(ev, record.kind, record.claim, ctx),
    );
    const evidence = this.aggregateEvidence(record.kind, record.claim, items, this.promisesOutcome);
    const applicability = this.aggregateApplicability(items);
    const reattached = items.some((i) => i.reattachedTo !== undefined);
    const reasons = this.collectReasons(items, evidence);
    const evaluation: RecordEvaluation = { evidence, applicability, items, reattached, reasons };
    if (cacheKey && ctx.cache) {
      // Freeze: the SAME object is served to every caller at this generation — one caller mutating
      // it must not be able to poison the cache for the rest (the verdicts are a read projection).
      ctx.cache.set(cacheKey, Object.freeze(evaluation));
    }
    return evaluation;
  }

  // ─── per-item revalidation ───────────────────────────────────────────────

  /**
   * G3.3 — locator resolution memoized for the pass. The locator scan is the dominant cost when
   * evidence goes orphaned: {@link MemorySoulPort.findByLocator} walks every soul node, PER orphaned
   * evidence item, PER record, PER call. Within one pass the same locator always resolves the same
   * way (the pass binds one dependency generation), so the first answer is the answer.
   */
  private findByLocatorMemoized(ctx: MemoryEvalContext, locator: StableLocator): Node[] {
    const memo = ctx.pass?.locatorMatches;
    const key = JSON.stringify(locator);
    const hit = memo?.get(key);
    if (hit) return hit;
    const matches = ctx.soul.findByLocator(locator);
    memo?.set(key, matches);
    return matches;
  }

  /**
   * G3.3 — quote verification memoized for the pass. `verifyQuote` rehydrates the node body from
   * disk (span read + text scan); identical (node · hash · quote · startLine) tuples within one
   * pass — e.g. duplicate evidence across records — rehydrate the same bytes repeatedly for a
   * known result. Keyed by hash, not just id, so a mid-pass node mutation can never serve a stale
   * memo under the same id.
   */
  private verifyQuoteMemoized(
    ctx: MemoryEvalContext,
    node: Node,
    quote?: string,
    startLine?: number,
  ): QuoteCheck {
    const memo = ctx.pass?.quoteChecks;
    const key = `${node.id}|${node.hash}|${quote ?? ''}|${startLine ?? ''}`;
    const hit = memo?.get(key);
    if (hit) return hit;
    const check = verifyQuote(ctx.soul, node, quote, startLine);
    memo?.set(key, check);
    return check;
  }

  private revalidateItem(
    ev: MemoryEvidence,
    claimKind: MemoryRecordKind,
    claim: string,
    ctx: MemoryEvalContext,
  ): EvidenceRevalidation {
    if (!isEvidenceKind(ev.kind)) {
      return {
        kind: 'source-quote',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'inadmissible-kind',
      };
    }
    // Admissibility for the claim kind. Pitfall's combo rule is resolved in aggregateEvidence; here
    // an inadmissible kind is `ignored` (it does not count toward the record — does not poison it).
    const admissible = ADMISSIBLE[claimKind];
    if (!admissible.includes(ev.kind)) {
      return { kind: ev.kind, evidence: 'ignored', applicability: 'current', reason: 'ignored' };
    }
    switch (ev.kind) {
      case 'source-quote':
        return this.revalidateSourceQuote(ev, ctx);
      case 'execution-assertion':
        return this.revalidateExecutionAssertion(ev, ctx);
      case 'committed-policy':
        return this.revalidateCommittedPolicy(ev, ctx);
      case 'human-attestation':
        return this.revalidateHumanAttestation(ev);
      case 'receipt-pair':
        return this.revalidateReceiptPair(ev, ctx);
      default:
        return {
          kind: ev.kind,
          evidence: 'invalid',
          applicability: 'orphaned',
          reason: 'inadmissible-kind',
        };
    }
  }

  /** source-quote: exact id+hash → trusted (no re-ground); hash drift → re-ground ; id gone → reattach. */
  private revalidateSourceQuote(ev: MemoryEvidence, ctx: MemoryEvalContext): EvidenceRevalidation {
    const node = ev.soulId ? ctx.soul.getNode(ev.soulId) : undefined;
    if (node) {
      // G3.3 hash short-circuit: the live node's content hash EQUALS the evidence's targetHash.
      // Hashes are content-addressed (same hash ⇒ same body bytes), and the quote was verified
      // grounded against exactly that body when the evidence was written — re-grounding would
      // rehydrate the span from disk to re-derive a known answer, per evidence item, per record,
      // per call. The DIVERGED (or absent) hash still re-grounds against the live content below.
      if (ev.targetHash !== undefined && node.hash === ev.targetHash) {
        return { kind: 'source-quote', evidence: 'valid', applicability: 'current', reason: 'ok' };
      }
      const hashMatch = ev.targetHash ? node.hash === ev.targetHash : true;
      const qv = this.verifyQuoteMemoized(ctx, node, ev.quote, ev.startLine);
      if (hashMatch) {
        return qv.verdict === 'grounded'
          ? { kind: 'source-quote', evidence: 'valid', applicability: 'current', reason: 'ok' }
          : qv.verdict === 'ungrounded'
            ? {
                kind: 'source-quote',
                evidence: 'invalid',
                applicability: 'needs-review',
                reason: 'quote-not-found',
              }
            : {
                kind: 'source-quote',
                evidence: 'degraded',
                applicability: 'current',
                reason: 'no-quote',
              };
      }
      // hash drifted but the symbol is still there — re-ground on the new content
      if (qv.verdict === 'grounded') {
        return {
          kind: 'source-quote',
          evidence: 'degraded',
          applicability: 'current',
          reason: 'hash-drift',
        };
      }
      return {
        kind: 'source-quote',
        evidence: 'invalid',
        applicability: 'needs-review',
        reason: 'hash-drift',
      };
    }
    // node gone — reattach by locator (PRD revalidation order steps 2–4)
    const locator = buildLocatorFromEvidence(ev);
    if (!locator) {
      return {
        kind: 'source-quote',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'anchor-gone',
      };
    }
    const candidates = this.findByLocatorMemoized(ctx, locator);
    if (candidates.length === 1) {
      const reattached = candidates[0];
      if (!reattached) {
        return {
          kind: 'source-quote',
          evidence: 'invalid',
          applicability: 'orphaned',
          reason: 'anchor-gone',
        };
      }
      const qv = this.verifyQuoteMemoized(ctx, reattached, ev.quote);
      if (qv.verdict === 'grounded') {
        return {
          kind: 'source-quote',
          evidence: 'degraded',
          applicability: 'current',
          reason: 'reattached',
          reattachedTo: reattached.id,
        };
      }
      return {
        kind: 'source-quote',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'quote-not-found',
        reattachedTo: reattached.id,
      };
    }
    if (candidates.length > 1) {
      return {
        kind: 'source-quote',
        evidence: 'degraded',
        applicability: 'needs-review',
        reason: 'ambiguous-reattach',
      };
    }
    return {
      kind: 'source-quote',
      evidence: 'invalid',
      applicability: 'orphaned',
      reason: 'anchor-gone',
    };
  }

  /** execution-assertion: resolve the receipt; the named assertion must have passed; policy drift → degraded. */
  private revalidateExecutionAssertion(
    ev: MemoryEvidence,
    ctx: MemoryEvalContext,
  ): EvidenceRevalidation {
    const port = ctx.receipts;
    if (!port || !ev.receiptId) {
      return {
        kind: 'execution-assertion',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'receipt-missing',
      };
    }
    const r = port.getReceipt(ev.receiptId);
    if (!r) {
      return {
        kind: 'execution-assertion',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'receipt-missing',
      };
    }
    const assertion = ev.assertion ? r.assertions.find((a) => a.name === ev.assertion) : undefined;
    if (!assertion || !assertion.passed) {
      return {
        kind: 'execution-assertion',
        evidence: 'invalid',
        applicability: 'current',
        reason: 'assertion-failed',
      };
    }
    const livePolicy = ctx.policy?.policyHash();
    if (livePolicy && r.policyHash !== livePolicy) {
      return {
        kind: 'execution-assertion',
        evidence: 'degraded',
        applicability: 'needs-review',
        reason: 'policy-drift',
      };
    }
    return {
      kind: 'execution-assertion',
      evidence: 'valid',
      applicability: 'current',
      reason: 'ok',
    };
  }

  /** committed-policy: the artifact anchor must exist + its hash match the policyHash; drift → needs-review. */
  private revalidateCommittedPolicy(
    ev: MemoryEvidence,
    ctx: MemoryEvalContext,
  ): EvidenceRevalidation {
    const node = ev.artifactId ? ctx.soul.getNode(ev.artifactId) : undefined;
    if (node) {
      const hashMatch = ev.targetHash ? node.hash === ev.targetHash : true;
      if (hashMatch) {
        return {
          kind: 'committed-policy',
          evidence: 'valid',
          applicability: 'current',
          reason: 'ok',
        };
      }
      return {
        kind: 'committed-policy',
        evidence: 'degraded',
        applicability: 'needs-review',
        reason: 'hash-drift',
      };
    }
    const locator = buildLocatorFromEvidence(ev);
    if (!locator) {
      return {
        kind: 'committed-policy',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'anchor-gone',
      };
    }
    const candidates = this.findByLocatorMemoized(ctx, locator);
    if (candidates.length === 1) {
      const cand = candidates[0];
      if (!cand) {
        return {
          kind: 'committed-policy',
          evidence: 'invalid',
          applicability: 'orphaned',
          reason: 'anchor-gone',
        };
      }
      // re-ground: the anchor heading must still resolve on the candidate
      const anchorOk = !ev.anchor || cand.anchor === ev.anchor || cand.heading === ev.anchor;
      if (anchorOk) {
        return {
          kind: 'committed-policy',
          evidence: 'degraded',
          applicability: 'current',
          reason: 'reattached',
          reattachedTo: cand.id,
        };
      }
      return {
        kind: 'committed-policy',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'quote-not-found',
        reattachedTo: cand.id,
      };
    }
    if (candidates.length > 1) {
      return {
        kind: 'committed-policy',
        evidence: 'degraded',
        applicability: 'needs-review',
        reason: 'ambiguous-reattach',
      };
    }
    return {
      kind: 'committed-policy',
      evidence: 'invalid',
      applicability: 'orphaned',
      reason: 'anchor-gone',
    };
  }

  /** human-attestation: a TTY attestation (tty === true + actor + attestedAt). No code anchor → current. */
  private revalidateHumanAttestation(ev: MemoryEvidence): EvidenceRevalidation {
    if (ev.tty !== true || !ev.actor || !ev.attestedAt) {
      return {
        kind: 'human-attestation',
        evidence: 'invalid',
        applicability: 'current',
        reason: 'not-attested',
      };
    }
    // Human decisions without code targets remain applicable until superseded/retracted/expired (PRD 179).
    return { kind: 'human-attestation', evidence: 'valid', applicability: 'current', reason: 'ok' };
  }

  /** receipt-pair (Pitfall): a failing receipt plus a SUBSEQUENT passing receipt; drift → degraded. */
  private revalidateReceiptPair(ev: MemoryEvidence, ctx: MemoryEvalContext): EvidenceRevalidation {
    const port = ctx.receipts;
    if (!port || !ev.failingReceiptId || !ev.passingReceiptId) {
      return {
        kind: 'receipt-pair',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'receipt-missing',
      };
    }
    const fail = port.getReceipt(ev.failingReceiptId);
    const pass = port.getReceipt(ev.passingReceiptId);
    if (!fail || !pass) {
      return {
        kind: 'receipt-pair',
        evidence: 'invalid',
        applicability: 'orphaned',
        reason: 'receipt-missing',
      };
    }
    const failFailed = fail.exitCode !== 0 || fail.assertions.some((a) => !a.passed);
    const passPassed = pass.exitCode === 0 && pass.assertions.every((a) => a.passed);
    const subsequent = pass.ts >= fail.ts;
    if (!(failFailed && passPassed && subsequent)) {
      return {
        kind: 'receipt-pair',
        evidence: 'invalid',
        applicability: 'current',
        reason: 'assertion-failed',
      };
    }
    const livePolicy = ctx.policy?.policyHash();
    if (livePolicy && pass.policyHash !== livePolicy) {
      return {
        kind: 'receipt-pair',
        evidence: 'degraded',
        applicability: 'needs-review',
        reason: 'policy-drift',
      };
    }
    return { kind: 'receipt-pair', evidence: 'valid', applicability: 'current', reason: 'ok' };
  }

  // ─── aggregation ─────────────────────────────────────────────────────────

  /**
   * Aggregate per-item evidence verdicts into the record's Evidence axis.
   *
   * Refines the shipped `types.ts` comment ("valid ⟺ all valid; invalid if any invalid; degraded
   * otherwise") per PRD intent: an `invalid` item alongside a `valid` one yields `degraded` (the
   * claim is still supported, but a stale evidence item exists), and `ignored` items (inadmissible
   * for the claim kind) do not count at all. Only an UNSUPPORTED claim (no valid/degraded admissible
   * evidence) is `invalid` → quarantined (PRD line 163).
   *
   * Pitfall combo rule (PRD): admissible iff a `receipt-pair` item is valid/degraded, OR a
   * `source-quote` AND a `human-attestation` item are BOTH valid/degraded (a reproduction).
   *
   * Procedure outcome rule (PRD): if the claim promises an outcome and no `execution-assertion` item
   * is valid, downgrade valid→degraded (missing required execution); if there is also no other valid
   * admissible evidence, the record is invalid.
   */
  private aggregateEvidence(
    kind: MemoryRecordKind,
    claim: string,
    items: EvidenceRevalidation[],
    promisesOutcome: (claim: string) => boolean,
  ): EvidenceVerdict {
    const counted = items.filter((i) => i.evidence !== 'ignored');
    const hasValid = counted.some((i) => i.evidence === 'valid');
    const hasDegraded = counted.some((i) => i.evidence === 'degraded');
    const hasInvalid = counted.some((i) => i.evidence === 'invalid');

    // Pitfall: enforce the two-path combo. If neither path is satisfied, the claim is unsupported.
    if (kind === 'pitfall') {
      const pair = items.find(
        (i) => i.kind === 'receipt-pair' && i.evidence !== 'ignored' && i.evidence !== 'invalid',
      );
      const sq = items.find(
        (i) => i.kind === 'source-quote' && (i.evidence === 'valid' || i.evidence === 'degraded'),
      );
      const ha = items.find(
        (i) =>
          i.kind === 'human-attestation' && (i.evidence === 'valid' || i.evidence === 'degraded'),
      );
      const reproduction = sq && ha;
      if (!pair && !reproduction) return 'invalid';
    }

    // Procedure outcome: execution required if the claim promises an outcome.
    if (kind === 'procedure' && promisesOutcome(claim)) {
      const execOk = items.some((i) => i.kind === 'execution-assertion' && i.evidence === 'valid');
      if (!execOk) {
        if (!hasValid && !hasDegraded) return 'invalid';
        // has policy/source evidence but lacks the required execution → degraded
        return 'degraded';
      }
    }

    if (counted.length === 0) return 'invalid'; // no admissible evidence at all
    if (hasValid && !hasInvalid) return hasDegraded ? 'degraded' : 'valid';
    if (hasValid && hasInvalid) return 'degraded'; // solid evidence present but a stale item exists
    if (hasDegraded && !hasInvalid) return 'degraded';
    return 'invalid'; // only invalid items
  }

  /**
   * Aggregate per-item applicability. Anchors = items with a code/doc/artifact target
   * (source-quote / execution-assertion / committed-policy / receipt-pair). Human-attestation has no
   * anchor → imposes no applicability constraint (current). No anchors ⇒ current (PRD line 179).
   * any needs-review ⇒ needs-review; else all orphaned ⇒ orphaned; else current.
   */
  private aggregateApplicability(items: EvidenceRevalidation[]): ApplicabilityVerdict {
    const anchors = items.filter(
      (i) =>
        i.kind === 'source-quote' ||
        i.kind === 'execution-assertion' ||
        i.kind === 'committed-policy' ||
        i.kind === 'receipt-pair',
    );
    if (anchors.length === 0) return 'current';
    if (anchors.some((i) => i.applicability === 'needs-review')) return 'needs-review';
    if (anchors.every((i) => i.applicability === 'orphaned')) return 'orphaned';
    return 'current';
  }

  private collectReasons(items: EvidenceRevalidation[], _evidence: EvidenceVerdict): ItemReason[] {
    const reasons: ItemReason[] = [];
    for (const i of items) {
      if (i.reason !== 'ok' && i.reason !== 'ignored' && !reasons.includes(i.reason))
        reasons.push(i.reason);
    }
    return reasons;
  }
}

/**
 * G3.3 — content-only cache key for one record evaluation. Derives from the record's own bytes
 * (id · kind · claim · evidence): never a timestamp, never wall clock — the WALL-CLOCK LAW forbids
 * anything feeding an id/hash/key from reading the clock, and a time-stamped key would also never
 * hit. Two records with the same content share an evaluation at the same generation; any change to
 * the record's content is a different key, and any change to a dependency slot re-fingerprints the
 * whole cache (generation-cache.ts).
 */
function evaluationCacheKey(record: MemoryRecord | MemoryRecordVersioned): string {
  return `${record.id}|${record.kind}|${record.claim}|${JSON.stringify(record.evidence)}`;
}

// ─── read projection: effective verdicts + recall eligibility ────────────────

/** The effective verdicts a record projects at read time, with the quarantine flag. */
export interface EffectiveVerdicts extends Verdicts {
  /** true iff a `quarantine` decision has been applied (excludes from normal recall, NOT deleted). */
  quarantined: boolean;
  /** the recomputed evidence + applicability from {@link RecordEvaluation}, when supplied. */
  reasons: ItemReason[];
}

/**
 * The record-level Evidence verdict stamped on a v2 record's evidence items, aggregated with the
 * memory-1 rule (types.ts): valid ⟺ all valid; invalid if any invalid; degraded otherwise. memory-2
 * records carry no aggregate `verdicts` field — the per-item verdicts are the stamped truth, so the
 * read projection derives the aggregate from them. PURE.
 */
function stampedEvidenceVerdict(evidence: readonly MemoryEvidence[]): EvidenceVerdict {
  if (evidence.length === 0) return 'invalid'; // no admissible evidence at all
  const hasValid = evidence.some((ev) => ev.verdict === 'valid');
  const hasInvalid = evidence.some((ev) => ev.verdict === 'invalid');
  const hasDegraded = evidence.some((ev) => ev.verdict === 'degraded');
  if (hasValid && !hasInvalid) return hasDegraded ? 'degraded' : 'valid';
  if (hasValid && hasInvalid) return 'degraded';
  if (hasDegraded) return 'degraded';
  return 'invalid';
}

/**
 * Compute the effective (read-projection) verdicts: Trust as-authored; Evidence + Applicability from
 * a fresh {@link RecordEvaluation} (when supplied, else the record's stamped verdicts); Lifecycle
 * overlaid from decision events (supersede → superseded, retract → retracted); quarantined iff a
 * `quarantine` decision exists. PURE over the record + decisions + evaluation (+ migration snapshot).
 *
 * A memory-2 record has no v1 verdict axes in its envelope (G1.1: trust is provenance-owned,
 * lifecycle is lineage/validTime-driven). The G1.2 migration carries the v1 axes in the legacy-ID
 * ALIAS snapshot (`migratedVerdicts` — the CONSERVATIVE merge of EVERY alias bound to this record,
 * `conservativeVerdicts` in aliases.ts: two v1 records of one claim can collapse onto one twin,
 * and the merged snapshot takes the worst axis per sibling, never a last-wins pick): with it, the
 * migrated twin projects verdicts at least as conservative as every collapsed sibling's stamp, so
 * migration never silently demotes a memory out of recall. Without it (a fresh v2 observation, no migration
 * history), the record projects as RANK-INELIGIBLE (`candidate` trust keeps it out of the ranked
 * `memories` list) but CONFLICT-VISIBLE: quarantined still applies (decisions key on the record id),
 * Evidence is derived honestly from the stamped per-item verdicts, and lifecycle still overlays
 * decision events. This keeps every v1 path crash-free on a mixed-version store — the axes are
 * never read off `undefined`.
 */
/** Decisions grouped by the record id they name — see {@link indexDecisionsBySubject}. */
export type DecisionsBySubject = ReadonlyMap<string, readonly MemoryDecision[]>;

const NO_DECISIONS: readonly MemoryDecision[] = [];

/**
 * Group a decision pool by `subject`, so a per-record verdict is a Map lookup instead of a scan.
 *
 * `effectiveVerdicts` filters the WHOLE pool per record. Ranking a corpus makes that O(records ×
 * decisions): at 100k records over 10k decisions it is ~1.09 BILLION comparisons and was 98% of
 * `MemoryApi.search` at that scale. Callers that evaluate many records against ONE stable pool
 * build this once and pass it; callers with a per-record pool (the G1.2 alias bridge, which
 * synthesises decisions keyed on the v2 id) keep the scan, which is correct and cheap for them.
 * PURE.
 */
export function indexDecisionsBySubject(decisions: readonly MemoryDecision[]): DecisionsBySubject {
  const index = new Map<string, MemoryDecision[]>();
  for (const decision of decisions) {
    const list = index.get(decision.subject);
    if (list) list.push(decision);
    else index.set(decision.subject, [decision]);
  }
  return index;
}

export function effectiveVerdicts(
  record: MemoryRecord | MemoryRecordVersioned,
  decisions: readonly MemoryDecision[],
  evaluation?: RecordEvaluation,
  migratedVerdicts?: Verdicts,
  /** pre-grouped `decisions` (see {@link indexDecisionsBySubject}). MUST be an index OF the same
   *  pool — passing an index of a different pool would silently change the verdict. */
  bySubject?: DecisionsBySubject,
): EffectiveVerdicts {
  const mine = bySubject
    ? (bySubject.get(record.id) ?? NO_DECISIONS)
    : decisions.filter((d) => d.subject === record.id);
  const quarantined = mine.some((d) => d.kind === 'quarantine');
  if (isMemoryRecordVersioned(record)) {
    // The alias snapshot is the base; a quarantine/retract/supersede decision recorded against the
    // v2 id (or bridged from the legacy id by the caller) still wins over the snapshot.
    let v2Lifecycle: EffectiveVerdicts['lifecycle'] = migratedVerdicts?.lifecycle ?? 'active';
    if (mine.some((d) => d.kind === 'retract')) v2Lifecycle = 'retracted';
    else if (mine.some((d) => d.kind === 'supersede')) v2Lifecycle = 'superseded';
    return {
      trust: migratedVerdicts?.trust ?? 'candidate',
      evidence:
        evaluation?.evidence ??
        migratedVerdicts?.evidence ??
        stampedEvidenceVerdict(record.evidence),
      applicability: evaluation?.applicability ?? migratedVerdicts?.applicability ?? 'current',
      lifecycle: v2Lifecycle,
      quarantined,
      reasons: evaluation?.reasons ?? [],
    };
  }
  let lifecycle = record.verdicts.lifecycle;
  // supersede/retract are terminal lifecycle transitions; a later retract wins over supersede.
  if (mine.some((d) => d.kind === 'retract')) lifecycle = 'retracted';
  else if (mine.some((d) => d.kind === 'supersede')) lifecycle = 'superseded';
  return {
    trust: record.verdicts.trust,
    evidence: evaluation?.evidence ?? record.verdicts.evidence,
    applicability: evaluation?.applicability ?? record.verdicts.applicability,
    lifecycle,
    quarantined,
    reasons: evaluation?.reasons ?? [],
  };
}

/**
 * Normal-recall eligibility (PRD line 142): `local|team + valid|degraded + current + active` and NOT
 * quarantined. `candidate`-trust, `invalid`/`orphaned`/`needs-review`, `superseded`/`retracted`, and
 * quarantined records are all excluded. Degraded records ARE eligible but rank below valid
 * ({@link rankRecall}).
 */
export function isRecallEligible(v: EffectiveVerdicts): boolean {
  return (
    (v.trust === 'local' || v.trust === 'team') &&
    (v.evidence === 'valid' || v.evidence === 'degraded') &&
    v.applicability === 'current' &&
    v.lifecycle === 'active' &&
    !v.quarantined
  );
}

/**
 * The memory-2 CONFLICT-VISIBILITY predicate: {@link isRecallEligible} MINUS the trust axis. A
 * fresh memory-2 record has no v1 trust stamp, so the read projection holds it at `candidate`
 * (rank-ineligible) while keeping it conflict-visible (G1.1 — `lineage.contradicts` pairs must
 * surface). Every other eligibility exclusion applies unchanged: a quarantined, superseded or
 * retracted record (or one with invalid evidence / non-current applicability) never surfaces as an
 * ACTIVE conflict — its resolution is already recorded.
 */
export function isV2ConflictVisible(v: EffectiveVerdicts): boolean {
  return (
    (v.evidence === 'valid' || v.evidence === 'degraded') &&
    v.applicability === 'current' &&
    v.lifecycle === 'active' &&
    !v.quarantined
  );
}

/**
 * A record's deterministic sort-time key: `createdAt` for memory-1, `transactionTime.recordedAt`
 * for memory-2 (which deliberately carries no `createdAt`). Both are stable authored strings, so
 * the ranking comparators stay deterministic; the empty fallback keeps a malformed record from
 * crashing a whole recall instead of degrading to the bottom.
 */
export function recordSortTime(record: MemoryRecord | MemoryRecordVersioned): string {
  if (isMemoryRecordVersioned(record)) return record.transactionTime.recordedAt ?? '';
  return record.createdAt ?? '';
}

/**
 * Rank recall-eligible records: `valid` evidence before `degraded` (PRD: "degraded records rank
 * below valid records"), then by `createdAt` descending (newest first) as a stable tiebreaker.
 * Returns a new sorted array; does not mutate. Non-eligible records are filtered out.
 */
export function rankRecall(
  records: readonly { record: MemoryRecord | MemoryRecordVersioned; verdicts: EffectiveVerdicts }[],
): { record: MemoryRecord | MemoryRecordVersioned; verdicts: EffectiveVerdicts }[] {
  return records
    .filter((r) => isRecallEligible(r.verdicts))
    .sort((a, b) => {
      const ea = a.verdicts.evidence === 'valid' ? 0 : 1;
      const eb = b.verdicts.evidence === 'valid' ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return recordSortTime(b.record).localeCompare(recordSortTime(a.record));
    });
}

// ─── conflict groups (PRD line 164 + G1.1 propositionKey) ─────────────────────

/** A conflict group: ≥2 records whose claims cannot all hold, returned together (no silent pick). */
export interface ConflictGroup {
  /** the shared conflict key: `subject|boundary|repoId` for v1, the propositionKey for v2. */
  key: string;
  subject: string;
  /** v1 only: the shared placement. A memory-2 group carries `propositionKey` instead — it has no
   *  v1 scope, and conflating the two key spaces would merge unrelated groups. */
  scope?: { boundary: string; repoId?: string };
  /** memory-2 only: the shared proposition key (what the claims are about — the real conflict key). */
  propositionKey?: string;
  records: (MemoryRecord | MemoryRecordVersioned)[];
}

/** Build the conflict-key for a memory-1 record (`subject|boundary|repoId`). memory-2 records never
 *  use this key — they conflict on `propositionKey` + explicit `lineage.contradicts` (G1.1). */
export function conflictKey(record: {
  subject: string;
  scope: { boundary: string; repoId?: string };
}): string {
  return `${record.subject}|${record.scope.boundary}|${record.scope.repoId ?? ''}`;
}

/**
 * Group records into conflict groups (PRD line 164: "Conflicting active records … are returned
 * together; ranking may not silently choose one"). Dispatch is per record version:
 *
 *   - memory-1 (unchanged semantics): ≥2 recall-eligible records sharing `subject + scope` are a
 *     conflict. Content-addressed ids mean two such records necessarily have DIFFERENT claims
 *     (same claim ⇒ same `mem:` id ⇒ deduped to one). This over-conflicts complementary facts —
 *     the deficiency G1.1 fixes for v2 and G1.2 retires when v1 retires.
 *   - memory-2 (G1.1): conflict = same `propositionKey` AND mutually exclusive claims. Mutual
 *     exclusivity is EXPRESSED, never inferred from text: a record joins the group iff it is in a
 *     `lineage.contradicts` pair with another record of the same propositionKey (either direction
 *     declares the contradiction). Complementary facts about one subject therefore share the
 *     propositionKey but do NOT conflict.
 *
 * v1 and v2 key spaces never merge (subject|boundary|repoId vs `prop:…`), so a migrated-claim pair
 * cannot double-report. PURE over the supplied (already effective) records.
 */
export function conflictGroups(
  entries: readonly { record: MemoryRecord | MemoryRecordVersioned; verdicts: EffectiveVerdicts }[],
): ConflictGroup[] {
  const v1Buckets = new Map<string, MemoryRecord[]>();
  const v2Buckets = new Map<string, MemoryRecordVersioned[]>();
  for (const { record, verdicts } of entries) {
    if (isMemoryRecordVersioned(record)) {
      // only records that could still be acted on can conflict: the SAME exclusion axes as the
      // v1 eligibility filter ({@link isRecallEligible}) minus the trust axis — a fresh memory-2
      // record deliberately projects as candidate-trust (rank-ineligible) yet stays
      // conflict-visible (G1.1). A quarantined / superseded / retracted record, invalid evidence,
      // or a non-current applicability must NOT surface as an active conflict: the resolution is
      // already recorded, and re-reporting it invites a second, contradictory supersede.
      if (!isV2ConflictVisible(verdicts)) continue;
      const bucket = v2Buckets.get(record.propositionKey);
      if (bucket) bucket.push(record);
      else v2Buckets.set(record.propositionKey, [record]);
      continue;
    }
    if (!isRecallEligible(verdicts)) continue; // only active recall-eligible records can conflict
    const key = conflictKey(record);
    const bucket = v1Buckets.get(key);
    if (bucket) bucket.push(record);
    else v1Buckets.set(key, [record]);
  }
  const groups: ConflictGroup[] = [];
  for (const [key, recs] of v1Buckets) {
    if (recs.length < 2) continue;
    const first = recs[0];
    if (!first) continue;
    groups.push({
      key,
      subject: first.subject,
      scope: {
        boundary: first.scope.boundary,
        ...(first.scope.repoId ? { repoId: first.scope.repoId } : {}),
      },
      records: recs,
    });
  }
  for (const [propositionKey, recs] of v2Buckets) {
    // Only the mutually-exclusive members join: a `lineage.contradicts` edge WITHIN the bucket pulls
    // in BOTH endpoints (the declarer and the declared-against record — either direction declares
    // the contradiction). Complementary facts stay out: no edge, no conflict.
    const ids = new Set(recs.map((r) => r.id));
    const declarers = new Set<string>();
    const declaredAgainst = new Set<string>();
    for (const r of recs) {
      for (const target of r.lineage.contradicts ?? []) {
        if (ids.has(target)) {
          declarers.add(r.id);
          declaredAgainst.add(target);
        }
      }
    }
    const conflicting = recs.filter((r) => declarers.has(r.id) || declaredAgainst.has(r.id));
    if (conflicting.length < 2) continue;
    const first = conflicting[0];
    if (!first) continue;
    groups.push({
      key: propositionKey,
      subject: first.subject,
      propositionKey,
      records: conflicting,
    });
  }
  return groups;
}

// ─── quarantine (PRD line 163: "quarantined, not deleted") ────────────────────

/**
 * Build a `quarantine` decision event for a record whose evidence is `invalid`. The record is NOT
 * deleted — the decision is appended (immutable, append-only); the read projection sees it and
 * excludes the record from normal recall. The caller persists the decision via the store.
 */
export function quarantineDecision(
  record: { id: string },
  actor: string,
  reason: string,
  now: string,
): MemoryDecision {
  return {
    id: decisionId({ kind: 'quarantine', subject: record.id, actor, reason }),
    schemaVersion: '1',
    kind: 'quarantine',
    subject: record.id,
    actor,
    reason,
    ts: now,
  };
}

/** Convenience: a `supersede` decision marking `oldRecord` superseded by `newRecord` (PRD line 181). */
export function supersedeDecision(
  oldRecord: { id: string },
  newRecord: { id: string },
  actor: string,
  reason: string,
  now: string,
): MemoryDecision {
  return {
    id: decisionId({
      kind: 'supersede',
      subject: oldRecord.id,
      successor: newRecord.id,
      actor,
      reason,
    }),
    schemaVersion: '1',
    kind: 'supersede',
    subject: oldRecord.id,
    successor: newRecord.id,
    actor,
    reason,
    ts: now,
  };
}

// ─── write-time admissibility pre-flight ─────────────────────────────────────

/** One reason a proposed evidence item could never support its claim. */
export interface AdmissibilityProblem {
  /** Index of the offending item in the supplied evidence array. */
  index: number;
  /** What is wrong, in the terms the author can act on. */
  problem: string;
}

/**
 * Would this evidence EVER let this claim become admissible? Checked at WRITE time.
 *
 * Reported from real use: an agent recorded a `convention` with
 * `evidence: [{ type: 'human-attestation', quote: '...' }]`. The write returned `ok: true`, the
 * agent told the user it had been remembered — and the claim could never be recalled, because
 * `type` is not `kind` and a human attestation additionally requires `tty`/`actor`/`attestedAt`.
 * Nothing surfaced that until the user concluded the whole memory system was broken.
 *
 * Structural admissibility is decidable the moment the claim is written, and that is the only
 * moment the author can still fix it. This checks exactly the properties that do NOT depend on the
 * live world — recognised kind, the PRD admissibility matrix, and the per-kind required fields.
 * Whether a source quote still MATCHES its anchor is a question for revalidation, deliberately not
 * asked here; a claim can be perfectly well formed and later go stale, and that is not an error.
 *
 * PURE. Returns an empty array when nothing is structurally wrong (including for empty evidence —
 * the episodic capture path legitimately stages claims whose evidence is supplied later).
 */
export function admissibilityProblems(
  claimKind: MemoryRecordKind,
  evidence: readonly MemoryEvidence[],
  opts: {
    /**
     * True when the evidence is being STAGED as a proposal rather than admitted.
     *
     * A human attestation is only valid with `tty`/`actor`/`attestedAt`, but those describe the
     * moment a human confirms it — and crib stamps them itself, from a real terminal, at admission
     * (`crib memory admit`). An agent relaying "the user told me to always do X" legitimately has
     * none of them yet, and must still be able to propose the claim. Requiring them at staging time
     * would make an honest proposal impossible while doing nothing to stop a dishonest one.
     */
    staged?: boolean;
  } = {},
): AdmissibilityProblem[] {
  const problems: AdmissibilityProblem[] = [];
  evidence.forEach((ev, index) => {
    const raw = ev as unknown as Record<string, unknown>;
    if (!isEvidenceKind(raw.kind)) {
      // The single most common authoring mistake gets named explicitly rather than reported as a
      // generic schema violation: `type` is what most tool schemas call this field.
      const hint =
        typeof raw.type === 'string'
          ? ` — found \`type: ${JSON.stringify(raw.type)}\`; the field is \`kind\``
          : '';
      problems.push({
        index,
        problem: `evidence[${index}] has no recognised \`kind\`${hint}. Expected one of ${EVIDENCE_KINDS.join(', ')}`,
      });
      return;
    }
    const kind = raw.kind;
    if (!admissibleFor(kind, claimKind)) {
      problems.push({
        index,
        problem: `evidence[${index}] kind '${kind}' is not admissible for a '${claimKind}' claim (admissible: ${ADMISSIBLE[claimKind].join(', ')})`,
      });
      return;
    }
    // Per-kind required fields, mirroring each revalidate* method's own precondition. Only fields
    // whose ABSENCE is unrecoverable are checked — never fields that merely affect the verdict.
    const missing: string[] = [];
    if (kind === 'human-attestation' && !opts.staged) {
      if (raw.tty !== true) missing.push('tty: true');
      if (typeof raw.actor !== 'string' || raw.actor.length === 0) missing.push('actor');
      if (typeof raw.attestedAt !== 'string' || raw.attestedAt.length === 0) {
        missing.push('attestedAt');
      }
    }
    if (kind === 'source-quote' && (typeof raw.soulId !== 'string' || raw.soulId.length === 0)) {
      missing.push('soulId');
    }
    if (kind === 'receipt-pair') {
      if (typeof raw.failingReceiptId !== 'string') missing.push('failingReceiptId');
      if (typeof raw.passingReceiptId !== 'string') missing.push('passingReceiptId');
    }
    if (kind === 'execution-assertion' && typeof raw.receiptId !== 'string') {
      missing.push('receiptId');
    }
    if (missing.length > 0) {
      problems.push({
        index,
        problem: `evidence[${index}] of kind '${kind}' is missing required field(s): ${missing.join(', ')}`,
      });
    }
  });
  return problems;
}
