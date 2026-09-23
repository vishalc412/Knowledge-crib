import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { MemoryStore, createGraphAssertion, createGraphEntity } from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * WP-G5 — `crib memory graph` drives the SAME `memory_graph` verb as MCP, end-to-end against the
 * built `dist/cli.js` over a temp indexed repo, with the principal taken from the environment.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-memory-graph-cli';
const ALPHA = 'principal:alpha';

let repo: string;
let home: string;
let cribDir: string;

function env(principal = ALPHA): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_EMBED_HOME: join(home, 'embed'),
    KCRIB_PRINCIPAL_ID: principal,
  };
}

function run(args: string[], principal = ALPHA): { status: number; json: Record<string, unknown> } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env(principal),
    });
    return { status: 0, json: JSON.parse(out) as Record<string, unknown> };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(err.stdout ?? '') as Record<string, unknown>;
    } catch {
      // usage errors print to stderr; the status assertion carries the failure
    }
    return { status: err.status ?? 1, json };
  }
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-graph-cli-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memory-graph-cli-home-'));
  cribDir = join(repo, '.crib');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function settle() { return 1; }\n');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  soul.commit(NOW);
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
  // The verb serves over the derived index like every other read verb, so build it once.
  execFileSync(process.execPath, [CLI, 'index', '.'], { cwd: repo, stdio: 'ignore', env: env() });
  // `crib index` owns crib.json; read the repo id it settled on rather than assuming ours survived.
  const repoId = (
    JSON.parse(readFileSync(join(cribDir, 'crib.json'), 'utf8')) as { repo: { id: string } }
  ).repo.id;
  const provenance = {
    principalId: ALPHA,
    deviceId: 'device:cli',
    actorId: 'agent:cli',
    clientId: 'vitest',
  };
  const support = createGraphEntity({
    kind: 'concept',
    name: 'retry-policy',
    namespace: { principalId: ALPHA },
    scope: { boundary: 'global' },
    provenance,
  });
  const edge = (predicate: 'about' | 'applies-to', subject: string, object: string) =>
    createGraphAssertion({
      predicate,
      subject,
      object,
      namespace: { principalId: ALPHA },
      scope: { boundary: 'global' },
      validAt: NOW,
      knownAt: NOW,
      supportedBy: [support.ref],
      provenance,
    });
  MemoryStore.local(repoId, { repoRoot: repo, env: env(), now: () => NOW }).submitGraphEntries([
    support,
    edge('about', 'mem:decision', 'topic:retry'),
    edge('applies-to', 'topic:retry', 'sym:src/a.ts#settle'),
  ]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('crib memory graph', () => {
  it('prints usage for --help and refuses a missing op', () => {
    const help = execFileSync(process.execPath, [CLI, 'memory', 'graph', '--help'], {
      cwd: repo,
      encoding: 'utf8',
      env: env(),
    });
    expect(help).toContain('usage: crib memory graph');
    expect(run(['memory', 'graph']).status).toBe(2);
  });

  it('answers path with the authorized assertion chain', () => {
    const r = run(['memory', 'graph', 'path', 'mem:decision', 'sym:src/a.ts#settle']);
    expect(r.status).toBe(0);
    expect((r.json.path as unknown[]).length).toBe(2);
    expect(typeof r.json.generation).toBe('string');
  });

  it('shows another principal nothing', () => {
    const r = run(['memory', 'graph', 'neighbors', 'mem:decision'], 'principal:beta');
    expect(r.status).toBe(0);
    expect(r.json.expansions).toEqual([]);
    expect(r.json.unresolvedRefs).toEqual(['mem:decision']);
  });

  it('exits BAD_ARGS with the verb error for an under-specified op', () => {
    const r = run(['memory', 'graph', 'path', 'mem:decision']);
    expect(r.status).toBe(2);
    expect((r.json.error as { code: string }).code).toBe('BAD_REQUEST');
  });
});
