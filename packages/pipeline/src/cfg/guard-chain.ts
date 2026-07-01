/**
 * Guard-chain framework (M11) — the path-condition model a CFG pass threads down a procedure body.
 *
 * A {@link GuardFrame} is one decision point on the path from procedure entry to a statement: an
 * IF branch or a loop. The pass keeps a stack of frames as it descends; {@link pathCondition}
 * folds that stack into the {@link PathCondition} that gets stamped onto an edge via
 * {@link SoulStore.annotateEdges}.
 *
 * Language-agnostic by design: a per-language CFG pass (see `resolve/plsql-cfg.ts`) decides how
 * to map its AST onto frames. The contract here is just "a frame carries a condition-node id (the
 * guard), a branch label, and the loop/exception flags".
 *
 * Convention (matches the PlSqlExtractor's condition-node emission):
 *   • An IF contributes ONE condition node (keyed by the IF's start line) shared across all its
 *     branches; the {@link GuardFrame.branch} label ('THEN'/'ELSIF'/'ELSE') distinguishes them.
 *     So a statement in the ELSE branch still carries the IF's condition on its `cfgPath` — the
 *     branch label records the polarity, not a separate negated node.
 *   • A loop with a condition contributes its condition node; a plain infinite loop contributes
 *     none (its frame has `condId: undefined`) but still sets `inLoop`.
 */

/** One frame on the path-condition stack. */
export interface GuardFrame {
  /** condition node id for this decision point; undefined for an ELSE branch or a plain LOOP. */
  condId?: string;
  /** branch label of the innermost IF branch ('THEN'/'ELSIF'/'ELSE'); undefined for loops. */
  branch?: string;
  loop: boolean;
  exception: boolean;
}

/** The folded path condition stamped onto an edge. */
export interface PathCondition {
  /** innermost condition node id on the path (the guard predicate reaching the action) */
  guard?: string;
  /** condition node ids from procedure entry → here, outermost first */
  cfgPath: string[];
  /** innermost IF branch label; undefined at top level or inside a loop */
  branch?: string;
  inLoop: boolean;
  inException: boolean;
}

/** Fold a frame stack into the {@link PathCondition} for the statement those frames enclose. */
export function pathCondition(frames: readonly GuardFrame[]): PathCondition {
  const cfgPath: string[] = [];
  for (const f of frames) if (f.condId !== undefined) cfgPath.push(f.condId);
  const inner = frames.length > 0 ? frames[frames.length - 1] : undefined;
  return {
    cfgPath,
    guard: cfgPath.length > 0 ? cfgPath[cfgPath.length - 1] : undefined,
    branch: inner?.branch,
    inLoop: frames.some((f) => f.loop),
    inException: frames.some((f) => f.exception),
  };
}
