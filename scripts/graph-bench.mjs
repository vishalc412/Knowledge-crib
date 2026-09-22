#!/usr/bin/env node
/**
 * WP-G8 — graph performance at launch scale (plan §4 "Local performance" and "Update latency").
 *
 *   node scripts/graph-bench.mjs --out <report.json> [--assertions 100000] [--records 5000]
 *
 * Builds ONE principal's graph of `--assertions` assertions over `--records` admitted records in a
 * real local store (a temp memory home), then measures through the shipped `memory_graph` verb:
 *
 *   - warm bounded read   — `neighbors` from an explicit ref at the default two hops;
 *   - context assembly    — `context` from a lexical query (model execution excluded: no embedder,
 *                           exactly the plan's "excluding model execution");
 *   - update latency      — one admitted assertion submitted, timed until `neighbors` returns it.
 *
 * Every sample is recorded; p50/p95 are computed from the samples, never estimated. The script
 * applies no threshold — the report states the plan's targets beside the measurements.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SoulStore, SqliteIndexStore, newManifest } from '../packages/core/dist/index.js';
import { Verbs } from '../packages/mcp/dist/index.js';
import {
  MemoryStore,
  __resetMemoryLockGuardForTest,
  createGraphAssertion,
  memoryRecordId,
} from '../packages/memory/dist/index.js';

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (!out) {
  process.stderr.write(
    'usage: node scripts/graph-bench.mjs --out <report.json> [--assertions N] [--records N]\n',
  );
  process.exit(2);
}
const ASSERTIONS = flag('--assertions', 100_000);
const RECORDS = flag('--records', 5_000);
const WARMUP = 3;
const SAMPLES = 30;
const UPDATE_SAMPLES = 10;
const NOW = '2026-09-17T00:00:00.000Z';
const PRINCIPAL = 'principal:bench';
const REPO_ID = 'graph-bench';
const PREDICATES = ['about', 'applies-to', 'affects', 'part-of', 'derived-from', 'supported-by'];

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const summary = (samples) => ({
  samples: samples.length,
  p50Ms: percentile(samples, 50),
  p95Ms: percentile(samples, 95),
  maxMs: Math.max(...samples),
});

const work = mkdtempSync(join(tmpdir(), 'crib-graph-bench-'));
const previous = { principal: process.env.KCRIB_PRINCIPAL_ID, home: process.env.KCRIB_MEMORY_DIR };
try {
  process.env.KCRIB_PRINCIPAL_ID = PRINCIPAL;
  process.env.KCRIB_MEMORY_DIR = join(work, 'home');
  __resetMemoryLockGuardForTest();
  const env = process.env;
  const repoRoot = join(work, 'repo');
  mkdirSync(join(repoRoot, '.crib'), { recursive: true });
  const soul = new SoulStore(join(repoRoot, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.commit(NOW);
  writeFileSync(
    join(repoRoot, '.crib', 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID } })}\n`,
  );
  const index = new SqliteIndexStore();
  index.buildFromSoul(soul, repoRoot);
  const local = MemoryStore.local(REPO_ID, { env, now: () => NOW, repoRoot });

  // ── build: admitted records, then assertions over them ─────────────────────
  const setupStart = performance.now();
  const records = [];
  for (let i = 0; i < RECORDS; i += 1) {
    const input = {
      kind: 'fact',
      subject: `topic:area-${i % 250}`,
      claim: `Component ${i} in area ${i % 250} retries idempotent ledger writes batch ${i}`,
      scope: { boundary: 'repo', repoId: REPO_ID },
      appliesTo: [`topic:area-${i % 250}`],
      evidence: [
        {
          kind: 'committed-policy',
          verdict: 'valid',
          checkedAt: NOW,
          artifactId: `artifact:docs/area-${i % 250}.md`,
          anchor: `docs/area-${i % 250}.md`,
        },
      ],
      authorship: { actor: 'bench', kind: 'agent', tool: 'graph-bench' },
    };
    records.push({
      id: memoryRecordId(input),
      schemaVersion: '1',
      ...input,
      verdicts: {
        trust: 'local',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
      createdAt: NOW,
    });
  }
  local.upsertEntries('active', records);
  const provenance = {
    principalId: PRINCIPAL,
    deviceId: 'device:bench',
    actorId: 'agent:bench',
    clientId: 'graph-bench',
  };
  const edge = (i) => {
    const record = records[i % RECORDS];
    return createGraphAssertion({
      predicate: PREDICATES[i % PREDICATES.length],
      subject: record.id,
      object: `sym:src/module-${i % 20_000}.ts#fn${i % 7}`,
      namespace: { principalId: PRINCIPAL, projectId: REPO_ID },
      scope: { boundary: 'repo', repoId: REPO_ID },
      validAt: NOW,
      knownAt: NOW,
      supportedBy: [record.id],
      provenance,
    });
  };
  const BATCH = 5_000;
  for (let start = 0; start < ASSERTIONS; start += BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(ASSERTIONS, start + BATCH); i += 1) batch.push(edge(i));
    local.submitGraphEntries(batch);
  }
  const setupMs = performance.now() - setupStart;

  const verbs = new Verbs({ soul, index, repoRoot, memory: { local } });
  const time = (fn) => {
    const t0 = performance.now();
    const result = fn();
    return { ms: performance.now() - t0, result };
  };

  // ── warm bounded read ──────────────────────────────────────────────────────
  const seedRef = records[17].id;
  const readSamples = [];
  let lastRead;
  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    const { ms, result } = time(() =>
      verbs.memoryConnectedGraph({ op: 'neighbors', refs: [seedRef], scope: 'repo' }),
    );
    if (i >= WARMUP) readSamples.push(ms);
    lastRead = result;
  }

  // ── context assembly (model execution excluded) ────────────────────────────
  const contextSamples = [];
  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    const { ms } = time(() =>
      verbs.memoryConnectedGraph({
        op: 'context',
        q: `area ${i % 250} idempotent ledger retries`,
        scope: 'repo',
      }),
    );
    if (i >= WARMUP) contextSamples.push(ms);
  }

  // ── update latency: submit → visible through the serving verb ──────────────
  const updateSamples = [];
  for (let i = 0; i < UPDATE_SAMPLES; i += 1) {
    const target = `sym:src/fresh-${i}.ts#fresh`;
    const fresh = createGraphAssertion({
      predicate: 'applies-to',
      subject: seedRef,
      object: target,
      namespace: { principalId: PRINCIPAL, projectId: REPO_ID },
      scope: { boundary: 'repo', repoId: REPO_ID },
      validAt: NOW,
      knownAt: NOW,
      supportedBy: [seedRef],
      provenance,
    });
    const t0 = performance.now();
    local.submitGraphEntries([fresh]);
    let visible = false;
    while (!visible && performance.now() - t0 < 30_000) {
      const res = verbs.memoryConnectedGraph({
        op: 'neighbors',
        refs: [seedRef],
        hops: 1,
        scope: 'repo',
        maxTokens: 20_000,
      });
      visible = JSON.stringify(res).includes(target);
    }
    updateSamples.push(visible ? performance.now() - t0 : Number.POSITIVE_INFINITY);
  }

  const report = {
    format: 'knowledge-crib-graph-bench',
    formatVersion: 1,
    recordedAt: new Date().toISOString(),
    host: {
      platform: platform(),
      cpus: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    scale: { assertions: ASSERTIONS, records: RECORDS },
    setupMs,
    warmRead: { ...summary(readSamples), targetP95Ms: 500, op: 'neighbors (2 hops, explicit ref)' },
    contextAssembly: {
      ...summary(contextSamples),
      targetP95Ms: 1000,
      op: 'context (lexical seeds, no model)',
    },
    updateLatency: {
      ...summary(updateSamples),
      targetP95Ms: 2000,
      op: 'submit one assertion → visible via neighbors',
    },
    sanity: {
      readReturnedExpansions: Array.isArray(lastRead?.expansions) ? lastRead.expansions.length : 0,
    },
  };
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  index.close();
} finally {
  if (previous.principal === undefined) Reflect.deleteProperty(process.env, 'KCRIB_PRINCIPAL_ID');
  else process.env.KCRIB_PRINCIPAL_ID = previous.principal;
  if (previous.home === undefined) Reflect.deleteProperty(process.env, 'KCRIB_MEMORY_DIR');
  else process.env.KCRIB_MEMORY_DIR = previous.home;
  rmSync(work, { recursive: true, force: true });
}
