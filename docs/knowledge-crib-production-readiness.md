# Knowledge-crib Production Readiness

Date: 2026-06-26

This note records the production gate, release fixes, and remaining non-blocking gaps for the first
production candidate.

## Release Gate

Use one command before tagging or publishing:

```bash
corepack pnpm@9.15.0 release:verify
```

That gate runs:

- `verify` for TypeScript build, Vitest suites, and Biome.
- `test:python` for the Python worker unittest suite.
- `pack:check` for package dry-runs and test/probe artifact rejection.
- `publish:dry-run` for the exact recursive pnpm publish lifecycle without registry writes.
- `installer:test`, `installer:build`, and `installer:smoke` for beta installer
  generation and local install verification.
- JSON schema import smoke check for `@knowledge-crib/soul-schema/schemas/node.schema.json`.
- A hermetic CLI smoke project that runs `crib index` and validates parsed `crib status` output
  without relying on the checkout's ignored derived index.

## Fixed For Release

- Root package stays private; publishable workspace packages are set to `0.1.0`.
- `crib index` and `crib reindex` now build the derived SQLite index explicitly.
- Read commands open the existing derived index and no longer rebuild/drop SQLite tables on every
  invocation, avoiding concurrent read lock contention.
- SQLite rebuilds write a temporary database and atomically swap it into place.
- `crib gaps` now filters builtin/external unresolved calls by default, exposes them with
  `--include-builtins`, and reports `summary.byCategory` for project, tests, fixtures, builtins, and
  external libraries.
- `@knowledge-crib/ui` has a real `buildVizGraph` Vitest smoke test; its test script no longer uses
  `--passWithNoTests`.
- Package dry-runs reject `*.test.*` and `__probe__` artifacts.
- Every published package explicitly carries the canonical Apache `LICENSE` and project `NOTICE`;
  the release metadata gate prevents package copies from drifting.
- Beta installer bundles are generated under `dist/installers/` with all workspace package tarballs,
  macOS and Windows installer scripts, manifest metadata, checksums, and local npm-prefix smoke
  installation.
- Generated installers enforce Node.js 20 or newer, verify all bundled checksums before installation,
  and use isolated temporary npm caches; CI smoke tests execute the scripts themselves and use the
  installed package to index and validate a temporary project.
- GitHub Actions verifies the complete release gate on Linux and performs installer build/install
  smoke tests on hosted macOS and Windows runners. Verified bundles are retained as workflow
  artifacts.
- GitHub Actions use immutable commit pins, read-only repository permissions, concurrency controls,
  and Dependabot coverage for npm and workflow dependencies.
- Pushing a `v*` tag runs the complete gate on Linux, macOS, and Windows, validates the tag against
  the bundle version, and creates a GitHub release only after all three jobs pass.
- The schema JSON subpath export resolves to shipped JSON files.

## Release Checklist

1. Confirm versions and changelog for the `0.1.0` production candidate.
2. Run `corepack pnpm@9.15.0 release:verify`.
3. Confirm `corepack pnpm@9.15.0 pack:check` output contains no test or probe files.
4. Confirm `corepack pnpm@9.15.0 publish:dry-run` selects all seven `0.1.0` packages.
5. Confirm `dist/installers/knowledge-crib-0.1.0/` contains the workspace `.tgz` files, macOS
   installer, Windows installer, manifest, and `SHA256SUMS.txt`.
6. Confirm the Linux, macOS, and Windows GitHub Actions jobs pass on the exact release commit.
7. Push the matching tag (for example, `v0.1.0`); the tag workflow re-verifies all three operating
   systems and creates the GitHub release with the verified bundle.
8. Publish the npm packages with the chosen provenance policy.
9. Re-run the hermetic CLI smoke against the published packages after publish.

## Known Non-Blockers

- LLM graph generation is optional post-release enrichment. `llmGraph: false` is acceptable for a
  deterministic-core release.
- Current repo status may show pending LLM graph targets. To enrich after release:

```bash
crib skill install
/crib-enrich
crib enrich --overview
```

- `crib gaps .` may still report real missing package bodies or unresolved project symbols. Those are
  honest analysis-readiness signals, not release blockers for the deterministic tooling itself.
- Native signed `.pkg` and `.msi` installers require Apple Developer ID, Windows signing, and
  notarization credentials. The beta installer bundle is the credential-free release artifact.
