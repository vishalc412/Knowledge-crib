/**
 * W3 Slice 3 — the memory composite projection: virtual `mem:` nodes + runtime edges derived from a
 * {@link RecallProjection}, for the unified composite read model (PRD lines 212–224). Memory is a
 * VIRTUAL graph layer — its nodes/edges are runtime strings NOT in the soul's closed `NodeKind`/
 * `Rel` enums (PRD boundary #2) — so this produces {@link MemoryCompositeNode}/
 * {@link MemoryCompositeEdge}-shaped objects tagged `origin: 'memory'` that the core
 * `mergeComposite` helper folds into the extracted + semantic snapshot WITHOUT touching the soul.
 *
 * Only RECALL-ELIGIBLE records become nodes: the projection already hard-filtered invalid /
 * orphaned / superseded / retracted / pending records (PRD line 338 invariant #1), so the composite
 * graph never surfaces a memory record that normal recall would withhold. Edges:
 *   - `applies-to`    : mem → each `appliesTo` target (the soul symbol/path the memory is about)
 *   - `supported-by`  : mem → an evidence `soulId` (a source-quote pinned to a soul anchor)
 *   - `conflicts-with`: pairwise within each conflict group (≥2 active records sharing subject+scope)
 *
 * `supersedes` edges are deliberately omitted: a superseded record is recall-INeligible (excluded as
 * a node), so a supersedes edge would point at an absent endpoint and be dropped by the merger's
 * valid-id filter anyway. Supersession chains surface in `memory_audit` (the W4 promotion domain).
 *
 * PURE over the projection — no IO, no soul access. The merger in core decides which edges survive
 * (an `applies-to` whose target is not in the soul + memory node set is dropped, mirroring
 * `GraphStore.compositeLive`'s edge filtering over extracted + semantic).
 */
import type { CompositeEdge, CompositeNode } from '@knowledge-crib/core';
import type { RecallProjection } from './recall.js';
import type { MemoryCandidate } from './types.js';
import { isMemoryRecordVersioned } from './types.js';

/** The runtime edge relations of the memory composite layer (NOT in the soul's closed `Rel` enum). */
export type MemoryCompositeRel = 'applies-to' | 'supported-by' | 'conflicts-with';

/** A virtual memory node in the composite graph (origin 'memory', kind 'memory'). A type-alias
 *  intersection (not `interface extends`) because `CompositeNode` is itself an intersection over a
 *  union (`Node | Record<string, unknown>`), which an interface cannot extend. */
export type MemoryCompositeNode = CompositeNode & {
  origin: 'memory';
  kind: 'memory';
  /** the record's effective trust verdict (candidate|local|team). */
  trust: string;
  /** the record's effective evidence verdict (valid|degraded — eligibility excluded invalid). */
  evidence: string;
  /** the store the record was gathered from (team|local|global) — drives ranking criteria 2–4. */
  source: string;
  /** the record's claim text (the assertion itself). */
  claim: string;
  /** `active` = a recall-eligible record; `pending` = a staged candidate not yet admitted. */
  status: 'active' | 'pending';
};

/** Options for {@link memoryComposite}. Both are additive — omitting them is the W3 projection. */
export interface MemoryCompositeOpts {
  /**
   * Staged, not-yet-admitted candidates, projected as `status: 'pending'` nodes with trust
   * `untrusted`. The link from a fresh write to the code it is about shows up in the graph the
   * moment it is written, and is labelled so nobody reads it as vouched-for memory.
   */
  pending?: readonly MemoryCandidate[];
  /**
   * Map a loose `appliesTo` target (an indexed file path, a symbol id) to the soul id it names.
   * Without it a path target points at an id that is not a node, and the merger drops the edge.
   */
  resolveTarget?: (target: string) => string | undefined;
}

/** A virtual memory edge in the composite graph (origin 'memory', provenance INFERRED). */
export type MemoryCompositeEdge = CompositeEdge & {
  origin: 'memory';
  rel: MemoryCompositeRel;
  provenance: 'INFERRED';
};

/** The virtual memory sub-graph: nodes + edges, ready for `mergeComposite`. */
export interface MemoryComposite {
  nodes: MemoryCompositeNode[];
  edges: MemoryCompositeEdge[];
}

/**
 * The {@link MemoryCompositeOpts.resolveTarget} every graph surface uses: a target that is already a
 * soul id stays as-is; an indexed file path becomes its `file:<path>` node; anything else is
 * unresolvable (the merger then drops the edge rather than inventing an endpoint).
 */
export function soulTargetResolver(
  getNode: (id: string) => unknown,
): (target: string) => string | undefined {
  return (target) => {
    if (getNode(target) !== undefined) return target;
    const fileId = `file:${target}`;
    return getNode(fileId) !== undefined ? fileId : undefined;
  };
}

/**
 * Build a composite memory edge. The id is content-stable (`memedge:<rel>:<src>:<dst>`), so two
 * projections over the same recall produce byte-identical edges (no per-process counter — the
 * composite graph stays deterministic for ifHash).
 */
function memEdge(
  src: string,
  dst: string,
  rel: MemoryCompositeRel,
  rationale: string,
): MemoryCompositeEdge {
  return {
    id: `memedge:${rel}:${src}:${dst}`,
    src,
    dst,
    rel,
    method: 'memory',
    provenance: 'INFERRED',
    confidence: 1,
    origin: 'memory',
    rationale,
  };
}

/**
 * Project a {@link RecallProjection} into the virtual memory composite graph. Each recall-eligible
 * record becomes a `mem:` node; `applies-to` / `supported-by` edges link it to its soul targets +
 * evidence anchors; `conflicts-with` edges link the pairwise members of each conflict group. The
 * result is deterministic over the same projection (content-stable node + edge ids).
 */
export function memoryComposite(
  recall: RecallProjection,
  opts: MemoryCompositeOpts = {},
): MemoryComposite {
  const nodes: MemoryCompositeNode[] = [];
  const edges: MemoryCompositeEdge[] = [];
  const present = new Set<string>();
  const resolve = (target: string): string => opts.resolveTarget?.(target) ?? target;

  for (const m of recall.memories) {
    const r = m.record;
    present.add(r.id);
    nodes.push({
      id: r.id,
      kind: 'memory',
      origin: 'memory',
      label: r.subject,
      trust: m.verdicts.trust,
      evidence: m.verdicts.evidence,
      source: m.source,
      claim: r.claim,
      targetId: r.subject,
      status: 'active',
    });
    // applies-to: the soul symbols/paths/subjects this memory is about.
    for (const target of isMemoryRecordVersioned(r) ? [] : r.appliesTo) {
      edges.push(memEdge(r.id, resolve(target), 'applies-to', 'memory applies to target'));
    }
    // supported-by: a source-quote evidence item pinned to a soul anchor by its soulId.
    for (const ev of r.evidence) {
      if (typeof ev.soulId === 'string' && ev.soulId.length > 0) {
        edges.push(memEdge(r.id, ev.soulId, 'supported-by', 'memory supported by soul evidence'));
      }
    }
  }

  // conflicts-with: every pair within a conflict group is a mutual edge (both endpoints are present
  // as eligible nodes; the conflictGroups builder already filtered to recall-eligible records).
  for (const group of recall.conflicts) {
    const ids = group.records.map((rec) => rec.id);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      if (a === undefined || !present.has(a)) continue;
      for (let j = i + 1; j < ids.length; j++) {
        const b = ids[j];
        if (b === undefined || !present.has(b)) continue;
        edges.push(memEdge(a, b, 'conflicts-with', 'conflicting claims share subject + scope'));
      }
    }
  }

  // pending: staged candidates, labelled untrusted. Never merged into conflict groups — a conflict
  // is a disagreement between memories crib vouches for, and a candidate is not one yet.
  for (const c of [...(opts.pending ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    if (present.has(c.id)) continue;
    present.add(c.id);
    nodes.push({
      id: c.id,
      kind: 'memory',
      origin: 'memory',
      label: c.subject,
      trust: 'untrusted',
      evidence: 'unverified',
      source: 'local',
      claim: c.claim,
      targetId: c.subject,
      status: 'pending',
    });
    for (const target of c.appliesTo) {
      edges.push(memEdge(c.id, resolve(target), 'applies-to', 'pending memory applies to target'));
    }
    for (const ev of c.evidence) {
      if (typeof ev.soulId === 'string' && ev.soulId.length > 0) {
        edges.push(memEdge(c.id, ev.soulId, 'supported-by', 'pending memory cites soul evidence'));
      }
    }
  }

  // A path target and the id it resolves to can both be listed — collapse to one edge per id.
  const seen = new Set<string>();
  return { nodes, edges: edges.filter((e) => !seen.has(e.id) && seen.add(e.id) !== undefined) };
}
