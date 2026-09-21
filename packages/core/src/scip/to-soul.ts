/**
 * Map a SCIP index onto soul nodes and edges — the import half of F7.
 *
 * WHY THIS EXISTS. Coverage is the project's structural disadvantage: 11 hand-written extractors, of
 * which one (TypeScript) uses a real type-checker, against an ecosystem of compiler-backed SCIP
 * indexers for Java, Scala, Kotlin, Go, Rust, Python, Ruby, C/C++, Dart and C#. Consuming SCIP buys
 * that coverage without maintaining a parser per language, and it buys COMPILER-GRADE resolution for
 * languages where the native extractor resolves by identifier at best.
 *
 * THE DESIGN DECISION THAT MATTERS: IDS ARE MINTED IN CRIB'S OWN GRAMMAR, not carried from SCIP.
 * A symbol imported for a file crib also parses lands on the SAME id as the native node
 * (`sym:<path>#<qualifiedName>@L<line>`), so an import MERGES with the native graph instead of
 * shadowing it — one node with edges from both sources, not two nodes describing one function. The
 * cost is that the mapping must reproduce crib's naming conventions from SCIP descriptors, which is
 * what {@link qualifiedNameOf} does and what the fixture tests pin.
 *
 * FOUR LIMITS, STATED RATHER THAN PAPERED OVER. Each is reported in {@link ScipImportResult} so a
 * caller can print it instead of implying a clean import:
 *
 *  1. A REFERENCE IS A REFERENCE, NEVER A CALL. SCIP records that a symbol occurs at a position; it
 *     does not distinguish invoking a function from naming it. Emitting `calls` would fabricate a
 *     distinction the format does not carry, so every occurrence-derived edge is `references` — which
 *     `impact` still traverses, because the traversal is rel-agnostic.
 *  2. CROSS-PACKAGE TARGETS ARE COUNTED, NOT MINTED. A reference to a symbol defined outside this
 *     index (a dependency) has no definition site to point at. Minting a node per external symbol
 *     would add the whole dependency closure to the graph, so those edges are dropped and counted as
 *     `externalReferences`.
 *  3. LOCALS ARE SKIPPED. `local <id>` symbols are Document-scoped by specification and carry no
 *     cross-file meaning; importing them would inflate the node count with the same sub-symbol detail
 *     the discovery surface already excludes.
 *  4. SPANS ARE DEFINITION EXTENTS ONLY WHEN THE INDEXER SAID SO. Crib spans cover a whole
 *     declaration; a SCIP definition occurrence covers only the NAME. `enclosing_range` carries the
 *     full extent, and indexers that omit it leave a one-line span — recorded honestly rather than
 *     guessed by re-parsing the file.
 */
import { type Edge, type Node, contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import {
  ROLE,
  SYMBOL_KIND_NAME,
  type ScipDocument,
  type ScipMetadata,
  type ScipRange,
  type ScipSymbolInformation,
  readDocuments,
  readMetadata,
} from './decode.js';
import { type ScipSymbol, parseScipSymbol, qualifiedNameOf, terminalSuffix } from './symbol.js';

/** What an import produced, and everything it could not represent. */
export interface ScipImportResult {
  nodes: Node[];
  edges: Edge[];
  /** The indexer that wrote the file, for the provenance stamped on every imported edge. */
  tool: { name: string; version: string };
  counts: {
    documents: number;
    definitions: number;
    /** Occurrence-derived `references` edges kept (target defined inside this index). */
    references: number;
    /** References dropped because the target is defined outside this index. */
    externalReferences: number;
    /** `local <id>` occurrences skipped by design. */
    locals: number;
    /** Symbol strings that did not satisfy the grammar — skipped rather than guessed. */
    unparseable: number;
    /** Definition occurrences with no range, which cannot be given a line-keyed id. */
    rangeless: number;
    relationshipEdges: number;
  };
  /** Human-readable qualifications on the numbers above. Never empty when something was dropped. */
  notes: string[];
}

/** A definition discovered in pass 1, keyed by its SCIP symbol string. */
interface Definition {
  nodeId: string;
  path: string;
  range: ScipRange;
  enclosing?: ScipRange;
}

/** SCIP is 0-based; crib line numbers are 1-based everywhere in the id grammar. */
const line1 = (line0: number): number => line0 + 1;

/** Does `range` contain the start position of `inner`? Used to attribute a reference to its owner. */
function contains(range: ScipRange, inner: ScipRange): boolean {
  if (inner.startLine < range.startLine || inner.startLine > range.endLine) return false;
  if (inner.startLine === range.startLine && inner.startChar < range.startChar) return false;
  if (inner.startLine === range.endLine && inner.startChar > range.endChar) return false;
  return true;
}

/** The area a range covers, in characters-on-one-line units — for picking the INNERMOST owner. */
function extent(range: ScipRange): number {
  const lines = range.endLine - range.startLine;
  return lines * 10_000 + (range.endChar - range.startChar);
}

/**
 * Crib's node `type` for a SCIP symbol: the indexer's `Kind` when it set one, else the descriptor
 * suffix. `Kind` is richer (it separates `method` from `function` from `getter`), but it is optional,
 * and many indexers only populate it for documents they have full type information for.
 */
function nodeType(info: ScipSymbolInformation | undefined, symbol: ScipSymbol): string {
  const byKind = info ? SYMBOL_KIND_NAME.get(info.kind) : undefined;
  if (byKind) return byKind;
  switch (terminalSuffix(symbol)) {
    case 'method':
      return 'method';
    case 'type':
      return 'class';
    case 'term':
      return 'variable';
    case 'namespace':
      return 'module';
    case 'macro':
      return 'macro';
    default:
      return 'symbol';
  }
}

/**
 * Language tag for a node. SCIP `Document.language` uses the `Language` enum's NAMES as strings
 * ("TypeScript", "Java", "Go"), which are lowercased here to match what the native extractors write.
 */
function langOf(doc: ScipDocument): string | undefined {
  return doc.language ? doc.language.toLowerCase() : undefined;
}

/** An imported edge, stamped so its origin is legible in the committed graph. */
function importedEdge(
  src: string,
  dst: string,
  rel: 'references' | 'implements' | 'member-of',
  tool: string,
): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    // `static`: a SCIP indexer resolves with the language's own compiler or type-checker, which is
    // the same standard of evidence the TypeScript extractor's `static` edges meet. The METHOD_RANK
    // ordering then lets the conflict rule prefer either over an identifier-matched guess.
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    // `by` names the INDEXER, not this importer: when an edge is wrong, the tool that resolved it is
    // the thing a reader needs to know.
    evidence: { by: `scip:${tool}` },
  };
}

/**
 * Build soul records from an encoded SCIP index.
 *
 * TWO PASSES OVER THE BUFFER, DELIBERATELY. A reference in document 1 may target a symbol defined in
 * document 900, so definitions must all be known before references resolve. The alternative — one
 * pass buffering every unresolved reference — holds O(references) strings in memory, which on a large
 * repository is the larger cost; decoding twice holds only the definition table, and an import is a
 * one-time operation. `Document.text` is what makes a SCIP index big, and neither pass retains it.
 */
export function scipToSoul(buf: Uint8Array, opts: { pathPrefix?: string } = {}): ScipImportResult {
  const metadata: ScipMetadata | undefined = readMetadata(buf);
  const tool = {
    name: metadata?.toolName || 'unknown',
    version: metadata?.toolVersion || '',
  };
  const prefix = opts.pathPrefix ? opts.pathPrefix.replace(/\/*$/, '/') : '';
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const definitions = new Map<string, Definition>();
  const counts = {
    documents: 0,
    definitions: 0,
    references: 0,
    externalReferences: 0,
    locals: 0,
    unparseable: 0,
    rangeless: 0,
    relationshipEdges: 0,
  };

  // ── pass 1: definitions become nodes ───────────────────────────────────────
  for (const doc of readDocuments(buf)) {
    counts.documents += 1;
    const path = prefix + doc.relativePath;
    const lang = langOf(doc);
    const fileId = idFor({ kind: 'file', path });
    nodes.set(fileId, {
      id: fileId,
      kind: 'file',
      hash: contentHash(`scip:file:${path}`),
      file: path,
      ...(lang ? { lang } : {}),
    });

    const infoBySymbol = new Map(doc.symbols.map((s) => [s.symbol, s]));
    for (const occ of doc.occurrences) {
      if ((occ.roles & ROLE.DEFINITION) === 0) continue;
      const symbol = parseScipSymbol(occ.symbol);
      if (!symbol) {
        counts.unparseable += 1;
        continue;
      }
      if (symbol.local) {
        counts.locals += 1;
        continue;
      }
      if (!occ.range) {
        counts.rangeless += 1;
        continue;
      }
      const qualifiedName = qualifiedNameOf(symbol);
      if (qualifiedName === '') {
        counts.unparseable += 1;
        continue;
      }
      const startLine = line1(occ.range.startLine);
      const nodeId = idFor({ kind: 'symbol', path, qualifiedName, startLine });
      const info = infoBySymbol.get(occ.symbol);
      // The declaration extent when the indexer provided one, else the name's own line.
      const span = occ.enclosingRange
        ? { start: line1(occ.enclosingRange.startLine), end: line1(occ.enclosingRange.endLine) }
        : { start: startLine, end: line1(occ.range.endLine) };
      if (!nodes.has(nodeId)) {
        nodes.set(nodeId, {
          id: nodeId,
          kind: 'symbol',
          // Keyed by the symbol's IDENTITY, not its body: the importer never reads source, so it
          // cannot hash content. A re-import of an unchanged index reproduces the same hash.
          hash: contentHash(`scip:${occ.symbol}`),
          file: path,
          span,
          ...(lang ? { lang } : {}),
          type: nodeType(info, symbol),
          name: symbol.descriptors.at(-1)?.name ?? qualifiedName,
          qualifiedName,
          ...(info?.displayName ? { signature: info.displayName } : {}),
          meta: { scip: { symbol: occ.symbol, tool: tool.name, kind: info?.kind ?? 0 } },
        });
        counts.definitions += 1;
      }
      definitions.set(occ.symbol, {
        nodeId,
        path,
        range: occ.range,
        ...(occ.enclosingRange ? { enclosing: occ.enclosingRange } : {}),
      });
      // Every symbol belongs to the file that declares it — the same edge the native extractors emit.
      const memberEdge = importedEdge(nodeId, fileId, 'member-of', tool.name);
      edges.set(memberEdge.id, memberEdge);
    }
  }

  // ── pass 2: references and declared relationships become edges ─────────────
  for (const doc of readDocuments(buf)) {
    const path = prefix + doc.relativePath;
    const fileId = idFor({ kind: 'file', path });
    // Definitions in THIS document, for attributing a reference to the symbol that encloses it.
    const owners = [...definitions.values()]
      .filter((d) => d.path === path)
      .map((d) => ({ def: d, area: extent(d.enclosing ?? d.range) }))
      .sort((a, b) => a.area - b.area);

    for (const occ of doc.occurrences) {
      if ((occ.roles & ROLE.DEFINITION) !== 0) continue;
      if (!occ.range) continue;
      const target = definitions.get(occ.symbol);
      if (!target) {
        // Either an external (dependency) symbol or a local one. Both are expected; distinguishing
        // them keeps the report honest about WHICH kind of coverage is missing.
        if (occ.symbol.startsWith('local ')) counts.locals += 1;
        else counts.externalReferences += 1;
        continue;
      }
      // The innermost definition whose extent contains this position owns the reference. With no
      // enclosing ranges in the index, nothing contains it and the FILE becomes the source — a
      // coarser but true statement ("this file references that symbol").
      const owner = owners.find(({ def }) =>
        contains(def.enclosing ?? def.range, occ.range as ScipRange),
      );
      const src = owner?.def.nodeId ?? fileId;
      if (src === target.nodeId) continue; // a symbol referencing itself carries no information
      const edge = importedEdge(src, target.nodeId, 'references', tool.name);
      if (!edges.has(edge.id)) {
        edges.set(edge.id, edge);
        counts.references += 1;
      }
    }

    // `SymbolInformation` carries relationships the indexer asserts directly — subtyping above all,
    // which occurrence data alone cannot express.
    for (const info of doc.symbols) {
      const self = definitions.get(info.symbol);
      if (!self) continue;
      if (info.enclosingSymbol) {
        const parent = definitions.get(info.enclosingSymbol);
        if (parent && parent.nodeId !== self.nodeId) {
          const edge = importedEdge(self.nodeId, parent.nodeId, 'member-of', tool.name);
          if (!edges.has(edge.id)) {
            edges.set(edge.id, edge);
            counts.relationshipEdges += 1;
          }
        }
      }
      for (const rel of info.relationships) {
        const other = definitions.get(rel.symbol);
        if (!other || other.nodeId === self.nodeId) continue;
        // `is_implementation` is the one relationship with an exact crib counterpart. The others
        // (`is_reference`, `is_type_definition`) are both "mentions in a type position", which is
        // `references` — the same rel occurrence data yields, so they de-duplicate against it.
        const kind = rel.isImplementation ? 'implements' : 'references';
        const edge = importedEdge(self.nodeId, other.nodeId, kind, tool.name);
        if (!edges.has(edge.id)) {
          edges.set(edge.id, edge);
          counts.relationshipEdges += 1;
        }
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    tool,
    counts,
    notes: importNotes(counts, metadata),
  };
}

/**
 * The qualifications that belong with the numbers.
 *
 * A report that printed only "imported 12,043 symbols" would read as complete coverage. Each note
 * below fires only when the thing it describes actually happened, so an import with nothing dropped
 * says so and one with 40% of its references unresolved cannot hide it.
 */
function importNotes(
  counts: ScipImportResult['counts'],
  metadata: ScipMetadata | undefined,
): string[] {
  const notes: string[] = [];
  if (!metadata) {
    notes.push(
      'the index carries no Metadata block, so the indexer and its project root are unknown — imported paths are trusted as-is',
    );
  }
  if (counts.externalReferences > 0) {
    notes.push(
      `${counts.externalReferences} reference(s) point at symbols defined OUTSIDE this index (dependencies); no node exists for them, so those edges were dropped rather than inventing the dependency closure`,
    );
  }
  if (counts.unparseable > 0) {
    notes.push(
      `${counts.unparseable} symbol string(s) did not satisfy the SCIP grammar and were skipped — a partially parsed symbol would have produced a wrong node id`,
    );
  }
  if (counts.rangeless > 0) {
    notes.push(
      `${counts.rangeless} definition(s) carried no range, so no line-keyed id could be minted for them`,
    );
  }
  if (counts.locals > 0) {
    notes.push(
      `${counts.locals} document-local symbol(s) skipped by design (SCIP 'local' symbols carry no cross-file meaning)`,
    );
  }
  notes.push(
    'every occurrence-derived edge is `references`, never `calls`: SCIP records that a symbol occurs at a position and does not distinguish invoking it from naming it',
  );
  return notes;
}
