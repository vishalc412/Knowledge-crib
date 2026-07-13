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
