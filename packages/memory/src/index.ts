/**
 * @knowledge-crib/memory — the trusted agent-memory ledger.
 *
 * The `memory-1` schema, content-addressed records, validators, manifest, migrations, strict
 * loaders, canonical serialization, and the secret scanner. Deliberately OUTSIDE the soul's closed
 * `NodeKind` enum (PRD boundary #2): agent-authored claims have their own schema, lifecycle,
 * evidence, trust, and migration rules. The stores (local repo / global / team) and the freshness
 * engine layer on top of these primitives (Slice 2 + Slice 3).
 *
 * Leaf-ish contract package: depends on `@knowledge-crib/soul-schema` (blake3 + shard primitives)
 * and `@knowledge-crib/core` (the W0 memory kinds + lock/atomic-write/SoulStore read API for the
 * stores). The claim/decision kinds are re-exported from `core` (they stay there because the W0
 * merge driver — pure, in `core` — needs them, and moving them here would cycle `core ↔ memory`).
 */
export * from './types.js';
export * from './enums.js';
export * from './ids.js';
export * from './schemas.js';
export * from './validate.js';
export * from './manifest.js';
export * from './migrations.js';
export * from './serialization.js';
export * from './loader.js';
export * from './secrets.js';
export * from './paths.js';
export * from './atomic.js';
export * from './store.js';
export * from './grounding.js';
export * from './locator.js';
export * from './evaluator.js';
export * from './recall.js';
