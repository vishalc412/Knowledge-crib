import { execFileSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  process.stdout.write(`\n$ ${[cmd, ...args].join(' ')}\n`);
  // `corepack` (and other node-distributed CLIs) ship as .cmd shims on Windows;
  // execFileSync(shell:false) can't launch them (ENOENT), so shell them on win32.
  // `node` is a real .exe and never needs a shell — and a shell would MANGLE inline
  // `-e` scripts containing double-quotes: cmd.exe re-parses the arg string and
  // truncates the script at the first ", yielding `SyntaxError: Unexpected end of
  // input`. So shell only the .cmd-shim commands, not `node`. Posix is unaffected
  // (the `&& win32` guard short-circuits to shell:false, byte-identical to before).
  const needsShell = cmd !== 'node' && process.platform === 'win32';
  execFileSync(cmd, args, {
    stdio: 'inherit',
    shell: needsShell,
    ...opts,
  });
}

function pnpm(args) {
  run('corepack', ['pnpm@9.15.0', ...args]);
}

pnpm(['verify']);
pnpm(['test:python']);
pnpm(['release:metadata']);
pnpm(['pack:check']);
pnpm(['budget:check']);
pnpm(['eval:check']);
pnpm(['semantic:check']);
pnpm(['rerank:check']);
pnpm(['linker:check']);
pnpm(['alias:check']);
pnpm(['js-coverage:check']);
pnpm(['ifhash:check']);
pnpm(['tier:check']);
pnpm(['ownership:check']);
pnpm(['federation:check']);
pnpm(['stats:check']);
pnpm(['parallel:check']);
pnpm(['fuzz:check']);
pnpm(['scale:check']);
pnpm(['security:battery']);
pnpm(['security:check']);
pnpm(['soul-refresh:check']);
pnpm(['onboarding:check']);
pnpm(['docs-site:check']);
pnpm(['capabilities:check']);
// WP3 bullet 6 — the dependency-hygiene gates. `credential:check` and `license:check` ride inside
// `pnpm verify` above, so a secret or a newly-copyleft dependency is caught at build time as well as
// at release; they are not repeated here.
//
// `dep-risk:check` is wired WITHOUT `--allow-unavailable`, deliberately: the flag exists for local
// runs where the registry may be unreachable, and passing it here would let this gate go green
// without having checked anything — the false green the three-outcome model exists to prevent. A
// registry that cannot be reached must fail the release, not pass it.
pnpm(['dep-risk:check']);
run('node', ['scripts/client-certification-evidence.test.mjs']);
run('node', ['scripts/client-certification-matrix.test.mjs']);
run('node', ['scripts/client-certification-matrix.mjs', '--check']);
// WP2 — the certification harness's own executable specification. It drives the real `certifyCell`
// against a fake vendor binary, so the gate proves the harness REFUSES a cell it cannot exercise
// rather than only proving the receipt contract holds. A harness that could be satisfied by a stub
// would be the single most damaging thing this release could ship.
run('node', ['scripts/client-certify.test.mjs']);
// Task 7 — the native editor scenarios: the nine-operation automation contract, the three platform
// desktop backends (Swift/AXUIElement, C#/UI Automation, Python/AT-SPI), the versioned selector
// law (no fixed coordinates, no untested editor versions), and the scenario engine's honesty gate
// — a host with no validated selector set must produce a BLOCKED, non-certifying v3 receipt that
// still validates and feeds the launch matrix under the same cell names.
run('node', ['scripts/desktop-backend.test.mjs']);
// Task 10 — the host preflight's own executable specification. Every certification cell runs the
// preflight before any expensive work; its suite proves a missing fact becomes a NAMED blocker
// (never a silently satisfied check), that WSL and GitHub-hosted runners are refused as
// certification cells, and that the per-platform desktop lock serializes GUI execution (a held
// lock makes client-desktop-certify REFUSE to start; releasing it lets the run proceed).
run('node', ['scripts/host-preflight.test.mjs']);
// The frozen requirements themselves: the policy hash pin fails loudly if the launch policy was
// edited (or merely reformatted), because every receipt collected under the old hash is then void.
run('node', ['scripts/launch-policy.test.mjs']);
run('node', ['scripts/launch-decision.test.mjs']);
// Task 2 — the shared acceptance-receipt validator's own executable specification: identity, cell,
// run-identity, derived-status and artifact-byte gates, plus the v2 writer. Orphaned like the
// evidence tests above were: nothing ran it, so the validator could rot between releases.
run('node', ['scripts/acceptance-receipt.test.mjs']);
// Task 3 — the candidate bundle's verification (manifest + every workspace package checksum, the
// before/after digest guard, the isolated install's bin contract) and the collector's check table:
// which product each check exercises, the installed-adapter/install/freshness seams, and the
// writer's product flags. Nothing else runs these; they are the specification of "exercise the
// supplied installed candidate".
run('node', ['scripts/candidate-bundle.test.mjs']);
run('node', ['scripts/collect-acceptance-receipts.test.mjs']);
// WP9.1 — the release-evidence manifest builder's own invariants (dirty/red/certification
// legs, tamper/omission/duplicate) were previously orphaned: nothing ran this file.
run('node', ['scripts/release-evidence.test.mjs']);
// WP3 bullet 6 — the SBOM for the release artifacts. It is generated BEFORE the evidence manifest so
// the artifact exists when the manifest is written, and it is written to a gitignored path
// (sbom.cdx.json) under the same rule as release-evidence.json: running the gate locally must not
// dirty the checkout it certifies. The generator FAILS on any structural-invariant violation and
// writes nothing when it fails, so a broken document cannot be mistaken for a release artifact.
pnpm(['sbom:generate']);
// F07: this writes the receipt even when a frozen quality gate is red, then fails the release.
pnpm(['release:evidence']);
pnpm(['publish:dry-run']);
// crib-cache-stability.test.mjs (run inside installer:test) only rebuilds the gitignored derived
// index when the file is ABSENT — it can't detect a STALE one (e.g. left over from a manual
// `crib index .` in this working tree). Force a fresh index here so installer:test always sees a
// derived index that matches the currently committed soul, regardless of local dev-machine state.
run('node', ['packages/cli/dist/cli.js', 'index', '.'], {
  timeout: 8 * 60_000, // full repo re-parse is ~2-3min locally; allow headroom on slower CI runners
});
pnpm(['installer:test']);
pnpm(['installer:build']);
pnpm(['installer:smoke']);
// WP7.6 — the uninstall-with-memory leg must be part of the release gate, not only the beta
// workflow: it is the one leg proving a seeded memory store survives client-removal / uninstall /
// reinstall byte-identically. It reuses the installer:build output above and adds a few minutes
// (a third full install), which is the intended cost of pinning the persistence row.
pnpm(['installer:smoke-userdir']);
run(
  'node',
  [
    '--input-type=module',
    '-e',
    'import schema from "@knowledge-crib/soul-schema/schemas/node.schema.json" with { type: "json" }; console.log(schema["$schema"])',
  ],
  { cwd: 'packages/cli' },
);
run('node', ['scripts/release-cli-smoke.mjs']);
