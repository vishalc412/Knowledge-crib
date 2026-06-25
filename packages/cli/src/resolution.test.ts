import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProject } from './registry.js';
import { resolveProjectRoot, walkUpForCrib } from './runtime.js';

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'crib-res-'));
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** Stamp a minimal `.crib/crib.json` so resolution recognizes the dir as indexed. */
function markIndexed(dir: string): void {
  mkdirSync(join(dir, '.crib'), { recursive: true });
  writeFileSync(join(dir, '.crib', 'crib.json'), '{}');
}

const emptyEnv: NodeJS.ProcessEnv = {};

describe('resolveProjectRoot — priority chain', () => {
  it('uses an explicit root when its .crib is present (no walk)', () => {
    const proj = join(sandbox, 'proj');
    mkdirSync(proj, { recursive: true });
    markIndexed(proj);
    const r = resolveProjectRoot({ explicitRoot: proj, env: emptyEnv, cwd: sandbox });
    expect(r.repoRoot).toBe(proj);
    expect(r.cribDir).toBe(join(proj, '.crib'));
  });

  it('walks up from an explicit subdir to the project root containing .crib', () => {
    const proj = join(sandbox, 'proj');
    const sub = join(proj, 'packages', 'foo');
    mkdirSync(sub, { recursive: true });
    markIndexed(proj);
    const r = resolveProjectRoot({ explicitRoot: sub, env: emptyEnv, cwd: sandbox });
    expect(r.repoRoot).toBe(proj);
  });

  it('honors KCRIB_ROOT env when no explicit root is given', () => {
    const proj = join(sandbox, 'envproj');
    mkdirSync(proj, { recursive: true });
    markIndexed(proj);
    const r = resolveProjectRoot({ env: { KCRIB_ROOT: proj }, cwd: sandbox });
    expect(r.repoRoot).toBe(proj);
  });

  it('honors CLAUDE_PROJECT_DIR env (Claude Code real workspace signal)', () => {
    const proj = join(sandbox, 'claudeproj');
    mkdirSync(proj, { recursive: true });
    markIndexed(proj);
    const r = resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: proj }, cwd: sandbox });
    expect(r.repoRoot).toBe(proj);
  });

  it('prefers explicit root over env signals', () => {
    const explicit = join(sandbox, 'explicit');
    const envproj = join(sandbox, 'env');
    mkdirSync(explicit, { recursive: true });
    mkdirSync(envproj, { recursive: true });
    markIndexed(explicit);
    markIndexed(envproj);
    const r = resolveProjectRoot({
      explicitRoot: explicit,
      env: { KCRIB_ROOT: envproj, CLAUDE_PROJECT_DIR: envproj },
      cwd: sandbox,
    });
    expect(r.repoRoot).toBe(explicit);
  });

  it('walks up from cwd when no explicit root or env is given', () => {
    const proj = join(sandbox, 'cwdproj');
    const sub = join(proj, 'src');
    mkdirSync(sub, { recursive: true });
    markIndexed(proj);
    const r = resolveProjectRoot({ env: emptyEnv, cwd: sub });
    expect(r.repoRoot).toBe(proj);
  });

  it('falls back to cwd/.crib when nothing is indexed anywhere (backward-compat)', () => {
    const r = resolveProjectRoot({ env: emptyEnv, cwd: sandbox });
    expect(r.repoRoot).toBe(sandbox);
    expect(r.cribDir).toBe(join(sandbox, '.crib'));
    expect(existsSync(r.cribDir)).toBe(false); // nothing there → caller hits "not indexed"
  });

  it('`.` positional behaves like cwd (walks up, backward-compat with `crib serve .`)', () => {
    const proj = join(sandbox, 'dotproj');
    mkdirSync(proj, { recursive: true });
    markIndexed(proj);
    // caller passes `.` → resolveRoot treats `.` as "no explicit" → walks from cwd.
    const r = resolveProjectRoot({ explicitRoot: undefined, env: emptyEnv, cwd: proj });
    expect(r.repoRoot).toBe(proj);
  });

  it('registry overlay: a registered custom cribDir wins when it exists on disk', () => {
    const proj = join(sandbox, 'regproj');
    const customCrib = join(sandbox, 'customcrib');
    mkdirSync(proj, { recursive: true });
    mkdirSync(customCrib, { recursive: true });
    markIndexed(proj); // standard .crib exists too
    writeFileSync(join(customCrib, 'crib.json'), '{}'); // custom cribDir also indexed
    const regEnv = { KCRIB_REGISTRY_DIR: sandbox };
    registerProject(proj, { repoId: 'r1', cribDir: customCrib, env: regEnv });
    const r = resolveProjectRoot({ explicitRoot: proj, env: regEnv, cwd: sandbox });
    expect(r.cribDir).toBe(customCrib);
    expect(r.repoRoot).toBe(proj); // repoRoot stays the work-tree root
  });

  it('registry overlay ignored when the registered cribDir no longer exists', () => {
    const proj = join(sandbox, 'staleproj');
    mkdirSync(proj, { recursive: true });
    markIndexed(proj);
    const regEnv = { KCRIB_REGISTRY_DIR: sandbox };
    registerProject(proj, { repoId: 'r1', cribDir: '/nonexistent/.crib', env: regEnv });
    const r = resolveProjectRoot({ explicitRoot: proj, env: regEnv, cwd: sandbox });
    expect(r.cribDir).toBe(join(proj, '.crib')); // falls back to standard
  });
});

describe('walkUpForCrib', () => {
  it('returns undefined when no ancestor has .crib', () => {
    expect(walkUpForCrib(sandbox)).toBeUndefined();
  });

  it('returns the nearest ancestor with .crib', () => {
    const proj = join(sandbox, 'a', 'b');
    mkdirSync(proj, { recursive: true });
    markIndexed(proj);
    expect(walkUpForCrib(join(proj, 'c', 'd'))).toBe(proj);
  });
});
