/**
 * Cache-stability contract test (the money lever). The crib cost advantage is real ONLY if the
 * context crib injects is byte-identical across turns — a stable prompt prefix stays in the model's
 * cache and re-reads at the 0.1x cache-read rate; any drift (reordering, a timestamp, a floating
 * score formatted differently) invalidates the cache and re-prices the whole block at the 1.25x
 * cache-write rate, silently erasing the win the cost harness claims.
 *
 * This test pins the properties the harness's `stable: true` assumption depends on:
 *   1. Determinism      — same query, fresh process, byte-identical output.
 *   2. Prefix stability — a broader query's output is a stable PREFIX-extension of a narrower one's
 *                          (adding a --limit does not reshuffle the head), so the cached prefix holds.
 *   3. Tiered default   — the default tier ships NO llm projection blob (that only appears under
 *                          --with-llm), keeping the cache-resident prefix small.
 *
 * Runs against this repo's own committed .crib soul. `node scripts/crib-cache-stability.test.mjs`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve('packages/cli/dist/cli.js');

function query(args) {
  return execFileSync(process.execPath, [CLI, 'query', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // drop the SQLite experimental-warning on stderr
    maxBuffer: 64 * 1024 * 1024,
  });
}

// 1. Determinism across fresh processes — the precondition for any cache hit at all.
{
  const a = query(['SoulStore', '--limit', '5']);
  const b = query(['SoulStore', '--limit', '5']);
  assert.equal(a, b, 'identical query must produce byte-identical output across processes');
  assert.equal(
    Buffer.byteLength(a, 'utf8'),
    Buffer.byteLength(b, 'utf8'),
    'byte length must be stable',
  );
}

// 2. Prefix stability — growing the result window must not reorder the head. If the top-K of a
// limit-3 query is not the head of the limit-8 query, the cached prefix from an earlier turn breaks.
{
  const narrow = JSON.parse(query(['Verbs', '--limit', '3']));
  const wide = JSON.parse(query(['Verbs', '--limit', '8']));
  const headIds = wide.hits.slice(0, narrow.hits.length).map((h) => h.id);
  const narrowIds = narrow.hits.map((h) => h.id);
  assert.deepEqual(
    narrowIds,
    headIds,
    'the narrow result must be the stable head of the wider result (no reshuffle)',
  );
}

// 3. Tiered default carries no llm projection — keeps the cache-resident prefix lean. The bulky
// analysis blob must only materialize under --with-llm (llmHits), never in the default tier.
{
  const parsed = JSON.parse(query(['cmdIndex', '--limit', '5']));
  assert.deepEqual(parsed.llmHits ?? [], [], 'default tier must not ship llm projections');
  for (const hit of parsed.hits) {
    assert.ok(
      !('analysis' in hit) && !('projection' in hit) && !('llm' in hit),
      `default-tier hit ${hit.id} must not embed an llm blob`,
    );
  }
}

console.log('crib cache-stability tests ok');
