/**
 * PDG layer — reaching definitions → data-dependence edges.
 *
 * Round-robin dataflow over the CFG in reverse post-order: for each node, IN[n] = ⋃ OUT[p] over
 * CFG predecessors, OUT[n] = (IN[n] minus KILL[n]) plus GEN[n], where GEN/KILL come from the
 * def sets captured during CFG construction (assignments define, a reassignment kills earlier
 * defs of the same variable). A data edge is then emitted from every def that reaches a node to
 * that node, when the node USES the variable.
 *
 * Deliberately intra-procedural and conservative: parameters are definitions at the entry node,
 * globals/properties are matched by name only, and any variable that is MAY-defined on some path
 * reaches as may-defined — an extra data edge is the acceptable direction of error here, a missed
 * `const q = req.query.q; exec(q)` flow is not.
 */
import type { ControlPdg, Pdg, PdgEdge } from './cfg.js';

/** Fill `data` and `reaching` on the graph (mutates the passed object and returns it). */
export function withDataDependence(cfg: ControlPdg, pdg: Pdg): Pdg {
  const preds = predecessors(cfg);
  const defsAt = new Map<number, string[]>();
  for (const n of cfg.nodes) {
    if (n.defs.length > 0) defsAt.set(n.id, [...n.defs]);
  }
  const inSets = reachFixpoint(cfg, preds, defsAt);
  const data = dataEdges(cfg, inSets);
  pdg.data = data;
  pdg.reaching = inSets;
  return pdg;
}

function predecessors(cfg: ControlPdg): Map<number, number[]> {
  const preds = new Map<number, number[]>();
  for (const n of cfg.nodes) preds.set(n.id, []);
  for (const [src, dsts] of cfg.succ) {
    for (const d of dsts) {
      const list = preds.get(d);
      if (list && !list.includes(src)) list.push(src);
    }
  }
  return preds;
}

/**
 * Fixpoint of the reaching-defs sets. Round-robin over RPO; a pass budget of nodes+2 bounds the
 * iteration defensively (the fixpoint needs at most a few passes on structured CFGs).
 */
function reachFixpoint(
  cfg: ControlPdg,
  preds: ReadonlyMap<number, number[]>,
  defsAt: ReadonlyMap<number, readonly string[]>,
): Map<number, Map<string, number[]>> {
  const rpo = reversePostOrder(cfg);
  const inSets = new Map<number, Map<string, number[]>>();
  const outSets = new Map<number, Map<string, number[]>>();
  for (const n of cfg.reachable) {
    inSets.set(n, new Map());
    outSets.set(n, new Map());
  }
  // the entry node defines the parameters
  const entryDefs = defsAt.get(cfg.entry) ?? [];
  const entryOut = outSets.get(cfg.entry)!;
  for (const v of entryDefs) entryOut.set(v, [cfg.entry]);

  for (let pass = 0; pass < rpo.length + 2; pass++) {
    let changed = false;
    for (const n of rpo) {
      const inn = mergePredecessors(preds.get(n) ?? [], outSets, cfg.reachable);
      const out = transfer(n, inn, defsAt.get(n) ?? []);
      const prevIn = inSets.get(n)!;
      const prevOut = outSets.get(n)!;
      if (!sameMap(prevIn, inn)) {
        inSets.set(n, inn);
        changed = true;
      }
      if (!sameMap(prevOut, out)) {
        outSets.set(n, out);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return inSets;
}

function mergePredecessors(
  preds: readonly number[],
  outSets: ReadonlyMap<number, Map<string, number[]>>,
  reachable: ReadonlySet<number>,
): Map<string, number[]> {
  const merged = new Map<string, number[]>();
  for (const p of preds) {
    if (!reachable.has(p)) continue;
    for (const [v, defs] of outSets.get(p) ?? []) {
      const target = merged.get(v) ?? [];
      for (const d of defs) if (!target.includes(d)) target.push(d);
      if (target.length > 0) merged.set(v, target);
    }
  }
  return merged;
}

/** OUT[n] = GEN[n] ∪ (IN[n] minus earlier defs of the same variables). */
function transfer(
  n: number,
  inn: ReadonlyMap<string, number[]>,
  defs: readonly string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [v, ds] of inn) {
    if (!defs.includes(v)) out.set(v, [...ds]);
  }
  for (const v of defs) out.set(v, [n]);
  return out;
}

function sameMap(a: ReadonlyMap<string, number[]>, b: ReadonlyMap<string, number[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb || vb.length !== va.length || va.some((x, i) => vb[i] !== x)) return false;
  }
  return true;
}

function reversePostOrder(cfg: ControlPdg): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const visit = (n: number): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const s of cfg.succ.get(n) ?? []) if (cfg.reachable.has(s)) visit(s);
    out.push(n);
  };
  visit(cfg.entry);
  return out.reverse();
}

/** For every reachable node that USES a variable, connect each reaching def site to it. */
function dataEdges(
  cfg: ControlPdg,
  inSets: ReadonlyMap<number, ReadonlyMap<string, readonly number[]>>,
): PdgEdge[] {
  const edges: PdgEdge[] = [];
  const seen = new Set<string>();
  for (const n of cfg.nodes) {
    if (!cfg.reachable.has(n.id)) continue;
    const reaching = inSets.get(n.id) ?? new Map<string, number[]>();
    for (const v of n.uses) {
      for (const defId of reaching.get(v) ?? []) {
        if (defId === n.id) continue;
        const key = `${defId}>${n.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ src: defId, dst: n.id, rel: 'flow' });
        }
      }
    }
  }
  return edges;
}
