/**
 * W6 — Always-fresh working overlay (PRD line 365).
 *
 * A SEPARATE, EPHEMERAL in-memory {@link SoulStore} that mirrors the committed canonical soul, then
 * swaps in re-parsed nodes/edges for files that are dirty (uncommitted) or untracked. The overlay is
 * never persisted — its store is constructed with `ephemeral: true`, so `SoulStore.commit()` is a
 * structural no-op — which means the committed `.crib/graph` shards stay byte-identical while edits
 * become queryable through the composite read model (PRD exit gate line 375). The PRD failure-audit
 * (line 467) mandates this separation: a single-soul design would let an accidental `commit()` during
 * watch dirty the canonical soul; an isolated ephemeral overlay store cannot.
 *
 * Design — full in-memory copy, not a small-delta merge:
 *   The overlay `load()`s from the canonical `.crib` directory (fast — no per-node AJV validation,
 *   unlike `putNodes`), giving it a full in-memory copy of the canonical graph. Refresh then re-parses
 *   only the dirty files plus their reverse-dependency closure into the overlay, reusing the existing
 *   incremental engine (`removeByFile` + `runStructure` + `runParse` + `runResolve`) UNCHANGED — no
 *   SymbolTable surgery or composed-soul wrapper. The memory cost is bounded by C4-default scale
 *   (100k LOC / 10k files ≈ tens of MB), acceptable for a long-lived `crib serve` process. The
 *   composite read model delegates to `overlay.store` when the overlay is active (see
 *   {@link GraphStore.setWorkingOverlay}), so the overlay IS the composed graph — no merge math.
 *
 * Convergence guarantees (PRD exit gate line 375):
 *   - edits queryable without dirtying committed `.crib/graph` — the overlay mutates in memory only;
 *     `commit()` is a no-op.
 *   - after commit, canonical and overlay converge — an external `crib update` advances the canonical
 *     on-disk manifest; the watch fallback detects the drift via {@link canonicalDrifted} and calls
 *     {@link resync}, which re-seeds the overlay from disk and recomputes the dirty set.
 *   - restarting watch produces the same working snapshot — reconstruction is deterministic from VCS
 *     state: seed from canonical + mark dirty every uncommitted/untracked source file + refresh.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Edge, Manifest, Node } from '@knowledge-crib/soul-schema';
import { graphPaths } from './graph-layout.js';
import { pathFromId } from './shard.js';
import { SoulStore } from './soul-store.js';

/** The canonical-manifest fields the overlay watches for drift caused by an external `crib update`. */
export interface CanonicalFingerprint {
  vcsHead: string | null;
  lastUpdated: string;
  extractedGeneration: number;
  nodes: number;
  edges: number;
}

/**
 * Read the ON-DISK canonical graph manifest (not an in-memory SoulStore's possibly-stale copy) so the
 * watch fallback can detect that another process advanced the committed soul. Reads `.crib/graph/
 * manifest.json` — the FULL graph manifest that carries `stats`/`generation`/`repo.vcsHead` — NOT the
 * byte-stable `.crib/crib.json` bootstrap locator, which strips those fields and would never show
 * drift. Returns `null` when the manifest is absent (un-indexed — the overlay wouldn't be active).
 */
export function canonicalFingerprint(cribDir: string): CanonicalFingerprint | null {
  const manifestPath = graphPaths(cribDir).manifest;
  if (!existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    return {
      vcsHead: m.repo?.vcsHead ?? null,
      lastUpdated: m.stats?.lastUpdated ?? '',
      extractedGeneration: m.generation?.extracted ?? 0,
      nodes: m.stats?.nodes ?? 0,
      edges: m.stats?.edges ?? 0,
    };
  } catch {
    return null;
  }
}

export class WorkingOverlay {
  /** The ephemeral in-memory store that holds canonical + the dirty swap. Never persisted. */
  readonly store: SoulStore;
  private readonly dirtyFiles = new Set<string>();
  private readonly canonicalCribDir: string;
  private lastFingerprint: CanonicalFingerprint | null;

  /**
   * @param canonical the committed soul the overlay mirrors. The overlay reads canonical's `.crib`
   *   directory for its seed + drift checks; it never mutates the passed store.
   */
  constructor(canonical: SoulStore) {
    this.canonicalCribDir = canonical.cribDir;
    // Ephemeral: commit() is a no-op, so loading from the canonical cribDir is safe — the overlay
    // hydrates from canonical's shards but can never write back to them.
    this.store = new SoulStore(canonical.cribDir, { ephemeral: true });
    this.store.load();
    this.lastFingerprint = canonicalFingerprint(canonical.cribDir);
  }

  /** Sorted repo-relative POSIX paths currently overridden by the overlay. */
  get dirty(): readonly string[] {
    return [...this.dirtyFiles].sort();
  }

  get isSealed(): boolean {
    return this.dirtyFiles.size === 0;
  }

  isDirty(path: string): boolean {
    return this.dirtyFiles.has(path);
  }

  /** The canonical-manifest fingerprint captured at seed/resync time (for drift comparison). */
  get fingerprint(): CanonicalFingerprint | null {
    return this.lastFingerprint;
  }

  /**
   * Has the canonical ON-DISK soul advanced since the overlay last seeded? An external `crib update`
   * (or `crib index`) bumps `generation.extracted` + `lastUpdated` + usually `vcsHead`; this returns
   * true when any of those moved, so the watch fallback knows to {@link resync} before refreshing.
   * Cheap: one `readFileSync` of the graph manifest, no graph hydration.
   */
  canonicalDrifted(): boolean {
    const current = canonicalFingerprint(this.canonicalCribDir);
    if (!current || !this.lastFingerprint) return current !== this.lastFingerprint;
    return (
      current.vcsHead !== this.lastFingerprint.vcsHead ||
      current.lastUpdated !== this.lastFingerprint.lastUpdated ||
      current.extractedGeneration !== this.lastFingerprint.extractedGeneration ||
      current.nodes !== this.lastFingerprint.nodes ||
      current.edges !== this.lastFingerprint.edges
    );
  }

  /**
   * Mark a file dirty: record it for re-parse on the next refresh. Does NOT drop the overlay's records
   * yet — the reverse-dependency closure is computed from the CANONICAL soul (whose edges are always
   * intact) inside the pipeline refresher BEFORE removal, mirroring `updateRepo`'s closure-before-
   * remove ordering. If we removed here, the incoming `B→dirty` edges would vanish from the overlay and
   * the closure scan would miss B, silently dropping the edge (the P0-1 fix from `updateRepo`). Until
   * the next refresh, reads see the pre-edit overlay state for this file — the freshness window is one
   * debounce. Idempotent.
   */
  markDirty(path: string): void {
    this.dirtyFiles.add(path);
  }

  /**
   * Cold-path re-seed: re-hydrate the overlay from the canonical ON-DISK soul (picking up an external
   * `crib update`) and clear the dirty set. The caller then re-marks the still-dirty files from VCS
   * (`uncommittedChanges` ∪ `untrackedFiles`) and calls the pipeline refresher to re-parse them. O(the
   * canonical graph) but infrequent — only on detected drift or restart.
   */
  resync(): void {
    this.store.load();
    this.dirtyFiles.clear();
    this.lastFingerprint = canonicalFingerprint(this.canonicalCribDir);
  }

  /**
   * Restore a SINGLE committed file into the overlay (used when a file leaves the dirty set without a
   * full resync — e.g. the watch refresh path determined a file is byte-identical to canonical and can
   * drop out of the overlay). Copies the canonical node/edge records for `path` from `canonical` back
   * into the overlay store after removing the overlay's current records for that path. Edges whose
   * OTHER endpoint is also dirty are skipped — the dirty endpoint's re-parse will re-emit them.
   */
  restoreFrom(canonical: SoulStore, path: string): void {
    if (!this.dirtyFiles.delete(path)) return;
    this.store.removeByFile(path);
    const nodes: Node[] = [];
    for (const n of canonical.iterate()) {
      if (n.file === path || pathFromId(n.id) === path) nodes.push(n);
    }
    if (nodes.length > 0) this.store.putNodes(nodes);
    const edges: Edge[] = [];
    for (const e of canonical.iterateEdges()) {
      const sPath = pathFromId(e.src);
      const dPath = pathFromId(e.dst);
      const touches = sPath === path || dPath === path;
      if (!touches) continue;
      const other = sPath === path ? dPath : sPath;
      if (other !== undefined && this.dirtyFiles.has(other)) continue; // dirty endpoint re-emits it
      edges.push(e);
    }
    if (edges.length > 0) this.store.putEdges(edges);
  }
}
