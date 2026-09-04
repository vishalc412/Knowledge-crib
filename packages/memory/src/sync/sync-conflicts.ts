/**
 * ADR-003 (Gate 4) D8 — decision-level conflicts: two devices appending INCOMPATIBLE retirement
 * decisions for one subject. Never resolved automatically (never LWW, never first-writer-wins);
 * surfaced in sync status + `crib memory audit` until a human appends an explicit
 * supersede/retract via `crib memory resolve` (D8: resolution is append-only, and the resolving
 * decision itself syncs and converges).
 *
 * Quarantine (and activate/accept) compose — they are never a conflict: exclusion is an independent
 * flag in the read projection, not a retirement, so a `quarantine` decision cannot collide with a
 * `supersede`/`retract` for the same subject.
 *
 * Mirrors `mergeMemoryChunk`'s rule 3 (core/src/memory-merge.ts) but as a PURE read-layer
 * projection over any decision set — the merge driver only sees the git sides, while sync needs the
 * same posture across devices. PURE and deterministic: groups sort by subject, decision ids sort
 * within a group, and no timestamps anywhere.
 */
import type { MemoryDecisionKind } from '../enums.js';
import type { MemoryDecision } from '../types.js';

/**
 * The decision kinds that retire/replace a record — the set the merge driver's rule 3 watches
 * (core/src/memory-merge.ts:36). Mirrored, not imported: the constant is deliberately un-exported
 * from `core` (it is private to the merge driver), and this module needs the same two kinds.
 * If the merge driver's set ever changes, change BOTH — the comment is the link.
 */
const RETIRING_KINDS: readonly MemoryDecisionKind[] = ['supersede', 'retract'];

/** One incompatible retirement set on a single subject. */
export interface DecisionConflictGroup {
  /** the `mem:` id the decisions key on (`subject`). */
  subject: string;
  /** the involved decision ids, sorted (deterministic). */
  decisionIds: string[];
  kind: 'retract-supersede' | 'divergent-successors';
}

/**
 * Group the decisions into conflict groups (D8). PURE, deterministic, no timestamps:
 *
 *   - a subject with >= 1 `retract` AND >= 1 `supersede` → 'retract-supersede' (the merge driver's
 *     rule-3 posture: both survive, the contradiction is a read-layer concern);
 *   - a subject with >= 2 `supersedes` naming DIFFERENT successors (an absent successor counts as a
 *     distinct value — two devices claiming different successors must be adjudicated by a human);
 *     two supersedes naming the SAME successor converge (the merge driver unions them by id).
 *
 * Decisions on different subjects never group. `quarantine` decisions are ignored here (composable,
 * never a conflict) — the read projection folds them separately.
 */
export function decisionConflicts(decisions: readonly MemoryDecision[]): DecisionConflictGroup[] {
  const bySubject = new Map<string, MemoryDecision[]>();
  for (const d of decisions) {
    if (!RETIRING_KINDS.includes(d.kind)) continue;
    const bucket = bySubject.get(d.subject);
    if (bucket) bucket.push(d);
    else bySubject.set(d.subject, [d]);
  }
  const groups: DecisionConflictGroup[] = [];
  for (const [subject, decisions_] of bySubject) {
    const retires = decisions_.filter((d) => d.kind === 'retract');
    const supersedes = decisions_.filter((d) => d.kind === 'supersede');
    const involved = [...retires, ...supersedes].map((d) => d.id).sort();
    if (retires.length > 0 && supersedes.length > 0) {
      groups.push({ subject, decisionIds: involved, kind: 'retract-supersede' });
      continue;
    }
    if (supersedes.length > 1) {
      const successors = new Set(supersedes.map((d) => JSON.stringify(d.successor ?? null)));
      if (successors.size > 1) {
        groups.push({ subject, decisionIds: involved, kind: 'divergent-successors' });
      }
    }
  }
  return groups.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}
