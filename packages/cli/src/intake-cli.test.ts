import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { MemoryStore } from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareImplementedPlan } from './implemented-plan.js';

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
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.', repoId: REPO_ID }) });
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

function run(args: string[], principalId = 'principal:test') {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      KCRIB_MEMORY_DIR: memoryHome,
      KCRIB_REGISTRY_DIR: memoryHome,
      KCRIB_PRINCIPAL_ID: principalId,
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
  it('archives an implemented plan and retrieves it from the separate memory lane', () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'plan.md'), '# Add feature\n\nUpdate index value.\n');
    git('add', '.');
    git('commit', '-qm', 'plan');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'implement plan');
    const intakeId = (JSON.parse(create('Add feature').stdout) as { id: string }).id;
    const missingReceipt = run([
      'intake',
      'implement',
      intakeId,
      '--plan',
      'docs/plan.md',
      '--base',
      base,
      '--category',
      'enhancement',
      '--summary',
      'Index value updated',
      '--receipt',
      `rcpt:${'a'.repeat(64)}`,
      '--json',
    ]);
    expect(missingReceipt.status).toBe(2);
    expect(missingReceipt.stderr).toMatch(/receipt is unavailable/i);
    const implemented = run([
      'intake',
      'implement',
      intakeId,
      '--plan',
      'docs/plan.md',
      '--base',
      base,
      '--category',
      'enhancement',
      '--summary',
      'Index value updated',
      '--json',
    ]);
    expect(implemented.status, implemented.stderr).toBe(0);
    const result = JSON.parse(implemented.stdout) as {
      id: string;
      archivePath: string;
      graphUpdated: boolean;
    };
    expect(result.id).toMatch(/^impl:/);
    expect(result.graphUpdated).toBe(true);
    const archive = readFileSync(join(memoryHome, 'repos', REPO_ID, result.archivePath), 'utf8');
    expect(archive).toContain('# Add feature');
    expect(archive).toContain('diff --git a/src/index.ts b/src/index.ts');
    const listed = run(['memory', 'implementations', 'list', '--json']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { record: { id: result.id }, integrity: 'valid', graph: 'private' },
    ]);
    const fetched = run(['memory', 'implementations', 'get', result.id, '--json']);
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toMatchObject({
      record: { id: result.id, category: 'enhancement' },
      integrity: 'valid',
    });
    const searched = run(['memory', 'implementations', 'search', 'Index value', '--json']);
    expect(searched.status, searched.stderr).toBe(0);
    expect(JSON.parse(searched.stdout)).toMatchObject([
      { record: { id: result.id }, integrity: 'valid' },
    ]);
    expect(
      JSON.parse(run(['memory', 'implementations', 'list', '--json'], 'principal:other').stdout),
    ).toEqual([]);
    const repeated = run([
      'intake',
      'implement',
      intakeId,
      '--plan',
      'docs/plan.md',
      '--base',
      base,
      '--category',
      'enhancement',
      '--summary',
      'Index value updated',
      '--json',
    ]);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({ id: result.id, alreadyCompleted: true });
  });

  it.each([false, true])(
    'requires explicit intake sharing before publishing a team plan archive (interrupted=%s)',
    (interrupted) => {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'plan.md'), '# Add shared feature\n');
      git('add', '.');
      git('commit', '-qm', 'plan');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 3;\n');
      git('add', '.');
      git('commit', '-qm', 'feature');
      const intakeId = (JSON.parse(create('Shared feature').stdout) as { id: string }).id;
      const command = [
        'intake',
        'implement',
        intakeId,
        '--plan',
        'docs/plan.md',
        '--base',
        base,
        '--category',
        'addon',
        '--summary',
        'Shared feature done',
        '--team',
        '--json',
      ];
      const refused = run(command);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toMatch(/shared with the team/i);
      const shared = run([
        'intake',
        'share',
        intakeId,
        '--audience',
        'team',
        '--next',
        'Archive the implementation',
        '--json',
      ]);
      expect(shared.status, shared.stderr).toBe(0);
      git('add', '.');
      git('commit', '-qm', 'share intake');
      if (interrupted) {
        // Simulate an interruption after the archive and records are durable but before graph
        // refresh and the completion checkpoint. The retry must resume from this exact state.
        const prepared = prepareImplementedPlan({
          repoRoot: repo,
          intakeId,
          principalId: 'principal:test',
          projectId: REPO_ID,
          planPath: 'docs/plan.md',
          base,
          category: 'addon',
          summary: 'Shared feature done',
          audience: 'team',
          receiptIds: [],
          actor: 'human:principal:test',
        });
        const archivePath = join(repo, prepared.record.archivePath);
        mkdirSync(join(repo, 'docs', 'implemented-plans'), { recursive: true });
        writeFileSync(archivePath, prepared.markdown);
        const env = {
          ...process.env,
          KCRIB_MEMORY_DIR: memoryHome,
          KCRIB_REGISTRY_DIR: memoryHome,
        };
        MemoryStore.local(REPO_ID, { env }).upsertEntry('implementations', prepared.record);
        MemoryStore.team(join(repo, '.crib'), { env }).upsertEntry(
          'implementations',
          prepared.record,
        );
        writeFileSync(join(repo, 'src', 'unrelated.ts'), 'export const unrelated = true;\n');
        expect(run(command).stderr).toMatch(/clean committed worktree/i);
        rmSync(join(repo, 'src', 'unrelated.ts'));
      }
      expect(JSON.parse(run(['memory', 'implementations', 'list', '--json']).stdout)).toEqual([]);
      const done = run(command);
      expect(done.status, done.stderr).toBe(0);
      const record = JSON.parse(done.stdout) as { id: string; archivePath: string };
      expect(readFileSync(join(repo, record.archivePath), 'utf8')).toContain(
        '# Add shared feature',
      );
      const query = run(['query', 'Shared feature done', '--json']);
      expect(query.status, query.stderr).toBe(0);
      expect(query.stdout).toContain('implemented-plans');
      const foreign = run(['memory', 'implementations', 'list', '--json'], 'principal:other');
      expect(foreign.status, foreign.stderr).toBe(0);
      expect(JSON.parse(foreign.stdout)).toMatchObject([
        { record: { id: record.id, audience: 'team' }, integrity: 'valid', graph: 'indexed' },
      ]);
    },
  );

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
