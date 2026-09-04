import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const REPO_ID = 'r-intake-cli';
let repo: string;
let memoryHome: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-intake-cli-'));
  memoryHome = mkdtempSync(join(tmpdir(), 'crib-intake-home-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  const cribDir = join(repo, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  soul.commit('2026-01-01T00:00:00.000Z');
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(memoryHome, { recursive: true, force: true });
});

function run(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      KCRIB_MEMORY_DIR: memoryHome,
      KCRIB_REGISTRY_DIR: memoryHome,
      KCRIB_PRINCIPAL_ID: 'principal:test',
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function create(label = 'Ship continuation') {
  return run([
    'intake',
    'create',
    '--from',
    `Continue ${label}`,
    '--outcome',
    label,
    '--accept',
    'A new session sees the same next action',
    '--json',
  ]);
}

describe('crib intake and session bootstrap', () => {
  it('creates and checkpoints an intake, then returns it from session bootstrap', () => {
    const created = create();
    expect(created.status).toBe(0);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    const checkpointed = run([
      'intake',
      'checkpoint',
      id,
      '--phase',
      'executing',
      '--next',
      'Run memory tests',
      '--summary',
      'Domain model implemented',
      '--completed-step',
      'domain',
      '--json',
    ]);
    expect(checkpointed.status).toBe(0);

    const bootstrap = run(['session', 'bootstrap', '--json']);
    expect(bootstrap.status).toBe(0);
    expect(
      (JSON.parse(bootstrap.stdout) as { intakes: { primary: { intakeId: string } } }).intakes
        .primary.intakeId,
    ).toBe(id);
  });

  it('returns BAD_ARGS for empty intake text and missing active next action', () => {
    expect(run(['intake', 'create', '--from', '', '--outcome', 'Ship', '--json']).status).toBe(2);
    const id = (JSON.parse(create('Validate arguments').stdout) as { id: string }).id;
    expect(
      run(['intake', 'checkpoint', id, '--phase', 'executing', '--summary', 'Started', '--json'])
        .status,
    ).toBe(2);
  });

  it('allows terminal completion without a next action', () => {
    const id = (JSON.parse(create('Complete safely').stdout) as { id: string }).id;
    const completed = run(['intake', 'complete', id, '--summary', 'All checks passed', '--json']);
    expect(completed.status).toBe(0);
    expect((JSON.parse(completed.stdout) as { kind: string }).kind).toBe('completed');
  });

  it('returns choices without a primary when multiple intakes are active', () => {
    for (const label of ['First task', 'Second task']) {
      const id = (JSON.parse(create(label).stdout) as { id: string }).id;
      expect(
        run([
          'intake',
          'checkpoint',
          id,
          '--phase',
          'planning',
          '--next',
          `Plan ${label}`,
          '--summary',
          'Captured',
          '--json',
        ]).status,
      ).toBe(0);
    }
    const listed = JSON.parse(run(['intake', 'list', '--json']).stdout) as {
      primary?: unknown;
      choices: unknown[];
    };
    expect(listed.primary).toBeUndefined();
    expect(listed.choices).toHaveLength(2);
  });

  it('shares intake history to the Git-visible team store only when explicitly requested', () => {
    const id = (JSON.parse(create('Share with team').stdout) as { id: string }).id;
    expect(
      run([
        'intake',
        'checkpoint',
        id,
        '--phase',
        'executing',
        '--next',
        'Run tests',
        '--summary',
        'Started',
        '--json',
      ]).status,
    ).toBe(0);
    const shared = run(['intake', 'share', id, '--audience', 'team', '--json']);
    expect(shared.status).toBe(0);
    expect(JSON.parse(shared.stdout)).toMatchObject({ teamWritten: true });
  });
});
