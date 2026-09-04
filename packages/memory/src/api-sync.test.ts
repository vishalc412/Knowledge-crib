/**
 * Gate 4 — the API surface + the D10 privacy guard, one test per contract clause:
 *
 *   - D10 (private never enters git): the team store's write gate refuses a private-projecting
 *     memory-2 record through EVERY path — a direct `upsertEntries`, the `supersede` successor
 *     path (no partial supersede: the decision never lands either), and the `proposeTeam`
 *     prophylactic — while the SAME private record lands fine at the local store and a
 *     workspace-projecting record writes fine everywhere;
 *   - `sync`: the discriminated-union routing (not-configured / fail-closed no-key / push /
 *     pull / status) over an INJECTED backend port with the key resolved from the env;
 *   - `syncInit`: seeds the baseline + writes the config file that carries a key REFERENCE and
 *     fingerprint, never key bytes;
 *   - `listSyncConflicts` + `resolveConflict`: the ledger folds per store; a human resolution
 *     appends decisions (append-only — the conflict rows are never rewritten);
 *   - `purgeRecords` (D11): the exact-confirm law, the dry-run that computes everything and
 *     writes nothing, the real purge (tombstone decision + shard rewrite + twin sweep + the
 *     alias-resolved twin with alias lines RETAINED), the team refusal on a dirty tree, and the
 *     remote deleteObject + purge-ack recorded LAST.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CandidateEvaluation,
  type CaptureOutboxEntry,
  type ConflictRecord,
  FileSyncObjectStore,
  type GateProfile,
  type GateReceipt,
  MemoryApi,
  type MemoryCandidate,
  type MemoryDecision,
  type MemoryEvidence,
  type MemoryPolicy,
  type MemoryRecord,
  type MemoryRecordV2,
  type MemoryScope,
  MemoryStore,
  ProposalRefusedError,
  type SyncConfigFile,
  TeamPrivateVisibilityError,
  __resetMemoryLockGuardForTest,
  buildCaptureOutboxEntry,
  deriveEventId,
  derivePropositionKey,
  feedbackId,
  isMemoryRecordV2,
  keyFingerprint,
  loadSyncState,
  memoryCandidateId,
  memoryRecordId,
  memoryRecordV2Id,
  policyHash,
  profileHash,
  proposeTeam,
  readStagedEvents,
  readSyncConfig,
  receiptId,
  routeKeyFor,
  syncConfigPath,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const LATER = '2027-01-01T00:00:00.000Z';
const REPO = 'r-api-sync';
const SUBJECT = 'sym:src/a.ts#A.b';
const ACTOR = 'principal-vishal';
const KEY_HEX = 'ab'.repeat(32);
const KEY = Buffer.from(KEY_HEX, 'hex');

// ─── fixtures ────────────────────────────────────────────────────────────────

function evidence(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId: SUBJECT,
    quote: 'does the thing',
    targetHash: 'blake3:abcd1234',
  };
}

const SCOPE: MemoryScope = { boundary: 'repo', repoId: REPO };
const AUTHORSHIP = { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' };

/** The v1 record + the SAME-SEED candidate twin (`cand:<h>` shares the v1 claim-body hash). */
function v1Pair(claim = 'A.b does the thing'): {
  record: MemoryRecord;
  candidate: MemoryCandidate;
} {
  const input = {
    kind: 'fact' as const,
    subject: SUBJECT,
    claim,
    scope: SCOPE,
    appliesTo: [SUBJECT],
    evidence: [evidence()],
    authorship: AUTHORSHIP,
  };
  return {
    record: {
      id: memoryRecordId(input),
      schemaVersion: '1',
      ...input,
      verdicts: {
        trust: 'local',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
      createdAt: T0,
    },
    candidate: {
      id: memoryCandidateId(input),
      schemaVersion: '1',
      ...input,
      origin: 'observe',
      proposedAt: T0,
    },
  };
}

/** A fully-formed memory-2 record (passes the v2 write gate when persisted). */
function v2Record(
  over: { claim?: string; visibility?: MemoryRecordV2['visibility'] } = {},
): MemoryRecordV2 {
  const claim = over.claim ?? 'A.b does the thing';
  const evidence_ = [evidence()];
  const propositionKey = derivePropositionKey({ subject: SUBJECT });
  return {
    id: memoryRecordV2Id({
      kind: 'fact',
      subject: SUBJECT,
      propositionKey,
      claim,
      evidence: evidence_,
    }),
    schemaVersion: '2',
    visibility: over.visibility ?? 'workspace',
    kind: 'fact',
    subject: SUBJECT,
    propositionKey,
    claim,
    validTime: { from: T0 },
    transactionTime: { observedAt: T0, recordedAt: T0 },
    evidence: evidence_,
    provenance: {
      principalId: ACTOR,
      deviceId: 'device-a',
      actorId: 'claude-code',
      clientId: 'claude-code',
    },
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
  };
}

/** The gate-receipt fixture promotion.test.ts uses (the only shape the receipts validator accepts). */
function profile(): GateProfile {
  return {
    name: 'test',
    executable: 'node',
    args: ['--version'],
    timeoutMs: 5000,
    permittedEnv: ['PATH'],
    successExitCodes: [0],
    assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
  };
}
function policy(): MemoryPolicy {
  return { version: 1, profiles: { test: profile() } };
}
function gateReceipt(): GateReceipt {
  const pol = policy();
  const prof = pol.profiles.test!;
  const r = {
    policyHash: policyHash(pol),
    profileHash: profileHash(prof),
    executable: '/usr/bin/node',
    args: prof.args,
    head: '0'.repeat(40),
    worktreeDigest: `blake3:${'a'.repeat(64)}`,
    exitCode: 0,
    outputDigest: `blake3:${'b'.repeat(64)}`,
    assertions: [{ name: 'exit-ok', passed: true }],
    runner: 'ci' as const,
  };
  return { id: receiptId(r), schemaVersion: '1', ...r, durationMs: 0, ts: T0 };
}

// ─── harness ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  __resetMemoryLockGuardForTest();
  const home = tempDir('mem-api-sync-env-');
  env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: KEY_HEX,
  };
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A device env: its own relocated memory home + registry + the shared sync key (D7 env source). */
function deviceEnv(): NodeJS.ProcessEnv {
  const home = tempDir('mem-api-sync-device-');
  return {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: KEY_HEX,
  };
}

function setup(opts: { team?: boolean; repoRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
  const runEnv = opts.env ?? env;
  const local = MemoryStore.local(REPO, {
    env: runEnv,
    now: () => T0,
    ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
  });
  local.ensureManifest(); // the sync surface keys the config + events on the manifest's repo.id
  const team = opts.team
    ? MemoryStore.team(tempDir('mem-api-sync-team-'), { env: runEnv, now: () => T0 })
    : undefined;
  const api = new MemoryApi({
    stores: team ? { team, local } : { local },
    env: runEnv,
    now: () => T0,
  });
  return { local, team, api };
}

/** A deliberately NON-git repo root: `git status` fails there, so the clean-tree gate refuses —
 *  deterministic, and it never depends on THIS checkout's working-tree state. */
const NON_GIT_ROOT = tempDir('mem-api-sync-not-a-git-');

// ─── the D10 privacy guard ────────────────────────────────────────────────────

describe('D10 — private never enters git', () => {
  it('a private v2 record is refused at the team store but lands fine locally; workspace writes fine', () => {
    const { team, local } = setup({ team: true });
    const rec = v2Record({ visibility: 'private' });
    expect(() => team!.upsertEntry('records', rec)).toThrow(TeamPrivateVisibilityError);
    // a non-private v2 record writes fine at the team store
    team!.upsertEntry('records', v2Record({ claim: 'a workspace claim' }));
    expect(team!.readCollection('records').entries).toHaveLength(1);
    // the SAME private record is unremarkable at the local store (git never sees it)
    local.ensureManifest();
    local.upsertEntry('active', rec);
    expect(local.readCollection('active').entries).toHaveLength(1);
  });

  it('a supersede whose successor projects private is refused with no partial supersede (D10)', () => {
    const { team, api } = setup({ team: true });
    const original = v2Record({ claim: 'the original claim', visibility: 'workspace' });
    team!.upsertEntry('records', original);
    // the payload successor defaults to 'private' — the team write gate refuses it
    const refused = api.supersede(
      original.id,
      { claim: 'a private successor claim' },
      { actor: ACTOR },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected the private-projecting supersede to be refused');
    expect(refused.error).toContain('private');
    // no partial supersede: no successor, no decision, the original untouched
    expect(team!.readCollection('records').entries).toHaveLength(1);
    expect(team!.readCollection('decisions').entries).toHaveLength(0);
    // and a workspace-projecting successor goes through
    const ok = api.supersede(
      original.id,
      { claim: 'a workspace successor', visibility: 'workspace' },
      { actor: ACTOR },
    );
    expect(ok.ok).toBe(true);
    expect(team!.readCollection('decisions').entries).toHaveLength(1);
  });

  it('proposeTeam refuses a private-projecting record before anything is written (D10 prophylactic)', () => {
    const { team } = setup({ team: true });
    // The D10 check reads the runtime shape and runs BEFORE any write, so a cast envelope is
    // enough here — the refusal fires before the receipt would ever be validated.
    const privateShape = {
      id: 'mem:cast-private',
      schemaVersion: '2',
      visibility: 'private',
      verdicts: {
        trust: 'local',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
    } as unknown as MemoryRecord;
    const evaluation = {
      record: privateShape,
      evaluation: { evidence: 'valid' },
    } as unknown as CandidateEvaluation;
    expect(() => proposeTeam(team!, evaluation, gateReceipt(), ACTOR, () => T0)).toThrow(
      ProposalRefusedError,
    );
    expect(() => proposeTeam(team!, evaluation, gateReceipt(), ACTOR, () => T0)).toThrow(
      /private never enters git/,
    );
    expect(team!.readCollection('records').entries).toHaveLength(0);
  });

  it('an invalid-evidence refusal still precedes the D10 check (admissibility first)', () => {
    const { team } = setup({ team: true });
    const privateShape = {
      id: 'mem:cast-private-invalid',
      schemaVersion: '2',
      visibility: 'private',
      verdicts: {
        trust: 'local',
        evidence: 'invalid',
        applicability: 'current',
        lifecycle: 'active',
      },
    } as unknown as MemoryRecord;
    const evaluation = {
      record: privateShape,
      evaluation: { evidence: 'invalid' },
    } as unknown as CandidateEvaluation;
    expect(() => proposeTeam(team!, evaluation, gateReceipt(), ACTOR, () => T0)).toThrow(
      /evidence verdict is invalid/,
    );
    expect(team!.readCollection('records').entries).toHaveLength(0);
  });
});

// ─── the sync API surface (D12: union routing, honest shapes) ────────────────

describe('MemoryApi.sync — union routing', () => {
  it('an API with no participant stores reports not-configured and names init-sync', async () => {
    const api = new MemoryApi({ stores: {}, env, now: () => T0 });
    const res = await api.sync({ op: 'push', stores: ['local'] });
    if ('op' in res) throw new Error('a not-configured response must not carry an op');
    expect(res.ok).toBe(false);
    expect(res.available).toBe(false);
    expect(res.capability).toBe('sync');
    expect(res.status).toBe('not-configured');
    expect(res.message).toContain('init-sync');
    expect(res.request).toEqual({ op: 'push', stores: ['local'] });
  });

  it('fails closed with no sync key — every store run is refused before any bytes move', async () => {
    const { local, api } = setup({ env: { ...env, KCRIB_SYNC_KEY: undefined } });
    local.ensureManifest();
    local.upsertEntry('active', v1Pair().record);
    const remote = tempDir('mem-api-sync-remote-');
    const res = await api.sync({ op: 'push', backend: new FileSyncObjectStore(remote) });
    if (!('op' in res) || res.op === 'status') throw new Error('expected a run result');
    expect(res.ok).toBe(false);
    expect(res.op).toBe('push');
    expect(res.stores).toEqual([]);
    expect(res.message).toContain('no sync key resolved');
    expect((await new FileSyncObjectStore(remote).listObjects('')).keys).toEqual([]);
  });

  it('push and pull route through the injected backend per participant store (device A → device B)', async () => {
    const backend = new FileSyncObjectStore(tempDir('mem-api-sync-remote-'));
    const a = setup({ env: deviceEnv() });
    const b = setup({ env: deviceEnv() });
    // init-sync seeds BOTH baselines (D5) before any bytes exist to sync
    expect((await a.api.syncInit({ scope: 'local', deviceId: 'device-a', key: KEY })).ok).toBe(
      true,
    );
    expect((await b.api.syncInit({ scope: 'local', deviceId: 'device-b', key: KEY })).ok).toBe(
      true,
    );
    const rec = v1Pair().record;
    a.local.upsertEntry('active', rec);

    const push = await a.api.sync({ op: 'push', backend });
    if (!('op' in push) || push.op === 'status') throw new Error('expected a run result');
    expect(push.ok).toBe(true);
    expect(push.stores).toHaveLength(1);
    expect(push.stores[0]?.store).toBe('local');
    expect(push.stores[0]?.push?.pushed).toBe(1);

    const pull = await b.api.sync({ op: 'pull', backend });
    if (!('op' in pull) || pull.op === 'status') throw new Error('expected a run result');
    expect(pull.ok).toBe(true);
    expect(pull.stores[0]?.pull?.applied.map((x) => x.action)).toEqual(['upserted']);
    // the pulled record lands through B's write gate keeping the pushing device's stamps
    const landed = b.local.readCollection('active').entries.find((e) => e.id === rec.id);
    expect(landed?.id).toBe(rec.id);
    expect(isMemoryRecordV2(landed!)).toBe(false);

    // status folds the per-store engine report: B pulled 1 batch, the key fingerprint matches
    const status = await b.api.sync({ op: 'status', backend });
    if (!('op' in status) || status.op !== 'status') throw new Error('expected a status report');
    expect(status.ok).toBe(true);
    expect(status.stores[0]?.status).toBe('initialized');
    expect(status.stores[0]?.batchesPulled).toBe(1);
    expect(status.stores[0]?.remote?.reachable).toBe(true);
    expect(status.stores[0]?.remote?.keyFingerprintMatch).toBe(true);
  });

  it('syncInit writes a config that carries a key REFERENCE + fingerprint, never key bytes', async () => {
    const { api } = setup();
    const res = await api.syncInit({ scope: 'local', deviceId: 'device-a', key: KEY });
    expect(res.ok).toBe(true);
    expect(res.baseline?.created).toBe(true);
    expect(res.keyFingerprint).toBe(keyFingerprint(KEY));
    expect(res.keyEpoch).toBe(1);
    const path = syncConfigPath('local', REPO, env);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain(KEY_HEX); // NEVER the bytes
    const config = readSyncConfig('local', REPO, env) as SyncConfigFile;
    expect(config.keySource).toBe('env');
    expect(config.keyFingerprint).toBe(res.keyFingerprint);
    expect(config.id).toBe(REPO);
  });
});

// ─── the conflicts ledger + append-only resolution (D8) ──────────────────────

/** Build a REAL same-id-different-bytes conflict: two devices, one shared remote, one pull. */
async function conflictFixture() {
  const backend = new FileSyncObjectStore(tempDir('mem-api-sync-conflict-remote-'));
  const a = setup({ env: deviceEnv() });
  const b = setup({ env: deviceEnv() });
  void (await a.api.syncInit({ scope: 'local', deviceId: 'device-a', key: KEY }));
  void (await b.api.syncInit({ scope: 'local', deviceId: 'device-b', key: KEY }));
  const recA = v1Pair().record;
  const recB = {
    ...recA,
    verdicts: { ...recA.verdicts, trust: 'team' as const },
    createdAt: LATER,
  };
  b.local.upsertEntry('active', recB); // same id, honest different bytes
  a.local.upsertEntry('active', recA);
  return { backend, a, b, recA, recB };
}

describe('listSyncConflicts + resolveConflict (D8: humans decide, the ledger records)', () => {
  it('folds the per-store conflict ledger from a real pull conflict, digests only', async () => {
    const { backend, a, b, recA, recB } = await conflictFixture();
    await a.api.sync({ op: 'push', backend });
    const pull = await b.api.sync({ op: 'pull', backend });
    if (!('op' in pull) || pull.op === 'status') throw new Error('expected a run result');
    expect(pull.stores[0]?.pull?.conflictsAdded).toHaveLength(1);
    // the ledger folds per store, and it carries digests + ids — never payload bytes
    const folded = b.api.listSyncConflicts();
    expect(folded.ok).toBe(true);
    expect(folded.conflicts).toHaveLength(1);
    const row = folded.conflicts[0] as ConflictRecord & { store: 'local' };
    expect(row.store).toBe('local');
    expect(row.payloadId).toBe(recA.id);
    expect(row.localDigest).not.toBe(row.remoteDigest);
    expect(row.sourceDevice).toBe('device-a');
    void recB;
  });

  it('a retract resolution APPENDS a decision and retires the local variant', async () => {
    const { backend, a, b, recA } = await conflictFixture();
    await a.api.sync({ op: 'push', backend });
    await b.api.sync({ op: 'pull', backend });
    const res = b.api.resolveConflict(
      recA.id,
      { retract: true },
      ACTOR,
      'the local variant wins by retract',
    );
    expect(res.ok).toBe(true);
    expect(res.decisionId).toBeDefined();
    // the resolving decision landed in the SAME store role as the record (append-only)
    const decisions = b.local.readCollection('decisions').entries as MemoryDecision[];
    const retract = decisions.find((d) => d.kind === 'retract' && d.subject === recA.id);
    expect(retract?.id).toBe(res.decisionId);
    // the record LINE survives (append-only law) — the belief change is the decision
    expect(b.local.readCollection('active').entries.find((e) => e.id === recA.id)).toBeDefined();
    expect(b.api.audit(recA.id).records[0]?.verdicts.lifecycle).toBe('retracted');
  });

  it('a successor resolution APPENDS a supersede decision naming that successor', async () => {
    const { backend, a, b, recA } = await conflictFixture();
    await a.api.sync({ op: 'push', backend });
    await b.api.sync({ op: 'pull', backend });
    // a second, unrelated record becomes the chosen successor
    const successor = v1Pair('A.b does the thing, verified').record;
    b.local.upsertEntry('active', successor);
    const res = b.api.resolveConflict(recA.id, { successor: successor.id }, ACTOR);
    expect(res.ok).toBe(true);
    const decisions = b.local.readCollection('decisions').entries as MemoryDecision[];
    const supersede = decisions.find((d) => d.kind === 'supersede' && d.subject === recA.id);
    expect(supersede?.successor).toBe(successor.id);
    expect(b.api.audit(recA.id).records[0]?.verdicts.lifecycle).toBe('superseded');
  });

  it('refuses to resolve with both or neither of successor / retract, and without an actor', async () => {
    const { b, recA } = await conflictFixture();
    expect(
      b.api.resolveConflict(recA.id, { retract: true, successor: 'mem:x' }, ACTOR).error,
    ).toContain('exactly one');
    expect(b.api.resolveConflict(recA.id, {}, ACTOR).error).toContain('successor or retract');
    expect(b.api.resolveConflict(recA.id, { retract: true }, '').error).toContain('actor');
  });
});

// ─── purgeRecords (D11) ───────────────────────────────────────────────────────

/** Seed a record + every twin the sweep must find: the same-seed `cand:` staging twin, a feedback
 *  row, and a capture-outbox entry correlated on the staging twin. */
function purgeFixture(opts: { team?: boolean; repoRoot?: string } = {}) {
  const { local, api, team } = setup({ team: opts.team, repoRoot: opts.repoRoot });
  local.ensureManifest();
  const { record, candidate } = v1Pair();
  local.upsertEntry('active', record);
  local.upsertEntry('candidates', candidate);
  const fb = {
    id: feedbackId({ signal: 'useful', subject: record.id, actor: ACTOR }),
    schemaVersion: '1' as const,
    signal: 'useful' as const,
    subject: record.id,
    actor: ACTOR,
    ts: T0,
  };
  local.upsertEntry('feedback', fb);
  const cap = {
    ...buildCaptureOutboxEntry(
      {
        kind: record.kind,
        subject: record.subject,
        claim: record.claim,
        scope: record.scope,
        appliesTo: record.appliesTo,
        evidence: record.evidence,
        authorship: record.authorship,
        origin: 'observe',
      },
      T0,
    ),
    meta: { candidateId: candidate.id },
  } as CaptureOutboxEntry;
  local.upsertEntry('outbox', cap);
  return { local, api, team, record, candidate, fb, cap };
}

describe('purgeRecords (D11: tombstone first, store-mediated rewrite, honest limits)', () => {
  it('refuses unless confirmIds repeats the exact purge list (no wildcards)', async () => {
    const { api, record } = purgeFixture();
    const res = await api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id, 'mem:other'],
    });
    expect(res.ok).toBe(false);
    expect(res.purged).toEqual([]);
    expect(res.message).toContain('confirmIds');
    // nothing was touched
    const noActor = await api.purgeRecords([record.id], { actor: '', confirmIds: [record.id] });
    expect(noActor.message).toContain('actor');
  });

  it('computes everything on dry-run and writes nothing anywhere', async () => {
    const { local, api, record, candidate, fb, cap } = purgeFixture();
    const res = await api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id],
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    const report = res.purged[0]!;
    expect(report.found).toBe(true);
    expect(report.stores[0]?.removed).toBe(false);
    expect(report.stores[0]?.twins).toEqual([candidate.id, fb.id, cap.id]);
    expect(report.stores[0]?.decisionId).toBeDefined();
    // NOTHING was written: the record, the twins, the ledger — all unchanged
    expect(local.readCollection('active').entries.find((e) => e.id === record.id)).toBeDefined();
    expect(
      local.readCollection('candidates').entries.find((e) => e.id === candidate.id),
    ).toBeDefined();
    expect(local.readCollection('feedback').entries.find((e) => e.id === fb.id)).toBeDefined();
    expect(local.readCollection('outbox').entries.find((e) => e.id === cap.id)).toBeDefined();
    expect(local.readCollection('decisions').entries).toHaveLength(0);
  });

  it('purges: tombstone decision appended, shard rewritten, twins swept, alias twin purged with alias lines RETAINED', async () => {
    const { local, api, record, candidate, fb, cap } = purgeFixture();
    // give the record a legacy alias so the resolved twin rides the same purge
    local.migrateToV2({});
    const legacyId = record.id;
    const v2Id = local.resolveId(legacyId);
    expect(v2Id).not.toBe(legacyId);

    const res = await api.purgeRecords([legacyId], { actor: ACTOR, confirmIds: [legacyId] });
    expect(res.ok).toBe(true);
    const report = res.purged[0]!;
    expect(report.found).toBe(true);
    expect(report.resolvedTwin).toBe(v2Id);
    const storeReport = report.stores[0]!;
    expect(storeReport.removed).toBe(true);
    expect(storeReport.twins).toEqual([candidate.id, fb.id, cap.id]);

    // (1) the logical tombstone decision is the synced, replayable part — keyed on the live
    // (v2 twin) line the migration left in the shard
    const decisions = local.readCollection('decisions').entries as MemoryDecision[];
    expect(decisions.find((d) => d.kind === 'retract' && d.subject === v2Id)).toBeDefined();
    // (2) BOTH the legacy id and its v2 twin are gone from the shards
    expect(local.readCollection('active').entries.find((e) => e.id === legacyId)).toBeUndefined();
    expect(local.readCollection('active').entries.find((e) => e.id === v2Id)).toBeUndefined();
    // (3) the twins are gone
    expect(
      local.readCollection('candidates').entries.find((e) => e.id === candidate.id),
    ).toBeUndefined();
    expect(local.readCollection('feedback').entries.find((e) => e.id === fb.id)).toBeUndefined();
    expect(local.readCollection('outbox').entries.find((e) => e.id === cap.id)).toBeUndefined();
    // (4) alias lines are RETAINED — deliberate audit history
    expect(local.readAliases().length).toBeGreaterThan(0);
  });

  it('team is never touched unless explicitly listed, and never physically removed even then', async () => {
    const { team, api, record } = purgeFixture({ team: true, repoRoot: NON_GIT_ROOT });
    team!.upsertEntry('records', record);
    // default stores are local + global — team is untouched without an explicit opt-in
    await api.purgeRecords([record.id], { actor: ACTOR, confirmIds: [record.id] });
    expect(team!.readCollection('records').entries.find((e) => e.id === record.id)).toBeDefined();
    // explicit opt-in on a NON-git root: the clean-tree gate refuses, nothing is removed
    const dirty = await api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id],
      stores: ['team'],
    });
    expect(dirty.ok).toBe(false);
    expect(dirty.purged[0]?.error).toContain('clean git working tree');
    expect(team!.readCollection('records').entries.find((e) => e.id === record.id)).toBeDefined();
  });

  it('deletes the routed remote blobs and records the purge-ack LAST; dry-run deletes nothing', async () => {
    const backend = new FileSyncObjectStore(tempDir('mem-api-sync-purge-remote-'));
    const a = setup({ env: deviceEnv() });
    void (await a.api.syncInit({ scope: 'local', deviceId: 'device-a', key: KEY }));
    const record = v1Pair().record;
    a.local.upsertEntry('active', record);
    void (await a.api.sync({ op: 'push', backend }));
    const evtId = deriveEventId('record.upsert', 'local', REPO, record);
    const routeKey = routeKeyFor(evtId, KEY);
    expect((await backend.listObjects('ev/')).keys).toContain(routeKey);

    // dry-run with a backend: computed, nothing deleted
    const dry = await a.api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id],
      stores: ['local'],
      dryRun: true,
      backend,
      syncKey: KEY,
    });
    expect(dry.ok).toBe(true);
    expect((await backend.listObjects('ev/')).keys).toContain(routeKey);

    const res = await a.api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id],
      stores: ['local'],
      backend,
      syncKey: KEY,
    });
    expect(res.ok).toBe(true);
    // terminal state first: the blob is gone from the remote
    expect((await backend.listObjects('ev/')).keys).not.toContain(routeKey);
    // bookkeeping last: the purge-ack is in sync-state
    const state = loadSyncState(a.local.rootDir);
    expect(state?.purgeAcks).toContain(evtId);
  });
});

// ─── write-site staging (D3/D4 at the API surface) ───────────────────────────

describe('write-site staging (D3/D4 at the API surface)', () => {
  it('a supersede written through the API stages its decision under the same lock, and the next push carries it to the peer', async () => {
    const backend = new FileSyncObjectStore(tempDir('mem-api-sync-stage-remote-'));
    const a = setup({ env: deviceEnv() });
    const b = setup({ env: deviceEnv() });
    void (await a.api.syncInit({ scope: 'local', deviceId: 'device-a', key: KEY }));
    void (await b.api.syncInit({ scope: 'local', deviceId: 'device-b', key: KEY }));
    const record = v1Pair().record;
    a.local.upsertEntry('active', record);

    const sup = a.api.supersede(
      record.id,
      { claim: 'A.b does the OTHER thing', visibility: 'workspace' },
      { actor: ACTOR },
    );
    if (!sup.ok) throw new Error(sup.error);
    // the decision staged AT the write site (one lock hold with the write), payloadId = decision id
    const staged = readStagedEvents(a.local.rootDir).events;
    expect(staged.map((e) => e.kind)).toEqual(['decision.append']);
    expect(staged[0]?.payloadId).toBe(sup.decisionId);

    // the push sweep carries the record (re-derived) AND the staged decision (already staged,
    // re-pushed without re-staging); both ack
    const push = await a.api.sync({ op: 'push', backend });
    if (!('op' in push) || push.op === 'status') throw new Error('expected a run result');
    expect(push.ok).toBe(true);
    // the sweep carries the original record + the successor record + the staged decision
    expect(push.stores[0]?.push?.pushed).toBe(3);
    expect(loadSyncState(a.local.rootDir)?.ackedEvents).toContain(staged[0]?.id);

    const pull = await b.api.sync({ op: 'pull', backend });
    if (!('op' in pull) || pull.op === 'status') throw new Error('expected a run result');
    expect(pull.ok).toBe(true);
    expect(pull.stores[0]?.pull?.applied).toEqual(
      expect.arrayContaining([
        { eventId: staged[0]?.id, payloadId: sup.decisionId, action: 'decision-applied' },
      ]),
    );
    // the tombstone replayed through B's write gate — the deletion reached the other device
    const landed = b.local.readCollection('decisions').entries.find((e) => e.id === sup.decisionId);
    expect(landed).toBeDefined();
  });
  it('a team purge refused on a dirty tree appends NO tombstone decision anywhere (gate ordering)', async () => {
    const { local, team, api, record } = purgeFixture({ team: true, repoRoot: NON_GIT_ROOT });
    team!.upsertEntry('records', record);
    const dirty = await api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id],
      stores: ['team'],
    });
    expect(dirty.ok).toBe(false);
    expect(dirty.purged[0]?.error).toContain('clean git working tree');
    // the clean-tree gate runs BEFORE the tombstone (F4/F11/F19/F23) — no retract decision was
    // appended in ANY store, so the refused purge syncs nothing and reverses nothing
    expect(team!.readCollection('decisions').entries).toHaveLength(0);
    expect(local.readCollection('decisions').entries).toHaveLength(0);
    expect(team!.readCollection('records').entries.find((e) => e.id === record.id)).toBeDefined();
  });

  it('per-scope routes delete each scope’s blobs from ITS OWN backend', async () => {
    const backendLocal = new FileSyncObjectStore(tempDir('mem-api-sync-routes-local-'));
    const backendGlobal = new FileSyncObjectStore(tempDir('mem-api-sync-routes-global-'));
    const runEnv = deviceEnv();
    const local = MemoryStore.local(REPO, { env: runEnv, now: () => T0 });
    local.ensureManifest();
    const globalStore = MemoryStore.global({ env: runEnv, now: () => T0 });
    globalStore.ensureManifest();
    const api = new MemoryApi({
      stores: { local, global: globalStore },
      env: runEnv,
      now: () => T0,
    });
    void (await api.syncInit({ scope: 'local', deviceId: 'device-a', key: KEY }));
    void (await api.syncInit({ scope: 'global', deviceId: 'device-a', key: KEY }));
    const record = v1Pair().record;
    local.upsertEntry('active', record);
    globalStore.upsertEntry('records', record);
    // each scope pushed through its own backend (the misroute a shared route used to cause)
    void (await api.sync({ op: 'push', stores: ['local'], backend: backendLocal }));
    void (await api.sync({ op: 'push', stores: ['global'], backend: backendGlobal }));
    const evtLocal = deriveEventId('record.upsert', 'local', REPO, record);
    const evtGlobal = deriveEventId('record.upsert', 'global', undefined, record);
    expect((await backendLocal.listObjects('ev/')).keys).toContain(routeKeyFor(evtLocal, KEY));
    expect((await backendGlobal.listObjects('ev/')).keys).toContain(routeKeyFor(evtGlobal, KEY));

    const res = await api.purgeRecords([record.id], {
      actor: ACTOR,
      confirmIds: [record.id],
      routes: {
        local: { backend: backendLocal, syncKey: KEY },
        global: { backend: backendGlobal, syncKey: KEY },
      },
    });
    expect(res.ok).toBe(true);
    // each scope's blob deleted from the backend THAT scope's config names
    expect((await backendLocal.listObjects('ev/')).keys).not.toContain(routeKeyFor(evtLocal, KEY));
    expect((await backendGlobal.listObjects('ev/')).keys).not.toContain(
      routeKeyFor(evtGlobal, KEY),
    );
    // and the purge-ack recorded per scope, LAST (D4)
    expect(loadSyncState(local.rootDir)?.purgeAcks).toContain(evtLocal);
    expect(loadSyncState(globalStore.rootDir)?.purgeAcks).toContain(evtGlobal);
  });
});
