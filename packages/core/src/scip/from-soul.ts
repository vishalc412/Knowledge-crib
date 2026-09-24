/**
 * Emit a SCIP index from the soul graph — the export half of F7.
 *
 * WHY EXPORT AT ALL, given the importer is the coverage win. Because it makes the graph legible to
 * tools nobody here will ever write an adapter for. A SCIP index is what Sourcegraph, an editor's
 * precise-navigation backend, and any future consumer of the standard already read; emitting one
 * turns `.crib/graph` from a private format into something an ecosystem can consume. It is also the
 * honest test of the importer: a round-trip that loses information shows exactly WHERE the two models
 * disagree, and that disagreement is documented below rather than discovered by a consumer.
 *
 * THE ONE FIDELITY LIMIT THAT CANNOT BE ENGINEERED AWAY: CRIB SPANS ARE LINES, SCIP RANGES ARE
 * CHARACTERS. A soul node records `span: {start, end}` in lines — the extractors never retain column
 * offsets. A SCIP `Occurrence` range is `[line, startCharacter, endCharacter]`. So an exported
 * definition occurrence starts at character 0 and spans the declaration's first line: correct as to
 * WHICH line declares the symbol, and deliberately coarse as to where in that line the name sits. A
 * consumer doing go-to-definition lands on the right line; one drawing a highlight over the name
 * cannot, and {@link scipExportNotes} says so rather than letting it look precise.
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { type ScipDescriptor, formatScipSymbol } from './symbol.js';
import { Writer } from './wire.js';

/** The scheme this exporter stamps. Must not be empty nor start with `local` (scip.proto grammar). */
export const CRIB_SCHEME = 'knowledge-crib';

export interface ScipExportOptions {
  /** Absolute path to the repository root, emitted as `Metadata.project_root`. */
  projectRoot: string;
  /** Package identity for every exported symbol. `.` is the documented empty-value placeholder. */
  package?: { manager?: string; name?: string; version?: string };
  /** Version string for `ToolInfo`, so a consumer can tell which crib wrote the index. */
  toolVersion?: string;
}

export interface ScipExportResult {
  bytes: Uint8Array;
  counts: { documents: number; symbols: number; occurrences: number; relationships: number };
  notes: string[];
}

/** `SymbolInformation.Kind` numbers for the crib node `type` values worth mapping. */
const KIND_NO = new Map<string, number>([
  ['class', 7],
  ['constructor', 9],
  ['enum', 11],
  ['field', 15],
  ['function', 17],
  ['getter', 18],
  ['interface', 21],
  ['macro', 25],
  ['method', 26],
  ['module', 29],
  ['namespace', 30],
  ['property', 41],
  ['setter', 45],
  ['struct', 49],
  ['trait', 53],
  ['type', 54],
  ['type-alias', 55],
  ['variable', 61],
  ['constant', 8],
]);

/** A crib `type` that denotes a callable, for choosing the `method` descriptor suffix. */
const CALLABLE = new Set(['function', 'method', 'constructor', 'getter', 'setter', 'macro']);
/** A crib `type` that denotes a type declaration, for the `type` (`#`) suffix. */
const TYPELIKE = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type', 'type-alias']);

/**
 * Build the SCIP symbol string for a soul node.
 *
 * Descriptors are the file path (one namespace descriptor PER SEGMENT, as indexers emit) followed by
 * the qualified name's segments. The LAST segment takes a suffix derived from the node's type so a
 * consumer can tell a method from a class; the intermediate segments are types, which is the correct
 * reading of `Outer.Inner.method` and the one that round-trips through {@link qualifiedNameOf}.
 *
 * REUSES THE INDEXER'S OWN SYMBOL WHEN THERE IS ONE. A node imported from SCIP carries its original
 * symbol string in `meta.scip.symbol`; re-exporting that verbatim makes import→export idempotent and
 * keeps a symbol stable across a tool that indexed it and crib that stored it.
 */
export function scipSymbolFor(node: Node, opts: ScipExportOptions): string {
  const carried = (node.meta as { scip?: { symbol?: unknown } } | undefined)?.scip?.symbol;
  if (typeof carried === 'string' && carried !== '') return carried;

  const path = node.file ?? '';
  const qualified = node.qualifiedName ?? node.name ?? '';
  const segments = qualified.split('.').filter((s) => s !== '');
  const descriptors: ScipDescriptor[] = [];
  // ONE NAMESPACE DESCRIPTOR PER PATH SEGMENT, which is what indexers emit: `src/app.ts/Service#`,
  // not a single descriptor holding `src/app.ts`. A `/` inside a descriptor name would have to be
  // backtick-escaped, producing `` `src/app.ts`/ `` — valid, but different byte-for-byte from every
  // other index in existence and therefore not comparable to one.
  for (const segment of path.split('/')) {
    if (segment !== '') descriptors.push({ name: segment, suffix: 'namespace' });
  }
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (!last) {
      descriptors.push({ name: segment, suffix: 'type' });
      return;
    }
    const type = node.type ?? '';
    if (CALLABLE.has(type)) descriptors.push({ name: segment, suffix: 'method' });
    else if (TYPELIKE.has(type)) descriptors.push({ name: segment, suffix: 'type' });
    else descriptors.push({ name: segment, suffix: 'term' });
  });
  if (descriptors.length === 0) descriptors.push({ name: node.id, suffix: 'term' });
  return formatScipSymbol({
    scheme: CRIB_SCHEME,
    package: {
      manager: opts.package?.manager ?? '',
      name: opts.package?.name ?? '',
      version: opts.package?.version ?? '',
    },
    descriptors,
    local: false,
  });
}

/**
 * Encode a soul graph as a SCIP index.
 *
 * Only `symbol` nodes are exported, grouped by file. Doc sections, clusters, tables, owners and the
 * sub-symbol detail kinds have no SCIP counterpart — SCIP describes code symbols and their
 * occurrences, and inventing symbols for a markdown heading would produce an index that other tools
 * would have to special-case. What is dropped is counted and reported.
 */
export function soulToScip(
  nodes: readonly Node[],
  edges: readonly Edge[],
  opts: ScipExportOptions,
): ScipExportResult {
  const symbols = nodes.filter((n) => n.kind === 'symbol' && n.file);
  const byFile = new Map<string, Node[]>();
  for (const node of symbols) {
    const list = byFile.get(node.file as string);
    if (list) list.push(node);
    else byFile.set(node.file as string, [node]);
  }
  // A symbol string per node id, so edges can name their endpoints.
  const symbolOf = new Map<string, string>();
  for (const node of symbols) symbolOf.set(node.id, scipSymbolFor(node, opts));

  // Relationships, from the edges SCIP can express.
  //
  // WHY `references` EDGES ARE NOT EXPORTED AT ALL — the one real loss in this direction. SCIP
  // expresses a reference as an OCCURRENCE, which is a position: file, line, character range. A crib
  // edge records that symbol A references symbol B and carries no call-site position (`Edge` has
  // src/dst/rel/method/confidence/evidence — no line). The only position available is A's own
  // declaration line, and writing that would put a reference at line 42 when the call is at line 57.
  // A consumer cannot tell an approximate position from an exact one, so find-references over this
  // index would silently point at the wrong lines. Omitting them keeps every position in the exported
  // index true; `scipExportNotes` states the omission so it is a documented subset, not a surprise.
  const relationships = new Map<string, Array<{ symbol: string; implementation: boolean }>>();
  let relationshipCount = 0;
  for (const edge of edges) {
    if (edge.rel !== 'implements' && edge.rel !== 'inherits') continue;
    const from = symbolOf.get(edge.src);
    const to = symbolOf.get(edge.dst);
    if (!from || !to) continue;
    const list = relationships.get(edge.src) ?? [];
    list.push({ symbol: to, implementation: true });
    relationships.set(edge.src, list);
    relationshipCount += 1;
  }

  const counts = { documents: 0, symbols: 0, occurrences: 0, relationships: relationshipCount };
  // crib `lang` tags SCIP has no enum member for. Collected so the report can name them.
  const unnamedLanguages = new Set<string>();
  const index = new Writer();

  // ── Metadata (Index field 1) ───────────────────────────────────────────────
  index.message(1, (meta) => {
    // ProtocolVersion has exactly one member, `UnspecifiedProtocolVersion = 0`, which proto3 omits.
    meta.message(2, (tool) => {
      tool.string(1, 'knowledge-crib');
      tool.string(2, opts.toolVersion ?? '');
    });
    meta.string(3, opts.projectRoot);
    meta.int32(4, 1); // TextEncoding.UTF8
  });

  // ── Documents (Index field 2) ──────────────────────────────────────────────
  for (const [path, fileNodes] of [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    counts.documents += 1;
    index.message(2, (doc) => {
      doc.string(1, path);
      const lang = fileNodes.find((n) => n.lang)?.lang;
      const scipLang = lang ? scipLanguageName(lang) : undefined;
      if (scipLang) doc.string(4, scipLang);
      else if (lang) unnamedLanguages.add(lang);
      // Occurrences (Document field 2) — one definition per symbol node.
      for (const node of fileNodes) {
        const symbol = symbolOf.get(node.id) as string;
        const line0 = Math.max(0, (node.span?.start ?? 1) - 1);
        doc.message(2, (occ) => {
          // Field 1, the deprecated packed form, is what every deployed reader supports; the typed
          // `oneof` was added later. Emitting the widely-read encoding maximises who can consume this.
          occ.packedInt32(1, [line0, 0, 0]);
          occ.string(2, symbol);
          occ.int32(3, 0x1); // SymbolRole.Definition
          const end0 = Math.max(line0, (node.span?.end ?? node.span?.start ?? 1) - 1);
          // `enclosing_range` (field 7) carries the declaration's full extent, which crib DOES know
          // in lines — so the part of the span that survives the model gap is still exported.
          if (end0 > line0) occ.packedInt32(7, [line0, 0, end0, 0]);
        });
        counts.occurrences += 1;
      }
      // SymbolInformation (Document field 3) — name, docs and relationships per symbol.
      for (const node of fileNodes) {
        const symbol = symbolOf.get(node.id) as string;
        doc.message(3, (info) => {
          info.string(1, symbol);
          const kind = KIND_NO.get(node.type ?? '');
          if (kind) info.int32(5, kind);
          info.string(6, node.name ?? node.qualifiedName ?? '');
          if (node.signature) info.message(7, (sig) => sig.string(5, node.signature as string));
          for (const rel of relationships.get(node.id) ?? []) {
            info.message(4, (r) => {
              r.string(1, rel.symbol);
              if (rel.implementation) r.int32(3, 1);
            });
          }
        });
        counts.symbols += 1;
      }
    });
  }

  return {
    bytes: index.finish(),
    counts,
    notes: scipExportNotes(nodes, counts, unnamedLanguages),
  };
}

/**
 * SCIP `Language` enum member NAMES, which `Document.language` carries as a string.
 *
 * SPELLED EXACTLY AS `scip.proto` SPELLS THEM — `PLSQL` and `JSON`, not `Plsql` and `Json`. A
 * capitalise-the-first-letter fallback looks harmless and is not: it emitted `Plsql` for this
 * repository's PL/SQL documents while the enum member `PLSQL` existed, producing a value no consumer
 * recognises for a language every consumer supports.
 *
 * A tag with NO enum counterpart (crib indexes `mule` and `properties`, which SCIP does not name)
 * leaves the field UNSET rather than inventing a member. An unset optional field is a consumer
 * reading "language unspecified", which is true; a made-up member is a value that looks recognised
 * and is not. {@link scipExportNotes} reports how many documents that affected.
 */
const SCIP_LANGUAGE: Record<string, string> = {
  typescript: 'TypeScript',
  ts: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  js: 'JavaScript',
  jsx: 'JSX',
  python: 'Python',
  py: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  scala: 'Scala',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  csharp: 'CSharp',
  cs: 'CSharp',
  php: 'PHP',
  swift: 'Swift',
  dart: 'Dart',
  elixir: 'Elixir',
  c: 'C',
  cpp: 'CPP',
  sql: 'SQL',
  plsql: 'PLSQL',
  markdown: 'Markdown',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML',
  toml: 'TOML',
  ini: 'Ini',
  shell: 'Shell',
  sh: 'Shell',
};

/** The SCIP enum member for a crib `lang` tag, or undefined when the standard does not name it. */
function scipLanguageName(lang: string): string | undefined {
  return SCIP_LANGUAGE[lang.toLowerCase()];
}

/** What the export could not carry. Printed by `crib scip export`, never suppressed. */
export function scipExportNotes(
  nodes: readonly Node[],
  counts: ScipExportResult['counts'],
  unnamedLanguages: ReadonlySet<string> = new Set(),
): string[] {
  const notes: string[] = [
    'ranges are LINE-accurate and character-coarse: crib stores line spans, so every exported occurrence starts at character 0 — go-to-definition lands on the right line, a name-width highlight cannot',
  ];
  const skipped = nodes.filter((n) => n.kind !== 'symbol').length;
  if (skipped > 0) {
    notes.push(
      `${skipped} non-symbol node(s) (doc sections, clusters, tables, owners, sub-symbol detail) were not exported — SCIP describes code symbols and has no counterpart for them`,
    );
  }
  const noFile = nodes.filter((n) => n.kind === 'symbol' && !n.file).length;
  if (noFile > 0) {
    notes.push(`${noFile} symbol node(s) had no file and could not be placed in a Document`);
  }
  if (unnamedLanguages.size > 0) {
    notes.push(
      `SCIP names no language for ${[...unnamedLanguages].sort().join(', ')}, so those documents carry no language tag — inventing an enum member would produce a value that looks recognised and is not`,
    );
  }
  if (counts.relationships === 0) {
    notes.push(
      'no `implements`/`inherits` edges were present, so the index carries no SymbolInformation relationships',
    );
  }
  notes.push(
    'the index carries DEFINITIONS and subtype relationships, not references: a SCIP reference is a position (file/line/character) and a crib edge records the relationship without the call site, so exporting one would put provably wrong positions in a file other tools read — go-to-definition and type hierarchy work, find-references does not',
  );
  return notes;
}
