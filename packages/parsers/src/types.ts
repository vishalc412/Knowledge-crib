/**
 * The Extractor plugin contract (extractor-plugins §1). An extractor turns ONE file into nodes +
 * INTRA-FILE edges only — cross-file resolution (`calls`/`imports`/`inherits` across files) is the
 * resolver's job (pipeline Phase 3). Extractors are deterministic and never call an LLM.
 *
 * The contract types live here rather than in `soul-schema` so the leaf schema package stays free
 * of parser concerns; they reference only the schema's Node/Edge/NodeKind.
 */
import type { Edge, Node, NodeKind, Span } from '@knowledge-crib/soul-schema';

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
  /** Mule-only: clone-safe classification attached by the structure-phase pre-pass. Absent for every
   *  non-Mule file, so existing extractors stay source-compatible (`supports()` never inspects it). */
  classification?: FileClassification;
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
  /** per-file diagnostics produced during extraction (warnings/errors/info). Absent ⇒ none. The
   *  parse phase aggregates these across files into `ParseStats` in discovery order. */
  diagnostics?: ExtractDiagnostic[];
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

// ---------------------------------------------------------------------------
// MuleSoft extraction contracts (schema-agnostic, clone-safe).
//
// Mule is the first NON-source-language extractor: it ingests Mule 3/4 projects
// (XML config, DataWeave, RAML, descriptors, properties, MUnit) and emits the same
// graph vocabulary as the language extractors. Classification is attached to
// FileMeta by the structure-phase pre-pass (classifyMuleFiles) so `MuleExtractor.
// supports()` can dispatch disjointly from generic XML/resource files WITHOUT any
// extractor registration order sensitivity. All Mule types are optional on the
// shared contracts above so every existing extractor compiles unchanged.
// ---------------------------------------------------------------------------

/** The role a Mule file plays inside its project. Drives extractor dispatch + source policy. */
export type MuleFileRole =
  | 'config' // *.xml flow/config under src/main/mule (mule4) or src/main/app (mule3)
  | 'dataweave' // *.dwl / *.dw DataWeave module
  | 'mel' // *.mel MuleSoft Expression Language resource (Mule 3)
  | 'raml' // *.raml API contract (APIKit route source)
  | 'munit' // *.xml MUnit test under src/test/munit
  | 'descriptor' // pom.xml / mule-artifact.json / mule-deploy.properties
  | 'properties' // *.properties / *.yaml / *.yml config (keys-only; values redacted)
  | 'resource'; // any other classified file (static resources, keystores metadata, etc.)

/** Clone-safe (pure-data, no live references) classification stamped onto FileMeta. */
export interface FileClassification {
  /** always 'mule' — the dispatch key MuleExtractor.supports() checks. */
  family: 'mule';
  /** the detected Mule project this file belongs to (projectRoot, or '.' for the repo root). */
  projectId: string;
  /** repo-relative POSIX root of the detected Mule project ('' for the repo root itself). */
  projectRoot: string;
  /** Mule 3 vs Mule 4 — selects the dialect normalizer inside MuleExtractor. */
  dialect: 'mule3' | 'mule4';
  /** what kind of Mule artifact this file is — drives extractor sub-dispatch + source policy. */
  role: MuleFileRole;
  /** true for secure/encrypted property files + key/trust stores → source policy `deny`. */
  sensitive?: boolean;
}

/** A per-file diagnostic produced by a Mule (or future) extractor. Pure data; structuredClone-safe. */
export interface ExtractDiagnostic {
  /** stable code, e.g. 'mule:unsupported-expression', 'mule:ambiguous-dialect'. */
  code: string;
  /** 'error' halts nothing by itself — the rest of the project stays queryable; counted in summary. */
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** repo-relative path of the file that produced the diagnostic, when file-scoped. */
  file?: string;
  /** the Mule project the diagnostic belongs to (matches FileClassification.projectId). */
  projectId?: string;
  /** line span anchoring the diagnostic, when known. */
  span?: Span;
}
