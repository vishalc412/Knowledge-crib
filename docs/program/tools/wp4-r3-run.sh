#!/usr/bin/env bash
# WP4 R3 deciding run — the §10.7 block, in order, with every artefact captured.
#
# Why a script and not six commands typed in sequence: R3 is a PRE-REGISTERED measurement whose
# whole value is that the rule was fixed before the numbers arrived. A run assembled by hand, from
# whichever commands happened to work, is not reproducible and cannot be re-audited. This script is
# the run; re-running it re-measures, and its logs are the evidence.
#
# WHAT IT DOES NOT DO. It does not decide anything. §10.5 is applied to these outputs afterwards,
# by hand, in `docs/program/wp4-implementation-spec.md` under `§10 RESULTS` — because the rule's
# clauses draw on three different harnesses and the judgement of which clauses are even checkable is
# part of the result, not a script's output.
#
# SERIALISATION. Step 6 measures wall time and peak RSS and MUST NOT run beside anything else. This
# script is therefore run alone; the caller is responsible for that, and the log records the run
# order so a reader can see the perf steps were not interleaved.
#
# Usage:
#   docs/program/tools/wp4-r3-run.sh <log-tag>            # full run
#   docs/program/tools/wp4-r3-run.sh <log-tag> --quality  # steps 0-5 only (no scale arms)
#   docs/program/tools/wp4-r3-run.sh <log-tag> --scale    # steps 0 and 6 (step 0 is the warm-up)
#
# Env:
#   WP4_BASE_TREE     a checkout of the corpus base commit, indexed `--vectors`  (the C1 tree)
#   WP4_BASE_TREE_C0  the same commit, indexed vectorless                          (the C0 tree)
#                     Both set -> step 4 measures BOTH arms and asserts each, which is what §10.5
#                     clause 2 needs. Either unset -> step 4 degrades to the arms it can measure and
#                     says in the log that clause 2 is unproven.
#
# Steps may also be run individually by sourcing nothing — each is a plain command, copy it out.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TAG="${1:-$(date +%Y-%m-%d)}"
MODE="${2:-}"
LOGDIR="$REPO/docs/program/logs"
LOG="$LOGDIR/wp4-r3-$TAG.log"

cd "$REPO" || exit 2
mkdir -p "$LOGDIR"

# A fresh embed cache per COLD measurement (§9.2's trap): the adapter caches by sha256(text), so
# reusing a directory turns the second "cold" run into a warm one and understates the cold cost by
# the entire embedding pass.
CACHE="$(mktemp -d)"
BASE_TREE="${WP4_BASE_TREE:-}"
# §10.5 clause 2 compares two arms on the SAME corpus base. The arm is a property of the tree's
# index, not a flag on the harness (`cli.ts` `cmdQuery` -> `upgradeIndexToVectors`), so the two arms
# need TWO checkouts of the one base commit: one indexed vectorless (C0, the incumbent) and one
# indexed `--vectors` (C1). WP4_BASE_TREE is the VECTORISED tree — unchanged from before — and
# WP4_BASE_TREE_C0 is the vectorless twin. Set both and step 4 measures both arms and asserts each;
# set neither and step 4 is skipped, as before. One tree alone still runs, arm auto-detected, but a
# single tree cannot yield clause 2's comparison and the log says so.
BASE_TREE_C0="${WP4_BASE_TREE_C0:-}"

say() { printf '\n=== %s ===\n' "$*" | tee -a "$LOG"; }
run() {
  printf '\n$ %s\n' "$*" >>"$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  printf '[exit %s]\n' "${PIPESTATUS[0]}" >>"$LOG"
}
# Same, but ALSO captures stdout to a file. Needed because `locate-eval.mjs` has no `--out`: it prints
# its JSON report to stdout, so the report only survives if this script keeps it. stderr goes to the log
# and NOT into the file, so a warning on stderr cannot corrupt the JSON — and if it ever did, the §10.5
# tool refuses an unparseable report rather than reading half of one.
run_json() {
  local out="$1"
  shift
  printf '\n$ %s  > %s\n' "$*" "$out" >>"$LOG"
  "$@" 2>>"$LOG" | tee -a "$LOG" "$out"
  printf '[exit %s]\n' "${PIPESTATUS[0]}" >>"$LOG"
}

: >"$LOG"
{
  echo "WP4 R3 deciding run — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo   : $REPO"
  echo "branch : $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "HEAD   : $(git rev-parse HEAD 2>/dev/null)"
  echo "dirty  : $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ') path(s)"
  echo "node   : $(node --version)"
  echo "embed cache for cold runs: $CACHE"
  echo
  echo "Order matters: steps 0-5 are quality/correctness/setup, step 6 is the perf arm and runs alone."
  echo "Step 0 reads every pinned model file, which WARMS THE OS PAGE CACHE for them. That is a"
  echo "measurement control, not an optimisation: the cold-index (vector) column would otherwise vary"
  echo "with whether ~3.2 GiB of weights happened to be resident, which is disk state, not the channel"
  echo "under test. Measured 2026-09-23 on a warm cache the load is ~1.3 s; the cold-cache figure was"
  echo "NOT measured and is not claimed. Whatever step 0 removes is NOT subtracted from any column."
} >>"$LOG"

# ── 0. what one embedder load costs, and warm the weights into page cache ────────────────────────
# Every process that touches vectors reads and sha256s every pinned model/weight file before it does
# any work (embed-install.ts `verifyInstalledEmbed` -> `checkPinnedFiles` -> `sha256File`: 3,313 MiB
# across 13 files, synchronous, 1 MiB chunks). Step 6 spawns several such children, so this measures
# the fixed cost once and warms the cache the perf columns would otherwise depend on. Register §5.4
# records the measurement AND the correction it forced: the load is ~1.3 s warm, so it does NOT
# explain the ~27-37 s per-CLI-invocation floor §5.3 measured, and an earlier attribution of a
# multi-minute stall to this hash was not supported.
say "0. embedder load cost (cold vs warm) + page-cache warm-up for the weights"
run node docs/program/tools/embed-load-cost.mjs

# ── 1. the tiers must be present, or the run does not happen (R3 §10.4) ───────────────────────────
say "1. doctor — the installed tier, recorded verbatim (§10.4)"
run node packages/cli/dist/cli.js doctor .

# ── 2. vectors must actually BE in the index, and hybrid must not be allowed to be absent (§8.6) ─
say "2. vector channel presence + the H-6 honesty gate"
run node scripts/eval/code-vector-eval.mjs --require-hybrid --json

# ── 3-5. §8's categories at HEAD (the C0/C1/C2 arms; C3 has no public entry point) ───────────────
# §10.7's block lists `--category exact,nl,cross-file,rename,dependency`, and step 5 below runs
# `cochange-eval.mjs` — which is exactly what the `dependency` category DELEGATES to (`--category
# dependency` shells out to the same script and returns its numbers). Both are listed here, so the
# category is measured once, by the same binary, in step 5, and not billed twice. The five categories
# are therefore all covered; the only difference from the spec's line is where the fifth is invoked.
say "3. per-category arms — exact, nl, cross-file, rename (D-a's numbers)"
run node scripts/bench/code-retrieval-eval.mjs \
  --category exact,nl,cross-file,rename --decide --json

if [ -n "$BASE_TREE" ]; then
  # The PRIMARY natural-language arm (§8.2) and the query-blind churn control (§10.5 clause 1).
  # Both need a checkout of the corpus base WITH ITS OWN INDEX — scoring against an index built
  # from a later tree is the leak the corpus exists to prevent, and locate-eval refuses it.
  say "4. primary NL arm (61 tasks) + churn control — §10.5 clauses 1 and 2"
  if [ -n "$BASE_TREE_C0" ]; then
    # The deciding comparison. `--arm` is not decoration: it ASSERTS the arm the run measured and
    # refuses if the run measured the other one, so a mis-provisioned tree is a non-zero exit here
    # rather than a column that silently means something else. The C0 tree is indexed vectorless on
    # purpose — the only difference between the two trees is the index's vectors, which is the
    # variable clause 2 is about.
    {
      echo "C0 (incumbent, vectorless) : $BASE_TREE_C0"
      echo "C1 (hybrid, --vectors)     : $BASE_TREE"
      echo "Both must be at the corpus base; locate-eval checks that independently of this script."
    } >>"$LOG"
    run_json "$LOGDIR/wp4-r3-$TAG-c0.json" \
      node scripts/bench/locate-eval.mjs --base-tree "$BASE_TREE_C0" --arm c0 --json
    run_json "$LOGDIR/wp4-r3-$TAG-c1.json" \
      node scripts/bench/locate-eval.mjs --base-tree "$BASE_TREE" --arm c1 --json

    # §10.5 is applied by a tool, not by hand. Seven clauses over four harnesses, read at the moment the
    # numbers are finally visible, is where a frozen rule gets quietly bent — so the computable ones are
    # computed in one place and the uncomputable ones are printed as unproven. The tool decides nothing:
    # clauses 3-5 are reported UNPROVEN/PENDING here, and §10.5 clause 3 has no instrument in this run at
    # all (register §5.6(G), spec §10.8(8)). Non-vacuity: `node docs/program/tools/wp4-r3-apply.test.mjs`.
    say "4b. §10.5 applied to the pair (clauses 1-2 computed; 3 unproven; 4-5 pending)"
    run node docs/program/tools/wp4-r3-apply.mjs \
      --c0 "$LOGDIR/wp4-r3-$TAG-c0.json" --c1 "$LOGDIR/wp4-r3-$TAG-c1.json"
  else
    run node scripts/bench/locate-eval.mjs --base-tree "$BASE_TREE" --json
    {
      echo "WP4_BASE_TREE_C0 is unset: ONE arm was measured and the harness reports which. §10.5"
      echo "clause 2 compares two arms on one base commit, so a single tree cannot decide it. Set"
      echo "WP4_BASE_TREE_C0=<vectorless checkout of the same base> to measure the comparison."
    } >>"$LOG"
  fi

  say "5. dependency arm + churn control (§8.5), unchanged so the number stays comparable"
  run node scripts/bench/cochange-eval.mjs --base-tree "$BASE_TREE" --json
else
  say "4-5. SKIPPED — WP4_BASE_TREE is unset"
  {
    echo "The primary NL arm (§8.2, 61 tasks) and the churn control were NOT measured: locate-eval and"
    echo "cochange-eval need --base-tree, a checkout of the corpus base commit with its own index."
    echo "§10.5 clauses 1 and 2 are therefore UNPROVEN for this run — not satisfied, not failed."
    echo "Rerun with WP4_BASE_TREE=<path> to measure them."
  } >>"$LOG"
fi

# ── 6. the scale arms (§9). Alone. Fresh cache per cold measurement. ─────────────────────────────
if [ "$MODE" != "--quality" ]; then
  say "6. scale arms — cold/warm/incremental/latency/RSS/disk (§9.1), §10.5 clauses 4 and 5"
  {
    echo "KCRIB_EMBED_CACHE=$CACHE"
    echo "The harness creates its OWN fresh cache directory per cold measurement and records it;"
    echo "this environment variable is set as well so an accidental nested run cannot reuse one."
  } >>"$LOG"
  KCRIB_EMBED_CACHE="$CACHE" run node scripts/scale-bench.mjs \
    --vectors --slices 10000,100000,500000 --out docs/bench/scale-curve.md
fi

say "done — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "log: $LOG"
