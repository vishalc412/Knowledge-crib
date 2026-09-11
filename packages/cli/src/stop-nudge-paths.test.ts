/**
 * What counts as "work" for the Stop nudge. Found by a real hook smoke run: a session that only
 * CREATED a file was never asked to record anything, because tracked-change detection ignores
 * untracked files. And the hooks themselves write under `.crib/` every turn — that must never look
 * like the agent did something.
 */
import { describe, expect, it } from 'vitest';
import {
  decideStopNudge,
  emptyNudgeState,
  nudgeWorkPaths,
  recordSessionStart,
} from './stop-nudge.js';

const NOW = '2026-09-11T00:00:00.000Z';

describe('nudgeWorkPaths', () => {
  it('counts a brand-new untracked file as work', () => {
    expect(nudgeWorkPaths([], ['src/new.ts'])).toEqual(['src/new.ts']);
  });

  it('merges tracked and untracked paths, de-duplicated and sorted', () => {
    expect(nudgeWorkPaths(['src/b.ts', 'src/a.ts'], ['src/a.ts', 'src/c.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it("ignores crib's and Claude's own state directories", () => {
    expect(
      nudgeWorkPaths(['.crib/nodes/aa.jsonl'], ['.claude/settings.json', '.crib/intelligence/x']),
    ).toEqual([]);
  });

  it('end to end: creating a file after session start triggers exactly one nudge', () => {
    const started = recordSessionStart(
      emptyNudgeState(),
      'k',
      { head: 'h1', changedPaths: nudgeWorkPaths([], ['.crib/index/db']) },
      NOW,
    );
    const quiet = decideStopNudge(
      started,
      'k',
      { head: 'h1', changedPaths: nudgeWorkPaths([], ['.crib/index/db', '.crib/intelligence/e']) },
      { stopHookActive: false, now: NOW },
    );
    expect(quiet.decision.nudge).toBe(false);
    const created = decideStopNudge(
      quiet.next,
      'k',
      { head: 'h1', changedPaths: nudgeWorkPaths([], ['.crib/index/db', 'src/new.ts']) },
      { stopHookActive: false, now: NOW },
    );
    expect(created.decision.nudge).toBe(true);
  });
});
