import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { Verbs } from '@knowledge-crib/mcp';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProject } from './registry.js';
import {
  buildIndex,
  isIndexed,
  openIndexForServe,
  openIndexOnly,
  openSoul,
  resolveProjectRoot,
  sweepStaleBuilds,
} from './runtime.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-cli-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    'export class AuthService {\n  login(): void {}\n}\n',
  );
  writeFileSync(join(repo, 'docs', 'auth.md'), '# Auth\n\nThe `AuthService.login` entry point.\n');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('CLI runtime — index → open → query', () => {
  it('isIndexed is false before, true after indexing', async () => {
    expect(isIndexed(repo)).toBe(false);
    const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
    soul.load();
    await indexRepo(soul, repo);
    expect(isIndexed(repo)).toBe(true);
  });

  it('rebuilds the index from the committed soul and answers verbs', async () => {
    const seed = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
    seed.load();
    await indexRepo(seed, repo);

    const rt = openSoul(resolveProjectRoot({ explicitRoot: repo }));
    const index = buildIndex(rt);
    const verbs = new Verbs({ soul: rt.soul, index, repoRoot: repo });

    const status = verbs.status() as { indexed: boolean };
    expect(status.indexed).toBe(true);

    const hits = (verbs.query({ q: 'login' }) as { hits: Array<{ id: string }> }).hits;
    expect(hits.length).toBeGreaterThan(0);

    // describes link from the doc to AuthService.login survives the rebuild
    const login = [...rt.soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'AuthService.login',
    );
    const docs = (verbs.describes({ id: login?.id ?? '' }) as { docs: unknown[] }).docs;
    expect(docs.length).toBeGreaterThanOrEqual(1);
    index.close();
  });

  it('refuses to open a stale derived index for read commands', async () => {
    const seed = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
    seed.load();
    await indexRepo(seed, repo);

    const rt = openSoul(resolveProjectRoot({ explicitRoot: repo }));
    const index = buildIndex(rt);
    index.close();

    const manifestPath = join(repo, '.crib', 'graph', 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(rt.soul.getManifest())}\n`);
    const future = new Date(Date.now() + 5000);
    utimesSync(manifestPath, future, future);

    expect(() => openIndexOnly(rt)).toThrow(/derived index missing or stale/);
  });

  it('openIndexForServe serves a stale-but-present index with a warning instead of throwing', async () => {
    const seed = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
    seed.load();
    await indexRepo(seed, repo);

    const rt = openSoul(resolveProjectRoot({ explicitRoot: repo }));
    const index = buildIndex(rt);
    index.close();

    // Advance the canonical manifest mtime past the derived sqlite → trips the staleness guard.
    const manifestPath = join(repo, '.crib', 'graph', 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(rt.soul.getManifest())}\n`);
    const future = new Date(Date.now() + 5000);
    utimesSync(manifestPath, future, future);

    // A read command would throw here; serve must NOT — it keeps the transport alive. Capture the
    // warning BEFORE mockRestore — vitest's mockRestore() clears mock.calls, so reading it after the
    // finally would always see an empty call list.
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let opened: ReturnType<typeof openIndexForServe> | undefined;
    let warned = false;
    try {
      opened = openIndexForServe(rt);
      expect(opened).toBeDefined();
      warned = spy.mock.calls.some((c) => /derived index stale/.test(String(c[0])));
      expect(warned).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const verbs = new Verbs({ soul: rt.soul, index: opened, repoRoot: repo });
    expect((verbs.status() as { indexed: boolean }).indexed).toBe(true);
    opened.close();
  });

  it('openIndexForServe throws on a missing derived index so serve can self-heal', async () => {
    const seed = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
    seed.load();
    await indexRepo(seed, repo);

    const rt = openSoul(resolveProjectRoot({ explicitRoot: repo }));
    const index = buildIndex(rt);
    index.close();

    rmSync(join(repo, '.crib', 'index', 'crib.sqlite'), { force: true });
    rmSync(join(repo, '.crib', 'index', 'crib.sqlite-wal'), { force: true });
    rmSync(join(repo, '.crib', 'index', 'crib.sqlite-shm'), { force: true });

    expect(() => openIndexForServe(rt)).toThrow(/derived index missing/);
  });
});

describe('CLI runtime — archive resolution', () => {
  let regDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    regDir = mkdtempSync(join(tmpdir(), 'crib-reg-'));
    env = { KCRIB_REGISTRY_DIR: regDir };
  });
  afterEach(() => rmSync(regDir, { recursive: true, force: true }));

  it('resolves an archive project key to its persistent source root (registry is the authority)', () => {
    // The archive file itself need NOT exist on disk for read-only resolution — the registered cache
    // tree + .crib are what matter. resolveProjectRoot must trust the registry here (no stat,
    // no existsSync guard), so a `crib status /path/to/app.zip` run resolves without re-extracting.
    registerProject('/work/app.zip', {
      repoId: 'r1',
      cribDir: '/cache/crib',
      sourceRoot: '/cache/source',
      sourceArchive: '/work/app.zip',
      sourceFingerprint: 'sha256:abc',
      env,
    });
    expect(resolveProjectRoot({ explicitRoot: '/work/app.zip', env })).toEqual({
      projectKey: '/work/app.zip',
      repoRoot: '/cache/source',
      cribDir: '/cache/crib',
      sourceArchive: '/work/app.zip',
      sourceFingerprint: 'sha256:abc',
    });
  });

  it('resolves a fresh (unregistered) archive FILE input without walking up', () => {
    // A real .zip on disk but no registry entry: it is a first-index candidate. projectKey is the
    // file path; repoRoot stays the file path (cmdIndex overrides it via prepareSourceInput).
    const zip = join(repo, 'app.zip');
    writeFileSync(zip, 'PK\x03\x04');
    const resolved = resolveProjectRoot({ explicitRoot: zip, env });
    expect(resolved.projectKey).toBe(zip);
    expect(resolved.repoRoot).toBe(zip);
    expect(resolved.sourceArchive).toBeUndefined();
    expect(resolved.cribDir).toBe(join(zip, '.crib'));
  });
});

describe('resolveProjectRoot — wrong-project guard', () => {
  // The measured failure: `crib serve` against a repo whose `.crib/crib.json` was missing fell
  // through to an ANCESTOR's `.crib` (~/Documents/.crib) and silently served that soul — a swarm
  // gate ran against the wrong project and scored 0/400 while looking healthy.
  function markIndexed(dir: string): void {
    mkdirSync(join(dir, '.crib'), { recursive: true });
    writeFileSync(join(dir, '.crib', 'crib.json'), '{}');
  }

  function captureStderr(fn: () => void): string {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fn();
      return spy.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      spy.mockRestore();
    }
  }

  it('an explicit root with a damaged .crib (dir present, manifest gone) refuses to fall through', () => {
    const ancestor = join(repo, 'ancestor');
    const target = join(ancestor, 'proj');
    mkdirSync(target, { recursive: true });
    markIndexed(ancestor);
    mkdirSync(join(target, '.crib')); // .crib exists but crib.json is gone — damaged index

    let resolved!: ReturnType<typeof resolveProjectRoot>;
    const err = captureStderr(() => {
      resolved = resolveProjectRoot({ explicitRoot: target, env: {}, cwd: repo });
    });

    expect(resolved.repoRoot).toBe(target); // NOT the ancestor: the wrong-project fallback is refused
    expect(existsSync(join(resolved.cribDir, 'crib.json'))).toBe(false); // → caller's not-indexed error
    expect(err).toMatch(/damaged/);
    expect(err).toContain(`crib index ${target}`); // remediation command included
  });

  it('a CWD with a damaged .crib refuses to fall through even on the discovery path', () => {
    // Same wrong-project hazard when `crib serve` runs with no args: walk-up from CWD must not
    // serve an ancestor past a damaged local index.
    const ancestor = join(repo, 'ancestor');
    const target = join(ancestor, 'proj');
    mkdirSync(target, { recursive: true });
    markIndexed(ancestor);
    mkdirSync(join(target, '.crib'));

    let resolved!: ReturnType<typeof resolveProjectRoot>;
    const err = captureStderr(() => {
      resolved = resolveProjectRoot({ env: {}, cwd: target });
    });

    expect(resolved.repoRoot).toBe(target);
    expect(err).toMatch(/damaged/);
    expect(err).toContain(`crib index ${target}`);
  });

  it('an explicit subdir with no .crib still walks up (monorepo) but loudly names the ancestor', () => {
    const ancestor = join(repo, 'ancestor');
    const sub = join(ancestor, 'packages', 'foo');
    mkdirSync(sub, { recursive: true });
    markIndexed(ancestor);

    let resolved!: ReturnType<typeof resolveProjectRoot>;
    const err = captureStderr(() => {
      resolved = resolveProjectRoot({ explicitRoot: sub, env: {}, cwd: repo });
    });

    expect(resolved.repoRoot).toBe(ancestor); // leniency kept (pinned by resolution.test.ts)
    expect(err).toContain(`serving the ancestor project at ${ancestor}`);
    expect(err).toContain(`crib index ${sub}`); // and says how to index the dir actually pointed at
  });

  it('an env-signaled root (KCRIB_ROOT, user-scoped IDE entry) loudly names the ancestor too', () => {
    const ancestor = join(repo, 'ancestor');
    const sub = join(ancestor, 'proj');
    mkdirSync(sub, { recursive: true });
    markIndexed(ancestor);

    let resolved!: ReturnType<typeof resolveProjectRoot>;
    const err = captureStderr(() => {
      resolved = resolveProjectRoot({ env: { KCRIB_ROOT: sub }, cwd: repo });
    });

    expect(resolved.repoRoot).toBe(ancestor);
    expect(err).toMatch(/serving the ancestor project at/);
  });

  it('the pure CWD walk-up (healthy monorepo subdir) resolves to the ancestor silently', () => {
    const ancestor = join(repo, 'ancestor');
    const sub = join(ancestor, 'src');
    mkdirSync(sub, { recursive: true });
    markIndexed(ancestor);

    let resolved!: ReturnType<typeof resolveProjectRoot>;
    const err = captureStderr(() => {
      resolved = resolveProjectRoot({ env: {}, cwd: sub });
    });

    expect(resolved.repoRoot).toBe(ancestor);
    expect(err).not.toMatch(/not indexed|ancestor project/); // normal case — no scare warnings
  });
});

describe('buildIndex — interruption-cleanup window', () => {
  it('is fully synchronous, so signal handlers suffice and no uncaughtException handler is registered', async () => {
    // The SIGINT/SIGTERM handlers + `finally` removal only cover the whole build if the event loop
    // never yields between tmp creation and rename. Guard the premise: if the sqlite path ever
    // gains an `await`, buildIndex returns a Promise and this test fails — at that point an
    // uncaughtException/unhandledRejection handler becomes mandatory (see comment in buildIndex).
    const seed = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
    seed.load();
    await indexRepo(seed, repo);
    const rt = openSoul(resolveProjectRoot({ explicitRoot: repo, env: {} }));

    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaughtException: process.listenerCount('uncaughtException'),
    };
    const first = buildIndex(rt);
    first.close();
    const second = buildIndex(rt); // repeated builds in one process must not stack listeners
    expect(typeof (second as unknown as { then?: unknown }).then).not.toBe('function');
    second.close();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaughtException);
  });
});

describe('sweepStaleBuilds (temp build-db reclamation)', () => {
  const HOUR = 60 * 60 * 1000;
  function tempBuild(dir: string, name: string, ageMs: number): string {
    const full = join(dir, name);
    writeFileSync(full, 'x');
    writeFileSync(`${full}-wal`, 'x');
    writeFileSync(`${full}-shm`, 'x');
    const when = new Date(Date.now() - ageMs);
    for (const f of [full, `${full}-wal`, `${full}-shm`]) utimesSync(f, when, when);
    return full;
  }

  it('reclaims aged temp builds together with their -wal/-shm sidecars', () => {
    const dir = join(repo, 'index');
    mkdirSync(dir, { recursive: true });
    const stale = tempBuild(dir, '.crib-build-111-aaa.sqlite', 3 * HOUR);
    expect(sweepStaleBuilds(dir)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(`${stale}-wal`)).toBe(false);
    expect(existsSync(`${stale}-shm`)).toBe(false);
  });

  it('never touches a recent temp build (a concurrent writer) or the real index', () => {
    const dir = join(repo, 'index');
    mkdirSync(dir, { recursive: true });
    const live = tempBuild(dir, '.crib-build-222-bbb.sqlite', 5 * 1000);
    const real = join(dir, 'crib.sqlite');
    writeFileSync(real, 'x');
    expect(sweepStaleBuilds(dir)).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(real)).toBe(true);
  });

  it('is best-effort: a missing index dir is not an error', () => {
    expect(sweepStaleBuilds(join(repo, 'does-not-exist'))).toBe(0);
  });
});
