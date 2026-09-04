import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest, openIndex } from '@knowledge-crib/core';
import {
  type MemoryEvidence,
  type MemoryRecord,
  MemoryStore,
  memoryRecordId,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
/**
 * `crib memory migrate` — the report must state the schema versions actually on disk.
 *
 * It used to print a hardcoded `schemaVersion: '1'`, so a store that had already been migrated to
 * memory-2 (or memory-3) was reported as v1 — in the one command an operator runs to find out what
 * the store is. The tally is now derived from the entries, and the supported-version list comes from
 * the library constant rather than a literal, so the two can never drift apart again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-migrate';

let repo: string;
let cribDir: string;
let memHome: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-migrate-'));
  cribDir = join(repo, '.crib');
  memHome = join(repo, 'mem-home');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'a.ts'),
    'export class A {\n  b(): number {\n    return 1;\n  }\n}\n',
  );
  // the CLI resolves the store through a REAL index, so bootstrap one (mirrors memory-check.test.ts)
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  indexRepo(soul, repo);
  mkdirSync(join(cribDir, 'index'), { recursive: true });
  const index = openIndex(soul.getManifest().stores.index.backend, {
    path: join(cribDir, 'index', 'crib.sqlite'),
  });
  index.buildFromSoul(soul, repo);
  index.close();
  soul.commit(NOW);
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
  mkdirSync(memHome, { recursive: true });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function ev(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: 'blake3:abc',
  } as MemoryEvidence;
}

/** A valid memory-1 record (id content-addressed from the v1 seed). */
function v1Record(claim: string): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: 'sym:src/a.ts#A.b',
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: ['sym:src/a.ts#A.b'],
    evidence: [ev()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  } as MemoryRecord;
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO_ID, {
    env: { ...process.env, KCRIB_MEMORY_DIR: memHome } as NodeJS.ProcessEnv,
    now: () => NOW,
  });
}

function runMigrate(): { status: number; report: Record<string, unknown> } {
  try {
    const out = execFileSync(process.execPath, [CLI, 'memory', 'migrate'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KCRIB_MEMORY_DIR: memHome, KCRIB_REGISTRY_DIR: memHome },
    });
    return { status: 0, report: JSON.parse(out) as Record<string, unknown> };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return {
      status: err.status ?? 1,
      report: JSON.parse(err.stdout ?? '{}') as Record<string, unknown>,
    };
  }
}

describe('crib memory migrate — reports the versions actually on disk', () => {
  it('tallies a memory-1 store as v1 and names the supported versions from the library', () => {
    localStore().upsertEntries('active', [v1Record('A.b does the thing')]);

    const { status, report } = runMigrate();

    expect(status).toBe(0);
    expect(report.totalInvalid).toBe(0);
    expect(report.byVersion).toEqual({ '1': 1 });
    // memory-3 is live, so the command must advertise it — this is the assertion that fails if the
    // CLI ever re-hardcodes a version list instead of reading SUPPORTED_MEMORY_SCHEMA_VERSIONS.
    expect(report.supportedSchemaVersions).toEqual(['1', '2', '3']);
    // the old lie is gone: there is no single flat `schemaVersion` claim about the whole store
    expect(report).not.toHaveProperty('schemaVersion');
  });

  it('reports a migrated store as memory-2, not as memory-1', () => {
    const store = localStore();
    store.upsertEntries('active', [v1Record('A.b does the thing')]);
    store.migrateToV2();

    const { status, report } = runMigrate();

    expect(status).toBe(0);
    expect(report.byVersion).toEqual({ '2': 1 });
    const perStore = report.perStore as Array<{ store: string; byVersion: Record<string, number> }>;
    expect(perStore.find((s) => s.store === 'local')?.byVersion).toEqual({ '2': 1 });
  });

  it('reports a namespaced store as memory-3', () => {
    const store = localStore();
    store.upsertEntries('active', [v1Record('A.b does the thing')]);
    store.migrateToV2();
    const v2 = store.readCollection('active').entries[0] as { provenance: { principalId: string } };
    store.migrateToV3({
      namespace: { principalId: v2.provenance.principalId, workspaceId: 'workspace:crib' },
    });

    const { status, report } = runMigrate();

    expect(status).toBe(0);
    // the v3 line must READ BACK as a valid entry, not be refused as an unsupported version —
    // the regression that made memory-3 records write-only
    expect(report.totalInvalid).toBe(0);
    expect(report.byVersion).toEqual({ '3': 1 });
  });
});
