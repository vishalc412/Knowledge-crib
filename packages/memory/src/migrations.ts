import type { Verdicts } from './enums.js';
import { derivePropositionKey, memoryAliasId, memoryRecordV2Id } from './ids.js';
/**
 * memory-1 → memory-2 migration + the unknown-version fail-closed gate (PRD §2: "Use separate
 * memory-1 JSON schemas and explicit migrators. Unknown versions fail closed." + W2 exit gate +
 * Gate 1 G1.2).
 *
 * Two DISTINCT migration paths, deliberately different in one respect — what happens to the id:
 *
 *   1. **The loader chain** ({@link MEMORY_MIGRATORS} + {@link migrateMemoryRecord}): an IN-PLACE
 *      upgrade a retired version takes on read. The loader's contract is that a line's id is STABLE
 *      across migration (loader.ts reassigns it after the walk), so every pre-migration decision/
 *      feedback keeps resolving WITHOUT an alias map. memory-1 is still LIVE
 *      (`LIVE_MEMORY_SCHEMA_VERSIONS`), so the chain never walks a v1 line today; the `1→2` step is
 *      registered now so the chain is complete the day v1 retires.
 *   2. **The store rewrite pass** ({@link MemoryStore.migrateToV2}): the explicit
 *      `read v1, write v2` rewrite. It RE-SEEDS the record's id from the memory-2 content seed
 *      (`claimBodyV2`, ids.ts — placement/provenance/time excluded, so repeated observations
 *      dedupe across writers). The re-seed is what orphans every legacy-keyed `dec:`/`fb:` event,
 *      which is why the pass MUST persist the legacy-ID alias map
 *      ({@link migrateRecordV1ToV2} → {@link MemoryAlias}) — the map is load-bearing, not cosmetic.
 *
 * The non-negotiable rule for BOTH paths: a record whose `schemaVersion` is not in
 * {@link SUPPORTED_MEMORY_SCHEMA_VERSIONS} is REFUSED by every loader — never silently coerced,
 * skipped, or re-stamped. This is the memory analogue of `SoulStore.load`'s refusal.
 */
import {
  MEMORY_SCHEMA_VERSION,
  type MemoryAlias,
  type MemoryRecord,
  type MemoryRecordV2,
  SUPPORTED_MEMORY_SCHEMA_VERSIONS,
} from './types.js';

/** A migrator lifts a parsed record from `from` to `to`. Pure; returns a new object. */
export interface MemoryMigrator {
  from: string;
  to: string;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

// ─── migration provenance (G1.1 envelope defaults from v1 authorship + env) ────

/**
 * Local-first provenance defaults (G1.1(c): the global store is DEVICE-global until sync ships, so
 * the defaults are per-device constants, overridable by env). `principalId` is OWNERSHIP and
 * `deviceId`/`clientId` are provenance — none of them is an access boundary (types.ts).
 */
export const DEFAULT_MIGRATION_PRINCIPAL_ID = 'principal:local';
export const DEFAULT_MIGRATION_DEVICE_ID = 'device:local';
export const DEFAULT_MIGRATION_CLIENT_ID = 'crib';

/** Which retention policy a migrated record defaults to (no retention policies are committed
 *  anywhere yet — policy.ts holds gate profiles, not retention schedules — so the migration defines
 *  the constant and a future retention-policy registry owns the id). */
export const DEFAULT_RETENTION_POLICY_ID = 'ret:default';

/** Explicit env/config overrides for the derived provenance (absent → derive, see below). */
export interface MigrationProvenanceOverrides {
  principalId?: string;
  deviceId?: string;
  clientId?: string;
}

/** The fully-resolved memory-2 provenance {@link migrateRecordV1ToV2} stamps. */
export interface MigrationProvenance {
  principalId: string;
  deviceId: string;
  actorId: string;
  /** present iff the v1 authorship kind is 'agent' (a human attestation has no agent). */
  agentId?: string;
  clientId: string;
  tool?: string;
}

/**
 * Derive a memory-2 {@link MigrationProvenance} from a memory-1 record's authorship + env config.
 * The derivation (documented per the G1.2 spec):
 *
 *   - `actorId` ← `authorship.actor` (the actor identity, human or agent, as authored);
 *   - `agentId` ← `authorship.actor` IFF `authorship.kind === 'agent'` (absent for humans);
 *   - `tool`    ← `authorship.tool` (the client tool that produced the claim, when authored);
 *   - `clientId` ← override → `KCRIB_CLIENT_ID` env → `authorship.tool` → `'crib'` (v1 records no
 *     client; the authoring tool is the closest honest proxy);
 *   - `principalId` ← override → `KCRIB_PRINCIPAL_ID` env → `'principal:local'` (local-first
 *     ownership default until sync supplies a real principal);
 *   - `deviceId` ← override → `KCRIB_DEVICE_ID` env → `'device:local'` (device-global, not
 *     user-global — G1(c));
 *   - `sessionId` is deliberately ABSENT — v1 has no session notion and fabricating one would be
 *     provenance noise.
 *
 * PURE over its inputs (no clock, no randomness); the derived provenance never enters the record's
 * content id, so a later env change re-migrates to the SAME id.
 */
export function migrationProvenance(
  authorship: { actor: string; kind: string; tool?: string },
  overrides: MigrationProvenanceOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): MigrationProvenance {
  const principalId =
    overrides.principalId ?? env.KCRIB_PRINCIPAL_ID ?? DEFAULT_MIGRATION_PRINCIPAL_ID;
  const deviceId = overrides.deviceId ?? env.KCRIB_DEVICE_ID ?? DEFAULT_MIGRATION_DEVICE_ID;
  const clientId =
    overrides.clientId ?? env.KCRIB_CLIENT_ID ?? authorship.tool ?? DEFAULT_MIGRATION_CLIENT_ID;
  const agent = authorship.kind === 'agent';
  return {
    principalId,
    deviceId,
    actorId: authorship.actor,
    ...(agent ? { agentId: authorship.actor } : {}),
    clientId,
    ...(authorship.tool !== undefined ? { tool: authorship.tool } : {}),
  };
}

/** A non-empty string meta value, or `undefined` (v1 `meta` is an open record; only a real
 *  non-empty override should pin the proposition key). */
function metaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

// ─── the pure record rewrite ─────────────────────────────────────────────────

/** One memory-1 → memory-2 rewrite: the re-seeded v2 record + its alias. */
export interface RecordMigration {
  record: MemoryRecordV2;
  alias: MemoryAlias;
}

/**
 * Rewrite one memory-1 record into the memory-2 envelope (G1.1 field set) + its legacy-ID alias.
 * PURE and fully deterministic — every output field is a function of the record + provenance, with
 * NO clock input, so re-migrating the same record re-derives byte-identical output (idempotent
 * migration) and the alias upsert is a no-op.
 *
 * Field mapping (the G1.2 contract):
 *   - `id` — RE-SEEDED from the v2 content seed (`memoryRecordV2Id`): placement, provenance, and
 *     both time axes are excluded so repeated observations still dedupe cross-writer. The old id
 *     survives in the alias (and on the v1 line itself — v1 stays loadable).
 *   - `propositionKey` — the G1.1 derivation ({@link derivePropositionKey}); a non-empty
 *     `meta.propositionKey` override wins (trimmed, verbatim).
 *   - `validTime.from` / `transactionTime` — the record's `createdAt` verbatim. Re-stamping the
 *     migration's wall-clock would break both determinism and idempotency, and the store learned
 *     the CLAIM at `createdAt` — the v2 twin is a schema re-statement of the same claim, not new
 *     knowledge. The alias map is the migration's own audit trail.
 *   - `visibility` — `'workspace'` (a memory-store record was shared within its scope by
 *     construction; 'private' is the v2 capture default for NEW observations, not a migration
 *     inference).
 *   - `sensitivity` — `'internal'` (the conservative default; nothing in v1 classifies higher).
 *   - `retentionPolicyId` — {@link DEFAULT_RETENTION_POLICY_ID}.
 *   - `lineage` — EMPTY. Migration never FABRICATES relationships: a heuristic v1 conflict pair
 *     (two records sharing subject+scope) migrates to two COEXISTING claims, because declaring
 *     `contradicts` is an author's assertion, not a migrator's inference.
 *   - `evidence` — carried verbatim (per-item verdicts are the stamped truth both versions read).
 *   - `scope`/`appliesTo`/`verdicts`/`meta` — have NO v2 counterpart in the closed envelope, so
 *     they travel in the ALIAS binding (types.ts MemoryAlias): the verdict axes are the v2 read
 *     projection's base snapshot, and `scope`/`appliesTo`/`meta` make the as-believed v1 state
 *     recoverable after a local/global migration REPLACES the v1 line (the twin alone cannot
 *     reconstruct them — placement became `visibility`, and `appliesTo` targets are not all
 *     evidence soulIds). `meta` is copied only when present (the v1 field is optional).
 */
export function migrateRecordV1ToV2(
  record: MemoryRecord,
  provenance: MigrationProvenance,
): RecordMigration {
  const propositionKey = derivePropositionKey({
    subject: record.subject,
    propositionKey: metaString(record.meta?.propositionKey),
  });
  const v2: MemoryRecordV2 = {
    id: memoryRecordV2Id({
      kind: record.kind,
      subject: record.subject,
      propositionKey,
      claim: record.claim,
      evidence: record.evidence,
    }),
    schemaVersion: '2',
    visibility: 'workspace',
    kind: record.kind,
    subject: record.subject,
    propositionKey,
    claim: record.claim,
    validTime: { from: record.createdAt },
    transactionTime: { observedAt: record.createdAt, recordedAt: record.createdAt },
    evidence: record.evidence,
    provenance,
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: DEFAULT_RETENTION_POLICY_ID,
  };
  const alias: MemoryAlias = {
    id: memoryAliasId({ legacyId: record.id, resolvedId: v2.id }),
    schemaVersion: '1',
    legacyId: record.id,
    resolvedId: v2.id,
    verdicts: record.verdicts as Verdicts,
    // the v1 state the closed envelope drops — recoverable from the binding (idempotent: the
    // alias id seeds {legacyId, resolvedId} only, so enriching the binding never moves it)
    scope: record.scope,
    appliesTo: record.appliesTo,
    ...(record.meta !== undefined ? { meta: record.meta } : {}),
  };
  return { record: v2, alias };
}

// ─── the migrator chain ──────────────────────────────────────────────────────

/** Narrow an unknown line to the memory-1 authorship shape the chain step reads. */
function chainAuthorship(raw: Record<string, unknown>): {
  actor: string;
  kind: string;
  tool?: string;
} {
  const authorship = raw.authorship as
    | { actor?: unknown; kind?: unknown; tool?: unknown }
    | undefined;
  if (
    authorship === null ||
    typeof authorship !== 'object' ||
    typeof authorship.actor !== 'string' ||
    typeof authorship.kind !== 'string'
  ) {
    throw new Error('1→2 chain step: record has no usable authorship (not a memory-1 record)');
  }
  return {
    actor: authorship.actor,
    kind: authorship.kind,
    ...(typeof authorship.tool === 'string' ? { tool: authorship.tool } : {}),
  };
}

/**
 * The `1 → 2` chain step. The LOADER's in-place upgrade: rewrites the envelope but PRESERVES the
 * line's id (the loader reassigns it after the walk regardless), so a retired v1 shard upgrades in
 * place and every legacy-keyed decision/feedback keeps resolving without the alias map. The
 * id-RE-SEEDING rewrite is the explicit store pass (`MemoryStore.migrateToV2`), which pairs with
 * {@link migrateRecordV1ToV2} + the alias map.
 */
const MIGRATE_1_TO_2: MemoryMigrator = {
  from: '1',
  to: '2',
  migrate: (raw): Record<string, unknown> => {
    const provenance = migrationProvenance(chainAuthorship(raw));
    const { record } = migrateRecordV1ToV2(raw as unknown as MemoryRecord, provenance);
    return { ...record, id: raw.id as string };
  },
};

/**
 * The migrator chain. `1→2` is registered here (G1.2) and paired with the legacy-ID alias map; it
 * does NOT engage while `1` is in {@link SUPPORTED_MEMORY_SCHEMA_VERSIONS} AND live — the loader
 * validates live versions in place and only walks a SUPPORTED-but-retired version. The step fires
 * the day memory-1 retires from `LIVE_MEMORY_SCHEMA_VERSIONS` and `MEMORY_SCHEMA_VERSION` bumps to
 * `'2'`.
 */
export const MEMORY_MIGRATORS: readonly MemoryMigrator[] = [MIGRATE_1_TO_2];

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
 * While memory-1 is live AND current, this is the identity for `'1'`; a future `MEMORY_SCHEMA_VERSION
 * === '2'` walks a retired `'1'` through {@link MIGRATE_1_TO_2}.
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
