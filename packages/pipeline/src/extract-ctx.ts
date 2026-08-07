/**
 * The ExtractCtx implementation handed to every extractor. Lives in `pipeline` (the spec puts the
 * contract types in parsers and the implementation here) so it can bind to fs + the id grammar.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createParserHandle } from '@knowledge-crib/parsers';
import type { ExtractCtx, ParserHandle } from '@knowledge-crib/parsers';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';

export function makeExtractCtx(repoRoot: string, relPath: string): ExtractCtx {
  let cached: string | undefined;
  return {
    async readText(): Promise<string> {
      if (cached === undefined) cached = await readFile(join(repoRoot, relPath), 'utf8');
      return cached;
    },
    treeSitter(grammar: string): ParserHandle {
      // synchronous by contract; backed by the pool `runParse` preloaded before extraction began
      // (see `grammarsNeededFor` / `preloadGrammars` in tree-sitter-pool.ts).
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
