import { CsharpExtractor } from '../csharp/CsharpExtractor.js';
import { GoExtractor } from '../go/GoExtractor.js';
import { JavaExtractor } from '../java/JavaExtractor.js';
import { MarkdownExtractor } from '../md/MarkdownExtractor.js';
import { PhpExtractor } from '../php/PhpExtractor.js';
import { PlSqlExtractor } from '../plsql/PlSqlExtractor.js';
import { PythonExtractor } from '../python/PythonExtractor.js';
import { RustExtractor } from '../rust/RustExtractor.js';
import { TypeScriptExtractor } from '../ts/TypeScriptExtractor.js';
/**
 * M3.5 parser fuzzing — the extractor fleet under fuzz.
 *
 * One spec per shipped extractor: the constructor (so the worker can build it by name after the
 * message boundary — class instances can't be sent across an isolate) + a canonical file extension
 * (so the fuzz FileMeta's `path` ends with an ext the extractor's `supports()` matches — otherwise
 * the registry wouldn't route to it and we'd fuzz nothing).
 *
 * The fuzz harness identifies an extractor by `ctor.name` (the JS class name) — deterministic, and
 * decoupled from the production `Extractor.name` field (which a malformed extractor could lie about).
 */
import type { Extractor } from '../types.js';

export interface FuzzExtractorSpec {
  /** identifier sent across the worker boundary = the JS class name. */
  name: string;
  /** builds a fresh extractor instance (extractors hold no per-run state that must persist). */
  ctor: new () => Extractor;
  /** file extension for the fuzz FileMeta.path so `supports()` matches. */
  ext: string;
}

/** The 9 shipped extractors, fuzzed in M3.5. */
export const FUZZ_EXTRACTORS: readonly FuzzExtractorSpec[] = [
  { name: MarkdownExtractor.name, ctor: MarkdownExtractor, ext: '.md' },
  { name: TypeScriptExtractor.name, ctor: TypeScriptExtractor, ext: '.ts' },
  { name: PlSqlExtractor.name, ctor: PlSqlExtractor, ext: '.pkb' },
  { name: PythonExtractor.name, ctor: PythonExtractor, ext: '.py' },
  { name: JavaExtractor.name, ctor: JavaExtractor, ext: '.java' },
  { name: CsharpExtractor.name, ctor: CsharpExtractor, ext: '.cs' },
  { name: GoExtractor.name, ctor: GoExtractor, ext: '.go' },
  { name: RustExtractor.name, ctor: RustExtractor, ext: '.rs' },
  { name: PhpExtractor.name, ctor: PhpExtractor, ext: '.php' },
];
