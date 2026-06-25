/**
 * Dossier persistence (Workstream E) — sharded, atomically-written, hash-stale reusable artifacts.
 *
 * Each dossier is one JSON file under `.crib/dossiers/<shard>/<nodeId>.json`, where `<shard>` is the
 * first 2 hex chars of blake3(nodeId) — mirroring the soul's sharding so a one-symbol rebuild touches
 * one file (minimal diffs). Writes are atomic (temp→rename) so a crash never leaves a half-written
 * artifact. Staleness is hash-anchored: a dossier carries the source node's `hash` + the soul's
 * `schemaVersion` at build time; {@link readDossier} reports `stale` when either differs from the
 * live soul, so the verb can rebuild on miss/stale and the pipeline can refresh changed symbols only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type { Dossier } from './builder.js';

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
 * `schemaVersion`. A missing file ⇒ `{ missing: true, stale: false }`. A present file whose
 * `nodeHash` matches the live hash and whose `schemaVersion` matches is fresh.
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
  return { dossier, missing: false, stale: hashStale || schemaStale };
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

/** Filesystem-safe name for a node id (replaces path separators / colons). */
function safeName(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9._-]+/g, '_');
}
