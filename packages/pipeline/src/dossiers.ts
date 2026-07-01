/**
 * Workstream E — persisted reusable dossiers.
 *
 * Post-resolve phase: for every callable symbol in the soul, build its deep dossier and persist it
 * under `.crib/dossiers/` (sharded, atomic, hash-anchored to the node's `hash`). Freshness also
 * compares the rebuilt graph-dependent content, so callers, callees, docs, and framework edges
 * cannot remain stale when the symbol's own source hash is unchanged. `builtAt` is ignored for this
 * comparison, preserving byte stability on a true no-op; artifacts for removed nodes are pruned.
 *
 * Pure over the soul + repoRoot (the builder is pure); the only side effect is writing the dossier
 * files. No IndexStore, no network. This is the batch twin of the MCP `dossier` verb's cache-miss
 * path — same builder, same serializer, same persistence — so a persisted artifact and a live verb
 * response are byte-identical in shape.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Dossier, SoulStore } from '@knowledge-crib/core';
import {
  CALLABLE_SYMBOL_TYPES,
  buildDossier,
  pruneDossiers,
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
  /** persisted artifacts removed because their node no longer exists. */
  pruned: number;
}

/**
 * Build + persist dossiers for every callable symbol in the soul. Runs after `soul.commit()` so the
 * graph (and the manifest's `lastUpdated`/`schemaVersion`) is final. Only missing, stale, or
 * graph-divergent artifacts are rewritten; fresh ones are preserved (deterministic re-index).
 */
export function runDossiers(soul: SoulStore, repoRoot: string, now: string): DossierStats {
  const cribDir = soul.cribDir;
  const schemaVersion = soul.getManifest().schemaVersion;
  let candidates = 0;
  let written = 0;
  let fresh = 0;
  let skipped = 0;
  const liveNodeIds = new Set<string>();

  for (const node of soul.iterate()) {
    liveNodeIds.add(node.id);
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
    if (
      !existing.missing &&
      !existing.stale &&
      existing.dossier &&
      sameDossierContent(existing.dossier, dossier)
    ) {
      fresh++;
      continue;
    }
    writeDossier(cribDir, dossier);
    written++;
  }

  const pruned = pruneDossiers(cribDir, liveNodeIds);
  return { candidates, written, fresh, skipped, pruned };
}

function sameDossierContent(existing: Dossier, current: Dossier): boolean {
  const persisted = JSON.stringify({ ...existing, builtAt: undefined });
  const rebuilt = JSON.stringify({ ...current, builtAt: undefined });
  return isDeepStrictEqual(JSON.parse(persisted), JSON.parse(rebuilt));
}
