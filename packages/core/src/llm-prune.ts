/**
 * LLM semantic-artifact orphan prune — the semantic-layer analogue of {@link pruneDossiers}.
 *
 * The semantic graph (`.crib/graph/semantic/artifacts/<layer>/<shard>/<targetId>_<hash>.json`) is a
 * derived cache keyed on soul node ids. When a `crib update` deletes or moves a symbol, the symbol's
 * node id disappears from the soul, but its persisted LLM artifact lingers forever — the enrich
 * queue (`EnrichmentStore.next`) only re-offers *stale* artifacts (hash mismatch); an *orphaned*
 * one (target node gone) is silently retained and still served by `query`/`context` as stale
 * analysis of code that no longer exists. `pruneDossiers` closes this gap for dossiers; this module
 * closes it for the semantic layer, called from `updateRepo` after `soul.commit()`.
 *
 * The contract is ORPHAN-ONLY: an artifact whose target node still exists but whose `nodeHash`
 * differs is PRESERVED so the enrich queue can re-offer it for re-authoring (the queue IS the
 * re-authoring path). Deleting stale-but-present artifacts would race `enrich_next` and discard
 * the old `evidence` quotes the re-author can reuse. The full orphan+stale prune is the explicit
 * `crib enrich prune` / `semantic_delta --prune --prune-stale` surface (mcp), not the auto-prune.
 *
 * This module is PURE (no SoulStore dependency) so `packages/pipeline` — which cannot import
 * `@knowledge-crib/mcp` — can call it. The `generation.semantic` manifest bump that must accompany
 * a prune lives on {@link SoulStore.bumpSemanticGeneration} (it mutates the in-memory manifest the
 * caller holds and persists via the private writer, keeping memory + disk consistent).
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';

/** The synthetic whole-repo target id (never orphaned — `targetFor('system:repo')` always resolves). */
const SYSTEM_TARGET = 'system:repo';

/**
 * Mirror of `EnrichmentStore.root()` / `.artifactsRoot()` WITHOUT depending on `@knowledge-crib/mcp`.
 * Returns the on-disk directory holding all persisted semantic artifacts: canonical
 * `.crib/graph/semantic/artifacts` (when the graph manifest exists) or legacy `.crib/llm/analysis`.
 */
function semanticArtifactsRoot(cribDir: string): string {
  const canonical = join(cribDir, 'graph', 'manifest.json');
  const root = existsSync(canonical) ? join(cribDir, 'graph', 'semantic') : join(cribDir, 'llm');
  return root.endsWith(`${sep}llm`) ? join(root, 'analysis') : join(root, 'artifacts');
}

/**
 * Delete persisted semantic artifacts whose `targetId` is no longer a live soul node. Stale-but-
 * present artifacts (target exists, `nodeHash` differs) are PRESERVED. The whole-repo `system:repo`
 * target is never pruned. Invalid-JSON files are left in place (do not GC what cannot be identified).
 * Returns the number of files deleted. Mirrors {@link pruneDossiers}.
 */
export function pruneSemanticArtifacts(cribDir: string, liveNodeIds: ReadonlySet<string>): number {
  const root = semanticArtifactsRoot(cribDir);
  if (!existsSync(root)) return 0;
  let pruned = 0;
  for (const layer of readdirSync(root, { withFileTypes: true })) {
    if (!layer.isDirectory()) continue;
    const layerPath = join(root, layer.name);
    for (const shard of readdirSync(layerPath, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const shardPath = join(layerPath, shard.name);
      for (const entry of readdirSync(shardPath, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const path = join(shardPath, entry.name);
        let targetId: string | undefined;
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as { targetId?: unknown };
          if (typeof parsed.targetId === 'string') targetId = parsed.targetId;
        } catch {
          continue; // invalid JSON — leave it; we cannot safely identify its target.
        }
        if (targetId === undefined) continue;
        if (targetId === SYSTEM_TARGET) continue;
        if (liveNodeIds.has(targetId)) continue;
        rmSync(path, { force: true });
        pruned++;
      }
    }
  }
  return pruned;
}
