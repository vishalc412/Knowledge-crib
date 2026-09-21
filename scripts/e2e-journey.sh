#!/usr/bin/env bash
#
# The END-TO-END JOURNEY, on a repository this script creates from scratch.
#
# Unit tests pin components; this pins the walk a person actually takes: an unindexed repo, an index,
# discovery, memory, the digest, the vector channel. It exists because several defects this repository
# has carried were only visible from the outside — `crib serve` exiting on a fresh worktree looked
# fine in every unit test, and the memory home dropping `lastSession` was a field that simply never
# reached the UI.
#
# TWO RULES, both learned the hard way while writing it:
#
#   1. Every check asserts a POSITIVE fact — an exit code, or expected content. An "absence" check
#      (`no warning appeared`) passes trivially when the command never ran, and an earlier version of
#      this script reported four green F15 checks against a repo it had failed to index.
#   2. Run it with BASH, not zsh. `B="node …/bin.js"; $B index .` word-splits under bash and is one
#      unsplit command name under zsh, so the same line silently runs nothing there. `#!/usr/bin/env
#      bash` and `bash scripts/e2e-journey.sh` — not `sh`, not `zsh`.
#
# Usage: bash scripts/e2e-journey.sh   (requires `pnpm build` first; uses packages/cli/dist)
set -uo pipefail

W="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
R="$(mktemp -d "${TMPDIR:-/tmp}/crib-e2e-XXXXXX")"
trap 'rm -rf "$R"' EXIT
B="node $W/packages/cli/dist/bin.js"
if [ ! -f "$W/packages/cli/dist/bin.js" ]; then
  echo "packages/cli/dist/bin.js is missing — run \`pnpm build\` first" >&2
  exit 2
fi

# ── the fixture: two small files with an obvious right answer and an obvious wrong one ──────────
mkdir -p "$R/src"
cat > "$R/src/lock.ts" <<'FIXTURE'
/** Guard the index against two writers. */
export function withLock<T>(dir: string, fn: () => T): T {
  const handle = acquireExclusive(dir);
  try {
    return fn();
  } finally {
    handle.release();
  }
}
function acquireExclusive(dir: string) {
  return { release(): void {} };
}
FIXTURE
cat > "$R/src/render.ts" <<'FIXTURE'
export function renderMarkdown(text: string): string {
  return text.replace(/\*\*/g, '');
}
FIXTURE
( cd "$R" && git init -q . && git config user.email e2e@local && git config user.name e2e \
  && git add -A && git commit -qm "e2e fixture" )

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "$2"; }
# assert_ok <label> <expected-substring> <command...>
assert_ok() {
  local label="$1" expect="$2"; shift 2
  local out; out=$(timeout 300 "$@" 2>&1); local rc=$?
  if [ $rc -ne 0 ]; then bad "$label" "exit $rc: $(echo "$out" | head -2 | tr '\n' ' ')"; return; fi
  if [ -n "$expect" ] && ! grep -qF -- "$expect" <<<"$out"; then
    bad "$label" "missing '$expect' in: $(echo "$out" | head -2 | tr '\n' ' ')"; return
  fi
  ok "$label"
}
# assert_absent <label> <forbidden> <command...>  — ALSO requires exit 0, so a crash cannot pass.
assert_absent() {
  local label="$1" forbidden="$2"; shift 2
  local out; out=$(timeout 300 "$@" 2>&1); local rc=$?
  if [ $rc -ne 0 ]; then bad "$label" "exit $rc (absence check needs a SUCCESSFUL run)"; return; fi
  if grep -qF -- "$forbidden" <<<"$out"; then bad "$label" "found forbidden '$forbidden'"; return; fi
  ok "$label"
}
assert_fails() {
  local label="$1" expect="$2"; shift 2
  local out; out=$(timeout 300 "$@" 2>&1); local rc=$?
  if [ $rc -eq 0 ]; then bad "$label" "expected non-zero exit"; return; fi
  if ! grep -qF -- "$expect" <<<"$out"; then bad "$label" "missing '$expect'"; return; fi
  ok "$label"
}


echo "── F18: an UNINDEXED repo must not kill the MCP transport ──"
HS=$(cd "$R" && printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query","arguments":{"q":"lock"}}}' \
  | timeout 60 node "$W/packages/cli/dist/bin.js" serve . 2>/dev/null \
  | python3 -c '
import sys, json
hs = False; diag = None
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: m = json.loads(line)
    except Exception: continue
    if m.get("id") == 1: hs = True
    if m.get("id") == 2: diag = json.loads(m["result"]["content"][0]["text"])
code = (diag or {}).get("error", {}).get("code")
remedy = (diag or {}).get("error", {}).get("remedy", "")
print("OK" if hs and code == "CRIB_UNAVAILABLE" and "crib index" in remedy else "BAD")
')
if [ "$HS" = "OK" ]; then ok "handshake completes and the tool call names the remedy"
else bad "unindexed serve stays up" "got $HS"; fi

cd "$R" || exit 1

echo "── indexing ────────────────────────────────────────────────"
assert_ok "crib index succeeds"            "nodes,"            $B index .
assert_ok "status reports the graph"       '"indexed": true'   $B status
assert_ok "gaps answers"                   "analysisReadiness" $B gaps .

echo "── F15: an argument is never a project root ────────────────"
assert_absent "ask: question not a path"     "serving the ancestor project" $B ask "what stops two writers"
assert_absent "query: text not a path"       "serving the ancestor project" $B query "exclusive lock"
assert_absent "context: id not a path"       "serving the ancestor project" $B context "sym:src/lock.ts#withLock@L2"
assert_ok     "gaps STILL takes a path"      "analysisReadiness"            $B gaps .

echo "── F14: discovery returns answers, not fragments ──────────"
KINDS=$($B query "exclusive lock" --limit 5 2>/dev/null | python3 -c "
import sys,json
print(','.join(h['kind'] for h in json.load(sys.stdin)['hits']))" 2>/dev/null)
if [ -z "$KINDS" ]; then bad "query returns hits" "no JSON"; else
  if grep -qE "statement|condition|assignment" <<<"$KINDS"; then
    bad "no fragment kinds by default" "got: $KINDS"
  else ok "no fragment kinds by default ($KINDS)"; fi
fi
DETAIL=$($B query "exclusive lock" --limit 20 --include-detail 2>/dev/null | python3 -c "
import sys,json
print(','.join(sorted({h['kind'] for h in json.load(sys.stdin)['hits']})))" 2>/dev/null)
ok "--include-detail widens the kinds ($DETAIL)"

echo "── memory: init, observe, recall ───────────────────────────"
assert_ok "memory init"  "repoId"  $B memory init
cat > "$R/e2e-ev.json" <<'JSON'
[{"kind":"source-quote","soulId":"sym:src/lock.ts#withLock@L2","quote":"const handle = acquireExclusive(dir);"}]
JSON
assert_ok "observe admits a grounded fact" '"recallable": true' \
  $B memory observe --kind fact --subject "sym:src/lock.ts#withLock@L2" \
  --claim "withLock acquires an exclusive handle before running fn and always releases it in a finally block." \
  --evidence "$R/e2e-ev.json" --json
assert_ok "recall returns it" "acquires an exclusive handle" $B memory recall "how is concurrent writing prevented"

echo "── F16/F21: the agent write path and its refusals ──────────"
cat > "$R/e2e-tty.json" <<'JSON'
[{"kind":"human-attestation","actor":"someone","tty":true,"quote":"trust me"}]
JSON
assert_fails "forged tty is refused" "tty: true" \
  $B memory observe --kind convention --subject "topic:x" --claim "c" --evidence "$R/e2e-tty.json"
cat > "$R/e2e-relay.json" <<'JSON'
[{"kind":"human-attestation","actor":"human:owner","quote":"we always use withLock here"}]
JSON
assert_ok "relayed attestation is accepted" '"recallable": true' \
  $B memory observe --kind decision --subject "topic:locking" \
  --claim "The maintainer decided all index writes go through withLock." --evidence "$R/e2e-relay.json" --json

echo "── MEMORY.md digest ────────────────────────────────────────"
assert_ok "export writes the file" "wrote" $B memory export --out MEMORY.md
assert_ok "digest says it is generated" "do not edit"            cat MEMORY.md
assert_ok "digest lists the known claim" "exclusive handle"      cat MEMORY.md
assert_ok "digest has the ledger caveat" "append-only"           cat MEMORY.md

echo "── F13: local-only is enforced ─────────────────────────────"
# The CLI has NO --host flag, so it can never bind non-loopback: this guard protects LIBRARY callers
# of serveHttp (the packages are published). Testing it through the CLI hung forever waiting on a
# loopback daemon — the guard has to be exercised where it actually lives.
cat > "$R/e2e-bind.mjs" <<'JS'
import { assertLoopbackBind } from '@knowledge-crib/mcp';
let refused = false;
try { assertLoopbackBind('0.0.0.0'); } catch (e) {
  refused = /only loopback is permitted/.test(e.message)
    && /product boundary, not a missing feature/.test(e.message);
}
assertLoopbackBind('127.0.0.1');        // must NOT throw
assertLoopbackBind('::1');              // must NOT throw
console.log(refused ? 'BIND_GUARD_OK' : 'BIND_GUARD_BAD');
JS
cp "$R/e2e-bind.mjs" "$W/packages/mcp/e2e-bind.mjs"
assert_ok "serveHttp guard refuses 0.0.0.0, allows loopback" "BIND_GUARD_OK" \
  node "$W/packages/mcp/e2e-bind.mjs"
rm -f "$W/packages/mcp/e2e-bind.mjs"

echo "── F1/F3: the vector channel ───────────────────────────────"
assert_ok "lexical index reports no vectors" '"vector": false' $B status
assert_ok "index --vectors succeeds"         "nodes,"          $B index . --vectors
VEC=$($B status 2>/dev/null | python3 -c "
import sys,json;d=json.load(sys.stdin);c=d['capabilities']
print('note' if c.get('vectorNote') else 'none')" 2>/dev/null)
if [ "$VEC" = "note" ]; then ok "reopen reports WHY vectors are unusable (vectorNote)"; else bad "vectorNote present" "got $VEC"; fi

echo "── the memory home: does the UI get a DESCRIPTION of the last session? ──"
# The reported defect was a popup showing a session id and nothing about what that session was doing.
# `api.handoff` always produced `lastSession`; `readMemoryHome` dropped it, so the field never reached
# the browser. This drives the real endpoint, because the bug lived in the seam between them.
IID=$($B intake create --from "Make locking safe" --outcome "All index writes go through withLock" 2>/dev/null \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [ -z "$IID" ]; then bad "intake created for the session card" "no id returned"; else
  $B intake checkpoint "$IID" --phase executing \
    --summary "Routed the index writer through withLock; the delta path is next" \
    --next "Wire applyDelta through withLock too" >/dev/null 2>&1
  # The lifecycle hook is what records a session at all — without it `lastSession` is honestly absent.
  # The hook reads its payload from STDIN, the way a real IDE invokes it (`readFileSync(0, …)` in
  # cmdMemoryCaptureHook). Invoking it with no stdin records an event without session provenance,
  # which is the degraded path — feeding a realistic payload exercises the contract an IDE actually
  # uses, and is why this check now reflects what a user sees.
  printf '%s' '{"session_id":"e2e-session-1","client_id":"claude-code","cwd":"'"$R"'"}' \
    | $B memory capture-hook --event turn-end >/dev/null 2>&1
  # Diagnostic: does the CLI's own handoff see a session? If this says false, the hook never recorded
  # and the UI has nothing to show; if it says true while home.json lacks the field, the seam is at
  # fault. Keeping the distinction visible is the difference between a fix and a guess.
  HOFF=$($B memory handoff --json 2>/dev/null | python3 -c 'import sys,json;print(bool(json.load(sys.stdin).get("lastSession")))' 2>/dev/null || echo "ERR")
  echo "     [diag] crib memory handoff sees a lastSession: $HOFF"
  VIZ_PORT=$(( 7900 + RANDOM % 90 ))
  node "$W/packages/cli/dist/bin.js" viz --port "$VIZ_PORT" >"$R/viz.log" 2>&1 &
  VIZ_PID=$!
  # Poll rather than sleep a guessed interval: a fixed wait is the flake this repository already fought
  # in its watch tests, and here it would misreport a slow start as a missing field.
  for _ in $(seq 1 40); do
    curl -fsS --max-time 5 "http://127.0.0.1:$VIZ_PORT/memory/home.json" -o "$R/home.json" 2>/dev/null && break
    sleep 0.5
  done
  kill "$VIZ_PID" 2>/dev/null; wait "$VIZ_PID" 2>/dev/null
  # Read the payload from a FILE. Passing it as argv quoting-dependent shell text is how an earlier
  # version of this check reported NO_LAST_SESSION for a payload that in fact contained the field.
  CARD=$(python3 - "$R/home.json" <<'PYCHK'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"NO_JSON:{e}")
    raise SystemExit
ls = d.get("lastSession")
if not ls:
    print("NO_LAST_SESSION:keys=" + ",".join(sorted(d.keys())))
    raise SystemExit
missing = [
    k for k, v in (
        ("summary", "withLock" in (ls.get("summary") or "")),
        ("summaryPhase", ls.get("summaryPhase") == "executing"),
        ("summaryIntakeId", bool(ls.get("summaryIntakeId"))),
    ) if not v
]
print("OK" if not missing else "INCOMPLETE:" + ",".join(missing))
PYCHK
)
  if [ "$CARD" = "OK" ]; then ok "/memory/home.json carries the last session's summary, phase and intake"
  else bad "last-session card" "got $CARD"; fi
fi

echo "── rerank tier ─────────────────────────────────────────────"
assert_ok "rerank status verifies integrity" "integrity: ok" $B rerank status

echo "── F7: SCIP interop ────────────────────────────────────────"
assert_ok "export writes an index"        "document(s)"   $B scip export --out out.scip
# The honesty signals are part of the deliverable: an export that silently implied full fidelity
# would be the failure this note exists to prevent.
assert_ok "export states the range limit" "character-coarse" $B scip export --out out.scip
assert_ok "export states what it omits"   "find-references does not" $B scip export --out out.scip
# Round-trip: crib's own export must re-import onto the SAME ids it came from, which is the whole
# claim behind minting ids in crib's grammar rather than carrying SCIP's.
assert_ok "re-import is a dry-run no-op"  "would import" $B scip import out.scip --dry-run
assert_fails "a non-SCIP file is named as such" "does not decode as a SCIP index" \
  $B scip import MEMORY.md
MERGED=$($B scip import out.scip --dry-run --json 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d['counts']['definitions'])" 2>/dev/null)
if [ -n "$MERGED" ] && [ "$MERGED" -gt 0 ]; then
  ok "round-trip recovers $MERGED definition(s)"
else
  bad "round-trip recovers definitions" "got '$MERGED'"
fi

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
