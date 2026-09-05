/**
 * SqlResolver (M10, Phase 3c) — cross-file SQL data-flow. Runs against the whole soul AFTER Phase 2:
 *
 *   • reads / writes  statement → table/column declared in ANOTHER file (the extractor already
 *     emitted same-file ones; we resolve the rest against the {@link SchemaCatalog}).
 *   • calls           procedure symbol → procedure symbol in another package/file (the extractor
 *     recorded call sites on each procedure symbol's `meta.calls`; we resolve them against the
 *     global procedure index).
 *
 * Drops anything that doesn't resolve to an indexed node (no guessing). Edges already present in
 * the soul (from the extractor) are skipped via a `getEdge` check, so a reference is counted once.
 */
import type { FileMeta } from '@knowledge-crib/parsers';
import { sqlRoles } from '@knowledge-crib/parsers';
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge } from '@knowledge-crib/soul-schema';
import type { ResolveContext, ResolveResult, Resolver } from './resolver-registry.js';
import { SchemaCatalog } from './schema-catalog.js';

const SQL_EXTS = ['.sql', '.pkb', '.pks', '.pck', '.pls', '.pkh', '.typ'];

interface CallSite {
  callee: string;
  line: number;
}

/** Shape of an FK carried on a table node's `meta.foreignKeys` (mirrors the parser's ForeignKey). */
interface FkMeta {
  columns: string[];
  refTable: string;
  refColumns?: string[];
}

export class SqlResolver implements Resolver {
  name = 'sql-resolver';

  supports(file: FileMeta): boolean {
    return SQL_EXTS.some((e) => file.path.endsWith(e));
  }

  resolve(ctx: ResolveContext): ResolveResult {
    const edges: Edge[] = [];
    const stats: Record<string, number> = {
      reads: 0,
      writes: 0,
      calls: 0,
      references: 0,
      dropped: 0,
    };
    const catalog = new SchemaCatalog(ctx.soul);
    // local dropped counter (Record<string, number> indexing yields `number | undefined` under
    // noUncheckedIndexedAccess; a plain local avoids `?? 0` on every miss).
    let dropped = 0;

    // procedure index for cross-file calls: qualified name + simple name (file-aware).
    //
    // SCOPED TO SQL FILES. `supports()` gates this resolver on a SQL extension, but `resolve()`
    // walks the whole soul — so in a mixed repository (one .sql fixture is enough) it was matching
    // TypeScript `function` symbols by bare name and emitting cross-file `calls` edges the TS
    // resolver had deliberately refused to guess at. That is how a `now` PARAMETER in one file
    // acquired a confidence-1 edge to `cmdMemoryDistill.now` in another (audit F11).
    const byQualified = new Map<string, string>();
    const bySimple = new Map<string, { id: string; file: string }[]>();
    for (const s of ctx.soul.iterate('symbol')) {
      if (s.type !== 'procedure' && s.type !== 'function') continue;
      if (!isSqlFile(s.file)) continue;
      const q = (s.qualifiedName ?? '').toLowerCase();
      const simple = (s.name ?? '').toLowerCase();
      if (q) byQualified.set(q, s.id);
      if (simple && s.file) {
        const list = bySimple.get(simple) ?? [];
        list.push({ id: s.id, file: s.file });
        bySimple.set(simple, list);
      }
    }

    const seen = new Set<string>();
    const emit = (
      src: string,
      dst: string,
      rel: Edge['rel'],
      snippet: string,
      statKey: string,
    ): void => {
      const id = edgeId(src, dst, rel);
      if (seen.has(id)) return;
      if (ctx.soul.getEdge(id)) {
        seen.add(id); // already emitted by the extractor (same-file) — count once
        return;
      }
      seen.add(id);
      edges.push({
        id,
        src,
        dst,
        rel,
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet },
      });
      stats[statKey] = (stats[statKey] ?? 0) + 1;
    };

    // statement → table reads/writes (cross-file; same-file already in the soul).
    for (const stmt of ctx.soul.iterate('statement')) {
      const tables = (stmt.meta?.tables as string[] | undefined) ?? [];
      if (tables.length === 0) continue;
      const { reads, writes } = sqlRoles(stmt.sqlKind ?? '', tables);
      for (const t of reads) {
        const dst = catalog.resolveTable(t);
        if (dst) emit(stmt.id, dst, 'reads', t, 'reads');
        else dropped++;
      }
      for (const t of writes) {
        const dst = catalog.resolveTable(t);
        if (dst) emit(stmt.id, dst, 'writes', t, 'writes');
        else dropped++;
      }
    }

    // cursor → table reads (cross-file; same-file already in the soul). A cursor's SELECT reads its
    // row-source tables; the extractor mined them into `meta.tables` on the cursor node (WS-7).
    for (const cur of ctx.soul.iterate('cursor')) {
      const tables = (cur.meta?.tables as string[] | undefined) ?? [];
      for (const t of tables) {
        const dst = catalog.resolveTable(t);
        if (dst) emit(cur.id, dst, 'reads', t, 'reads');
        else dropped++;
      }
    }

    // table → table references (cross-file FK; same-file already in the soul). The extractor mined
    // each FK into `meta.foreignKeys` on the child table node; resolve the parent against the
    // catalog and emit a `references` edge child → parent (WS-7 — the schema's referential structure).
    for (const tbl of ctx.soul.iterate('table')) {
      const fks = (tbl.meta?.foreignKeys as FkMeta[] | undefined) ?? [];
      for (const fk of fks) {
        const dst = catalog.resolveTable(fk.refTable);
        if (dst) emit(tbl.id, dst, 'references', fk.refTable, 'references');
        else dropped++;
      }
    }

    // procedure → procedure calls (cross-file; same-file already in the soul).
    for (const sym of ctx.soul.iterate('symbol')) {
      if (sym.type !== 'procedure' && sym.type !== 'function') continue;
      if (!isSqlFile(sym.file)) continue;
      const calls = (sym.meta?.calls as CallSite[] | undefined) ?? [];
      for (const site of calls) {
        const dst = resolveCallee(site.callee, sym.file ?? '', byQualified, bySimple);
        if (dst && dst !== sym.id) {
          emit(sym.id, dst, 'calls', site.callee, 'calls');
        } else if (dst === sym.id) {
          // self-recursion: no self-edge (cycle avoidance, same convention as the extractor); flag
          // the proc so the dossier/context surface reports the recursion + the recursive call site.
          if (!sym.meta) sym.meta = {};
          if (!sym.meta.recursive) sym.meta.recursive = true;
        } else {
          dropped++;
        }
      }
    }

    stats.dropped = dropped;
    return { edges, stats };
  }
}

/** Resolve a callee "pkg.proc" / "proc" to a symbol id, preferring same-file matches for bare names. */
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
  // Prefer a callee declared in the same file (intra-package call).
  const same = list.find((e) => e.file === callerFile);
  if (same) return same.id;
  // Otherwise resolve ONLY when the simple name is unambiguous. Taking `list[0]` from several
  // same-named candidates produced a confident edge chosen by index order — deterministic, and
  // deterministically wrong whenever the guess missed. An ambiguous name is dropped instead, so it
  // is reported as an unresolved call site rather than a resolved-but-fabricated one.
  return list.length === 1 ? list[0]?.id : undefined;
}

/** Is this symbol's file one this resolver owns? Mirrors {@link SqlResolver.supports}. */
function isSqlFile(file: string | undefined): boolean {
  return file !== undefined && SQL_EXTS.some((e) => file.endsWith(e));
}
