/**
 * memory-1 migrations + the unknown-version fail-closed gate (PRD §2: "Use separate memory-1 JSON
 * schemas and explicit migrators. Unknown versions fail closed." + W2 exit gate).
 *
 * memory-1 is the FIRST version, so there is no prior version to migrate FROM yet. The migrator
 * table is therefore empty but STRUCTURED so a future `1 → 2` bump is a one-line addition: register
 * a `migrate1to2(raw)` and add `'1'` to the chain. The non-negotiable rule is that a record whose
 * `schemaVersion` is not in {@link SUPPORTED_MEMORY_SCHEMA_VERSIONS} is REFUSED by every loader —
 * it is never silently coerced, skipped, or re-stamped. This is the memory analogue of
 * `SoulStore.load`'s `SUPPORTED_SCHEMA_VERSIONS` refusal.
 */
import { MEMORY_SCHEMA_VERSION, SUPPORTED_MEMORY_SCHEMA_VERSIONS } from './types.js';

/** A migrator lifts a parsed record from `from` to `to`. Pure; returns a new object. */
export interface MemoryMigrator {
  from: string;
  to: string;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The migrator chain. Today: no-op (only `1` is supported). To add `2`: register a `1→2` migrator
 * and append `'2'` to `SUPPORTED_MEMORY_SCHEMA_VERSIONS` in types.ts. The loader walks the chain
 * from the record's declared version up to {@link MEMORY_SCHEMA_VERSION}.
 */
export const MEMORY_MIGRATORS: readonly MemoryMigrator[] = [];

/** True iff `version` is a supported memory schema version. */
export function isSupportedMemorySchemaVersion(version: unknown): boolean {
  return (
    typeof version === 'string' &&
    (SUPPORTED_MEMORY_SCHEMA_VERSIONS as readonly string[]).includes(version)
  );
}

/** Throw a typed error if `version` is unsupported — the fail-closed gate every loader calls. */
export function assertSupportedMemorySchemaVersion(version: unknown): void {
  if (!isSupportedMemorySchemaVersion(version)) {
    throw new MemorySchemaVersionError(
      typeof version === 'string' ? version : JSON.stringify(version),
    );
  }
}

/** Thrown when a record/manifest declares an unknown memory schema version. */
export class MemorySchemaVersionError extends Error {
  constructor(public readonly version: string) {
    super(
      `unsupported memory schemaVersion "${version}"; supported: ${SUPPORTED_MEMORY_SCHEMA_VERSIONS.join(', ')}`,
    );
    this.name = 'MemorySchemaVersionError';
  }
}

/**
 * Walk the migrator chain from a record's declared `schemaVersion` up to the current
 * {@link MEMORY_SCHEMA_VERSION}. Refuses unknown versions (fail closed). Pure: returns a new object.
 * Today this is the identity for `1`; it exists so the chain is wired before the first bump.
 */
export function migrateMemoryRecord(
  raw: Record<string, unknown>,
  fromVersion: string,
): Record<string, unknown> {
  assertSupportedMemorySchemaVersion(fromVersion);
  let current = raw;
  let version = fromVersion;
  while (version !== MEMORY_SCHEMA_VERSION) {
    const step = MEMORY_MIGRATORS.find((m) => m.from === version);
    if (!step) {
      // No forward step from a supported-but-not-latest version means the chain is incomplete —
      // refuse rather than silently stalling.
      throw new MemorySchemaVersionError(version);
    }
    current = step.migrate(current);
    version = step.to;
  }
  return current;
}
