import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Windows runners default to core.autocrlf=true, so checked-out YAML carries \r\n line endings
// and the structural regexes below (which match `on:\n  push:`) would fail. A workflow-shape test
// must not depend on the host's line-ending policy, so normalize CRLF → LF at read time.
const readLF = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const workflow = readLF('.github/workflows/beta-installers.yml');
const releaseWorkflow = readLF('.github/workflows/ci.yml');
const tagWorkflow = readLF('.github/workflows/release.yml');
const soulRefreshWorkflow = readLF('.github/workflows/crib-soul-refresh.yml');
const occurrences = (text, pattern) => [...text.matchAll(pattern)].length;
const dependabot = readLF('.github/dependabot.yml');

assert.match(workflow, /macos-latest/, 'beta installer CI must run on macOS');
assert.match(workflow, /windows-latest/, 'beta installer CI must run on Windows');
assert.match(
  workflow,
  /corepack pnpm@9\.15\.0 installer:build/,
  'CI must build beta installer artifacts',
);
assert.match(
  workflow,
  /corepack pnpm@9\.15\.0 installer:smoke/,
  'CI must smoke-install beta artifacts',
);
assert.match(workflow, /install-macos\.sh/, 'CI must execute the generated macOS installer');
assert.match(workflow, /install-windows\.ps1/, 'CI must execute the generated Windows installer');
assert.match(workflow, /actions\/upload-artifact@/, 'CI must upload installer bundles');
assert.match(workflow, /contents:\s*read/, 'installer CI must use read-only repository access');
assert.match(workflow, /cancel-in-progress:\s*true/, 'installer CI must cancel superseded runs');
assert.equal(
  occurrences(workflow, /^permissions:/gm),
  1,
  'installer CI must define permissions once',
);
assert.equal(
  occurrences(workflow, /^concurrency:/gm),
  1,
  'installer CI must define concurrency once',
);
assert.equal(
  occurrences(workflow, /^\s+timeout-minutes:/gm),
  1,
  'installer CI must define its job timeout once',
);

assert.match(releaseWorkflow, /ubuntu-latest/, 'release CI must run on Linux');
assert.match(
  releaseWorkflow,
  /corepack pnpm@9\.15\.0 release:verify/,
  'release CI must run the complete release gate',
);
assert.match(
  releaseWorkflow,
  /KCRIB_EMBED_HOME/,
  'release CI must isolate the semantic model cache from the runner home',
);
assert.match(
  releaseWorkflow,
  /embed setup --model large --yes/,
  'release CI must install the supported semantic tier before collecting release evidence',
);
assert.match(
  releaseWorkflow,
  /contents:\s*read/,
  'release CI must use read-only repository access',
);
assert.match(
  releaseWorkflow,
  /cancel-in-progress:\s*true/,
  'release CI must cancel superseded runs',
);
// WP6 slice D — the browser acceptance suite runs ONLY on the ubuntu release gate (it
// downloads real chromium), never on the Windows/matrix legs. Both pins must hold: the
// binaries are installed and the suite actually runs.
assert.match(
  releaseWorkflow,
  /playwright install --with-deps chromium/,
  'release CI must install chromium for the browser acceptance suite',
);
assert.match(
  releaseWorkflow,
  /verify:browser/,
  'release CI must run the browser acceptance suite against the real isolated backend',
);
// WP9.4 — logs-on-failed-jobs: BOTH CI jobs (release gate + verify matrix) must upload their
// failure diagnostics even when a step fails. `if: always()` on the upload step is what keeps
// release-evidence.json and run logs alive past a red gate; without it the artifact step is
// skipped on exactly the runs where the evidence matters.
assert.ok(
  occurrences(releaseWorkflow, /name:\s*Upload failure diagnostics\s*\n\s+if:\s*always\(\)/g) >= 2,
  'both CI jobs must carry an if: always() failure-diagnostics upload step',
);
assert.ok(
  occurrences(releaseWorkflow, /uses:\s+actions\/upload-artifact@/g) >= 2,
  'both CI jobs must upload failure diagnostics',
);
assert.match(
  releaseWorkflow,
  /if-no-files-found:\s*warn/,
  'CI diagnostics upload must be best-effort (warn, not error, when no files match)',
);

for (const [name, source] of [
  ['release CI', releaseWorkflow],
  ['installer CI', workflow],
  ['tag release', tagWorkflow],
]) {
  const actionRefs = [...source.matchAll(/uses:\s+actions\/[\w-]+@([^\s]+)/g)];
  assert.ok(actionRefs.length > 0, `${name} must use GitHub Actions`);
  for (const [, ref] of actionRefs) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${name} action references must use immutable SHAs`);
  }
}

assert.match(tagWorkflow, /tags:\s*\n\s*- ['"]v\*['"]/, 'release workflow must run for v* tags');
for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
  assert.match(tagWorkflow, new RegExp(os), `tag release must verify on ${os}`);
}
assert.match(
  tagWorkflow,
  /corepack pnpm@9\.15\.0 release:verify/,
  'tag release must run the complete release gate',
);
assert.match(
  tagWorkflow,
  /KCRIB_EMBED_HOME/,
  'tag release must isolate the semantic model cache from the runner home',
);
assert.match(
  tagWorkflow,
  /embed setup --model large --yes/,
  'tag release must install the supported semantic tier before collecting release evidence',
);
assert.match(
  tagWorkflow,
  /actions\/upload-artifact@/,
  'tag release must upload the verified bundle',
);
assert.match(
  tagWorkflow,
  /release-evidence\.json/,
  'tag release must archive the semantic release receipt',
);
assert.match(
  tagWorkflow,
  /actions\/download-artifact@/,
  'tag release must download the verified bundle',
);
assert.match(
  tagWorkflow,
  /v\$VERSION/,
  'tag release must compare the tag with the package version',
);
assert.match(tagWorkflow, /gh release create/, 'tag release must create the GitHub release');
assert.match(
  tagWorkflow,
  /contents:\s*write/,
  'release job must have permission to create a release',
);
// WP9.4 — the F07 diagnostic manifest is written before the gate exits 1, so the evidence
// upload must not be conditioned on the gate passing: strand it on failed runners and a
// NO-GO launch decision has no evidence to read.
assert.match(
  tagWorkflow,
  /name:\s*Upload release evidence\s*\n\s+if:\s*always\(\)/,
  'release evidence must upload even when the gate fails (if: always() on the upload step)',
);
// WP9.4 — ONE aggregated launch decision: a dedicated job downloads every per-OS evidence
// artifact and combines them via the aggregation CLI. The `if: !cancelled()` pin matters —
// the NO-GO path is exactly when the decision must still be printed.
assert.match(
  tagWorkflow,
  /launch-decision:\s*\n\s+name:\s*Aggregate launch decision\s*\n\s+needs:\s*verify/,
  'release workflow must have a launch-decision job aggregating after the verify matrix',
);
assert.match(
  tagWorkflow,
  /if:\s+\$\{\{\s*!cancelled\(\)\s*\}\}/,
  'launch-decision must run even when a verify cell fails (if: !cancelled())',
);
assert.match(
  tagWorkflow,
  /pattern:\s*knowledge-crib-release-evidence-\*/,
  'launch-decision must download every per-OS release evidence artifact',
);
assert.match(
  tagWorkflow,
  /scripts\/launch-decision\.mjs --cells /,
  'launch-decision must aggregate the per-OS evidence via scripts/launch-decision.mjs --cells',
);
// WP9.5 / WP9.3 — a tag is a launch decision: the release gate must demand client runtime
// certification receipts for every advertised platform cell.
assert.match(
  tagWorkflow,
  /--require-runtime-certification/,
  'tag release must require client runtime certification before shipping',
);
assert.match(
  tagWorkflow,
  /--certification-platforms darwin,linux,win32/,
  'tag release must certify every advertised platform (darwin, linux, win32)',
);

assert.match(dependabot, /package-ecosystem:\s*"npm"/, 'Dependabot must monitor npm dependencies');
assert.match(
  dependabot,
  /package-ecosystem:\s*"github-actions"/,
  'Dependabot must monitor GitHub Actions',
);

// M4.3 — crib-soul-refresh workflow shape. The "never stale" differentiator: on every merge, run
// `crib update` and commit the refreshed committed soul back. The behavioral idempotence (the
// property the auto-commit loop relies on) is pinned in scripts/soul-refresh-check.mjs; these
// assertions pin the workflow FILE shape — trigger, the crib update call, loop control, commit scope.
assert.match(
  soulRefreshWorkflow,
  /name:\s*Crib Soul Refresh/,
  'soul-refresh workflow must be named',
);
assert.match(
  soulRefreshWorkflow,
  /on:\n\s+push:\n\s+branches:\n\s+-\s+main\n\s+-\s+master/,
  'soul-refresh must trigger on push to main + master (merge)',
);
assert.match(
  soulRefreshWorkflow,
  /workflow_dispatch:/,
  'soul-refresh must allow manual workflow_dispatch',
);
assert.match(
  soulRefreshWorkflow,
  /contents:\s*write/,
  'soul-refresh needs contents:write to push the refreshed soul back',
);
assert.match(
  soulRefreshWorkflow,
  /node packages\/cli\/dist\/cli\.js update \./,
  'soul-refresh must run the built crib CLI `update` (the incremental re-extract)',
);
assert.match(
  soulRefreshWorkflow,
  /\[skip ci\]/,
  'soul-refresh auto-commit must carry [skip ci] so the push does not re-trigger the workflow',
);
assert.match(
  soulRefreshWorkflow,
  /github\.actor\s*!=\s*'github-actions\[bot\]'/,
  'soul-refresh must skip runs launched by the bot itself (loop-control belt-and-suspenders)',
);
assert.match(
  soulRefreshWorkflow,
  /github-actions\[bot\]@users\.noreply\.github\.com/,
  'soul-refresh commit must be authored by github-actions[bot]',
);
// commit scope: the canonical graph plus dossiers/schema/bootstrap manifest —
// NEVER the gitignored derived .crib/index or .crib/embeddings.
assert.match(
  soulRefreshWorkflow,
  /git add \.crib\/graph \.crib\/dossiers \.crib\/schema \.crib\/crib\.json/,
  'soul-refresh must stage only the committed soul artifacts, never the derived index/embeddings',
);
assert.match(
  soulRefreshWorkflow,
  /git diff --staged --quiet/,
  'soul-refresh must skip the commit when the diff is empty (idempotent no-op)',
);
assert.match(
  soulRefreshWorkflow,
  /fetch-depth:\s*0/,
  'soul-refresh needs full git history for the vcsHead anchor diff',
);
assert.equal(
  occurrences(soulRefreshWorkflow, /contents:\s*write/g),
  1,
  'soul-refresh must define permissions once',
);
assert.equal(
  occurrences(soulRefreshWorkflow, /concurrency:/g),
  1,
  'soul-refresh must define concurrency once',
);

console.log('ci-workflow tests ok');
