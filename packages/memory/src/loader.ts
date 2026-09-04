/**
 * The strict memory loader (PRD W2: "strict loaders" + exit gate "unknown schemas fail closed").
 *
 * Two pure primitives the stores (Slice 2) layer atomic writes + locks on top of:
 *   - {@link loadMemoryManifestJson}: parse + version-gate + validate a manifest. Unknown
 *     `schemaVersion` → `MemorySchemaVersionError` (fail closed). A missing manifest is NOT an
 *     error — the store treats it as "uninitialized" and creates a fresh one.
 *   - {@link parseMemoryShard}: parse a JSONL shard strictly. Unlike the W0 merge driver's opaque
 *     `parseMemoryChunk` (which only requires a string `id`), the loader runs full schema validation
 *     per line via {@link assertValidMemoryEntry} and migrates a record whose `schemaVersion` is an
 *     older supported version up to `memory-1`. A malformed or unknown-version line is recorded as
 *     an error rather than silently dropped (a silent skip could erase a committed claim).
 *
 * The W0 merge driver stays opaque on purpose: it is pure, lives in `core`, and must not depend on
 * this package. The loader here is the read/validate path the store uses; the merge driver is the
 * merge path git uses. Both agree on "JSON object with a string content-addressed id".
 */
import {
  MemorySchemaVersionError,
  assertSupportedMemorySchemaVersion,
  migrateMemoryRecord,
} from './migrations.js';
import { LIVE_MEMORY_SCHEMA_VERSIONS, type MemoryManifest } from './types.js';
import { assertValidMemoryEntry, assertValidMemoryManifest } from './validate.js';

/** One parsed shard line: the validated entry, or an error for a rejected line. */
export type MemoryShardLine =
  | { ok: true; entry: Record<string, unknown> }
  | { ok: false; error: string };

export interface ParsedMemoryShard {
  entries: Record<string, unknown>[];
  /** `source:line: reason` for each rejected line (empty when the shard is clean). */
  errors: string[];
}

/**
 * Parse + validate a memory JSONL shard. Blank lines are ignored. Every non-blank line MUST be a
 * JSON object with a string `id` whose prefix is a known memory kind, AND it must pass that kind's
 * schema (records dispatch on the declared `schemaVersion`: memory-1 and memory-2 are both LIVE and
 * validated in place — see LIVE_MEMORY_SCHEMA_VERSIONS). A line carrying a SUPPORTED but retired
 * `schemaVersion` is migrated up before validation; any other line → an error (never a silent
 * skip, a silent skip could erase a committed claim).
 */
export function parseMemoryShard(text: string, source: string): ParsedMemoryShard {
  const entries: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const lines = text.length === 0 ? [] : text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const loc = `${source}:${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      errors.push(`${loc}: ${(err as Error).message ?? 'invalid JSON'}`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${loc}: not a JSON object`);
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.id !== 'string' || obj.id.length === 0) {
      errors.push(`${loc}: missing or non-string 'id'`);
      continue;
    }
    // Live versions (memory-1 + memory-2 today) validate in place; a SUPPORTED but retired version
    // migrates up before validation; unknown versions fail closed below.
    const declared = obj.schemaVersion;
    const live = (LIVE_MEMORY_SCHEMA_VERSIONS as readonly string[]).includes(
      typeof declared === 'string' ? declared : '',
    );
    if (declared !== undefined && !live) {
      try {
        assertSupportedMemorySchemaVersion(declared);
        obj.id; // touch — id is stable across migration
        const migrated = migrateMemoryRecord(obj, declared as string);
        // preserve the (unchanged) id; migrateMemoryRecord returns a fresh object
        (migrated as Record<string, unknown>).id = obj.id;
        const validated = migrated as { id: string } & Record<string, unknown>;
        try {
          assertValidMemoryEntry(validated);
        } catch (err) {
          errors.push(`${loc}: ${(err as Error).message ?? 'schema validation failed'}`);
          continue;
        }
        entries.push(validated);
        continue;
      } catch (err) {
        errors.push(`${loc}: ${(err as Error).message ?? 'unsupported schemaVersion'}`);
        continue;
      }
    }
    const entry = obj as { id: string } & Record<string, unknown>;
    try {
      assertValidMemoryEntry(entry);
    } catch (err) {
      errors.push(`${loc}: ${(err as Error).message ?? 'schema validation failed'}`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, errors };
}

/** Parse + version-gate + validate a manifest. Throws `MemorySchemaVersionError` on an unknown
 *  version, `MemorySchemaError` on a structural failure. A missing manifest is the caller's concern
 *  (the store creates a fresh one).
 *
 *  Manifests remain memory-1 in the G1.1 phase: there is no v2 manifest concept yet, so the manifest
 *  version gate stays pinned to `1` even though RECORD version '2' is now supported — record and
 *  manifest versions gate independently, and a '2' manifest fails closed, never coerced. */
export function loadMemoryManifestJson(json: unknown): MemoryManifest {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('memory manifest is not a JSON object');
  }
  const obj = json as Record<string, unknown>;
  if (obj.schemaVersion !== '1') {
    throw new MemorySchemaVersionError(
      typeof obj.schemaVersion === 'string' ? obj.schemaVersion : JSON.stringify(obj.schemaVersion),
    );
  }
  const manifest = obj as unknown as MemoryManifest;
  assertValidMemoryManifest(manifest);
  return manifest;
}
