import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import {
  expectedBinPaths,
  fileDigests,
  findInstallerBundle,
  installedBinCommand,
  installerCommand,
  npmInstallArgs,
  scenarioMemoryRoots,
  scenarioRepoId,
  seedScenarioMemory,
  smokeMemoryRecord,
  userDirEnv,
  userDirScenarioPaths,
  validateMemorySurvived,
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

// ─── WP7.6 — the uninstall-with-memory fixture's seeding/survival logic ─────────
//
// The smoke leg itself installs/uninstalls real npm packages (minutes, network), so these pins
// exercise the pure halves the gate can check on every run: the seeded store layout, the
// content-addressed record ids, the digest baseline, and the survival verdict's failure modes.

// The two seeded store roots follow the memory package's paths.ts layout: global under the
// scenario home's ~/.crib/memory, team inside the scenario project's .crib/memory.
const memRoots = scenarioMemoryRoots(scenario);
assert.equal(memRoots.global, join(scenario.home, '.crib', 'memory', 'global'));
assert.equal(memRoots.team, join(scenario.project, '.crib', 'memory', 'team'));

// Records are content-addressed: identical input → identical id, a different claim → different id,
// and the id is the memory package's `mem:<blake3>` shape (the strict store loader rejects a
// hand-computed id, so seeding through anything else would not round-trip through recall).
const recordInput = {
  subject: 'topic:install-smoke',
  claim: 'memory survives uninstall',
  scope: { boundary: 'global' },
  actor: 'install-smoke',
  at: '2026-01-01T00:00:00.000Z',
};
const seeded = smokeMemoryRecord(recordInput);
assert.match(seeded.id, /^mem:[0-9a-f]{64}$/);
assert.equal(seeded.id, smokeMemoryRecord(recordInput).id);
assert.notEqual(seeded.id, smokeMemoryRecord({ ...recordInput, claim: 'different claim' }).id);
// recall-eligible verdicts, stamped like the repo's memory test fixtures.
assert.deepEqual(seeded.verdicts, {
  trust: 'local',
  evidence: 'valid',
  applicability: 'current',
  lifecycle: 'active',
});

// Seeding writes BOTH stores through the real MemoryStore and captures a digest baseline that
// covers the written shard. scenarioRepoId resolves the repoId from the project's crib.json.
const memRoot = mkdtempSync(join(tmpdir(), 'kc-smoke-memory-'));
try {
  const memPaths = {
    home: join(memRoot, 'home'),
    project: join(memRoot, 'project'),
  };
  mkdirSync(join(memPaths.project, '.crib'), { recursive: true });
  writeFileSync(
    join(memPaths.project, '.crib', 'crib.json'),
    `${JSON.stringify({ repo: { id: 'r-smoke', root: '.' } }, null, 2)}\n`,
  );
  assert.equal(scenarioRepoId(memPaths), 'r-smoke');

  const memSeed = seedScenarioMemory({
    paths: memPaths,
    env: { ...process.env, HOME: memPaths.home },
  });
  assert.match(memSeed.records.global.id, /^mem:[0-9a-f]{64}$/);
  assert.match(memSeed.records.team.id, /^mem:[0-9a-f]{64}$/);
  assert.notEqual(memSeed.records.global.id, memSeed.records.team.id);
  assert.deepEqual(memSeed.records.team.scope, { boundary: 'repo', repoId: 'r-smoke' });
  assert.deepEqual(memSeed.records.global.scope, { boundary: 'global' });
  // the seeded shards exist and are in the digest baseline (the global store writes records/*.jsonl
  // plus generation markers; the baseline must cover whatever an uninstall+reinstall could touch).
  assert.ok(
    Object.keys(memSeed.digests.global).some((rel) => /^records\/.*\.jsonl$/.test(rel)),
    'the global digest baseline must cover the seeded record shard',
  );
  assert.ok(
    Object.keys(memSeed.digests.team).some((rel) => /^records\/.*\.jsonl$/.test(rel)),
    'the team digest baseline must cover the seeded record shard',
  );
  // digests are stable on an untouched tree and keyed by relative path.
  const redigested = {
    global: fileDigests(memSeed.roots.global),
    team: fileDigests(memSeed.roots.team),
  };
  assert.deepEqual(redigested, memSeed.digests);

  // the survival verdict passes when recall returns both ids and the bytes are unchanged…
  assert.equal(
    validateMemorySurvived({
      seed: memSeed,
      recall: {
        memories: [{ id: memSeed.records.global.id }, { id: memSeed.records.team.id }],
      },
      digests: redigested,
    }),
    true,
  );
  // …and fails on each axis: a record recall no longer returns…
  assert.throws(
    () =>
      validateMemorySurvived({
        seed: memSeed,
        recall: { memories: [{ id: memSeed.records.global.id }] },
        digests: redigested,
      }),
    /did not survive uninstall \+ reinstall/,
  );
  // …a mutated store file…
  const drifted = {
    global: { ...redigested.global },
    team: { ...redigested.team },
  };
  const [teamShard] = Object.keys(drifted.team).filter((rel) => rel.endsWith('.jsonl'));
  drifted.team[teamShard] = '0'.repeat(64);
  assert.throws(
    () =>
      validateMemorySurvived({
        seed: memSeed,
        recall: {
          memories: [{ id: memSeed.records.global.id }, { id: memSeed.records.team.id }],
        },
        digests: drifted,
      }),
    new RegExp(
      `memory store "team" changed[^]*${teamShard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  // …and a file that appeared or vanished (key-set change, not just bytes).
  const extraFile = {
    global: { ...redigested.global, 'records/99.jsonl': '1'.repeat(64) },
    team: redigested.team,
  };
  assert.throws(
    () =>
      validateMemorySurvived({
        seed: memSeed,
        recall: {
          memories: [{ id: memSeed.records.global.id }, { id: memSeed.records.team.id }],
        },
        digests: extraFile,
      }),
    /memory store "global" changed/,
  );
} finally {
  rmSync(memRoot, { recursive: true, force: true });
}

// fileDigests: missing root → empty baseline (a store that was never created survives trivially,
// but the verdict treats it as a key-set change when the seed HAD files).
assert.deepEqual(fileDigests(join(tmpdir(), 'kc-smoke-missing-root-')), {});

// scenarioRepoId fails closed when neither the project manifest nor the registry can resolve an id.
assert.throws(
  () => scenarioRepoId({ home: join(memRoot, 'home'), project: join(memRoot, 'nope') }),
  /could not resolve the scenario project's repoId/,
);

console.log('install-smoke tests ok');
