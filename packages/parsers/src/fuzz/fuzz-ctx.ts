import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
/**
 * M3.5 parser fuzzing — the ExtractCtx handed to extractors under fuzz.
 *
 * Mirrors `makeExtractCtx` (pipeline/src/extract-ctx.ts) EXACTLY — same `contentHash`, `idFor`,
 * `createParserHandle` — except `readText()` returns the fuzz input instead of reading a file. This
 * is deliberate: the extractor gets a REAL ctx (so PHP's tree-sitter path + the canonical id grammar
 * are exercised), only the input is adversarial. Stubbing the ctx would fuzz a different surface
 * than production sees.
 *
 * The fuzz worker builds one of these per input, so it must be cheap — `contentHash` + `idFor` are
 * pure functions, `createParserHandle` is a cheap handle over the preloaded Language. No fs, no state.
 */
import { createParserHandle } from '../tree-sitter-pool.js';
import type { ExtractCtx, ParserHandle } from '../types.js';

/** An ExtractCtx whose `readText()` yields the given (adversarial) text. */
export function makeFuzzCtx(text: string): ExtractCtx {
  return {
    async readText(): Promise<string> {
      return text;
    },
    treeSitter(grammar: string): ParserHandle {
      return createParserHandle(grammar);
    },
    hash(s: string): string {
      return contentHash(s);
    },
    idFor(kind: NodeKind, parts: Record<string, unknown>): string {
      return idFor({ kind, ...parts } as IdSpec);
    },
  };
}
