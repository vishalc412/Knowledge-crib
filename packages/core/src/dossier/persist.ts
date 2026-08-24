/**
 * Dossier persistence (Workstream E) — sharded, atomically-written, hash-stale reusable artifacts.
 *
 * Each dossier is one JSON file under `.crib/dossiers/<shard>/<nodeId>.json`, where `<shard>` is the
 * first 2 hex chars of blake3(nodeId) — mirroring the soul's sharding so a one-symbol rebuild touches
 * one file (minimal diffs). Writes are atomic (temp→rename) so a crash never leaves a half-written
 * artifact. Staleness is hash-anchored: a dossier carries the source node's `hash` + the soul's
 * `schemaVersion` at build time; {@link readDossier} reports `stale` when either differs from the
 * live soul. The pipeline additionally compares rebuilt graph-dependent content and prunes orphan
 * artifacts, covering relationship changes that do not alter the source node hash.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type { Dossier } from './builder.js';
import { DOSSIER_SHAPE_VERSION } from './framework.js';

const SHARD_HEX = 2;

/** The on-disk directory holding all persisted dossiers for one crib. */
export function dossiersDir(cribDir: string): string {
  return join(cribDir, 'dossiers');
}

/** The shard directory + file path for one dossier, keyed by blake3(nodeId). */
export function dossierPath(cribDir: string, nodeId: string): string {
  const shard = blake3Hex(nodeId).slice(0, SHARD_HEX);
  return join(dossiersDir(cribDir), shard, `${safeName(nodeId)}.json`);
}

/** Atomically write a dossier to its sharded path. */
export function writeDossier(cribDir: string, dossier: Dossier): void {
  const path = dossierPath(cribDir, dossier.id);
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(dossier, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** A read result: the artifact (when present) + a `stale` flag vs the live soul. */
export interface DossierRead {
  dossier?: Dossier;
  /** true iff no artifact exists on disk */
  missing: boolean;
  /** true iff the artifact's nodeHash/schemaVersion diverge from the live soul (caller-supplied) */
  stale: boolean;
}

/**
 * Read a dossier from disk and flag staleness against the live node's `hash` + the soul's
 * `schemaVersion` + the dossier `shapeVersion`. A missing file ⇒ `{ missing: true, stale: false }`.
 * A present file is fresh iff `nodeHash` matches the live hash, `schemaVersion` matches the soul's
 * schema version, AND `shapeVersion` matches {@link DOSSIER_SHAPE_VERSION}. The shape gate is the
 * critical one: a pre-change persisted dossier carries `schemaVersion: '1.3'` (unchanged) but no
 * `framework` section, so without this bump it would be served fresh-and-incomplete forever.
 */
export function readDossier(
  cribDir: string,
  nodeId: string,
  live: { nodeHash?: string; schemaVersion: string },
): DossierRead {
  const path = dossierPath(cribDir, nodeId);
  if (!existsSync(path)) return { missing: true, stale: false };
  let dossier: Dossier;
  try {
    dossier = JSON.parse(readFileSync(path, 'utf8')) as Dossier;
  } catch {
    return { missing: true, stale: false };
  }
  const hashStale = live.nodeHash !== undefined && dossier.nodeHash !== live.nodeHash;
  const schemaStale = dossier.schemaVersion !== live.schemaVersion;
  // shape staleness: a missing or older shapeVersion forces a rebuild even when schema is unchanged.
  // `dossier.shapeVersion` is undefined on pre-2.0 artifacts → stale (rebuilt on demand).
  const shapeStale = (dossier.shapeVersion ?? 1) !== DOSSIER_SHAPE_VERSION;
  return { dossier, missing: false, stale: hashStale || schemaStale || shapeStale };
}

/** Remove a dossier (used when a symbol disappears from the soul). No-op if absent. */
export function deleteDossier(cribDir: string, nodeId: string): void {
  const path = dossierPath(cribDir, nodeId);
  if (existsSync(path)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // swallow — cleanup is best-effort
    }
  }
}

/** Remove persisted dossiers whose node no longer exists in the live soul. */
export function pruneDossiers(cribDir: string, liveNodeIds: ReadonlySet<string>): number {
  const root = dossiersDir(cribDir);
  if (!existsSync(root)) return 0;
  let pruned = 0;
  for (const shard of readdirSync(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardPath = join(root, shard.name);
    for (const entry of readdirSync(shardPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(shardPath, entry.name);
      let id: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown };
        if (typeof parsed.id === 'string') id = parsed.id;
      } catch {
        // Invalid cache entries are unusable and safe to discard.
      }
      if (id !== undefined && liveNodeIds.has(id)) continue;
      rmSync(path, { force: true });
      pruned++;
    }
  }
  return pruned;
}

/**
 * Filesystem-safe name for a node id (replaces path separators / colons).
 * Caps length for macOS NAME_MAX (255): long Java package+method ids otherwise
 * overflow when writing `<safe>.json.tmp`.
 */
function safeName(nodeId: string): string {
  const cleaned = nodeId.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Leave room for `.json.tmp` suffix on the write path (~9 chars).
  const maxBase = 240;
  if (cleaned.length <= maxBase) return cleaned;
  const hash = blake3Hex(nodeId).slice(0, 16);
  const keep = maxBase - hash.length - 1;
  return `${cleaned.slice(0, keep)}_${hash}`;
}
