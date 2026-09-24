/**
 * WP4 — the serving process's serialized refresh loop and reader-bundle registry.
 *
 * One coordinator per serve process routes EVERY refresh trigger (startup, file events, fallback
 * scans, clean transitions, external `crib update`) through a single serialized slot (WP4.1). Each
 * cycle builds a FRESH, INVISIBLE candidate — a new WorkingOverlay seeded from the on-disk
 * canonical graph plus a new in-memory FTS projection built from it — re-checks the live source
 * BEFORE publication, and only then publishes the pair as one reader bundle (WP4.4). Nothing ever
 * mutates the serving bundle in place: the torn window the old watch mode had (refresh awaits
 * interleaving with queries over a half-updated overlay) is gone because the serving bundle is
 * immutable from the moment it is adopted.
 *
 * The serving bundle never changes between requests:
 *   - every verb except `memorySync` is synchronous, so an MCP request is one uninterruptible verb
 *     call and a synchronous swap can never land inside it;
 *   - `memorySync` (and any future async verb) is pinned by the request-level retain/release the
 *     MCP pin router wraps around every tools/call — a published bundle WAITS in
 *     `publishedGeneration` until the in-flight requests drain (WP4.5), then the swap retires the
 *     old bundle (closing its FTS index) only when nothing can be reading it.
 *
 * A failed cycle (parse/git/build) discards its candidate and leaves the last-good bundle serving,
 * recording the error for `readerFreshness` until a later cycle SUCCEEDS (WP4.6).
 *
 * Determinism: a cycle's output is a pure function of (on-disk canonical graph, VCS state), so a
 * process restart reproduces the same bundle — the PRD's restart-convergence property, now by
 * construction instead of by replay.
 */
import { SqliteIndexStore, WorkingOverlay, canonicalFingerprint } from '@knowledge-crib/core';
import type { SoulStore } from '@knowledge-crib/core';
import type { ReaderFreshness, ReaderRefreshError, RefreshState } from '@knowledge-crib/mcp';
import { STALE_REASONS } from '@knowledge-crib/mcp';
import {
  AnchorUnavailableError,
  type Extractor,
  type OverlayRefreshResult,
  changedFilesSince,
  contentDigestForPaths,
  currentHead,
  refreshWorkingOverlay,
  trackedFiles,
  uncommittedChanges,
  untrackedFiles,
} from '@knowledge-crib/pipeline';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { type RefreshReason, isWatchable } from './watch.js';

/** The candidate's view of the source at capture time — the guard AND the build share one scan. */
export interface SourceCapture {
  /** Live repository HEAD; null when VCS detection failed (unknown ≠ fresh). */
  head: string | null;
  /** HEAD the on-disk canonical graph was built at (manifest, not in-memory — external updates move it). */
  indexedHead: string | null;
  /** Fingerprint of the on-disk canonical graph manifest — external `crib update` detector. */
  canonicalFp: string | null;
  /** Content-addressed digest over the watchable dirty set (changed-since-index ∪ uncommitted ∪ untracked). */
  dirtyFp: string;
  /** The watchable dirty set itself, sorted — the candidate's overlay scope. */
  dirtyPaths: string[];
  /** 'unavailable' when `changedFilesSince(indexedHead)` could not resolve (history rewritten). */
  anchor: 'available' | 'unavailable';
  /**
   * Durable memory-graph source position. A change makes the candidate differ from the one being
   * served (so a rebuild and a new graph publication happen), but NOT a new CODE-reader generation:
   * it is an input to candidate equality, not to {@link bundleGeneration} (D2-a).
   */
  graphSourcePosition: string | null;
}

/** A disposable memory-graph read model staged with code graph and FTS before publication. */
export interface DerivedGraphReader {
  /** Must be the same identity as the containing reader bundle. */
  readonly generation: string;
  /** Durable memory-journal position represented by this graph projection. */
  readonly sourcePosition: string | null;
  /**
   * The graph's OWN identity: the monotonic publication counter of the projection that built it
   * (D2-b). Independent of {@link generation} on purpose.
   *
   * `generation` says which CODE the projection describes, and a bundle must not publish a graph
   * describing different code. `publication` says WHICH projection this is, and it moves on every
   * rebuild — including the rebuild a memory-only mutation causes, which does not move `generation`
   * (D2-a). Without it the freshness report could only ever restate `readerGeneration` as
   * `graphGeneration` (`graphGeneration === readerGeneration` by construction), so an agreement
   * check between the two could never fail and would prove nothing. With it the two CAN disagree,
   * and the memory-graph half of an answer has an identity a caller can actually cite.
   */
  readonly publication: number;
  close(): void;
}

export interface GraphBuildInput {
  readonly generation: string;
  readonly capture: SourceCapture;
  readonly overlay: WorkingOverlay;
}

/** One published graph+FTS pair. Immutable from publication until retired. */
export interface ReaderBundle {
  /** Content-generation id (blake3 over the source capture) — graph and FTS agree on it by
   * construction: both projections are derived from the SAME overlay store, sequentially, with the
   * source re-check guarding that the store still describes the live tree (WP4.4). */
  readonly generation: string;
  /** The capture this bundle was built from — the reader-staleness comparison base. */
  readonly capture: SourceCapture;
  readonly overlay: WorkingOverlay;
  readonly index: SqliteIndexStore;
  /** Authorized graph projection built from the candidate's memory source position. */
  readonly graph: DerivedGraphReader | undefined;
  /** Refresh stats for logging; undefined when the cycle had nothing dirty to re-parse. */
  readonly refresh: OverlayRefreshResult | undefined;
  /** ISO timestamp of the moment this bundle became the published one. */
  publishedAt: string;
}

export interface RefreshCoordinatorOpts {
  /** Include nonignored untracked files in the overlay; default true (PRD line 367). */
  includeUntracked?: boolean;
  /** Test/CLI passthrough to refreshWorkingOverlay's extractor fleet. */
  extractors?: Extractor[];
  /** Log line per successful publication (stderr in `crib serve`). */
  onPublish?: (bundle: ReaderBundle, reason: RefreshReason) => void;
  /** Non-fatal warnings (discarded candidates, scan failures). */
  onWarn?: (message: string) => void;
  /** TEST SEAM — invoked between candidate build and source re-check; write to the tree from here to
   *  reproduce "the source changed during refresh" deterministically (WP4.4 scenario). */
  onCandidateBuilt?: (bundle: ReaderBundle) => void | Promise<void>;
  /** Durable graph-source position. It participates in candidate EQUALITY (so a memory-only change
   *  still rebuilds and republishes), but not in the code-reader generation id (D2-a). */
  graphSourcePosition?: () => string | null;
  /** Builds a memory graph before a candidate can publish. A throw rejects the whole candidate. */
  buildGraph?: (input: GraphBuildInput) => Promise<DerivedGraphReader> | DerivedGraphReader;
}

/**
 * WP4.7 — the cold (non-serving) ReaderFreshness: what `crib status`, the viz server and manual-mode
 * serve report. The reader here IS the committed index, so committed-behind-HEAD is genuine reader
 * staleness (watch mode's overlay compensation does not exist). No bundle exists, so the generation
 * fields are honestly null — never a fabricated "current".
 */
export function coldReaderFreshness(repoRoot: string, cribDir: string): ReaderFreshness {
  const fp = canonicalFingerprint(cribDir);
  let head: string | null = null;
  try {
    head = currentHead(repoRoot) ?? null;
  } catch {
    head = null;
  }
  const indexed = (fp?.nodes ?? 0) > 0;
  const staleReasons: string[] = [];
  let stale = false;
  if (head !== null && fp?.vcsHead != null && head !== fp.vcsHead) {
    stale = true;
    staleReasons.push(STALE_REASONS.COMMITTED_BEHIND);
  }
  if (head === null) {
    staleReasons.push(STALE_REASONS.SOURCE_UNKNOWN);
    // An index anchored to a commit means this project IS VCS-backed, so a null live head is a
    // FAILED read, not a project without history: the reader cannot be shown to match anything, and
    // unknown must not read as fresh (A05). A never-VCS-backed project is annotated, not stale —
    // its content comparison is still meaningful.
    if (fp?.vcsHead != null) stale = true;
  }
  return {
    indexedHead: fp?.vcsHead ?? null,
    currentHead: head,
    publishedGeneration: null,
    readerGeneration: null,
    graphSourcePosition: fp
      ? `${fp.vcsHead}|${fp.extractedGeneration}|${fp.nodes}|${fp.edges}|${fp.lastUpdated}`
      : null,
    codeRevision: head,
    graphGeneration: null,
    searchGeneration: null,
    refreshState: indexed ? 'idle' : 'unindexed',
    stale,
    staleReasons,
    lastSuccessfulRefreshAt: fp?.lastUpdated ?? null,
    lastRefreshError: null,
  };
}

function captureEquals(a: SourceCapture, b: SourceCapture): boolean {
  return (
    a.head === b.head &&
    a.indexedHead === b.indexedHead &&
    a.canonicalFp === b.canonicalFp &&
    a.dirtyFp === b.dirtyFp &&
    a.anchor === b.anchor &&
    a.graphSourcePosition === b.graphSourcePosition
  );
}

/**
 * The CODE-reader generation: a content id over the code capture alone.
 *
 * `graphSourcePosition` — the durable memory-ledger position — is deliberately NOT an input (D2-a).
 * It used to be, which priced a memory-only mutation as a code change: one appended memory line
 * moved the code-reader generation and forced a full overlay + FTS + graph candidate rebuild
 * (`refresh-coordinator.ts:410-441`), re-parsing code that had not changed.
 *
 * Removing it does NOT make a memory change invisible, and that is the point of doing the two parts
 * together. `captureEquals` still compares the position, so the coordinator still rebuilds and still
 * publishes; what no longer moves is the CODE identity. The memory side is covered by the two things
 * that genuinely describe it: the graph reader's own publication counter ({@link DerivedGraphReader})
 * and the evaluation cache's `ledger` slot (WP1 item 8), which reads `store.readStoreGeneration()`.
 * A memory-only change therefore shows up as a new graph publication against an unchanged reader
 * generation — two fields that CAN disagree, which is what makes an agreement row evidence rather
 * than a tautology (D2-b).
 */
function bundleGeneration(capture: SourceCapture): string {
  return `reader:${blake3Hex(
    [capture.canonicalFp ?? 'none', capture.head ?? 'none', capture.dirtyFp, capture.anchor].join(
      '\\0',
    ),
  )}`;
}

export class RefreshCoordinator {
  private current: ReaderBundle | undefined;
  private published: ReaderBundle | undefined;
  private busy = false;
  private pendingReason: RefreshReason | undefined;
  /** Set when a candidate was discarded mid-cycle (WP4.4) — guarantees a retry even with no further event. */
  private reschedule = false;
  private lastCapture: SourceCapture | undefined;
  private lastRefreshError: ReaderRefreshError | null = null;
  private lastSuccessfulRefreshAt: string | null = null;
  private initialized = false;
  /** In-flight MCP requests (RequestPins) — a swap drains these before landing (WP4.5). */
  private inFlight = 0;
  private adopter: ((bundle: ReaderBundle) => void) | undefined;
  private closed = false;
  /** Bundles whose native index has already been closed — the exactly-once disposal guard. */
  private readonly disposed = new WeakSet<ReaderBundle>();
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly canonical: SoulStore,
    private readonly repoRoot: string,
    private readonly opts: RefreshCoordinatorOpts = {},
  ) {}

  /** Build + publish the first bundle. Called BEFORE the watcher exists (startup is itself a
   *  refresh trigger — WP4.1 "route initial startup through it"). A save landing mid-build
   *  discards the initial candidate and queues a replay (WP4.4); startup sees that chain through
   *  instead of crashing — it throws only when the chain settles WITHOUT ever publishing (nothing
   *  to serve), which is the loud failure the exit gate wants. */
  async initialize(): Promise<void> {
    await this.refresh('initial');
    while (
      this.current === undefined &&
      (this.busy || this.reschedule || this.pendingReason !== undefined)
    ) {
      await this.whenIdle();
    }
    if (!this.current) throw new Error('refresh coordinator failed to publish an initial bundle');
    this.initialized = true;
  }

  /** Request a refresh cycle. Serialized + coalescing: a trigger while a cycle runs latches into ONE
   *  pending reason (newest wins), replayed from the cycle's finally — concurrent triggers coalesce
   *  to a single cycle, and a no-op trigger (nothing changed) costs one VCS scan, nothing more. */
  requestRefresh(reason: RefreshReason): void {
    if (this.closed || this.busy) {
      if (this.busy) this.pendingReason = reason;
      return;
    }
    const capture = this.captureSource();
    // lastCapture is set ONLY by a successful publication — before the first one nothing can match,
    // so the initial cycle (which bypasses requestRefresh) and its retries always run. This also
    // guards the post-initial replay, which fires from the initial's finally BEFORE initialize()
    // stamps `initialized`: an unchanged source ends the chain instead of rebuilding a bundle
    // nobody needs.
    if (this.lastCapture !== undefined && captureEquals(capture, this.lastCapture)) {
      this.flushIdle(); // an unchanged source is the loop's steady state — waiters may settle
      return;
    }
    void this.refresh(reason, capture);
  }

  /** WP4.5 — pin bundle adoption while requests are in flight. Implements the MCP RequestPins. */
  retain(): void {
    this.inFlight++;
  }

  release(): void {
    this.inFlight--;
    if (this.inFlight <= 0) {
      this.inFlight = 0;
      this.maybeSwap(true);
    }
  }

  /** Called (by `crib serve`) once the Verbs instance exists; adopts every LATER publication. */
  setAdopter(adopter: (bundle: ReaderBundle) => void): void {
    this.adopter = adopter;
  }

  /** The serving bundle's overlay store — cmdServe wires it into the Verbs deps at construction. */
  get currentOverlay(): SoulStore | undefined {
    return this.current?.overlay.store;
  }

  /** The serving bundle's in-memory FTS projection (paired with the same overlay snapshot). */
  get currentIndex(): SqliteIndexStore | undefined {
    return this.current?.index;
  }

  /** The serving bundle's authorized memory graph, when the caller configured one. */
  get currentGraph(): DerivedGraphReader | undefined {
    return this.current?.graph;
  }

  /**
   * WP1 item 8 — the generation of the bundle THIS process is currently SERVING reads through. O(1)
   * and side-effect free, unlike {@link freshness}, which recomputes a source capture to report
   * staleness right now and is a diagnostic, not a per-query accessor.
   *
   * This is what a memory read pins its verdicts against: they move when — and only when — this
   * string moves. `null` while no bundle is adopted (the serve process is still starting, or this is
   * a one-shot command with no reader at all); a caller that has a reader but cannot name it must
   * express that as `UNVERSIONED`, never as `null`.
   */
  get currentReaderGeneration(): string | null {
    return this.current?.generation ?? null;
  }

  /** The serving bundle's dirty scope — surfaced for the serve startup banner. */
  get currentDirtyPaths(): readonly string[] {
    return this.current?.capture.dirtyPaths ?? [];
  }

  /** Resolves when the refresh loop is idle (no cycle running, nothing pending). Test + shutdown use. */
  whenIdle(): Promise<void> {
    if (!this.busy && this.pendingReason === undefined && !this.reschedule)
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** WP4.7 — the live ReaderFreshness for this serving process. Recomputes the source capture so
   *  `stale` reflects RIGHT NOW, not the last tick: a status call is a health check and must not
   *  answer from a cached "probably fine". */
  freshness(): ReaderFreshness {
    const live = this.captureSource();
    const served = this.current;
    const staleReasons: string[] = [];
    let stale = false;
    if (served !== undefined) {
      if (live.head !== null && served.capture.head !== null && live.head !== served.capture.head) {
        stale = true;
        staleReasons.push(STALE_REASONS.HEAD_MOVED);
      }
      if (live.dirtyFp !== served.capture.dirtyFp) {
        stale = true;
        staleReasons.push(STALE_REASONS.WORKING_TREE_CHANGED);
      }
      if (live.canonicalFp !== served.capture.canonicalFp) {
        stale = true;
        staleReasons.push(STALE_REASONS.CANONICAL_ADVANCED);
      }
    }
    // Committed index behind HEAD is NOT reader-stale on its own — the overlay compensates for
    // exactly those files. Reported as a reason, kept distinct from the active-reader verdict.
    if (
      live.indexedHead !== null &&
      live.head !== null &&
      live.indexedHead !== live.head &&
      !staleReasons.includes(STALE_REASONS.COMMITTED_BEHIND)
    ) {
      staleReasons.push(STALE_REASONS.COMMITTED_BEHIND);
    }
    // The generation invariant, checked as IDENTITY rather than inferred from content: a bundle
    // published while a request was pinned is not what the reader serves, and a source that has
    // meanwhile returned to the reader's own state makes every content comparison agree again. The
    // reader is still behind, and only comparing the two bundles can see it (A05).
    //
    // Bundle identity, NOT generation equality. The generation was only ever a proxy for "these are
    // different bundles", and since D2-a took the memory position out of it, two bundles CAN now
    // share a generation while differing in their graph publication: a memory-only mutation
    // published behind a pinned request would have gone unreported (the reader still serving the
    // old graph, with nothing in the report saying so). Identity is the exact test and cannot drift.
    if (served !== undefined && this.published !== undefined && this.published !== served) {
      stale = true;
      staleReasons.push(STALE_REASONS.ADOPTION_PENDING);
    }
    if (live.anchor === 'unavailable') {
      stale = true;
      staleReasons.push(STALE_REASONS.ANCHOR_UNAVAILABLE);
    }
    if (live.head === null) {
      staleReasons.push(STALE_REASONS.SOURCE_UNKNOWN);
      if (live.indexedHead !== null) stale = true; // VCS-backed + unreadable = unknown ≠ fresh
    }
    return {
      indexedHead: live.indexedHead,
      currentHead: live.head,
      publishedGeneration: this.published?.generation ?? null,
      readerGeneration: served?.generation ?? null,
      graphSourcePosition:
        served?.graph?.sourcePosition ??
        served?.capture.graphSourcePosition ??
        served?.capture.canonicalFp ??
        null,
      codeRevision: served?.capture.head ?? null,
      // The graph's OWN publication, never the bundle generation (D2-b). The old `?? served.generation`
      // tail was a fabricated agreement: with no graph in the bundle it answered "the graph generation
      // is the reader's generation", which is not a weaker statement than the truth — it is a
      // different one, and a false one. A graph that does not exist has no generation.
      graphGeneration: served?.graph === undefined ? null : String(served.graph.publication),
      // The FTS projection is NOT optional on a bundle: it is built from the same overlay, in the
      // same cycle, and disposed with it. So a served bundle's search generation IS its generation
      // — reported explicitly rather than left to be inferred, because the WP-G3 exit is that a
      // caller can SEE that the graph and search halves of its answer came from one generation.
      searchGeneration: served?.generation ?? null,
      refreshState: this.refreshState(),
      stale,
      staleReasons,
      lastSuccessfulRefreshAt: this.lastSuccessfulRefreshAt,
      lastRefreshError: this.lastRefreshError,
    };
  }

  /** Shutdown: no further cycles, and every bundle's FTS index closed. The in-memory overlays are
   *  ephemeral (GC); the canonical on-disk graph was never touched. */
  close(): void {
    this.closed = true;
    this.dispose(this.published);
    this.dispose(this.current);
    this.current = undefined;
    this.published = undefined;
  }

  /**
   * Close one bundle's native index, at most once ever.
   *
   * Every bundle this coordinator builds owns a SqliteIndexStore, and a bundle leaves service by
   * exactly one of four routes: discarded mid-cycle, superseded before adoption, retired by a swap,
   * or shut down. The superseded route had no owner at all (A08) — a publication simply overwrote
   * the pending pointer — so the identity set is tracked here instead of at each call site, which
   * also makes a double close (the same defect from the other side) impossible.
   */
  private dispose(bundle: ReaderBundle | undefined): void {
    if (bundle === undefined || this.disposed.has(bundle)) return;
    this.disposed.add(bundle);
    bundle.index.close();
    bundle.graph?.close();
  }

  private refreshState(): RefreshState {
    if (this.busy) return 'refreshing';
    if (this.pendingReason !== undefined || this.reschedule) return 'queued';
    if (!this.initialized) return 'unindexed';
    if (this.lastRefreshError !== null) return 'error';
    return 'idle';
  }

  /** One serialized cycle: capture → build candidate → re-check source → publish → replay pending. */
  private async refresh(reason: RefreshReason, capture?: SourceCapture): Promise<void> {
    const start = capture ?? this.captureSource();
    this.busy = true;
    let candidate: ReaderBundle | undefined;
    let published = false;
    try {
      candidate = await this.buildBundle(start);
      await this.opts.onCandidateBuilt?.(candidate);
      // Shutdown owns no new readers. A candidate that completed after close is still invisible,
      // so discard it through the normal exactly-once cleanup path rather than resurrecting a
      // bundle after the server has released its request pins and transport.
      if (this.closed) return;
      // WP4.4 — the candidate is INVISIBLE until the source re-check agrees with the capture it was
      // built from. A save that landed mid-build means the bundle answers a question the tree has
      // already stopped asking: discard + reschedule, never publish-then-patch.
      const now = this.captureSource();
      if (!captureEquals(now, start)) {
        this.reschedule = true;
        this.opts.onWarn?.(
          'source changed during refresh — candidate discarded, a new cycle is queued',
        );
        return;
      }
      // From this point the publication register owns candidate disposal, including an observer
      // that throws after the reader has become current.
      published = true;
      this.publish(candidate, reason);
      this.lastCapture = start;
      this.lastSuccessfulRefreshAt = new Date().toISOString();
      // WP4.7 — an error clears ONLY on a successful refresh, never with time.
      this.lastRefreshError = null;
    } catch (err) {
      // WP4.6 — last-good keeps serving. The candidate (if any) is discarded below.
      this.lastRefreshError = {
        code: (err as Error).name ?? 'Error',
        message: (err as Error).message ?? String(err),
        occurredAt: new Date().toISOString(),
      };
      this.opts.onWarn?.(`refresh failed: ${this.lastRefreshError.message}`);
    } finally {
      if (candidate && !published) this.dispose(candidate);
      this.busy = false;
      // Coalesced replay: exactly one queued trigger, newest reason wins. Routed through
      // requestRefresh so the capture guard applies — an unchanged source ENDS the chain here
      // instead of rebuilding a bundle nobody needs (the discard path relies on this: its
      // reschedule fires only while the source still disagrees with the last publication).
      const replay = this.pendingReason ?? (this.reschedule ? 'fallback' : undefined);
      this.pendingReason = undefined;
      this.reschedule = false;
      if (!this.closed && replay !== undefined) {
        this.requestRefresh(replay);
      } else {
        this.flushIdle();
      }
    }
  }

  /** Build the invisible candidate: fresh overlay seeded from the on-disk canonical + the full
   *  watchable dirty scope + FTS and memory-graph projections over the same captured inputs. */
  private async buildBundle(capture: SourceCapture): Promise<ReaderBundle> {
    // Pick up an external `crib update` before seeding: both the in-memory semantic layer (Verbs
    // reads `soul`) and the overlay's canonical seed must describe the same on-disk graph.
    this.canonical.load();
    const overlay = new WorkingOverlay(this.canonical);
    for (const path of capture.dirtyPaths) overlay.markDirty(path);
    let refresh: OverlayRefreshResult | undefined;
    if (overlay.dirty.length > 0) {
      refresh = await refreshWorkingOverlay(overlay, this.canonical, this.repoRoot, {
        ...(this.opts.extractors ? { extractors: this.opts.extractors } : {}),
      });
    }
    const index = new SqliteIndexStore();
    let graph: DerivedGraphReader | undefined;
    try {
      index.buildFromSoul(overlay.store, this.repoRoot);
      const generation = bundleGeneration(capture);
      graph = await this.opts.buildGraph?.({ generation, capture, overlay });
      if (graph !== undefined && graph.generation !== generation) {
        throw new Error(
          `derived graph generation ${graph.generation} does not match reader generation ${generation}`,
        );
      }
      return {
        generation,
        capture,
        overlay,
        index,
        graph,
        refresh,
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      graph?.close();
      index.close();
      throw error;
    }
  }

  /** Publish, then swap if no request is in flight. The published bundle is visible to
   *  `publishedGeneration` immediately — the reader adopts it when the pins drain (WP4.5). */
  private publish(bundle: ReaderBundle, reason: RefreshReason): void {
    bundle.publishedAt = new Date().toISOString();
    // A bundle that was published but never adopted (its swap was deferred by a pinned request) can
    // never be adopted once a newer one supersedes it: it leaves service here, so it is disposed
    // here. Only a bundle that is still SERVING is off limits — the reader is holding its handle.
    const superseded = this.published;
    if (superseded !== undefined && superseded !== this.current && superseded !== bundle)
      this.dispose(superseded);
    this.published = bundle;
    if (this.current === undefined) {
      // Startup: the first bundle becomes the reader directly (there is nothing to retire and no
      // Verbs instance exists yet — cmdServe wires its slots at construction).
      this.current = bundle;
      this.opts.onPublish?.(bundle, reason);
      return;
    }
    this.maybeSwap();
    if (this.current === bundle) this.opts.onPublish?.(bundle, reason);
  }

  private maybeSwap(fromRelease = false): void {
    const next = this.published;
    if (next === undefined || next === this.current) return;
    if (this.inFlight > 0) return; // WP4.5 — wait for the active reader to finish
    const retired = this.current;
    this.current = next;
    this.adopter?.(next);
    // Safe to close NOW: the drain guarantees zero in-flight requests, every verb except
    // `memorySync` is synchronous (a swap can never land inside its own call), and the adopter has
    // already moved both Verbs slots — nothing can still hold the retired FTS handle.
    this.dispose(retired);
    // A DEFERRED adoption can land on a tree that moved while the request was pinned, so the bundle
    // just adopted may already be behind. One scan settles it: requestRefresh's capture guard ends
    // the chain immediately when the source still matches, so the healthy path costs nothing more
    // than the scan and the unhealthy one converges instead of waiting for the next file event.
    if (fromRelease && !this.closed) this.requestRefresh('fallback');
  }

  private flushIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * The source capture: live HEAD + on-disk canonical manifest + a content-addressed digest over the
   * FULL watchable dirty scope. The scope is uniform across every reason — `changedFilesSince` (all
   * commits since the index: branch switches, merges, rebases) ∪ uncommitted ∪ untracked — so the
   * old per-reason state machine (transition/drift latches) is subsumed: every cycle is a pure
   * recompute. Renames surface as removal+addition because both VCS diffs run `--no-renames`.
   * `changedFilesSince` uses `git diff <anchor>..HEAD` (an empty range when the index is current),
   * so a clean checkout with no dirty files still sees the committed delta. Content hashing costs
   * one blake3 pass over files git itself just diffed — the same I/O the old fallback scan spent.
   */
  private captureSource(): SourceCapture {
    const fp = canonicalFingerprint(this.canonical.cribDir);
    let head: string | null = null;
    try {
      head = currentHead(this.repoRoot) ?? null;
    } catch {
      head = null;
    }
    const indexedHead = fp?.vcsHead ?? null;
    const dirty = new Set<string>();
    let anchor: SourceCapture['anchor'] = 'available';
    if (indexedHead !== null && head !== null) {
      try {
        for (const p of changedFilesSince(this.repoRoot, indexedHead)) dirty.add(p);
      } catch (err) {
        if (err instanceof AnchorUnavailableError) {
          // History was rewritten or gc'd — the committed delta is UNKNOWABLE, so the honest repair
          // is a full rebuild from the CURRENT supported tree (every tracked + untracked watchable
          // file), reported through staleReasons until `crib update` re-anchors. Never a crash and
          // never a silent partial overlay that would answer from a mix of two histories.
          anchor = 'unavailable';
        }
        // Any other git failure leaves the uncommitted ∪ untracked scope in place — the next tick
        // retries the committed scan.
      }
    }
    try {
      for (const p of uncommittedChanges(this.repoRoot)) dirty.add(p);
    } catch {
      // non-git repo — the untracked overlay below still covers new files
    }
    if (this.opts.includeUntracked ?? true) {
      try {
        for (const p of untrackedFiles(this.repoRoot)) dirty.add(p);
      } catch {
        // best-effort parity with the old watch loop
      }
    }
    if (anchor === 'unavailable') {
      dirty.clear();
      try {
        for (const p of trackedFiles(this.repoRoot)) dirty.add(p);
      } catch {
        // leave untracked-only scope — still a full rebuild of what git can see
      }
      try {
        for (const p of untrackedFiles(this.repoRoot)) dirty.add(p);
      } catch {
        // best-effort
      }
    }
    const watchable = [...dirty].filter(isWatchable).sort();
    let graphSourcePosition: string | null = null;
    try {
      graphSourcePosition = this.opts.graphSourcePosition?.() ?? null;
    } catch {
      // A source-position probe is advisory at capture time. A changed/unreadable source cannot be
      // treated as equal to the prior non-null position, and graph construction itself still fails
      // visibly if the ledger is unreadable.
      graphSourcePosition = null;
    }
    return {
      head,
      indexedHead,
      canonicalFp: fp
        ? `${fp.vcsHead}|${fp.extractedGeneration}|${fp.nodes}|${fp.edges}|${fp.lastUpdated}`
        : null,
      dirtyFp: contentDigestForPaths(this.repoRoot, watchable),
      dirtyPaths: watchable,
      anchor,
      graphSourcePosition,
    };
  }
}
