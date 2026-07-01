import type { SoulStore } from '@knowledge-crib/core';
/**
 * Inverted index `symbolName → symbol[]` built once from the soul, so the deterministic linker
 * passes are O(doc tokens), never O(docs × symbols). Also indexes by qualifiedName and by file.
 */
import type { Node } from '@knowledge-crib/soul-schema';

export class InvertedIndex {
  private readonly byName = new Map<string, Node[]>();
  private readonly byQualified = new Map<string, Node>();
  private readonly byFile = new Map<string, Node[]>();

  constructor(soul: SoulStore) {
    for (const node of soul.iterate('symbol')) {
      if (node.name) push(this.byName, node.name, node);
      if (node.qualifiedName) this.byQualified.set(node.qualifiedName, node);
      if (node.file) push(this.byFile, node.file, node);
    }
  }

  symbolsNamed(name: string): Node[] {
    return this.byName.get(name) ?? [];
  }

  qualified(qn: string): Node | undefined {
    return this.byQualified.get(qn);
  }

  symbolsInFile(path: string): Node[] {
    return this.byFile.get(path) ?? [];
  }

  /** True if exactly one symbol carries this name (safe to treat a bare code ref as explicit). */
  nameIsUnique(name: string): boolean {
    return (this.byName.get(name)?.length ?? 0) === 1;
  }
}

function push(map: Map<string, Node[]>, key: string, node: Node): void {
  const list = map.get(key) ?? [];
  list.push(node);
  map.set(key, list);
}
