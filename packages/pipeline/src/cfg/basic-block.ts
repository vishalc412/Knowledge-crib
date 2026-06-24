/**
 * Basic-block segmentation (M11) — the generic CFG unit.
 *
 * A {@link BasicBlock} is a maximal straight-line run of statements with no internal control-flow
 * split: between two compound statements (IF / LOOP), every statement shares the same enclosing
 * path condition. The {@link PlSqlCfgPass} segments each lexical {@link Block} into basic blocks
 * and stamps one {@link PathCondition} per block (computed once from the frame stack), so the
 * guard-chain annotation is computed per block, not per statement.
 *
 * Language-agnostic: works on the shared `Block`/`Stmt` shapes from `@knowledge-crib/parsers`.
 */
import type { Block, Stmt } from '@knowledge-crib/parsers';

/** A maximal straight-line run of non-compound statements sharing one path condition. */
export interface BasicBlock {
  statements: Stmt[];
}

/** is this statement a control-flow split (an IF or LOOP that starts a sub-CFG)? */
function isCompound(s: Stmt): boolean {
  return s.kind === 'if' || s.kind === 'loop';
}

/**
 * Segment a lexical block into basic blocks. Compound statements (IF / LOOP) are NOT included in
 * any block — the caller recurses into them separately (pushing frames). Consecutive non-compound
 * statements collapse into one block.
 */
export function segmentBlock(block: Block): BasicBlock[] {
  const blocks: BasicBlock[] = [];
  let run: Stmt[] = [];
  for (const s of block.statements) {
    if (isCompound(s)) {
      if (run.length > 0) {
        blocks.push({ statements: run });
        run = [];
      }
    } else {
      run.push(s);
    }
  }
  if (run.length > 0) blocks.push({ statements: run });
  return blocks;
}
