/**
 * The Extractor plugin contract (extractor-plugins §1). An extractor turns ONE file into nodes +
 * INTRA-FILE edges only — cross-file resolution (`calls`/`imports`/`inherits` across files) is the
 * resolver's job (pipeline Phase 3). Extractors are deterministic and never call an LLM.
 *
 * The contract types live here rather than in `soul-schema` so the leaf schema package stays free
 * of parser concerns; they reference only the schema's Node/Edge/NodeKind.
 */
import type { Edge, Node, NodeKind } from '@knowledge-crib/soul-schema';

export interface FileMeta {
  /** repo-relative path. */
  path: string;
  lang?: string;
  bytes: number;
  mtime: number;
}

/** A minimal tree-sitter-ish parser handle; concrete shape is backend-defined (M8 langs). */
export interface ParserHandle {
  parse(source: string): unknown;
}

export interface ExtractCtx {
  /** lazy source read for the current file. */
  readText(): Promise<string>;
  /** shared parser pool for a vendored grammar (tree-sitter/ANTLR langs, M8+). */
  treeSitter(grammar: string): ParserHandle;
  /** ANTLR parse hook for legacy langs (migration track, §4.6). */
  antlrParse?(grammar: string, source: string): unknown;
  /** blake3 content hash, "blake3:<hex>". */
  hash(s: string): string;
  /** id-grammar helper so every id stays canonical. */
  idFor(kind: NodeKind, parts: Record<string, unknown>): string;
}

export interface ExtractResult {
  nodes: Node[];
  /** intra-file edges only: member-of, local calls, etc. */
  edges: Edge[];
}

/** What a language extractor claims to resolve. Capability-honesty tests verify these (§5). */
export interface Capabilities {
  imports: boolean;
  calls: boolean;
  inheritance: boolean;
  /** full | partial | none */
  types: 'full' | 'partial' | 'none';
}

export interface Extractor {
  /** unique id, e.g. "lang:typescript", "doc:markdown". */
  name: string;
  /** which files this handles. */
  supports(file: FileMeta): boolean;
  /** capability matrix; format extractors may omit it. */
  capabilities?: Capabilities;
  /** parse one file → nodes + intra-file edges. Must degrade to a file node on parse failure. */
  extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult>;
}
