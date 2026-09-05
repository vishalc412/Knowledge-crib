/**
 * R02 (docs/audits/2026-09-05/post-merge-reaudit.md) — evidence validity is a property of the
 * world, never of the schema a claim happens to be stored in.
 *
 * The audit stored a trusted v1 record whose `source-quote` evidence pointed at a symbol that no
 * longer existed. Fresh search correctly returned nothing. It then ran the supported
 * `migrateToV2()` and searched again — and the SAME record came back, stamped
 * `evidence: valid`, `applicability: current`, `freshness.state: fresh`. Migration had laundered
 * stale evidence into fresh advice.
 *
 * Two independent defects produced that:
 *   1. `recallProjection` guarded live evaluation with `!isMemoryRecordVersioned(record)`, so a
 *      migrated record was never revalidated — it projected the verdict snapshot captured in its
 *      alias at migration time.
 *   2. The search response stamped ONE freshness object on every hit, derived from "an evaluator
 *      was bound for this pass" rather than from whether that record went through it.
 *
 * So the tests below assert the outcome (a record with a vanished source is excluded) AND the
 * mechanism (a record that was not evaluated never reports `fresh`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryApi } from './api.js';
import { MemoryEvaluator } from './evaluator.js';
import type { MemoryEvalContext } from './evaluator.js';
import { memoryRecordId, memoryRecordV3Id } from './ids.js';
import { derivePropositionKey } from './ids.js';
import { MemoryStore } from './store.js';

const SUBJECT = 'sym:src/deploy.ts#deploy';
const AT = '2026-09-05T00:00:00.000Z';
const QUOTE = 'requires a signed artifact';

/** A soul in which the evidence's anchor symbol does NOT exist — the "source was deleted" world. */
const vanishedSource = {
  getNode: () => undefined,
  rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
  findByLocator: () => [],
} as unknown as MemoryEvalContext['soul'];

/** A soul in which the anchor exists and still contains the quoted text — the control world. */
function livingSource(): MemoryEvalContext['soul'] {
  const node = {
    id: SUBJECT,
    kind: 'symbol',
    name: 'deploy',
    path: 'src/deploy.ts',
    hash: `blake3:${'a'.repeat(64)}`,
    span: { startLine: 1, endLine: 3 },
  };
  return {
    getNode: (id: string) => (id === SUBJECT ? node : undefined),
    rehydrate: () => ({
      text: `export function deploy() { /* ${QUOTE} */ }`,
      truncated: false,
      totalLines: 3,
      startLine: 1,
    }),
    findByLocator: () => [node],
  } as unknown as MemoryEvalContext['soul'];
}

function evidence() {
  return [
    {
      kind: 'source-quote' as const,
      verdict: 'valid' as const,
      checkedAt: AT,
      soulId: SUBJECT,
      quote: QUOTE,
      targetHash: `blake3:${'a'.repeat(64)}`,
    },
  ];
}

/** A trusted memory-1 record — the shape the migration consumes. */
function v1Record(repoId: string) {
  const seed = {
    kind: 'fact' as const,
    subject: SUBJECT,
    claim: 'Deployment requires a signed artifact',
    scope: { boundary: 'repo' as const, repoId },
    appliesTo: [SUBJECT],
    evidence: evidence(),
    authorship: { actor: 'fixture', kind: 'agent' as const, tool: 'test' },
  };
  return {
    ...seed,
    id: memoryRecordId(seed),
    schemaVersion: '1' as const,
    createdAt: AT,
    verdicts: {
      trust: 'local' as const,
      evidence: 'valid' as const,
      applicability: 'current' as const,
      lifecycle: 'active' as const,
    },
  };
}

function makeApi(
  store: MemoryStore,
  env: NodeJS.ProcessEnv,
  soul: MemoryEvalContext['soul'],
): MemoryApi {
  return new MemoryApi({
    stores: { local: store },
    env,
    evaluator: new MemoryEvaluator(),
    evalCtx: { soul } as MemoryEvalContext,
  });
}

/**
 * Every store in this file lives in a per-test temporary directory. `KCRIB_MEMORY_DIR` MUST be set:
 * leaving it unset resolves to the developer's real `~/.crib/memory`, where these fixtures would
 * both persist between runs (making the assertions depend on leftover state) and write test records
 * into a human's actual memory.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-r02-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(repoId: string) {
  const env = {
    ...process.env,
    KCRIB_MEMORY_DIR: join(dir, 'memory'),
    KCRIB_PRINCIPAL_ID: 'principal:local',
  } as NodeJS.ProcessEnv;
  return { env, repoId };
}

describe('migration must not resurrect invalid evidence (R02)', () => {
  it('excludes a vanished-source record BEFORE and AFTER migrateToV2', ({ task }) => {
    const repoId = `r02-${task.id}`;
    const { env } = harness(repoId);
    const store = MemoryStore.local(repoId, { env });
    store.upsertEntry('active', v1Record(repoId));
    const api = makeApi(store, env, vanishedSource);

    // Pre-migration: the freshness engine already gets this right.
    const before = api.search('Deployment');
    expect(before.hits).toHaveLength(0);

    const migration = store.migrateToV2({});
    expect(migration.migrated).toHaveLength(1);

    // Post-migration: the audited regression returned one hit here, valid/current/fresh.
    const after = api.search('Deployment');
    expect(after.hits).toHaveLength(0);
  });

  it('still recalls the SAME migrated record while its source is intact', ({ task }) => {
    const repoId = `r02-live-${task.id}`;
    const { env } = harness(repoId);
    const store = MemoryStore.local(repoId, { env });
    store.upsertEntry('active', v1Record(repoId));
    const api = makeApi(store, env, livingSource());

    expect(api.search('Deployment').hits).toHaveLength(1);
    expect(store.migrateToV2({}).migrated).toHaveLength(1);
    // The negative case above must come from the evidence being gone, NOT from migration
    // breaking recall for every migrated record.
    const after = api.search('Deployment');
    expect(after.hits).toHaveLength(1);
    expect(after.hits[0]!.verdicts.evidence).toBe('valid');
    expect(after.hits[0]!.freshness.state).toBe('fresh');
  });

  it('revalidates a NATIVE versioned record rather than trusting its stamped evidence', ({
    task,
  }) => {
    const repoId = `r02-native-${task.id}`;
    const { env } = harness(repoId);
    const store = MemoryStore.local(repoId, { env });
    // A v3 record whose evidence is STAMPED valid but whose anchor is gone. Nothing about it was
    // migrated, so no alias snapshot is involved — this isolates the schema guard itself.
    const seed = {
      kind: 'fact' as const,
      subject: SUBJECT,
      propositionKey: derivePropositionKey({ subject: SUBJECT }),
      claim: 'Deployment requires a signed artifact',
      evidence: evidence(),
    };
    const namespace = { principalId: 'principal:local', projectId: repoId };
    store.upsertEntry('active', {
      ...seed,
      id: memoryRecordV3Id({ ...seed, namespace }),
      schemaVersion: '3',
      namespace,
      visibility: 'private',
      validTime: { from: AT },
      transactionTime: { observedAt: AT, recordedAt: AT },
      provenance: {
        principalId: 'principal:local',
        deviceId: 'test',
        actorId: 'test',
        clientId: 'test',
      },
      lineage: {},
      sensitivity: 'internal',
      retentionPolicyId: 'ret:default',
    } as never);

    const api = makeApi(store, env, vanishedSource);
    const hit = api.search(SUBJECT).hits.find((h) => h.subject === SUBJECT);
    // Whatever admission decides about native v3 trust, a vanished source must never surface it.
    expect(hit).toBeUndefined();
  });

  it('never labels a record `fresh` that no evaluation pass examined', ({ task }) => {
    const repoId = `r02-label-${task.id}`;
    const { env } = harness(repoId);
    const store = MemoryStore.local(repoId, { env });
    store.upsertEntry('active', v1Record(repoId));
    // No evaluator bound at all: the stamped verdicts carry the record, and the response must say
    // so. This is the invariant that stops a future skip from re-advertising unchecked evidence.
    const api = new MemoryApi({ stores: { local: store }, env });
    const result = api.search('Deployment');
    expect(result.provenance.fresh).toBe(false);
    for (const hit of result.hits) expect(hit.freshness.state).toBe('unevaluated');
  });
});
