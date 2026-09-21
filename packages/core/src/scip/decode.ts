/**
 * Decode a SCIP index into plain objects.
 *
 * FIELD NUMBERS ARE TRANSCRIBED FROM `scip.proto` (sourcegraph/scip, the schema under the open
 * steering committee since March 2026), not recalled. Each message below lists the numbers it reads
 * so a reviewer can diff this file against the proto without opening a decoder.
 *
 * READING IS LAZY AND PER-DOCUMENT. An index for a large repository is tens of megabytes and its
 * `Document.text` fields often hold entire source files. {@link readDocuments} yields one document at
 * a time over a subarray of the input, so peak memory tracks the largest single document rather than
 * the whole index. Callers that only need metadata never touch the documents at all.
 */
import { WIRE, appendInt32s, asString, fields } from './wire.js';

/** A 0-based half-open range, normalised from whichever of the four encodings the writer chose. */
export interface ScipRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/** `SymbolRole` bit flags (scip.proto `enum SymbolRole`). */
export const ROLE = {
  DEFINITION: 0x1,
  IMPORT: 0x2,
  WRITE_ACCESS: 0x4,
  READ_ACCESS: 0x8,
  GENERATED: 0x10,
  TEST: 0x20,
  FORWARD_DEFINITION: 0x40,
} as const;

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  documentation: string[];
  relationships: ScipRelationship[];
  /** `SymbolInformation.Kind` as its raw enum number; {@link SYMBOL_KIND_NAME} names the common ones. */
  kind: number;
  displayName: string;
  enclosingSymbol: string;
}

export interface ScipOccurrence {
  symbol: string;
  range?: ScipRange;
  enclosingRange?: ScipRange;
  roles: number;
  syntaxKind: number;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
  /** Present only when the indexer embedded source text; never required by this importer. */
  text: string;
}

export interface ScipMetadata {
  version: number;
  toolName: string;
  toolVersion: string;
  toolArguments: string[];
  projectRoot: string;
  textDocumentEncoding: number;
}

/** Normalise `SingleLineRange` (fields 1,2,3 = line, start_character, end_character). */
function singleLineRange(buf: Uint8Array): ScipRange {
  let line = 0;
  let startChar = 0;
  let endChar = 0;
  for (const f of fields(buf)) {
    if (f.no === 1) line = f.varint;
    else if (f.no === 2) startChar = f.varint;
    else if (f.no === 3) endChar = f.varint;
  }
  return { startLine: line, startChar, endLine: line, endChar };
}

/** Normalise `MultiLineRange` (fields 1..4 = start_line, start_character, end_line, end_character). */
function multiLineRange(buf: Uint8Array): ScipRange {
  const r: ScipRange = { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };
  for (const f of fields(buf)) {
    if (f.no === 1) r.startLine = f.varint;
    else if (f.no === 2) r.startChar = f.varint;
    else if (f.no === 3) r.endLine = f.varint;
    else if (f.no === 4) r.endChar = f.varint;
  }
  return r;
}

/**
 * Normalise the DEPRECATED packed form, `repeated int32 range`.
 *
 * This is not a legacy path in practice: every widely deployed indexer — scip-typescript, scip-java,
 * scip-go, scip-python, rust-analyzer's SCIP output — still writes field 1, because the typed
 * `oneof` was added later and the packed form remains valid. An importer that read only fields 8/9
 * would decode real indexes as having no ranges at all, which is why both are handled and why this
 * function is the one covered by a fixture test.
 *
 * Three elements mean a single line: `[line, startChar, endChar]`. Four mean `[startLine, startChar,
 * endLine, endChar]`. Any other arity is malformed and yields `undefined` rather than a guess.
 */
export function rangeFromPacked(values: readonly number[]): ScipRange | undefined {
  if (values.length === 3) {
    const [line, startChar, endChar] = values as [number, number, number];
    return { startLine: line, startChar, endLine: line, endChar };
  }
  if (values.length === 4) {
    const [startLine, startChar, endLine, endChar] = values as [number, number, number, number];
    return { startLine, startChar, endLine, endChar };
  }
  return undefined;
}

/** `Relationship`: 1 symbol, 2 is_reference, 3 is_implementation, 4 is_type_definition, 5 is_definition. */
function decodeRelationship(buf: Uint8Array): ScipRelationship {
  const rel: ScipRelationship = {
    symbol: '',
    isReference: false,
    isImplementation: false,
    isTypeDefinition: false,
    isDefinition: false,
  };
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        rel.symbol = asString(f);
        break;
      case 2:
        rel.isReference = f.varint !== 0;
        break;
      case 3:
        rel.isImplementation = f.varint !== 0;
        break;
      case 4:
        rel.isTypeDefinition = f.varint !== 0;
        break;
      case 5:
        rel.isDefinition = f.varint !== 0;
        break;
      default:
        break; // unknown field — skipped by the iterator
    }
  }
  return rel;
}

/**
 * `SymbolInformation`: 1 symbol, 3 documentation, 4 relationships, 5 kind, 6 display_name,
 * 7 signature_documentation, 8 enclosing_symbol. (Field 2 is not assigned in the proto.)
 *
 * `signature_documentation` is deliberately NOT decoded: it is a whole nested `Document`, and the
 * signature crib stores comes from its own extractors. Decoding it would multiply the cost of an
 * import for a field nothing downstream reads.
 */
function decodeSymbolInformation(buf: Uint8Array): ScipSymbolInformation {
  const info: ScipSymbolInformation = {
    symbol: '',
    documentation: [],
    relationships: [],
    kind: 0,
    displayName: '',
    enclosingSymbol: '',
  };
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        info.symbol = asString(f);
        break;
      case 3:
        info.documentation.push(asString(f));
        break;
      case 4:
        if (f.bytes) info.relationships.push(decodeRelationship(f.bytes));
        break;
      case 5:
        info.kind = f.varint;
        break;
      case 6:
        info.displayName = asString(f);
        break;
      case 8:
        info.enclosingSymbol = asString(f);
        break;
      default:
        break;
    }
  }
  return info;
}

/**
 * `Occurrence`: 1 range (deprecated packed), 2 symbol, 3 symbol_roles, 4 override_documentation,
 * 5 syntax_kind, 6 diagnostics, 7 enclosing_range (deprecated packed), 8 single_line_range,
 * 9 multi_line_range, 10 single_line_enclosing_range, 11 multi_line_enclosing_range.
 *
 * The typed `oneof` wins when present: it is unambiguous, whereas the packed form infers its arity.
 * Diagnostics are skipped — they describe the indexer's own analysis errors, not the code graph.
 */
function decodeOccurrence(buf: Uint8Array): ScipOccurrence {
  const occ: ScipOccurrence = { symbol: '', roles: 0, syntaxKind: 0 };
  const packed: number[] = [];
  const packedEnclosing: number[] = [];
  let typedRange: ScipRange | undefined;
  let typedEnclosing: ScipRange | undefined;
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        appendInt32s(f, packed);
        break;
      case 2:
        occ.symbol = asString(f);
        break;
      case 3:
        occ.roles = f.varint;
        break;
      case 5:
        occ.syntaxKind = f.varint;
        break;
      case 7:
        appendInt32s(f, packedEnclosing);
        break;
      case 8:
        if (f.bytes) typedRange = singleLineRange(f.bytes);
        break;
      case 9:
        if (f.bytes) typedRange = multiLineRange(f.bytes);
        break;
      case 10:
        if (f.bytes) typedEnclosing = singleLineRange(f.bytes);
        break;
      case 11:
        if (f.bytes) typedEnclosing = multiLineRange(f.bytes);
        break;
      default:
        break;
    }
  }
  const range = typedRange ?? rangeFromPacked(packed);
  const enclosing = typedEnclosing ?? rangeFromPacked(packedEnclosing);
  if (range) occ.range = range;
  if (enclosing) occ.enclosingRange = enclosing;
  return occ;
}

/** `Document`: 1 relative_path, 2 occurrences, 3 symbols, 4 language, 5 text, 6 position_encoding. */
function decodeDocument(buf: Uint8Array): ScipDocument {
  const doc: ScipDocument = {
    relativePath: '',
    language: '',
    occurrences: [],
    symbols: [],
    text: '',
  };
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        doc.relativePath = asString(f);
        break;
      case 2:
        if (f.bytes) doc.occurrences.push(decodeOccurrence(f.bytes));
        break;
      case 3:
        if (f.bytes) doc.symbols.push(decodeSymbolInformation(f.bytes));
        break;
      case 4:
        doc.language = asString(f);
        break;
      case 5:
        doc.text = asString(f);
        break;
      default:
        break;
    }
  }
  return doc;
}

/** `Metadata`: 1 version, 2 tool_info, 3 project_root, 4 text_document_encoding. */
function decodeMetadata(buf: Uint8Array): ScipMetadata {
  const meta: ScipMetadata = {
    version: 0,
    toolName: '',
    toolVersion: '',
    toolArguments: [],
    projectRoot: '',
    textDocumentEncoding: 0,
  };
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        meta.version = f.varint;
        break;
      case 2:
        if (f.bytes) {
          for (const t of fields(f.bytes)) {
            if (t.no === 1) meta.toolName = asString(t);
            else if (t.no === 2) meta.toolVersion = asString(t);
            else if (t.no === 3) meta.toolArguments.push(asString(t));
          }
        }
        break;
      case 3:
        meta.projectRoot = asString(f);
        break;
      case 4:
        meta.textDocumentEncoding = f.varint;
        break;
      default:
        break;
    }
  }
  return meta;
}

/** `Index` field 1 — the index's own metadata, or `undefined` when it carries none. */
export function readMetadata(buf: Uint8Array): ScipMetadata | undefined {
  for (const f of fields(buf)) {
    if (f.no === 1 && f.wire === WIRE.LENGTH && f.bytes) return decodeMetadata(f.bytes);
  }
  return undefined;
}

/** `Index` field 2 — the documents, yielded one at a time. */
export function* readDocuments(buf: Uint8Array): Generator<ScipDocument> {
  for (const f of fields(buf)) {
    if (f.no === 2 && f.wire === WIRE.LENGTH && f.bytes) yield decodeDocument(f.bytes);
  }
}

/**
 * `Index` field 3 — `external_symbols`: symbols DEFINED OUTSIDE this index that its documents refer
 * to. They carry documentation and relationships but no definition site here, so the importer uses
 * them to name and type cross-package references without minting definition nodes for them.
 */
export function* readExternalSymbols(buf: Uint8Array): Generator<ScipSymbolInformation> {
  for (const f of fields(buf)) {
    if (f.no === 3 && f.wire === WIRE.LENGTH && f.bytes) yield decodeSymbolInformation(f.bytes);
  }
}

/**
 * Cheap structural check: does this look like a SCIP index at all?
 *
 * A file that is not protobuf usually fails on the very first tag, so decoding one field is enough
 * to tell "wrong file" from "SCIP index" — and a caller can then say which it was instead of
 * reporting zero symbols imported.
 */
export function looksLikeScip(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  try {
    for (const f of fields(buf)) {
      // The first field of an Index is metadata (1) or a document (2); both are length-delimited.
      return (f.no === 1 || f.no === 2 || f.no === 3) && f.wire === WIRE.LENGTH;
    }
  } catch {
    return false;
  }
  return false;
}

/** Names for the `SymbolInformation.Kind` values a mapper cares about (scip.proto `enum Kind`). */
export const SYMBOL_KIND_NAME = new Map<number, string>([
  [7, 'class'],
  [9, 'constructor'],
  [11, 'enum'],
  [12, 'enum-member'],
  [15, 'field'],
  [17, 'function'],
  [18, 'getter'],
  [21, 'interface'],
  [25, 'macro'],
  [26, 'method'],
  [29, 'module'],
  [30, 'namespace'],
  [33, 'object'],
  [35, 'package'],
  [37, 'parameter'],
  [41, 'property'],
  [42, 'protocol'],
  [45, 'setter'],
  [49, 'struct'],
  [53, 'trait'],
  [54, 'type'],
  [55, 'type-alias'],
  [58, 'type-parameter'],
  [61, 'variable'],
  [8, 'constant'],
  [80, 'method'],
  [82, 'variable'],
]);
