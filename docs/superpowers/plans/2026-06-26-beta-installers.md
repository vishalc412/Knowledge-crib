# Beta Installers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce beta-ready macOS and Windows installer bundles for the Knowledge-crib CLI/MCP package, with reproducible packaging, smoke-install verification, and open-source release documentation.

**Architecture:** Knowledge-crib is a Node CLI/MCP product, so the installer artifact is a packed npm tarball plus platform installer scripts that install that exact tarball with npm into the user's global prefix. The release builder emits `dist/installers/knowledge-crib-<version>/`, installer scripts, the npm tarball, a manifest, and SHA-256 checksums; verification installs the tarball into a temporary prefix and runs the shipped CLI.

**Tech Stack:** Node.js ESM scripts, pnpm workspace packaging, npm global prefix smoke installs, Vitest-free Node assertions for release scripts, POSIX shell installer, PowerShell installer.

---

### Task 1: Installer Builder Script

**Files:**
- Create: `scripts/build-installers.mjs`
- Create: `scripts/build-installers.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

- [x] **Step 1: Write the failing installer builder contract test**

Create `scripts/build-installers.test.mjs` with tests that import pure helpers from `scripts/build-installers.mjs` and assert:

```js
import assert from 'node:assert/strict';
import { installSh, installPs1, normalizePackageVersion, sha256Hex } from './build-installers.mjs';

assert.equal(normalizePackageVersion({ name: 'knowledge-crib', version: '0.1.0' }).tag, 'knowledge-crib-0.1.0');
assert.match(sha256Hex(Buffer.from('abc')), /^[a-f0-9]{64}$/);
assert.match(installSh('knowledge-crib-0.1.0.tgz'), /npm install -g "\$SCRIPT_DIR\/knowledge-crib-0\.1\.0\.tgz"/);
assert.match(installPs1('knowledge-crib-0.1.0.tgz'), /npm install -g "\$PSScriptRoot[\\/]knowledge-crib-0\.1\.0\.tgz"/);
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-installers.test.mjs`

Expected: FAIL because `scripts/build-installers.mjs` does not exist.

- [x] **Step 3: Implement the builder**

Create `scripts/build-installers.mjs` with:

- Exported helpers `normalizePackageVersion`, `sha256Hex`, `installSh`, `installPs1`.
- `main()` that runs `pnpm --filter knowledge-crib pack --pack-destination <staging>`.
- Copies the generated `.tgz` into `dist/installers/knowledge-crib-<version>/`.
- Writes `install-macos.sh`, `install-windows.ps1`, `manifest.json`, and `SHA256SUMS.txt`.
- Uses only Node standard library.

- [x] **Step 4: Run the test to verify it passes**

Run: `node scripts/build-installers.test.mjs`

Expected: PASS and prints `build-installers tests ok`.

- [x] **Step 5: Wire scripts and ignore generated artifacts**

Update `package.json`:

```json
"installer:build": "node scripts/build-installers.mjs",
"installer:test": "node scripts/build-installers.test.mjs"
```

Update `.gitignore`:

```gitignore
dist/
*.tgz
```

### Task 2: Installer Smoke Verification

**Files:**
- Create: `scripts/install-smoke.mjs`
- Create: `scripts/install-smoke.test.mjs`
- Modify: `package.json`
- Modify: `scripts/release-verify.mjs`

- [x] **Step 1: Write the failing smoke helper test**

Create `scripts/install-smoke.test.mjs` that imports `findInstallerBundle` and `expectedBinPaths` and verifies the macOS/Linux bin path resolves to `<prefix>/bin/crib` and the Windows bin path resolves to `<prefix>/crib.cmd`.

- [x] **Step 2: Run the test to verify it fails**

Run: `node scripts/install-smoke.test.mjs`

Expected: FAIL because `scripts/install-smoke.mjs` does not exist.

- [x] **Step 3: Implement install smoke**

Create `scripts/install-smoke.mjs` that:

- Finds the newest `dist/installers/knowledge-crib-*/manifest.json`.
- Installs the bundled tarball with `npm install -g --prefix <tmpPrefix> <tarball>`.
- Runs `<tmpPrefix>/bin/crib --help` on macOS/Linux or `<tmpPrefix>/crib.cmd --help` on Windows.
- Runs `node <tmpPrefix>/lib/node_modules/knowledge-crib/dist/cli.js --help` as a direct fallback smoke.
- Removes the temporary prefix after the test.

- [x] **Step 4: Run smoke helper test**

Run: `node scripts/install-smoke.test.mjs`

Expected: PASS and prints `install-smoke tests ok`.

- [x] **Step 5: Wire release gate**

Update `package.json`:

```json
"installer:smoke": "node scripts/install-smoke.mjs"
```

Update `scripts/release-verify.mjs` to run:

```js
run('pnpm', ['installer:test']);
run('pnpm', ['installer:build']);
run('pnpm', ['installer:smoke']);
```

### Task 3: Open-Source Beta Release Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/knowledge-crib-client-setup.md`
- Modify: `docs/knowledge-crib-user-guide.md`
- Modify: `docs/knowledge-crib-production-readiness.md`
- Create: `docs/knowledge-crib-beta-installers.md`

- [x] **Step 1: Update docs to match the supported toolchain**

Replace stale `pnpm 11.x` references with `pnpm 9.15.0 via Corepack` and keep Node `>=20`.

- [x] **Step 2: Document beta installer artifacts**

Create `docs/knowledge-crib-beta-installers.md` with:

- Build command: `pnpm installer:build`.
- Verification command: `pnpm installer:smoke`.
- macOS install command: `./install-macos.sh`.
- Windows install command: `powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`.
- Checksum verification command using `SHA256SUMS.txt`.
- Current limitation: scripts require Node/npm on the target machine; signed `.pkg`/`.msi` installers need Apple Developer ID and Windows signing credentials in a later release step.

- [x] **Step 3: Link beta installer docs from README and production readiness**

Add links to the beta installer doc and list `pnpm installer:build` / `pnpm installer:smoke` in the release checklist.

### Task 4: Verification

**Files:**
- No production file changes unless a verification failure identifies a real issue.

- [x] **Step 1: Run builder unit tests**

Run: `pnpm installer:test`

Expected: PASS.

- [x] **Step 2: Run release package builder**

Run: `pnpm installer:build`

Expected: `dist/installers/knowledge-crib-0.1.0/` contains `.tgz`, `install-macos.sh`, `install-windows.ps1`, `manifest.json`, and `SHA256SUMS.txt`.

- [x] **Step 3: Run local install smoke**

Run: `pnpm installer:smoke`

Expected: PASS, CLI help prints from the installed package.

- [x] **Step 4: Run existing release gate**

Run: `pnpm release:verify`

Expected: PASS.

- [x] **Step 5: Inspect generated installer bundle**

Run: `find dist/installers -maxdepth 2 -type f -print`

Expected: only release artifacts and no source test/probe files.

## Self-Review

- Spec coverage: The plan covers macOS installer, Windows installer, beta release readiness, open-source docs, test/install verification, and release-gate integration. Native signed `.pkg`/`.msi` files are identified as credential-dependent follow-up work, not silently implied.
- Placeholder scan: No `TBD`, `TODO`, or vague testing instructions remain.
- Type consistency: Helper names are consistent across test and implementation tasks.
