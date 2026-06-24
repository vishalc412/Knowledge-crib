/**
 * @knowledge-crib/core — SoulStore (source of truth) + conflict rule + manifest + validation.
 * IndexStore lands at M1.
 */
export * from './soul-store.js';
export * from './conflict-rule.js';
export * from './manifest.js';
export * from './shard.js';
export * from './validate.js';
export * from './index-store.js';
export { SqliteIndexStore } from './index/sqlite-index.js';
export { KuzuIndexStore } from './index/kuzu-index.js';
export { openIndex } from './index/factory.js';
