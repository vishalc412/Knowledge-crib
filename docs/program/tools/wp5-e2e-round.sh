#!/usr/bin/env bash
#
# WP5 §9 G-U5 — the end-to-end round that G-U3 needs.
#
# WHY THIS EXISTS. T12 pins the recovery ladder at the API boundary, and the browser suite measures the
# fixture's one real recovery line. So of the four failure states U3 names — stale index, unavailable
# model, blocked extraction, failed persistence — the register records three as UNPROVEN. This round
# does not assert the branches; it INDUCES the states in a real process and reads the served Home
# payload. A branch that fires only under a simulated state is not evidence, which is the whole point.
#
# SAFETY. Everything runs under a sandboxed HOME; KCRIB_MEMORY_DIR / KCRIB_REGISTRY_DIR /
# KCRIB_PRINCIPAL_ID are all pointed inside it, so no user state is read or written. The only writes
# outside the sandbox are this log. The target is a throwaway monorepo built in the sandbox.
#
# CLI under test: packages/cli/dist/bin.js (the canonical `bin` entry, which loads ./cli.js), REBUILT
# from source with `pnpm -C packages/cli run build` immediately before this run. That matters: the
# round claims the registry temp-name fix is exercised, and a stale artifact would make that false.
#
# INDUCING THE STALE-INDEX STATE — the non-obvious part, learned by experiment, not by reading:
#   `freshness.behindHead` is `lastKnownGood.head !== currentHead` and it is FALSE whenever no
#   generation was ever published. `crib index` does NOT publish one, and neither does `crib update`
#   (`freshness status` reports "last-known-good: never published" after both). The publisher is the
#   freshness WORKER, and the thing that gives it a task is the post-commit hook — which enqueues in
#   `auto` mode and is a no-op in `manual` (the default). So the state is induced by: set `auto`,
#   enqueue + publish at commit A, commit B, then leave the worker down. Indexing alone proves nothing;
#   that is why §6 failed on the first run of this script.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/bin.js"
LOG="$REPO_ROOT/docs/program/logs/e2e-round-wp5-2026-09-23.log"

SB="$(mktemp -d "${TMPDIR:-/tmp}/crib-wp5-e2e-XXXXXX")"
TARGET="$SB/target"
export HOME="$SB/home"
export KCRIB_MEMORY_DIR="$SB/home/.crib/memory"
export KCRIB_REGISTRY_DIR="$SB/home/.crib"
export KCRIB_PRINCIPAL_ID="e2e-round-2026-09-23"
mkdir -p "$HOME" "$TARGET"

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$SB"
}
trap cleanup EXIT

section() { printf '\n\n===== %s =====\n' "$1"; }

# Read a JSON file and print one value. Usage: probe <file> [<js-expression on `j`>]
probe() {
  node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const out=process.argv[2] ? eval(process.argv[2]) : j;
    process.stdout.write(typeof out==="string" ? out+"\n" : JSON.stringify(out,null,2)+"\n");
  ' "$1" "${2:-}"
}

crib() { node "$CLI" "$@"; }
g() { git -c user.email=e2e@local -c user.name=e2e "$@"; }

{
echo "WP5 G-U5 end-to-end round — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "sandbox: $SB   (HOME sandboxed; no user state read or written)"
echo "cli under test: packages/cli/dist/bin.js (rebuilt from source with pnpm run build this session)"

# ---------------------------------------------------------------------------
section "0. Target: a two-package monorepo with a real cross-package import"
# ---------------------------------------------------------------------------
mkdir -p "$TARGET/packages/acme-core/src" "$TARGET/packages/acme-web/src"
cat > "$TARGET/package.json" <<'EOF'
{ "name": "acme-widgets", "private": true, "type": "module" }
EOF
cat > "$TARGET/pnpm-workspace.yaml" <<'EOF'
packages:
  - packages/*
EOF
cat > "$TARGET/packages/acme-core/package.json" <<'EOF'
{ "name": "acme-core", "version": "1.0.0", "type": "module" }
EOF
cat > "$TARGET/packages/acme-core/src/units.ts" <<'EOF'
export function normalizeUnit(value: string): string {
  return value.trim().toLowerCase();
}
EOF
cat > "$TARGET/packages/acme-web/package.json" <<'EOF'
{ "name": "acme-web", "version": "1.0.0", "type": "module", "dependencies": { "acme-core": "1.0.0" } }
EOF
cat > "$TARGET/packages/acme-web/src/render.ts" <<'EOF'
import { normalizeUnit } from 'acme-core';

export function renderLabel(value: string): string {
  return `unit: ${normalizeUnit(value)}`;
}
EOF
cd "$TARGET" || exit 1
git init -q . && g add -A && g commit -qm "target baseline"
echo "target: $(git rev-parse --short HEAD) — $(git ls-files | wc -l | tr -d ' ') tracked file(s)"

# ---------------------------------------------------------------------------
section "1. crib index — the derived graph a recall will be checked against"
# ---------------------------------------------------------------------------
crib index . 2>&1 | tail -2
crib status . --json > "$SB/status.json" 2>/dev/null
echo "index head recorded: $(probe "$SB/status.json" 'j.readerFreshness && j.readerFreshness.graphSourcePosition ? JSON.stringify(j.readerFreshness.graphSourcePosition) : "n/a"')"

# ---------------------------------------------------------------------------
section "2. A grounded memory — the admission gate, not a write"
# ---------------------------------------------------------------------------
# `--evidence` takes a JSON ARRAY of evidence items. An object is rejected outright, and the rejection
# is correct: an observation with no admissible evidence must not be staged.
cat > "$SB/ev.json" <<'EOF'
[ { "kind": "source-quote", "path": "packages/acme-core/src/units.ts", "line": 2,
    "quote": "return value.trim().toLowerCase();" } ]
EOF
crib memory observe --kind fact --subject "unit normalization is trim+lowercase" \
  --claim "normalizeUnit lowercases and trims, so unit comparison is case- and whitespace-insensitive." \
  --evidence "$SB/ev.json" > "$SB/observe.out" 2>&1
echo "recallable:  $(probe "$SB/observe.out" 'j.recallable')"
echo "trust:       $(probe "$SB/observe.out" 'j.trust || j.status || "(n/a)"')"
echo "nextAction:  $(probe "$SB/observe.out" 'j.nextAction || "(n/a)"')"

# ---------------------------------------------------------------------------
section "3. Recall in a NEW process — does the admitted claim come back?"
# ---------------------------------------------------------------------------
crib memory recall "unit normalization" --json > "$SB/recall.json" 2>/dev/null
echo "recall hits:            $(probe "$SB/recall.json" '(j.memories||j.hits||j.results||[]).length')"
echo "first hit evidence:     $(probe "$SB/recall.json" 'JSON.stringify((j.memories||j.hits||j.results||[])[0]?.evidence ?? (j.memories||j.hits||j.results||[])[0]?.verdicts ?? null)')"

# ---------------------------------------------------------------------------
section "4. crib viz — start the REAL server and read the SERVED Home payload"
# ---------------------------------------------------------------------------
# The banner is `viz → http://127.0.0.1:<port>/  (<n> nodes · <n> edges · <n> clusters)`.
# Parsed with `grep -oE`, NOT a BSD `sed` BRE: `\+` is a GNU extension, so the sed form silently never
# matched and this loop once reported "server never announced a port" over a banner that had printed.
crib viz --port 0 --no-open > "$SB/viz.log" 2>&1 &
SERVER_PID=$!
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$SB/viz.log" | head -1)
  [ -n "$URL" ] && break
  sleep 0.5
done
if [ -z "$URL" ]; then echo "FATAL: server never announced a port"; cat "$SB/viz.log"; exit 1; fi
echo "server: $URL"
for _ in $(seq 1 40); do curl -sf "$URL/memory/home.json" -o /dev/null 2>/dev/null && break; sleep 0.25; done

curl -sf "$URL/memory/home.json" -o "$SB/home-baseline.json"
echo "--- BASELINE ---"
echo "configured:            $(probe "$SB/home-baseline.json" 'j.configured')"
echo "retrieval.mode:        $(probe "$SB/home-baseline.json" 'j.health.retrieval.mode')"
echo "codeIndex:             $(probe "$SB/home-baseline.json" 'JSON.stringify(j.health.codeIndex)')"
echo "capture:               $(probe "$SB/home-baseline.json" 'JSON.stringify(j.health.capture||"(absent)")')"
echo "sync:                  $(probe "$SB/home-baseline.json" 'JSON.stringify(j.health.sync||"(absent)")')"
echo "recovery:              $(probe "$SB/home-baseline.json" 'JSON.stringify(j.recovery||{})')"
echo "nextAction:            $(probe "$SB/home-baseline.json" 'j.nextAction')"

# ---------------------------------------------------------------------------
section "5. The ledger — and the same read with the re-check explicitly OFF"
# ---------------------------------------------------------------------------
curl -sf "$URL/memory.json" -o "$SB/ledger.json"
curl -sf "$URL/memory.json?revalidate=0" -o "$SB/ledger-stamp.json"
echo "top-level keys:        $(probe "$SB/ledger.json" 'Object.keys(j).join(",")')"
echo "total / counts:        $(probe "$SB/ledger.json" 'j.total + " " + JSON.stringify(j.counts)')"
echo "revalidated (default): $(probe "$SB/ledger.json" 'j.revalidated')"
echo "revalidated (=0):      $(probe "$SB/ledger-stamp.json" 'j.revalidated')"
echo "row ids (default):     $(probe "$SB/ledger.json" 'JSON.stringify((j.rows||[]).map(r=>r.id||r.memoryId))')"
echo "row ids (=0):          $(probe "$SB/ledger-stamp.json" 'JSON.stringify((j.rows||[]).map(r=>r.id||r.memoryId))')"
echo "row reasons (default): $(probe "$SB/ledger.json" 'JSON.stringify((j.rows||[]).map(r=>r.reasons||[]))')"
echo "bad literal rejected:  $(curl -s -o /dev/null -w '%{http_code}' "$URL/memory.json?revalidate=maybe") (expect 400)"

# ---------------------------------------------------------------------------
section "6. INDUCE state 1/4 — STALE INDEX"
# ---------------------------------------------------------------------------
# The induction that actually works, and the reason each step is here:
#   auto mode      — the post-commit hook enqueues in `auto` and is a NO-OP in `manual` (the default)
#   hook + worker  — nothing but the worker publishes a generation; `index` and `update` never do
#   no worker after — the state is transient by design (self-healing), so it is read as a snapshot
crib freshness auto 2>&1 | head -1
crib freshness hook 2>&1 | tail -1
( timeout 15 node "$CLI" freshness worker > "$SB/worker.log" 2>&1 )
echo "after publish at A:    $(crib freshness status 2>&1 | grep 'last-known-good')"
echo "HEAD at publish:       $(git rev-parse --short HEAD)"
git add -A && g commit -qm "target commit B (deliberately NOT re-indexed)" --allow-empty
echo "HEAD now:              $(git rev-parse --short HEAD)"
echo "status behind HEAD:    $(crib freshness status 2>&1 | grep 'behind HEAD')"
curl -sf "$URL/memory/home.json" -o "$SB/home-stale.json"
echo "codeIndex:             $(probe "$SB/home-stale.json" 'JSON.stringify(j.health.codeIndex)')"
echo "recovery.codeIndex:    $(probe "$SB/home-stale.json" 'j.recovery?.codeIndex || "(ABSENT)"')"
echo "nextAction:            $(probe "$SB/home-stale.json" 'j.nextAction')"

# ---------------------------------------------------------------------------
section "7. state 2/4 — UNAVAILABLE MODEL (fired already, at baseline)"
# ---------------------------------------------------------------------------
echo "No induction needed in a sandboxed HOME: with no embedder installed, installedEmbedder is falsy,"
echo "so health.retrieval.mode is lexical-fallback by construction."
echo "observed at baseline:  $(probe "$SB/home-baseline.json" 'j.health.retrieval.mode')"
echo "baseline recovery:     $(probe "$SB/home-baseline.json" 'j.recovery?.retrieval || "(ABSENT)"')"
echo "ORDERING, observed not assumed: at baseline (behindHead false) the model branch was the top step."
echo "In §6 (behindHead true) nextAction became the stale-index line instead, demoting the model line —"
echo "the ladder's documented precedence, seen firing in both directions."

# ---------------------------------------------------------------------------
section "8. state 4/4 — FAILED PERSISTENCE (structurally unreachable on this surface)"
# ---------------------------------------------------------------------------
echo "sync tile as served:   $(probe "$SB/home-baseline.json" 'JSON.stringify(j.health.sync)')"
echo "sync vs its declared shape — the API type allows pending/dead, but cli.ts populates"
echo "  sync with {configured, lastSuccessfulAt} ONLY. Observed keys above carry NO pending/dead, so"
echo "  there is nothing for the ladder to read and recoveryFor emits no sync line:"
echo "recovery.sync present: $(probe "$SB/home-baseline.json" 'j.recovery && "sync" in j.recovery ? "yes" : "NO — absent by construction"')"
echo "This is a GAP in U3's coverage, recorded as such — not scored as a pass."

# ---------------------------------------------------------------------------
section "9. state 3/4 — BLOCKED EXTRACTION / dead captures (NOT INDUCED)"
# ---------------------------------------------------------------------------
echo "capture tile:          $(probe "$SB/home-baseline.json" 'JSON.stringify(j.health.capture)')"
echo "the tile's reachable keys: $(probe "$SB/home-baseline.json" 'Object.keys(j.health.capture||{}).join(",")')"
crib memory handoff --json 2>/dev/null > "$SB/handoff.json" || echo "(handoff unavailable)"
echo "handoff counts:        $(probe "$SB/handoff.json" 'JSON.stringify(j.counts||j.deadCaptures||"(n/a)")' 2>/dev/null || echo "(n/a)")"
echo "No dead-letter is reachable without a provider that exhausts its retries. This round does NOT"
echo "claim the state was induced. Reported as NOT INDUCED — the one of U3's four states still unproven."

# ---------------------------------------------------------------------------
section "10. Does the ladder step back DOWN when the cause is removed?"
# ---------------------------------------------------------------------------
# FINDING (B16). The stale-index line the user is shown says "run `crib update` to catch it up". It does
# not catch it up. publishGeneration has exactly ONE call site — the freshness worker's task loop
# (freshness.ts:943) — so `crib update` refreshes the graph but leaves lastKnownGood at the old head,
# and behindHead stays true. The user follows the instruction and the banner does not clear.
crib update . 2>&1 | tail -1
curl -sf "$URL/memory/home.json" -o "$SB/home-after-update.json"
echo "AFTER the action the recovery line recommends ('crib update'):"
echo "  codeIndex.behindHead: $(probe "$SB/home-after-update.json" 'j.health.codeIndex.behindHead')   <-- STILL TRUE"
echo "  recovery.codeIndex:   $(probe "$SB/home-after-update.json" 'j.recovery?.codeIndex || "(absent)"' | head -c 60)..."
echo "NOW the action that actually clears it (enqueue, then let the worker publish):"
crib freshness hook 2>&1 | tail -1
( timeout 15 node "$CLI" freshness worker > "$SB/worker2.log" 2>&1 )
curl -sf "$URL/memory/home.json" -o "$SB/home-recovered.json"
echo "  codeIndex.behindHead: $(probe "$SB/home-recovered.json" 'j.health.codeIndex.behindHead')   <-- cleared"
echo "  recovery.codeIndex:   $(probe "$SB/home-recovered.json" 'j.recovery?.codeIndex || "(absent - fault cleared)"' | head -c 60)..."
echo "  nextAction:           $(probe "$SB/home-recovered.json" 'j.nextAction' | head -c 60)..."
echo "  ^ the top step falls back to the model line: the ladder IS a live ranking, not a set flag."
echo "  BUT the repair text names a command that does not clear the fault. That is finding B16."

section "round complete"
} 2>&1 | tee "$LOG"
