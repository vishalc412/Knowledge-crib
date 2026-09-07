// Audit reproductions only. Run from repository root after building the workspace.
// All stores, service definitions, and child processes are isolated to a temporary directory.
import { fork, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const load = (path) => import(pathToFileURL(resolve(repo, path)).href);
const mem = await load('packages/memory/dist/index.js');
const core = await load('packages/core/dist/index.js');
const service = await load('packages/cli/dist/freshness-service.js');
const root = mkdtempSync(join(tmpdir(), 'crib-reaudit-behavior-'));
const report = { format: 'knowledge-crib-reaudit-behavior', generatedAt: new Date().toISOString() };
const children = [];
try {
  const env = { ...process.env, KCRIB_MEMORY_DIR: join(root, 'memory'), KCRIB_REGISTRY_DIR: join(root, 'registry'), KCRIB_PRINCIPAL_ID: 'principal:local' };
  const local = mem.MemoryStore.local('audit-migration', { env });
  const subject = 'sym:src/a.ts#deploy';
  const seed = {
    kind: 'fact', subject, claim: 'Deployment requires a signed artifact',
    scope: { boundary: 'repo', repoId: 'audit-migration' }, appliesTo: [subject],
    evidence: [{ kind: 'source-quote', verdict: 'valid', checkedAt: '2026-09-05T00:00:00.000Z', soulId: subject, quote: 'requires a signed artifact', targetHash: `blake3:${'a'.repeat(64)}` }],
    authorship: { actor: 'fixture', kind: 'agent', tool: 'audit' },
  };
  const record = { ...seed, id: mem.memoryRecordId(seed), schemaVersion: '1', createdAt: '2026-09-05T00:00:00.000Z', verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' } };
  local.upsertEntry('active', record);
  const missingSource = { getNode: () => undefined, rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }), findByLocator: () => [] };
  const api = new mem.MemoryApi({ stores: { local }, env, evaluator: new mem.MemoryEvaluator(), evalCtx: { soul: missingSource } });
  const before = api.search('Deployment', { fresh: true });
  const migration = local.migrateToV2({});
  const after = api.search('Deployment', { fresh: true });
  report.migratedSourceFreshness = {
    condition: 'Referenced source symbol is absent in both searches; same evidence and trust before/after supported migration',
    beforeHits: before.hits.length,
    migratedCount: migration.migrated.length,
    afterHits: after.hits.map((h) => ({ schemaVersion: h.schemaVersion, verdicts: h.verdicts, freshness: h.freshness })),
  };
  const v3seed = { kind: 'fact', subject: 'topic:v3-native', propositionKey: mem.derivePropositionKey({ subject: 'topic:v3-native' }), claim: 'Native v3 signed deployment rule', evidence: seed.evidence };
  const namespace = { principalId: 'principal:local', projectId: 'audit-migration' };
  const native = { ...v3seed, id: mem.memoryRecordV3Id({ ...v3seed, namespace }), schemaVersion: '3', namespace, visibility: 'private', validTime: { from: '2026-09-05T00:00:00.000Z' }, transactionTime: { observedAt: '2026-09-05T00:00:00.000Z', recordedAt: '2026-09-05T00:00:00.000Z' }, provenance: { principalId: 'principal:local', deviceId: 'audit', actorId: 'audit', clientId: 'audit' }, lineage: {}, sensitivity: 'internal', retentionPolicyId: 'ret:default' };
  local.upsertEntry('active', native);
  const nativeResult = api.get(native.id);
  report.nativeV3 = { getFound: nativeResult.found, verdicts: nativeResult.verdicts, exactSubjectReturnsRecord: api.search(native.subject, { fresh: false }).hits.some((h) => h.id === native.id), interpretation: 'A native v3 active-store record is still candidate-trust without a migration alias; no-throw search does not prove recall/admission support.' };

  const hookRepo = join(root, 'hook-repo');
  const cribDir = join(hookRepo, '.crib');
  mkdirSync(cribDir, { recursive: true });
  const soul = new core.SoulStore(cribDir, { manifest: core.newManifest({ root: '.' }) });
  soul.load(); soul.commit('2026-09-05T00:00:00.000Z');
  writeFileSync(join(cribDir, 'crib.json'), JSON.stringify({ repo: { id: 'audit-hook', root: '.' } }));
  const hook = (payload) => {
    const result = spawnSync(process.execPath, [resolve(repo, 'packages/cli/dist/cli.js'), 'memory', 'capture-hook', '--event', 'turn-end'], { cwd: hookRepo, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
    return { exitCode: result.status, acknowledgment: result.stdout.trim() ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : null };
  };
  const ordinary = hook({ session_id: 'audit-session', tool_name: 'Edit' });
  const hookStore = mem.MemoryStore.local('audit-hook', { repoRoot: hookRepo, env });
  report.ordinaryHook = { ...ordinary, candidates: hookStore.readCollection('candidates').entries.length, pendingCaptures: mem.pendingCaptures(hookStore).length, intakes: hookStore.readCollection('intakes').entries.length };
  const firstOutcome = hook({ session_id: 'audit-session', knowledge_crib_outcome: { result: 'First separate meaningful result.' } });
  const secondOutcome = hook({ session_id: 'audit-session', knowledge_crib_outcome: { result: 'Second separate meaningful result.' } });
  report.outcomesWithoutOffsets = { firstOutcome, secondOutcome, pendingCaptures: mem.pendingCaptures(hookStore).length, candidates: hookStore.readCollection('candidates').entries.length };

  const opts = { userHome: join(root, 'service-home'), nodePath: '/opt/node/bin/node', cliPath: '/home/user/My Project/crib/bin.js', registryDir: join(root, 'service-registry'), uid: 501 };
  const linux = service.freshnessServiceSpec({ ...opts, platform: 'linux' });
  const windows = service.freshnessServiceSpec({ ...opts, platform: 'win32' });
  const darwin = service.freshnessServiceSpec({ ...opts, platform: 'darwin' });
  mkdirSync(resolve(darwin.path, '..'), { recursive: true });
  writeFileSync(darwin.path, darwin.content);
  const reported = service.queryFreshnessService({ ...opts, platform: 'darwin', run: () => 'state = not running\nlast exit code = 1' });
  report.services = { linuxExecStart: linux.content.split('\n').find((line) => line.startsWith('ExecStart')), windowsDeclaresUTF16ButWriterUsesUTF8: windows.content.includes('encoding="UTF-16"'), windowsContainsRegistryOverride: windows.content.includes(opts.registryDir), macStatusForRegisteredStoppedJob: { installed: reported.installed, active: reported.active }, qualification: 'Generated definitions and injected manager output; not native Linux/Windows installation acceptance.' };

  const childPath = join(root, 'worker-child.mjs');
  const workerUrl = pathToFileURL(resolve(repo, 'packages/cli/dist/freshness.js')).href;
  writeFileSync(childPath, `import { FreshnessWorker } from ${JSON.stringify(workerUrl)};\nprocess.send({ready:true});\nprocess.on('message', async ({registry}) => { const worker = new FreshnessWorker({env:{KCRIB_REGISTRY_DIR:registry}, revalidate:async()=>({generation:'audit'}), pollMs:10000, heartbeatMs:10000}); try { await worker.start(); process.send({started:true,pid:process.pid}); } catch(error) { process.send({started:false,error:error.message}); } });\n`);
  report.workerElection = [];
  for (let trial = 0; trial < 12; trial++) {
    const group = Array.from({ length: 8 }, () => fork(childPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    children.push(...group);
    await Promise.all(group.map((child) => new Promise((done) => child.once('message', done))));
    const responses = group.map((child) => new Promise((done) => child.once('message', done)));
    for (const child of group) child.send({ registry: join(root, `election-${trial}`) });
    const results = await Promise.all(responses);
    report.workerElection.push({ trial, contenders: group.length, accepted: results.filter((r) => r.started).length });
    await Promise.all(group.map((child) => new Promise((done) => { child.once('exit', done); child.kill('SIGKILL'); })));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
