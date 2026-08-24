#!/usr/bin/env node
/**
 * Semantic retrieval gate — does asking a real question return the file that answers it?
 *
 * Held-out questions an engineer actually asks, each scored against EVERY file that legitimately
 * answers it. The expected answers were written by reading the code, not by reading the ranking,
 * so this measures retrieval rather than measuring itself.
 *
 * This exists because coverage metrics lie. `brief.coverage` reported 100% while the top hit for
 * "how do I debug a parser that hangs" was an unrelated Rust fixture: it counts hits that carry
 * prose, and once most files are described a symbol inherits its file's purpose whether or not it
 * is relevant. Only an answer-level measurement catches that.
 *
 * Baselines on this repo (see `fuseSemantic` for why alternating beat reciprocal-rank fusion):
 *   keyword only ....... top-1 10%   top-3 10%   MRR 0.147
 *   alternating ........ top-1 85%   top-3 90%   MRR 0.873
 *
 * Usage: node scripts/eval/semantic-retrieval-eval.mjs [--min-mrr 0.75]
 * Exits non-zero when MRR falls below the floor, so a ranking regression fails the build.
 */
import * as core from '../../packages/core/dist/index.js';
import { Verbs } from '../../packages/mcp/dist/verbs.js';
const R = process.cwd();
const soul = new core.SoulStore(R + '/.crib');
soul.load();
const index = new core.SqliteIndexStore(R + '/.crib/index/crib.sqlite');
const v = new Verbs({ soul, index, repoRoot: R });

const CASES = [
  // Each case lists EVERY file that legitimately answers the question. A single expected answer
  // punished correct results: "how is a claim proven against real code" is answered by the memory
  // grounding module as truly as by the enrichment one.
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

function rankOf(q, wants) {
  const r = v.brief({ q, maxTokens: 4000 });
  const ids = r.codeHits.map((h) => h.id);
  for (let i = 0; i < ids.length; i++) if (wants.some((w) => ids[i].includes(w))) return i + 1;
  return 0;
}
let top1 = 0,
  top3 = 0,
  top10 = 0,
  mrrSum = 0;
const misses = [];
for (const [q, want] of CASES) {
  const rank = rankOf(q, want);
  if (rank === 1) top1++;
  if (rank >= 1 && rank <= 3) top3++;
  if (rank >= 1) {
    top10++;
    mrrSum += 1 / rank;
  } else misses.push(q + '  -> want ' + want.join(' | '));
}
const n = CASES.length;
console.log('questions        :', n);
console.log('answer at rank 1 :', top1, '(' + Math.round((100 * top1) / n) + '%)');
console.log('answer in top 3  :', top3, '(' + Math.round((100 * top3) / n) + '%)');
console.log('answer in top 10 :', top10, '(' + Math.round((100 * top10) / n) + '%)');
console.log('MRR              :', (mrrSum / n).toFixed(3));
if (misses.length) {
  console.log('\nnot found at all:');
  for (const m of misses) console.log('  ' + m);
}

const argIdx = process.argv.indexOf('--min-mrr');
const floor = argIdx >= 0 ? Number.parseFloat(process.argv[argIdx + 1]) : 0.75;
const mrr = mrrSum / n;
if (!Number.isFinite(floor)) {
  console.error('--min-mrr needs a number');
  process.exit(2);
}
if (mrr < floor) {
  console.error(`\nFAIL: MRR ${mrr.toFixed(3)} is below the floor of ${floor}.`);
  console.error('Retrieval got worse. Re-run after enriching, or investigate the ranking change.');
  process.exit(1);
}
console.log(`\nOK: MRR ${mrr.toFixed(3)} >= floor ${floor}`);
