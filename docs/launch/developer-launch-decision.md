# Developer launch decision

Run the release verification on a clean commit, then create the strict manifest and decision:

```bash
corepack pnpm@9.15.0 release:verify
node scripts/release-evidence.mjs --require-pass --require-runtime-certification \
  --certification-platforms darwin,linux,win32
node scripts/launch-decision.mjs --evidence release-evidence.json
```

`launch-decision.mjs` prints `GO` only when the evidence manifest passes and every advertised
client/platform cell has a validated vendor-client runtime receipt. It prints `NO-GO` with the exact
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
