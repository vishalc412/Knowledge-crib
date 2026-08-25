import type { Node, NodeKind, Rel } from '@knowledge-crib/soul-schema';
/**
 * Importance ranking — the shared signal that powers both the UI viz declutter ("show everything,
 * rank hard") and the enrichment queue ordering (high-value production symbols first, test
 * scaffolding last). Extracted from `ui/src/viz.ts` so the MCP layer can rank the enrich queue
 * without depending on `ui` (the dependency graph runs `ui → core`, `mcp → core`, never crossing).
 *
 * The metric is directed in-degree over ARCHITECTURAL_RELS only, decorated by a kind base weight so
 * a heavily-called function outranks a heavily-called statement, and a leaf file/interface still
 * ranks above the noise floor with zero reverse dependents. Value-for-value identical to the
 * original viz.ts computation — `viz.test.ts` tier assertions guard the parity.
 */
import type { SoulStore } from './soul-store.js';

/** A symbol's derived kind — the architectural subtype the viz renders and ranking weights by.
 *  `NodeKind` widened with the derived symbol kinds `deriveNodeKind` resolves a raw `symbol` into. */
export type DerivedKind =
  | NodeKind
  | 'class'
  | 'method'
  | 'function'
  | 'interface'
  | 'enum'
  | 'type'
  | 'getter'
  | 'setter'
  | 'property';

/**
 * Edges that carry architectural signal (who calls/imports/inherits/exposes/injects/renders/
 * produces whom) — the relationships an architecture-altitude view cares about. Deliberately
 * excludes `member-of` (near-universal, would swamp the signal) and statement-level control-flow
 * rels (`executes`/`reads`/`writes`/`guarded-by`/`raises`/`handles`/`iterates`/`declares`).
 */
export const ARCHITECTURAL_RELS: ReadonlySet<Rel> = new Set<Rel>([
  'calls',
  'imports',
  'inherits',
  'implements',
  'exposes',
  'injects',
  'renders',
  'produces',
]);

/** Statement-level / control-flow node kinds — real signal, but not architecture. Weighted down so
 *  they don't drown out the module map; never hidden. */
export const NOISE_KINDS: ReadonlySet<DerivedKind> = new Set<DerivedKind>([
  'assignment',
  'case-branch',
  'condition',
  'cursor',
  'raise',
  'exception-handler',
]);

export interface ImportanceEntry {
  /** kindBase + (in-degree × weight); higher = more architecturally central. */
  importance: number;
  /** Raw directed in-degree over ARCHITECTURAL_RELS (undecorated by kind weight). */
  degree: number;
}

/** Resolve a raw `symbol` node into its architectural subtype; non-symbol kinds pass through. */
export function deriveNodeKind(node: Node): DerivedKind {
  if (node.kind !== 'symbol') return node.kind;
  const t = (node.type ?? '').toLowerCase();
  if (t.includes('class')) return 'class';
  if (t.includes('method')) return 'method';
  if (t.includes('function')) return 'function';
  if (t.includes('interface')) return 'interface';
  if (t.includes('enum')) return 'enum';
  if (t.includes('type')) return 'type';
  if (t.includes('getter')) return 'getter';
  if (t.includes('setter')) return 'setter';
  if (t.includes('property')) return 'property';
  return 'symbol';
}

/** A baseline importance floor for structural container kinds, so a file/class/interface/route/
 *  table still ranks above the noise floor even with zero incoming architectural edges. */
export function kindBase(kind: DerivedKind): number {
  switch (kind) {
    case 'file':
      return 2;
    case 'class':
    case 'interface':
    case 'route':
    case 'table':
      return 3;
    default:
      return 0;
  }
}

/**
 * Compute per-node importance over the whole soul: directed in-degree over ARCHITECTURAL_RELS,
 * decorated by `kindBase` and a 0.1 noise-kind weight. Returns a Map keyed by node id. Only nodes
 * with an incoming architectural edge OR a non-zero kindBase appear (leaf symbols with no callers
 * and no base bump carry importance 0 and are intentionally absent — callers use `?? 0`).
 */
export function computeImportance(soul: SoulStore): Map<string, ImportanceEntry> {
  const inDegree = new Map<string, number>();
  for (const edge of soul.iterateEdges()) {
    if (!ARCHITECTURAL_RELS.has(edge.rel)) continue;
    inDegree.set(edge.dst, (inDegree.get(edge.dst) ?? 0) + 1);
  }
  const out = new Map<string, ImportanceEntry>();
  for (const node of soul.iterate()) {
    const kind = deriveNodeKind(node);
    const degree = inDegree.get(node.id) ?? 0;
    const weight = NOISE_KINDS.has(kind) ? 0.1 : 1;
    const importance = kindBase(kind) + degree * weight;
    if (importance === 0) continue; // leaf symbol, no base — skip to keep the map lean
    out.set(node.id, { importance, degree });
  }
  return out;
}

/** Summed member importance for a cluster (the cluster-level rank signal for the enrich queue). */
export function clusterImportance(
  soul: SoulStore,
  cluster: Node,
  importance: Map<string, ImportanceEntry>,
): number {
  const memberIds = new Set(cluster.members ?? []);
  let sum = 0;
  for (const id of memberIds) {
    sum += importance.get(id)?.importance ?? 0;
  }
  return sum;
}

/** True for test scaffolding paths — the test-helper deprioritization signal for the enrich queue. */
export function isTestPath(file?: string): boolean {
  // Fixture and golden-data directories are test material too: `packages/parsers/fixtures/go/auth.go`
  // is a sample input for the Go parser's tests, not shipped code. Before they were recognised, 289
  // symbols (7% of this repo's graph) ranked alongside production code — surfacing fixture symbols
  // in top-symbol lists and offering them for enrichment ahead of real modules.
  //
  // Only DIRECTORY segments match (the trailing slash), so an ordinary `src/fixtures.ts` module is
  // untouched. This governs ranking only; nothing here excludes a file from the graph.
  return (
    !!file &&
    /(\.test\.|\.spec\.|__tests__|(?:^|\/)tests?\/|(?:^|\/)(?:fixtures?|__fixtures__|testdata)\/)/.test(
      file,
    )
  );
}
