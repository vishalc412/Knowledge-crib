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
]) {
  assert.match(
    budgetCheck,
    new RegExp(required),
    `budget-check.mjs must enforce the ${required} budget`,
  );
}

console.log('budget-check wiring tests ok');
