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
 * all of which missed. It also inherits the corpus's limits — 20 questions, one repository, authored by
 * someone who knows the codebase — so it is a regression gate, not an external benchmark.
 *
 * Usage:
 *   node scripts/eval/code-vector-eval.mjs [--min-mrr 0] [--json] [--limit 10] [--require-hybrid]
 *
 * Three outcomes, following `docs/bench/perf-gates.md`:
 *
 *   PASS (0)         — the run happened and measured what it says it measured; `--min-mrr`, if given,
 *                      was met.
 *   FAIL (1)         — the graded arm's MRR fell below `--min-mrr`.
 *   UNAVAILABLE (2)  — the arm you asked to be graded COULD NOT BE MEASURED: an embedder is installed
 *                      and the index refused the vector channel, or `--require-hybrid` was passed and
 *                      no hybrid arm ran. The report names which case withheld it.
 *
 * `--min-mrr` grades whichever arm ran, and now SAYS which — see the `graded` field. Before this the
 * fallback was silent: with the vector channel off, `--min-mrr` was applied to the LEXICAL MRR while
 * the run looked like a hybrid gate, which is a passing verdict on a number the vector channel never
 * produced. A `--min-mrr` PASS on the lexical arm is still meaningful — but only in the run that
 * states it is lexical-only, where no embedder is installed at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SoulStore,
  SqliteIndexStore,
  loadInstalledEmbedder,
  loadInstalledReranker,
} from '../../packages/core/dist/index.js';

const R = process.cwd();
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
};
const LIMIT = flag('--limit', 10);
/** How deep the hybrid stage is reranked. 50 is `DEFAULT_RERANK_DEPTH`. */
const RERANK_DEPTH = flag('--rerank-depth', 50);
const MIN_MRR = args.includes('--min-mrr') ? flag('--min-mrr', 0) : undefined;
const REQUIRE_HYBRID = args.includes('--require-hybrid');
const AS_JSON = args.includes('--json');

/**
 * Exit codes, following the three-outcome gate model in `docs/bench/perf-gates.md`.
 *
 * UNAVAILABLE is deliberately distinct from FAIL: "the vector channel was withheld, so nothing was
 * measured" and "the vector channel was measured and is worse" are different facts, and collapsing
 * them would let an unusable index read as a failing one — or, worse, as a passing one.
 */
const EXIT = { PASS: 0, FAIL: 1, UNAVAILABLE: 2 };

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

/**
 * The text a reranker sees for one hit: the same surface + capped body the vector channel embeds
 * (`vectorText` v2), so the second stage judges the same content the first stage ranked. Reading a
 * DIFFERENT projection here would measure the projection, not the reranker.
 */
const fileLines = new Map();
function textForHit(hit) {
  const node = soul.getNode?.(hit.id);
  const surface = [node?.name, node?.qualifiedName, node?.signature, node?.heading, node?.file]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .join(' ');
  if (!node?.file || !node?.span) return surface || hit.id;
  let lines = fileLines.get(node.file);
  if (lines === undefined) {
    try {
      lines = readFileSync(join(R, node.file), 'utf8').split('\n');
    } catch {
      lines = null;
    }
    fileLines.set(node.file, lines);
  }
  if (!lines) return surface || hit.id;
  const body = lines.slice(Math.max(node.span.start - 1, 0), node.span.end).join('\n');
  const capped = body.length > 1200 ? body.slice(0, 1200) : body;
  return capped ? `${surface}\n${capped}` : surface || hit.id;
}

/** Score the corpus through a store, reranking the top `RERANK_DEPTH` hits with a cross-encoder. */
function scoreReranked(store, reranker) {
  let top1 = 0;
  let top3 = 0;
  let found = 0;
  let mrr = 0;
  const ranks = [];
  for (const [q, want] of CASES) {
    const pool = store.query({ text: q, limit: RERANK_DEPTH });
    let ordered = pool;
    if (pool.length > 1) {
      const scores = reranker.rerankBatch(q, pool.map(textForHit));
      ordered = pool
        .map((hit, i) => ({ hit, score: scores[i] }))
        .sort((a, b) => b.score - a.score)
        .map((e) => e.hit);
    }
    const window = ordered.slice(0, LIMIT);
    let rank = 0;
    for (let i = 0; i < window.length; i++) {
      if (want.some((w) => window[i].id.includes(w))) {
        rank = i + 1;
        break;
      }
    }
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

/**
 * WHICH of the degradation cases withheld the vector channel — the §5.3 cases of
 * `docs/program/wp4-implementation-spec.md`, named by the state this script can observe.
 *
 * Classified from facts this script already holds rather than by matching prose out of the note: a
 * regex over the store's message would silently mislabel the moment that message is reworded, and a
 * mislabelled reason is worse than no reason. The note is still carried and printed verbatim, so the
 * SPECIFICS (which recipe version, which dims, which embedder id) survive without being guessed at
 * here. The coarse label carries only the distinction that changes what the operator does next.
 *
 *   not-built        — no `vector_meta` at all. Nothing refused anything; the index was simply never
 *                      built with `--vectors`. Distinguished from a refusal because a bare
 *                      `vector: false` otherwise reads as "never implemented" (the F1 defect), and
 *                      because the fix is a rebuild rather than an investigation.
 *   refused-by-index — the index CARRIES vectors and this reader would not use them (a §5.3
 *                      text-recipe, dim or embedder-id mismatch). The verbatim note names which.
 *   no-embedder      — nothing on this machine could embed, so no arm was attempted.
 */
function classifyDegradation(caps, hasEmbedder) {
  if (caps.vectorNote === undefined || caps.vectorNote === null) return 'not-built';
  return hasEmbedder ? 'refused-by-index' : 'no-embedder';
}

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

/**
 * The third column: hybrid retrieval, then a cross-encoder over the top RERANK_DEPTH.
 *
 * Opt-in via `--rerank`, because it loads a ~1.1 GB model and costs a forward pass per candidate —
 * a gate that silently did that on every run would be a gate nobody runs.
 */
let rerankedScore;
let rerankerId = null;
let rerankedOver = null;
if (args.includes('--rerank')) {
  const reranker = await loadInstalledReranker().catch((e) => {
    process.stderr.write(`reranker unavailable: ${e.message}\n`);
    return undefined;
  });
  if (reranker) {
    rerankerId = reranker.id;
    // Rerank over whichever first stage is actually available. Measuring rerank-over-LEXICAL is not a
    // fallback, it is the more practically interesting question: it says whether a second stage can
    // rescue a cheap index, versus paying for the 24-minute vector build first.
    const live = hybridCaps?.vector === true && embedder;
    rerankedOver = live ? 'hybrid' : 'lexical';
    const store = live ? new SqliteIndexStore(DB, { embedder }) : new SqliteIndexStore(DB);
    rerankedScore = scoreReranked(store, reranker);
    store.close();
  }
}

/**
 * Which arm `--min-mrr` grades, decided ONCE and printed. The old fallback (`hybridScore?.mrr ??
 * lexicalScore.mrr`) silently substituted the lexical number whenever the hybrid arm was absent, so a
 * run with the vector channel off printed a green verdict for a channel that never ran. Naming the arm
 * is what makes the verdict falsifiable: the reader can see which column the number came from.
 */
const gradedArm = hybridScore ? 'hybrid' : 'lexical';

const report = {
  db: DB,
  reranker: rerankerId,
  rerankedOver,
  rerankDepth: rerankerId ? RERANK_DEPTH : null,
  cases: CASES.length,
  limit: LIMIT,
  embedder: embedder ? { id: embedder.id, dim: embedder.dim() } : null,
  vectorChannel: hybridCaps?.vector === true,
  // Only meaningful when the channel is OFF: an unusable vector channel has a REASON, and a gate that
  // hides it reports a tie as a result. When the channel is LIVE, the lexical store's own note ("this
  // reader loaded no embedder") is true of that store and says nothing about the run — printing it
  // beside "LIVE" read as a contradiction, so it is suppressed rather than carried.
  vectorNote:
    hybridCaps?.vector === true ? null : (hybridCaps?.vectorNote ?? lexicalCaps.vectorNote ?? null),
  vectorUnavailable:
    hybridCaps?.vector === true
      ? null
      : classifyDegradation(hybridCaps ?? lexicalCaps, Boolean(embedder)),
  lexical: lexicalScore,
  hybrid: hybridScore ?? null,
  reranked: rerankedScore ?? null,
  /** Which arm `--min-mrr` grades. Stated in the report, never left for the caller to infer. */
  graded: gradedArm,
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
  if (report.vectorUnavailable && embedder) {
    // H-6: a measurement that did not run is reported as NOT HAVING RUN. Without this line the lexical
    // column reads as a result and the absent hybrid column reads as an omission.
    //
    // Suppressed when no embedder is installed: there the reason the hybrid arm did not run is the
    // missing model, which rule 2 states below far more precisely than this field can. Printing both
    // would put two different axes of explanation side by side and read as a contradiction.
    console.log(`withheld because : ${report.vectorUnavailable}`);
  }
  console.log('');
  console.log(row('lexical', lexicalScore));
  // §8.6: with no embedder installed there is no hybrid column to print, and printing an empty one
  // would invite the reader to wait for a number instead of reading the lexical-only statement.
  if (embedder) console.log(row('hybrid', hybridScore));
  if (rerankerId) console.log(row(`rerank/${rerankedOver}`, rerankedScore));
  console.log(`graded by --min-mrr: ${gradedArm}`);
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

/**
 * The verdict, applying §8.6 as written — three rules, and `docs/bench/perf-gates.md`'s three-outcome
 * model is what keeps "not measured" from being read as either of the two outcomes it is not.
 *
 *   1. An embedder IS resolvable and `capabilities().vector` is false → non-zero. The operator has the
 *      model and did not get the channel, so the run is not the measurement they think it is. This is
 *      the rule the pre-fix harness broke most badly: with the embedder installed and the channel
 *      refused, it exited 0 and printed a lexical number under a heading that promised a comparison.
 *   2. No embedder is installed at all → the report states it is lexical-only, prints no hybrid
 *      column, and exits on `--min-mrr` alone. A lexical run that SAYS it is lexical is a legitimate
 *      regression gate for the shipped default path.
 *   3. `--require-hybrid` makes "hybrid ran" a hard precondition for exit 0, so CI can assert it
 *      without depending on which embedder happens to be installed on the runner.
 *
 * UNAVAILABLE (2), never FAIL (1), when the channel was withheld: "the vector channel could not be
 * measured" and "the vector channel was measured and is worse" are different facts, and collapsing
 * them would let an unusable index read as a failing one — or, worse, as a passing one.
 *
 * No floor is baked in: WP4 §10.5 preregisters the decision rule, and a threshold invented here would
 * be exactly the unfounded claim the pre-registration discipline exists to prevent.
 */
let exitCode = EXIT.PASS;

/** Rule 1 — the embedder is here and the channel is not. Actionable, so it is never a silent pass. */
if (embedder && !report.vectorChannel) {
  console.error(
    `UNAVAILABLE: an embedder is installed (${embedder.id}) but the index withheld the vector channel (${report.vectorUnavailable}).`,
  );
  console.error(
    `  ${report.vectorNote ?? 'The index carries no vector_meta — it was not built with --vectors.'}`,
  );
  console.error('  Nothing about the vector channel was measured by this run.');
  exitCode = EXIT.UNAVAILABLE;
}

/** Rule 2 — no embedder at all: a stated lexical-only run, reported above, and not an error here. */
if (!embedder) {
  console.log(
    'lexical-only run : true — no embedder is installed, so the hybrid arm was not attempted',
  );
}

/** Rule 3 — CI asserts the hybrid arm ran without depending on the runner's installed models. */
if (REQUIRE_HYBRID && !hybridScore) {
  console.error(
    `UNAVAILABLE: --require-hybrid was passed but the hybrid arm was not measured (${report.vectorUnavailable}).`,
  );
  console.error(
    `  The vector channel is ${report.vectorChannel ? 'LIVE' : 'off'}${report.vectorNote ? ` — ${report.vectorNote}` : ''}`,
  );
  console.error(
    '  Nothing about the vector channel was measured, so this is NOT a passing verdict on it.',
  );
  exitCode = EXIT.UNAVAILABLE;
}

if (MIN_MRR !== undefined) {
  // `gradedArm === 'hybrid'` iff `hybridScore` exists — that is how it was derived above — so this
  // reads the exact column the report prints under `graded`. No `??` fallback: the substitution IS
  // the defect this block replaced.
  const got = gradedArm === 'hybrid' ? hybridScore.mrr : lexicalScore.mrr;
  if (got < MIN_MRR) {
    console.error(`FAIL: MRR ${got.toFixed(3)} < --min-mrr ${MIN_MRR} (graded arm: ${gradedArm})`);
    if (exitCode === EXIT.PASS) exitCode = EXIT.FAIL;
  } else {
    console.log(`PASS: MRR ${got.toFixed(3)} >= --min-mrr ${MIN_MRR} (graded arm: ${gradedArm})`);
  }
}

process.exit(exitCode);
