import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * G5.1 — `crib rename` driven end-to-end against the BUILT `dist/cli.js` over a temp indexed repo
 * (the harness memory-sync.test.ts uses). What this pins:
 *
 *   - default is a DRY RUN: the plan, its deterministic plan id, confidence counts and the
 *     unresolved bucket are printed and NOTHING is written;
 *   - `--apply` without `--plan-id` is a usage error; a WRONG plan id fails closed (nothing written);
 *   - the real apply rewrites the definition and the resolved caller, is word-boundary exact, and
 *     then chains the post-apply reindex (the `crib update`/self-heal path) to a zero exit code.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');

const AUTH = [
  'export function verifyToken(t: string): boolean {',
  '  return t.length > 0;',
  '}',
  '',
].join('\n');
const CALLER = [
  'import { verifyToken } from "./auth.js";',
  'export function main(t: string): boolean {',
  '  return verifyToken(t);',
  '}',
  '',
].join('\n');

let repo: string;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  repo = tempDir('crib-rename-cli-');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'auth.ts'), AUTH, 'utf8');
  writeFileSync(join(repo, 'src', 'caller.ts'), CALLER, 'utf8');
  // Index through the CLI itself: `rename` reads the derived index (openVerbs), so the fixture
  // must be indexed exactly the way a user would — soul AND derived index on disk.
  const res = spawnSync(process.execPath, [CLI, 'index', '.'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`fixture index failed: ${res.stderr ?? res.stdout}`);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** spawnSync (not execFileSync) so stderr on a SUCCESSFUL run stays observable. */
function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

describe('crib rename (G5.1) — plan/apply lifecycle over the built CLI', () => {
  it('dry run prints the plan, the plan id and confidence counts — and writes nothing', () => {
    const r = run(['rename', '--from', 'verifyToken', '--to', 'checkToken', '--json']);
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout) as {
      applied: boolean;
      planId: string;
      counts: { exact: number; inferred: number; files: number; edits: number };
      notes: string[];
    };
    expect(plan.applied).toBe(false);
    expect(plan.planId.startsWith('rename:')).toBe(true);
    // both code sites grounded: definition + import/call references → exact; no text-only hits here
    expect(plan.counts.exact).toBeGreaterThanOrEqual(3);
    expect(plan.counts.files).toBe(2);
    // nothing changed on disk
    expect(readFileSync(join(repo, 'src', 'auth.ts'), 'utf8')).toBe(AUTH);
    expect(readFileSync(join(repo, 'src', 'caller.ts'), 'utf8')).toBe(CALLER);

    // the human (non --json) form surfaces the same facts plus the apply hint
    const h = run(['rename', '--from', 'verifyToken', '--to', 'checkToken']);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('dry run — nothing written');
    expect(h.stdout).toContain(plan.planId);
    expect(h.stdout).toContain('exact');
    expect(h.stdout).toContain('--apply --plan-id');
  });

  it('apply fails closed on a wrong plan id and on missing --plan-id — files untouched', () => {
    const missing = run(['rename', '--from', 'verifyToken', '--to', 'checkToken', '--apply']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('--plan-id');
    const wrong = run([
      'rename',
      '--from',
      'verifyToken',
      '--to',
      'checkToken',
      '--apply',
      '--plan-id',
      'rename:0000000000000000000000000000000000000000000000000000000000000000',
    ]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('PLAN_MISMATCH');
    expect(readFileSync(join(repo, 'src', 'auth.ts'), 'utf8')).toBe(AUTH);
    expect(readFileSync(join(repo, 'src', 'caller.ts'), 'utf8')).toBe(CALLER);
  });

  it('apply rewrites both files atomically and chains the post-apply reindex', () => {
    const dry = run(['rename', '--from', 'verifyToken', '--to', 'checkToken', '--json']);
    const planId = (JSON.parse(dry.stdout) as { planId: string }).planId;
    const r = run([
      'rename',
      '--from',
      'verifyToken',
      '--to',
      'checkToken',
      '--apply',
      '--plan-id',
      planId,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('renamed in 2 file(s)');
    expect(r.stdout).toContain(planId);
    // the post-apply reindex ran (dirty update, or its full-index fallback outside git)
    expect(r.stdout).toContain('reindexing (dirty update)');
    // and the rewrite is real: definition + import + call, boundary-exact
    const auth = readFileSync(join(repo, 'src', 'auth.ts'), 'utf8');
    const caller = readFileSync(join(repo, 'src', 'caller.ts'), 'utf8');
    expect(auth).toContain('export function checkToken(');
    expect(caller).toContain('import { checkToken }');
    expect(caller).toContain('checkToken(t)');
    expect(auth).not.toContain('verifyToken');
    // the graph is current again: a dry run for a NEW rename resolves the renamed symbol
    const again = run(['rename', '--from', 'checkToken', '--to', 'checkToken2', '--json']);
    expect(again.status).toBe(0);
    expect((JSON.parse(again.stdout) as { applied: boolean }).applied).toBe(false);
  });
});
