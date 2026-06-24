import type { SoulStore } from '@knowledge-crib/core';
/**
 * SchemaCatalog (M10) — the global table/column index the {@link SqlResolver} resolves DML
 * references against. Built once from the soul AFTER Phase 2 (so every `table`/`column` node
 * emitted by the PlSqlExtractor, in any file, is present in memory). Lookup is case-insensitive
 * (PL/SQL is, except quoted ids — the lexer already lower-cased refs).
 *
 * A reference that resolves to NO catalog entry is dropped (capability-honesty: we never guess a
 * table that has no DDL anywhere in the indexed repo — it's an external schema).
 */
import type { Node } from '@knowledge-crib/soul-schema';

export class SchemaCatalog {
  /** "schema.table" (lower) → table id. */
  private readonly qualified = new Map<string, string>();
  /** "table" (lower) → table ids (a bare name may match several schemas). */
  private readonly byName = new Map<string, string[]>();
  /** "schema.table.col" / "table.col" (lower) → column id. */
  private readonly columns = new Map<string, string>();
  /** all table nodes (for completeness queries). */
  readonly tables: Node[] = [];
  readonly cols: Node[] = [];

  constructor(soul: SoulStore) {
    for (const t of soul.iterate('table')) {
      this.tables.push(t);
      const id = t.id;
      const schema = (t.schema ?? '').toLowerCase();
      const name = (t.name ?? '').toLowerCase();
      if (name) {
        const list = this.byName.get(name) ?? [];
        list.push(id);
        this.byName.set(name, list);
      }
      if (schema && name) this.qualified.set(`${schema}.${name}`, id);
      if (!schema && name) this.qualified.set(name, id); // bare table → qualified by name
    }
    for (const c of soul.iterate('column')) {
      this.cols.push(c);
      const schema = (c.schema ?? '').toLowerCase();
      const table = (c.table ?? '').toLowerCase();
      const col = (c.name ?? '').toLowerCase();
      if (table && col) this.columns.set(`${table}.${col}`, c.id);
      if (schema && table && col) this.columns.set(`${schema}.${table}.${col}`, c.id);
    }
  }

  /** Resolve a table reference ("schema.table" or "table") to a node id, or undefined. */
  resolveTable(ref: string): string | undefined {
    const r = ref.toLowerCase();
    const q = this.qualified.get(r);
    if (q) return q;
    const last = r.split('.').pop() ?? r;
    const byName = this.byName.get(last);
    return byName?.[0];
  }

  /** Resolve a column reference ("table.col" / "schema.table.col") to a node id, or undefined. */
  resolveColumn(ref: string): string | undefined {
    return this.columns.get(ref.toLowerCase());
  }
}
