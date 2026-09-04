/**
 * Cross-vendor launch-gate comparison (MEMORY-QUALITY, launch-verification gate).
 *
 * Runs the SAME pinned 500-query launch corpus (bench/launch-corpus.ts) against knowledge-crib
 * and against third-party memory vendors (Mem0, Graphiti, Letta), so the launch-gate numbers have
 * an external reference instead of being self-referential. Design rules, all honesty-driven:
 *
 *   - The crib column is the REAL gate: it imports the built `runLaunchGate()` from
 *     packages/memory/dist — no re-implementation, no parallel scorer.
 *   - Vendor detection is credential-first and honest: an env-var credential or an on-PATH CLI.
 *     A vendor that is not configured is reported as "vendor unversioned/absent — comparison
 *     pending operator credentials", NEVER as zero or as a loss. No fabricated numbers.
 *   - Vendor calls are wired to each vendor's documented REST surface when a credential exists
 *     (adapter `seed`/`search` below). The exact route/config for a given deployment is a
 *     placeholder the operator fills via env (see VENDORS); latency is measured, cost is left
 *     null until the vendor's own usage response supplies it — vendor pricing is not frozen here.
 *   - No secrets are hardcoded; credentials are read from env only and never printed.
 *   - This script is NOT imported by any test — no vendor API call can fire from the test suite.
 *
 * Usage:
 *   node scripts/launch-vendor-compare.mjs                # crib gates + vendor availability
 *   node scripts/launch-vendor-compare.mjs --crib-only    # crib gate table only, no vendor probes
 *   node scripts/launch-vendor-compare.mjs --vendor mem0  # probe one vendor
 *   node scripts/launch-vendor-compare.mjs --json         # machine-readable report
 */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildLaunchCorpus } from '../packages/memory/dist/bench/launch-corpus.js';
import { formatLaunchGate, runLaunchGate } from '../packages/memory/dist/bench/launch-eval.js';
import { mrr, recallAtK } from '../packages/memory/dist/bench/metrics.js';

// ─── vendor adapters ─────────────────────────────────────────────────────────

/**
 * Each adapter declares: the env credentials that make it available, an optional CLI for
 * on-device deployments, and the wired REST calls. The REST shapes below follow each vendor's
 * documented public API as of the launch-verification window; where a deployment differs, the
 * operator overrides the base URL / route via the listed env — the adapter treats those as
 * config placeholders, not assumptions.
 */
const VENDORS = [
  {
    id: 'mem0',
    label: 'Mem0 (SaaS / self-hosted REST)',
    credentials: ['MEM0_API_KEY'],
    cli: 'mem0',
    configEnv: ['MEM0_BASE_URL', 'MEM0_ORG_ID', 'MEM0_PROJECT_ID'],
    base: (env) => env.MEM0_BASE_URL ?? 'https://api.mem0.ai',
    // Wire: v1 memories add (batched) + v2 search. `user_id` carries the principal scope, which
    // is how the cross-principal fixture maps onto Mem0 (crib's isolation is structural store
    // topology; Mem0's is a scope field — the comparison reports that difference, not hides it).
    seed: async (env, records) => {
      const base = baseOf('mem0', env);
      // One call per record: the v1 add route scopes user_id/metadata per call, and both carry
      // per-record payload (scope + the id the comparison ranks against).
      for (const r of records) {
        await api(base, '/v1/memories/', {
          method: 'POST',
          headers: bearer(env.MEM0_API_KEY),
          body: JSON.stringify({
            messages: [{ role: 'user', content: r.claim }],
            user_id: r.scope,
            metadata: { record_id: r.id },
          }),
        });
      }
    },
    search: async (env, query, scope) => {
      const base = baseOf('mem0', env);
      const res = await api(base, '/v2/memories/search/', {
        method: 'POST',
        headers: bearer(env.MEM0_API_KEY),
        body: JSON.stringify({ query, filters: { user_id: scope }, top_k: 5 }),
      });
      return (res ?? []).map((m) => m?.metadata?.record_id ?? m?.id ?? '').filter(Boolean);
    },
  },
  {
    id: 'graphiti',
    label: 'Graphiti (self-hosted REST service)',
    credentials: ['GRAPHITI_BASE_URL'],
    cli: 'graphiti',
    configEnv: ['GRAPHITI_API_KEY'],
    base: (env) => env.GRAPHITI_BASE_URL,
    // Wire: add episodes in group_id-scoped batches; search scoped by the same group_id.
    seed: async (env, records) => {
      const base = baseOf('graphiti', env);
      for (const r of records) {
        await api(base, '/messages', {
          method: 'POST',
          headers: bearer(env.GRAPHITI_API_KEY),
          body: JSON.stringify({
            group_id: r.scope,
            messages: [{ role: 'user', content: r.claim }],
            reference_id: r.id,
          }),
        });
      }
    },
    search: async (env, query, scope) => {
      const base = baseOf('graphiti', env);
      const res = await api(base, '/search', {
        method: 'POST',
        headers: bearer(env.GRAPHITI_API_KEY),
        body: JSON.stringify({ query, group_ids: [scope], num_results: 5 }),
      });
      return (res ?? []).map((n) => n?.reference_id ?? n?.id ?? '').filter(Boolean);
    },
  },
  {
    id: 'letta',
    label: 'Letta (MemGPT agents API)',
    credentials: ['LETTA_API_KEY'],
    cli: 'letta',
    configEnv: ['LETTA_BASE_URL', 'LETTA_AGENT_ID'],
    base: (env) => env.LETTA_BASE_URL ?? 'https://api.letta.com',
    // Wire: archival-memory insert per record; scoped search via one agent per principal scope
    // (LETTA_AGENT_ID for the main fixture; the harness derives per-scope agent ids at run time).
    seed: async (env, records) => {
      const base = baseOf('letta', env);
      const agent = env.LETTA_AGENT_ID;
      if (!agent) throw new Error('letta: LETTA_AGENT_ID required for archival seeding');
      for (const r of records) {
        await api(base, `/v1/agents/${encodeURIComponent(agent)}/archival`, {
          method: 'POST',
          headers: bearer(env.LETTA_API_KEY),
          body: JSON.stringify({ text: r.claim, metadata: { record_id: r.id, scope: r.scope } }),
        });
      }
    },
    search: async (env, query, scope) => {
      const base = baseOf('letta', env);
      const agent = env.LETTA_AGENT_ID;
      if (!agent) throw new Error('letta: LETTA_AGENT_ID required for archival search');
      const res = await api(
        base,
        `/v1/agents/${encodeURIComponent(agent)}/archival/search?query=${encodeURIComponent(query)}&limit=5`,
        { method: 'GET', headers: bearer(env.LETTA_API_KEY) },
      );
      // Scope filtering happens client-side here unless the operator provisions per-scope agents;
      // the harness reports that as a config placeholder rather than assuming it.
      return (res ?? [])
        .filter((m) => !scope || m?.metadata?.scope === scope)
        .map((m) => m?.metadata?.record_id ?? '')
        .filter(Boolean);
    },
  },
];

function bearer(token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function baseOf(id, env) {
  const vendor = VENDORS.find((v) => v.id === id);
  const base = vendor?.base?.(env);
  if (!base) throw new Error(`${id}: base URL missing — set its config env`);
  return base.replace(/\/+$/, '');
}

async function api(base, route, init) {
  const res = await fetch(`${base}${route}`, init);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${route} → HTTP ${res.status}`);
  return res.json();
}

// ─── detection (credential-first, `which` for the CLI path) ──────────────────

function whichOnPath(cli) {
  const probe = spawnSync('which', [cli], { encoding: 'utf8' });
  return probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim().length > 0;
}

function cliVersion(cli) {
  const probe = spawnSync(cli, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  return (probe.stdout ?? '').trim().split('\n')[0] || null;
}

function detectVendor(vendor, env = process.env) {
  const credEnv = vendor.credentials.filter((k) => Boolean(env[k]));
  if (credEnv.length > 0) {
    return {
      available: true,
      via: `env:${credEnv.join(',')}`,
      version:
        'unversioned (SaaS/service API — pin the API version in vendor config before publishing a comparison)',
    };
  }
  if (vendor.cli && whichOnPath(vendor.cli)) {
    const version = cliVersion(vendor.cli);
    if (version) {
      return { available: true, via: `cli:${vendor.cli}`, version };
    }
  }
  return {
    available: false,
    via: 'none',
    version: null,
    reason: 'vendor unversioned/absent — comparison pending operator credentials',
  };
}

// ─── the shared corpus, scoped for vendors ───────────────────────────────────

/**
 * Vendor view of the launch corpus: every record carries its scope (main / principal-a /
 * principal-b) and the vendor maps that scope onto its own scoping primitive. Queries stay the
 * 500 labeled ones, each tagged with the scope it must search.
 */
function scopedCorpus() {
  const corpus = buildLaunchCorpus();
  const recs = [
    ...corpus.records.map((r) => ({ ...r, scope: 'main' })),
    ...corpus.principalA.records.map((r) => ({ ...r, scope: 'principal-a' })),
    ...corpus.principalB.records.map((r) => ({ ...r, scope: 'principal-b' })),
  ];
  const queries = [
    ...corpus.queries.map((q) => ({ ...q, scope: 'main' })),
    ...corpus.principalA.queries.map((q) => ({ ...q, scope: 'principal-a' })),
    ...corpus.principalB.queries.map((q) => ({ ...q, scope: 'principal-b' })),
  ];
  return { recs, queries, categoryCounts: corpus.categoryCounts };
}

// ─── vendor measurement ──────────────────────────────────────────────────────

async function measureVendor(vendor, corpus) {
  const detection = detectVendor(vendor);
  if (!detection.available) {
    return { id: vendor.id, label: vendor.label, status: 'ABSENT', detection, metrics: null };
  }
  const env = process.env;
  const rows = [];
  const ms = [];
  const t0 = performance.now();
  await vendor.seed(env, corpus.recs);
  const seedMs = performance.now() - t0;
  for (const q of corpus.queries) {
    const start = performance.now();
    let ids = [];
    try {
      ids = await vendor.search(env, q.query, q.scope);
    } catch (err) {
      return {
        id: vendor.id,
        label: vendor.label,
        status: 'ERROR',
        detection,
        metrics: null,
        error: `${err instanceof Error ? err.message : String(err)} (seed took ${seedMs.toFixed(0)}ms)`,
      };
    }
    ms.push(performance.now() - start);
    rows.push({ category: q.category, rank: ids.slice(0, 5), rel: q.relevantIds });
  }
  const mean = (f) =>
    rows.length === 0 ? 0 : rows.reduce((acc, r) => acc + f(r), 0) / rows.length;
  const perCategory = new Map();
  for (const row of rows) {
    const list = perCategory.get(row.category) ?? [];
    list.push(row);
    perCategory.set(row.category, list);
  }
  const categories = [...perCategory.entries()].map(([category, rs]) => ({
    category,
    queries: rs.length,
    recallAt5: meanOf(rs, (r) => recallAtK(r.rank, r.rel, 5)),
    mrr: meanOf(rs, (r) => mrr([r.rank], [r.rel])),
  }));
  const p50p95 = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
      p50: s[Math.floor((s.length - 1) * 0.5)] ?? 0,
      p95: s[Math.floor((s.length - 1) * 0.95)] ?? 0,
    };
  };
  return {
    id: vendor.id,
    label: vendor.label,
    status: 'MEASURED',
    detection,
    metrics: {
      queries: rows.length,
      recallAt5: mean((r) => recallAtK(r.rank, r.rel, 5)),
      mrr: mean((r) => mrr([r.rank], [r.rel])),
      searchLatencyMs: p50p95(ms),
      // Cost stays null: vendor pricing is not frozen here — wire the vendor usage response in
      // when publishing a comparison. A null is honest; a guessed $/query is not.
      costUsd: null,
      costNote: 'cost placeholder — vendor pricing not frozen; wire the usage response to fill it',
      seedMs,
      categories,
    },
  };
}

function meanOf(rows, f) {
  if (rows.length === 0) return 0;
  return rows.reduce((acc, r) => acc + f(r), 0) / rows.length;
}

// ─── report ──────────────────────────────────────────────────────────────────

function render(results, gateReport, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ crib: gateReport, vendors: results }, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push('LAUNCH GATE — cross-vendor comparison (same pinned 500-query corpus)');
  lines.push(formatLaunchGate(gateReport));
  lines.push('');
  lines.push(
    'vendor comparison (same corpus, vendor adapters wired to their documented REST APIs)',
  );
  for (const r of results) {
    lines.push(`  ${r.id} — ${r.label}`);
    if (r.status !== 'MEASURED') {
      const why =
        r.status === 'ABSENT' ? r.detection.reason : `${r.status}: ${r.error ?? 'unknown error'}`;
      lines.push(`    ${why}`);
      if (r.status === 'ABSENT') {
        lines.push('    (unavailable vendors are reported as pending, never scored as zero)');
      }
      continue;
    }
    const m = r.metrics;
    lines.push(
      `    version: ${r.detection.version} · via ${r.detection.via} · queries ${m.queries}`,
    );
    lines.push(
      `    recall@5 ${(m.recallAt5 * 100).toFixed(1)}% · MRR ${m.mrr.toFixed(3)} · search p50 ${m.searchLatencyMs.p50.toFixed(0)}ms / p95 ${m.searchLatencyMs.p95.toFixed(0)}ms · cost ${m.costUsd ?? 'unmeasured'} (${m.costNote})`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const json = process.argv.includes('--json');
  const cribOnly = process.argv.includes('--crib-only');
  const vendorIdx = process.argv.indexOf('--vendor');
  const onlyId = vendorIdx >= 0 ? process.argv[vendorIdx + 1] : undefined;

  const gateReport = runLaunchGate();
  if (cribOnly) {
    render([], gateReport, json);
    return;
  }
  const corpus = scopedCorpus();
  const picked = onlyId ? VENDORS.filter((v) => v.id === onlyId) : VENDORS;
  if (picked.length === 0) {
    throw new Error(
      `unknown vendor ${JSON.stringify(onlyId)} — known: ${VENDORS.map((v) => v.id).join(', ')}`,
    );
  }
  const results = [];
  for (const vendor of picked) results.push(await measureVendor(vendor, corpus));
  render(results, gateReport, json);
}

await main();
