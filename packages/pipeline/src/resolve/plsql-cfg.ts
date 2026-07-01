import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EdgeAnnotation } from '@knowledge-crib/core';
import type { FileMeta } from '@knowledge-crib/parsers';
import { parsePlSql } from '@knowledge-crib/parsers';
import type {
  Block,
  CallStmt,
  CaseStmt,
  ExceptionBlock,
  IfStmt,
  LoopStmt,
  Stmt,
  Unit,
} from '@knowledge-crib/parsers';
import { edgeId, idFor } from '@knowledge-crib/soul-schema';
import { segmentBlock } from '../cfg/basic-block.js';
import { pathCondition } from '../cfg/guard-chain.js';
import type { GuardFrame } from '../cfg/guard-chain.js';
import type { CfgContext, CfgPass, CfgStats } from './dispatch.js';

const SQL_EXTS = ['.sql', '.pkb', '.pks', '.pck', '.pls', '.pkh', '.typ'];

export class PlSqlCfgPass implements CfgPass {
  name = 'plsql-cfg';

  supports(file: FileMeta): boolean {
    return SQL_EXTS.some((e) => file.path.endsWith(e));
  }

  run(ctx: CfgContext): CfgStats {
    const supported = ctx.files.filter((f) => this.supports(f));
    let annotated = 0;
    const skipped = 0;
    if (supported.length === 0) return { annotated, skipped };

    // callee index for `calls` edges: qualified name + simple name (file-aware), mirroring the
    // SqlResolver so an edge id computed here matches the one the resolver/extractor wrote.
    const byQualified = new Map<string, string>();
    const bySimple = new Map<string, { id: string; file: string }[]>();
    for (const s of ctx.soul.iterate('symbol')) {
      if (s.type !== 'procedure' && s.type !== 'function') continue;
      const q = (s.qualifiedName ?? '').toLowerCase();
      const simple = (s.name ?? '').toLowerCase();
      if (q) byQualified.set(q, s.id);
      if (simple && s.file) {
        const list = bySimple.get(simple) ?? [];
        list.push({ id: s.id, file: s.file });
        bySimple.set(simple, list);
      }
    }

    const updates: EdgeAnnotation[] = [];
    for (const f of supported) {
      let text: string;
      try {
        text = readFileSync(join(ctx.root, f.path), 'utf8');
      } catch {
        continue; // unreadable file — skip (never throws the pipeline)
      }
      let units: ReturnType<typeof parsePlSql>;
      try {
        units = parsePlSql(text);
      } catch {
        continue; // tolerant: a parse failure yields no annotation
      }
      const walker = new Walker(f.path, byQualified, bySimple, updates);
      for (const top of units) walker.addTop(top);
    }

    ctx.soul.annotateEdges(updates);
    annotated = updates.length;
    return { annotated, skipped };
  }
}

/** Mirrors `SqlResolver.resolveCallee` — qualified match first, else file-aware simple match. */
function resolveCallee(
  callee: string,
  callerFile: string,
  byQualified: Map<string, string>,
  bySimple: Map<string, { id: string; file: string }[]>,
): string | undefined {
  const c = callee.toLowerCase();
  const q = byQualified.get(c);
  if (q) return q;
  const simple = c.split('.').pop() ?? c;
  const list = bySimple.get(simple);
  if (!list || list.length === 0) return undefined;
  const same = list.find((e) => e.file === callerFile);
  const pick = same ?? list[0];
  return pick?.id;
}

/** Walks one file's parsed units, accumulating edge annotations. */
class Walker {
  constructor(
    private readonly path: string,
    private readonly byQualified: Map<string, string>,
    private readonly bySimple: Map<string, { id: string; file: string }[]>,
    private readonly updates: EdgeAnnotation[],
  ) {}

  addTop(top: { kind: string }): void {
    if (top.kind === 'table-ddl') return; // tables have no body to walk
    this.walkUnit(top as unknown as Unit, '');
  }

  private walkUnit(u: Unit, qualifier: string): void {
    const qualifiedName = qualifier ? `${qualifier}.${u.name}` : u.name;
    const procId = idFor({
      kind: 'symbol',
      path: this.path,
      qualifiedName,
      startLine: u.span.start,
    });

    // nested declarations thread the qualifier, exactly as the extractor's addUnit does.
    if (u.declarations) {
      for (const d of u.declarations) {
        if (d.kind === 'procedure' || d.kind === 'function') {
          const nested: Unit = {
            kind: d.kind,
            name: d.name,
            params: d.params,
            returnType: d.returnType,
            span: d.span,
            declarations: d.declarations,
            body: d.body,
          };
          this.walkUnit(nested, qualifiedName);
        }
      }
    }
    if (u.body) this.walkBlock(u.body, procId, []);
  }

  private walkBlock(block: Block, procId: string, frames: GuardFrame[]): void {
    // 1. each straight-line run shares one path condition — annotate once per block.
    for (const bb of segmentBlock(block)) {
      const cond = pathCondition(frames);
      for (const s of bb.statements) this.annotate(s, procId, cond);
    }
    // 2. recurse into compound statements, pushing a frame for each branch / loop / case / handler.
    for (const s of block.statements) {
      if (s.kind === 'if') this.walkIf(s, procId, frames);
      else if (s.kind === 'loop') this.walkLoop(s, procId, frames);
      else if (s.kind === 'case') this.walkCase(s, procId, frames);
      else if (s.kind === 'exception') this.walkException(s, procId, frames);
    }
  }

  private walkIf(s: IfStmt, procId: string, frames: GuardFrame[]): void {
    // the IF contributes ONE condition node (keyed by the IF's start line) shared across branches;
    // the branch label records polarity.
    const ifCondId = idFor({ kind: 'condition', file: this.path, line: s.span.start });
    for (const branch of s.branches) {
      const frame: GuardFrame = {
        condId: ifCondId,
        branch: branch.label,
        loop: false,
        exception: false,
      };
      this.walkBlock(branch.body, procId, [...frames, frame]);
    }
  }

  private walkLoop(s: LoopStmt, procId: string, frames: GuardFrame[]): void {
    const loopCondId = s.condition
      ? idFor({ kind: 'condition', file: this.path, line: s.span.start })
      : undefined;
    const frame: GuardFrame = { condId: loopCondId, loop: true, exception: false };
    this.walkBlock(s.body, procId, [...frames, frame]);
  }

  /**
   * 1.2: a CASE statement contributes one `case-branch` condition node per WHEN/ELSE branch, keyed
   * by the branch's start line (matching the extractor). Each branch body is walked under a frame
   * whose condId is that case-branch id and whose branch label is WHEN/ELSE (polarity).
   */
  private walkCase(s: CaseStmt, procId: string, frames: GuardFrame[]): void {
    for (const branch of s.branches) {
      const caseBranchId = idFor({ kind: 'case-branch', file: this.path, line: branch.span.start });
      const frame: GuardFrame = {
        condId: caseBranchId,
        branch: branch.label,
        loop: false,
        exception: false,
      };
      this.walkBlock(branch.body, procId, [...frames, frame]);
    }
  }

  /**
   * 1.2: an EXCEPTION clause marks each handler body `inException: true`. The handler contributes
   * NO condition to the path (an exception is not a guarded branch — it's an alternate entry), so
   * the frame's condId is undefined and the existing guard chain is inherited unchanged.
   */
  private walkException(s: ExceptionBlock, procId: string, frames: GuardFrame[]): void {
    for (const handler of s.handlers) {
      const frame: GuardFrame = { condId: undefined, loop: false, exception: true };
      this.walkBlock(handler.body, procId, [...frames, frame]);
    }
  }

  /** Stamp the path condition onto the statement's `executes` (or `calls`) edge. */
  private annotate(s: Stmt, procId: string, cond: ReturnType<typeof pathCondition>): void {
    // case / exception are compound — segmented out of basic blocks and recursed into, never
    // annotated directly. raise has no executes edge (it emits a `raises` edge, not executes).
    if (s.kind === 'case' || s.kind === 'exception' || s.kind === 'raise') return;

    const patch: Omit<EdgeAnnotation, 'id'> = {
      cfgPath: cond.cfgPath,
      inLoop: cond.inLoop,
      inException: cond.inException,
    };
    if (cond.guard !== undefined) patch.guard = cond.guard;
    if (cond.branch !== undefined) patch.branch = cond.branch;

    if (s.kind === 'call') {
      this.annotateCall(s, procId, patch);
      return;
    }
    // 1.2: an assignment emits an `assignment` node (not a `statement`); compute its id so the
    // executes edge the extractor wrote is stamped with the path condition.
    const stmtId =
      s.kind === 'assign'
        ? idFor({ kind: 'assignment', file: this.path, line: s.span.start })
        : idFor({ kind: 'statement', file: this.path, line: s.span.start });
    this.updates.push({ id: edgeId(procId, stmtId, 'executes'), ...patch });
  }

  private annotateCall(s: CallStmt, procId: string, patch: Omit<EdgeAnnotation, 'id'>): void {
    const dstId = resolveCallee(s.callee, this.path, this.byQualified, this.bySimple);
    if (!dstId) return; // callee unresolved → no `calls` edge to annotate (honest: skip)
    this.updates.push({ id: edgeId(procId, dstId, 'calls'), ...patch });
  }
}
