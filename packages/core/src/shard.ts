/**
 * Sharding logic for the SoulStore.
 *
 * A record's shard = first `shardHexDigits` hex chars of blake3(shardKey). The shard key for a node
 * is its source path (so all records for one file cluster into one shard → a one-file edit touches
 * one shard → minimal git diffs and merge conflicts). Edges shard by the source path of their `src`
 * id, so a symbol's outgoing edges live beside the symbol.
 *
 * File-less records (cluster nodes, schema-keyed table/column nodes) shard by their id instead, and
 * cluster nodes are written to a dedicated `clusters/clusters.jsonl` rather than `nodes/`.
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';

/** Extract the embedded source path from an id, where the grammar carries one. */
export function pathFromId(id: string): string | undefined {
  const colon = id.indexOf(':');
  if (colon === -1) return undefined;
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  switch (prefix) {
    case 'file':
      return rest;
    case 'sym':
    case 'doc':
    case 'media': {
      // path is up to the first '#'
      const hash = rest.indexOf('#');
      return hash === -1 ? rest : rest.slice(0, hash);
    }
    case 'expl':
    case 'stmt':
    case 'cond': {
      // path is up to the '@L' line suffix
      const at = rest.lastIndexOf('@L');
      return at === -1 ? rest : rest.slice(0, at);
    }
    default:
      // c: (cluster), table:, col: carry no fs path
      return undefined;
  }
}

/** The key a node hashes into a shard by: its source path, else its id. */
export function shardKeyForNode(node: Node): string {
  return node.file ?? pathFromId(node.id) ?? node.id;
}

/** The key an edge hashes into a shard by: the source path of its `src`, else the `src` id. */
export function shardKeyForEdge(edge: Edge): string {
  return pathFromId(edge.src) ?? edge.src;
}

/** Compute the shard label for an arbitrary key. */
export function shardOf(key: string, shardHexDigits: number): string {
  return blake3Hex(key).slice(0, shardHexDigits);
}
