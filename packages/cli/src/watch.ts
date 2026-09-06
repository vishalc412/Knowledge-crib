/**
 * W6 — watch mode (PRD line 365, exit gate line 375).
 *
 * Keeps a {@link WorkingOverlay} fresh as files change in the working tree, so `crib serve --watch`
 * exposes edits through the composite read model without dirtying the committed `.crib/graph`.
 *
 * Robustness model — the VCS scan is the source of truth, the watcher is a low-latency trigger:
 *   `node:fs.watch` (recursive) fires on save and schedules a debounced refresh; the refresh's dirty
 *   set comes from `uncommittedChanges ∪ untrackedFiles` (gitignore-aware), NOT from the per-event
 *   filename. So gitignored build churn (`dist/`, `node_modules/`) is excluded even when the watcher
 *   fires for it, and a missed event (atomic save, watcher overflow) is caught by the 2s fallback
 *   scan — the PRD's "convergence within one debounce plus one fallback scan." No external dependency
 *   (no chokidar): the 2s fallback guarantees convergence even if `fs.watch` drops events entirely.
 *
 * Convergence:
 *   - external `crib update` advances the canonical on-disk manifest; the fallback scan's drift check
 *     (`overlay.canonicalDrifted`) reloads canonical + resyncs the overlay + recomputes the dirty set.
 *   - branch switch moves many files at once; the fallback scan's `collectDirty` recomputes from VCS.
 *   - process restart: reconstruction is deterministic (seed from canonical + collectDirty + refresh),
 *     so a fresh watch produces the same working snapshot.
 *
 * Watch mode NEVER promotes memory or runs an evaluation/enrichment provider (PRD line 373).
 */
import { type FSWatcher, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SoulStore, WorkingOverlay } from '@knowledge-crib/core';
import {
  type OverlayRefreshResult,
  changedFilesSince,
  currentHead,
  emptyParseStats,
  langForPath,
  refreshWorkingOverlay,
  uncommittedChanges,
  untrackedFiles,
} from '@knowledge-crib/pipeline';

export interface WatchOpts {
  /**
   * Debounce window for coalescing rapid save bursts; default 300ms. G3.4 red line #2 pins watch
   * mode at a 300ms debounce (serialized updates, atomic generation publication, 5s queryable-update
   * p95 target) — the pre-G3.4 default was 500ms; the default moved, existing explicit values win.
   */
  debounceMs?: number;
  /** VCS fallback scan interval — the convergence backstop; default 2000ms (PRD line 370). */
  fallbackMs?: number;
  /** Include nonignored untracked files in the overlay; default true (PRD line 367). */
  includeUntracked?: boolean;
  /** Invoked after each overlay refresh with the result (used for stderr logging in `crib serve`). */
  onRefresh?: (result: OverlayRefreshResult, reason: RefreshReason) => void;
  /** Invoked when an external `crib update` advanced canonical and the overlay resynced. */
  onDrift?: () => void;
  /** Invoked for non-fatal warnings (fallback discoveries, refresh errors). */
  onWarn?: (message: string) => void;
}

export type RefreshReason = 'initial' | 'watcher' | 'fallback' | 'drift' | 'transition';

/** Dirs whose churn must NOT schedule a refresh (build output, deps, the soul itself). */
const IGNORE_PREFIXES = [
  '.git/',
  'node_modules/',
  '.crib/',
  'dist/',
  'build/',
  'coverage/',
  '.next/',
  'out/',
  'target/',
];

export class WatchMode {
  private watcher?: FSWatcher;
  private fallbackTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private refreshing = false;
  private stopped = false;
  /** HEAD observed when the overlay was last seeded; detects clean checkouts with no dirty files. */
  private observedHead?: string;
  /** Latest clean Git transition deferred while another overlay refresh owns the mutation slot. */
  private pendingTransitionHead?: string;

  constructor(
    private readonly canonical: SoulStore,
    private readonly overlay: WorkingOverlay,
    private readonly repoRoot: string,
    private readonly opts: WatchOpts = {},
  ) {}

  /** Start the watcher + fallback scan. Performs the initial dirty-set refresh. Resolves once the
   *  initial refresh completes; the watcher + fallback then run in the background until {@link stop}. */
  async start(): Promise<void> {
    this.observedHead = this.readHead();
    await this.refresh('initial');
    this.watcher = watch(this.repoRoot, { recursive: true }, (_event, filename) => {
      const rel = toRepoRelative(this.repoRoot, filename);
      if (!rel || !isWatchable(rel)) return;
      this.scheduleRefresh();
    });
    const fb = this.opts.fallbackMs ?? 2000;
    this.fallbackTimer = setInterval(() => {
      void this.fallbackScan();
    }, fb);
  }

  /** Schedule a debounced refresh (coalesces rapid save bursts into one re-parse). */
  private scheduleRefresh(): void {
    if (this.debounceTimer || this.stopped) return;
    const ms = this.opts.debounceMs ?? 300;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh('watcher');
    }, ms);
  }

  /** The 2s backstop: catches missed watcher events, untracked files, and canonical drift. */
  private async fallbackScan(): Promise<void> {
    if (this.stopped) return;
    const head = this.readHead();
    if (head !== undefined && this.observedHead !== undefined && head !== this.observedHead) {
      await this.handleTransition(head);
      return;
    }
    if (head !== undefined) this.observedHead = head;
    if (this.overlay.canonicalDrifted()) {
      await this.handleDrift();
      return;
    }
    await this.refresh('fallback');
  }

  /**
   * A clean checkout changes committed source without creating any working-tree diff. Re-seed from
   * the indexed canonical graph, then overlay the full Git delta to the newly observed HEAD. This
   * keeps the committed graph immutable in watch mode while connected readers immediately query the
   * branch they are actually on.
   */
  private async handleTransition(head: string): Promise<void> {
    if (this.refreshing) {
      this.pendingTransitionHead = head;
      return;
    }
    this.overlay.resync();
    const indexedHead = this.canonical.getManifest().repo.vcsHead;
    if (indexedHead !== undefined) {
      try {
        for (const path of changedFilesSince(this.repoRoot, indexedHead)) {
          if (isWatchable(path)) this.overlay.markDirty(path);
        }
      } catch (err) {
        this.opts.onWarn?.(`watch transition scan failed: ${(err as Error).message}`);
        return; // keep observedHead unchanged so the next fallback retries the transition
      }
    }
    await this.refresh('transition');
    this.observedHead = head;
  }

  /** External `crib update` advanced canonical: reload + resync + recompute the dirty set. */
  private async handleDrift(): Promise<void> {
    this.canonical.load();
    this.overlay.resync();
    this.opts.onDrift?.();
    await this.refresh('drift');
  }

  /** Recompute the dirty set from VCS, mark new dirty files, and re-parse if anything changed. */
  private async refresh(reason: RefreshReason): Promise<void> {
    if (this.refreshing || this.stopped) return;
    const dirty = this.collectDirty();
    const newDirty = dirty.filter((p) => !this.overlay.isDirty(p));
    for (const p of newDirty) this.overlay.markDirty(p);
    // Drift can advance canonical out from under a pending debounce — re-check after marking.
    if (reason !== 'drift' && this.overlay.canonicalDrifted()) {
      await this.handleDrift();
      return;
    }
    if (this.overlay.dirty.length === 0) {
      // R04 — a DRIFT with an empty dirty set is still a change the reader must adopt.
      //
      // `handleDrift` has already reloaded canonical and resynced the overlay, so the graph this
      // process serves is new. But when the working tree is clean — an external `crib update` that
      // committed everything, a clean branch switch — there is nothing dirty to re-parse and this
      // early return skipped `onRefresh` entirely. Consumers rebuild their read projections in
      // that callback, so the audited failure followed: the server logged "canonical soul advanced
      // — overlay resynced", reported the NEW head through `status`, and went on answering queries
      // from the projection built against the OLD graph. A newly started reader saw the symbol
      // immediately; the connected one never did.
      //
      // Nothing needs re-parsing, so no refresh is run — the callback carries an empty result whose
      // only job is to say "canonical moved, rebuild what you derived from it".
      if (reason === 'drift' || reason === 'transition')
        this.opts.onRefresh?.(emptyRefreshResult(), reason);
      return;
    }
    this.refreshing = true;
    try {
      const result = await refreshWorkingOverlay(this.overlay, this.canonical, this.repoRoot);
      this.opts.onRefresh?.(result, reason);
    } catch (err) {
      this.opts.onWarn?.(`watch refresh failed: ${(err as Error).message}`);
    } finally {
      this.refreshing = false;
      const pendingHead = this.pendingTransitionHead;
      this.pendingTransitionHead = undefined;
      if (pendingHead !== undefined && !this.stopped) void this.handleTransition(pendingHead);
    }
  }

  /** Uncommitted tracked changes ∪ nonignored untracked files, filtered to source-ish langs and
   *  excluding build-output dirs. The build-dir exclusion mirrors the watcher's `isWatchable` filter so
   *  the fallback scan and the watcher agree: a `.ts` file under `dist/`/`build/` is build output, not
   *  source, and must never enter the overlay even when it isn't gitignored (a fresh repo may not have a
   *  .gitignore yet). Source of truth stays the VCS scan; this just keeps its notion of "source" consistent. */
  private collectDirty(): string[] {
    const tracked = uncommittedChanges(this.repoRoot);
    const untracked = (this.opts.includeUntracked ?? true) ? untrackedFiles(this.repoRoot) : [];
    const all = new Set<string>([...tracked, ...untracked]);
    return [...all].filter((p) => !isExcludedByPrefix(p) && langForPath(p) !== undefined).sort();
  }

  private readHead(): string | undefined {
    try {
      return currentHead(this.repoRoot);
    } catch {
      return undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.pendingTransitionHead = undefined;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}

/**
 * The zero-work refresh result announcing a canonical advance with nothing dirty to re-parse.
 * Every count is genuinely zero: no file was re-extracted. It exists so `onRefresh` can carry the
 * "adopt the new generation" signal in the shape consumers already handle.
 */
function emptyRefreshResult(): OverlayRefreshResult {
  return {
    dirty: [],
    scope: [],
    parse: emptyParseStats(),
    resolve: { imports: 0, calls: 0, inherits: 0, implements: 0, dropped: 0 },
    cluster: { communities: 0, members: 0 },
  };
}

/** Normalize a watcher `filename` to a repo-relative POSIX path, or undefined if outside the repo. */
function toRepoRelative(root: string, filename: string | null): string | undefined {
  if (!filename) return undefined;
  const abs = filename.startsWith('/') ? filename : join(root, filename);
  const rel = relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return undefined;
  return rel.split(sep).join('/');
}

/** True if `rel` is a source-ish file whose churn should schedule a refresh (excludes build/deps/.crib). */
function isWatchable(rel: string): boolean {
  return !isExcludedByPrefix(rel) && langForPath(rel) !== undefined;
}

/** True if `rel` lives under a build-output / deps / soul dir that must never enter the overlay. */
function isExcludedByPrefix(rel: string): boolean {
  for (const prefix of IGNORE_PREFIXES) {
    const dir = prefix.slice(0, -1);
    if (rel === dir || rel.startsWith(prefix)) return true;
  }
  return false;
}
