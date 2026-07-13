import type { SoulStore } from '@knowledge-crib/core';
/**
 * M3.1 ownership layer — `git blame` → symbol-level `owned-by` edges (EXTRACTED provenance).
 *
 * Answers "who do I ask about this code" as a graph query: every callable symbol gets an edge to the
 * git author `git blame` attributes its source lines to. A non-git repo is a clean no-op (no owners,
 * no edges), so the deterministic index path is unchanged outside a git work tree. `owned-by` is
 * EXTRACTED (a deterministic, file-derived fact, not a similarity inference) with confidence 1, so it
 * belongs in the `--extracted-only` deterministic subset and survives the byte-identical invariant.
 *
 * Cost: one `git blame` per file with symbols. Bounded by the file count a full index discovers; the
 * M3.6 scale bench decides whether to shard for ≥1M-LOC repos. For a typical repo this is comfortably
 * fast and runs once per full index (incremental `update` re-blames only changed files).
 */
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import { blameLines, currentHead, isGitRepo } from './vcs.js';

export interface OwnershipStats {
  /** files blame ran over (files with ≥1 symbol node). */
  files: number;
  /** symbols attributed to an owner (an edge was emitted). */
  symbols: number;
  /** distinct owner nodes created. */
  owners: number;
  /** `owned-by` edges emitted. */
  edges: number;
  /** symbols with no blame coverage (untracked file / blame failed / span outside blame). */
  skipped: number;
}

/** Build the `owner` node for an author identity (deduped by email, name-only fallback). */
export function ownerNode(name: string, email?: string): Node {
  const id = email ? idFor({ kind: 'owner', email }) : idFor({ kind: 'owner-name', name });
  return {
    id,
    kind: 'owner',
    hash: contentHash(id),
    name,
    ...(email ? { email } : {}),
  };
}

/** Majority author across a symbol's span lines; ties break toward the start-line author (the one who
 *  touched where the symbol begins — the most representative owner for a single-author body). */
function majorityAuthor(
  blame: Map<number, { name: string; email?: string; commit: string }>,
  start: number,
  end: number,
): { name: string; email?: string; commit: string } | null {
  const tally = new Map<
    string,
    { count: number; rec: { name: string; email?: string; commit: string } }
  >();
  let first: { name: string; email?: string; commit: string } | null = null;
  for (let line = start; line <= end; line++) {
    const rec = blame.get(line);
    if (!rec) continue;
    const key = rec.email ?? rec.name;
    if (!first) first = rec;
    const entry = tally.get(key);
    if (entry) entry.count++;
    else tally.set(key, { count: 1, rec });
  }
  if (tally.size === 0) return first;
  let best: { count: number; rec: { name: string; email?: string; commit: string } } | null = null;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.rec ?? first;
}

/** Run the ownership phase: emit `owner` nodes + symbol→owner `owned-by` edges from `git blame`.
 *  `onlyFiles` (when set) restricts to those repo-relative paths — the incremental-update path re-blames
 *  only changed files (their old `owned-by` edges were dropped by `removeByFile`), so a body edit
 *  re-attributes ownership instead of leaving symbols ownerless. Undefined ⇒ all files with symbols. */
export function runOwnership(
  soul: SoulStore,
  root: string,
  onlyFiles?: Set<string>,
): OwnershipStats {
  const stats: OwnershipStats = { files: 0, symbols: 0, owners: 0, edges: 0, skipped: 0 };
  if (!isGitRepo(root)) return stats;
  let head = '';
  try {
    head = currentHead(root);
  } catch {
    return stats;
  }

  // Group symbol nodes by file (blame is per-file; one git call amortises a file's whole symbol set).
  const byFile = new Map<string, Node[]>();
  for (const node of soul.iterate('symbol')) {
    if (!node.file || !node.span) continue;
    if (onlyFiles && !onlyFiles.has(node.file)) continue;
    const list = byFile.get(node.file);
    if (list) list.push(node);
    else byFile.set(node.file, [node]);
  }

  const owners = new Map<string, Node>();
  const edges: Edge[] = [];
  const REL: Rel = 'owned-by';

  for (const [file, symbols] of byFile) {
    const blame = blameLines(root, file);
    if (blame.length === 0) {
      stats.skipped += symbols.length;
      continue;
    }
    stats.files++;
    const lineMap = new Map<number, { name: string; email?: string; commit: string }>();
    for (const b of blame) lineMap.set(b.line, { name: b.name, email: b.email, commit: b.commit });
    for (const sym of symbols) {
      const span = sym.span!;
      const owner = majorityAuthor(lineMap, span.start, span.end);
      if (!owner) {
        stats.skipped++;
        continue;
      }
      const key = owner.email ?? owner.name;
      let on = owners.get(key);
      if (!on) {
        on = ownerNode(owner.name, owner.email);
        owners.set(key, on);
      }
      edges.push({
        id: edgeId(sym.id, on.id, REL),
        src: sym.id,
        dst: on.id,
        rel: REL,
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'git-blame', commit: owner.commit, head },
      });
      stats.symbols++;
    }
  }

  if (owners.size > 0) soul.putNodes([...owners.values()]);
  if (edges.length > 0) soul.putEdges(edges);
  stats.owners = owners.size;
  stats.edges = edges.length;
  return stats;
}
