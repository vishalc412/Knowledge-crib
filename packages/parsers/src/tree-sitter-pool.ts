/**
 * The "shared parser pool for a vendored grammar" referenced by `ExtractCtx.treeSitter` (see
 * types.ts). `ExtractCtx.treeSitter(grammar): ParserHandle` is a SYNCHRONOUS contract, but
 * web-tree-sitter's `Parser.init()` / `Language.load()` are async (they load WASM). The seam:
 * `preloadGrammars` does the one-time async WASM load BEFORE extraction begins (pipeline's
 * `runParse` awaits it), then `createParserHandle` synchronously hands back a handle backed by the
 * already-loaded `Language` — matching the sync contract without changing it.
 *
 * Only grammars actually needed by files in THIS run are preloaded (see `grammarsNeededFor`), so a
 * repo with zero PHP files never pays the WASM engine boot cost — the whole point of a POOL rather
 * than an eager global init.
 *
 * `web-tree-sitter` is pinned to 0.20.x (NOT the current 0.26.x) because the vendored
 * `grammars/*.wasm` files are compiled against tree-sitter-cli 0.20's WASM ABI (the wasm dylink
 * format changed across major tree-sitter releases). Bumping this dependency without also
 * recompiling/re-vendoring every grammar in `grammars/` breaks `Language.load` at runtime with an
 * opaque "getDylinkMetadata" error — verified empirically when integrating the PHP grammar.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';
import type { FileMeta, ParserHandle } from './types.js';

/** Extensions handled by each vendored grammar. Single source of truth for both the extractor's
 *  own `supports()` and the pipeline's decision to preload that grammar at all. */
const GRAMMAR_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  php: ['.php'],
};

const GRAMMAR_FILES: Readonly<Record<string, string>> = {
  php: 'tree-sitter-php.wasm',
};

function grammarsDir(): string {
  // this file compiles to dist/tree-sitter-pool.js; grammars/ sits alongside dist/ and src/ at the
  // package root, so one level up from dist is the package root.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars');
}

/** Which vendored grammars (by name, e.g. "php") the given file set actually needs. */
export function grammarsNeededFor(files: readonly FileMeta[]): string[] {
  const needed: string[] = [];
  for (const [grammar, extensions] of Object.entries(GRAMMAR_EXTENSIONS)) {
    if (files.some((f) => extensions.some((ext) => f.path.endsWith(ext)))) needed.push(grammar);
  }
  return needed;
}

let initPromise: Promise<void> | undefined;
const loadedLanguages = new Map<string, Parser.Language>();

async function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

/**
 * Load (once, cached) every grammar in `names`. Idempotent — safe to call once per `crib index`
 * with exactly the grammars this run needs (see `grammarsNeededFor`); a no-op for `names: []` so a
 * repo with no tree-sitter-backed files never boots the WASM engine at all.
 */
export async function preloadGrammars(names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await ensureInitialized();
  for (const name of names) {
    if (loadedLanguages.has(name)) continue;
    const file = GRAMMAR_FILES[name];
    if (!file) throw new Error(`no vendored grammar for "${name}"`);
    const lang = await Parser.Language.load(join(grammarsDir(), file));
    loadedLanguages.set(name, lang);
  }
}

/**
 * Synchronously hand back a {@link ParserHandle} for an already-preloaded grammar. Throws with a
 * clear message if the grammar was never preloaded — a caller bug (missing `preloadGrammars` call),
 * not a runtime condition an extractor should degrade around.
 */
export function createParserHandle(grammar: string): ParserHandle {
  const lang = loadedLanguages.get(grammar);
  if (!lang) {
    throw new Error(
      `tree-sitter grammar "${grammar}" was not preloaded — call preloadGrammars(["${grammar}"]) before extraction`,
    );
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return {
    parse(source: string): unknown {
      return parser.parse(source);
    },
  };
}
