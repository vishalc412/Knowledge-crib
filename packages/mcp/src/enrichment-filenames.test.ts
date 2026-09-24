/**
 * Artifact file names are derived from the target's soul id. A nested class under a deep path
 * produced a name over the 255-byte filesystem limit, so every save of it failed with ENAMETOOLONG
 * and — because the save loop threw — aborted the rest of the batch too.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrichNextBatch, EnrichSaveResult } from './enrichment.js';
import { Verbs } from './verbs.js';

const DEEP_DIR = `src/${'eventmanagement/'.repeat(8)}api/v3/centerstage`;
const DEEP_FILE = `${DEEP_DIR}/ApiV3CenterStageRemoteScoreDetail.java`;
const NESTED = 'ApiV3CenterStageRemoteScoreDetail.ApiV3CsRemoteAchievementsDetail';

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

const nestedId = idFor({ kind: 'symbol', path: DEEP_FILE, qualifiedName: NESTED, startLine: 2 });
const shortId = idFor({ kind: 'symbol', path: 'src/a.ts', qualifiedName: 'run', startLine: 1 });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-enrich-names-'));
  mkdirSync(join(repo, DEEP_DIR), { recursive: true });
  writeFileSync(
    join(repo, DEEP_FILE),
    'class ApiV3CenterStageRemoteScoreDetail {\n  static class ApiV3CsRemoteAchievementsDetail { int achievementPoints = computeAchievements(); }\n}\n',
  );
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function run() { return startTheEngine(); }\n');
  soul = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
  soul.putNodes([
    {
      id: nestedId,
      kind: 'symbol',
      type: 'class',
      name: 'ApiV3CsRemoteAchievementsDetail',
      qualifiedName: NESTED,
      file: DEEP_FILE,
      span: { start: 2, end: 2 },
      lang: 'java',
      hash: contentHash(NESTED),
    },
    {
      id: shortId,
      kind: 'symbol',
      type: 'function',
      name: 'run',
      qualifiedName: 'run',
      file: 'src/a.ts',
      span: { start: 1, end: 1 },
      lang: 'typescript',
      hash: contentHash('run'),
    },
  ]);
  soul.commit('2026-01-01T00:00:00.000Z');
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  verbs = new Verbs({ soul, index, repoRoot: repo });
});

afterEach(() => {
  index.close();
  rmSync(repo, { recursive: true, force: true });
});

function save(): EnrichSaveResult {
  const batch = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
  return verbs.enrichSave({
    batchId: batch.batchId,
    items: [
      {
        targetId: nestedId,
        analysis: { purpose: 'Holds achievement points.', confidence: 0.9 },
        graph: { nodes: [], edges: [] },
        evidence: [{ soulId: nestedId, quote: 'int achievementPoints = computeAchievements();' }],
      },
      {
        targetId: shortId,
        analysis: { purpose: 'Starts the engine.', confidence: 0.9 },
        graph: { nodes: [], edges: [] },
        evidence: [{ soulId: shortId, quote: 'return startTheEngine();' }],
      },
    ],
  }) as unknown as EnrichSaveResult;
}

describe('enrichment artifact file names', () => {
  it('persists a target whose id would exceed the filesystem name limit, and the rest of the batch', () => {
    expect(Buffer.byteLength(nestedId)).toBeGreaterThan(255);
    const result = save();
    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((a) => a.targetId).sort()).toEqual([nestedId, shortId].sort());
    for (const a of result.accepted) expect(Buffer.byteLength(basename(a.path))).toBeLessThan(240);
    expect(verbs.enrichNext({ layer: 'symbol', limit: 25 })).toMatchObject({ items: [] });
  });

  it('re-saving replaces the previous artifact instead of accumulating files', () => {
    const first = save().accepted.find((a) => a.targetId === nestedId)!;
    save();
    const dir = join(first.path, '..');
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });
});
