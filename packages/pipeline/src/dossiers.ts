/**
 * Workstream E — persisted reusable dossiers.
 *
 * Post-resolve phase: for every callable symbol in the soul, build its deep dossier and persist it
 * under `.crib/dossiers/` (sharded, atomic, hash-anchored to the node's `hash`). A dossier that is
 * already fresh (matching `nodeHash` + `schemaVersion`) is left untouched — so an unchanged repo
 * re-indexes without rewriting the dossier store (the determinism discipline the soul already obeys).
 *
 * Pure over the soul + repoRoot (the builder is pure); the only side effect is writing the dossier
 * files. No IndexStore, no network. This is the batch twin of the MCP `dossier` verb's cache-miss
 * path — same builder, same serializer, same persistence — so a persisted artifact and a live verb
 * response are byte-identical in shape.
 */
import type { SoulStore } from '@knowledge-crib/core';
import {
  CALLABLE_SYMBOL_TYPES,
  buildDossier,
  readDossier,
  writeDossier,
} from '@knowledge-crib/core';

export interface DossierStats {
  /** callable symbols considered. */
  candidates: number;
  /** dossiers written this run (missing or stale). */
  written: number;
  /** dossiers already fresh on disk and left untouched. */
  fresh: number;
  /** callable symbols for which the builder returned no artifact (e.g. no source span). */
  skipped: number;
}

/**
 * Build + persist dossiers for every callable symbol in the soul. Runs after `soul.commit()` so the
 * graph (and the manifest's `lastUpdated`/`schemaVersion`) is final. Only missing/stale artifacts are
 * rewritten; fresh ones are preserved (deterministic re-index).
 */
export function runDossiers(soul: SoulStore, repoRoot: string, now: string): DossierStats {
  const cribDir = soul.cribDir;
  const schemaVersion = soul.getManifest().schemaVersion;
  let candidates = 0;
  let written = 0;
  let fresh = 0;
  let skipped = 0;

  for (const node of soul.iterate()) {
    if (node.kind !== 'symbol' || !node.type || !CALLABLE_SYMBOL_TYPES.has(node.type)) continue;
    candidates++;
    const dossier = buildDossier(soul, repoRoot, node.id, now);
    if (!dossier) {
      skipped++;
      continue;
    }
    const existing = readDossier(cribDir, node.id, {
      nodeHash: node.hash,
      schemaVersion,
    });
    if (!existing.missing && !existing.stale) {
      fresh++;
      continue;
    }
    writeDossier(cribDir, dossier);
    written++;
  }

  return { candidates, written, fresh, skipped };
}
