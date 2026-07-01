import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const releaseVerifier = readFileSync('scripts/release-verify.mjs', 'utf8');
assert.match(
  releaseVerifier,
  /budget:check/,
  'release gate must run the lightweight-budget gate (budget-check.mjs)',
);

const budgetCheck = readFileSync('scripts/budget-check.mjs', 'utf8');
for (const required of [
  'MAX_RUNTIME_DEPS',
  'MAX_PACKAGE_BYTES',
  'MAX_PARSERS_PACKAGE_BYTES',
  'MAX_DEFAULT_HIT_BYTES',
  'MAX_QUERY_P50_MS',
  'MAX_INDEX_MS',
  'MIN_COST_SAVING',
]) {
  assert.match(
    budgetCheck,
    new RegExp(required),
    `budget-check.mjs must enforce the ${required} budget`,
  );
}

// The cost gate and the public benchmark must price tokens from the SAME model, or CI could pass a
// cost floor the published benchmark contradicts.
assert.match(
  budgetCheck,
  /from '\.\/lib\/pricing\.mjs'/,
  'cost gate must use the shared pricing model',
);
const bench = readFileSync('scripts/crib-bench.mjs', 'utf8');
assert.match(bench, /from '\.\/lib\/pricing\.mjs'/, 'benchmark must use the shared pricing model');

console.log('budget-check wiring tests ok');
