/**
 * The Stop-hook memory nudge — the write trigger for Claude Code.
 *
 * crib cannot distill a transcript (the capture policy forbids storing one), so an automatic write
 * still needs the agent to call `memory_observe`. The hook's job is to ASK, at the moment work has
 * actually happened, and never to nag:
 *   - never while Claude is already continuing because a stop hook blocked it;
 *   - never for a session that changed nothing (dirt that predates the session does not count);
 *   - at most once per session per HEAD — asked again only after a commit moves HEAD.
 *
 * Everything here is pure except the two small state-file helpers, so the policy is testable
 * without spawning the CLI.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What the working tree looks like right now (paths only — never contents). */
export interface WorkSnapshot {
  head?: string;
  changedPaths: readonly string[];
}

export interface SessionNudgeState {
  startHead?: string;
  /** paths already changed when the session started — pre-existing work is not this session's. */
  startPaths: string[];
  /** HEADs this session was already asked at. */
  nudgedHeads: string[];
  updatedAt: string;
}

export interface NudgeStateFile {
  version: 1;
  sessions: Record<string, SessionNudgeState>;
}

export type NudgeDecision = { nudge: false; why: string } | { nudge: true; reason: string };

/** Sessions remembered at once; the least recently touched fall off first. */
export const MAX_TRACKED_SESSIONS = 64;
const MAX_START_PATHS = 2_000;

export const STOP_NUDGE_REASON =
  'crib memory: this session changed code. Before you stop — if you learned something reusable ' +
  '(a non-obvious fact, a pitfall and its fix, a verified procedure), record it with the ' +
  '`memory_observe` tool: kind, subject, claim, and evidence as source-quote items carrying path, ' +
  'line and the exact quoted text, so crib can verify and admit it. Nothing reusable? Just stop — ' +
  'you will not be asked again until the next commit.';

/** Directories the hooks and crib itself write on every turn — their churn is never "work". */
const SELF_WRITTEN_PREFIXES = ['.crib/', '.claude/'];

/**
 * The paths a session could have touched: tracked changes AND untracked, not-ignored files (a
 * session that only creates new files did work too — `uncommittedChanges` alone misses it), minus
 * crib's and Claude's own state directories. Sorted and de-duplicated.
 */
export function nudgeWorkPaths(tracked: readonly string[], untracked: readonly string[]): string[] {
  return [...new Set([...tracked, ...untracked])]
    .filter((path) => !SELF_WRITTEN_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .sort();
}

export function emptyNudgeState(): NudgeStateFile {
  return { version: 1, sessions: {} };
}

/** Session ids are hashed before they become keys — the state file never stores one verbatim. */
export function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
}

function prune(sessions: Record<string, SessionNudgeState>): Record<string, SessionNudgeState> {
  const entries = Object.entries(sessions);
  if (entries.length <= MAX_TRACKED_SESSIONS) return sessions;
  entries.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt) || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_SESSIONS));
}

/**
 * Record the session's starting tree. A session seen before (a resume fires SessionStart again)
 * keeps its original baseline and the HEADs it was already asked at.
 */
export function recordSessionStart(
  file: NudgeStateFile,
  key: string,
  snap: WorkSnapshot,
  now: string,
): NudgeStateFile {
  if (file.sessions[key]) return file;
  return {
    version: 1,
    sessions: prune({
      ...file.sessions,
      [key]: {
        ...(snap.head ? { startHead: snap.head } : {}),
        startPaths: [...snap.changedPaths].sort().slice(0, MAX_START_PATHS),
        nudgedHeads: [],
        updatedAt: now,
      },
    }),
  };
}

/** Decide whether this Stop should be blocked with {@link STOP_NUDGE_REASON}. */
export function decideStopNudge(
  file: NudgeStateFile,
  key: string,
  snap: WorkSnapshot,
  opts: { stopHookActive: boolean; now: string },
): { decision: NudgeDecision; next: NudgeStateFile } {
  if (opts.stopHookActive) {
    return { decision: { nudge: false, why: 'already continuing from a stop hook' }, next: file };
  }
  const session = file.sessions[key];
  if (!session) {
    // The hooks were installed mid-session (no SessionStart seen): baseline now, ask later.
    return {
      decision: { nudge: false, why: 'first sighting of this session — baseline recorded' },
      next: recordSessionStart(file, key, snap, opts.now),
    };
  }
  const startPaths = new Set(session.startPaths);
  const worked =
    (snap.head !== undefined && snap.head !== session.startHead) ||
    snap.changedPaths.some((path) => !startPaths.has(path));
  if (!worked) {
    return { decision: { nudge: false, why: 'no work since the session started' }, next: file };
  }
  const headKey = snap.head ?? 'no-head';
  if (session.nudgedHeads.includes(headKey)) {
    return { decision: { nudge: false, why: 'already asked at this HEAD' }, next: file };
  }
  return {
    decision: { nudge: true, reason: STOP_NUDGE_REASON },
    next: {
      version: 1,
      sessions: prune({
        ...file.sessions,
        [key]: { ...session, nudgedHeads: [...session.nudgedHeads, headKey], updatedAt: opts.now },
      }),
    },
  };
}

/** Read the state file; a missing or malformed file is an empty state, never an error. */
export function readNudgeState(path: string): NudgeStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NudgeStateFile>;
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
      return emptyNudgeState();
    }
    return { version: 1, sessions: parsed.sessions as Record<string, SessionNudgeState> };
  } catch {
    return emptyNudgeState();
  }
}

/** Atomic write (tmp + rename) so two hooks racing at a turn boundary cannot tear the file. */
export function writeNudgeState(path: string, file: NudgeStateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, 'utf8');
  renameSync(tmp, path);
}
