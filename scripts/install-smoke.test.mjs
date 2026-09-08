import assert from 'node:assert/strict';
import { join } from 'node:path';
import path from 'node:path';
import {
  expectedBinPaths,
  findInstallerBundle,
  installedBinCommand,
  installerCommand,
  npmInstallArgs,
  userDirEnv,
  userDirScenarioPaths,
  validateSmokeStatus,
} from './install-smoke.mjs';

// Darwin bin/direct paths are always POSIX regardless of the host runner's platform — use
// path.posix.join so the expected value does not flip to backslashes on a Windows runner.
assert.equal(expectedBinPaths('/tmp/kc', 'darwin').bin, path.posix.join('/tmp/kc', 'bin', 'crib'));
assert.equal(
  expectedBinPaths('/tmp/kc', 'darwin').direct,
  path.posix.join('/tmp/kc', 'lib', 'node_modules', 'knowledge-crib', 'dist', 'cli.js'),
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
    // Separate args (no pre-quoting, no /s) — see installedBinCommand: a single pre-quoted arg
    // was double-escaped by Node's execFileSync arg escaping, so cmd.exe saw `\"…\crib.cmd\"` as
    // the program name. Separate args let Node quote only a spaced path + pass --help through.
    args: ['/d', '/c', 'C:\\Program Files\\Knowledge Crib\\crib.cmd', '--help'],
  },
);

assert.deepEqual(installerCommand('/tmp/bundle', 'darwin'), {
  command: 'sh',
  args: [path.posix.join('/tmp/bundle', 'install-macos.sh')],
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
  validateSmokeStatus({ indexed: true, schemaVersion: '1.5', stats: { nodes: 4, edges: 2 } }),
  { indexed: true, schemaVersion: '1.5', stats: { nodes: 4, edges: 2 } },
);
assert.throws(
  () => validateSmokeStatus({ indexed: false, stats: { nodes: 0 } }),
  /did not produce an indexed graph/,
);
assert.throws(
  () => validateSmokeStatus({ indexed: true, stats: { nodes: 0 } }),
  /did not extract any nodes/,
);

// WP1.6 — every path in the scenario must carry BOTH a space and a non-ASCII byte, so the smoke
// can never silently degrade back to an ASCII-safe temp dir.
const scenario = userDirScenarioPaths(join(path.sep === '\\' ? 'C:' : '', 'tmp', 'kc-userdir'));
for (const p of [scenario.home, scenario.prefix, scenario.project]) {
  assert.ok(p.includes(' '), `scenario path must contain a space: ${p}`);
  assert.ok(
    [...p].some((ch) => ch.codePointAt(0) > 0x7f),
    `scenario path must contain a non-ASCII byte: ${p}`,
  );
}
assert.equal(scenario.prefix.startsWith(scenario.home), true);
assert.equal(scenario.project.startsWith(scenario.home), true);
// The env must relocate BOTH homedir sources (HOME for darwin/linux, USERPROFILE for win32) and
// the npm prefix — a smoke that only sets one leaves the other platform reading the real user home.
const scenarioEnv = userDirEnv(scenario);
assert.equal(scenarioEnv.HOME, scenario.home);
assert.equal(scenarioEnv.USERPROFILE, scenario.home);
assert.equal(scenarioEnv.npm_config_prefix, scenario.prefix);

console.log('install-smoke tests ok');
