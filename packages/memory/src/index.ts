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
export * from './intake.js';
export * from './intake-projection.js';
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
export * from './aliases.js';
export * from './api.js';
export * from './vector-store.js';
export * from './handoff.js';
export * from './intelligence-events.js';
export * from './intelligence-projections.js';
export * from './identity-directory.js';
export * from './grounding.js';
export * from './locator.js';
export * from './evaluator.js';
export * from './ledger.js';
export * from './generation-cache.js';
export * from './recall.js';
export * from './fts-index.js';
export * from './persistent-fts.js';
export * from './fusion.js';
export * from './composite.js';
export * from './policy.js';
export * from './capture-policy.js';
export * from './outbox.js';
export * from './distill.js';
export * from './gate-runner.js';
export * from './promotion.js';
export * from './trusted-ref.js';
export * from './attempt.js';
export * from './tombstone.js';
export * from './feedback.js';
export * from './bench/metrics.js';
export * from './bench/corpus.js';
export * from './bench/heldout.js';
export * from './bench/scenarios.js';
export * from './bench/run.js';
export * from './bench/retrieval-eval.js';
export * from './sync/event.js';
export * from './sync/crypto.js';
export * from './sync/adapter.js';
export * from './sync/queue.js';
export * from './backup.js';
export * from './sync/policy.js';
export * from './sync/sync-conflicts.js';
export * from './sync/bootstrap.js';
export * from './sync/engine.js';
export * from './sync/stage.js';
