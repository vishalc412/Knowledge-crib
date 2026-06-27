import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/beta-installers.yml', 'utf8');
const releaseWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const tagWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const occurrences = (text, pattern) => [...text.matchAll(pattern)].length;
const dependabot = readFileSync('.github/dependabot.yml', 'utf8');

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
  /contents:\s*read/,
  'release CI must use read-only repository access',
);
assert.match(
  releaseWorkflow,
  /cancel-in-progress:\s*true/,
  'release CI must cancel superseded runs',
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
  /actions\/upload-artifact@/,
  'tag release must upload the verified bundle',
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

assert.match(dependabot, /package-ecosystem:\s*"npm"/, 'Dependabot must monitor npm dependencies');
assert.match(
  dependabot,
  /package-ecosystem:\s*"github-actions"/,
  'Dependabot must monitor GitHub Actions',
);

console.log('ci-workflow tests ok');
