import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { Verbs } from '@knowledge-crib/mcp';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex, isIndexed, openSoul, resolveProjectRoot } from './runtime.js';

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
});
