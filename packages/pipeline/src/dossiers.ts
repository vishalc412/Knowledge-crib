/**
 * Workstream E — persisted reusable dossiers.
 *
 * Post-resolve phase: for every callable symbol in the soul, build its deep dossier and persist it
 * under `.crib/dossiers/` (sharded, atomic, hash-anchored to the node's `hash`). Freshness also
 * compares the rebuilt graph-dependent content, so callers, callees, docs, and framework edges
 * cannot remain stale when the symbol's own source hash is unchanged. `builtAt` is ignored for this
 * comparison, preserving byte stability on a true no-op; artifacts for removed nodes are pruned.
 *
 * Build order is deliberate: buildDossier FIRST, then readDossier + compare. A fresh `nodeHash`
 * does NOT imply fresh callers/callees/docs/framework (those depend on edges, not the node's own
 * source), so a read-first shortcut would serve stale graph-dependent content — see the
 * `refreshes an unchanged callee dossier when its incoming call edge disappears` pin in
 * pipeline.test.ts.
 *
 * Pure over the soul + repoRoot (the builder is pure); the only side effect is writing the dossier
 * files. No IndexStore, no network. This is the batch twin of the MCP `dossier` verb's cache-miss
 * path — same builder, same serializer, same persistence — so a persisted artifact and a live verb
 * response are byte-identical in shape.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Dossier, DossierOpts, SoulStore } from '@knowledge-crib/core';
import {
  CALLABLE_SYMBOL_TYPES,
  buildDossier,
  pruneDossiers,
  readDossier,
  writeDossier,
} from '@knowledge-crib/core';
import type { Edge } from '@knowledge-crib/soul-schema';

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
 * Build the once-per-run inputs {@link buildDossier} would otherwise rebuild per symbol: the
 * outgoing/incoming adjacency maps, the `produces` supply-chain map, and the lowercased name index
 * coverage uses for call-site resolution. One `iterateEdges()` pass + one `iterate('symbol')`
 * pass, regardless of how many dossiers the run builds — the whole-soul twin of
 * `buildDossiersByScope`'s 1-scan contract. Without this, every `buildDossier` re-scanned every
 * edge (and `frameworkSemantics`/`decisionTable` re-walked them again), so D×E edge visits
 * dominated `crib update` on large souls.
 *
 * `out` (the decision-table's ExtractRulesOpts field) is deliberately NOT set — buildDossier
 * already routes `opts.out ?? outgoing`, so the hoisted adjacency reaches the decision table too.
 */
export function hoistedDossierOpts(soul: SoulStore): DossierOpts {
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const producerOf = new Map<string, string>();
  for (const e of soul.iterateEdges()) {
    const o = outgoing.get(e.src);
    if (o) o.push(e);
    else outgoing.set(e.src, [e]);
    const i = incoming.get(e.dst);
    if (i) i.push(e);
    else incoming.set(e.dst, [e]);
    // first producer wins — identical to frameworkSemantics' internal buildProducerOf, which
    // walks the same iterateEdges order via the incoming map.
    if (e.rel === 'produces' && !producerOf.has(e.dst)) producerOf.set(e.dst, e.src);
  }

  // Byte-identical to coverage.ts's private buildNameIndex (name + qualifiedName + simple segment,
  // all lowercased) — the hoist must not change which call sites coverage can resolve.
  const nameIndex = new Set<string>();
  for (const n of soul.iterate('symbol')) {
    if (n.name) nameIndex.add(n.name.toLowerCase());
    if (n.qualifiedName) {
      nameIndex.add(n.qualifiedName.toLowerCase());
      nameIndex.add((n.qualifiedName.split('.').pop() ?? '').toLowerCase());
    }
  }

  return { outgoing, incoming, producerOf, nameIndex };
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
  const buildOpts = hoistedDossierOpts(soul);

  for (const node of soul.iterate()) {
    // pruneDossiers keys on the FULL live id set (every node kind, not just callable symbols), so
    // keep collecting ids here even for nodes that can never own a dossier.
    liveNodeIds.add(node.id);
    if (node.kind !== 'symbol' || !node.type || !CALLABLE_SYMBOL_TYPES.has(node.type)) continue;
    candidates++;
    const dossier = buildDossier(soul, repoRoot, node.id, now, buildOpts);
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
