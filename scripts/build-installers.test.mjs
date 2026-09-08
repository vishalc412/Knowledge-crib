import assert from 'node:assert/strict';
import { installPs1, installSh, normalizePackageVersion, sha256Hex } from './build-installers.mjs';

assert.equal(
  normalizePackageVersion({ name: 'knowledge-crib', version: '0.1.0' }).tag,
  'knowledge-crib-0.1.0',
);
assert.match(sha256Hex(Buffer.from('abc')), /^[a-f0-9]{64}$/);
assert.match(
  installSh(['@knowledge-crib-core-0.1.0.tgz', 'knowledge-crib-0.1.0.tgz']),
  /npm install -g --cache "\$CACHE_DIR" --no-audit --no-fund "\$SCRIPT_DIR\/@knowledge-crib-core-0\.1\.0\.tgz" "\$SCRIPT_DIR\/knowledge-crib-0\.1\.0\.tgz"/,
);
assert.match(installSh(['knowledge-crib-0.1.0.tgz']), /--cache "\$CACHE_DIR"/);
assert.match(installSh(['knowledge-crib-0.1.0.tgz']), /mktemp -d/);
assert.match(installSh(['knowledge-crib-0.1.0.tgz']), /NODE_MAJOR/);
assert.match(installSh(['knowledge-crib-0.1.0.tgz']), /SHA256SUMS\.txt/);
assert.match(installSh(['knowledge-crib-0.1.0.tgz']), /shasum -a 256 -c/);
assert.match(installSh(['knowledge-crib-0.1.0.tgz']), /sha256sum -c/);
// Tarball specs are `./<name>` (forward-slash, relative), resolved against the bundle dir via
// Push-Location $PSScriptRoot — NOT `"$PSScriptRoot\<name>"`, which PS 5.1 + the npm.cmd batch shim
// mangle in the native-arg stream (middle path segments stripped -> npm sees `D:\<name>` -> ENOENT).
assert.match(
  installPs1(['@knowledge-crib-core-0.1.0.tgz', 'knowledge-crib-0.1.0.tgz']),
  /npm install -g --cache "\$CacheDir" --no-audit --no-fund "\.\/@knowledge-crib-core-0\.1\.0\.tgz" "\.\/knowledge-crib-0\.1\.0\.tgz"/,
);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /Push-Location -LiteralPath \$PSScriptRoot/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /Pop-Location/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /--cache "\$CacheDir"/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /NodeMajor/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /SHA256SUMS\.txt/);
// Checksum verification uses the .NET SHA256 API (Get-KcFileHash wrapper), not the Get-FileHash
// cmdlet — Get-FileHash is not auto-loaded on some stock Windows PowerShell 5.1 hosts (e.g. GitHub
// windows-latest runners under `powershell.exe -NoProfile`), which broke the installer there.
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /Get-KcFileHash/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /SHA256\]::Create/);
assert.match(
  installPs1(['knowledge-crib-0.1.0.tgz']),
  /\$LASTEXITCODE/,
  'PowerShell installer must fail when npm exits nonzero',
);

console.log('build-installers tests ok');

// The installer finishes the setup rather than stopping at "installed": a binary on PATH is not a
// wired repository, and the four remaining commands were previously left for the operator to
// discover. Both opt-outs must be present in both installers, or "skip the 2.1 GB model" becomes
// unreachable for anyone installing from a bundle.
//
// Setup is invoked through the ABSOLUTE entry point resolved from the npm prefix npm just
// installed into — never a bare `crib` PATH lookup. The bare form failed on any host where the
// prefix's bin dir is not on the current process PATH: custom npm prefixes
// (npm_config_prefix) and every installer smoke that installs into an isolated prefix on
// purpose — the exact windows-latest installer failure ("The term 'crib' is not recognized").
for (const [name, render] of [
  ['installSh', installSh],
  ['installPs1', installPs1],
]) {
  const text = render(['knowledge-crib-0.1.0.tgz']);
  assert.match(text, /setup \./, `${name} should run setup against the current directory`);
  assert.match(
    text,
    /node_modules[/\\]knowledge-crib[/\\]dist[/\\]cli\.js/,
    `${name} should resolve the installed crib entry point from the npm prefix`,
  );
  assert.doesNotMatch(
    text,
    /(^|\n)\s*(crib|& crib) setup /,
    `${name} must not invoke setup through a bare PATH lookup`,
  );
  assert.match(text, /KCRIB_NO_SETUP/, `${name} should honour KCRIB_NO_SETUP`);
  assert.match(text, /KCRIB_NO_EMBED/, `${name} should document KCRIB_NO_EMBED`);
  assert.match(
    text,
    /rev-parse --is-inside-work-tree/,
    `${name} should only auto-setup inside a git work tree`,
  );
}
// The shell installer resolves the prefix with `npm prefix -g` and prepends its bin dir to PATH so
// crib is usable in the SAME shell (a new shell resolves it via the user PATH).
{
  const text = installSh(['knowledge-crib-0.1.0.tgz']);
  assert.match(text, /NPM_PREFIX=\$\(npm prefix -g/, 'installSh should resolve the npm prefix');
  assert.match(text, /node "\$CRIB_ENTRY" setup \./, 'installSh should invoke node <entry> setup .');
}
// The Windows installer resolves the prefix with `npm prefix -g` (APPDATA fallback), then invokes
// the entry via node with an explicit nonzero-exit warning — never a bare `crib`.
{
  const text = installPs1(['knowledge-crib-0.1.0.tgz']);
  assert.match(text, /npm prefix -g/, 'installPs1 should resolve the npm prefix');
  assert.match(text, /& node \$CribEntry setup \./, 'installPs1 should invoke node <entry> setup .');
  assert.match(text, /\$LASTEXITCODE -ne 0[\s\S]*?crib setup did not complete/);
}
