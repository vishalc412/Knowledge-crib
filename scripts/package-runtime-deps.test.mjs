import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pipeline = JSON.parse(readFileSync('packages/pipeline/package.json', 'utf8'));

assert.ok(
  pipeline.dependencies?.typescript,
  '@knowledge-crib/pipeline imports typescript at runtime and must publish it as a dependency',
);

console.log('package-runtime-deps tests ok');
