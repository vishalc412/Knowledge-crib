# Developer launch decision

## What is being decided

**Scope (launch policy version 2).** This launch is certified for **Claude Code on macOS**. Every
other client — Copilot, Cursor, Codex, Windsurf, Gemini, VS Code — and every other platform is
**preview**: wired, protocol-tested and documented, with no vendor runtime evidence. The promise was
narrowed to the evidence rather than the evidence stretched to the promise; widening it back is a
policy change that reinstates each cell as a hard requirement and voids every receipt collected
under the old hash.

## Running the decision

Receipts are candidate-bound, so the whole set is collected together on a clean commit:

```bash
corepack pnpm@9.15.0 release:verify
node scripts/collect-acceptance-receipts.mjs --out ~/crib-launch-evidence/<date>
node scripts/release-evidence.mjs --require-pass --require-runtime-certification \
  --certification-platforms darwin
node scripts/launch-decision.mjs --evidence release-evidence.json
```

### The vendor cell cannot be automated

One receipt in that set is not producible by a script, by CI, or by an agent:

```bash
node scripts/client-certify-claude.mjs --out ~/crib-launch-evidence/<date>/receipts
```

It installs the candidate tarball into an isolated prefix, generates the config through the shipped
installer, and then drives the **real** `claude` binary through handshake, tool use, a uniquely
tagged authorized intake, a SIGKILL interruption, a restart that recovers that intake, and a
foreign-principal exclusion planted through a second principal's config.

It must be run from a terminal where Claude Code is **signed in**. A nested, non-interactive launch
reports `Not logged in`, and an unauthenticated client certifies nothing — which is the point: the
one piece of evidence that proves a real vendor application drove this build is the one piece a
build system cannot fabricate for itself.

`launch-decision.mjs` prints `GO` only when the evidence manifest passes and every advertised
client/platform cell — under policy 2, `claude/darwin` — has a validated vendor-client runtime
receipt. It prints `NO-GO` with the exact
missing cells otherwise. A configuration file, a protocol simulator, and a self-authored log do not
count as runtime evidence.

The client table in [the capability matrix](../capability-matrix.md) is generated from the same
receipt directory (`docs/launch/client-certification-receipts/`). Update it with:

```bash
node scripts/client-certification-matrix.mjs
node scripts/client-certification-matrix.mjs --check
```

Cross-device sync remains a preview feature until its separate v3, offline-divergence, and
cross-platform certification receipts are complete. The local/global memory stores, backup and
restore commands, and explicit device sharing boundaries are release-ready independently of that
preview status.
