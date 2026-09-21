/**
 * `crib scip import` / `crib scip export` — interop with the SCIP Code Intelligence Protocol (F7).
 *
 * WHAT THIS BUYS. The project maintains 11 hand-written extractors, one of which (TypeScript) uses a
 * real type-checker; the SCIP ecosystem has compiler-backed indexers for Java, Scala, Kotlin, Go,
 * Rust, Python, Ruby, C/C++, Dart and C#. Importing an index adds that language's symbols and
 * compiler-grade resolution to the graph without a parser to maintain. Exporting makes the graph
 * readable by anything that already speaks the standard.
 *
 * WHY IMPORT IS ADDITIVE AND NEVER REPLACES. An import calls `putNodes`/`putEdges` — the same write
 * path the native extractors use — so nodes land in the EXTRACTED layer and merge by id. When crib
 * already parses the language, an imported symbol collides with the native node on the same id and
 * the native one wins (`putNodes` keeps the existing record), leaving only the imported EDGES as new
 * information. That is the intended outcome: the compiler-resolved call graph is the part worth
 * importing, and the node a local parser built from actual source text is the better node.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { looksLikeScip, scipToSoul, soulToScip } from '@knowledge-crib/core';
import { EXIT, type ResolvedRoot, isIndexedRoot, openSoul } from './runtime.js';

/** Read a `--flag value` pair. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `crib scip import <index.scip> [--prefix <path>] [--dry-run] [--json]` */
function cmdScipImport(args: string[], resolved: ResolvedRoot): number {
  // The index path is a POSITIONAL, and it is NOT a project root (F15): `crib scip import x.scip`
  // must never be read as "serve the project at ./x.scip".
  const file = args.find((a) => !a.startsWith('--') && a !== flag(args, '--prefix'));
  if (!file) {
    process.stderr.write(
      'usage: crib scip import <index.scip> [--prefix <path>] [--dry-run] [--json]\n',
    );
    return EXIT.BAD_ARGS;
  }
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first, then import alongside it\n');
    return EXIT.NOT_INDEXED;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(resolve(file)));
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${(e as Error).message}\n`);
    return EXIT.BAD_ARGS;
  }
  if (!looksLikeScip(bytes)) {
    // Naming the real problem beats reporting "imported 0 symbols" from a file that was never an
    // index — the most likely mistake here is handing over a JSON dump or a gzipped index.
    process.stderr.write(
      [
        `${file} does not decode as a SCIP index (its first field is not a protobuf message).`,
        '  A SCIP index is the binary protobuf written by an indexer, e.g. `scip-typescript index`,',
        '  `scip-java index`, `scip-go`. If the file is gzipped, decompress it first.',
        '',
      ].join('\n'),
    );
    return EXIT.BAD_ARGS;
  }

  const prefix = flag(args, '--prefix');
  const result = scipToSoul(bytes, prefix ? { pathPrefix: prefix } : {});
  const dryRun = args.includes('--dry-run');
  if (!dryRun) {
    const rt = openSoul(resolved);
    if (result.nodes.length > 0) rt.soul.putNodes(result.nodes);
    if (result.edges.length > 0) rt.soul.putEdges(result.edges);
    rt.soul.commit();
  }

  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: result.tool,
          dryRun,
          nodes: result.nodes.length,
          edges: result.edges.length,
          counts: result.counts,
          notes: result.notes,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }
  const c = result.counts;
  const version = result.tool.version ? ` ${result.tool.version}` : '';
  process.stdout.write(
    [
      `${dryRun ? 'would import' : 'imported'} ${c.definitions} definition(s) and ${result.edges.length} edge(s) from ${result.tool.name}${version}`,
      `  documents ${c.documents}, references ${c.references}, relationships ${c.relationshipEdges}`,
      // The notes are the honest part of this report — each one names something the import could not
      // represent, so they print unconditionally rather than behind a --verbose flag.
      ...result.notes.map((n) => `  note: ${n}`),
      dryRun
        ? '  (--dry-run: nothing was written)'
        : '  run `crib index` to refresh the derived index',
      '',
    ].join('\n'),
  );
  return EXIT.OK;
}

/** `crib scip export [--out <index.scip>] [--json]` */
function cmdScipExport(args: string[], resolved: ResolvedRoot): number {
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const nodes = [...rt.soul.iterate()];
  const edges = [...rt.soul.iterateEdges()];
  const manifest = rt.soul.getManifest();
  const result = soulToScip(nodes, edges, {
    projectRoot: resolved.repoRoot,
    package: { name: manifest.repo?.id ?? '' },
    toolVersion: manifest.schemaVersion ?? '',
  });
  const out = flag(args, '--out') ?? 'index.scip';
  writeFileSync(resolve(resolved.repoRoot, out), result.bytes);

  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ out, bytes: result.bytes.length, counts: result.counts, notes: result.notes }, null, 2)}\n`,
    );
    return EXIT.OK;
  }
  process.stdout.write(
    `wrote ${out} — ${result.counts.documents} document(s), ${result.counts.symbols} symbol(s), ` +
      `${result.counts.occurrences} occurrence(s), ${result.counts.relationships} relationship(s), ` +
      `${result.bytes.length} bytes\n` +
      `${result.notes.map((n) => `  note: ${n}\n`).join('')}`,
  );
  return EXIT.OK;
}

/** `crib scip <import|export>` */
export function cmdScip(args: string[], resolved: ResolvedRoot): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'import':
      return cmdScipImport(rest, resolved);
    case 'export':
      return cmdScipExport(rest, resolved);
    default:
      process.stderr.write(
        'usage: crib scip <import <index.scip> [--prefix <path>] [--dry-run] | export [--out <file>]> [--json]\n' +
          '  import: fold a SCIP index from a compiler-backed indexer into the extracted graph\n' +
          '  export: emit the graph as a SCIP index for tools that read the standard\n',
      );
      return EXIT.BAD_ARGS;
  }
}
