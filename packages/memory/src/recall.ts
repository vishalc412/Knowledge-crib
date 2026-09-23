import { bridgedDecisions, buildAliasIndex, conservativeVerdicts } from './aliases.js';
import {
  type ConflictGroup,
  type DecisionsBySubject,
  type EffectiveVerdicts,
  type MemoryEvalContext,
  type MemoryEvaluator,
  type RecallExclusionClause,
  conflictGroups,
  effectiveVerdicts,
  indexDecisionsBySubject,
  isRecallEligible,
  recallExclusionClause,
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
import { DEFAULT_MIGRATION_PRINCIPAL_ID } from './migrations.js';
import type { MemoryStore } from './store.js';
import type {
  MemoryAlias,
  MemoryDecision,
  MemoryEntry,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordVersioned,
} from './types.js';
import { isMemoryRecordVersioned } from './types.js';

// ─── sources ─────────────────────────────────────────────────────────────────

/** Which store a gathered record came from. Drives ranking criteria 2–4 (team > local > global). */
export type MemorySource = 'team' | 'local' | 'global';

/** A record tagged with the store it was gathered from. */
export interface TaggedRecord {
  record: MemoryRecord | MemoryRecordVersioned;
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
  score(
    record: MemoryRecord | MemoryRecordVersioned,
    query: string,
    targetIds: readonly string[],
  ): number;
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
  record: MemoryRecord | MemoryRecordVersioned,
  query: string,
  targetIds: readonly string[],
): number {
  const targets = new Set(targetIds);
  const subjectExact =
    (query.length > 0 && record.subject === query) || targets.has(record.subject);
  const appliesTo = isMemoryRecordVersioned(record) ? [] : record.appliesTo;
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
  record: MemoryRecord | MemoryRecordVersioned;
  source: MemorySource;
  verdicts: EffectiveVerdicts;
  score: RecallScore;
  /**
   * R02 — was THIS record revalidated against the live world during this projection, or are its
   * verdicts the stamped/snapshotted ones? Per-record, because a pass-level "an evaluator was
   * supplied" flag is not evidence that any particular record went through it. The serving layer
   * reports freshness from this, so a record the evaluator skipped can never be advertised as
   * freshly validated.
   */
  evaluated: boolean;
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

/**
 * WP5 §7.2 — a record that was GATHERED and then dropped by the hard eligibility filter, with the one
 * clause that dropped it.
 *
 * Why this exists: `provenance.counts` reports `considered: 8` beside `eligible: 3` and stops there.
 * Five records disappear from the answer with no account of themselves, and the operator's only
 * recourse is to read the stores by hand — which is precisely the U1 failure (exclusion reasons are
 * computed, then discarded at the API boundary). These rows are the account.
 *
 * `excludedBy` is the FIRST failing clause, derived by {@link recallExclusionClause} — the same walk
 * {@link isRecallEligible} is defined by, so the label cannot disagree with the decision that
 * produced it. `verdicts` is carried whole (not just the failing axis) because it also carries
 * `reasons`: "dropped for `evidence`" is a fact, and *which evidence item stopped grounding* is the
 * explanation, in the evaluator's own vocabulary.
 */
export interface RecallExclusion {
  id: string;
  claim: string;
  source: MemorySource;
  /** the effective verdicts the decision was made on — including `reasons` when a pass ran. */
  verdicts: EffectiveVerdicts;
  /** which predicate clause excluded it — derived from verdicts, never re-implemented. */
  excludedBy: RecallExclusionClause;
}

/** The recall projection: ranked eligible memories + conflict groups + provenance. */
export interface RecallProjection {
  memories: ScoredRecord[];
  conflicts: ConflictGroup[];
  /**
   * WP5 §7.2 — every gathered record the eligibility filter dropped, one row per record, each named
   * with the clause that dropped it. REQUIRED rather than optional: an absent field would be
   * indistinguishable from "nothing was excluded", which is the confusion this list exists to end —
   * so a caller building a projection by hand must say `[]` and mean it.
   *
   * Ordering is `(id, source)` ascending, NOT gather order, for the same reason the ranking is a
   * defined comparator: this is a diagnostic surface a human reads, and gather order shifts with the
   * set of stores present, so an unrelated change (a global store appearing) would silently reorder
   * the panel. Deterministic → ifHash-stable.
   */
  excluded: RecallExclusion[];
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
  /**
   * G7 — the principal boundary (launch gate "unauthorised cross-principal results = 0"). The
   * resolved caller principal every accepted record was scoped against, and the count of records
   * that carried a DIFFERENT principal stamp and were excluded at this merge point (fail-closed).
   * Both OPTIONAL so the pure literal builders in tests project identically.
   */
  principal?: string;
  principalExcluded?: number;
}

// ─── the principal boundary (G7) ─────────────────────────────────────────────

/**
 * The principal identity a record carries, or `undefined` when it carries none. Only memory-2
 * records carry one (`provenance.principalId`); a memory-1 record has NO principal column. The
 * parameter takes the version UNION (not the v1 read model alone) so the guard narrows a real
 * union instead of intersecting `MemoryRecord` with `MemoryRecordV2` down to `never` — the same
 * reason {@link recallProjection} widens its gathered record before guarding.
 */
function recordPrincipalId(record: MemoryRecord | MemoryRecordVersioned): string | undefined {
  return isMemoryRecordVersioned(record) ? record.provenance.principalId : undefined;
}

/**
 * Resolve the caller's principal for a gather. An explicit option wins (tests / a serving layer
 * that resolves identity itself); otherwise the same ownership default the migration and sync
 * staging paths stamp — `KCRIB_PRINCIPAL_ID` env, then `'principal:local'` — so every record this
 * device wrote under the default matches its own reader and the single-principal path is
 * byte-unchanged. A blank identity is not an identity: it falls back to the default rather than
 * disabling the boundary.
 */
function resolveCallerPrincipal(opts: GatherRecallOptions): string {
  const env = opts.env ?? process.env;
  const resolved = opts.principal ?? env.KCRIB_PRINCIPAL_ID ?? DEFAULT_MIGRATION_PRINCIPAL_ID;
  return resolved.trim().length === 0 ? DEFAULT_MIGRATION_PRINCIPAL_ID : resolved;
}

/**
 * The env switch that ENGAGES the strict principal boundary at the private stores. Off unless set
 * truthy — see {@link resolveStrictPrincipal} for why, measured.
 */
export const STRICT_PRINCIPAL_ENV = 'KCRIB_STRICT_PRINCIPAL';

/**
 * Resolve whether a production gather runs strict, from the environment. This is WP1 item 13's
 * "resolve the default of `strictPrincipal`" half; the "pass it explicitly at the production
 * gathers" half is every call site calling this function rather than hardcoding either value.
 *
 * §14 D-2 posed the choice as: flip it on by default, at the cost of "a one-time visibility change
 * for users who never set `KCRIB_PRINCIPAL_ID`", or ship it behind an explicit opt-in. **The
 * implementation round MEASURED the first branch's cost model and found it wrong in KIND.** It is
 * not a one-time visibility change; it is a permanent blackout of every record this device writes:
 *
 *   - Local admission (`admitGrounded` → `buildRecord`, auto-admit.ts) mints a MEMORY-1 record.
 *     Memory-1 carries no ownership column at all (`MemoryRecord`, types.ts), so a strict gather
 *     refuses it. Measured on the live MCP write path: `memoryObserve` writes one record, then
 *     `gatherRecall({strictPrincipal: true})` returns `[]` while the permissive gather returns that
 *     same `mem:` id. Six MCP tests across four files failed on exactly this and no other cause.
 *   - Memory-2 is not a way out. `MemoryRecordV2` has no `verdicts` field, so `effectiveVerdicts`
 *     (evaluator.ts) projects a NATIVE v2 record at `candidate` trust and `isRecallEligible` drops
 *     it; only the alias snapshot `migrateToV2` writes makes a twin rankable at all.
 *   - So `crib memory migrate` (item 12) can never reach a steady state: it stamps what exists, and
 *     the very next `memory_observe` mints a fresh unstamped record. The doctor's
 *     "principal boundary enforceable" check would flap red forever after each write.
 *
 * On that evidence the honest branch is D-2's SECOND: the boundary stays implemented, reachable from
 * production and tested THROUGH a production surface with this switch engaged, but it is not
 * silently on. Closing D3-a by default is handed back to the principal, blocked on a native
 * memory-2 LOCAL write path that no work package in `developer-trust-plan.md` covers.
 *
 * Both the gather's default and every production call site resolve through here, deliberately: the
 * default means a NEW production surface cannot silently reopen the hole by omitting the option, and
 * the explicit call site is what a reader sees when asking "is this merge point scoped?".
 *
 * Truthy = `1` / `true` / `yes`, trimmed and case-insensitive. Anything else, including unset, is off.
 */
export function resolveStrictPrincipal(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[STRICT_PRINCIPAL_ENV];
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

// ─── id-prefix narrowing ─────────────────────────────────────────────────────
//
// `readCollection` returns the `MemoryEntry` union (a JSONL shard could in principle hold any line
// kind). The collection determines the intended kind, but a corrupt/mis-sharded line would slip
// through as the wrong shape, so narrow by the content-addressed id prefix and discard mismatches
// (recording a per-shard error rather than crashing the whole recall). The store validates on write
// (W2), so in practice every line matches; the guards are defensive.

function isRecordEntry(e: MemoryEntry): e is MemoryRecord | MemoryRecordVersioned {
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

/** Options for {@link gatherRecall}. */
export interface GatherRecallOptions {
  /** which stores to gather; defaults to {@link DEFAULT_RECALL_SOURCES}. */
  sources?: readonly MemorySource[];
  /**
   * G7 — the caller's principal. When absent it resolves to `KCRIB_PRINCIPAL_ID` env, then
   * `'principal:local'` (see {@link resolveCallerPrincipal}). Any record carrying a principal stamp
   * that is NOT the caller's never enters the gathered pool.
   *
   * NOTE the limit, precisely: memory-1 records carry NO principal stamp, so this filter cannot
   * exclude them — see {@link strictPrincipal}.
   */
  principal?: string;
  /**
   * Exclude records that carry NO principal stamp at all (every memory-1 record) from the PRIVATE
   * stores — `local` and `global`.
   *
   * When omitted it resolves through {@link resolveStrictPrincipal} — the `KCRIB_STRICT_PRINCIPAL`
   * opt-in, OFF by default — so a production surface that forgets the option does not silently
   * reopen the hole, and a test that forgets it is not silently scoped. Read that function for the
   * measured reason strict is not the default: the local admission path writes memory-1, which
   * carries no ownership column, so a strict gather refuses every record this device writes and
   * `crib memory migrate` can never catch up. §14 D-2 priced that as a one-time visibility change;
   * it is a permanent blackout.
   *
   * Set it explicitly `true` where store sets from more than one principal can meet (a cross-device
   * pull, a shared daemon, a multi-principal audit). There, "unstamped" means "owner unknown", and an
   * unknown owner must not be treated as the caller. Measured before it existed: gathering principal
   * A's team store together with principal B's local store returned all 15 of B's memory-1 records
   * to A. It stays `true` for tests of the boundary itself.
   *
   * **It does NOT exclude unstamped TEAM records, and that is not an oversight.** The team ledger is
   * committed and append-only, so `migrateToV2` can never stamp a memory-1 line in it — measured, not
   * assumed (WP1 item 12: a team migration reports `retained: 1`, writes an alias, and leaves
   * `schemaVersion: '1'` with no `provenance` on disk). Excluding them would therefore remove shared
   * team memory from recall PERMANENTLY, with no repair available, and it would buy no confidentiality
   * either: a team record is a file in the repository, readable by anyone who can read the repo. The
   * boundary protects private records, which is exactly what it scopes.
   */
  strictPrincipal?: boolean;
  /** env override (tests); defaults to `process.env`. Read for the principal and strictness defaults. */
  env?: NodeJS.ProcessEnv;
}

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
 *
 * **The principal boundary (G7 — launch gate "unauthorised cross-principal results = 0").** This is
 * THE merge point for store sets, so the boundary lives here: every gathered record is scoped
 * against the caller's principal (see {@link GatherRecallOptions.principal}). A record that CARRIES
 * a principal stamp which is not the caller's is excluded — fail-closed (only an exact ownership
 * match or no stamp passes). A record that carries NO stamp (memory-1) passes: the v1 schema
 * pre-dates principals and has no column to compare — treating it as the caller's own is the
 * documented honest limitation, closed for a store by `migrateToV2` (the migration stamps the
 * migrating principal). A strict gather ({@link GatherRecallOptions.strictPrincipal}) closes it for
 * the private stores (`local`/`global`) instead of treating "unknown owner" as "the caller"; team
 * records stay visible because that ledger is committed and append-only, so its memory-1 lines are
 * un-stampable and shared by construction. The boundary scopes the RECORD pool only — decisions and
 * feedback are id-keyed retire/adjust events; they can never add foreign content to a projection, so
 * they stay un-scoped (a foreign tombstone on a shared content id suppresses, it never reveals).
 */
export function gatherRecall(stores: RecallStores, opts: GatherRecallOptions = {}): GatheredRecall {
  const sources = opts.sources ?? DEFAULT_RECALL_SOURCES;
  const principal = resolveCallerPrincipal(opts);
  // An explicit option wins; otherwise the KCRIB_STRICT_PRINCIPAL opt-in (OFF by default). See
  // `resolveStrictPrincipal` for the measured reason strict is not the default, and the option's own
  // doc for why it scopes the PRIVATE stores only (an unstamped team line can never be stamped, so
  // excluding it would be a permanent, unrepairable recall loss).
  const strictPrincipal = opts.strictPrincipal ?? resolveStrictPrincipal(opts.env);
  const records: TaggedRecord[] = [];
  const decisions: MemoryDecision[] = [];
  const localDecisions: MemoryDecision[] = [];
  const feedback: MemoryFeedback[] = [];
  const errors: string[] = [];
  const aliases: MemoryAlias[] = [];
  let principalExcluded = 0;
  // The boundary accept: keep iff the record carries no principal stamp (v1 — treated as the
  // caller's own) or carries EXACTLY the caller's principal. Anything else is foreign and excluded.
  const acceptRecord = (
    record: MemoryRecord | MemoryRecordVersioned,
    source: MemorySource,
  ): boolean => {
    const ownedBy = recordPrincipalId(record);
    if (ownedBy === undefined) {
      // unstamped (memory-1). Owner is UNKNOWN, not "the caller" — a strict gather refuses it,
      // but only where refusal protects something. A team record is committed to the repository and
      // is readable by anyone who can read the repo, so excluding it protects no secret; and because
      // that ledger is append-only it can never be stamped, so excluding it would hide it from
      // recall forever. Private stores (local/global) are the ones the boundary is for.
      if (strictPrincipal && source !== 'team') {
        principalExcluded += 1;
        return false;
      }
    } else if (ownedBy !== principal) {
      principalExcluded += 1;
      return false;
    }
    records.push({ record, source });
    return true;
  };

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
      if (isRecordEntry(e)) acceptRecord(e, 'team');
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
      if (isRecordEntry(e)) acceptRecord(e, 'local');
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
      if (isRecordEntry(e)) acceptRecord(e, 'global');
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

  return {
    records,
    decisions,
    localDecisions,
    feedback,
    aliases,
    errors,
    principal,
    principalExcluded,
  };
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
  const scoreRecord = (
    r: MemoryRecord | MemoryRecordVersioned,
    q: string,
    t: readonly string[],
  ): number => (lexical ? lexical.score(r, q, t) : exactLexicalScorer(r, q, t));
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

  // The two stable decision pools recall evaluates against (see the no-poison split below), grouped
  // by subject on first use. Lazy so a projection over a store with no decisions pays nothing.
  let sharedIndex: DecisionsBySubject | undefined;
  let localIndex: DecisionsBySubject | undefined;
  const decisionIndexFor = (source: MemorySource): DecisionsBySubject => {
    if (source === 'local') {
      localIndex ??= indexDecisionsBySubject([...gathered.decisions, ...gathered.localDecisions]);
      return localIndex;
    }
    sharedIndex ??= indexDecisionsBySubject(gathered.decisions);
    return sharedIndex;
  };

  // PERF — the local no-poison pool is the SAME array for every local record, but it used to be
  // rebuilt with a two-array spread INSIDE the loop: at 100k records over 10k decisions that is
  // ~360 million element copies and was 92% of the whole projection. Built once, lazily, so a
  // projection with no local records never pays for it.
  let localPoolCache: MemoryDecision[] | undefined;
  const localPool = (): MemoryDecision[] => {
    localPoolCache ??= [...gathered.decisions, ...gathered.localDecisions];
    return localPoolCache;
  };

  const consideredBySource = { team: 0, local: 0, global: 0 };
  const eligibleEntries: {
    record: MemoryRecord | MemoryRecordVersioned;
    verdicts: EffectiveVerdicts;
    source: MemorySource;
    evaluated: boolean;
  }[] = [];
  // Every considered record with its effective verdicts — the input to conflict detection. v1
  // eligibility filtering happens INSIDE conflictGroups (unchanged semantics); memory-2 records are
  // rank-ineligible in the v1 projection but still conflict-visible (G1.1), so they must reach it.
  const consideredEntries: {
    record: MemoryRecord | MemoryRecordVersioned;
    verdicts: EffectiveVerdicts;
    source: MemorySource;
    evaluated: boolean;
  }[] = [];
  // WP5 §7.2 — the dropped records, in gather order here and sorted into a stable order below.
  const exclusions: RecallExclusion[] = [];

  for (const { record, source } of gathered.records) {
    consideredBySource[source] += 1;
    // R02 — EVERY schema is revalidated live when a pass is bound. This guard used to exclude
    // versioned records (`!isMemoryRecordVersioned`), which left a migrated record projecting the
    // evidence verdict captured in its alias snapshot at migration time. A record whose source
    // symbol was deleted AFTER migration therefore came back `valid`/`current` — migration
    // silently laundered stale evidence into fresh advice. `effectiveVerdicts` already prefers a
    // live evaluation over the snapshot; it simply never received one.
    const evaluation =
      fresh && opts.evaluator && opts.evalCtx
        ? opts.evaluator.evaluate(record, opts.evalCtx)
        : undefined;
    const evaluated = evaluation !== undefined;
    // No-poison (W5 Slice 2 + 3): local decisions overlay LOCAL records only; team/global decisions
    // are authoritative across stores (a team supersede/quarantine of an id correctly retires the
    // same-id local copy too). Folding local decisions into a team/global record would let a single
    // local negative event retract team memory (PRD line 242).
    const decs = source === 'local' ? localPool() : gathered.decisions;
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
    const boundAliases = isMemoryRecordVersioned(record) ? aliasIndex.aliasesFor(record.id) : [];
    const bridged = boundAliases.length > 0;
    const recordDecs = bridged ? bridgedDecisions(boundAliases, record.id, decs) : decs;
    // PERF — the unbridged path evaluates every record against ONE of two stable pools, so the
    // subject grouping is built once per pool instead of scanning it per record (O(records ×
    // decisions) → O(records)). A BRIDGED record gets a freshly synthesised pool, so it keeps the
    // scan: indexing a per-record array would cost more than the scan it replaces.
    const verdicts = effectiveVerdicts(
      record,
      recordDecs,
      evaluation,
      conservativeVerdicts(boundAliases),
      bridged ? undefined : decisionIndexFor(source),
    );
    consideredEntries.push({ record, verdicts, source, evaluated });
    // WP5 §7.2 — the SAME walk as the eligibility decision (`isRecallEligible` is defined as "fails no
    // clause"), so every record here is either eligible or carries the clause that dropped it: the
    // two lists partition `considered`, which is the invariant T14 asserts rather than assumes.
    const excludedBy = recallExclusionClause(verdicts);
    if (excludedBy !== undefined) {
      exclusions.push({ id: record.id, claim: record.claim, source, verdicts, excludedBy });
      continue;
    }
    eligibleEntries.push({ record, verdicts, source, evaluated });
  }

  const memories: ScoredRecord[] = eligibleEntries.map(
    ({ record, verdicts, source, evaluated }) => ({
      record,
      source,
      verdicts,
      evaluated,
      score: {
        lexical: scoreRecord(record, query, targetIds),
        sourceTier: sourceTier(source),
        evidenceQuality: evidenceQuality(verdicts),
        feedbackAdjust: feedbackAdjust(record.id, netFeedback, bound),
      },
    }),
  );

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

  return {
    memories,
    conflicts,
    // Stable order for a human-read diagnostic (see {@link RecallProjection.excluded}): `id` first,
    // then `source`, so two records sharing an id across stores stay adjacent and ordered.
    excluded: exclusions.sort(
      (a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source),
    ),
    provenance,
  };
}

/**
 * The hard eligibility filter applied before ranking (re-exported for verb/CLI convenience so callers
 * do not need to import the evaluator directly to test a single verdict). PRD line 338 invariant #1.
 */
export { isRecallEligible };

/** Re-exported so callers of {@link recallProjection} can type the `conflicts` field without importing
 *  the evaluator directly. */
export type { ConflictGroup };
