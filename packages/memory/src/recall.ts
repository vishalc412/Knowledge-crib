import { bridgedDecisions, buildAliasIndex, conservativeVerdicts } from './aliases.js';
import {
  type ConflictGroup,
  type EffectiveVerdicts,
  type MemoryEvalContext,
  type MemoryEvaluator,
  conflictGroups,
  effectiveVerdicts,
  isRecallEligible,
  recordSortTime,
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
import type {
  MemoryAlias,
  MemoryDecision,
  MemoryEntry,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordV2,
} from './types.js';
import { isMemoryRecordV2 } from './types.js';

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
  /**
   * G3.2 (red line #6) — the ranking-version id naming the configuration that produced the order
   * (embedder id + scorer version + fusion strategy). OPTIONAL: the built-in exact scorer has no
   * configuration to name. When present, the projection carries it on provenance (`scorerVersion`)
   * so every search/recall answer is traceable to the ranking that produced it.
   */
  readonly versionId?: string;
}

/** Exact-match bonus large enough to dominate any realistic FTS5 BM25 score (BM25 is O(1–10)). */
export const EXACT_MATCH_BONUS = 1_000_000;

/**
 * The default (Slice 1) lexical scorer: exact subject/target match only, no fuzzy/FTS relevance.
 * A record scores {@link EXACT_MATCH_BONUS} iff its `subject` equals the query or a requested target,
 * or any of its `appliesTo` targets is requested. The count of matched `appliesTo` targets is added
 * as a fine-grained tiebreak among exact matches (0..N). Non-matching records score 0.
 *
 * Accepts both record versions (memory-2 has no `appliesTo`; a v2 record can still exact-match on
 * `subject`, and the guard keeps the scorer crash-free on a mixed-version gather).
 */
export function exactLexicalScorer(
  record: MemoryRecord | MemoryRecordV2,
  query: string,
  targetIds: readonly string[],
): number {
  const targets = new Set(targetIds);
  const subjectExact =
    (query.length > 0 && record.subject === query) || targets.has(record.subject);
  const appliesTo = isMemoryRecordV2(record) ? [] : record.appliesTo;
  let matchedTargets = 0;
  for (const a of appliesTo) {
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
  /**
   * G3.2 (red line #6) — the versioned scorer id (embedder + scorer version + fusion strategy) the
   * criterion-1 lexical order was produced under, when the supplied scorer names one. Absent for
   * the built-in exact scorer. Deterministic (a config fingerprint, never a clock) → ifHash-stable.
   */
  scorerVersion?: string;
  /**
   * G3.3 — the dependency-generation fingerprint the fresh verdicts in this projection were proven
   * current against, attached by callers that bind a generation-keyed evaluation pass (the shared
   * `bindEvaluationPass`); null when no versioned dependency could be fingerprinted. Absent when no
   * binding was attempted (stamped-verdict reads). Deterministic → ifHash-stable.
   */
  generation?: string | null;
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
  /** team + global decisions (authoritative across stores — these apply to EVERY record). */
  decisions: MemoryDecision[];
  /**
   * LOCAL decisions (W5 Slice 3). These apply to LOCAL records ONLY — {@link recallProjection} folds
   * them into a local record's effective verdicts but NEVER into a team/global record's. This is the
   * no-poison rule: a local quarantine / tombstone decision shares its `subject` id with the team
   * record that promoted the same content, so applying it to the team record would drop team memory
   * on a single local negative event (PRD line 242: "one negative event cannot retract team memory").
   * Local decisions are gathered (so a local quarantine CAN suppress its own local record — PRD W5
   * line 361) but scoped to local-sourced records at the {@link effectiveVerdicts} call site.
   */
  localDecisions: MemoryDecision[];
  feedback: MemoryFeedback[];
  /**
   * The legacy-ID alias map (G1.2), gathered from every requested store's `<rootDir>/aliases`
   * shards. OPTIONAL so a store with no migration history (every pre-G1.2 store, and the literal
   * builders in recall.test.ts) projects identically. Lets a decision/feedback keyed on a v1 id keep
   * attaching to the migrated v2 record that now owns the claim, and restores the v1 verdicts the
   * migration carried in the alias snapshot (without them a migrated record would project as
   * `candidate`-trust and silently vanish from recall).
   */
  aliases?: readonly MemoryAlias[];
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
 * team/global decisions go into `decisions` (authoritative across stores); LOCAL decisions go into
 * `localDecisions` (apply to LOCAL records only — see {@link GatheredRecall.localDecisions}); feedback
 * from `local.feedback` + `global.feedback` (team has none). Each record is tagged with its source.
 *
 * **The no-poison rule (W5 Slice 2 + Slice 3).** A local tombstone (supersede) or a local
 * contradicted-feedback quarantine is a decision whose `subject` is the record id — the SAME id as the
 * team record that promoted the same content. {@link effectiveVerdicts} matches decisions by
 * `subject === record.id` and treats `supersede`/`quarantine` as terminal/excluding, so applying a
 * local decision to the same-id team record would drop team memory on a single local negative event
 * (PRD line 242: "one negative event cannot retract team memory"). Local decisions are therefore
 * gathered SEPARATELY and {@link recallProjection} folds them into a record's effective verdicts ONLY
 * when that record's source is `local` — team/global records see team/global decisions alone. This
 * lets a local quarantine suppress its own local record (PRD W5 line 361) without poisoning team trust.
 */
export function gatherRecall(
  stores: RecallStores,
  opts: { sources?: readonly MemorySource[] } = {},
): GatheredRecall {
  const sources = opts.sources ?? DEFAULT_RECALL_SOURCES;
  const records: TaggedRecord[] = [];
  const decisions: MemoryDecision[] = [];
  const localDecisions: MemoryDecision[] = [];
  const feedback: MemoryFeedback[] = [];
  const errors: string[] = [];
  const aliases: MemoryAlias[] = [];

  const want = (s: MemorySource): boolean => sources.includes(s);
  // Alias reads are fail-closed in the store (a corrupt map means a moved seed); recall records the
  // failure and degrades to the un-aliased projection rather than crashing the whole verb — the v1
  // records still rank, the migrated twins simply stay un-bridged.
  const gatherAliases = (source: MemorySource, store: MemoryStore): void => {
    try {
      aliases.push(...store.readAliases());
    } catch (err) {
      errors.push(`${source}.aliases: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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
    gatherAliases('team', stores.team);
  }

  if (want('local') && stores.local) {
    const r = stores.local.readCollection('active');
    for (const e of r.entries) {
      if (isRecordEntry(e)) records.push({ record: e, source: 'local' });
      else errors.push(`local.active: non-record entry ${String(e?.id)}`);
    }
    errors.push(...r.errors);
    // W5 Slice 3: gather local decisions into their own pool (apply to local records only — no-poison).
    const d = stores.local.readCollection('decisions');
    for (const e of d.entries) {
      if (isDecisionEntry(e)) localDecisions.push(e);
      else errors.push(`local.decisions: non-decision entry ${String(e?.id)}`);
    }
    errors.push(...d.errors);
    const f = stores.local.readCollection('feedback');
    for (const e of f.entries) {
      if (isFeedbackEntry(e)) feedback.push(e);
      else errors.push(`local.feedback: non-feedback entry ${String(e?.id)}`);
    }
    errors.push(...f.errors);
    gatherAliases('local', stores.local);
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
    gatherAliases('global', stores.global);
  }

  return { records, decisions, localDecisions, feedback, aliases, errors };
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

  // The legacy-ID alias index (G1.2). Throws AliasConflictError if a committed alias map binds one
  // legacy id to two different resolved ids (a moved seed) — recall refuses rather than silently
  // picking a twin. Over an absent/empty map every alias read is `undefined` and the projection is
  // byte-identical to the pre-G1.2 behaviour.
  const aliasIndex = buildAliasIndex(gathered.aliases ?? []);

  // Pre-aggregate net feedback per record id (criterion 6), bounded at read time. A feedback event
  // keyed on a LEGACY id is ADDITIVELY double-keyed under the resolved id (the original key stays,
  // so a retained v1 line — team — keeps its own adjustment); the on-disk line is never rewritten.
  const netFeedback = new Map<string, number>();
  const addFeedback = (subject: string, signal: MemoryFeedback['signal']): void => {
    netFeedback.set(subject, (netFeedback.get(subject) ?? 0) + feedbackWeight(signal));
  };
  for (const fb of gathered.feedback) {
    addFeedback(fb.subject, fb.signal);
    const resolved = aliasIndex.resolve(fb.subject);
    if (resolved !== undefined && resolved !== fb.subject) addFeedback(resolved, fb.signal);
  }

  const consideredBySource = { team: 0, local: 0, global: 0 };
  const eligibleEntries: {
    record: MemoryRecord;
    verdicts: EffectiveVerdicts;
    source: MemorySource;
  }[] = [];
  // Every considered record with its effective verdicts — the input to conflict detection. v1
  // eligibility filtering happens INSIDE conflictGroups (unchanged semantics); memory-2 records are
  // rank-ineligible in the v1 projection but still conflict-visible (G1.1), so they must reach it.
  const consideredEntries: {
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
    // No-poison (W5 Slice 2 + 3): local decisions overlay LOCAL records only; team/global decisions
    // are authoritative across stores (a team supersede/quarantine of an id correctly retires the
    // same-id local copy too). Folding local decisions into a team/global record would let a single
    // local negative event retract team memory (PRD line 242).
    const decs =
      source === 'local' ? [...gathered.decisions, ...gathered.localDecisions] : gathered.decisions;
    // G1.2 legacy-ID bridge: a migrated v2 record adopts the CONSERVATIVE verdict snapshot of every
    // alias bound to it (the worst axis across collapsed v1 siblings — the v2 seed excludes
    // authorship/scope, so two v1 records of one claim can share a twin; a last-wins pick could
    // wash out a demoted sibling or resurface a quarantined one) and inherits decision events keyed
    // on ANY bound legacy id as in-memory copies re-subjected to the v2 id — the same multi-alias
    // rule the feedback bridge above already uses. Both bridges are ADDITIVE: the original lines
    // stay, and with no bound aliases (a fresh v2 observation, or a store with no migration
    // history) the calls are exact no-ops.
    // Widen before the version guard: TaggedRecord.record is typed memory-1 (the v1 read model's
    // record), so narrowing it with isMemoryRecordV2 would intersect to `never` — the guard is
    // honest over the union the store can actually hand back.
    const asVersioned: MemoryRecord | MemoryRecordV2 = record;
    const boundAliases = isMemoryRecordV2(asVersioned) ? aliasIndex.aliasesFor(record.id) : [];
    const recordDecs =
      boundAliases.length > 0 ? bridgedDecisions(boundAliases, record.id, decs) : decs;
    const verdicts = effectiveVerdicts(
      record,
      recordDecs,
      evaluation,
      conservativeVerdicts(boundAliases),
    );
    consideredEntries.push({ record, verdicts, source });
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
    return recordSortTime(b.record).localeCompare(recordSortTime(a.record));
  });

  // Conflict detection over every considered record: v1 groups keep their eligibility filter inside
  // conflictGroups; memory-2 records participate via propositionKey + explicit contradicts lineage
  // (G1.1) even though they are not yet ranked in the v1 read projection.
  const conflicts = conflictGroups(consideredEntries);

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
    // Red line #6 — carry the scorer's configuration id when the caller supplied a versioned one
    // (the built-in exact scorer names nothing and stays field-absent, byte-identical responses).
    ...(lexical?.versionId !== undefined ? { scorerVersion: lexical.versionId } : {}),
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
