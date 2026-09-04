/**
 * The legacy-ID alias map's PURE resolution helpers (G1.2).
 *
 * The persisted {@link MemoryAlias} entries are the store's concern (see `MemoryStore.readAliases` /
 * `upsertAliases`); this module is the pure join layer consumers use on top of them:
 *
 *   - {@link buildAliasIndex}: an id→id lookup that FAILS CLOSED on a legacy id bound to two
 *     different resolved ids (the v2 content seed is deterministic, so a disagreement means the
 *     seed moved — never silently pick one);
 *   - {@link AliasIndex.aliasesFor} + {@link conservativeVerdicts}: the COLLAPSED-TWIN helpers. The
 *     v2 content seed excludes v1 authorship + scope, so two v1 records of one claim (observed by
 *     two actors, or at two scope boundaries) legitimately migrate to the SAME twin — every
 *     projection over a migrated record must therefore consider EVERY alias bound to it and merge
 *     the sibling verdict snapshots CONSERVATIVELY (worst axis), never last-wins;
 *   - {@link bridgedDecisions}: the additive read-bridge that lets a decision keyed on a LEGACY id
 *     keep attaching to the migrated record that now owns the claim — from EVERY bound legacy id,
 *     matching the multi-alias feedback bridge — WITHOUT rewriting the decision line (memory is
 *     append-only; the bridge happens in the read projection only).
 */
import type { Verdicts } from './enums.js';
import type { MemoryAlias, MemoryDecision } from './types.js';

/** A built lookup over a store's persisted aliases. */
export interface AliasIndex {
  /** The v2 id a legacy id resolves to, or `undefined` when it has no alias. */
  resolve(legacyId: string): string | undefined;
  /**
   * The alias whose record NOW owns the claim (`undefined` when `resolvedId` was never migrated).
   *
   * WARNING: with collapsed twins (two legacy ids → one v2 record) this returns ONE arbitrary
   * sibling (the last seen in gather order). Projection code must use {@link aliasesFor} and merge
   * with {@link conservativeVerdicts}; `aliasFor` remains for single-legacy-id lookups only.
   */
  aliasFor(resolvedId: string): MemoryAlias | undefined;
  /** EVERY alias bound to `resolvedId` (caller-supplied order; empty when never migrated). Two
   *  legacy ids onto one twin are legitimate — see the module header. */
  aliasesFor(resolvedId: string): readonly MemoryAlias[];
  /** Every alias in the index (caller-supplied order). */
  all(): readonly MemoryAlias[];
}

/** Thrown when one legacy id is bound to two different resolved ids (a moved v2 seed). */
export class AliasConflictError extends Error {
  constructor(
    readonly legacyId: string,
    readonly first: string,
    readonly second: string,
  ) {
    super(
      `conflicting legacy-ID aliases for ${legacyId}: ${first} vs ${second} (the v2 content id seed must be deterministic)`,
    );
    this.name = 'AliasConflictError';
  }
}

/**
 * Build an {@link AliasIndex} over persisted aliases. PURE; throws {@link AliasConflictError} if two
 * aliases bind the same legacy id to DIFFERENT resolved ids (never silently pick one — a
 * disagreement means the v2 content seed changed under a committed alias). Two legacy ids
 * resolving to the SAME v2 record are legitimate (the v2 seed ignores v1 scope/authorship, so two
 * v1 records of one claim can collapse onto one v2 twin).
 */
export function buildAliasIndex(aliases: readonly MemoryAlias[]): AliasIndex {
  const byLegacy = new Map<string, string>();
  for (const alias of aliases) {
    const bound = byLegacy.get(alias.legacyId);
    if (bound !== undefined && bound !== alias.resolvedId) {
      throw new AliasConflictError(alias.legacyId, bound, alias.resolvedId);
    }
    byLegacy.set(alias.legacyId, alias.resolvedId);
  }
  const resolve = (legacyId: string): string | undefined => {
    let current = legacyId;
    let resolved = byLegacy.get(current);
    if (resolved === undefined) return undefined;
    const seen = new Set<string>([current]);
    while (byLegacy.has(resolved)) {
      if (seen.has(resolved)) {
        throw new AliasConflictError(legacyId, current, resolved);
      }
      seen.add(resolved);
      current = resolved;
      resolved = byLegacy.get(current)!;
    }
    return resolved;
  };
  const aliasesFor = (resolvedId: string): readonly MemoryAlias[] =>
    aliases.filter((alias) => resolve(alias.legacyId) === resolvedId);
  return {
    resolve,
    aliasFor: (resolvedId) => aliasesFor(resolvedId).at(-1),
    aliasesFor,
    all: () => aliases,
  };
}

// ─── the conservative verdict snapshot (collapsed twins) ──────────────────────

/** Axis orderings from WORST to best: the conservative merge picks the worst value per axis. */
const TRUST_WORST_FIRST = ['candidate', 'local', 'team'] as const;
const EVIDENCE_WORST_FIRST = ['invalid', 'degraded', 'valid'] as const;
const APPLICABILITY_WORST_FIRST = ['orphaned', 'needs-review', 'current'] as const;
const LIFECYCLE_WORST_FIRST = ['retracted', 'superseded', 'active'] as const;

/** The worst (earliest in its WORST_FIRST ordering) of `values` — deterministic over the SET. */
function worstOf<T extends string>(worstFirst: readonly T[], values: readonly T[]): T {
  let out = values[0] as T;
  for (const v of values) {
    if (worstFirst.indexOf(v) < worstFirst.indexOf(out)) out = v;
  }
  return out;
}

/**
 * The verdict snapshot for a migrated v2 record with ONE OR MORE bound legacy ids: the WORST axis
 * across every collapsed sibling (worst trust, worst evidence, worst applicability, worst
 * lifecycle), so a demoted/quarantined-adjacent sibling can never be washed out by an
 * arbitrary last-wins pick. PURE and order-independent — the merge is a function of the sibling
 * SET, never of shard/file/gather order. Returns `undefined` for no aliases (a fresh v2
 * observation: the read projection then derives its axes as documented in evaluator.ts).
 */
export function conservativeVerdicts(aliases: readonly MemoryAlias[]): Verdicts | undefined {
  if (aliases.length === 0) return undefined;
  return {
    trust: worstOf(
      TRUST_WORST_FIRST,
      aliases.map((a) => a.verdicts.trust),
    ),
    evidence: worstOf(
      EVIDENCE_WORST_FIRST,
      aliases.map((a) => a.verdicts.evidence),
    ),
    applicability: worstOf(
      APPLICABILITY_WORST_FIRST,
      aliases.map((a) => a.verdicts.applicability),
    ),
    lifecycle: worstOf(
      LIFECYCLE_WORST_FIRST,
      aliases.map((a) => a.verdicts.lifecycle),
    ),
  };
}

/**
 * The read-bridge for decision events keyed on a LEGACY id: returns `decisions` plus in-memory
 * COPIES of every legacy-keyed decision re-subjected to `recordId` (the id of the migrated record
 * that now owns the claim) — from EVERY legacy id bound to `recordId`, matching the multi-alias
 * feedback bridge (recall.ts double-keys feedback under each bound alias). With collapsed twins
 * (two v1 records → one v2 record) a quarantine recorded against EITHER sibling must still
 * attach to the twin: bridging one arbitrary legacy id would let a quarantined claim resurface.
 * ADDITIVE by design — the original decision stays visible to the legacy record wherever it still
 * exists (the team store retains v1 lines), and the on-disk line is never rewritten (memory is
 * append-only; bridging is a read-projection concern). PURE.
 *
 * Returns `decisions` unchanged when no alias is bound to `recordId` (nothing to bridge).
 */
export function bridgedDecisions(
  aliases: readonly MemoryAlias[] | undefined,
  recordId: string,
  decisions: readonly MemoryDecision[],
): MemoryDecision[] {
  const bound = (aliases ?? []).filter((a) => a.resolvedId === recordId && a.legacyId !== recordId);
  if (bound.length === 0) return decisions as MemoryDecision[];
  const out: MemoryDecision[] = [...decisions];
  const seen = new Set<string>();
  for (const alias of bound) {
    if (seen.has(alias.legacyId)) continue; // defensive: a duplicated legacy id never double-bridges
    seen.add(alias.legacyId);
    for (const decision of decisions) {
      if (decision.subject === alias.legacyId) out.push({ ...decision, subject: recordId });
    }
  }
  return out;
}
