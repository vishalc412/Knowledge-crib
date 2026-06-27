# Knowledge-crib Beta Installers

Date: 2026-06-26

Knowledge-crib is currently a Node.js CLI/MCP product. The beta installer bundle packages the exact
workspace npm tarballs for the `0.1.0` release candidate plus platform install scripts for macOS
and Windows. Bundling the workspace tarballs lets the installer smoke-test unpublished internal
packages before the public npm publish step.

## Build The Bundle

```bash
corepack pnpm@9.15.0 installer:build
```

The builder writes:

```text
dist/installers/knowledge-crib-0.1.0/
  knowledge-crib-soul-schema-0.1.0.tgz
  knowledge-crib-core-0.1.0.tgz
  knowledge-crib-parsers-0.1.0.tgz
  knowledge-crib-ui-0.1.0.tgz
  knowledge-crib-mcp-0.1.0.tgz
  knowledge-crib-pipeline-0.1.0.tgz
  knowledge-crib-0.1.0.tgz
  install-macos.sh
  install-windows.ps1
  manifest.json
  SHA256SUMS.txt
```

## Verify The Bundle

```bash
corepack pnpm@9.15.0 installer:test
corepack pnpm@9.15.0 installer:smoke
```

`installer:smoke` executes the generated platform installer with a temporary npm global prefix. The
installer verifies every entry in `SHA256SUMS.txt`, enforces Node.js 20 or newer, installs with an
isolated npm cache, and then the harness uses the installed package to run `crib --help`, index a
temporary TypeScript project, and validate parsed `crib status` output.

## Cross-platform CI

`.github/workflows/beta-installers.yml` runs the installer tests, bundle build, temporary-prefix
smoke install, and generated platform installer on both `macos-latest` and `windows-latest`. Each
matrix job uploads its verified bundle as a GitHub Actions artifact. `.github/workflows/ci.yml`
separately runs the complete `release:verify` gate on Linux with read-only repository permissions.
Workflow actions are pinned to immutable commit SHAs and Dependabot proposes npm and GitHub Actions
updates.

On a `v*` tag, `.github/workflows/release.yml` reruns the complete gate on Linux, macOS, and Windows,
checks that the tag matches the bundle version, and creates the GitHub release from the verified
bundle.

Before publishing a beta, require all three operating-system jobs to pass for the release commit and
download one of the uploaded installer artifacts for the GitHub release.

## macOS Install

Requirements: Node.js 20 or newer with npm.

From the extracted installer bundle:

```bash
shasum -a 256 -c SHA256SUMS.txt
./install-macos.sh
crib --help
```

## Windows Install

Requirements: Node.js 20 or newer with npm.

From PowerShell in the extracted installer bundle:

```powershell
Get-FileHash .\*.tgz, .\install-macos.sh, .\install-windows.ps1 -Algorithm SHA256
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
crib --help
```

Compare `Get-FileHash` output with `SHA256SUMS.txt` before installing. The installer repeats that
verification and stops on any mismatch or npm failure.

## Current Beta Limitation

These beta installers require Node/npm on the target machine and use npm to fetch third-party
dependencies such as `ajv`, `typescript`, and `better-sqlite3`. Native signed `.pkg` and `.msi`
installers should be added after Apple Developer ID, Windows code-signing, and release notarization
credentials are available.
