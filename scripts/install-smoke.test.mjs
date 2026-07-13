import assert from 'node:assert/strict';
import { join } from 'node:path';
import path from 'node:path';
import {
  expectedBinPaths,
  findInstallerBundle,
  installedBinCommand,
  installerCommand,
  npmInstallArgs,
  validateSmokeStatus,
} from './install-smoke.mjs';

assert.equal(expectedBinPaths('/tmp/kc', 'darwin').bin, join('/tmp/kc', 'bin', 'crib'));
assert.equal(
  expectedBinPaths('/tmp/kc', 'darwin').direct,
  join('/tmp/kc', 'lib', 'node_modules', 'knowledge-crib', 'dist', 'cli.js'),
);
assert.equal(expectedBinPaths('C:\\kc', 'win32').bin, path.win32.join('C:\\kc', 'crib.cmd'));
assert.equal(
  expectedBinPaths('C:\\kc', 'win32').direct,
  path.win32.join('C:\\kc', 'node_modules', 'knowledge-crib', 'dist', 'cli.js'),
);

assert.deepEqual(installedBinCommand('/tmp/kc/bin/crib', 'darwin'), {
  command: '/tmp/kc/bin/crib',
  args: ['--help'],
});
assert.deepEqual(
  installedBinCommand('C:\\Program Files\\Knowledge Crib\\crib.cmd', 'win32', {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  }),
  {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\Program Files\\Knowledge Crib\\crib.cmd" --help'],
  },
);

assert.deepEqual(installerCommand('/tmp/bundle', 'darwin'), {
  command: 'sh',
  args: [join('/tmp/bundle', 'install-macos.sh')],
});
assert.deepEqual(installerCommand('C:\\bundle', 'win32'), {
  command: 'powershell.exe',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.win32.join('C:\\bundle', 'install-windows.ps1'),
  ],
});

assert.throws(
  () => findInstallerBundle(join(process.cwd(), 'missing-installers')),
  /No installer bundles found/,
);

assert.deepEqual(npmInstallArgs('/tmp/kc', ['/tmp/dep.tgz', '/tmp/pkg.tgz']), [
  'install',
  '-g',
  '--prefix',
  '/tmp/kc',
  '--cache',
  join('/tmp/kc', '.npm-cache'),
  '--fetch-retries',
  '1',
  '--fetch-retry-mintimeout',
  '1000',
  '--fetch-retry-maxtimeout',
  '5000',
  '--fetch-timeout',
  '15000',
  '--no-audit',
  '--no-fund',
  '/tmp/dep.tgz',
  '/tmp/pkg.tgz',
]);

assert.deepEqual(
  validateSmokeStatus({ indexed: true, schemaVersion: '1.4', stats: { nodes: 4, edges: 2 } }),
  { indexed: true, schemaVersion: '1.4', stats: { nodes: 4, edges: 2 } },
);
assert.throws(
  () => validateSmokeStatus({ indexed: false, stats: { nodes: 0 } }),
  /did not produce an indexed graph/,
);
assert.throws(
  () => validateSmokeStatus({ indexed: true, stats: { nodes: 0 } }),
  /did not extract any nodes/,
);

console.log('install-smoke tests ok');
