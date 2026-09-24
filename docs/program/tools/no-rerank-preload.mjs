// Measurement-only preload for the rerank-prior decision (docs/bench/rerank-prior.md): forces the
// hybrid query path to skip the M2.2 structural prior (arm C2) while everything else stays the
// shipped `crib query` path. It patches the SAME core module instance the CLI imports, because Node
// caches ES modules by resolved path.
//
//   NODE_OPTIONS="--import ./docs/program/tools/no-rerank-preload.mjs" \
//     node scripts/bench/locate-eval.mjs --base-tree <vectorised tree> --arm c1 --json
//
// locate-eval still labels the run `c1-hybrid-rrf-rerank`, because that label describes the tree's
// index, not the query options. Read the result as C2 and file it as C2.
import { SqliteIndexStore } from '../../../packages/core/dist/index.js';

const shipped = SqliteIndexStore.prototype.query;
SqliteIndexStore.prototype.query = function queryWithoutPrior(q) {
  return shipped.call(this, { ...q, rerank: false });
};
