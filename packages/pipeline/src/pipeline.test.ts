import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SoulStore,
  SqliteIndexStore,
  dossiersDir,
  newManifest,
  readDossier,
} from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from './pipeline.js';
import { discoverFiles } from './structure.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'junk', 'index.ts'), 'export const ignored = 1;\n');
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    [
      'export class AuthService {',
      '  login(): void { this.issue(); }',
      '  issue(): void { log(); }',
      '}',
      'export function log(): void {}',
    ].join('\n'),
  );
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function soulFor(): SoulStore {
  const s = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  s.load();
  return s;
}

describe('indexRepo Phase 1+2 (M2 integration)', () => {
  it('discoverFiles ignores node_modules and finds source', () => {
    const files = discoverFiles(repo);
    expect(files.map((f) => f.path)).toEqual(['src/auth.ts']);
  });

  it('builds file + symbol nodes and intra-file edges into the soul', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, repo, { now: '2026-01-01T00:00:00.000Z' });
    expect(report.files).toBe(1);

    const reopened = soulFor();
    expect([...reopened.iterate('file')]).toHaveLength(1);
    const symbols = [...reopened.iterate('symbol')].map((n) => n.qualifiedName).sort();
    expect(symbols).toEqual(
      ['AuthService', 'AuthService.issue', 'AuthService.login', 'log'].sort(),
    );
    expect([...reopened.iterateEdges('member-of')].length).toBeGreaterThanOrEqual(4);
    expect([...reopened.iterateEdges('calls')].length).toBe(2);
  });

  it('feeds the derived index so impact works end to end', async () => {
    const soul = soulFor();
    const index = new SqliteIndexStore();
    await indexRepo(soul, repo, { now: '2026-01-01T00:00:00.000Z', index });
    const login = [...soul.iterate('symbol')].find((n) => n.qualifiedName === 'AuthService.login');
    const issue = [...soul.iterate('symbol')].find((n) => n.qualifiedName === 'AuthService.issue');
    expect(login && issue).toBeTruthy();
    // login depends on issue (down); issue is in login's blast radius going down.
    if (login) expect(index.impact(login.id, 'down').nodes).toContain(issue?.id);
    // BM25 search finds the class.
    expect(index.query({ text: 'AuthService', kinds: ['symbol'] })[0]?.name).toBe('AuthService');
    index.close();
  });

  it('re-index is deterministic (id-stable symbols)', async () => {
    const a = soulFor();
    await indexRepo(a, repo, { now: '2026-01-01T00:00:00.000Z' });
    const idsA = [...soulFor().iterate('symbol')].map((n) => n.id).sort();
    const b = soulFor();
    await indexRepo(b, repo, { now: '2026-01-02T00:00:00.000Z' });
    const idsB = [...soulFor().iterate('symbol')].map((n) => n.id).sort();
    expect(idsB).toEqual(idsA);
  });
});

describe('indexRepo Workstream E — persisted reusable dossiers', () => {
  it('builds + persists a fresh dossier for every callable symbol under .crib/dossiers/', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, repo, { now: '2026-01-01T00:00:00.000Z' });
    // 3 callables: AuthService.login, AuthService.issue, log (the class itself is not callable).
    expect(report.dossiers.candidates).toBe(3);
    expect(report.dossiers.written).toBe(3);
    expect(report.dossiers.fresh).toBe(0);

    const dir = dossiersDir(join(repo, '.crib'));
    expect(existsSync(dir)).toBe(true);
    const shardDirs = readdirSync(dir);
    expect(shardDirs.length).toBeGreaterThan(0);

    const login = [...soul.iterate('symbol')].find((n) => n.qualifiedName === 'AuthService.login')!;
    const read = readDossier(join(repo, '.crib'), login.id, {
      nodeHash: login.hash,
      schemaVersion: soul.getManifest().schemaVersion,
    });
    expect(read.missing).toBe(false);
    expect(read.stale).toBe(false);
    expect(read.dossier?.node.qualifiedName).toBe('AuthService.login');
    expect(read.dossier?.callers.length).toBe(0);
    expect(read.dossier?.callees.map((c) => c.qualifiedName)).toContain('AuthService.issue');
  });

  it('leaves fresh dossiers untouched on a no-op re-index (deterministic dossier store)', async () => {
    const a = soulFor();
    await indexRepo(a, repo, { now: '2026-01-01T00:00:00.000Z' });
    const b = soulFor();
    const report = await indexRepo(b, repo, { now: '2026-01-02T00:00:00.000Z' });
    expect(report.dossiers.candidates).toBe(3);
    expect(report.dossiers.written).toBe(0);
    expect(report.dossiers.fresh).toBe(3);
  });
});
