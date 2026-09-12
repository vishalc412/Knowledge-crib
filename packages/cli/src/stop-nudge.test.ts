/**
 * The Stop-hook memory nudge (stop-nudge.ts): ask the agent to record what it learned exactly when
 * work happened — and never nag. Each rule the module documents is pinned here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TRACKED_SESSIONS,
  type NudgeStateFile,
  STOP_NUDGE_REASON,
  decideStopNudge,
  emptyNudgeState,
  readNudgeState,
  recordSessionStart,
  sessionKey,
  writeNudgeState,
} from './stop-nudge.js';

const NOW = '2026-09-11T00:00:00.000Z';
const KEY = sessionKey('session-1');

function started(paths: string[] = [], head = 'h1'): NudgeStateFile {
  return recordSessionStart(emptyNudgeState(), KEY, { head, changedPaths: paths }, NOW);
}

function stop(file: NudgeStateFile, changedPaths: string[], head = 'h1', stopHookActive = false) {
  return decideStopNudge(file, KEY, { head, changedPaths }, { stopHookActive, now: NOW });
}

describe('decideStopNudge', () => {
  it('does not nudge a session that changed nothing', () => {
    expect(stop(started(), []).decision.nudge).toBe(false);
  });

  it('does not count dirt that predates the session as work', () => {
    expect(stop(started(['.agents/notes.md']), ['.agents/notes.md']).decision.nudge).toBe(false);
  });

  it('nudges once the session changes a file, naming memory_observe', () => {
    const { decision } = stop(started(), ['src/a.ts']);
    expect(decision).toEqual({ nudge: true, reason: STOP_NUDGE_REASON });
    expect(STOP_NUDGE_REASON).toMatch(/memory_observe/);
  });

  it('asks only once per HEAD', () => {
    const first = stop(started(), ['src/a.ts']);
    const second = stop(first.next, ['src/a.ts', 'src/b.ts']);
    expect(second.decision.nudge).toBe(false);
  });

  it('asks again after a commit moves HEAD', () => {
    const first = stop(started(), ['src/a.ts']);
    const afterCommit = stop(first.next, [], 'h2');
    expect(afterCommit.decision.nudge).toBe(true);
  });

  it('never nudges while Claude is already continuing from a stop hook', () => {
    expect(stop(started(), ['src/a.ts'], 'h1', true).decision.nudge).toBe(false);
  });

  it('baselines an unseen session instead of nudging (hooks installed mid-session)', () => {
    const { decision, next } = stop(emptyNudgeState(), ['src/a.ts']);
    expect(decision.nudge).toBe(false);
    expect(next.sessions[KEY]?.startPaths).toEqual(['src/a.ts']);
  });

  it('keeps the original baseline when SessionStart fires again on resume', () => {
    const first = stop(started(), ['src/a.ts']);
    const resumed = recordSessionStart(
      first.next,
      KEY,
      { head: 'h1', changedPaths: ['src/a.ts'] },
      NOW,
    );
    expect(resumed.sessions[KEY]?.nudgedHeads).toEqual(['h1']);
    expect(resumed.sessions[KEY]?.startPaths).toEqual([]);
  });

  it('bounds how many sessions it remembers', () => {
    let file = emptyNudgeState();
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i++) {
      file = recordSessionStart(
        file,
        sessionKey(`s-${i}`),
        { head: 'h', changedPaths: [] },
        `2026-09-11T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
      );
    }
    expect(Object.keys(file.sessions)).toHaveLength(MAX_TRACKED_SESSIONS);
  });

  it('never stores a session id verbatim', () => {
    expect(Object.keys(started().sessions)).not.toContain('session-1');
  });
});

describe('nudge state file', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crib-nudge-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips', () => {
    const path = join(dir, 'nested', 'stop-nudge.json');
    writeNudgeState(path, started(['x']));
    expect(readNudgeState(path)).toEqual(started(['x']));
  });

  it('treats a missing or corrupt file as empty state', () => {
    expect(readNudgeState(join(dir, 'absent.json'))).toEqual(emptyNudgeState());
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    expect(readNudgeState(corrupt)).toEqual(emptyNudgeState());
  });
});
