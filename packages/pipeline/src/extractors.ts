/**
 * The default extractor fleet — the SINGLE source of truth shared by `indexRepo` (full), `updateRepo`
 * (incremental), and the M3.4 parallel parse worker. Lives in its own module so the worker thread can
 * import JUST the fleet (and `@knowledge-crib/parsers`) without pulling all of `pipeline.ts`
 * (resolve/cfg/link/cluster/ownership/dossiers) into the worker isolate.
 *
 * Markdown first so doc files never fall through to a code extractor, then every language extractor
 * (TypeScript + PL/SQL + Python + Java + C# + Go + Rust + PHP). `Supports()` are disjoint by
 * extension, so the order is only load-bearing for `.md`. PHP (`.php`) is the only tree-sitter-backed
 * extractor; `runParse` preloads its grammar lazily — see `grammarsNeededFor` — so repos with no
 * `.php` files never pay the WASM boot cost.
 */
import {
  CsharpExtractor,
  GoExtractor,
  JavaExtractor,
  MarkdownExtractor,
  MuleExtractor,
  PhpExtractor,
  PlSqlExtractor,
  PythonExtractor,
  RustExtractor,
  TypeScriptExtractor,
} from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';

export function defaultExtractors(): Extractor[] {
  return [
    new MarkdownExtractor(),
    new TypeScriptExtractor(),
    new PlSqlExtractor(),
    new PythonExtractor(),
    new JavaExtractor(),
    new CsharpExtractor(),
    new GoExtractor(),
    new RustExtractor(),
    new PhpExtractor(),
    // MuleSoft — the first non-source-language extractor. `supports()` is disjoint (family === 'mule'
    // set by the discovery classifier), so it never competes with a code extractor; appended last so a
    // repo with no Mule files pays nothing. Property VALUES are never stored (keys + references only).
    new MuleExtractor(),
  ];
}
