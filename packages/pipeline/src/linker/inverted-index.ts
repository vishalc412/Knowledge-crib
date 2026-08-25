import type { SoulStore } from '@knowledge-crib/core';
/**
 * Inverted index `symbolName → symbol[]` built once from the soul, so the deterministic linker
 * passes are O(doc tokens), never O(docs × symbols). Also indexes by qualifiedName and by file.
 *
 * With `{ targets: true }` (the doc linker's link signal, W1 markdown fidelity) it additionally
 * indexes `file` nodes by path and `doc-section` nodes by `path#anchor`, so an internal Markdown
 * link resolves to ONE file/doc-section target instead of fanning out to every symbol in the file.
 * The media + semantic linkers opt out (they never resolve MD links) and pay only the symbol cost.
 */
import type { Node } from '@knowledge-crib/soul-schema';

export interface InvertedIndexOpts {
  /** also index `file` (by path) + `doc-section` (by `path#anchor`) for the anchor-aware link signal. */
  targets?: boolean;
}

export class InvertedIndex {
  private readonly byName = new Map<string, Node[]>();
  private readonly byQualified = new Map<string, Node>();
  private readonly byFile = new Map<string, Node[]>();
  private readonly fileNodeByPath = new Map<string, Node>();
  private readonly docSectionByPathAnchor = new Map<string, Node>();

  constructor(soul: SoulStore, opts: InvertedIndexOpts = {}) {
    for (const node of soul.iterate('symbol')) {
      if (node.name) push(this.byName, node.name, node);
      if (node.qualifiedName) this.byQualified.set(node.qualifiedName, node);
      if (node.file) push(this.byFile, node.file, node);
    }
    if (opts.targets) {
      for (const node of soul.iterate('file')) {
        if (node.file) this.fileNodeByPath.set(node.file, node);
      }
      for (const node of soul.iterate('doc-section')) {
        if (node.file && node.anchor)
          this.docSectionByPathAnchor.set(`${node.file}#${node.anchor}`, node);
      }
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

  /** The `file` node for a repo-relative path, or undefined if it is not indexed. */
  fileNode(path: string): Node | undefined {
    return this.fileNodeByPath.get(path);
  }

  /** The `doc-section` node for a `path#anchor`, or undefined if that heading is not indexed. */
  docSection(path: string, anchor: string): Node | undefined {
    return this.docSectionByPathAnchor.get(`${path}#${anchor}`);
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
