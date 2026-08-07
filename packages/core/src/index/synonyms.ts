/**
 * Lightweight hybrid retrieval (P2): a small, curated, deterministic synonym table for common
 * code-domain verbs/nouns, expanded into the FTS5 MATCH expression at query time.
 *
 * This deliberately is NOT a neural embedding model — no weights to bundle, no inference cost, no
 * network call, no GPU. It is a few hundred bytes of static data that closes the most common
 * conceptual-search gap pure lexical BM25 has: a query for "save" does not match code named
 * "persist"/"write"/"commit" because they share no substring. Expanding the query (not the index)
 * keeps the index schema and rebuild cost unchanged — this only changes which `MATCH` terms are
 * OR-joined for a given query string.
 *
 * Real (vector) embeddings remain on the roadmap for queries this table can't cover (e.g. true
 * paraphrase / cross-language concept matching); this is the zero-dependency floor underneath that,
 * not a replacement for it.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['save', 'persist', 'store', 'write', 'commit'],
  ['get', 'fetch', 'read', 'load', 'retrieve'],
  ['delete', 'remove', 'erase', 'prune', 'purge'],
  ['create', 'build', 'make', 'construct'],
  ['update', 'modify', 'change', 'mutate', 'patch'],
  ['validate', 'check', 'verify', 'assert'],
  ['parse', 'extract', 'decode'],
  ['search', 'query', 'find', 'lookup'],
  ['error', 'exception', 'failure', 'fail'],
  ['config', 'configuration', 'settings', 'options'],
  ['start', 'init', 'initialize', 'begin'],
  ['stop', 'end', 'finish', 'terminate', 'close'],
  ['send', 'emit', 'dispatch', 'publish'],
  ['receive', 'consume', 'subscribe', 'listen'],
  ['convert', 'transform', 'map'],
  ['merge', 'combine', 'join'],
  ['split', 'divide', 'separate'],
  ['list', 'array', 'collection'],
  ['auth', 'authentication', 'authorize', 'authorization'],
  ['user', 'account', 'member'],
];

const LOOKUP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const set = new Set(group);
    for (const word of group) map.set(word, set);
  }
  return map;
})();

/**
 * Expand one lowercase-folded token to itself plus its synonym group, if any. Pure + deterministic:
 * a token with no group maps to itself only, so callers never need a fallback branch.
 */
export function expandToken(token: string): readonly string[] {
  const group = LOOKUP.get(token.toLowerCase());
  return group ? [...group] : [token];
}
