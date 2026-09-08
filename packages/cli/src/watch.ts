/**
 * WP4/W6 — watch mode's EVENT SOURCE.
 *
 * Keeps the serving process's refresh loop triggered as files change in the working tree, so
 * `crib serve --watch` exposes edits without dirtying the committed `.crib/graph`.
 *
 * Robustness model — the VCS scan is the source of truth, the watcher is a low-latency trigger:
 *   `node:fs.watch` (recursive) fires on save and schedules a debounced refresh; the refresh's scope
 *   comes from VCS, NOT from the per-event filename. So gitignored build churn (`dist/`,
 *   `node_modules/`) is excluded even when the watcher fires for it, and a missed event (atomic
 *   save, watcher overflow) is caught by the fallback scan — convergence within one debounce plus
 *   one fallback scan. No external dependency (no chokidar): the fallback guarantees convergence
 *   even if `fs.watch` drops events entirely.
 *
 * WP4.1 moved ALL refresh work (dirty computation, transition handling, canonical drift,
 * candidate building, publication) into {@link RefreshCoordinator}: this class is now purely the
 * trigger layer, because a candidate-per-refresh design needs no incremental state here. The
 * coordinator's capture guard makes a triggered refresh a no-op when nothing actually changed, so
 * the fallback scan fires it unconditionally every tick. The old state machine (observedHead,
 * pendingTransitionHead, pendingDrift latches) died with the in-place overlay mutation it
 * protected — a torn window that no longer exists when each refresh builds an invisible candidate
 * and publishes it atomically.
 *
 * Watch mode NEVER promotes memory or runs an evaluation/enrichment provider (PRD line 373).
 */
import { type FSWatcher, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { langForPath } from '@knowledge-crib/pipeline';

/** Why a refresh was requested. The coordinator treats every reason uniformly except `initial`. */
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

/** True if `rel` is a source-ish file whose churn should schedule a refresh (excludes build/deps/.crib). */
export function isWatchable(rel: string): boolean {
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

/** Normalize a watcher `filename` to a repo-relative POSIX path, or undefined if outside the repo. */
function toRepoRelative(root: string, filename: string | null): string | undefined {
  if (!filename) return undefined;
  const abs = filename.startsWith('/') ? filename : join(root, filename);
  const rel = relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return undefined;
  return rel.split(sep).join('/');
}

export interface WatchOpts {
  /**
   * Debounce window for coalescing rapid save bursts; default 300ms. G3.4 red line #2 pins watch
   * mode at a 300ms debounce (serialized updates, atomic generation publication, 5s queryable-update
   * p95 target) — the pre-G3.4 default was 500ms; the default moved, existing explicit values win.
   */
  debounceMs?: number;
  /** VCS fallback scan interval — the convergence backstop; default 2000ms (PRD line 370). */
  fallbackMs?: number;
  /** Invoked for non-fatal warnings (watcher setup failures). */
  onWarn?: (message: string) => void;
}

export class WatchMode {
  private watcher?: FSWatcher;
  private fallbackTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private stopped = false;

  /**
   * @param coordinator the serialized refresh loop (WP4.1). Structural, so tests pass a spy without
   *   constructing a real coordinator.
   */
  constructor(
    private readonly coordinator: { requestRefresh(reason: RefreshReason): void },
    private readonly repoRoot: string,
    private readonly opts: WatchOpts = {},
  ) {}

  /** Start the watcher + fallback scan. The FIRST bundle is built by the coordinator's
   *  `initialize()` BEFORE the watcher exists, so `start()` performs no refresh itself — an event
   *  arriving during startup coalesces into the coordinator's pending slot like any other. */
  async start(): Promise<void> {
    try {
      this.watcher = watch(this.repoRoot, { recursive: true }, (_event, filename) => {
        const rel = toRepoRelative(this.repoRoot, filename);
        if (!rel || !isWatchable(rel)) return;
        this.scheduleRefresh();
      });
    } catch (err) {
      // A platform without recursive fs.watch (some network filesystems, containers) must not lose
      // freshness: the fallback scan keeps converging on its own.
      this.opts.onWarn?.(
        `file watcher unavailable (${(err as Error).message}) — fallback scan only`,
      );
    }
    const fb = this.opts.fallbackMs ?? 2000;
    this.fallbackTimer = setInterval(() => {
      if (!this.stopped) this.coordinator.requestRefresh('fallback');
    }, fb);
  }

  /** Schedule a debounced refresh (coalesces rapid save bursts into one request). */
  private scheduleRefresh(): void {
    if (this.debounceTimer || this.stopped) return;
    const ms = this.opts.debounceMs ?? 300;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.coordinator.requestRefresh('watcher');
    }, ms);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
