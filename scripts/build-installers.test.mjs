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
assert.match(
  installPs1(['@knowledge-crib-core-0.1.0.tgz', 'knowledge-crib-0.1.0.tgz']),
  /npm install -g --cache "\$CacheDir" --no-audit --no-fund "\$PSScriptRoot[\\/]@knowledge-crib-core-0\.1\.0\.tgz" "\$PSScriptRoot[\\/]knowledge-crib-0\.1\.0\.tgz"/,
);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /--cache "\$CacheDir"/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /NodeMajor/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /SHA256SUMS\.txt/);
assert.match(installPs1(['knowledge-crib-0.1.0.tgz']), /Get-FileHash/);
assert.match(
  installPs1(['knowledge-crib-0.1.0.tgz']),
  /\$LASTEXITCODE/,
  'PowerShell installer must fail when npm exits nonzero',
);

console.log('build-installers tests ok');
