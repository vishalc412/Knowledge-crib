#!/usr/bin/env node
/**
 * WP4 §8 — the five-category code-retrieval harness.
 *
 * §8 refuses a single blended score: "A category with no discriminating power is reported as such —
 * not merged into a blend." So this harness reports FIVE categories side by side, each with its own
 * metric, and each able to say *why* it could not be measured rather than quietly scoring zero.
 *
 *   exact        R@1 / R@10 / MRR, ground truth derived mechanically from the soul store (not
 *                hand-written — §8's own requirement), with the name-ambiguity confound published
 *                because it CAPS the achievable R@1. Measured here: 7,400 symbols with a name of 3+
 *                characters, 621 of their names borne by more than one symbol, covering 2,516 — so the
 *                bare-name selfR@1 ceiling is 74.4%, and the 33 points below it are ranking failure
 *                rather than collisions. `fileR@1` is reported beside `selfR@1` to separate "found the
 *                wrong overload" from "did not find the symbol", and `qualifiedName` is measured as a
 *                second variant because it is the less ambiguous query (ceiling 83.7%).
 *   nl           MRR / R@10 over the labelled natural-language corpus. Per §10.7 this is the 20-case
 *                CASES arm SPLIT BY ARM; the primary 61-task leakage-controlled corpus is scored by
 *                the separate `locate-eval.mjs` invocation, not re-scored here.
 *   cross-file   file-level R@k and the all-files-covered rate — §8's own framing: "a view over CASES",
 *                so it shares the corpus and changes only the grain.
 *   rename       from the frozen `rename-corpus.json`. Absent corpus → UNAVAILABLE. `powered:false` →
 *                reported as underpowered with n and the reason, and NO metric (§8.4 step 5).
 *   dependency   delegates to `cochange-eval.mjs` so the number stays comparable (§8.5, §11).
 *
 * ── THE FOUR ARMS, AND THE ONE THAT CANNOT BE REACHED ─────────────────────────────────────────────
 *
 *   C0  lexical-only        query({ semantic: false })
 *   C1  hybrid-rrf-rerank   query({})                                  — the default path
 *   C2  hybrid-rrf          query({ rerank: false })
 *   C3  semantic-only       NOT MEASURABLE through any public API
 *
 * C3 is reported as unmeasurable, with the structural reason, rather than approximated. `vectorQuery`
 * is private; the only public switch is `semantic: false`, which turns the vector channel OFF. Cosine
 * alone therefore has no entry point, and reaching it via a cast would measure a configuration
 * production does not have — the F1/H-6 class of defect this work package exists to remove. Naming
 * the gap is the §8.6 discipline applied to the candidate set.
 *
 * ── WHY C1/C2 CAN REPORT *UNAVAILABLE* ON A WORKING INDEX ─────────────────────────────────────────
 *
 * The hybrid arms are not "worse" on an index with no vectors — they are IDENTICAL to C0, because
 * `SqliteIndexStore.query` branches on `builtEmbedderId !== null` before it ever fuses. Scoring them
 * would print three identical columns and invite the reader to conclude "hybrid adds nothing", which
 * is a claim about a channel that never ran. The three-outcome model in `docs/bench/perf-gates.md`
 * exists for exactly this: `capabilities().vector === false` makes C1/C2 UNAVAILABLE (exit 2), never a
 * FAIL and never a tie, and the report carries `vectorNote` so the reader learns the remedy.
 *
 * Usage:
 *   node scripts/bench/code-retrieval-eval.mjs [--category exact,nl,cross-file,rename,dependency]
 *        [--k 10] [--limit <per-query fetch>] [--db .crib/index/crib.sqlite] [--soul .crib]
 *        [--exact-sample 400|all] [--exact-variant name,qualifiedName]
 *        [--rename-corpus docs/bench/rename-corpus.json] [--base-tree <path>]
 *        [--require <categories>] [--decide] [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '../../packages/core/dist/index.js';
import { mean } from '../eval/metrics.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const str = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')
    ? args[i + 1]
    : fallback;
};

const R = process.cwd();
const K = Number(str('--k', '10'));
/** How many hits each query fetches. Deeper than K so recall@K is measured on a real ranking. */
const LIMIT = Number(str('--limit', '50'));
const DB = resolve(R, str('--db', '.crib/index/crib.sqlite'));
const SOUL_DIR = resolve(R, str('--soul', '.crib'));
const RENAME_CORPUS = resolve(R, str('--rename-corpus', 'docs/bench/rename-corpus.json'));
const BASE_TREE = str('--base-tree', undefined);
const EXACT_SAMPLE = str('--exact-sample', '400');
const EXACT_VARIANTS = (str('--exact-variant', 'name,qualifiedName') ?? '')
  .split(',')
  .filter(Boolean);
const CATEGORIES = (str('--category', 'exact,nl,cross-file,rename,dependency') ?? '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
const REQUIRE = (str('--require', '') ?? '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
const DECIDE = has('--decide');
const AS_JSON = has('--json');
const ALL_CATEGORIES = ['exact', 'nl', 'cross-file', 'rename', 'dependency'];

/** The three-outcome gate model (`docs/bench/perf-gates.md`). */
const EXIT = { PASS: 0, FAIL: 1, UNAVAILABLE: 2 };

/**
 * The labelled natural-language corpus, duplicated from `scripts/eval/code-vector-eval.mjs` because
 * that file runs its whole evaluation on import and so cannot be imported for its data. The
 * duplication is a known limitation and is published under `limits` in the report; `CASES.length` is
 * asserted below so an edit here cannot silently change the corpus size.
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
  ['where is the dossier rendered to markdown', ['dossier-md.ts', 'dossier-render.ts']],
  ['what decides which files are extracted', ['core/src/scope.ts', 'core/src/source-policy.ts']],
  [
    'how does an incremental update find what changed',
    ['core/src/delta.ts', 'sqlite-index.ts', 'incremental.ts'],
  ],
  ['what enforces that memory writes are atomic', ['memory/src/atomic.ts', 'atomic-write.ts']],
  ['where do embeddings get cached between runs', ['generation-cache.ts', 'vector-store.ts']],
  ['what stops a stale index answering confidently', ['sqlite-index.ts', 'refresh-coordinator.ts']],
  ['how are clusters of related symbols formed', ['cluster.ts', 'hierarchical.ts']],
  ['what reads the repo instructions file', ['source-policy.ts', 'instructions.ts']],
  ['how does memory recall rank competing claims', ['recall.ts', 'evaluator.ts']],
  ['what happens when two devices sync memory', ['sync/queue.ts', 'sync']],
  ['where is the graph model built for the ui', ['graph-model.js', 'graph-model.ts']],
  ['what validates a workflow graph before it saves', ['validate', 'workflow.ts']],
  ['how is a symbol renamed safely across the graph', ['rename.ts']],
  ['what decides a node is too detailed to embed', ['enums.ts', 'sqlite-index.ts']],
  [
    'what proves parallel and serial produce the same graph',
    ['parallel-check.mjs', 'determinism-mule-par.mjs', 'parse-pool.ts'],
  ],
];

if (CASES.length !== 20) {
  process.stderr.write(
    `NL corpus drifted: expected 20 cases (matching scripts/eval/code-vector-eval.mjs), found ${CASES.length}\n`,
  );
  process.exit(EXIT.UNAVAILABLE);
}

const ARMS = [
  { id: 'C0', name: 'lexical-only', query: { semantic: false } },
  { id: 'C1', name: 'hybrid-rrf-rerank', query: {} },
  { id: 'C2', name: 'hybrid-rrf', query: { rerank: false } },
];

/** The category a hit belongs to, by the file it names. Mirrors `code-vector-eval.mjs`'s convention. */
function fileOf(hit) {
  if (hit.file) return hit.file;
  const id = String(hit.id ?? '');
  const m = id.match(/^[a-z-]+:(.+?)#/);
  return m?.[1] ?? id;
}

/** 1-based rank of the first hit satisfying `pred`, or 0 if none. */
function rankMatching(items, pred) {
  for (let i = 0; i < items.length; i++) if (pred(items[i])) return i + 1;
  return 0;
}

/**
 * Recall over the expected set, at a grain the caller has already reduced to (files, or ids).
 *
 * This is NOT `metrics.recallAtK`, and the reason is a measured trap rather than a preference. That
 * helper intersects by exact string equality, which is right when ground truth holds the same path
 * spelling the retriever returns — but `CASES` ground truth holds path FRAGMENTS (`core/src/lock.ts`)
 * while every hit returns a repository-relative path (`packages/core/src/lock.ts`). The intersection is
 * then empty by construction, and the harness printed `R@10 0.0%` next to `R@1 10.0%` — a pair that
 * cannot both be true, since a rank-1 hit is inside the top 10. An impossible pair is the signature of
 * a broken metric rather than a bad ranker, so recall is computed here against the same `isRight`
 * predicate the ranker is judged by, and the two can no longer disagree.
 */
function recallOverExpected(topK, expected, isRight) {
  if (expected.length === 0) return 0;
  let matched = 0;
  for (const want of expected) if (topK.some((item) => isRight(item, want))) matched += 1;
  return matched / expected.length;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────────────── index + arm capability

if (!existsSync(DB)) {
  process.stderr.write(`no index at ${DB} — run \`crib index\` first\n`);
  process.exit(EXIT.UNAVAILABLE);
}

const store = new SqliteIndexStore(DB);
const caps = store.capabilities();
/**
 * Whether the two hybrid arms can be measured AT ALL. This is the gate that keeps a lexical-only
 * index from printing three identical columns and calling it a comparison.
 */
const hybridMeasurable = caps.vector === true;
const hybridNote = hybridMeasurable
  ? null
  : (caps.vectorNote ??
    'the index holds no vectors; C1/C2 would be byte-identical to C0 because query() branches on builtEmbedderId before fusing');

const results = {
  generatedAt: new Date().toISOString(),
  repo: R,
  db: DB,
  k: K,
  limit: LIMIT,
  index: { vector: caps.vector, cypher: caps.cypher, vectorNote: caps.vectorNote ?? null },
  arms: {
    C0: { name: 'lexical-only', status: 'measured' },
    C1: {
      name: 'hybrid-rrf-rerank',
      status: hybridMeasurable ? 'measured' : 'unavailable',
      ...(hybridNote ? { reason: hybridNote } : {}),
    },
    C2: {
      name: 'hybrid-rrf',
      status: hybridMeasurable ? 'measured' : 'unavailable',
      ...(hybridNote ? { reason: hybridNote } : {}),
    },
    C3: {
      name: 'semantic-only',
      status: 'not-measurable',
      reason:
        'no public switch: `semantic:false` turns the vector channel off, and `vectorQuery` is private, so cosine-alone has no entry point. Measuring it would require reaching past the API into a configuration production does not have.',
    },
  },
  categories: {},
};

/** Which arms to actually run: C0 always; C1/C2 only when the vector channel exists. */
const RUNNABLE = ARMS.filter((a) => a.id === 'C0' || hybridMeasurable);

function queryArm(arm, text) {
  return store.query({ text, limit: LIMIT, ...arm.query });
}

// ─────────────────────────────────────────────────────────────── exact

function runExact() {
  const soul = new SoulStore(SOUL_DIR, { manifest: newManifest({ root: '.' }) });
  soul.load();

  const symbols = [];
  for (const node of soul.iterate('symbol')) {
    if (typeof node.name === 'string' && node.name.length >= 3) symbols.push(node);
  }
  symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Name ambiguity, measured rather than assumed: it is a CEILING on selfR@1, so a report that omits
  // it invites a reader to read a collision as a ranking miss. Reported at the universe level (the
  // bare `name` distribution) and again per variant, because `qualifiedName` is far less ambiguous and
  // so has a higher ceiling — which is the whole reason both variants are measured.
  const ambiguityOf = (keyOf) => {
    const counts = new Map();
    for (const s of symbols) {
      const k = keyOf(s);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let namesBorneByMultiple = 0;
    let symbolsSharing = 0;
    for (const n of counts.values()) {
      if (n > 1) {
        namesBorneByMultiple += 1;
        symbolsSharing += n;
      }
    }
    return { distinct: counts.size, namesBorneByMultiple, symbolsSharing };
  };
  const byName = ambiguityOf((s) => s.name);

  const sampleSize =
    EXACT_SAMPLE === 'all' ? symbols.length : Math.min(symbols.length, Number(EXACT_SAMPLE));
  const stride = Math.max(1, Math.floor(symbols.length / Math.max(1, sampleSize)));
  const sampled = [];
  for (let i = 0; i < symbols.length && sampled.length < sampleSize; i += stride)
    sampled.push(symbols[i]);

  const out = {
    category: 'exact',
    universe: {
      symbols: symbols.length,
      distinctNames: byName.distinct,
      namesBorneByMultipleSymbols: byName.namesBorneByMultiple,
      symbolsSharingAName: byName.symbolsSharing,
      sampled: sampled.length,
      stride,
      deterministic: 'stride over the id-sorted symbol list — identical on every run and every arm',
    },
    variants: {},
  };

  for (const variant of EXACT_VARIANTS) {
    const keyOf = (s) => (variant === 'qualifiedName' ? s.qualifiedName : s.name);
    const amb = ambiguityOf(keyOf);
    const perArm = {};
    for (const arm of RUNNABLE) {
      let self1 = 0;
      let file1 = 0;
      let self10 = 0;
      const mrrs = [];
      for (const s of sampled) {
        const text = variant === 'qualifiedName' ? (s.qualifiedName ?? s.name) : s.name;
        if (!text || text.length < 3) continue;
        const hits = queryArm(arm, text);
        const selfRank = rankMatching(hits, (h) => h.id === s.id);
        const fileRank = rankMatching(hits, (h) => fileOf(h) === s.file);
        if (selfRank === 1) self1 += 1;
        if (fileRank === 1) file1 += 1;
        if (selfRank > 0 && selfRank <= K) self10 += 1;
        mrrs.push(selfRank > 0 ? 1 / selfRank : 0);
      }
      perArm[arm.id] = {
        n: mrrs.length,
        selfR1: self1 / Math.max(1, mrrs.length),
        selfRAtK: self10 / Math.max(1, mrrs.length),
        fileR1: file1 / Math.max(1, mrrs.length),
        mrr: mean(mrrs),
      };
    }
    out.variants[variant] = {
      /**
       * The exact ceiling on the share of sampled symbols that can EVER reach selfR@1 at this variant:
       * one per distinct query string, because bearers of the same name cannot all be rank 1. Anything
       * above it is unreachable, so the gap between it and the observed `selfR1` — not the raw `selfR1`
       * — is the part that is genuinely a ranking failure.
       */
      selfR1Ceiling: amb.distinct / Math.max(1, symbols.length),
      queryStringsBorneByMultipleSymbols: amb.namesBorneByMultiple,
      arms: perArm,
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── nl (20-case), and cross-file

function runNl() {
  const perArm = {};
  for (const arm of RUNNABLE) {
    const r1 = [];
    const rk = [];
    const mrrs = [];
    for (const [text, expected] of CASES) {
      const hits = queryArm(arm, text);
      const files = hits.map(fileOf);
      const isRight = (f, want) => f.includes(want);
      const rank = rankMatching(hits, (h) => expected.some((w) => isRight(fileOf(h), w)));
      r1.push(rank === 1 ? 1 : 0);
      rk.push(recallOverExpected(files.slice(0, K), expected, isRight));
      mrrs.push(rank > 0 ? 1 / rank : 0);
    }
    perArm[arm.id] = { n: CASES.length, r1: mean(r1), rAtK: mean(rk), mrr: mean(mrrs) };
  }
  return {
    category: 'nl',
    corpus: {
      name: 'CASES (20 labelled questions)',
      role: 'arm-split view; the primary 61-task arm is locate-eval.mjs',
    },
    arms: perArm,
  };
}

function runCrossFile() {
  const perArm = {};
  for (const arm of RUNNABLE) {
    const rk = [];
    const mrrVals = [];
    let allCovered = 0;
    for (const [text, expected] of CASES) {
      const hits = queryArm(arm, text);
      // DEDUPE BY FILE: this is the whole point of the grain change — §8 asks for file-level R@k, and
      // several nodes of one file in the top-k must count once, or a single well-represented file
      // would inflate recall.
      const files = [];
      for (const h of hits) {
        const f = fileOf(h);
        if (!files.includes(f)) files.push(f);
      }
      const isRight = (f, want) => f.includes(want);
      rk.push(recallOverExpected(files.slice(0, K), expected, isRight));
      const rank = rankMatching(files, (f) => expected.some((w) => isRight(f, w)));
      mrrVals.push(rank > 0 ? 1 / rank : 0);
      const top = files.slice(0, K);
      if (expected.every((w) => top.some((f) => isRight(f, w)))) allCovered += 1;
    }
    perArm[arm.id] = {
      n: CASES.length,
      rAtK: mean(rk),
      mrr: mean(mrrVals),
      allFilesCoveredRate: allCovered / CASES.length,
    };
  }
  return {
    category: 'cross-file',
    grain: 'file — hits deduped by file before scoring',
    arms: perArm,
  };
}

// ─────────────────────────────────────────────────────────────── rename

function runRename() {
  if (!existsSync(RENAME_CORPUS)) {
    return {
      category: 'rename',
      status: 'unavailable',
      reason: `no frozen corpus at ${RENAME_CORPUS} — build it with scripts/bench/rename-corpus.mjs`,
    };
  }
  const corpus = JSON.parse(readFileSync(RENAME_CORPUS, 'utf8'));
  const power = corpus.power ?? { powered: false, tasks: (corpus.tasks ?? []).length };

  // §8.4 step 5. An underpowered category gets its n and its reason and NO METRIC — a metric computed
  // from too few tasks is the "padded set" the step forbids, wearing a decimal point.
  if (!power.powered) {
    return {
      category: 'rename',
      status: 'underpowered',
      n: power.tasks,
      minTasks: power.minTasks ?? null,
      reason:
        'fewer qualifying renames than the corpus minimum, so §8.4 step 5 applies: reported as underpowered rather than scored',
      window: corpus.window,
      indexRev: corpus.indexRev,
      composition: corpus.counts?.byPathClass ?? null,
      limits: corpus.limits ?? [],
    };
  }

  const perArm = {};
  for (const arm of RUNNABLE) {
    const newSiteR1 = [];
    const newSiteMrr = [];
    let oldAtTop = 0;
    for (const task of corpus.tasks) {
      const hits = queryArm(arm, task.question);
      const isNew = (h) => task.expectedFiles.some((w) => fileOf(h).includes(w));
      const isOld = (h) => fileOf(h) === task.oldPath;
      const rank = rankMatching(hits, isNew);
      newSiteR1.push(rank === 1 ? 1 : 0);
      newSiteMrr.push(rank > 0 ? 1 / rank : 0);
      if (hits.length > 0 && isOld(hits[0])) oldAtTop += 1;
    }
    perArm[arm.id] = {
      n: corpus.tasks.length,
      newSiteR1: mean(newSiteR1),
      newSiteMrr: mean(newSiteMrr),
      /** A TRIPWIRE, not a distribution — see `corpus.metric2`. */
      oldSiteAtTopRate: oldAtTop / corpus.tasks.length,
    };
  }
  return {
    category: 'rename',
    status: 'measured',
    metric2: corpus.metric2 ?? null,
    window: corpus.window,
    indexRev: corpus.indexRev,
    arms: perArm,
  };
}

// ─────────────────────────────────────────────────────────────── dependency (delegated)

function runDependency() {
  const corpus = str('--locate-corpus', 'docs/bench/locate-corpus.json');
  if (!BASE_TREE) {
    return {
      category: 'dependency',
      status: 'unavailable',
      reason:
        'cochange-eval.mjs requires --base-tree (a checkout of the corpus base with its own index); pass --base-tree to measure this category',
    };
  }
  if (!existsSync(resolve(R, corpus))) {
    return { category: 'dependency', status: 'unavailable', reason: `no corpus at ${corpus}` };
  }
  try {
    const raw = execFileSync(
      process.execPath,
      [
        'scripts/bench/cochange-eval.mjs',
        '--base-tree',
        BASE_TREE,
        '--corpus',
        corpus,
        '--k',
        String(K),
        '--json',
      ],
      { cwd: R, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(raw);
    return {
      category: 'dependency',
      status: 'measured',
      delegatedTo: 'scripts/bench/cochange-eval.mjs',
      tasks: parsed.tasks,
      k: parsed.k,
      table: parsed.table,
      note: 'liftOverBlind is relative to the BEST query-blind control; a method at lift <= 1.00 has not shown it uses the seed file at all',
    };
  } catch (err) {
    return {
      category: 'dependency',
      status: 'unavailable',
      reason: `cochange-eval.mjs did not produce JSON: ${String(err.message ?? err).split('\n')[0]}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────── §10.5 decision rule

/**
 * §10.5, applied as written. Every criterion is either evaluated or explicitly reported as NOT
 * CHECKABLE — because on a lexical-only index the discrimination and minimum-effect criteria cannot
 * fire, and silently passing them would turn "not measured" into "satisfied".
 */
function decide() {
  const exact = results.categories.exact?.variants?.name;
  const nl = results.categories.nl?.arms;
  const criteria = [];

  for (const arm of ['C1', 'C2']) {
    const measurable = hybridMeasurable;
    const armNl = nl?.[arm];
    const c0Nl = nl?.C0;
    criteria.push({
      arm,
      discriminable: measurable,
      minimumEffect: measurable && armNl && c0Nl ? armNl.mrr >= c0Nl.mrr + 0.05 : null,
      exactGuard:
        measurable && exact?.[arm] && exact?.C0 ? exact[arm].selfR1 >= exact.C0.selfR1 : null,
      mrrDelta: armNl && c0Nl ? armNl.mrr - c0Nl.mrr : null,
    });
  }

  const anyMeasurable = criteria.some((c) => c.discriminable);
  return {
    rule: 'docs/program/wp4-implementation-spec.md §10.5',
    verdict: anyMeasurable
      ? 'evaluated'
      : 'no-change — the hybrid arms were not measurable, and §10.5 step 6 biases a tie toward no change; step 7: a negative result ships as a negative result',
    criteria,
    note: anyMeasurable
      ? null
      : 'criteria 1-3 are reported as null rather than false: they are NOT CHECKABLE here, and a null read as a pass would be the failure §8.6 exists to prevent',
  };
}

// ─────────────────────────────────────────────────────────────── run

const unknown = CATEGORIES.filter((c) => !ALL_CATEGORIES.includes(c));
if (unknown.length > 0) {
  process.stderr.write(
    `unknown category: ${unknown.join(', ')} (known: ${ALL_CATEGORIES.join(', ')})\n`,
  );
  process.exit(EXIT.UNAVAILABLE);
}

if (CATEGORIES.includes('exact')) results.categories.exact = runExact();
if (CATEGORIES.includes('nl')) results.categories.nl = runNl();
if (CATEGORIES.includes('cross-file')) results.categories['cross-file'] = runCrossFile();
if (CATEGORIES.includes('rename')) results.categories.rename = runRename();
if (CATEGORIES.includes('dependency')) results.categories.dependency = runDependency();
if (DECIDE) results.decision = decide();

store.close();

results.limits = [
  'The nl and cross-file arms reuse a corpus DUPLICATED from scripts/eval/code-vector-eval.mjs, which cannot be imported because it evaluates on import. CASES.length is asserted at 20 so the size cannot drift silently; the entries themselves are not mechanically compared.',
  'The exact arm samples the id-sorted symbol list at a fixed stride. The stride, the eligible count and the ambiguity ceiling are all reported so a low R@1 is attributable rather than mysterious.',
  'The primary natural-language arm (§8.2, the 61-task corpus) is scored by `locate-eval.mjs`, not here — this harness scores the 20-case corpus so the ARMS can be compared on one corpus.',
];

// ─────────────────────────────────────────────────────────────── report

function textReport() {
  const L = [];
  L.push('');
  L.push(`code retrieval — 5 categories, k=${K}`);
  L.push(`  index ${DB}`);
  L.push(
    `  vector channel: ${results.index.vector ? 'PRESENT' : 'ABSENT'}${results.index.vectorNote ? ` — ${results.index.vectorNote}` : ''}`,
  );
  L.push('');
  L.push('  arms');
  for (const [id, a] of Object.entries(results.arms)) {
    L.push(`    ${id} ${a.name.padEnd(20)} ${a.status}${a.reason ? ` — ${a.reason}` : ''}`);
  }

  const ex = results.categories.exact;
  if (ex) {
    L.push('');
    L.push('  exact-symbol');
    L.push(
      `    universe ${ex.universe.symbols} symbols · ${ex.universe.distinctNames} distinct names`,
    );
    L.push(
      `    ${ex.universe.namesBorneByMultipleSymbols} names shared by >1 symbol, covering ${ex.universe.symbolsSharingAName} symbols`,
    );
    L.push(`    sampled ${ex.universe.sampled} at stride ${ex.universe.stride}`);
    for (const [variant, v] of Object.entries(ex.variants)) {
      L.push(
        `    variant ${variant} — selfR@1 ceiling ${pct(v.selfR1Ceiling)} (${v.queryStringsBorneByMultipleSymbols} query strings shared)`,
      );
      for (const [arm, m] of Object.entries(v.arms)) {
        L.push(
          `      ${arm}  selfR@1 ${pct(m.selfR1)}  selfR@${K} ${pct(m.selfRAtK)}  fileR@1 ${pct(m.fileR1)}  MRR ${m.mrr.toFixed(4)}`,
        );
      }
    }
  }

  const nl = results.categories.nl;
  if (nl) {
    L.push('');
    L.push(`  nl (${nl.corpus.name}) — arm-split; primary 61-task arm is locate-eval.mjs`);
    for (const [arm, m] of Object.entries(nl.arms)) {
      L.push(`    ${arm}  R@1 ${pct(m.r1)}  R@${K} ${pct(m.rAtK)}  MRR ${m.mrr.toFixed(4)}`);
    }
  }

  const cf = results.categories['cross-file'];
  if (cf) {
    L.push('');
    L.push(`  cross-file (${cf.grain})`);
    for (const [arm, m] of Object.entries(cf.arms)) {
      L.push(
        `    ${arm}  R@${K} ${pct(m.rAtK)}  MRR ${m.mrr.toFixed(4)}  all-files-covered ${pct(m.allFilesCoveredRate)}`,
      );
    }
  }

  const rn = results.categories.rename;
  if (rn) {
    L.push('');
    L.push('  rename');
    if (rn.status === 'underpowered') {
      L.push(`    UNDERPOWERED — n=${rn.n} (min ${rn.minTasks}). NO METRIC: §8.4 step 5.`);
      if (rn.composition) {
        const c = rn.composition;
        L.push(
          `    composition: ${c.source} source · ${c.derived} derived · ${c.docs} docs · ${c.other} other`,
        );
      }
    } else if (rn.status === 'unavailable') {
      L.push(`    UNAVAILABLE — ${rn.reason}`);
    } else {
      for (const [arm, m] of Object.entries(rn.arms)) {
        L.push(
          `    ${arm}  newSiteR@1 ${pct(m.newSiteR1)}  newSiteMRR ${m.newSiteMrr.toFixed(4)}  oldSiteAtTop ${pct(m.oldSiteAtTopRate)} (tripwire)`,
        );
      }
    }
  }

  const dep = results.categories.dependency;
  if (dep) {
    L.push('');
    L.push('  dependency');
    if (dep.status === 'unavailable') {
      L.push(`    UNAVAILABLE — ${dep.reason}`);
    } else {
      for (const row of dep.table) {
        L.push(
          `    ${row.method.padEnd(14)} R@1 ${pct(row.recall1)}  MRR ${row.mrr.toFixed(4)}  lift ${row.liftOverBlind.toFixed(2)}`,
        );
      }
    }
  }

  if (results.decision) {
    L.push('');
    L.push('  §10.5 decision');
    L.push(`    ${results.decision.verdict}`);
    for (const c of results.decision.criteria) {
      L.push(
        `    ${c.arm}: discriminable=${c.discriminable} minimumEffect=${c.minimumEffect} exactGuard=${c.exactGuard}`,
      );
    }
    if (results.decision.note) L.push(`    ${results.decision.note}`);
  }

  L.push('');
  L.push('  limits');
  for (const l of results.limits) L.push(`    - ${l}`);
  L.push('');
  return L.join('\n');
}

process.stdout.write(AS_JSON ? `${JSON.stringify(results, null, 2)}\n` : textReport());

// ─────────────────────────────────────────────────────────────── exit code

const ran = Object.keys(results.categories);
if (REQUIRE.length > 0) {
  const missing = REQUIRE.filter((c) => !ran.includes(c));
  if (missing.length > 0) {
    process.stderr.write(`required category not run: ${missing.join(', ')}\n`);
    process.exit(EXIT.UNAVAILABLE);
  }
  // A required category that is UNMEASURABLE is UNAVAILABLE, not FAIL — including when the index
  // simply has no vectors. "The channel could not be measured" is a different fact from "it is worse".
  const blocked = REQUIRE.filter((c) => {
    const r = results.categories[c];
    return r.status === 'unavailable' || r.status === 'underpowered';
  });
  if (blocked.length > 0) {
    process.stderr.write(
      `required category could not be measured: ${blocked
        .map((c) => `${c} (${results.categories[c].status})`)
        .join(', ')}\n`,
    );
    process.exit(EXIT.UNAVAILABLE);
  }
}
process.exit(EXIT.PASS);
