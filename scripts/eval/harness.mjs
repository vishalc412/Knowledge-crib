/**
 * The M1.1 retrieval-eval harness.
 *
 * For each language fixture repo under packages/parsers/fixtures/, build a fresh in-memory soul
 * via the real pipeline (`indexRepo` from @knowledge-crib/pipeline) — clustering and dossiers OFF
 * and the INFERRED semantic pass OFF so the result is 100% deterministic — then build an in-memory
 * sqlite index and score every golden pair (mechanically seeded + hand-curated conceptual) against
 * `index.query` directly. This is the pure BM25 retrieval path with no MCP/LLM `llmHits` fusion
 * (the verb layer would inject nondeterminism + token cost the eval must opt OUT of).
 *
 * Output: a report with per-language + overall recall@10 / MRR / nDCG@10, written to JSON for the
 * eval-check.mjs regression gate to compare against the committed baseline.
 *
 * Determinism notes:
 *  - Fixed `NOW` timestamp → stable commit stamps.
 *  - cluster:false → no nondeterministic `c:` cluster ids are produced (and we never template off
 *    them anyway; all expected ids are `sym:`/`route:`).
 *  - The fixture source is the committed ground truth; re-indexing yields byte-identical node ids
 *    (asserted by go-resolver / csharp-resolver tests), so the baseline is stable across runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPTUAL_PACKS } from './conceptual.mjs';
import { mean, scorePair } from './metrics.mjs';
import { seedGoldenPairs } from './seed.mjs';

/** Fixed commit timestamp so the soul + manifest stamps are identical across runs. */
const NOW = '2026-01-01T00:00:00.000Z';
/** Over-fetch well beyond the scored k=10 window so MRR/recall see the full ranked list. */
const QUERY_LIMIT = 50;
const K = 10;

/** The 9 fixture repos (8 language families; ts-min is an extra known-call-graph TS fixture). */
export const FIXTURE_LANGS = [
  'go',
  'python',
  'rust',
  'ts',
  'ts-min',
  'java',
  'php',
  'csharp',
  'plsql',
];

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the repo root (the dir holding pnpm-workspace.yaml) from the harness location. */
export function repoRoot() {
  // scripts/eval/harness.mjs → repo root is 3 levels up.
  return resolve(__dirname, '..', '..');
}

/** Default fixtures root. */
export function defaultFixturesRoot() {
  return join(repoRoot(), 'packages', 'parsers', 'fixtures');
}

/**
 * Dynamically import the built core + pipeline dist. release:verify builds every package (pretest)
 * before any gate runs, so these files exist at eval:check time. Resolved by path (like
 * budget-check.mjs) rather than by package name so the gate never depends on pnpm's root symlink.
 */
async function loadCore() {
  const root = repoRoot();
  const core = await import(resolve(root, 'packages', 'core', 'dist', 'index.js'));
  const pipeline = await import(resolve(root, 'packages', 'pipeline', 'dist', 'index.js'));
  return { core, pipeline };
}

/**
 * Resolve a conceptual pack's name-based match to concrete soul node ids.
 * Case-insensitive on `name`; optional `qualified` substring filters by qualifiedName for
 * disambiguation (e.g. "validate" on java → AuthController.validate vs BaseService.validate).
 */
export function resolveExpected(entry, soul) {
  const wantName = entry.match.name.toLowerCase();
  const wantQualified = entry.match.qualified?.toLowerCase();
  const ids = [];
  for (const node of soul.iterate('symbol')) {
    const name = (node.name ?? '').toLowerCase();
    if (name !== wantName) continue;
    if (wantQualified) {
      const q = (node.qualifiedName ?? '').toLowerCase();
      if (!q.includes(wantQualified)) continue;
    }
    ids.push(node.id);
  }
  return ids;
}

/**
 * Build a fresh in-memory soul + index for one fixture dir, run every golden pair, and return
 * per-language scores. Throws if the fixture produced zero golden pairs (a real wiring failure,
 * not a regression — surfaces a broken extractor or empty fixture loudly).
 */
export async function scoreFixture(lang, fixtureDir, core, pipeline) {
  const { SoulStore, SqliteIndexStore, newManifest } = core;
  const { indexRepo } = pipeline;

  const cribDir = mkdtempSync(join(tmpdir(), `crib-eval-${lang}-`));
  try {
    const soul = new SoulStore(cribDir, { manifest: newManifest({ now: NOW, root: '.' }) });
    soul.load();
    const index = new SqliteIndexStore(':memory:');
    await indexRepo(soul, fixtureDir, {
      now: NOW,
      index,
      dossiers: false,
      cluster: false,
      semantic: false,
    });

    const mechanical = seedGoldenPairs(soul, lang);
    const conceptual = CONCEPTUAL_PACKS.filter((p) => p.lang === lang).map((p) => {
      const expectedIds = resolveExpected(p, soul);
      return {
        id: `${lang}:conceptual:${p.question}`,
        template: 'conceptual',
        lang,
        question: p.question,
        expectedIds,
      };
    });
    // Drop conceptual pairs whose expected symbols the fixture's extractor didn't surface — a
    // missing expected set would silently score 0 and look like a retrieval failure. Log them so
    // the harness output names the gap (a future extractor fix then lifts coverage, not a false
    // regression).
    const unresolved = conceptual.filter((p) => p.expectedIds.length === 0);
    if (unresolved.length > 0) {
      for (const p of unresolved) {
        process.stderr.write(`  [${lang}] conceptual pack unresolved: "${p.question}"\n`);
      }
    }
    const conceptualResolved = conceptual.filter((p) => p.expectedIds.length > 0);

    const allPairs = [...mechanical, ...conceptualResolved];
    if (allPairs.length === 0) {
      throw new Error(`${lang}: fixture produced 0 golden pairs — extractor or fixture is broken`);
    }

    const recalls = [];
    const mrrs = [];
    const ndcgs = [];
    for (const pair of allPairs) {
      const hits = index.query({ text: pair.question, limit: QUERY_LIMIT });
      const retrieved = hits.map((h) => h.id);
      const s = scorePair(retrieved, pair.expectedIds, K);
      recalls.push(s.recall);
      mrrs.push(s.mrr);
      ndcgs.push(s.ndcg);
    }

    index.close();
    return {
      lang,
      pairs: allPairs.length,
      mechanical: mechanical.length,
      conceptual: conceptualResolved.length,
      conceptualUnresolved: unresolved.length,
      recall10: mean(recalls),
      mrr: mean(mrrs),
      ndcg10: mean(ndcgs),
    };
  } finally {
    rmSync(cribDir, { recursive: true, force: true });
  }
}

/**
 * Run the full eval across every fixture language. Returns the report object (no I/O).
 * @param {string} [fixturesRoot] override (tests); defaults to packages/parsers/fixtures.
 */
export async function runEval(fixturesRoot = defaultFixturesRoot()) {
  const { core, pipeline } = await loadCore();
  const perLang = {};
  for (const lang of FIXTURE_LANGS) {
    const fixtureDir = join(fixturesRoot, lang);
    process.stdout.write(`  eval: ${lang} ...`);
    const r = await scoreFixture(lang, fixtureDir, core, pipeline);
    perLang[lang] = r;
    process.stdout.write(
      ` pairs=${r.pairs} (mech=${r.mechanical} concept=${r.conceptual})  ` +
        `R@10=${r.recall10.toFixed(3)} MRR=${r.mrr.toFixed(3)} nDCG@10=${r.ndcg10.toFixed(3)}\n`,
    );
  }

  const allPairCounts = Object.values(perLang).map((r) => r.pairs);
  const totalPairs = allPairCounts.reduce((a, b) => a + b, 0);
  // Macro-average across languages (each language weighted equally), so a tiny fixture like
  // ts-min can't be drowned out by a large one like csharp.
  const overall = {
    recall10: mean(Object.values(perLang).map((r) => r.recall10)),
    mrr: mean(Object.values(perLang).map((r) => r.mrr)),
    ndcg10: mean(Object.values(perLang).map((r) => r.ndcg10)),
    pairs: totalPairs,
  };
  return { perLang, overall };
}

/** CLI entry: write the report JSON to the path in argv[2] (or stdout if omitted). */
export async function main() {
  const outPath = process.argv[2];
  const report = await runEval();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outPath, json);
    process.stdout.write(`\nwrote eval report to ${outPath}\n`);
  } else {
    process.stdout.write(`\n${json}`);
  }
}

// run when invoked directly (`node scripts/eval/harness.mjs [out.json]`), not when imported.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, 'harness.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`\neval harness failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
