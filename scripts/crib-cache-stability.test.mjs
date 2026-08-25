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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI = resolve('packages/cli/dist/cli.js');
const DERIVED_INDEX = resolve('.crib/index/crib.sqlite');

function query(args) {
  return execFileSync(process.execPath, [CLI, 'query', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // drop the SQLite experimental-warning on stderr
    maxBuffer: 64 * 1024 * 1024,
  });
}

// The derived SQLite index (.crib/index/crib.sqlite) is a gitignored build artifact projected from
// the committed JSONL soul — a fresh CI checkout has none, so `crib query` returns NOT_INDEXED (3)
// and every assertion below is meaningless. Build it once here if absent; subsequent queries are
// fast. release:verify does the same `crib index .` before running this gate locally.
if (!existsSync(DERIVED_INDEX)) {
  execFileSync(process.execPath, [CLI, 'index', '.'], {
    stdio: 'inherit',
    timeout: 8 * 60_000, // full repo re-parse is ~132s locally; allow headroom on slower CI runners
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

// 3. The tiered default stays lean: the bulky analysis+graph+evidence blob may only materialize
// under --with-llm, never in the default tier.
//
// This previously asserted that `llm` was ABSENT entirely, which is stricter than the contract
// `attachLlm` documents: the default tier deliberately folds a LIGHTWEIGHT pointer (provenance,
// confidence, one-line purpose) so a hit can signal that an analysis exists without paying for it.
// That assertion only held because the repo had no authored artifacts — it was passing vacuously,
// and started failing the moment any existed. It now checks the property that was actually meant,
// plus a hard byte ceiling so the "lightweight" pointer cannot quietly grow into the blob it exists
// to avoid.
const MAX_POINTER_BYTES = 600;
{
  const parsed = JSON.parse(query(['cmdIndex', '--limit', '5']));
  assert.deepEqual(parsed.llmHits ?? [], [], 'default tier must not ship llm projections');
  for (const hit of parsed.hits) {
    assert.ok(
      !('analysis' in hit) && !('projection' in hit),
      `default-tier hit ${hit.id} must not embed an llm blob`,
    );
    if (hit.llm !== undefined) {
      for (const bulky of ['analysis', 'graph', 'evidence']) {
        assert.ok(
          !(bulky in hit.llm),
          `default-tier hit ${hit.id} llm pointer must not carry \`${bulky}\``,
        );
      }
      const bytes = Buffer.byteLength(JSON.stringify(hit.llm), 'utf8');
      assert.ok(
        bytes <= MAX_POINTER_BYTES,
        `default-tier llm pointer for ${hit.id} is ${bytes} bytes, over the ${MAX_POINTER_BYTES}-byte ceiling`,
      );
    }
  }
}

console.log('crib cache-stability tests ok');
