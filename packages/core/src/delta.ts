/**
 * Incremental delta helpers (M6). Pure functions over a loaded SoulStore that:
 *   - `fileScopedIds` — snapshot the ids of nodes+edges tied to a set of repo-relative files, BEFORE a
 *     scoped re-extract; and
 *   - `buildDelta` — diff that snapshot against the post-extract state to produce an `IndexDelta` for
 *     `IndexStore.applyDelta`.
 *
 * Membership (P0-4): a node is in scope if its `file` (or embedded id path) ∈ files; an edge is in scope
 * if `pathFromId(src)` OR `pathFromId(dst)` ∈ files. Edges CANNOT route by their own id — `pathFromId`
 * of an `e:<hash>` edge id is `undefined` — so both endpoints must be considered. This is what lets an
 * incoming edge `B→A` (B unchanged, references changed A) be pruned AND re-emitted, and is the basis of
 * the honest "only the changed file's shard chunks diff" gate.
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { IndexDelta } from './index-store.js';
import { pathFromId } from './shard.js';
import type { SoulStore } from './soul-store.js';

export interface ScopedIds {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

/** Snapshot the ids of every node+edge scoped to `files` (membership by node file/id-path; edge src/dst paths). */
export function fileScopedIds(soul: SoulStore, files: Set<string>): ScopedIds {
  const nodeIds = new Set<string>();
  for (const node of soul.iterate()) {
    if (inScope(node.file, node.id, files)) nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of soul.iterateEdges()) {
    const s = pathFromId(edge.src);
    const d = pathFromId(edge.dst);
    if ((s !== undefined && files.has(s)) || (d !== undefined && files.has(d))) {
      edgeIds.add(edge.id);
    }
  }
  return { nodeIds, edgeIds };
}

/** Build an `IndexDelta` for `files`: current scoped records as upserts, `before ∖ after` as removed. */
export function buildDelta(soul: SoulStore, before: ScopedIds, files: Set<string>): IndexDelta {
  const after = fileScopedIds(soul, files);
  const removed: string[] = [];
  for (const id of before.nodeIds) if (!after.nodeIds.has(id)) removed.push(id);
  for (const id of before.edgeIds) if (!after.edgeIds.has(id)) removed.push(id);

  const nodes: Node[] = [];
  for (const id of after.nodeIds) {
    const n = soul.getNode(id);
    if (n) nodes.push(n);
  }
  const edges: Edge[] = [];
  for (const id of after.edgeIds) {
    const e = soul.getEdge(id);
    if (e) edges.push(e);
  }
  return { nodes, edges, removed };
}

function inScope(file: string | undefined, id: string, files: Set<string>): boolean {
  if (file !== undefined && files.has(file)) return true;
  const p = pathFromId(id);
  return p !== undefined && files.has(p);
}
