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
for (const [name, render] of [
  ['installSh', installSh],
  ['installPs1', installPs1],
]) {
  const text = render(['knowledge-crib-0.1.0.tgz']);
  assert.match(text, /crib setup \./, `${name} should run \`crib setup .\` after installing`);
  assert.match(text, /KCRIB_NO_SETUP/, `${name} should honour KCRIB_NO_SETUP`);
  assert.match(text, /KCRIB_NO_EMBED/, `${name} should document KCRIB_NO_EMBED`);
  assert.match(
    text,
    /rev-parse --is-inside-work-tree/,
    `${name} should only auto-setup inside a git work tree`,
  );
}
