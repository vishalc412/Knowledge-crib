import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { smokeCli } from './release-cli-smoke.mjs';

const status = smokeCli();

assert.equal(status.indexed, true, 'smoke project must be indexed');
assert.equal(status.schemaVersion, '1.4', 'smoke project must use the current schema');
assert.ok(status.stats.nodes > 0, 'smoke project must contain extracted nodes');

const releaseVerifier = readFileSync('scripts/release-verify.mjs', 'utf8');
assert.match(
  releaseVerifier,
  /release-cli-smoke\.mjs/,
  'release gate must run the hermetic CLI smoke project',
);
assert.doesNotMatch(
  releaseVerifier,
  /\['packages\/cli\/dist\/cli\.js', 'status', '\.'\]/,
  'release gate must not depend on a machine-local derived index',
);

console.log('release-cli-smoke tests ok');
