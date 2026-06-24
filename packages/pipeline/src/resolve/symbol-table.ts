import type { SoulStore } from '@knowledge-crib/core';
/**
 * Global symbol table built from the soul after Phase 2. The resolver looks symbols up here to turn
 * a cross-file reference into a concrete `dst` id — and drops anything that doesn't resolve to an
 * indexed symbol (no guessing).
 */
import { idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';

export class SymbolTable {
  /** filePath → its symbol nodes (any nesting). */
  private readonly byFile = new Map<string, Node[]>();
  /** filePath → (top-level symbol name → node). */
  private readonly topLevel = new Map<string, Map<string, Node>>();

  constructor(soul: SoulStore) {
    for (const node of soul.iterate('symbol')) {
      if (!node.file) continue;
      const list = this.byFile.get(node.file) ?? [];
      list.push(node);
      this.byFile.set(node.file, list);
      if (isTopLevel(node) && node.name) {
        const tl = this.topLevel.get(node.file) ?? new Map<string, Node>();
        if (!tl.has(node.name)) tl.set(node.name, node);
        this.topLevel.set(node.file, tl);
      }
    }
  }

  hasFile(path: string): boolean {
    return this.byFile.has(path) || this.topLevel.has(path);
  }

  /** A top-level (exported-or-not) symbol named `name` declared in `file`. */
  topLevelSymbol(file: string, name: string): Node | undefined {
    return this.topLevel.get(file)?.get(name);
  }

  /** The file node id for a path (always exists after Phase 1). */
  fileId(path: string): string {
    return idFor({ kind: 'file', path });
  }

  /** Innermost symbol in `file` whose span contains `line`, or undefined. */
  enclosingSymbolId(file: string, line: number): string | undefined {
    const syms = this.byFile.get(file);
    if (!syms) return undefined;
    let best: Node | undefined;
    for (const s of syms) {
      const span = s.span;
      if (!span || line < span.start || line > span.end) continue;
      if (!best || (best.span && span.start >= best.span.start && span.end <= best.span.end))
        best = s;
    }
    return best?.id;
  }
}

/** Top-level = declared directly under the file (no enclosing symbol). */
function isTopLevel(node: Node): boolean {
  const parent = node.meta?.parentQualifier;
  return parent === undefined || parent === '';
}
