import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const KEY_HEX = 'a1'.repeat(32);
const SYNC_ID = 'shared-intake-project';
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(repoId: string): Promise<string> {
  const repo = tempDir('crib-intake-e2e-repo-');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  const cribDir = join(repo, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  soul.commit('2026-01-01T00:00:00.000Z');
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: repoId, root: '.' } }, null, 2)}\n`,
  );
  return repo;
}

function runJson(repo: string, home: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd: repo,
    env: {
      ...process.env,
      KCRIB_MEMORY_DIR: home,
      KCRIB_REGISTRY_DIR: home,
      KCRIB_PRINCIPAL_ID: 'principal:e2e',
      KCRIB_SYNC_KEY: KEY_HEX,
    },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`crib ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cross-device intake continuation', () => {
  it('resumes the same intake and next action in a second checkout', async () => {
    const repoA = await makeRepo('repo-device-a');
    const repoB = await makeRepo('repo-device-b');
    const homeA = tempDir('crib-intake-e2e-home-a-');
    const homeB = tempDir('crib-intake-e2e-home-b-');
    const remote = tempDir('crib-intake-e2e-remote-');
    const initArgs = [
      'memory',
      'init-sync',
      '--scope',
      'repo',
      '--backend',
      'file',
      '--url',
      remote,
      '--sync-id',
      SYNC_ID,
    ];
    runJson(repoA, homeA, initArgs);
    runJson(repoB, homeB, initArgs);

    const created = runJson(repoA, homeA, [
      'intake',
      'create',
      '--from',
      'Continue the MCP integration',
      '--outcome',
      'Complete cross-client context continuation',
      '--accept',
      'Device B resumes the same next action',
    ]);
    const intakeId = created.id as string;
    runJson(repoA, homeA, [
      'intake',
      'checkpoint',
      intakeId,
      '--phase',
      'executing',
      '--next',
      'Run the MCP integration tests',
      '--summary',
      'Encrypted continuation is implemented',
    ]);
    runJson(repoA, homeA, ['memory', 'sync', 'push']);
    runJson(repoB, homeB, ['memory', 'sync', 'pull']);

    const resumed = runJson(repoB, homeB, ['session', 'bootstrap']);
    expect((resumed.intakes as { primary?: Record<string, unknown> }).primary).toMatchObject({
      intakeId,
      nextSafeAction: 'Run the MCP integration tests',
    });
  });
});
