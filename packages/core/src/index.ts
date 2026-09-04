/**
 * @knowledge-crib/core — SoulStore (source of truth) + conflict rule + manifest + validation.
 * IndexStore lands at M1.
 */
export * from './soul-store.js';
export * from './graph-layout.js';
export * from './graph-store.js';
export * from './working-overlay.js';
export * from './materialize.js';
export * from './conflict-rule.js';
export * from './manifest.js';
export * from './shard.js';
export * from './delta.js';
export * from './rename.js';
export * from './merge.js';
export * from './memory-kinds.js';
export * from './memory-merge.js';
export * from './validate.js';
export * from './source.js';
export * from './source-policy.js';
export * from './importance.js';
export * from './lock.js';
export * from './cluster-hash.js';
export * from './llm-overlay.js';
export * from './functional-map.js';
export * from './aliases.js';
export * from './ifhash.js';
export * from './dossier/index.js';
export * from './index-store.js';
export * from './federation.js';
export { SqliteIndexStore } from './index/sqlite-index.js';
export { KuzuIndexStore } from './index/kuzu-index.js';
export { openIndex } from './index/factory.js';
export * from './embeddings/types.js';
export { CharNgramEmbedder, cosine, decodeVec, encodeVec } from './embeddings/char-ngram.js';
export { resolveEmbedder, isDefaultProvider } from './embeddings/provider.js';
export * from './embeddings/embed-install.js';
export * from './embeddings/remote.js';
export * from './embeddings/tier.js';
export * from './rules/index.js';
export * from './llm-prune.js';
