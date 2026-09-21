#!/usr/bin/env node
/**
 * Code-retrieval gate for the VECTOR channel — does `crib index --vectors` actually retrieve better?
 *
 * Why this exists. The vector path (brute-force cosine fused with BM25 by RRF, then the deterministic
 * structural prior in `index/rerank.ts`) shipped unreachable: no production call site passed an
 * embedder, and the metadata that authorizes reading vectors was in-memory only, so every reopen fell
 * back to BM25 over a fully populated `vectors` table. Making it reachable is not the same as making
 * it better, and the audit that found it (docs/audits/2026-09-20) recorded a NEGATIVE result: with the
 * channel confirmed live, three paraphrase probes were no better, because the embedded text was
 * surface fields only. This harness is what turns that from an anecdote into a number.
 *
 * What it measures. The SAME labelled corpus `semantic-retrieval-eval.mjs` uses — questions an
 * engineer actually asks, each paired with every file that legitimately answers it, written by reading
 * the code and not by reading a ranking — scored through two index configurations that differ only in
 * whether an embedder is attached:
 *
 *   lexical : SqliteIndexStore(path)                  → pure FTS5 BM25 (the shipped default)
 *   hybrid  : SqliteIndexStore(path, { embedder })    → BM25 ∪ cosine, RRF-fused, then reranked
 *
 * Both read the SAME sqlite file, so nothing but the retrieval path varies. The index must have been
 * built with `crib index --vectors`; without vectors the hybrid column is identical to the lexical one
 * by construction and the script says so rather than reporting a tie as a result.
 *
 * What it does NOT measure, stated because the omission matters. It does not isolate the contribution
 * of BODY text (vectorText v2) from the contribution of having vectors at all: producing v1 vectors
 * would need a second embedding recipe kept alive in production code purely for this harness, which is
 * a worse trade than reporting the ceiling honestly. The v1 evidence is the three probes in the audit,
 * all of which missed. It also inherits the corpus's limits — 22 questions, one repository, authored by
 * someone who knows the codebase — so it is a regression gate, not an external benchmark.
 *
 * Usage:
 *   node scripts/eval/code-vector-eval.mjs [--min-mrr 0] [--json] [--limit 10]
 *
 * Exits non-zero only when `--min-mrr` is supplied and the hybrid MRR falls below it, so the default
 * run reports and never fails a build on a number that has no pre-registered floor yet.
 */
import {
  loadInstalledEmbedder,
  SoulStore,
  SqliteIndexStore,
} from '../../packages/core/dist/index.js';

const R = process.cwd();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const LIMIT = flag('--limit', 10);
const MIN_MRR = args.includes('--min-mrr') ? flag('--min-mrr', 0) : undefined;
const AS_JSON = args.includes('--json');

/**
 * The labelled corpus. Kept IDENTICAL to `semantic-retrieval-eval.mjs`'s cases on purpose: two gates
 * disagreeing about what the right answer is would make both unreadable, and a corpus edited to suit
 * one ranker is the test-set-selection failure this repository's pre-registration discipline exists to
 * prevent. Each entry lists every file that legitimately answers the question.
 */
const CASES = [
  [
    'how do I debug a parser that hangs',
    ['fuzz/extractor-fuzz.ts', 'fuzz/fuzz-worker.ts', 'fuzz-check.mjs'],
  ],
  ['why is there no native hashing dependency', ['soul-schema/src/hash.ts']],
  ['what stops two indexing runs corrupting each other', ['core/src/lock.ts']],
  [
    'how do I add a new language',
    [
      'parsers/src/types.ts',
      'parsers/src/registry.ts',
      'extractor-plugins.md',
      'resolver-registry.ts',
    ],
  ],
  [
    'what stops a secret being indexed',
    [
      'core/src/source-policy.ts',
      'mcp/src/secrets.ts',
      'memory/src/secrets.ts',
      'mule/descriptors.ts',
    ],
  ],
  ['how is a claim proven against real code', ['mcp/src/grounding.ts', 'memory/src/grounding.ts']],
  [
    'what makes re-indexing byte identical',
    [
      'core/src/soul-store.ts',
      'parallel-check.mjs',
      'soul-refresh-check.mjs',
      'memory/src/serialization.ts',
    ],
  ],
  ['how does a memory survive a refactor', ['memory/src/locator.ts']],
  [
    'what decides which memory the team trusts',
    [
      'memory/src/policy.ts',
      'memory/src/trusted-ref.ts',
      'memory/src/gate-runner.ts',
      'memory/src/promotion.ts',
    ],
  ],
  [
    'how does blast radius cross repositories',
    ['core/src/federation.ts', 'ts/http-client.ts', 'federation-check.mjs'],
  ],
  ['why is a response never unbounded', ['mcp/src/token-budget.ts', 'budget-check.mjs']],
  [
    'how are business rules derived from branches',
    ['core/src/rules/extract.ts', 'cfg/guard-chain.ts', 'resolve/plsql-cfg.ts'],
  ],
  [
    'what keeps uncommitted edits queryable',
    ['core/src/working-overlay.ts', 'cli/src/watch.ts', 'working-overlay-refresh.ts'],
  ],
  [
    'how is a cross file reference resolved without guessing',
    ['resolve/symbol-table.ts', 'resolve/index.ts', 'ts-resolver.ts', 'mule-resolver.ts'],
  ],
  [
    'what decides which symbols get described first',
    ['core/src/importance.ts', 'mcp/src/enrichment.ts'],
  ],
  ['how does an unchanged answer avoid resending', ['core/src/ifhash.ts', 'ifhash-check.mjs']],
  [
    'how is documentation joined to code',
    ['linker/signals.ts', 'linker/index.ts', 'linker/score.ts', 'md/MarkdownExtractor.ts'],
  ],
  [
    'what groups related code into modules',
    ['cluster/cluster.ts', 'cluster/louvain.ts', 'core/src/functional-map.ts'],
  ],
  [
    'how is only the changed part re-indexed',
    ['pipeline/src/update.ts', 'core/src/delta.ts', 'pipeline/src/vcs.ts'],
  ],
  [
    'what proves parallel and serial produce the same graph',
    ['parallel-check.mjs', 'determinism-mule-par.mjs', 'parse-pool.ts'],
  ],
];

const DB = `${R}/.crib/index/crib.sqlite`;

/** First 1-based rank whose hit id contains any wanted path fragment, or 0 for a miss. */
function rankOf(store, q, wants) {
  const hits = store.query({ text: q, limit: LIMIT });
  for (let i = 0; i < hits.length; i++) {
    if (wants.some((w) => hits[i].id.includes(w))) return i + 1;
  }
  return 0;
}

function score(store) {
  let top1 = 0;
  let top3 = 0;
  let found = 0;
  let mrr = 0;
  const ranks = [];
  for (const [q, want] of CASES) {
    const rank = rankOf(store, q, want);
    ranks.push({ q, rank });
    if (rank === 1) top1++;
    if (rank >= 1 && rank <= 3) top3++;
    if (rank >= 1) {
      found++;
      mrr += 1 / rank;
    }
  }
  const n = CASES.length;
  return {
    n,
    top1,
    top3,
    found,
    mrr: mrr / n,
    top1Pct: Math.round((100 * top1) / n),
    top3Pct: Math.round((100 * top3) / n),
    foundPct: Math.round((100 * found) / n),
    ranks,
  };
}

const soul = new SoulStore(`${R}/.crib`);
soul.load();

const embedder = await loadInstalledEmbedder().catch(() => undefined);

const lexical = new SqliteIndexStore(DB);
const lexicalCaps = lexical.capabilities();
const lexicalScore = score(lexical);
lexical.close();

let hybridScore;
let hybridCaps;
if (embedder) {
  const hybrid = new SqliteIndexStore(DB, { embedder });
  hybridCaps = hybrid.capabilities();
  hybridScore = hybrid.capabilities().vector ? score(hybrid) : undefined;
  hybrid.close();
}

const report = {
  db: DB,
  cases: CASES.length,
  limit: LIMIT,
  embedder: embedder ? { id: embedder.id, dim: embedder.dim() } : null,
  vectorChannel: hybridCaps?.vector === true,
  // Carried verbatim: an unusable vector channel has a REASON, and a gate that hides it reports a tie
  // as a result. `vectorNote` names whether the index lacks vectors, lacks a matching model, or was
  // built from an older text recipe.
  vectorNote: hybridCaps?.vectorNote ?? lexicalCaps.vectorNote ?? null,
  lexical: lexicalScore,
  hybrid: hybridScore ?? null,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const row = (label, s) =>
    s === undefined || s === null
      ? `${label.padEnd(9)} —  (not measured)`
      : `${label.padEnd(9)} top1 ${String(s.top1).padStart(2)}/${s.n} (${String(s.top1Pct).padStart(3)}%)   ` +
        `top3 ${String(s.top3).padStart(2)}/${s.n} (${String(s.top3Pct).padStart(3)}%)   ` +
        `found ${String(s.found).padStart(2)}/${s.n} (${String(s.foundPct).padStart(3)}%)   MRR ${s.mrr.toFixed(3)}`;
  console.log(`corpus           : ${CASES.length} labelled questions, top-${LIMIT} window`);
  console.log(
    `embedder         : ${embedder ? `${embedder.id} (dim ${embedder.dim()})` : 'none installed'}`,
  );
  console.log(
    `vector channel   : ${report.vectorChannel ? 'LIVE' : 'off'}${report.vectorNote ? ` — ${report.vectorNote}` : ''}`,
  );
  console.log('');
  console.log(row('lexical', lexicalScore));
  console.log(row('hybrid', hybridScore));
  if (hybridScore) {
    console.log('');
    const better = [];
    const worse = [];
    for (let i = 0; i < CASES.length; i++) {
      const a = lexicalScore.ranks[i];
      const b = hybridScore.ranks[i];
      // rank 0 is a MISS, which is worse than any real rank — normalise before comparing so a
      // miss→rank-7 counts as an improvement rather than as a regression from "rank 0".
      const norm = (r) => (r === 0 ? Number.POSITIVE_INFINITY : r);
      if (norm(b.rank) < norm(a.rank))
        better.push(`  + ${a.q}  (${a.rank || 'miss'} → ${b.rank || 'miss'})`);
      if (norm(b.rank) > norm(a.rank))
        worse.push(`  - ${a.q}  (${a.rank || 'miss'} → ${b.rank || 'miss'})`);
    }
    console.log(`improved by hybrid : ${better.length}`);
    for (const l of better) console.log(l);
    console.log(`regressed by hybrid: ${worse.length}`);
    for (const l of worse) console.log(l);
  }
}

if (MIN_MRR !== undefined) {
  const got = hybridScore?.mrr ?? lexicalScore.mrr;
  if (got < MIN_MRR) {
    console.error(`FAIL: MRR ${got.toFixed(3)} < --min-mrr ${MIN_MRR}`);
    process.exit(1);
  }
}
