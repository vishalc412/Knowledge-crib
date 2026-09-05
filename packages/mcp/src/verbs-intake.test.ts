import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { MemoryStore, __resetMemoryLockGuardForTest } from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-mcp-intake';
let repo: string;
let home: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let local: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-mcp-intake-'));
  home = mkdtempSync(join(tmpdir(), 'crib-mcp-intake-home-'));
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
  local = MemoryStore.local(REPO_ID, {
    repoRoot: repo,
    env: { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home },
    now: () => NOW,
  });
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function memoryCaller() {
  const server = buildServer(new Verbs({ soul, index, repoRoot: repo, memory: { local } }));
  const tool = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
        }
      >;
    }
  )._registeredTools.memory;
  if (!tool) throw new Error('memory tool not registered');
  return async (args: Record<string, unknown>) => {
    const result = await tool.handler(args);
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  };
}

describe('MCP intake continuation operations', () => {
  it('creates local intake state and returns it through handoff', async () => {
    const callMemory = memoryCaller();
    const created = await callMemory({
      op: 'intake_create',
      original: 'Add durable continuation',
      outcome: 'Resume on device B',
      acceptanceCriteria: ['Same next action'],
      actor: 'human:vishal',
    });
    expect(created.id).toMatch(/^intake:/);
    await callMemory({
      op: 'intake_checkpoint',
      id: created.id,
      phase: 'planning',
      summary: 'Design accepted',
      nextSafeAction: 'Write tests',
      actor: 'agent:codex',
    });
    const handoff = (await callMemory({ op: 'handoff' })) as {
      intakes: { primary: { intakeId: string; nextSafeAction: string } };
    };
    expect(handoff.intakes.primary).toMatchObject({
      intakeId: created.id,
      nextSafeAction: 'Write tests',
    });
  });

  it('stages device sharing locally and refuses Git-visible team sharing', async () => {
    const callMemory = memoryCaller();
    const created = await callMemory({
      op: 'intake_create',
      original: 'Share this intake',
      outcome: 'Continue elsewhere',
      actor: 'human:vishal',
    });
    await callMemory({
      op: 'intake_checkpoint',
      id: created.id,
      phase: 'executing',
      summary: 'Work started',
      nextSafeAction: 'Run tests',
      actor: 'agent:codex',
    });
    const devices = await callMemory({
      op: 'intake_share',
      id: created.id,
      audience: 'devices',
      actor: 'human:vishal',
    });
    expect(devices).toMatchObject({ ok: true, sync: 'staged-local-only' });

    const team = await callMemory({
      op: 'intake_share',
      id: created.id,
      audience: 'team',
      actor: 'human:vishal',
    });
    expect(team).toMatchObject({ ok: false, status: 'cli-required' });
  });
});
