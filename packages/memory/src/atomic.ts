/**
 * The durable write primitive belongs to `core` (`@knowledge-crib/core/atomic-write`); this module
 * re-exports it so the package keeps ONE implementation, shared with `SoulStore`.
 *
 * Before WP1 each package carried its OWN copy of the temp→rename pattern: `SoulStore.atomicWrite`
 * was a private method and this package vendored a second, identical one. WP1 obligation 2 ("flush
 * file contents before replacement … never report durable success after a persistence failure") is
 * a change that has to land in both, which is precisely the shape of change that gets applied to
 * one copy and forgotten in the other. So the implementation moved to the dependency-free core
 * leaf and both packages now write through it.
 *
 * The `./atomic.js` module path is deliberately KEPT rather than having every writer import the core
 * leaf directly: it is this package's own seam. `ack-after-persist.test.ts` and `graph-submit.test.ts`
 * mock `./atomic.js` to observe the store's write ordering, and the store's writers import it by
 * name. Re-exporting means those seams keep working and no caller changes.
 *
 * The contract — the three-valued {@link AtomicWriteDurability} capability, what the flushes flank
 * the rename for, and why a supported-but-failing barrier THROWS instead of degrading — is
 * documented in full at `packages/core/src/atomic-write.ts`.
 */
export {
  type AtomicWriteDurability,
  DurabilityError,
  appendLineDurable,
  atomicWriteDurability,
  writeJsonAtomic,
} from '@knowledge-crib/core/atomic-write';
