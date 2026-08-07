import {
  type ConflictGroup,
  type EffectiveVerdicts,
  type MemoryEvalContext,
  type MemoryEvaluator,
  conflictGroups,
  effectiveVerdicts,
  isRecallEligible,
} from './evaluator.js';
/**
 * W3 Slice 1 — the recall core: a pure join + rank + conflict projection over the three memory
 * stores + the W2 freshness engine. This is the layer the MCP `brief` / `memory_recall` verbs
 * (Slice 3) sit on, and it directly satisfies the W3 exit gate's recall invariants (PRD line 338):
 *
 *   - "normal recall never returns invalid, orphaned, superseded, retracted, or pending records"
 *     → {@link isRecallEligible} is the HARD filter applied before any ranking: `candidate`-trust,
 *       `invalid`/`orphaned`/`needs-review` applicability, `superseded`/`retracted` lifecycle, and
 *       quarantined records are all excluded. Pending (candidate) memory never enters recall.
 *   - "conflicting claims appear together" → {@link conflictGroups} (re-used from the evaluator)
 *       groups ≥2 active records sharing `subject + scope`; ranking never silently picks one.
 *   - "repeat ifHash responses remain below 100 tokens" → the projection is deterministic and
 *       caller-stable (no timestamps/volatile fields), so the verb's `applyIfHash` collapses a
 *       repeat to `{ unchanged: true, hash }` (~30 bytes).
 *
 * Ranking (PRD W3 lines 327–333) is a priority-ordered (lexicographic) comparator, NOT a weighted
 * sum, so the criterion order is honoured exactly:
 *   1. lexical relevance + exact subject/target match  (criterion 1; FTS lexical lands in Slice 2)
 *   2. repo team memory                                 (criterion 2)
 *   3. repo local memory                                (criterion 3)
 *   4. explicit global memory                           (criterion 4)
 *   5. evidence quality (valid > degraded)              (criterion 5)
 *   6. bounded feedback adjustment                      (criterion 6)
 * with `createdAt` descending as the stable final tiebreaker (preserves W2 `rankRecall` behaviour).
 *
 * PURE over the gathered entries + an optional {@link MemoryEvaluator} context + an optional
 * {@link LexicalScorer}: no IO of its own. {@link gatherRecall} performs the (sync) store reads and
 * id-prefix narrowing; {@link recallProjection} is the pure rank/conflict step. The two-step split
 * keeps the ranking logic unit-testable without constructing real stores (mirroring the evaluator's
 * "pure over ports" discipline).
 */
import type { MemoryStore } from './store.js';
import type { MemoryDecision, MemoryEntry, MemoryFeedback, MemoryRecord } from './types.js';

// ─── sources ─────────────────────────────────────────────────────────────────

/** Which store a gathered record came from. Drives ranking criteria 2–4 (team > local > global). */
export type MemorySource = 'team' | 'local' | 'global';

/** A record tagged with the store it was gathered from. */
export interface TaggedRecord {
  record: MemoryRecord;
  source: MemorySource;
}

// ─── lexical scoring (criterion 1) ───────────────────────────────────────────

/**
 * Scores a record's lexical + exact-match relevance to a query / set of target ids (PRD criterion 1).
 * Higher = more relevant. Slice 1 ships {@link exactLexicalScorer} (exact subject/target match only);
 * Slice 2 supplies an FTS5-BM25-backed scorer that adds lexical relevance for non-exact matches. The
 * scorer is a port so the recall core stays SQLite-free and unit-testable in isolation.
 */
export interface LexicalScorer {
  score(record: MemoryRecord, query: string, targetIds: readonly string[]): number;
}

/** Exact-match bonus large enough to dominate any realistic FTS5 BM25 score (BM25 is O(1–10)). */
export const EXACT_MATCH_BONUS = 1_000_000;

/**
 * The default (Slice 1) lexical scorer: exact subject/target match only, no fuzzy/FTS relevance.
 * A record scores {@link EXACT_MATCH_BONUS} iff its `subject` equals the query or a requested target,
 * or any of its `appliesTo` targets is requested. The count of matched `appliesTo` targets is added
 * as a fine-grained tiebreak among exact matches (0..N). Non-matching records score 0.
 */
export function exactLexicalScorer(
  record: MemoryRecord,
  query: string,
  targetIds: readonly string[],
): number {
  const targets = new Set(targetIds);
  const subjectExact =
    (query.length > 0 && record.subject === query) || targets.has(record.subject);
  let matchedTargets = 0;
  for (const a of record.appliesTo) {
    if (targets.has(a)) matchedTargets += 1;
  }
  const targetExact = matchedTargets > 0;
  if (!subjectExact && !targetExact) return 0;
  return EXACT_MATCH_BONUS + matchedTargets;
}

// ─── feedback adjustment (criterion 6) ───────────────────────────────────────

/** The bound on the feedback adjustment (PRD: "bounded feedback adjustment"). One negative event
 *  cannot retract team memory — feedback only nudges ranking within this bound, never eligibility. */
export const DEFAULT_FEEDBACK_BOUND = 3;

/** `useful` = +1; `unhelpful` / `contradicted` = -1. Bounded to ±{@link DEFAULT_FEEDBACK_BOUND}. */
function feedbackWeight(signal: MemoryFeedback['signal']): number {
  return signal === 'useful' ? 1 : -1;
}

/** Sum the bounded feedback adjustment for a record id from a per-id net-feedback map. */
function feedbackAdjust(
  recordId: string,
  netFeedback: ReadonlyMap<string, number>,
  bound: number,
): number {
  const raw = netFeedback.get(recordId);
  if (raw === undefined) return 0;
  return Math.max(-bound, Math.min(bound, raw));
}

// ─── the recall score ────────────────────────────────────────────────────────

/** Source-tier ranking weight (PRD criteria 2–4): team > local > global. */
function sourceTier(source: MemorySource): number {
  return source === 'team' ? 3 : source === 'local' ? 2 : 1;
}

/** Evidence-quality weight (PRD criterion 5): valid > degraded. Eligibility already excluded invalid. */
function evidenceQuality(v: EffectiveVerdicts): number {
  return v.evidence === 'valid' ? 2 : 1;
}

/** The per-record ranking tuple (priority-ordered, NOT a weighted sum). */
export interface RecallScore {
  /** criterion 1: lexical + exact subject/target match. */
  lexical: number;
  /** criteria 2–4: team=3, local=2, global=1. */
  sourceTier: number;
  /** criterion 5: valid=2, degraded=1. */
  evidenceQuality: number;
  /** criterion 6: bounded net feedback, ±bound. */
  feedbackAdjust: number;
}

/** A recall-eligible record, ranked, with its effective verdicts + score + source. */
export interface ScoredRecord {
  record: MemoryRecord;
  source: MemorySource;
  verdicts: EffectiveVerdicts;
  score: RecallScore;
}

// ─── provenance ──────────────────────────────────────────────────────────────

/** Deterministic provenance for a projection (no timestamps → ifHash-stable). */
export interface RecallProvenance {
  sources: readonly MemorySource[];
  counts: {
    team: number;
    local: number;
    global: number;
    /** total records considered before eligibility filtering. */
    considered: number;
    /** records that passed {@link isRecallEligible}. */
    eligible: number;
    /** conflict groups (≥2 active records sharing subject + scope). */
    conflicts: number;
  };
  /** true iff a {@link MemoryEvaluator} revalidation was run (fresh verdicts vs stamped). */
  fresh: boolean;
}

/** The recall projection: ranked eligible memories + conflict groups + provenance. */
export interface RecallProjection {
  memories: ScoredRecord[];
  conflicts: ConflictGroup[];
  provenance: RecallProvenance;
}

// ─── gathering (the only IO step) ────────────────────────────────────────────

/** The three stores, any of which may be absent (e.g. a fresh repo has no local store yet). */
export interface RecallStores {
  team?: MemoryStore;
  local?: MemoryStore;
  global?: MemoryStore;
}

/** What {@link gatherRecall} collected from the stores, plus any per-shard read errors. */
export interface GatheredRecall {
  records: TaggedRecord[];
  decisions: MemoryDecision[];
  feedback: MemoryFeedback[];
  errors: string[];
}

// ─── id-prefix narrowing ─────────────────────────────────────────────────────
//
// `readCollection` returns the `MemoryEntry` union (a JSONL shard could in principle hold any line
// kind). The collection determines the intended kind, but a corrupt/mis-sharded line would slip
// through as the wrong shape, so narrow by the content-addressed id prefix and discard mismatches
// (recording a per-shard error rather than crashing the whole recall). The store validates on write
// (W2), so in practice every line matches; the guards are defensive.

function isRecordEntry(e: MemoryEntry): e is MemoryRecord {
  return typeof (e as MemoryRecord).id === 'string' && (e as MemoryRecord).id.startsWith('mem:');
}
function isDecisionEntry(e: MemoryEntry): e is MemoryDecision {
  return (
    typeof (e as MemoryDecision).id === 'string' && (e as MemoryDecision).id.startsWith('dec:')
  );
}
function isFeedbackEntry(e: MemoryEntry): e is MemoryFeedback {
  return typeof (e as MemoryFeedback).id === 'string' && (e as MemoryFeedback).id.startsWith('fb:');
}

/** Default sources gathered when no `sources` filter is supplied: all three stores. */
export const DEFAULT_RECALL_SOURCES: readonly MemorySource[] = ['team', 'local', 'global'];

/**
 * Gather records + decisions + feedback from the requested stores. Reads are sync + lock-free
 * (`MemoryStore.readCollection`). Records come from `team.records` + `local.active` + `global.records`;
 * decisions from `team.decisions` + `global.decisions` ONLY; feedback from `local.feedback`
 * + `global.feedback` (team has none). Each record is tagged with its source for ranking.
 *
 * **Local decisions are deliberately NOT gathered** (W5 Slice 2 no-poison rule): a local tombstone is a
 * `supersede` decision whose `subject` is the record id — the SAME id as the team record that promoted
 * it. {@link effectiveVerdicts} matches decisions by `subject === record.id` and treats `supersede` as
 * terminal, so gathering local tombstones would mark the same-id team record `superseded` and drop it
 * from recall. Local decisions are audit-only (read by `crib memory audit`); they never enter the recall
 * decision pool. See `tombstone.ts`.
 */
export function gatherRecall(
  stores: RecallStores,
  opts: { sources?: readonly MemorySource[] } = {},
): GatheredRecall {
  const sources = opts.sources ?? DEFAULT_RECALL_SOURCES;
  const records: TaggedRecord[] = [];
  const decisions: MemoryDecision[] = [];
  const feedback: MemoryFeedback[] = [];
  const errors: string[] = [];

  const want = (s: MemorySource): boolean => sources.includes(s);

  if (want('team') && stores.team) {
    const r = stores.team.readCollection('records');
    for (const e of r.entries) {
      if (isRecordEntry(e)) records.push({ record: e, source: 'team' });
      else errors.push(`team.records: non-record entry ${String(e?.id)}`);
    }
    errors.push(...r.errors);
    const d = stores.team.readCollection('decisions');
    for (const e of d.entries) {
      if (isDecisionEntry(e)) decisions.push(e);
      else errors.push(`team.decisions: non-decision entry ${String(e?.id)}`);
    }
    errors.push(...d.errors);
  }

  if (want('local') && stores.local) {
    const r = stores.local.readCollection('active');
    for (const e of r.entries) {
      if (isRecordEntry(e)) records.push({ record: e, source: 'local' });
      else errors.push(`local.active: non-record entry ${String(e?.id)}`);
    }
    errors.push(...r.errors);
    const f = stores.local.readCollection('feedback');
    for (const e of f.entries) {
      if (isFeedbackEntry(e)) feedback.push(e);
      else errors.push(`local.feedback: non-feedback entry ${String(e?.id)}`);
    }
    errors.push(...f.errors);
  }

  if (want('global') && stores.global) {
    const r = stores.global.readCollection('records');
    for (const e of r.entries) {
      if (isRecordEntry(e)) records.push({ record: e, source: 'global' });
      else errors.push(`global.records: non-record entry ${String(e?.id)}`);
    }
    errors.push(...r.errors);
    const d = stores.global.readCollection('decisions');
    for (const e of d.entries) {
      if (isDecisionEntry(e)) decisions.push(e);
      else errors.push(`global.decisions: non-decision entry ${String(e?.id)}`);
    }
    errors.push(...d.errors);
    const f = stores.global.readCollection('feedback');
    for (const e of f.entries) {
      if (isFeedbackEntry(e)) feedback.push(e);
      else errors.push(`global.feedback: non-feedback entry ${String(e?.id)}`);
    }
    errors.push(...f.errors);
  }

  return { records, decisions, feedback, errors };
}

// ─── the pure projection ─────────────────────────────────────────────────────

export interface RecallOptions {
  /** the recall query (criterion 1 exact subject match); empty string = no query. */
  query?: string;
  /** soul ids / paths / subject keys to exact-match against (criterion 1 target match). */
  targetIds?: readonly string[];
  /** lexical scorer; defaults to {@link exactLexicalScorer} (Slice 2 plugs in FTS). */
  lexicalScorer?: LexicalScorer;
  /** if supplied with `evalCtx`, revalidate each record fresh against the live soul (W2 engine). */
  evaluator?: MemoryEvaluator;
  evalCtx?: MemoryEvalContext;
  /** feedback bound (criterion 6); defaults to {@link DEFAULT_FEEDBACK_BOUND}. */
  feedbackBound?: number;
}

/**
 * The pure recall projection: effective verdicts → hard eligibility filter → 6-criterion rank →
 * conflict groups → deterministic provenance. The memories array is sorted best-first; conflicts
 * surface every active record sharing a `subject + scope` (no silent pick). See the module header
 * for the exit-gate invariants this enforces.
 */
export function recallProjection(
  gathered: GatheredRecall,
  opts: RecallOptions = {},
): RecallProjection {
  const query = opts.query ?? '';
  const targetIds = opts.targetIds ?? [];
  // Normalize the scorer: a supplied LexicalScorer (object with `.score`) vs the default free
  // function. A bare `??` would union the two into a non-callable type, so collapse to one shape.
  const lexical = opts.lexicalScorer;
  const scoreRecord = (r: MemoryRecord, q: string, t: readonly string[]): number =>
    lexical ? lexical.score(r, q, t) : exactLexicalScorer(r, q, t);
  const bound = opts.feedbackBound ?? DEFAULT_FEEDBACK_BOUND;
  const fresh = opts.evaluator !== undefined && opts.evalCtx !== undefined;

  // Pre-aggregate net feedback per record id (criterion 6), bounded at read time.
  const netFeedback = new Map<string, number>();
  for (const fb of gathered.feedback) {
    const prev = netFeedback.get(fb.subject) ?? 0;
    netFeedback.set(fb.subject, prev + feedbackWeight(fb.signal));
  }

  const consideredBySource = { team: 0, local: 0, global: 0 };
  const eligibleEntries: {
    record: MemoryRecord;
    verdicts: EffectiveVerdicts;
    source: MemorySource;
  }[] = [];

  for (const { record, source } of gathered.records) {
    consideredBySource[source] += 1;
    const evaluation =
      fresh && opts.evaluator && opts.evalCtx
        ? opts.evaluator.evaluate(record, opts.evalCtx)
        : undefined;
    const verdicts = effectiveVerdicts(record, gathered.decisions, evaluation);
    if (!isRecallEligible(verdicts)) continue;
    eligibleEntries.push({ record, verdicts, source });
  }

  const memories: ScoredRecord[] = eligibleEntries.map(({ record, verdicts, source }) => ({
    record,
    source,
    verdicts,
    score: {
      lexical: scoreRecord(record, query, targetIds),
      sourceTier: sourceTier(source),
      evidenceQuality: evidenceQuality(verdicts),
      feedbackAdjust: feedbackAdjust(record.id, netFeedback, bound),
    },
  }));

  // Priority-ordered (lexicographic) comparator — criterion 1 → 6, then newest-first tiebreak.
  memories.sort((a, b) => {
    if (b.score.lexical !== a.score.lexical) return b.score.lexical - a.score.lexical;
    if (b.score.sourceTier !== a.score.sourceTier) return b.score.sourceTier - a.score.sourceTier;
    if (b.score.evidenceQuality !== a.score.evidenceQuality)
      return b.score.evidenceQuality - a.score.evidenceQuality;
    if (b.score.feedbackAdjust !== a.score.feedbackAdjust)
      return b.score.feedbackAdjust - a.score.feedbackAdjust;
    return b.record.createdAt.localeCompare(a.record.createdAt);
  });

  const conflicts = conflictGroups(eligibleEntries);

  const sourcesPresent: MemorySource[] = [];
  if (consideredBySource.team > 0) sourcesPresent.push('team');
  if (consideredBySource.local > 0) sourcesPresent.push('local');
  if (consideredBySource.global > 0) sourcesPresent.push('global');

  const provenance: RecallProvenance = {
    sources: sourcesPresent,
    counts: {
      team: consideredBySource.team,
      local: consideredBySource.local,
      global: consideredBySource.global,
      considered: gathered.records.length,
      eligible: memories.length,
      conflicts: conflicts.length,
    },
    fresh,
  };

  return { memories, conflicts, provenance };
}

/**
 * The hard eligibility filter applied before ranking (re-exported for verb/CLI convenience so callers
 * do not need to import the evaluator directly to test a single verdict). PRD line 338 invariant #1.
 */
export { isRecallEligible };

/** Re-exported so callers of {@link recallProjection} can type the `conflicts` field without importing
 *  the evaluator directly. */
export type { ConflictGroup };
