/**
 * Agent-driven LLM graph enrichment.
 *
 * The MCP server never calls a model. It exposes a deterministic work queue (`enrich_next`) and a
 * persistence/validation surface (`enrich_save`) so the host IDE's selected agent model can author a
 * semantic graph grounded in the deterministic soul. Canonical artifacts live under
 * `.crib/graph/semantic/`; extracted nodes/edges remain byte-stable.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import {
  type FunctionalModule,
  type ImportanceEntry,
  buildDossier,
  buildFunctionalMap,
  clusterContentHash,
  clusterImportance,
  clusterMembers as clusterMembersCore,
  computeCoverage,
  computeImportance,
  decisionTable,
  isTestPath,
  readLlmOverlay,
} from '@knowledge-crib/core';
import type { SoulStore } from '@knowledge-crib/core';
import { blake3Hex, contentHash } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import {
  type EvidenceCheck,
  type GroundingResult,
  verifyArtifact,
  verifyEvidence,
} from './grounding.js';
import { collectStrings, redactSecrets, scanSecrets } from './secrets.js';
import { DEFAULT_BATCH_TOKENS, estimateTokens } from './token-budget.js';

export type EnrichLayer = 'symbol' | 'file' | 'cluster' | 'system';

/**
 * W7 — semantic quality tier (PRD line 379). Every artifact carries one:
 *   • `verified` — grounded (≥1 evidence quote passed M1.3 overlap). ONLY `verified` satisfies
 *     enrichment coverage (PRD line 380); a fresh-but-unverified artifact is still pending repair.
 *   • `draft` — a skeleton (`mode==='skeleton'`) Phase-0.5 pass; authored but not yet verified.
 *   • `legacy` — a full (non-skeleton) artifact that is NOT grounded: a pre-quality-era artifact or a
 *     confidence-0.1 stub. Kept for read-backward-compat but never satisfies coverage.
 *
 * Stamped at save time when known; `qualityOf` derives it on read for pre-W7 artifacts (no `quality`
 * field), so the W7 migration is implicit — no on-disk rewrite required to start enforcing coverage.
 */
export type QualityTier = 'verified' | 'draft' | 'legacy';

/** Derive an artifact's quality tier. Prefers the stamped `quality` field; falls back to the
 *  pre-W7 signals (`mode==='skeleton'` → draft, `grounded===true` → verified, else legacy) so existing
 *  on-disk artifacts are classified without a rewrite. Pure. */
export function qualityOf(a: LlmArtifact): QualityTier {
  if (a.quality) return a.quality;
  if (a.mode === 'skeleton') return 'draft';
  if (a.grounded === true) return 'verified';
  return 'legacy';
}

/**
 * M2.7 model-tier hint. A deterministic, per-item recommendation for which model tier a host should
 * author the artifact with. The crib never calls a model — the host does — so this is a *contract*
 * the host's dispatcher reads to route items to the right tier. Symbols are the bulk (many small
 * per-callable analyses) → `fast`; files/clusters are mid-synthesis → `balanced`; the system bible is
 * the rare, high-synthesis whole-repo pass → `powerful`. Routing by layer drops cost without quality
 * loss: the cheapest tier handles 90%+ of items by count, the expensive tier only the handful of
 * bibles. The skeleton system pass is a lightweight draft → `balanced`.
 */
export type SuggestedTier = 'fast' | 'balanced' | 'powerful';

/** Per-layer suggested tier (M2.7). Deterministic; the only input is the layer. */
const SUGGESTED_TIER_BY_LAYER: Record<EnrichLayer, SuggestedTier> = {
  symbol: 'fast',
  file: 'balanced',
  cluster: 'balanced',
  system: 'powerful',
};

/**
 * Relative cost multiplier per tier (M2.7 cost model). `fast` ≈ a Haiku-class model, `balanced` ≈ a
 * Sonnet-class, `powerful` ≈ an Opus-class. Used by the crib-enrich SKILL cost model so a host can
 * estimate $/enrichment-pass as Σ (tokens × tierMultiplier × $/1M @ that tier). Relative, not
 * absolute, so the model is stable as absolute prices move.
 */
export const TIER_COST_MULTIPLIER: Record<SuggestedTier, number> = {
  fast: 1,
  balanced: 3,
  powerful: 10,
};

const LAYERS: readonly EnrichLayer[] = ['symbol', 'file', 'cluster', 'system'];
/** Layers that can be path-scoped. The system layer is whole-repo only. */
const LAYERS_SCOPED: readonly EnrichLayer[] = ['symbol', 'file', 'cluster'];
const LLM_VERSION = 1;
const SYSTEM_TARGET = 'system:repo';
const SHARD_HEX = 2;

/**
 * Pending-target count above which `/crib-enrich` shows a graphify-style scope picker instead of
 * blindly looping. Each enrich target authors a deep analysis (~10x a graphify file extraction), so
 * 200 pending ≈ graphify's 500-file threshold in effort. On PENDING (not total) so a fresh large repo
 * never nags. Tunable in one place.
 */
export const ENRICH_SCOPE_THRESHOLD = 200;

/** Rough per-target token heuristics for status-level cost previews. */
const HEURISTIC_TOKENS_PER_LAYER: Record<EnrichLayer, number> = {
  symbol: 2500,
  file: 5000,
  cluster: 8000,
  system: 12000,
};

export interface EnrichScope {
  /** Repo-relative path prefix, e.g. `packages/cli`. Trailing-slash-safe startsWith match. */
  pathPrefix?: string;
  /** Optional cluster refinement inside the prefix: cluster id or slug (`c:...` or bare slug). */
  cluster?: string;
}

export interface EnrichLayerCounts {
  total: number;
  missing: number;
  stale: number;
  fresh: number;
}

export interface EnrichScopeInfo {
  pathPrefix: string;
  label: string;
  pending: number;
  symbols: number;
  files: number;
  clusters: number;
}

export interface EnrichStatus {
  model: string | null;
  builtAgainstHead?: string;
  layers: Record<EnrichLayer, EnrichLayerCounts>;
  nextLayer?: EnrichLayer;
  done: boolean;
  /** Present when `scopes:true` and no active scope: ranked path-prefix scopes for the picker. */
  totalPending?: number;
  threshold?: number;
  scopes?: EnrichScopeInfo[];
  /** Present when a scope is active. */
  scopeEcho?: EnrichScope;
  /** True when the active scope matched zero in-scope targets (typo / empty prefix). */
  scopeEmpty?: boolean;
  /** Under a scope the system layer is whole-repo only; report its pending count separately. */
  wholeRepoPending?: { system: number };
  /** Progress across all layers: completed / pending / total targets. */
  progress?: { completed: number; pending: number; total: number };
  /** Rough token-cost preview (currency: tokens), using heuristics for status and per-seed for next. */
  costEstimate?: { currency: 'tokens'; pending: number; total: number };
  /** Set when `budgetTokens` was supplied and the pending estimate exceeds it. */
  budgetExceeded?: boolean;
  /** Echo of the supplied budget, if any. */
  budget?: number;
  /** Presence/freshness of a draft system skeleton bible (Phase 0.5). The skill authors a skeleton
   *  before Phase 1 only when `present === false`. */
  systemSkeleton?: { present: boolean; fresh: boolean };
}

export interface EnrichStatusArgs {
  layer?: EnrichLayer;
  scope?: EnrichScope;
  /** When true and no scope is set, return ranked scopes + totalPending + threshold for the picker. */
  scopes?: boolean;
  /** Optional token budget guard. If pending cost estimate exceeds this, status returns `budgetExceeded: true`. */
  budgetTokens?: number;
}

export interface EnrichNextArgs {
  layer?: EnrichLayer;
  limit?: number;
  scope?: EnrichScope;
  /** Optional per-batch token budget. Acts as the **packer**: the greedy strict-prefix selector
   *  accumulates items in importance order while their cumulative cost fits this budget, stopping at
   *  the first item that does not fit (it stays first in line next turn — no skipping). When absent,
   *  {@link DEFAULT_BATCH_TOKENS} is used. `limit` (default 25, the hard cap) is only the item-count
   *  safety ceiling. If the FIRST item alone exceeds the budget, it is returned alone with
   *  `budgetExceeded: true` + `oversized: true` so the queue never stalls — raise the budget or
   *  route the item to a bigger tier. */
  budgetTokens?: number;
  /** When true with `layer:'system'`, return a single SKELETON system-bible work item (the quick
   *  Phase-0.5 draft pass) — a lightweight seed (functionalMap + top READMEs + top symbols) the
   *  host authors at confidence ≤0.6 with a draft note. A skeleton never satisfies the system layer
   *  for queue purposes; the final full pass is still offered. Explicit-only — `nextLayer` never
   *  auto-choses skeleton, preventing driver loops. */
  skeleton?: boolean;
}

export interface EnrichOverviewArgs {
  scope?: EnrichScope;
  /** Fold the full analysis+graph+evidence blobs into a `full` array (opt-in; default output is
   *  lean pointers + modules). Always computed live, never served from the cache. */
  withLlm?: boolean;
}

export interface EnrichWorkItem {
  targetId: string;
  seed: Record<string, unknown>;
  lowerLayer: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  instructions: string;
  /** M2.7 model-tier hint the host dispatcher reads to route this item to a tier. */
  suggestedTier: SuggestedTier;
}

export interface EnrichNextBatch {
  batchId: string;
  layer: EnrichLayer;
  items: EnrichWorkItem[];
  remaining: number;
  /** Echo of the selected target ids — lets the caller detect a zero-progress re-issue. */
  selectedTargetIds: string[];
  scopeEcho?: EnrichScope;
  scopeEmpty?: boolean;
  /** The batchId previously issued for this (layer, scope), if any. Server-side source of truth so a
   * context-compacted host (or a headless driver that forgot `lastBatchId`) can still detect a
   * zero-progress re-issue without relying on its own memory. */
  previousBatchId?: string;
  /** True when this batchId equals the previously-issued one for this (layer, scope) — i.e. the same
   * pending set was returned twice with no save landing in between. The server-derived signal that the
   * old 6m27s churn trap is recurring; a driver MUST break on this. */
  zeroProgress?: boolean;
  /** Progress across all layers: completed / pending / total targets. */
  progress?: { completed: number; pending: number; total: number };
  /** Rough token-cost preview (currency: tokens) for this batch, with a per-item breakdown. */
  costEstimate?: {
    currency: 'tokens';
    batch: number;
    perItem: Array<{ targetId: string; tokens: number; tier: SuggestedTier }>;
    totalPending: number;
  };
  /** Set when `budgetTokens` was supplied and the batch estimate exceeds it. Under token-packed
   *  selection this only happens when a single item alone exceeds the budget — the batch is still
   *  returned (that one item) so the queue never stalls. Actionable: raise the budget or route the
   *  item to a bigger model tier. */
  budgetExceeded?: boolean;
  /** Set alongside `budgetExceeded` when the first item alone exceeded the budget and was returned
   *  alone (the oversized-single-item case). Distinct from a normal packed batch, which never
   *  exceeds the budget. */
  oversized?: boolean;
  /** Echo of the supplied budget, if any. */
  budget?: number;
}

export interface LlmAnalysis {
  purpose?: string;
  responsibilities?: string[];
  businessRules?: Array<Record<string, unknown>>;
  inputs?: unknown[];
  outputs?: unknown[];
  sideEffects?: unknown[];
  errorBehavior?: unknown[];
  invariants?: unknown[];
  preconditions?: unknown[];
  postconditions?: unknown[];
  risks?: unknown[];
  whatToDistrust?: unknown[];
  confidence?: number;
  [key: string]: unknown;
}

export interface LlmGraphNode {
  localId: string;
  kind: string;
  name: string;
  summary?: string;
  attributes?: Record<string, unknown>;
}

export interface LlmGraphEdge {
  from: string;
  to: string;
  rel: string;
  rationale?: string;
  confidence?: number;
}

export interface LlmEvidence {
  soulId: string;
  why?: string;
  /** verbatim text lifted from the anchor node's rehydrated span — the grounding quote (M1.3). The
   *  validator rehydrates the span and requires this to overlap; a missing/failed quote downgrades
   *  or rejects the artifact. Optional for backward compat with pre-M1.3 artifacts. */
  quote?: string;
  /** 1-based absolute file line the quote starts at (hint; the validator still rehydrates the span). */
  startLine?: number;
  /** 1-based absolute file line the quote ends at (inclusive). */
  endLine?: number;
}

export interface EnrichSaveItem {
  targetId: string;
  model?: string;
  analysis: LlmAnalysis;
  graph: {
    nodes: LlmGraphNode[];
    edges: LlmGraphEdge[];
  };
  evidence: LlmEvidence[];
}

export interface EnrichSaveArgs {
  batchId: string;
  items: EnrichSaveItem[];
}

export interface EnrichAccepted {
  targetId: string;
  path: string;
  droppedEdges?: Array<{ edge: LlmGraphEdge; reason: string }>;
  /** evidence items whose quotes failed the grounding check (M1.3). Dropped from the persisted
   *  artifact so the on-disk record only ever carries verifiable claims. */
  droppedEvidence?: Array<{ soulId: string; reason: string }>;
  /** true iff ≥1 evidence quote was verified against a rehydrated span (M1.3). */
  grounded?: boolean;
}

export interface EnrichRejected {
  targetId: string;
  reason: string;
}

export interface EnrichSaveResult {
  accepted: EnrichAccepted[];
  rejected: EnrichRejected[];
}

/** Per-target verdict from {@link EnrichmentStore.auditLlm} (M1.3 re-verify). */
export interface AuditTarget {
  targetId: string;
  layer: EnrichLayer;
  stale: boolean;
  /** the artifact's stamped save-time verdict (absent on pre-M1.3 artifacts). */
  stampedGrounded?: boolean;
  /** W7 — the artifact's derived quality tier (verified/draft/legacy). */
  quality: QualityTier;
  /** the recomputed verdict (rehydrated against the CURRENT soul). */
  grounded: boolean;
  score: number;
  groundedCount: number;
  ungroundedCount: number;
  unsupportedCount: number;
  checks: EvidenceCheck[];
}

/** Result of {@link EnrichmentStore.auditLlm} — re-verifies every persisted artifact on disk. */
export interface AuditLlmResult {
  checked: number;
  grounded: number;
  ungrounded: number;
  /** artifacts whose save-time `grounded` stamp disagrees with the recomputed verdict (drift). */
  drifted: number;
  stale: number;
  targets: AuditTarget[];
}

export interface LlmArtifact {
  version: number;
  layer: EnrichLayer;
  targetId: string;
  nodeHash: string;
  schemaVersion: string;
  builtAt: string;
  model?: string;
  /** `'skeleton'` marks a draft system bible (the quick Phase-0.5 pass); `'full'` or absent = the
   *  real pass. Additive — old artifacts read as full. `LLM_VERSION` stays 1. */
  mode?: 'skeleton' | 'full';
  analysis: LlmAnalysis;
  graph: {
    nodes: Array<LlmGraphNode & { id: string; targetId: string }>;
    edges: Array<LlmGraphEdge & { from: string; to: string; targetId: string }>;
  };
  evidence: LlmEvidence[];
  /** M1.3 grounding verdict stamped at save time: true iff ≥1 evidence quote was verified against a
   *  rehydrated span. Absent on pre-M1.3 artifacts (audit-llm recomputes). */
  grounded?: boolean;
  /** W7 semantic quality tier (PRD line 379). Stamped at save time; absent on pre-W7 artifacts
   *  (`qualityOf` derives it from `mode`/`grounded`). Only `verified` satisfies coverage. */
  quality?: QualityTier;
}

export interface LlmRead {
  artifact?: LlmArtifact;
  missing: boolean;
  stale: boolean;
  /** W7 — true when an artifact is present and fresh (not stale) but its quality tier is NOT
   *  `verified` (a draft skeleton or a legacy/ungrounded artifact). Such a target is still PENDING
   *  repair — it does not satisfy coverage — so the queue re-offers it. The artifact is carried so a
   *  caller can inspect what's there before re-authoring. */
  unverified?: boolean;
}

export class EnrichmentStore {
  constructor(
    private readonly soul: SoulStore,
    private readonly repoRoot: string,
  ) {}

  status(args: EnrichStatusArgs = {}): EnrichStatus {
    const manifest = this.readManifest();
    let result: EnrichStatus;
    let layers: Record<EnrichLayer, EnrichLayerCounts>;

    // Picker-discovery mode: no active scope, caller wants the ranked scopes for the picker.
    if (args.scopes && !args.scope) {
      layers = Object.fromEntries(LAYERS.map((layer) => [layer, this.countLayer(layer)])) as Record<
        EnrichLayer,
        EnrichLayerCounts
      >;
      const totalPending = Object.values(layers).reduce((n, l) => n + l.missing + l.stale, 0);
      const nextLayer = args.layer
        ? layers[args.layer].missing + layers[args.layer].stale > 0
          ? args.layer
          : undefined
        : LAYERS.find((layer) => layers[layer].missing + layers[layer].stale > 0);
      result = {
        model: manifest?.model ?? null,
        ...(manifest?.builtAgainstHead ? { builtAgainstHead: manifest.builtAgainstHead } : {}),
        layers,
        ...(nextLayer ? { nextLayer } : {}),
        done: !nextLayer,
        totalPending,
        threshold: ENRICH_SCOPE_THRESHOLD,
        scopes: this.scopes(),
      };
    } else if (args.scope) {
      // Scoped mode: counts/nextLayer/done are over in-scope targets only; system is whole-repo.
      const scope = args.scope;
      layers = Object.fromEntries(
        LAYERS_SCOPED.map((layer) => [layer, this.countLayer(layer, scope)]),
      ) as Record<EnrichLayer, EnrichLayerCounts>;
      // Report the whole-repo system layer separately so the user knows the bible still needs it.
      (layers as Record<EnrichLayer, EnrichLayerCounts>).system = this.countLayer('system');
      const reqLayer =
        args.layer && args.layer !== 'system' ? (args.layer as EnrichLayer) : undefined;
      const nextLayer = reqLayer
        ? layers[reqLayer].missing + layers[reqLayer].stale > 0
          ? reqLayer
          : undefined
        : LAYERS_SCOPED.find((layer) => layers[layer].missing + layers[layer].stale > 0);
      const scopeEmpty = LAYERS_SCOPED.every((layer) => layers[layer].total === 0);
      const wholeSystem = layers.system.missing + layers.system.stale;
      result = {
        model: manifest?.model ?? null,
        ...(manifest?.builtAgainstHead ? { builtAgainstHead: manifest.builtAgainstHead } : {}),
        layers,
        ...(nextLayer ? { nextLayer } : {}),
        done: !nextLayer,
        scopeEcho: scope,
        scopeEmpty,
        wholeRepoPending: { system: wholeSystem },
      };
    } else {
      // Unscoped (current behavior).
      layers = Object.fromEntries(LAYERS.map((layer) => [layer, this.countLayer(layer)])) as Record<
        EnrichLayer,
        EnrichLayerCounts
      >;
      const nextLayer = args.layer
        ? layers[args.layer].missing + layers[args.layer].stale > 0
          ? args.layer
          : undefined
        : LAYERS.find((layer) => layers[layer].missing + layers[layer].stale > 0);
      result = {
        model: manifest?.model ?? null,
        ...(manifest?.builtAgainstHead ? { builtAgainstHead: manifest.builtAgainstHead } : {}),
        layers,
        ...(nextLayer ? { nextLayer } : {}),
        done: !nextLayer,
      };
    }

    result.progress = progressFromLayers(layers);
    result.costEstimate = costFromLayers(layers);
    // Whole-repo skeleton-bible presence/freshness (Phase 0.5 signal). Reported in every mode so the
    // skill can gate Phase 0.5 (`present === false` → author a skeleton) regardless of scope.
    const skeletons = this.allArtifacts().filter(
      (a) => a.layer === 'system' && a.mode === 'skeleton',
    );
    result.systemSkeleton = {
      present: skeletons.length > 0,
      fresh: skeletons.some((a) => !this.isStale(a)),
    };
    if (args.budgetTokens !== undefined) {
      result.budget = args.budgetTokens;
      if (result.costEstimate.pending > args.budgetTokens) {
        result.budgetExceeded = true;
      }
    }
    return result;
  }

  next(args: EnrichNextArgs = {}): EnrichNextBatch {
    // `limit` is now the item-count SAFETY CEILING only (default 25, the max). The real per-batch
    // control is the token budget below — a fixed item count either wastes headroom on cheap items
    // or blows it on fat ones (item cost varies ~15×).
    const limit = Math.max(1, Math.min(args.limit ?? 25, 25));
    const scope = args.scope;
    // Under a scope, the system layer is never offered; default to the scoped nextLayer. If a caller
    // explicitly asks for system under a scope, fall back to the scoped nextLayer (preserving bottom-up
    // order) rather than jumping back to a hardcoded 'symbol' that may already be fresh.
    let layer =
      args.layer ??
      (scope
        ? (this.status({ scope }).nextLayer ?? 'symbol')
        : (this.status().nextLayer ?? 'system'));
    if (scope && layer === 'system') layer = this.status({ scope }).nextLayer ?? 'symbol';
    // Skeleton system pass (Phase 0.5): a single draft-bible work item under a distinct batchId
    // prefix. Explicit-only — never auto-chosen by nextLayer. Scoped requests never hit this
    // (system is whole-repo only).
    if (args.skeleton && layer === 'system' && !scope) {
      return this.nextSkeletonSystem(args);
    }
    const all = this.targets(layer, scope);
    const pending = all.filter((target) => {
      const read = this.read(target.layer, target.id, target.hash);
      // W7: a fresh-but-unverified artifact (draft/legacy) is still pending — re-offer it for repair.
      return read.missing || read.stale || read.unverified;
    });
    // Deterministic batchId over the FULL pending set (not the selection): same pending set
    // => same id => idempotent re-calls, and the id is stable regardless of `limit`/budget. No
    // Date.now() — the old time-based id re-issued the same targets under a fresh batchId forever
    // (the churn trap). Packing only changes `items`/`selectedTargetIds`, never the batchId, so the
    // server-side zero-progress guard is preserved.
    const batchId = `llm:${layer}:${blake3Hex(
      pending
        .map((t) => t.id)
        .sort()
        .join('|'),
    ).slice(0, 12)}`;

    // Token-packed greedy STRICT-PREFIX selection. Walk `pending` in importance order (already
    // ranked by this.targets, tests last). Build each work item once, measure it with the existing
    // estimateWorkItemCost, and accumulate while the cumulative cost fits the budget. Stop at the
    // FIRST item that does not fit — do NOT skip it to fit a smaller later item: skipping breaks
    // importance order and starves expensive-but-important targets forever (they would always sit
    // behind smaller items). The fat item stays first in line for the next turn.
    const hasExplicitBudget = args.budgetTokens !== undefined;
    const budget = hasExplicitBudget ? (args.budgetTokens as number) : DEFAULT_BATCH_TOKENS;
    const items: EnrichWorkItem[] = [];
    const perItemCost: Array<{ targetId: string; tokens: number; tier: SuggestedTier }> = [];
    let batchCost = 0;
    let oversized = false;
    for (const target of pending) {
      if (items.length >= limit) break; // hard item-count ceiling
      const item = this.workItem(target);
      const cost = estimateWorkItemCost(item);
      // Strict prefix: once we have ≥1 item, stop at the first item that would overflow the budget.
      if (items.length > 0 && batchCost + cost > budget) break;
      items.push(item);
      batchCost += cost;
      perItemCost.push({ targetId: item.targetId, tokens: cost, tier: item.suggestedTier });
      // CRITICAL invariant — never return an empty batch. If the FIRST item alone exceeds the
      // budget, return it alone (oversized) so a single fat target can never deadlock the queue.
      // Without this, the packer would emit zero items and the same batchId would re-issue forever.
      if (items.length === 1 && cost > budget) {
        oversized = true;
        break;
      }
    }
    const remainingCount = Math.max(0, pending.length - items.length);
    const totalPendingCostEstimate = batchCost + remainingCount * HEURISTIC_TOKENS_PER_LAYER[layer];
    // budgetExceeded is now ONLY the oversized-single-item case (a normal packed batch never
    // exceeds the budget by construction). Report it only against an explicitly supplied budget —
    // against the default it is not actionable and the single item is simply returned.
    const budgetExceeded = hasExplicitBudget && oversized;

    const baseBatch: EnrichNextBatch = {
      batchId,
      layer,
      items,
      remaining: remainingCount,
      selectedTargetIds: items.map((item) => item.targetId),
      progress: this.status(scope ? { scope } : {}).progress,
      costEstimate: {
        currency: 'tokens',
        batch: batchCost,
        perItem: perItemCost,
        totalPending: totalPendingCostEstimate,
      },
      ...(hasExplicitBudget ? { budget: args.budgetTokens } : {}),
      ...(budgetExceeded ? { budgetExceeded: true, oversized: true } : {}),
      ...(scope ? { scopeEcho: scope, scopeEmpty: all.length === 0 } : {}),
    };

    // Server-side zero-progress detection: persist the last-issued batchId per (layer, scope) so a
    // context-compacted host or a headless driver can detect a re-issue without remembering anything.
    // Persist whenever a workable batch was issued (items > 0) — including the oversized single
    // item, which the caller is expected to author + save. An empty pending set issues nothing and
    // is not persisted (no false zero-progress).
    if (items.length > 0) {
      const key = this.lastIssuedKey(layer, scope);
      const manifest = this.readManifest();
      const previousBatchId = manifest?.lastIssued?.[key]?.batchId;
      const zeroProgress = previousBatchId !== undefined && previousBatchId === batchId;
      const lastIssued = { ...(manifest?.lastIssued ?? {}), [key]: { batchId } };
      this.writeManifest(manifest?.model ?? null, lastIssued);
      return {
        ...baseBatch,
        ...(previousBatchId !== undefined ? { previousBatchId } : {}),
        ...(zeroProgress ? { zeroProgress: true } : {}),
      };
    }
    return baseBatch;
  }

  /** Stable key under which the last-issued batchId is persisted for zero-progress detection. */
  private lastIssuedKey(layer: EnrichLayer, scope?: EnrichScope): string {
    return `${layer}:${scope?.pathPrefix ?? ''}|${scope?.cluster ?? ''}`;
  }

  /**
   * Skeleton system-bible batch (Phase 0.5) — a single draft work item the host authors at
   * confidence ≤0.6 with a draft note, seeded from the functional map + top READMEs + top symbols.
   * Returns an empty batch when a fresh skeleton already exists (the skill gates on
   * `status.systemSkeleton.present`, but the server enforces too). Distinct batchId prefix
   * `llm:system-skeleton:` so a full pass (prefix `llm:system:`) never collides.
   */
  private nextSkeletonSystem(args: EnrichNextArgs): EnrichNextBatch {
    const target = this.targets('system')[0];
    const batchId = `llm:system-skeleton:${blake3Hex(target?.hash ?? 'empty').slice(0, 12)}`;
    const progress = this.status().progress;
    if (!target) {
      return {
        batchId,
        layer: 'system',
        items: [],
        remaining: 0,
        selectedTargetIds: [],
        progress,
        costEstimate: { currency: 'tokens', batch: 0, perItem: [], totalPending: 0 },
      };
    }
    const freshSkeleton = this.allArtifacts().some(
      (a) => a.layer === 'system' && a.mode === 'skeleton' && !this.isStale(a),
    );
    if (freshSkeleton) {
      return {
        batchId,
        layer: 'system',
        items: [],
        remaining: 0,
        selectedTargetIds: [],
        progress,
        costEstimate: { currency: 'tokens', batch: 0, perItem: [], totalPending: 0 },
      };
    }
    const item: EnrichWorkItem = {
      targetId: target.id,
      seed: this.skeletonSeed(),
      lowerLayer: { clusters: this.freshArtifacts('cluster') },
      outputSchema: outputSchema('system'),
      instructions: `${instructionsFor('system')} DRAFT SKELETON: author at confidence ≤0.6 and record a draft note in whatToDistrust. The final full pass will supersede this artifact.`,
      // Skeleton is a lightweight draft → balanced, not the powerful tier the full bible earns.
      suggestedTier: 'balanced',
    };
    const perItemCost = [
      { targetId: item.targetId, tokens: estimateWorkItemCost(item), tier: item.suggestedTier },
    ];
    return {
      batchId,
      layer: 'system',
      items: [item],
      remaining: 0,
      selectedTargetIds: [target.id],
      progress,
      costEstimate: {
        currency: 'tokens',
        batch: perItemCost[0]!.tokens,
        perItem: perItemCost,
        totalPending: perItemCost[0]!.tokens,
      },
      ...(args.budgetTokens !== undefined ? { budget: args.budgetTokens } : {}),
    };
  }

  /** Seed for the skeleton system pass — the functional map, the top README doc-sections, and the
   *  top symbols by importance. Leaner than the full seed (no per-symbol dossiers). */
  private skeletonSeed(): Record<string, unknown> {
    const manifest = this.soul.getManifest();
    const functionalMap = buildFunctionalMap(this.soul, { overlay: readLlmOverlay(this.soul) });
    const readmes = [...this.soul.iterate('doc-section')]
      .filter((d) => d.file && /readme(\.|$)/i.test(d.file))
      .sort(byId)
      .slice(0, 10)
      .map((d) => ({ id: d.id, heading: d.heading, file: d.file }));
    const topSymbols = this.topSymbols(50).map((n) => ({
      id: n.id,
      name: n.name,
      qualifiedName: n.qualifiedName,
      file: n.file,
    }));
    return {
      repo: manifest.repo,
      stats: manifest.stats,
      functionalMap: {
        source: functionalMap.source,
        modules: functionalMap.modules.map(overviewModule),
      },
      readmes,
      topSymbols,
      caveats: [
        'DRAFT skeleton bible — author at confidence ≤0.6 with a draft note in whatToDistrust. The final full pass supersedes this.',
      ],
    };
  }

  save(args: EnrichSaveArgs): EnrichSaveResult {
    const accepted: EnrichAccepted[] = [];
    const rejected: EnrichRejected[] = [];
    const knownLocalIds = this.knownLlmNodeIds();
    const model = args.items.find((i) => i.model)?.model ?? this.readManifest()?.model;

    for (const item of args.items) {
      const target = this.targetFor(item.targetId);
      if (!target) {
        rejected.push({ targetId: item.targetId, reason: 'unknown targetId' });
        continue;
      }
      const malformed = validateSaveItem(item);
      if (malformed) {
        rejected.push({ targetId: item.targetId, reason: malformed });
        continue;
      }

      // M1.4 secret scan (the persist-time guard): the LLM layer is a COMMITTED artifact, and a
      // model-authored evidence `quote` lifts verbatim source. A secret copied into a quote or an
      // analysis field would land in git. Reject the whole item on any hit so a planted canary
      // secret can never reach a committed artifact. Runs BEFORE grounding — a secret must never
      // persist regardless of whether the quote overlaps the span.
      // Scan every string the model authored on this item (analysis + graph + evidence + their
      // nested fields). collectStrings yields bracketed paths like `evidence[0].quote`; we keep
      // every field because the whole item is model-authored and a secret anywhere is a reject.
      const secretFields = collectStrings(item);
      const secretHits = secretFields
        .map((f) => ({ f, hits: scanSecrets(f.value) }))
        .filter((x) => x.hits.length > 0);
      if (secretHits.length > 0) {
        const where = secretHits
          .map((x) => `${x.f.path}(${x.hits.map((h) => h.pattern).join('|')})`)
          .join(', ');
        rejected.push({
          targetId: item.targetId,
          reason: `secret pattern detected in authored field(s): ${where} — redact before persisting`,
        });
        continue;
      }

      // M1.3 grounding (the moat): verify every evidence quote against the rehydrated anchor span.
      //   • any quote present, none grounded → hallucination → reject the whole item.
      //   • otherwise drop the ungrounded quotes, keep grounded + unsupported, stamp `grounded`.
      // Unsupported (no quote / unverifiable anchor) is a downgrade, not a reject — preserves
      // backward compat with pre-M1.3 artifacts whose evidence carried only {soulId, why}.
      const evidenceList = item.evidence ?? [];
      const evidenceChecks = evidenceList.map((ev) => verifyEvidence(this.soul, this.repoRoot, ev));
      const groundedEv: LlmEvidence[] = [];
      const droppedEvidence: Array<{ soulId: string; reason: string }> = [];
      let anyQuoted = false;
      for (const [i, check] of evidenceChecks.entries()) {
        const ev = evidenceList[i];
        if (!ev) continue;
        if (ev.quote?.trim()) anyQuoted = true;
        if (check.verdict === 'grounded') groundedEv.push(ev);
        else if (check.verdict === 'ungrounded')
          droppedEvidence.push({ soulId: ev.soulId, reason: check.reason ?? 'ungrounded' });
        // unsupported → keep (downgrade, not a reject)
      }
      const groundedCount = groundedEv.length;
      if (anyQuoted && groundedCount === 0) {
        rejected.push({
          targetId: item.targetId,
          reason:
            'no evidence grounded — every quoted claim failed overlap with its anchor span (hallucination)',
        });
        continue;
      }

      const localIds = new Set(item.graph.nodes.map((node) => node.localId));
      const droppedEdges: Array<{ edge: LlmGraphEdge; reason: string }> = [];
      const keptEdges: Array<LlmGraphEdge & { from: string; to: string; targetId: string }> = [];
      for (const edge of item.graph.edges) {
        const from = this.resolveEndpoint(edge.from, item.targetId, localIds, knownLocalIds);
        const to = this.resolveEndpoint(edge.to, item.targetId, localIds, knownLocalIds);
        if (!from || !to) {
          droppedEdges.push({ edge, reason: 'unresolved endpoint' });
          continue;
        }
        keptEdges.push({ ...edge, from, to, targetId: item.targetId });
      }

      // Skeleton mode is stamped server-side from the batchId prefix so the skill can't forget — a
      // `llm:system-skeleton:` batch always persists mode:'skeleton'; a full pass leaves mode absent
      // (reads as full) and overwrites the skeleton at the same targetId+nodeHash path.
      const skeletonMode: 'skeleton' | undefined = args.batchId.startsWith('llm:system-skeleton:')
        ? 'skeleton'
        : undefined;
      // W7 quality tier (PRD line 379): verified iff grounded; draft iff a skeleton pass; legacy
      // otherwise (an ungrounded full artifact — e.g. a pre-quality-era artifact or a stub). Only
      // `verified` satisfies coverage; draft/legacy stay pending for repair.
      const quality: QualityTier = skeletonMode
        ? 'draft'
        : groundedCount > 0
          ? 'verified'
          : 'legacy';
      const artifact: LlmArtifact = {
        version: LLM_VERSION,
        layer: target.layer,
        targetId: item.targetId,
        nodeHash: target.hash,
        schemaVersion: this.soul.getManifest().schemaVersion,
        builtAt: new Date().toISOString(),
        ...(item.model ? { model: item.model } : {}),
        ...(skeletonMode ? { mode: skeletonMode } : {}),
        analysis: item.analysis,
        graph: {
          nodes: item.graph.nodes.map((node) => ({
            ...node,
            id: llmNodeId(item.targetId, node.localId),
            targetId: item.targetId,
          })),
          edges: keptEdges,
        },
        // persist only grounded + unsupported evidence; ungrounded quotes were dropped above.
        evidence: groundedEv,
        ...(groundedCount > 0 ? { grounded: true } : { grounded: false }),
        quality,
      };
      const path = this.writeArtifact(artifact);
      this.pruneSuperseded(artifact, path);
      for (const node of artifact.graph.nodes) knownLocalIds.add(node.id);
      accepted.push({
        targetId: item.targetId,
        path,
        ...(droppedEdges.length > 0 ? { droppedEdges } : {}),
        ...(droppedEvidence.length > 0 ? { droppedEvidence } : {}),
        grounded: groundedCount > 0,
      });
    }

    if (accepted.length > 0) this.bumpSemanticGeneration();
    this.writeManifest(model ?? null);
    this.writeOverview();
    return { accepted, rejected };
  }

  readForTarget(targetId: string): LlmRead {
    const target = this.targetFor(targetId);
    if (!target) return { missing: true, stale: false };
    return this.read(target.layer, target.id, target.hash);
  }

  allArtifacts(): LlmArtifact[] {
    const root = this.artifactsRoot();
    if (!existsSync(root)) return [];
    const files = walkFiles(root).filter((p) => p.endsWith('.json'));
    const artifacts: LlmArtifact[] = [];
    for (const file of files) {
      const artifact = readJson<LlmArtifact>(file);
      if (artifact) artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => a.targetId.localeCompare(b.targetId));
  }

  pruneStale(apply = false): {
    apply: boolean;
    candidates: Array<{ path: string; targetId: string; reason: 'stale' | 'orphaned' }>;
    removed: number;
  } {
    const candidates: Array<{
      path: string;
      targetId: string;
      reason: 'stale' | 'orphaned';
    }> = [];
    for (const path of walkFiles(this.artifactsRoot()).filter((p) => p.endsWith('.json'))) {
      const artifact = readJson<LlmArtifact>(path);
      if (!artifact) continue;
      const target = this.targetFor(artifact.targetId);
      const reason = !target ? 'orphaned' : this.isStale(artifact) ? 'stale' : undefined;
      if (reason) candidates.push({ path, targetId: artifact.targetId, reason });
    }
    if (apply) for (const candidate of candidates) rmSync(candidate.path, { force: true });
    if (apply && candidates.length > 0) {
      this.bumpSemanticGeneration();
      this.writeManifest(this.readManifest()?.model ?? null);
      this.writeOverview();
    }
    return { apply, candidates, removed: apply ? candidates.length : 0 };
  }

  /**
   * `audit-llm` (M1.3 — the moat): re-verify every persisted artifact on disk against the CURRENT
   * soul. Re-runs the same grounding check that ran at `enrich_save` time, so a post-refactor re-verify
   * (the soul changed, the on-disk artifact is stale) is identical to the original verdict. Reports
   * per-target verdicts + drift (a save-time `grounded` stamp that disagrees with the recomputed one)
   * + staleness. PURE over the soul + repoRoot — never calls a model, never mutates the on-disk artifacts.
   */
  auditLlm(): AuditLlmResult {
    const targets: AuditTarget[] = [];
    let grounded = 0;
    let ungrounded = 0;
    let drifted = 0;
    let stale = 0;
    for (const artifact of this.allArtifacts()) {
      const target = this.targetFor(artifact.targetId);
      const isStale = target
        ? artifact.nodeHash !== target.hash ||
          artifact.schemaVersion !== this.soul.getManifest().schemaVersion
        : true;
      if (isStale) stale++;
      const result: GroundingResult = verifyArtifact(this.soul, this.repoRoot, artifact);
      const recomputedGrounded = result.verified;
      if (recomputedGrounded) grounded++;
      else ungrounded++;
      const stamped = artifact.grounded;
      if (stamped !== undefined && stamped !== recomputedGrounded) drifted++;
      targets.push({
        targetId: artifact.targetId,
        layer: artifact.layer,
        stale: isStale,
        ...(stamped !== undefined ? { stampedGrounded: stamped } : {}),
        quality: qualityOf(artifact),
        grounded: recomputedGrounded,
        score: result.score,
        groundedCount: result.grounded,
        ungroundedCount: result.ungrounded,
        unsupportedCount: result.unsupported,
        checks: result.checks,
      });
    }
    return { checked: targets.length, grounded, ungrounded, drifted, stale, targets };
  }

  /**
   * `crib export --format llm` (M1.4): render the committed LLM layer as JSON. With `redact` (default)
   * every evidence `quote` is replaced by a span ref `{soulId, file, startLine, endLine}` — verbatim
   * source stripped — and any secret-pattern substring in analysis/graph strings is masked. Use this
   * bundle, not raw `.crib/graph/semantic` artifacts, when sharing externally.
   */
  exportLlm(redact: boolean): string {
    const artifacts = this.allArtifacts().map((a) => {
      if (!redact) return a;
      const evidence = (a.evidence ?? []).map((e) => {
        const node = this.soul.getNode(e.soulId);
        const startLine = e.startLine ?? node?.span?.start;
        const endLine = e.endLine ?? node?.span?.end;
        return {
          soulId: e.soulId,
          ...(e.why ? { why: redactSecrets(e.why) } : {}),
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
          ...(node?.file ? { file: node.file } : {}),
        };
      });
      return {
        ...a,
        analysis: JSON.parse(redactSecrets(JSON.stringify(a.analysis))) as LlmAnalysis,
        graph: JSON.parse(redactSecrets(JSON.stringify(a.graph))) as LlmArtifact['graph'],
        evidence,
      };
    });
    return `${JSON.stringify({ schemaVersion: 'llm-1', redacted: redact, artifacts }, null, 2)}\n`;
  }

  overview(args: EnrichOverviewArgs = {}): Record<string, unknown> {
    const scope = args.scope;
    const withLlm = args.withLlm ?? false;
    // Unscoped: serve the cached whole-repo overview.json (lean v2 shape), rebuilding only if absent
    // OR stale (the soul was rebuilt against a new vcsHead) OR the cache is a pre-v2 file. v1 caches
    // (version absent or 1) auto-rebuild via the `version === 2` gate — free migration. `withLlm`
    // always computes live (blobs never cached).
    if (!scope) {
      const overviewPath = join(this.soul.cribDir, 'index', 'overview.json');
      const currentHead = this.soul.getManifest().repo.vcsHead ?? null;
      if (!withLlm) {
        const cached = readJson<{ version?: number; builtAgainstHead?: string }>(overviewPath);
        if (cached && cached.version === 2 && cached.builtAgainstHead === currentHead)
          return cached as Record<string, unknown>;
      }
      const rebuilt = this.buildOverview(undefined, withLlm);
      if (!withLlm) writeJsonAtomic(overviewPath, rebuilt);
      return rebuilt;
    }
    // Scoped: a module bible is computed live (never cached on disk beside the whole-repo one).
    return this.buildOverview(scope);
  }

  neighbors(id: string): Record<string, unknown> {
    const resolved = this.soul.getNode(id) ? id : this.resolveLlmId(id);
    if (!resolved)
      return { error: { code: 'NOT_FOUND', message: `no soul or LLM node with id ${id}` } };
    const edges = this.allArtifacts()
      .flatMap((a) => a.graph.edges)
      .filter((e) => e.from === resolved || e.to === resolved)
      .sort((a, b) => `${a.from}:${a.to}:${a.rel}`.localeCompare(`${b.from}:${b.to}:${b.rel}`));
    return { id: resolved, edges };
  }

  matchText(q: string, limit: number): LlmArtifact[] {
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length === 0) return [];
    // Rank by term-overlap count (desc) so a query whose terms all land in one artifact's
    // analysis/graph beats an artifact that mentions only one term. This also de-prioritizes
    // single-term false positives (e.g. a test helper that happens to mention "sqlite" once)
    // relative to artifacts whose core purpose/responsibilities match every query term.
    return this.allArtifacts()
      .map((a) => ({ a, hits: terms.filter((term) => artifactText(a).includes(term)).length }))
      .filter((x) => x.hits > 0 && !this.isStale(x.a))
      .sort((x, y) => y.hits - x.hits)
      .slice(0, limit)
      .map((x) => x.a);
  }

  hasAnyFresh(): boolean {
    return this.allArtifacts().some((a) => !this.isStale(a));
  }

  private countLayer(layer: EnrichLayer, scope?: EnrichScope): EnrichLayerCounts {
    const targets = this.targets(layer, scope);
    const counts: EnrichLayerCounts = { total: targets.length, missing: 0, stale: 0, fresh: 0 };
    for (const target of targets) {
      const read = this.read(layer, target.id, target.hash);
      // W7: only `verified` satisfies coverage. A fresh-but-unverified artifact (draft/legacy) is
      // pending repair → count it as missing so `nextLayer`/`done`/`progress` reflect real coverage,
      // not stubs that masquerade as fresh (PRD line 380, exit gate line 392).
      if (read.missing) counts.missing++;
      else if (read.stale) counts.stale++;
      else if (read.unverified) counts.missing++;
      else counts.fresh++;
    }
    return counts;
  }

  private targets(
    layer: EnrichLayer,
    scope?: EnrichScope,
  ): Array<{ layer: EnrichLayer; id: string; hash: string; node?: Node }> {
    if (layer === 'system') {
      // The system layer is whole-repo only — never scoped.
      if (scope) return [];
      const any = [...this.soul.iterate()].length > 0;
      return any ? [{ layer, id: SYSTEM_TARGET, hash: this.systemHash() }] : [];
    }
    if (layer === 'cluster') {
      const imp = this.importanceMap();
      return this.rankNodes([...this.soul.iterate('cluster')], layer, imp)
        .map((node) => ({ layer, id: node.id, hash: this.clusterHash(node), node }))
        .filter((target) => this.matchesScope(target.node!, layer, scope));
    }
    const imp = this.importanceMap();
    return this.rankNodes([...this.soul.iterate(layer)], layer, imp)
      .map((node) => ({ layer, id: node.id, hash: node.hash, node }))
      .filter((target) => this.matchesScope(target.node!, layer, scope));
  }

  /**
   * Importance-ranked queue ordering (outcome D, the new default): tests LAST, then importance desc
   * (cluster = summed member importance), then id asc as the deterministic tie-break. Replaces the
   * old alphabetical-by-id sort that surfaced `cli.test.ts` helpers before production symbols on a
   * partial enrichment. The batchId hashes the FULL pending set (order-independent), so reordering
   * `pending.slice(0, limit)` does not change the batchId — only which targets a small batch hits.
   */
  private rankNodes(
    nodes: Node[],
    layer: EnrichLayer,
    importance: Map<string, ImportanceEntry>,
  ): Node[] {
    return nodes
      .map((node) => ({ node, rank: this.targetRank(node, layer, importance) }))
      .sort((a, b) => {
        if (a.rank.test !== b.rank.test) return a.rank.test ? 1 : -1;
        if (b.rank.imp !== a.rank.imp) return b.rank.imp - a.rank.imp;
        return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
      })
      .map(({ node }) => node);
  }

  /** Test-path flag + importance for a target. Clusters: test iff the majority of members live in
   *  test files; importance = summed member importance. */
  private targetRank(
    node: Node,
    layer: EnrichLayer,
    importance: Map<string, ImportanceEntry>,
  ): { test: boolean; imp: number } {
    if (layer === 'cluster') {
      const members = clusterMembersCore(this.soul, node);
      if (members.length === 0) return { test: false, imp: 0 };
      const tests = members.filter((m) => isTestPath(m.file)).length;
      return {
        test: tests > members.length / 2,
        imp: clusterImportance(this.soul, node, importance),
      };
    }
    return { test: isTestPath(node.file), imp: importance.get(node.id)?.importance ?? 0 };
  }

  /** Per-instance importance cache keyed on `manifest.stats.lastUpdated` so the queue re-ranks once
   *  per soul generation, not once per `targets()` call. */
  private importanceCache: { key: string; map: Map<string, ImportanceEntry> } | undefined;
  private importanceMap(): Map<string, ImportanceEntry> {
    const key = this.soul.getManifest().stats.lastUpdated;
    if (this.importanceCache && this.importanceCache.key === key) return this.importanceCache.map;
    const map = computeImportance(this.soul);
    this.importanceCache = { key, map };
    return map;
  }

  /**
   * True when the node is in-scope for the given layer. Absent scope => true for all (except system,
   * which targets() short-circuits). Trailing-slash-safe: `packages/core` matches `packages/core` and
   * `packages/core/x.ts` but not `packages/core-extra/x.ts`.
   */
  private matchesScope(node: Node, layer: EnrichLayer, scope?: EnrichScope): boolean {
    if (!scope) return true;
    const { pathPrefix, cluster } = scope;
    if (layer === 'symbol' || layer === 'file') {
      const p = node.file;
      if (pathPrefix && (!p || !(p === pathPrefix || p.startsWith(`${pathPrefix}/`)))) return false;
      if (cluster) {
        // Cluster refinement: resolve the cluster node (by id or slug) and check membership via the
        // cluster's `members` array — what the pipeline actually stamps. The pipeline never stamps
        // `clusterId` onto symbols, so reading `node.clusterId` alone (the old code) excluded every
        // symbol and dropped the primary layer of a cluster-scoped run. `node.clusterId` is still
        // honored when present for back-compat with any soul that does stamp it.
        const clusterNode = this.resolveCluster(cluster);
        if (!clusterNode) return false;
        if (layer === 'symbol') {
          if (!this.symbolInCluster(node, clusterNode)) return false;
        } else {
          // A file is in the cluster if any cluster member symbol lives in that file.
          if (!this.fileInCluster(p, clusterNode)) return false;
        }
      }
      return true;
    }
    if (layer === 'cluster') {
      const members = this.clusterMembers(node);
      if (
        pathPrefix &&
        !members.some(
          (m) => m.file && (m.file === pathPrefix || m.file.startsWith(`${pathPrefix}/`)),
        )
      ) {
        return false;
      }
      if (cluster) {
        const slug = node.id.startsWith('c:') ? node.id.slice(2) : node.id;
        if (node.id !== cluster && slug !== cluster && `c:${slug}` !== cluster) return false;
      }
      return true;
    }
    return true;
  }

  /** Find a cluster node by id or slug (`c:slug` or bare `slug`). */
  private resolveCluster(ref: string): Node | undefined {
    const norm = (x: string): string => (x.startsWith('c:') ? x.slice(2) : x);
    const r = norm(ref);
    return [...this.soul.iterate('cluster')].find((c) => norm(c.id) === r);
  }

  /** True when the symbol node belongs to the cluster (via members array, with clusterId back-compat). */
  private symbolInCluster(symbol: Node, cluster: Node): boolean {
    const memberIds = new Set(cluster.members ?? []);
    if (memberIds.has(symbol.id)) return true;
    const slug = cluster.id.startsWith('c:') ? cluster.id.slice(2) : cluster.id;
    return symbol.clusterId === cluster.id || symbol.clusterId === slug;
  }

  /** True when the file path contains any member symbol of the cluster. */
  private fileInCluster(file: string | undefined, cluster: Node): boolean {
    if (!file) return false;
    const memberIds = new Set(cluster.members ?? []);
    return [...this.soul.iterate('symbol')].some((n) => memberIds.has(n.id) && n.file === file);
  }

  /**
   * Rank the top-5 repo path prefixes by pending symbol count for the graphify-style picker.
   * Monorepo descent: if the largest first-component bucket holds >80% of symbols (e.g. every target
   * under `packages/`), re-group by the first TWO components so `packages/cli`, `packages/core` show
   * as distinct rows instead of one useless `packages` row.
   */
  private scopes(): EnrichScopeInfo[] {
    const symbols = [...this.soul.iterate('symbol')];
    if (symbols.length === 0) return [];

    // Precompute pending symbol ids once (one disk read per symbol) — scopes() runs once per run.
    const pendingIds = new Set<string>();
    for (const s of symbols) {
      const r = this.read('symbol', s.id, s.hash);
      if (r.missing || r.stale) pendingIds.add(s.id);
    }

    const buckets = this.groupByPathPrefix(symbols, 1);
    if (buckets.length === 0) return [];
    const total = symbols.length;
    const largest = [...buckets].sort((a, b) => b.symbols.length - a.symbols.length)[0];
    const effective =
      largest && largest.symbols.length > total * 0.8
        ? this.groupByPathPrefix(symbols, 2)
        : buckets;

    const files = [...this.soul.iterate('file')];
    const clusters = [...this.soul.iterate('cluster')];

    const infos = effective.map((bucket) => {
      const { pathPrefix, symbols: syms } = bucket;
      const pending = syms.filter((s) => pendingIds.has(s.id)).length;
      const fileCount = files.filter(
        (f) => f.file && (f.file === pathPrefix || f.file.startsWith(`${pathPrefix}/`)),
      ).length;
      const clusterCount = clusters.filter((c) =>
        this.clusterMembers(c).some(
          (m) => m.file && (m.file === pathPrefix || m.file.startsWith(`${pathPrefix}/`)),
        ),
      ).length;
      const label = pathPrefix.split('/').pop() || '(root)';
      return {
        pathPrefix,
        label,
        pending,
        symbols: syms.length,
        files: fileCount,
        clusters: clusterCount,
      };
    });

    return infos
      .sort((a, b) => b.pending - a.pending || a.pathPrefix.localeCompare(b.pathPrefix))
      .slice(0, 5);
  }

  private groupByPathPrefix(
    symbols: Node[],
    depth: number,
  ): Array<{ pathPrefix: string; symbols: Node[] }> {
    const map = new Map<string, Node[]>();
    for (const n of symbols) {
      const p = n.file;
      if (!p) continue;
      const parts = p.split('/');
      const prefix = parts.slice(0, depth).join('/');
      if (!prefix || parts.length < depth) continue;
      if (!map.has(prefix)) map.set(prefix, []);
      map.get(prefix)!.push(n);
    }
    return [...map.entries()].map(([pathPrefix, syms]) => ({ pathPrefix, symbols: syms }));
  }

  /** True when a saved artifact's target is in-scope (for the scoped overview). */
  private artifactInScope(a: LlmArtifact, scope: EnrichScope): boolean {
    if (a.layer === 'system') return false; // scoped overview excludes the whole-repo bible.
    const node = this.soul.getNode(a.targetId);
    if (!node) return false;
    return this.matchesScope(node, a.layer, scope);
  }

  private targetFor(
    targetId: string,
  ): { layer: EnrichLayer; id: string; hash: string; node?: Node } | undefined {
    if (targetId === SYSTEM_TARGET)
      return { layer: 'system', id: targetId, hash: this.systemHash() };
    const node = this.soul.getNode(targetId);
    if (!node) return undefined;
    if (node.kind === 'symbol' || node.kind === 'file' || node.kind === 'cluster') {
      const layer = node.kind;
      return {
        layer,
        id: targetId,
        hash: layer === 'cluster' ? this.clusterHash(node) : node.hash,
        node,
      };
    }
    return undefined;
  }

  private workItem(target: {
    layer: EnrichLayer;
    id: string;
    hash: string;
    node?: Node;
  }): EnrichWorkItem {
    return {
      targetId: target.id,
      seed: this.seed(target),
      lowerLayer: this.lowerLayer(target),
      outputSchema: outputSchema(target.layer),
      instructions: instructionsFor(target.layer),
      suggestedTier: SUGGESTED_TIER_BY_LAYER[target.layer],
    };
  }

  private seed(target: { layer: EnrichLayer; id: string; node?: Node }): Record<string, unknown> {
    if (target.layer === 'symbol' && target.node) {
      const manifest = this.soul.getManifest();
      const dossier = buildDossier(
        this.soul,
        this.repoRoot,
        target.id,
        manifest.stats.lastUpdated,
        {
          includeTables: true,
        },
      );
      return {
        node: target.node,
        sourceBody: dossier?.source,
        callers: dossier?.callers ?? [],
        callees: dossier?.callees ?? [],
        decisionTable: target.node.type
          ? decisionTable(this.soul, target.id, { includeTables: true })
          : undefined,
        controlFlow: dossier?.controlFlow,
        coverage: target.node.type ? computeCoverage(this.soul, target.id) : undefined,
        caveats: [
          'Respect only facts grounded in this seed and the supplied lower-layer analyses.',
        ],
      };
    }
    if (target.layer === 'file' && target.node) {
      const symbols = [...this.soul.iterate('symbol')]
        .filter((n) => n.file === target.node?.file)
        .sort(byId)
        .map((n) => ({
          id: n.id,
          name: n.name,
          qualifiedName: n.qualifiedName,
          type: n.type,
          hash: n.hash,
        }));
      return { node: target.node, symbols };
    }
    if (target.layer === 'cluster' && target.node) {
      return { node: target.node, members: this.clusterMembers(target.node).map((n) => n.id) };
    }
    return {
      repo: this.soul.getManifest().repo,
      stats: this.soul.getManifest().stats,
      // Importance-ranked entry points (tests deprioritized) — replaces the old unranked
      // alphabetical slice(0,50) so the bible seed leads with the architecturally central symbols.
      entryPoints: this.topSymbols(50).map((n) => ({
        id: n.id,
        name: n.name,
        qualifiedName: n.qualifiedName,
        file: n.file,
      })),
    };
  }

  /** Top-N symbols by importance (tests last, id tie-break) — used by the system + skeleton seeds. */
  private topSymbols(limit: number): Node[] {
    const imp = this.importanceMap();
    return [...this.soul.iterate('symbol')]
      .filter((n) => n.type && ['function', 'method', 'procedure'].includes(n.type))
      .map((n) => ({
        node: n,
        test: isTestPath(n.file),
        imp: imp.get(n.id)?.importance ?? 0,
      }))
      .sort((a, b) => {
        if (a.test !== b.test) return a.test ? 1 : -1;
        if (b.imp !== a.imp) return b.imp - a.imp;
        return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
      })
      .slice(0, limit)
      .map(({ node }) => node);
  }

  private lowerLayer(target: { layer: EnrichLayer; node?: Node }): Record<string, unknown> {
    if (target.layer === 'symbol') return {};
    if (target.layer === 'file' && target.node) {
      return {
        symbols: this.verifiedArtifacts('symbol').filter(
          (a) => this.soul.getNode(a.targetId)?.file === target.node?.file,
        ),
      };
    }
    if (target.layer === 'cluster' && target.node) {
      const memberFiles = new Set(
        this.clusterMembers(target.node)
          .map((n) => n.file)
          .filter(Boolean),
      );
      return {
        files: this.verifiedArtifacts('file').filter((a) =>
          memberFiles.has(this.soul.getNode(a.targetId)?.file),
        ),
      };
    }
    return { clusters: this.verifiedArtifacts('cluster') };
  }

  private freshArtifacts(layer: EnrichLayer): LlmArtifact[] {
    return this.allArtifacts().filter((a) => a.layer === layer && !this.isStale(a));
  }

  /** W7 — fresh AND `verified` artifacts only. Used to seed the lower-layer context fed to a higher
   *  layer's work items so a draft/legacy stub can never masquerade as a grounded lower-layer
   *  analysis and propagate garbage upward (PRD line 380). `freshArtifacts` (display/overview) stays
   *  broader — it still surfaces draft/legacy for transparency. */
  private verifiedArtifacts(layer: EnrichLayer): LlmArtifact[] {
    return this.allArtifacts().filter(
      (a) => a.layer === layer && !this.isStale(a) && qualityOf(a) === 'verified',
    );
  }

  private read(layer: EnrichLayer, targetId: string, liveHash: string): LlmRead {
    const dir = join(this.artifactsRoot(), layer, shard(targetId));
    const prefix = `${safeName(targetId)}_`;
    if (!existsSync(dir)) return { missing: true, stale: false };
    const candidates = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort();
    if (candidates.length === 0) return { missing: true, stale: false };
    // Prefer the artifact whose nodeHash matches the live hash (the fresh one). After a re-index both
    // an old-hash and new-hash file coexist; picking by alphabetical-last could select the stale file
    // and report a freshly-saved target as stale forever (a false zero-progress stop).
    let artifact: LlmArtifact | undefined;
    for (const name of candidates) {
      const candidate = readJson<LlmArtifact>(join(dir, name));
      if (candidate?.nodeHash === liveHash) {
        artifact = candidate;
        break;
      }
      artifact ??= candidate;
    }
    if (!artifact) return { missing: true, stale: false };
    const stale =
      artifact.nodeHash !== liveHash ||
      artifact.schemaVersion !== this.soul.getManifest().schemaVersion;
    // A fresh skeleton system bible counts as MISSING for queue purposes — the full pass is still
    // offered. A stale skeleton stays stale (re-offered). `overview()` reads skeletons directly via
    // allArtifacts, so this only affects the queue, not the served bible.
    if (layer === 'system' && artifact.mode === 'skeleton' && !stale)
      return { missing: true, stale: false };
    // W7: a fresh-but-unverified artifact (draft/legacy) is NOT coverage-satisfied. Flag it so the
    // queue re-offers the target for repair. `verified` artifacts (grounded) pass through as fresh.
    if (!stale && qualityOf(artifact) !== 'verified')
      return { artifact, missing: false, stale: false, unverified: true };
    return { artifact, missing: false, stale };
  }

  private writeArtifact(artifact: LlmArtifact): string {
    const path = artifactPath(
      this.artifactsRoot(),
      artifact.layer,
      artifact.targetId,
      artifact.nodeHash,
    );
    writeJsonAtomic(path, artifact);
    return path;
  }

  private pruneSuperseded(artifact: LlmArtifact, keepPath: string): void {
    const dir = dirname(keepPath);
    const prefix = `${safeName(artifact.targetId)}_`;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path !== keepPath && name.startsWith(prefix) && name.endsWith('.json')) {
        rmSync(path, { force: true });
      }
    }
  }

  private writeManifest(
    model: string | null,
    lastIssued?: Record<string, { batchId: string }>,
  ): void {
    const status = Object.fromEntries(LAYERS.map((layer) => [layer, this.countLayer(layer)]));
    // Preserve the lastIssued zero-progress map across the save() path, which also writes the manifest.
    const preserved = lastIssued ?? this.readManifest()?.lastIssued;
    writeJsonAtomic(this.statePath(), {
      version: LLM_VERSION,
      model,
      builtAgainstHead: this.soul.getManifest().repo.vcsHead ?? null,
      layerCounts: status,
      ...(presencedLastIssued(preserved) ? { lastIssued: preserved } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Advance the authoritative graph generation whenever canonical semantic artifacts change. */
  private bumpSemanticGeneration(): void {
    if (!existsSync(join(this.soul.cribDir, 'graph', 'manifest.json'))) return;
    const manifest = this.soul.getManifest();
    const generation = manifest.generation ?? { extracted: 0, semantic: 0 };
    manifest.generation = { ...generation, semantic: generation.semantic + 1 };
    writeJsonAtomic(join(this.soul.cribDir, 'graph', 'manifest.json'), manifest);
  }

  private readManifest():
    | {
        model?: string | null;
        builtAgainstHead?: string | null;
        lastIssued?: Record<string, { batchId: string }>;
      }
    | undefined {
    return readJson(this.statePath());
  }

  private writeOverview(): void {
    writeJsonAtomic(
      join(this.soul.cribDir, 'index', 'overview.json'),
      this.buildOverview(undefined, false),
    );
  }

  /**
   * Overview v2 — module-segmented, importance-ranked, LEAN by default. The old v1 dumped every
   * fresh artifact as a full analysis+graph+evidence blob sorted alphabetically by targetId, so on
   * a partial enrichment the test helpers from `cli.test.ts` sorted first and megabytes of test
   * scaffolding swamped the system bible. v2:
   *
   *   • `modules` — ALWAYS present, works at 0% enrichment (computed from the soul, not the LLM
   *     layer); the functional segregation the user asked for.
   *   • `analyses` — lean pointers `{layer, targetId, purpose, confidence?, stale}`, sorted by
   *     importance desc with test paths deprioritized — production symbols first, test helpers last.
   *   • `system` / `systemProvenance` — the freshest system bible (full preferred over skeleton).
   *   • `full` — the old-style blobs, ONLY when `withLlm:true` (opt-in; never cached).
   *
   * The system bible is moved OUT of `analyses` into its own slot (it was always the most valuable
   * artifact yet arrived last under alphabetical sort). Scoped overviews exclude the system layer
   * and filter modules/analyses to the scope.
   */
  private buildOverview(scope?: EnrichScope, withLlm = false): Record<string, unknown> {
    const overlay = readLlmOverlay(this.soul);
    const functionalMap = buildFunctionalMap(this.soul, { overlay });

    // Modules: filter to the scope's path prefix when scoped (system is whole-repo only; a scoped
    // overview reports just the in-scope modules).
    let modules = functionalMap.modules;
    if (scope?.pathPrefix) {
      modules = modules.filter(
        (m) => m.pathPrefix === scope.pathPrefix || m.pathPrefix.startsWith(`${scope.pathPrefix}/`),
      );
    }

    // Fresh non-system artifacts → lean pointers, importance-sorted, tests last.
    const importance = computeImportance(this.soul);
    let fresh = this.allArtifacts().filter((a) => !this.isStale(a) && a.layer !== 'system');
    if (scope) fresh = fresh.filter((a) => this.artifactInScope(a, scope));
    const ranked = fresh
      .map((a) => ({
        a,
        imp: this.artifactImportance(a, importance),
        test: this.artifactIsTest(a),
      }))
      .sort((x, y) => {
        if (x.test !== y.test) return x.test ? 1 : -1;
        if (y.imp !== x.imp) return y.imp - x.imp;
        return x.a.targetId < y.a.targetId ? -1 : x.a.targetId > y.a.targetId ? 1 : 0;
      });
    const analyses = ranked.map(({ a }) => ({
      layer: a.layer,
      targetId: a.targetId,
      purpose: a.analysis.purpose ?? '',
      ...(a.analysis.confidence !== undefined ? { confidence: a.analysis.confidence } : {}),
      quality: qualityOf(a),
      stale: false,
    }));

    // System bible: unscoped only; full preferred over skeleton; freshest (non-stale pool, then
    // stale fallback so a draft skeleton still surfaces when that's all that exists).
    let system: LlmArtifact | undefined;
    if (!scope) {
      const sysArts = this.allArtifacts().filter((a) => a.layer === 'system');
      const freshSys = sysArts.filter((a) => !this.isStale(a));
      const pool = freshSys.length > 0 ? freshSys : sysArts;
      system = pool.find((a) => a.mode !== 'skeleton') ?? pool[0];
    }

    const result: Record<string, unknown> = {
      version: 2,
      model: this.readManifest()?.model ?? null,
      builtAgainstHead: this.soul.getManifest().repo.vcsHead ?? null,
      modules: modules.map((m) => overviewModule(m)),
      analyses,
      ...(system
        ? {
            system: system.analysis,
            systemProvenance: {
              mode: system.mode === 'skeleton' ? 'skeleton' : 'full',
              stale: this.isStale(system),
            },
          }
        : {}),
      ...(scope ? { scopeEcho: scope } : {}),
    };

    // Opt-in full blobs (never cached): the old-style analysis+graph+evidence per fresh artifact,
    // importance-sorted, with the system bible first.
    if (withLlm) {
      const full: Array<Record<string, unknown>> = [];
      if (system) {
        full.push({
          layer: system.layer,
          targetId: system.targetId,
          analysis: system.analysis,
          graph: system.graph,
          evidence: system.evidence,
        });
      }
      for (const { a } of ranked) {
        full.push({
          layer: a.layer,
          targetId: a.targetId,
          analysis: a.analysis,
          graph: a.graph,
          evidence: a.evidence,
        });
      }
      result.full = full;
    }
    return result;
  }

  /** Importance of an artifact's target — symbol/file degree-weighted importance, or summed member
   *  importance for a cluster. System artifacts are excluded from `analyses` so this is never called
   *  for them. */
  private artifactImportance(a: LlmArtifact, importance: Map<string, ImportanceEntry>): number {
    if (a.layer === 'cluster') {
      const node = this.soul.getNode(a.targetId);
      return node ? clusterImportance(this.soul, node, importance) : 0;
    }
    return importance.get(a.targetId)?.importance ?? 0;
  }

  /** Test-path deprioritization for an artifact — a symbol/file is a test if its file is a test
   *  path; a cluster is a test if the majority of its members live in test files. */
  private artifactIsTest(a: LlmArtifact): boolean {
    const node = this.soul.getNode(a.targetId);
    if (!node) return false;
    if (a.layer === 'cluster') {
      const members = clusterMembersCore(this.soul, node);
      if (members.length === 0) return false;
      const tests = members.filter((m) => isTestPath(m.file)).length;
      return tests > members.length / 2;
    }
    return isTestPath(node.file);
  }

  private resolveEndpoint(
    endpoint: string,
    targetId: string,
    localIds: Set<string>,
    knownLlmIds: Set<string>,
  ): string | undefined {
    if (this.soul.getNode(endpoint)) return endpoint;
    if (localIds.has(endpoint)) return llmNodeId(targetId, endpoint);
    if (knownLlmIds.has(endpoint)) return endpoint;
    const sameTarget = llmNodeId(targetId, endpoint);
    if (knownLlmIds.has(sameTarget)) return sameTarget;
    return undefined;
  }

  private knownLlmNodeIds(): Set<string> {
    return new Set(this.allArtifacts().flatMap((a) => a.graph.nodes.map((n) => n.id)));
  }

  private resolveLlmId(id: string): string | undefined {
    const ids = this.knownLlmNodeIds();
    if (ids.has(id)) return id;
    const matches = [...ids].filter((candidate) => candidate.endsWith(`#${id}`));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private isStale(artifact: LlmArtifact): boolean {
    const target = this.targetFor(artifact.targetId);
    return (
      !target ||
      target.hash !== artifact.nodeHash ||
      artifact.schemaVersion !== this.soul.getManifest().schemaVersion
    );
  }

  /** Cluster membership — delegates to the core `cluster-hash` module so the MCP layer and the
   *  functional map share one implementation (the parity guarantee). */
  private clusterMembers(cluster: Node): Node[] {
    return clusterMembersCore(this.soul, cluster);
  }

  /** Cluster content hash — delegates to core `clusterContentHash` (byte-identical to the old
   *  inline formula; guarded by `cluster-hash.parity.test.ts`). */
  private clusterHash(cluster: Node): string {
    return clusterContentHash(this.soul, cluster);
  }

  private systemHash(): string {
    return contentHash(
      [...this.soul.iterate()]
        .map((n) => `${n.id}:${n.hash}`)
        .sort()
        .join('|'),
    );
  }

  private root(): string {
    const canonical = join(this.soul.cribDir, 'graph', 'manifest.json');
    return existsSync(canonical)
      ? join(this.soul.cribDir, 'graph', 'semantic')
      : join(this.soul.cribDir, 'llm');
  }

  private artifactsRoot(): string {
    const root = this.root();
    return root.endsWith(`${sep}llm`) ? join(root, 'analysis') : join(root, 'artifacts');
  }

  private statePath(): string {
    const root = this.root();
    return root.endsWith(`${sep}llm`) ? join(root, 'manifest.json') : join(root, 'state.json');
  }
}

export function llmProjection(read: LlmRead): Record<string, unknown> | undefined {
  if (!read.artifact) return undefined;
  return {
    provenance: 'LLM',
    model: read.artifact.model,
    stale: read.stale,
    confidence: read.artifact.analysis.confidence,
    analysis: read.artifact.analysis,
    graph: read.artifact.graph,
    evidence: read.artifact.evidence,
  };
}

/**
 * Lightweight LLM pointer — the DEFAULT projection folded onto a hit so a consumer can see "an LLM
 * analysis exists for this target, here is its one-line purpose + confidence" without paying the
 * multi-KB cost of the full analysis+graph+evidence blob. The full {@link llmProjection} is opt-in
 * via `withLlm: true` on the read verbs; this pointer is what keeps `query`/`context`/`dossier`
 * lightweight by default — the core token-cost promise of the crib.
 */
export function llmPointer(read: LlmRead): Record<string, unknown> | undefined {
  if (!read.artifact) return undefined;
  const a = read.artifact.analysis;
  return {
    provenance: 'LLM',
    model: read.artifact.model,
    stale: read.stale,
    confidence: a.confidence,
    purpose: a.purpose ?? '',
  };
}

function validateSaveItem(item: EnrichSaveItem): string | undefined {
  if (!isRecord(item.analysis)) return 'analysis must be an object';
  if (!isRecord(item.graph)) return 'graph must be an object';
  if (!Array.isArray(item.graph.nodes)) return 'graph.nodes must be an array';
  if (!Array.isArray(item.graph.edges)) return 'graph.edges must be an array';
  if (!Array.isArray(item.evidence)) return 'evidence must be an array';
  for (const node of item.graph.nodes) {
    if (!node.localId || !node.kind || !node.name)
      return 'graph.nodes require localId, kind, and name';
  }
  for (const edge of item.graph.edges) {
    if (!edge.from || !edge.to || !edge.rel) return 'graph.edges require from, to, and rel';
    if (edge.confidence !== undefined && (edge.confidence < 0 || edge.confidence > 1)) {
      return 'graph.edge confidence must be between 0 and 1';
    }
  }
  if (
    item.analysis.confidence !== undefined &&
    (item.analysis.confidence < 0 || item.analysis.confidence > 1)
  ) {
    return 'analysis confidence must be between 0 and 1';
  }
  return undefined;
}

function outputSchema(layer: EnrichLayer): Record<string, unknown> {
  return {
    type: 'object',
    required: ['targetId', 'analysis', 'graph', 'evidence'],
    properties: {
      targetId: { type: 'string' },
      model: { type: 'string' },
      analysis: {
        type: 'object',
        required: ['purpose', 'responsibilities', 'confidence'],
        properties: {
          purpose: { type: 'string' },
          responsibilities: { type: 'array', items: { type: 'string' } },
          businessRules: { type: 'array' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      graph: {
        type: 'object',
        required: ['nodes', 'edges'],
        properties: {
          nodes: { type: 'array' },
          edges: { type: 'array' },
        },
      },
      evidence: { type: 'array' },
    },
    additionalProperties: true,
    'x-crib-layer': layer,
  };
}

function instructionsFor(layer: EnrichLayer): string {
  const common =
    'Author detailed analysis plus semantic graph nodes/edges. Ground every claim in seed/lowerLayer evidence. Do not invent code facts. Edges may point only to real soul ids or localIds authored in this item or earlier saved items.';
  if (layer === 'symbol')
    return `${common} Focus on purpose, rules, invariants, IO, side effects, errors, and risks for this symbol.`;
  if (layer === 'file')
    return `${common} Synthesize the file purpose from its symbol analyses and identify feature/capability relationships.`;
  if (layer === 'cluster')
    return `${common} Name the module/cluster and describe responsibilities plus inter-module semantic dependencies.`;
  return `${common} Produce the whole-system bible: architecture, subsystems, cross-cutting flows, glossary, stack, and risk map.`;
}

function artifactPath(
  artifactsRoot: string,
  layer: EnrichLayer,
  targetId: string,
  hash: string,
): string {
  return join(
    artifactsRoot,
    layer,
    shard(targetId),
    `${safeName(targetId)}_${safeName(hash)}.json`,
  );
}

function llmNodeId(targetId: string, localId: string): string {
  return `llm:${targetId}#${localId}`;
}

function shard(id: string): string {
  return blake3Hex(id).slice(0, SHARD_HEX);
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function byId(a: Node, b: Node): number {
  return a.id.localeCompare(b.id);
}

/** Lean overview module shape — picks the fields the overview surfaces from a FunctionalModule
 *  (drops the internal stereotypes/clusterIds/readme the viz consumes directly via its own pass). */
function overviewModule(m: FunctionalModule): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    pathPrefix: m.pathPrefix,
    ...(m.purpose ? { purpose: m.purpose } : {}),
    counts: m.counts,
    coverage: m.coverage,
    topSymbols: m.topSymbols,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Narrows an unknown manifest `lastIssued` value into a typed map, or returns false. */
function presencedLastIssued(v: unknown): v is Record<string, { batchId: string }> {
  if (!isRecord(v)) return false;
  for (const entry of Object.values(v)) {
    if (!isRecord(entry) || typeof entry.batchId !== 'string') return false;
  }
  return true;
}

function estimateWorkItemCost(item: EnrichWorkItem): number {
  return (
    estimateTokens(item.seed) +
    estimateTokens(item.lowerLayer) +
    estimateTokens(item.instructions) +
    estimateTokens(item.outputSchema)
  );
}

function progressFromLayers(layers: Record<EnrichLayer, EnrichLayerCounts>): {
  completed: number;
  pending: number;
  total: number;
} {
  const total = Object.values(layers).reduce((n, l) => n + l.total, 0);
  const pending = Object.values(layers).reduce((n, l) => n + l.missing + l.stale, 0);
  return { completed: total - pending, pending, total };
}

function costFromLayers(layers: Record<EnrichLayer, EnrichLayerCounts>): {
  currency: 'tokens';
  pending: number;
  total: number;
} {
  let pending = 0;
  let total = 0;
  for (const layer of LAYERS) {
    const l = layers[layer];
    const rate = HEURISTIC_TOKENS_PER_LAYER[layer];
    pending += (l.missing + l.stale) * rate;
    total += l.total * rate;
  }
  return { currency: 'tokens', pending, total };
}

function artifactText(artifact: LlmArtifact): string {
  return JSON.stringify({
    analysis: artifact.analysis,
    nodes: artifact.graph.nodes.map((n) => ({ name: n.name, summary: n.summary, kind: n.kind })),
  }).toLowerCase();
}
