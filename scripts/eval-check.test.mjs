import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mean, mrr, ndcgAtK, recallAtK, scorePair } from './eval/metrics.mjs';

// 1. The regression gate must be wired into the release sequence, right after budget:check.
const releaseVerifier = readFileSync('scripts/release-verify.mjs', 'utf8');
assert.match(
  releaseVerifier,
  /eval:check/,
  'release gate must run the retrieval-eval regression gate (eval-check.mjs)',
);
assert.match(
  releaseVerifier,
  /semantic:check/,
  'release gate must run the M2.1 hybrid-recall gate (semantic-check.mjs)',
);
assert.match(
  releaseVerifier,
  /rerank:check/,
  'release gate must run the M2.2 graph-aware-rerank gate (rerank-check.mjs)',
);
assert.match(
  releaseVerifier,
  /linker:check/,
  'release gate must run the M2.3 embedding-linker recall-up gate (linker-check.mjs)',
);
assert.match(
  releaseVerifier,
  /alias:check/,
  'release gate must run the M2.4 alias-dictionary gate (alias-check.mjs)',
);
assert.match(
  releaseVerifier,
  /js-coverage:check/,
  'release gate must run the M2.5 plain-JS coverage gate (js-coverage-check.mjs)',
);
assert.match(
  releaseVerifier,
  /ifhash:check/,
  'release gate must run the M2.6 ifHash change-aware cache gate (ifhash-check.mjs)',
);
assert.match(
  releaseVerifier,
  /tier:check/,
  'release gate must run the M2.7 model-tier-hints gate (tier-check.mjs)',
);
assert.match(
  releaseVerifier,
  /ownership:check/,
  'release gate must run the M3.1 ownership gate (ownership-check.mjs)',
);
assert.match(
  releaseVerifier,
  /federation:check/,
  'release gate must run the M3.2 cross-repo federation gate (federation-check.mjs)',
);
assert.match(
  releaseVerifier,
  /stats:check/,
  'release gate must run the M3.3 server-observability gate (stats-check.mjs)',
);
assert.match(
  releaseVerifier,
  /parallel:check/,
  'release gate must run the M3.4 parallel-parse gate (parallel-check.mjs)',
);
assert.match(
  releaseVerifier,
  /fuzz:check/,
  'release gate must run the M3.5 parser-fuzz gate (fuzz-check.mjs)',
);
assert.match(
  releaseVerifier,
  /scale:check/,
  'release gate must run the M3.6 scale-bench gate (scale-bench.mjs)',
);
assert.match(
  releaseVerifier,
  /security:check/,
  'release gate must run the M3.7 threat-model + access-model doc gate (security-doc-check.mjs)',
);
assert.match(
  releaseVerifier,
  /soul-refresh:check/,
  'release gate must run the M4.3 crib-soul-refresh idempotence gate (soul-refresh-check.mjs)',
);
assert.match(
  releaseVerifier,
  /onboarding:check/,
  'release gate must run the M4.2 crib init + doctor onboarding gate (onboarding-check.mjs)',
);
assert.match(
  releaseVerifier,
  /docs-site:check/,
  'release gate must run the M4.4 docs site + stats drift gate (docs-site-check.mjs)',
);
const pkg = readFileSync('package.json', 'utf8');
assert.match(
  pkg,
  /"semantic:check":\s*"node scripts\/semantic-check\.mjs"/,
  'package.json must define semantic:check',
);
assert.match(
  pkg,
  /"rerank:check":\s*"node scripts\/rerank-check\.mjs"/,
  'package.json must define rerank:check',
);
assert.match(
  pkg,
  /"linker:check":\s*"node scripts\/linker-check\.mjs"/,
  'package.json must define linker:check',
);
assert.match(
  pkg,
  /"alias:check":\s*"node scripts\/alias-check\.mjs"/,
  'package.json must define alias:check',
);
assert.match(
  pkg,
  /"js-coverage:check":\s*"node scripts\/js-coverage-check\.mjs"/,
  'package.json must define js-coverage:check',
);
assert.match(
  pkg,
  /"ifhash:check":\s*"node scripts\/ifhash-check\.mjs"/,
  'package.json must define ifhash:check',
);
assert.match(
  pkg,
  /"tier:check":\s*"node scripts\/tier-check\.mjs"/,
  'package.json must define tier:check',
);
assert.match(
  pkg,
  /"ownership:check":\s*"node scripts\/ownership-check\.mjs"/,
  'package.json must define ownership:check',
);
assert.match(
  pkg,
  /"federation:check":\s*"node scripts\/federation-check\.mjs"/,
  'package.json must define federation:check',
);
assert.match(
  pkg,
  /"stats:check":\s*"node scripts\/stats-check\.mjs"/,
  'package.json must define stats:check',
);
assert.match(
  pkg,
  /"parallel:check":\s*"node scripts\/parallel-check\.mjs"/,
  'package.json must define parallel:check',
);
assert.match(
  pkg,
  /"fuzz:check":\s*"node scripts\/fuzz-check\.mjs"/,
  'package.json must define fuzz:check',
);
assert.match(
  pkg,
  /"fuzz:nightly":\s*"node scripts\/fuzz-check\.mjs --iterations 1000000"/,
  'package.json must define fuzz:nightly (10^6 iters/extractor)',
);
assert.match(
  pkg,
  /"scale:check":\s*"node scripts\/scale-bench\.mjs --slice 20000 --out \/tmp\/crib-scale-gate\.md"/,
  'package.json must define scale:check (M3.6 harness smoke, throwaway out path)',
);
assert.match(
  pkg,
  /"scale:nightly":\s*"node scripts\/scale-bench\.mjs --slices 10000,100000,500000,1000000"/,
  'package.json must define scale:nightly (full 1M-LOC curve)',
);
assert.match(
  pkg,
  /"security:check":\s*"node scripts\/security-doc-check\.mjs"/,
  'package.json must define security:check (M3.7 threat-model + access-model doc gate)',
);
assert.match(
  pkg,
  /"soul-refresh:check":\s*"node scripts\/soul-refresh-check\.mjs"/,
  'package.json must define soul-refresh:check (M4.3 crib-soul-refresh idempotence gate)',
);
assert.match(
  pkg,
  /"onboarding:check":\s*"node scripts\/onboarding-check\.mjs"/,
  'package.json must define onboarding:check (M4.2 crib init + doctor onboarding gate)',
);
assert.match(
  pkg,
  /"docs:stats":\s*"node scripts\/docs-stats\.mjs"/,
  'package.json must define docs:stats (M4.4 canonical stats generator)',
);
assert.match(
  pkg,
  /"docs:build":\s*"node scripts\/docs-site-build\.mjs"/,
  'package.json must define docs:build (M4.4 docs site generator)',
);
assert.match(
  pkg,
  /"docs-site:check":\s*"node scripts\/docs-site-check\.mjs"/,
  'package.json must define docs-site:check (M4.4 docs site + stats drift gate)',
);
const rerankCheck = readFileSync('scripts/rerank-check.mjs', 'utf8');
assert.match(rerankCheck, /MIN_MRR_LIFT/, 'rerank-check.mjs must enforce an MRR-improvement floor');
assert.match(
  rerankCheck,
  /runEval/,
  'rerank-check.mjs must drive the eval harness in semantic mode',
);
assert.match(rerankCheck, /deterministic/i, 'rerank-check.mjs must assert determinism across runs');
const linkerCheck = readFileSync('scripts/linker-check.mjs', 'utf8');
assert.match(
  linkerCheck,
  /runSemanticLink/,
  'linker-check.mjs must drive both semantic-linker backends via runSemanticLink',
);
assert.match(
  linkerCheck,
  /'embedding'|'tfidf'/,
  'linker-check.mjs must run both embedding and tfidf modes',
);
assert.match(linkerCheck, /deterministic/i, 'linker-check.mjs must assert determinism across runs');
const aliasCheck = readFileSync('scripts/alias-check.mjs', 'utf8');
assert.match(
  aliasCheck,
  /writeAliases/,
  'alias-check.mjs must author the alias dictionary via writeAliases',
);
assert.match(
  aliasCheck,
  /DebtToIncomeCalculator/,
  'alias-check.mjs must target the camelCase class the alias case is built around',
);
assert.match(aliasCheck, /deterministic/i, 'alias-check.mjs must assert determinism across runs');
const jsCoverageCheck = readFileSync('scripts/js-coverage-check.mjs', 'utf8');
assert.match(
  jsCoverageCheck,
  /\.js.*\.jsx.*\.mjs.*\.cjs|js-coverage/,
  'js-coverage-check.mjs must cover the JS file family (.js/.jsx/.mjs/.cjs)',
);
assert.match(
  jsCoverageCheck,
  /indexRepo/,
  'js-coverage-check.mjs must drive the pipeline indexRepo over the plain-js fixture',
);
assert.match(
  jsCoverageCheck,
  /deterministic/i,
  'js-coverage-check.mjs must assert determinism across indexes',
);
const ifhashCheck = readFileSync('scripts/ifhash-check.mjs', 'utf8');
assert.match(
  ifhashCheck,
  /unchanged/,
  'ifhash-check.mjs must assert the unchanged:true collapse on a matching ifHash',
);
assert.match(
  ifhashCheck,
  /Verbs/,
  'ifhash-check.mjs must drive the verbs (context/source/dossier) over a built soul',
);
assert.match(
  ifhashCheck,
  /deterministic/i,
  'ifhash-check.mjs must assert determinism across full calls',
);
assert.match(
  ifhashCheck,
  /0\.1|10%/,
  'ifhash-check.mjs must enforce a measurable size-drop floor (the token-cost gate)',
);
const tierCheck = readFileSync('scripts/tier-check.mjs', 'utf8');
assert.match(
  tierCheck,
  /suggestedTier/,
  'tier-check.mjs must assert enrich_next items carry suggestedTier',
);
assert.match(
  tierCheck,
  /enrichNext/,
  'tier-check.mjs must drive the real Verbs.enrichNext surface over a built soul',
);
assert.match(tierCheck, /'fast'|fast/, 'tier-check.mjs must pin the symbol→fast mapping');
assert.match(
  tierCheck,
  /'balanced'/,
  'tier-check.mjs must pin the skeleton-system→balanced mapping',
);
assert.match(tierCheck, /perItem/, 'tier-check.mjs must assert costEstimate.perItem carries tier');
assert.match(
  tierCheck,
  /SKILL\.md|skills\/crib-enrich/,
  'tier-check.mjs must assert the crib-enrich SKILL documents the cost model',
);
const ownershipCheck = readFileSync('scripts/ownership-check.mjs', 'utf8');
assert.match(
  ownershipCheck,
  /indexRepo/,
  'ownership-check.mjs must drive the real indexRepo pipeline (not a hand-built fixture)',
);
assert.match(
  ownershipCheck,
  /owned-by/,
  'ownership-check.mjs must assert owned-by edges are emitted',
);
assert.match(
  ownershipCheck,
  /EXTRACTED/,
  'ownership-check.mjs must assert owned-by edges are EXTRACTED provenance',
);
assert.match(
  ownershipCheck,
  /git blame|git.*blame|blame/,
  'ownership-check.mjs must pin the git-blame → owned-by intent',
);
assert.match(
  ownershipCheck,
  /verbs\.ownership|\.ownership\(/,
  'ownership-check.mjs must drive the ownership MCP verb',
);
const federationCheck = readFileSync('scripts/federation-check.mjs', 'utf8');
// Wiring assertions anchored to EXECUTABLE call-site syntax, not bare words — a bare /indexRepo/
// matches the header doc comment, so a stub that deleted every real call but kept the comment would
// pass. These require an actual awaited call / invocation / field access, so a gutted no-op stub fails.
assert.match(
  federationCheck,
  /await indexRepo\(/,
  'federation-check.mjs must AWAIT the real indexRepo pipeline call (not just mention it in a comment)',
);
assert.match(
  federationCheck,
  /loadFederation\(\[/,
  'federation-check.mjs must call loadFederation with a roots array (load a federation of souls)',
);
assert.match(
  federationCheck,
  /federatedImpact\(fed/,
  'federation-check.mjs must call the federatedImpact traversal with the loaded federation',
);
assert.match(
  federationCheck,
  /kind === 'http-call'/,
  'federation-check.mjs must assert http-call nodes (the schema 1.5 call site) by kind check',
);
assert.match(
  federationCheck,
  /\.crossRepo\b/,
  'federation-check.mjs must read the .crossRepo field (assert the cross-repo hop is flagged)',
);
assert.match(
  federationCheck,
  /soul\.getNode\(e\.src\)|soul\.getNode\(e\.dst\)/,
  'federation-check.mjs must verify no committed cross-repo edge by resolving every edge endpoint in-soul',
);
const statsCheck = readFileSync('scripts/stats-check.mjs', 'utf8');
assert.match(
  statsCheck,
  /await indexRepo\(/,
  'stats-check.mjs must AWAIT the real indexRepo pipeline (drive the real Verbs surface, not a stub)',
);
assert.match(
  statsCheck,
  /verbs\.getStats\(\)\.snapshot\(\)/,
  'stats-check.mjs must read the live snapshot via verbs.getStats().snapshot()',
);
assert.match(
  statsCheck,
  /verbs\.context\(/,
  'stats-check.mjs must drive a real verb (context) to populate per-verb counts',
);
assert.match(
  statsCheck,
  /ifHash/,
  'stats-check.mjs must exercise the ifHash cache hit/miss path for the cache hit rate',
);
assert.match(
  statsCheck,
  /applyIfHash/,
  'stats-check.mjs must assert the private applyIfHash helper is NOT counted as a verb',
);
const semanticCheck = readFileSync('scripts/semantic-check.mjs', 'utf8');
assert.match(semanticCheck, /MIN_RECOVERY/, 'semantic-check.mjs must enforce a recovery floor');
assert.match(
  semanticCheck,
  /runEval/,
  'semantic-check.mjs must drive the eval harness in semantic mode',
);

// 2. The gate must define the regression ceiling + the metrics it tracks + the baseline path.
const evalCheck = readFileSync('scripts/eval-check.mjs', 'utf8');
assert.match(
  evalCheck,
  /MAX_REGRESSION_PCT/,
  'eval-check.mjs must enforce a MAX_REGRESSION_PCT ceiling',
);
assert.match(evalCheck, /recall10/, 'eval-check.mjs must track recall10');
assert.match(evalCheck, /mrr/, 'eval-check.mjs must track MRR');
assert.match(evalCheck, /ndcg10/, 'eval-check.mjs must track nDCG@10');
assert.match(
  evalCheck,
  /eval-baseline\.json/,
  'eval-check.mjs must compare against scripts/eval-baseline.json',
);

// 3. The harness must cover every fixture language family.
const harness = readFileSync('scripts/eval/harness.mjs', 'utf8');
for (const lang of ['go', 'python', 'rust', 'ts', 'ts-min', 'java', 'php', 'csharp', 'plsql']) {
  assert.match(harness, new RegExp(`'${lang}'`), `harness must cover the ${lang} fixture`);
}
assert.match(harness, /FIXTURE_LANGS/, 'harness must declare the fixture language list');

// 4. Metrics correctness on a known input — the eval gate is only meaningful if the metrics
//    themselves are right. Pin the definitions so a future refactor can't silently break them.
//    retrieved = [a, b, c, d, e], expected = [c, e, z] → 2 relevant, top-10 window.
{
  const retrieved = ['a', 'b', 'c', 'd', 'e'];
  const expected = ['c', 'e', 'z'];
  assert.equal(recallAtK(retrieved, expected, 10), 2 / 3, 'recall@10 = 2 of 3 expected present');
  assert.equal(recallAtK(retrieved, expected, 3), 1 / 3, 'recall@3 = only c is in the top 3');
  assert.equal(
    mrr(retrieved, expected),
    1 / 3,
    'MRR = 1/rank(c)=1/3, c is the first expected at rank 3',
  );
  // nDCG@10: 3 relevant (c,e,z); ideal ranks them 1,2,3 → IDCG = 1/log2(2)+1/log2(3)+1/log2(4)
  // actual  = c at rank3, e at rank5 → DCG = 1/log2(4) + 1/log2(6) = 0.5 + 0.38685
  const dcg = 1 / Math.log2(4) + 1 / Math.log2(6);
  const idcg = 1 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4);
  assert.ok(
    Math.abs(ndcgAtK(retrieved, expected, 10) - dcg / idcg) < 1e-12,
    'nDCG@10 matches the binary-relevance DCG/IDCG ratio',
  );
  assert.equal(mrr(['x', 'y'], expected), 0, 'MRR is 0 when no expected id is retrieved');
  assert.equal(recallAtK(retrieved, [], 10), 0, 'recall is 0 (not 1) when expected is empty');
  assert.equal(ndcgAtK(retrieved, [], 10), 0, 'nDCG is 0 when expected is empty');
  assert.equal(mean([]), 0, 'mean of empty is 0 (no divide-by-zero)');
  assert.equal(mean([1, 2, 3]), 2, 'mean of [1,2,3] is 2');
  const s = scorePair(retrieved, expected, 10);
  assert.ok(
    Math.abs(s.recall - 2 / 3) < 1e-12 && Math.abs(s.mrr - 1 / 3) < 1e-12,
    'scorePair bundles recall + MRR',
  );
}

// 5. The conceptual pack must be non-empty (the hand-curated set the plan calls for).
const conceptual = readFileSync('scripts/eval/conceptual.mjs', 'utf8');
assert.match(conceptual, /CONCEPTUAL_PACKS/, 'conceptual.mjs must export CONCEPTUAL_PACKS');
assert.match(
  conceptual,
  /assess_application/,
  'conceptual packs must cover the PL/SQL loan rule engine',
);
assert.match(
  conceptual,
  /AssessApplication/,
  'conceptual packs must cover the C# loan rule engine',
);

console.log('eval-check wiring tests ok');
