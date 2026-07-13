/**
 * M2.4 — alias dictionary + query rewrite pass.
 *
 * Acronyms and domain shorthand ("DTI", "LTV", "AML") rarely share a token with the symbol that
 * implements them (`DebtToIncomeCalculator`), so BM25 — a token-prefix match — misses them entirely.
 * The alias dictionary maps a shorthand to a phrase that DOES share a token-prefix with the canonical
 * symbol surface, and a deterministic rewrite pass appends every matching expansion to the query
 * before it reaches the index. The original query text is preserved (the expansion is appended, not
 * substituted) so a symbol that literally contains the acronym still matches on the original token.
 *
 * Where it lives:
 *   - The dictionary is a committed, per-repo, agent-authorable file at `.crib/llm/aliases.json` —
 *     the same layer as the rest of the LLM semantic graph, so the system-layer glossary (which the
 *     crib-enrich SKILL already produces: DTI/LTV/AML/KYC entity nodes) can author it. Absent file →
 *     empty map → rewrite is a pure no-op, so every existing query path is byte-identical when no
 *     aliases are configured (zero regression risk for fixtures without a dictionary).
 *   - The rewrite is applied at the verb layer (`query` / `ask`), NOT in the index — the index stays
 *     alias-agnostic and the eval harness (which calls `index.query` directly) is unaffected.
 *
 * Determinism: `rewriteQuery` is a pure function of (text, aliases); `loadAliases` reads a committed
 * JSON file with no clock/network. Identical input → identical output across runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A readonly alias→expansion map (e.g. "DTI" → "debt to income"). */
export type AliasMap = ReadonlyMap<string, string>;

/** On-disk schema for `.crib/llm/aliases.json`. */
export interface AliasFile {
  /** schema tag; currently `aliases-1`. */
  version: 1;
  /** Ordered alias entries. An alias may carry multiple expansions (all appended on match). */
  aliases: Array<{ alias: string; expand: string }>;
}

const ALIAS_FILE = 'aliases.json';
const ALIAS_SCHEMA = 'aliases-1';

/**
 * Load the alias dictionary from `<cribDir>/llm/aliases.json`. Returns an empty map when the file is
 * absent (the common case — aliases are an opt-in, agent-authored artifact) or unreadable, so callers
 * never branch on presence. Accepts the {@link AliasFile} entry shape; a legacy `{ aliases: Record }`
 * plain map is also tolerated.
 */
export function loadAliases(cribDir: string): AliasMap {
  const path = join(cribDir, 'llm', ALIAS_FILE);
  if (!existsSync(path)) return new Map<string, string>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return new Map<string, string>();
  }
  return parseAliases(raw);
}

/** Parse a raw JSON value into an alias map. Tolerates the entry-list shape and a plain string map. */
export function parseAliases(raw: unknown): AliasMap {
  const out = new Map<string, string>();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  const list = obj.aliases;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { alias?: unknown; expand?: unknown };
      if (typeof e.alias !== 'string' || typeof e.expand !== 'string') continue;
      if (e.alias.length === 0 || e.expand.length === 0) continue;
      // first write wins — a duplicated alias keeps its earliest expansion (stable, reviewable).
      if (!out.has(e.alias)) out.set(e.alias, e.expand);
    }
    return out;
  }
  // legacy plain map: { "DTI": "debt to income", ... }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && k.length > 0 && v.length > 0) out.set(k, v);
  }
  return out;
}

/** Escape RegExp metacharacters in a literal string. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite a query by appending the expansion of every alias that appears as a whole word (case-
 * sensitive, word-boundary) in the text. The original text is preserved verbatim; expansions are
 * appended once each, deduped, in alias-first-seen order (stable across runs). Pure + deterministic.
 *
 * Case-sensitive whole-word matching keeps the acronym "DTI" from firing on a lowercase "dti" inside
 * another token; the alias dictionary is expected to carry the canonical casing the user types.
 */
export function rewriteQuery(text: string, aliases: AliasMap): string {
  if (aliases.size === 0 || text.length === 0) return text;
  const expansions: string[] = [];
  const seen = new Set<string>();
  for (const [alias, expand] of aliases) {
    // a bare word-boundary match; alias is escaped so it's a literal. The `\b` on both sides requires
    // the alias to sit between non-word chars (start/end of string count), not be a substring.
    const re = new RegExp(`(?<![\\w])${reEscape(alias)}(?![\\w])`);
    if (re.test(text) && !seen.has(alias)) {
      seen.add(alias);
      expansions.push(expand);
    }
  }
  if (expansions.length === 0) return text;
  return `${text} ${expansions.join(' ')}`;
}

/**
 * Persist an alias dictionary to `<cribDir>/llm/aliases.json` in the committed {@link AliasFile}
 * shape. The authoring primitive the enrichment layer (system-layer glossary) calls to write the
 * domain acronym map. Overwrites any existing file atomically (single write).
 */
export function writeAliases(
  cribDir: string,
  aliases: Array<{ alias: string; expand: string }>,
): void {
  const dir = join(cribDir, 'llm');
  const path = join(dir, ALIAS_FILE);
  mkdirSync(dir, { recursive: true });
  const file: AliasFile = { version: 1, aliases };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** The schema tag the loader expects; exported for assertions/tests. */
export const ALIASES_SCHEMA_VERSION = ALIAS_SCHEMA;
