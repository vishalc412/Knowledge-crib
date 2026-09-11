/**
 * Closing work over MCP. Reported from real use: "Work to resume" in the memory home only ever grew,
 * because an agent could create and checkpoint an intake over MCP but never finish or cancel one —
 * only the CLI could. `intake_checkpoint` with phase `done` / `cancelled` now writes the same
 * terminal checkpoint `crib intake complete|cancel` writes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { MemoryStore, __resetMemoryLockGuardForTest } from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';

const NOW = '2026-09-11T00:00:00.000Z';
const REPO_ID = 'r-intake-close';

let repo: string;
let home: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-intake-close-'));
  home = mkdtempSync(join(tmpdir(), 'crib-intake-close-home-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.commit(NOW);
  writeFileSync(
    join(repo, '.crib', 'crib.json'),
    JSON.stringify({ repo: { id: REPO_ID, root: '.' } }),
  );
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  __resetMemoryLockGuardForTest();
  const local = MemoryStore.local(REPO_ID, {
    repoRoot: repo,
    env: { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home },
  });
  verbs = new Verbs({ soul, index, repoRoot: repo, memory: { local } });
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function openWork(outcome: string): string {
  const created = verbs.memoryIntakeCreate({
    original: `Please ${outcome}`,
    outcome,
    actor: 'claude-code',
  });
  const id = String(created.id);
  verbs.memoryIntakeCheckpoint({
    id,
    phase: 'executing',
    summary: 'started',
    nextSafeAction: 'keep going',
    actor: 'claude-code',
  });
  return id;
}

function resumable(): number {
  const handoff = verbs.memoryHandoff({}) as { intakes: { resumableCount: number } };
  return handoff.intakes.resumableCount;
}

describe('intake_checkpoint closes work', () => {
  it('phase done completes the intake — it stops counting as work to resume', () => {
    const id = openWork('fix the rubric form');
    expect(resumable()).toBe(1);
    const cp = verbs.memoryIntakeCheckpoint({
      id,
      phase: 'done',
      summary: 'Shipped and verified',
      nextSafeAction: '',
      actor: 'claude-code',
    });
    expect(cp).toMatchObject({ kind: 'completed', phase: 'complete' });
    expect(resumable()).toBe(0);
  });

  it('phase cancelled cancels the intake', () => {
    const id = openWork('try the awards screen');
    const cp = verbs.memoryIntakeCheckpoint({
      id,
      phase: 'cancelled',
      summary: 'No longer needed',
      nextSafeAction: '',
      actor: 'claude-code',
    });
    expect(cp).toMatchObject({ kind: 'cancelled' });
    expect(resumable()).toBe(0);
  });

  it('closing one piece of work leaves the others resumable', () => {
    const done = openWork('first task');
    openWork('second task');
    expect(resumable()).toBe(2);
    verbs.memoryIntakeCheckpoint({
      id: done,
      phase: 'done',
      summary: 'done',
      nextSafeAction: '',
      actor: 'claude-code',
    });
    expect(resumable()).toBe(1);
  });
});
