/**
 * The Extractor plugin contract (extractor-plugins §1). An extractor turns ONE file into nodes +
 * INTRA-FILE edges only — cross-file resolution (`calls`/`imports`/`inherits` across files) is the
 * resolver's job (pipeline Phase 3). Extractors are deterministic and never call an LLM.
 *
 * The contract types live here rather than in `soul-schema` so the leaf schema package stays free
 * of parser concerns; they reference only the schema's Node/Edge/NodeKind.
 */
import type { Edge, Node, NodeKind } from '@knowledge-crib/soul-schema';

/**
 * Max chars retained for a captured expression snippet — an assignment RHS (scoring formula), a
 * statement's source text, a condition predicate, or a cursor's SELECT. Generous on purpose: real
 * risk-score formulas, multi-line cursor queries, and compound boolean guards all fit well under
 * this, so the decision-table / behavior views read losslessly without rehydrating the body. The
 * rare overflow (a machine-generated SQL blob) sets the node's `exprTruncated` flag — honest about
 * the loss and pointing the consumer at `file`+`span` for the full text. Uniform across all 7
 * languages so expression fidelity is identical PL/SQL → Java → C# → Go → Rust → Python → TS.
 *
 * Was 120 (PL/SQL) / 200 (others) — those caps silently clipped exactly the formulas/queries a
 * migration needs, which is why a graph-only plan lost detail to a direct-source read.
 */
export const EXPR_MAX_CHARS = 2000;

/**
 * Clamp an expression snippet to {@link EXPR_MAX_CHARS}, reporting whether the cap was hit so the
 * caller can stamp `exprTruncated` on the node. Single source of truth for expression fidelity —
 * every extractor routes its `expr`/`cursorQuery`/`whenSelector`/`errorMessage` capture through here.
 */
export function clampExpr(s: string, max = EXPR_MAX_CHARS): { expr: string; truncated: boolean } {
  if (s.length <= max) return { expr: s, truncated: false };
  return { expr: s.slice(0, max), truncated: true };
}

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
