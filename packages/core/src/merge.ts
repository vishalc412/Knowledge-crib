import type { Edge, Node } from '@knowledge-crib/soul-schema';
/**
 * `.crib` chunk 3-way merge (M6) — the pure merger the git `kcrib` merge driver shells into.
 *
 * `.crib` shards are JSONL chunk files (one record per line). Each chunk is homogeneous (all nodes or
 * all edges) and sorted by id (see SoulStore), so a chunk is a deterministic map of `id → record`.
 * Merge by id, three-way:
 *   - unchanged on both sides → keep base;
 *   - one side changed, other unchanged → take the changed side;
 *   - both sides changed identically → take either;
 *   - both sides changed differently:
 *       • edges (records carrying `rel`) → resolve via `resolveEdgeConflict` (the SAME rule the store
 *         applies at put time — so the merged soul matches a re-index), deterministically; and
 *       • nodes → take "ours", emit a WARNING to stderr (two devs editing the same symbol is a genuine
 *         source conflict the source-driver must resolve; the soul is regenerable, so we never block).
 *   - add/delete + modify/delete → keep the surviving addition/modification with a warning.
 *
 * The result is re-serialized sorted by id (byte-stable across re-runs, matching the store's order).
 */
import { resolveEdgeConflict } from './conflict-rule.js';

export type ChunkRecord = Node | Edge;

/** Is this record an edge? Edges carry `rel`; nodes carry `kind` + `hash`. */
function isEdge(r: ChunkRecord): r is Edge {
  return (r as Edge).rel !== undefined && (r as Edge).src !== undefined;
}

/** Parse a JSONL chunk into an id→record map, skipping blank/malformed lines. */
export function parseChunk(text: string): Map<string, ChunkRecord> {
  const map = new Map<string, ChunkRecord>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as ChunkRecord;
      if (rec.id) map.set(rec.id, rec);
    } catch {
      // skip a malformed line rather than aborting the merge
    }
  }
  return map;
}

/** Serialize an id→record map to a newline-delimited, id-sorted JSONL chunk (trailing newline). */
export function serializeChunk(map: Map<string, ChunkRecord>): string {
  const lines = [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, rec]) => JSON.stringify(rec));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export interface MergeResult {
  merged: Map<string, ChunkRecord>;
  /** warnings emitted for non-edge conflicts a human should review (source merge / re-index). */
  warnings: string[];
}

/**
 * Three-way merge of two evolved versions against a base, keyed by record id. The result mirrors what
 * a post-merge `crib update` would produce for edge conflicts (same conflict rule) and keeps node
 * presence/identity intact; node-level edit collisions are deferred to the source merge with a warning.
 */
export function mergeThreeWay(
  base: Map<string, ChunkRecord>,
  ours: Map<string, ChunkRecord>,
  theirs: Map<string, ChunkRecord>,
): MergeResult {
  const merged = new Map<string, ChunkRecord>();
  const warnings: string[] = [];
  const ids = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);

  for (const id of ids) {
    const b = base.get(id);
    const o = ours.get(id);
    const t = theirs.get(id);

    // additions (absent in base)
    if (b === undefined) {
      if (o !== undefined && t !== undefined) {
        if (equal(o, t)) merged.set(id, o);
        else if (isEdge(o) && isEdge(t)) merged.set(id, resolveEdgeConflict(o, t));
        else {
          merged.set(id, o);
          warnings.push(`node ${id}: both branches added a different node — took ours, review`);
        }
      } else {
        // present on exactly one side → keep the addition
        const rec = o ?? t;
        if (rec) merged.set(id, rec);
      }
      continue;
    }

    // present in base: classify each side vs base. A deletion is a change (vs base) only if the other
    // side did NOT also delete — but a one-sided deletion where the other side is unchanged-from-base must
    // be respected (drop the record), not treated as "neither changed → keep base".
    const oDeleted = o === undefined;
    const tDeleted = t === undefined;
    const oChanged = o === undefined ? false : !equal(b, o);
    const tChanged = t === undefined ? false : !equal(b, t);

    if (oDeleted && tDeleted) {
      // both sides dropped it → drop
    } else if (oDeleted && !tChanged) {
      // ours deleted, theirs unchanged → respect the deletion (no warning)
    } else if (tDeleted && !oChanged) {
      // theirs deleted, ours unchanged → respect the deletion (no warning)
    } else if (oDeleted /* && tChanged → modify/delete */) {
      merged.set(id, t as ChunkRecord); // keep the modification
      warnings.push(`node ${id}: deleted ours, modified theirs — kept theirs, review`);
    } else if (tDeleted /* && oChanged → modify/delete */) {
      merged.set(id, o as ChunkRecord); // keep the modification
      warnings.push(`node ${id}: modified ours, deleted theirs — kept ours, review`);
    } else if (!oChanged && !tChanged) {
      merged.set(id, b); // unchanged
    } else if (oChanged && !tChanged) {
      merged.set(id, o as ChunkRecord); // only ours changed
    } else if (!oChanged && tChanged) {
      merged.set(id, t as ChunkRecord); // only theirs changed
    } else if (o !== undefined && t !== undefined && equal(o, t)) {
      merged.set(id, o); // same change on both sides
    } else if (o !== undefined && t !== undefined && isEdge(o) && isEdge(t)) {
      merged.set(id, resolveEdgeConflict(o, t)); // edge conflict → deterministic rule
    } else {
      merged.set(id, (o ?? t) as ChunkRecord); // conflicting node edits
      warnings.push(
        `node ${id}: conflicting node edits — took ${o !== undefined ? 'ours' : 'theirs'}, review`,
      );
    }
  }

  return { merged, warnings };
}

/** Structural equality of two JSON records via key-sorted serialization. */
function equal(a: ChunkRecord | undefined, b: ChunkRecord | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}
