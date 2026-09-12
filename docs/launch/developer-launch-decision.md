# Developer launch decision

## What is being decided

**Scope (launch policy version 3, `scripts/launch-policy.json`, frozen 2026-09-12).** The promise is
**seven clients on three native platforms — twenty-one cells, no waivers**: Claude Code, GitHub
Copilot, Cursor, VS Code, Codex, Windsurf and Gemini, each on macOS, native Linux and native Windows.
A cell is met only by a vendor runtime receipt for the exact candidate package.

**There is no preview tier.** Policy version 2 had narrowed the promise to Claude Code on macOS and
named the other twenty cells *preview*; version 3 removes that narrowing and its `uncertified`
escape hatch. A cell that cannot be executed leaves the release **NO-GO** rather than becoming
preview, so the honest answer for an unavailable client or host is a refused launch — not a smaller
promise quietly kept.

**WSL is not a native runtime.** A receipt whose `platform.wsl` is true reports `process.platform`
`linux` from a Windows host and can never satisfy a native Linux or Windows cell.

## The decision today

**NO-GO.** No cell has a vendor runtime receipt, because a cell requires a signed-in vendor client on
a native host of its platform and this machine cannot supply them. `launch-decision.mjs` reports a
named `client-cell-uncertified:*` blocker for each one, and that is the correct output: the policy
permits exactly this, and it is the only output that can be produced without fabricating evidence.

Nothing in this repository claims otherwise. The client table in
[the capability matrix](../capability-matrix.md) is generated from the same receipt directory, and it
reads `not certified` for all twenty-one cells until the receipts exist.

## Running the decision

Receipts are candidate-bound, so the whole set is collected together on a clean commit, and the
package is built **once** — `pnpm pack` orders dependency keys non-deterministically, so a rebuild
mid-pass would re-point every receipt at bytes nobody verified:

```bash
corepack pnpm@9.15.0 release:verify
node scripts/collect-acceptance-receipts.mjs --out ~/crib-launch-evidence/<date>
node scripts/release-evidence.mjs --require-pass --require-runtime-certification \
  --certification-platforms darwin,linux,win32
node scripts/launch-decision.mjs --evidence release-evidence.json
```

### The vendor cells cannot be automated

Twenty-one receipts in that set are not producible by a script, by CI, or by an agent. Each is
produced by the same harness, run once per client on a native host of the platform being certified:

```bash
node scripts/client-certify.mjs --client <id> --package <tarball> \
  --candidate-commit <sha> --out ~/crib-launch-evidence/<date>/receipts
```

It installs the candidate tarball into an isolated prefix, generates the config through the shipped
installer, and then drives the **real** vendor binary through eight legs: configuration, handshake,
tool use, record, a SIGKILL interruption, a restart that recovers that intake, an authorized resume,
and a foreign-principal exclusion planted through a second principal's config.

It must be run from a terminal where that client is **signed in**. A nested, non-interactive launch
reports `Not logged in`, and an unauthenticated client certifies nothing — which is the point: the
one piece of evidence that proves a real vendor application drove this build is the one piece a build
system cannot fabricate for itself.

`launch-decision.mjs` prints `GO` only when the evidence manifest passes and every one of the
twenty-one advertised cells has a validated vendor-client runtime receipt. It prints `NO-GO` with the
exact missing cells otherwise. A configuration file, a protocol simulator, a test client and a
self-authored log do not count as runtime evidence.

Update the generated table with:

```bash
node scripts/client-certification-matrix.mjs
node scripts/client-certification-matrix.mjs --check
```

The receipt directory `docs/launch/client-certification-receipts/` does not exist yet, which is why
every cell reads `not certified`. When the receipts are produced they are committed there, and the
table is regenerated from them; the command above refuses to render a row it cannot validate.

Cross-device sync remains **preview only**: the policy records that production promotion requires a
separate decision and scope authorization, and its version-3 protocol tests do not establish
production offline-divergence or interrupted-transfer behaviour across devices. It is a feature, not
a client cell, and it is the only thing under version 3 that is still preview-scoped. The local and
global memory stores, backup and restore commands, and explicit device sharing boundaries are
release-ready independently of that status.

## Superseded records

The dated reports under [`../audits/`](../audits/) are immutable — they record what was true on their
own date, and they are not edited when the policy moves. Two of them bear directly on this decision,
and both were written under the narrower promise:

- [`audits/2026-09-09/production-go-decision.md`](../audits/2026-09-09/production-go-decision.md)
  decided **NO-GO** with one blocker, `client-cell-uncertified:claude/darwin`, against candidate
  `01ac6103` under **policy version 2**. Version 3 replaces that scope: the blocker set is now all
  twenty-one cells, and the candidate is not frozen.
- [`audits/2026-09-11/competitor-feasibility.md`](../audits/2026-09-11/competitor-feasibility.md)
  recommends shipping as an explicitly labelled preview rather than holding distribution for
  certification. **That recommendation is declined.** Version 3 removes the preview tier precisely so
  that an unavailable cell produces NO-GO and not a smaller promise that quietly holds.

Neither report is wrong about its own date. This page is the current decision; those are the
history of how it was reached.

