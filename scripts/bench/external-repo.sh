#!/bin/bash
# Run the localisation benchmark against an EXTERNAL repository, end to end.
#
# Why external repos are the point: a corpus built from this repository's own history has one dominant
# author and a churn-concentrated tree, which raises the query-blind floor and makes the measurement a
# weak discriminator. A foreign repository with many authors and flat churn is where a retrieval claim
# either survives or does not — and running one is what found the CommonJS extraction gap that was
# costing express 50% of its symbols.
#
# It clones and INDEXES third-party source. It never executes it: crib parses with tree-sitter and the
# TypeScript compiler API, and the only commands run inside the clone are `git` and `rg`.
#
# usage: scripts/bench/external-repo.sh <git-url> <name> [depth]
set -u
URL="$1"; NAME="$2"; DEPTH="${3:-300}"
CRIB_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="${CRIB_BENCH_DIR:-/tmp/crib-bench-ext}"
mkdir -p "$EXT"
cd "$CRIB_ROOT" || exit 1

if [ ! -d "$EXT/$NAME/.git" ]; then
  echo "── cloning $NAME"
  git clone --quiet "$URL" "$EXT/$NAME" || exit 1
fi

echo "── profile: $NAME"
printf '   commits %s · authors %s\n' \
  "$(git -C "$EXT/$NAME" rev-list --count HEAD)" \
  "$(git -C "$EXT/$NAME" shortlog -sn HEAD | wc -l | tr -d ' ')"

echo "── corpus"
node scripts/bench/locate-corpus.mjs --repo "$EXT/$NAME" --depth "$DEPTH" \
  --out "/tmp/corpus-$NAME.json" 2>/dev/null | grep -vE '^warning:'

BASE=$(python3 -c "import json;print(json.load(open('/tmp/corpus-$NAME.json'))['base'])")
if [ ! -d "$EXT/$NAME-base" ]; then
  git -C "$EXT/$NAME" worktree add --detach "$EXT/$NAME-base" "$BASE" >/dev/null 2>&1
fi
# The index MUST be built from the base tree; a stale one from an earlier run would silently
# score against a different graph than the corpus was built for.
rm -rf "$EXT/$NAME-base/.crib"
echo "── indexing the base tree"
node packages/cli/dist/bin.js index "$EXT/$NAME-base" >/dev/null 2>&1

echo "── evaluating"
node scripts/bench/locate-eval.mjs --corpus "/tmp/corpus-$NAME.json" \
  --base-tree "$EXT/$NAME-base" 2>/dev/null
