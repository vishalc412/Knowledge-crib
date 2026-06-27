import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const repoUrl = 'git+https://github.com/KnowledgeCrib/knowledge-crib.git';
const issueUrl = 'https://github.com/KnowledgeCrib/knowledge-crib/issues';
const homepage = 'https://github.com/KnowledgeCrib/knowledge-crib#readme';
const requiredDocs = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
];
const packageFiles = [
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/mcp/package.json',
  'packages/parsers/package.json',
  'packages/pipeline/package.json',
  'packages/soul-schema/package.json',
  'packages/ui/package.json',
];
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const releaseVerifier = readFileSync('scripts/release-verify.mjs', 'utf8');

for (const file of requiredDocs) {
  assert.ok(existsSync(file), `${file} is required for open-source release readiness`);
}

const readme = readFileSync('README.md', 'utf8');
assert.doesNotMatch(
  readme,
  /status:\*\* implementation in progress/i,
  'README.md must describe the current release status',
);
assert.match(
  readme,
  /`?0\.1\.0`? release candidate/i,
  'README.md must identify the 0.1.0 release candidate',
);

const changelog = readFileSync('CHANGELOG.md', 'utf8');
assert.match(changelog, /## \[0\.1\.0\]/, 'CHANGELOG.md must document the 0.1.0 release');

assert.equal(
  rootPackage.scripts?.['publish:dry-run'],
  'corepack pnpm@9.15.0 -r publish --dry-run --no-git-checks',
  'package.json must expose the pinned recursive publish dry-run',
);
assert.match(
  releaseVerifier,
  /pnpm\(\['publish:dry-run'\]\)/,
  'release gate must exercise the recursive publish dry-run',
);

const notice = readFileSync('NOTICE', 'utf8');
const license = readFileSync('LICENSE', 'utf8');
for (const file of packageFiles) {
  const packageNotice = file.replace(/package\.json$/, 'NOTICE');
  const packageLicense = file.replace(/package\.json$/, 'LICENSE');
  assert.ok(existsSync(packageNotice), `${packageNotice} must ship with the package`);
  assert.ok(existsSync(packageLicense), `${packageLicense} must ship with the package`);
  assert.equal(
    readFileSync(packageNotice, 'utf8'),
    notice,
    `${packageNotice} must match root NOTICE`,
  );
  assert.equal(
    readFileSync(packageLicense, 'utf8'),
    license,
    `${packageLicense} must match root LICENSE`,
  );
}
const runtimeDependencies = new Set();
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!String(version).startsWith('workspace:')) runtimeDependencies.add(name);
  }
}
for (const dependency of runtimeDependencies) {
  assert.match(
    notice,
    new RegExp(dependency.replace('/', '\\/')),
    `NOTICE must name ${dependency}`,
  );
}
assert.doesNotMatch(
  notice,
  /@modelcontextprotocol\/server/,
  'NOTICE must not name the obsolete MCP package',
);

for (const [name, script] of Object.entries(rootPackage.scripts ?? {})) {
  if (!/\bpnpm\b/.test(script)) continue;
  assert.doesNotMatch(
    script,
    /(^|&&\s*|\|\|\s*|;\s*)pnpm\b/,
    `root script ${name} must pin pnpm through corepack`,
  );
}

for (const file of ['package.json', ...packageFiles]) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(pkg.license, 'Apache-2.0', `${file} must declare Apache-2.0`);
  assert.equal(pkg.repository?.type, 'git', `${file} must declare repository.type`);
  assert.equal(pkg.repository?.url, repoUrl, `${file} must declare repository.url`);
  assert.equal(pkg.bugs?.url, issueUrl, `${file} must declare bugs.url`);
  assert.equal(pkg.homepage, homepage, `${file} must declare homepage`);
  assert.ok(pkg.engines?.node, `${file} must declare supported Node versions`);
  assert.ok(
    Array.isArray(pkg.keywords) && pkg.keywords.length >= 3,
    `${file} must declare keywords`,
  );
  if (pkg.name?.startsWith('@')) {
    assert.equal(pkg.publishConfig?.access, 'public', `${file} scoped package must publish public`);
  }
}

console.log('release-metadata tests ok');
