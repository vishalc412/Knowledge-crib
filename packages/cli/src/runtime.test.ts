import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
