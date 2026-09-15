#!/usr/bin/env node
/**
 * Certification host preflight tests (Task 10).
 *
 * The preflight's contract is honesty about infrastructure: a host that cannot certify a vendor
 * cell must fail HERE, with a named blocker an operator can act on — never as a certification run
 * that times out, and never as a launch queued forever. These tests pin that contract over a
 * matrix of fake hosts, exercising every branch on ANY machine (the real probes are injected):
 *
 *   - every platform's fully-provisioned fixture produces a complete green report;
 *   - every provisioning defect a host can have produces its own NAMED blocker (WSL, hosted
 *     runner, wrong architecture, wrong Node, headless desktop, sleep/lock enabled — per platform,
 *     backend unresolvable, client binary missing, probe failure);
 *   - the attested facts are never silently satisfied: a missing, incomplete, unattributed,
 *     undated or unreadable operator attestation produces per-fact blockers;
 *   - the report lists EVERY blocker, not just the first;
 *   - a platform mismatch SKIPS the platform probes rather than fabricating them, and the CLI
 *     exits 1 with a parseable report (fast, because nothing probes);
 *   - the per-platform desktop lock serializes GUI runs: a live holder is named by pid, a stale
 *     holder is stolen, a mid-acquisition (fresh unparseable) holder blocks until the grace window
 *     passes, an uncreatable lock is a named refusal, a different platform takes its own lock,
 *     and release works;
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERTIFIED_CLIENTS } from './client-certification-evidence.mjs';
import {
  EXPECTED_ARCHITECTURES,
  PREFLIGHT_VERSION,
  PROBED_CHECKS,
  REQUIRED_ATTESTED_FACTS,
  acquireDesktopLock,
  runHostPreflight,
} from './host-preflight.mjs';

const cliPath = fileURLToPath(new URL('./host-preflight.mjs', import.meta.url));

// ── the fixtures ────────────────────────────────────────────────────────────────────────────────

/** A spawn seam answering scripted full-argv probes with spawnSync-shaped results. Any unscripted
 * probe exits 127, so a fixture that silently stops probing a command it claims to probe fails. */
function fakeSpawn(scripts) {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const script = scripts[key];
    if (script === undefined) {
      // A distinctive prefix: this string lands in a blocker detail, so a fixture that silently
      // stops probing a command it claims to probe must be attributable to the fake, not read as
      // a real host's shell error.
      return { status: 127, stdout: '', stderr: `fakeSpawn: probe not scripted: ${key}` };
    }
    if (typeof script === 'function') return script(command, args);
    return { status: 0, stdout: script, stderr: '' };
  };
}

const PASSING_BACKEND = () => ({ status: 'pass', backend: { technology: 'swift+AppleScript' } });
const PASSING_BINARY = () => ({
  status: 'pass',
  binary: '/usr/local/bin/client',
  version: '1.2.3',
});

/** Per-platform probe answers for a fully provisioned host — the platform's own way of saying the
 * desktop is interactive and will not sleep or lock mid-run. */
const PROVISIONED_PROBES = {
  darwin: {
    'launchctl managername': 'Aqua\n',
    // Real pmset output annotates assertion lines: "sleep 0 (sleep prevented by powerd,
    // caffeinate)" is what a host that DID disable sleep and ran caffeinate prints — the passing
    // fixture carries the annotation so the parser is pinned against it (a parser that only
    // accepts bare "sleep 0" would false-block exactly the certified hosts).
    'pmset -g':
      'Battery Power:\nCurrently in use:\n sleep          0 (sleep prevented by powerd, caffeinate)\n displaysleep   0\n',
  },
  linux: {
    'gsettings get org.gnome.desktop.session idle-delay': 'uint32 0\n',
    'gsettings get org.gnome.desktop.screensaver lock-enabled': 'false\n',
  },
  win32: {
    'powershell.exe -NoProfile -Command [Environment]::UserInteractive': 'True\n',
    'powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE':
      'Power Setting GUID: 29f6c1db-86da-48c5-9fdb-93cd2733c1c4\n  Current AC Power Setting Index: 0x00000000\n  Current DC Power Setting Index: 0x00000000\n',
    // ScreenSaveActive is REG_SZ: reg query prints its data verbatim, so a disabled saver is the
    // plain string "0" — the fixture pins the real-world encoding, not a REG_DWORD-style 0x0.
    'reg query HKCU\\Control Panel\\Desktop /v ScreenSaveActive':
      'HKEY_CURRENT_USER\\Control Panel\\Desktop\n    ScreenSaveActive    REG_SZ    0\n',
  },
};

const PROVISIONED_ENV = {
  darwin: {},
  linux: { DISPLAY: ':0' },
  win32: {},
};

/** The complete operator attestation: every unprovable fact affirmed, attributed and dated. */
const FULL_ATTESTATION = {
  operator: 'certification-ops',
  recordedAt: '2026-09-14T00:00:00Z',
  facts: {
    dedicatedVendorTestAccounts: true,
    clientsSignedIn: [...CERTIFIED_CLIENTS],
    accessibilityPermissionsGranted: true,
    credentialsInVendorSecureStorage: true,
    noUnrelatedUserProjects: true,
  },
};

/**
 * A fake host. `attestation` is FULL_ATTESTATION by default, `null` for a host with no attestation
 * file, an arbitrary object for an incomplete one, or `{ readError }` for an unreadable one. Every
 * host fact is injected, so a single test machine exercises all three platforms' branches.
 */
function fakeHost(
  platform,
  {
    spawn,
    env,
    arch,
    node = '22.11.0',
    wsl = false,
    attestation = FULL_ATTESTATION,
    clients,
    resolveBinary,
    resolveDesktopBackend,
  } = {},
) {
  return runHostPreflight({
    requestedPlatform: platform,
    hostPlatform: platform,
    hostArch: arch ?? EXPECTED_ARCHITECTURES[platform],
    hostNode: node,
    wsl: () => wsl,
    env: env ?? PROVISIONED_ENV[platform],
    spawn: spawn ?? fakeSpawn(PROVISIONED_PROBES[platform]),
    clients,
    resolveBinary: resolveBinary ?? PASSING_BINARY,
    resolveDesktopBackend: resolveDesktopBackend ?? PASSING_BACKEND,
    attestationPath: '/attestation/certification-host.json',
    exists: () => attestation !== null,
    readJson: () => {
      if (attestation?.readError) {
        const error = new Error(attestation.readError);
        // Real fs errors carry an errno code; the fixture can set one to exercise the IO branch.
        if (attestation.readErrorCode) error.code = attestation.readErrorCode;
        throw error;
      }
      return attestation;
    },
    homedir: '/home/op',
  });
}

/** The blocked check's reason, asserting the check exists and IS blocked on the way. */
function blockedReason(report, id) {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check, `check ${id} is missing from the report`);
  assert.equal(check.status, 'blocked', `check ${id} should be blocked`);
  return check.reason;
}

// ── the all-pass fixtures: every platform produces a complete green report ─────────────────────

for (const platform of ['darwin', 'linux', 'win32']) {
  const report = fakeHost(platform);
  assert.equal(
    report.status,
    'pass',
    `a fully provisioned ${platform} host must pass, got: ${JSON.stringify(report.blockers)}`,
  );
  assert.equal(report.version, PREFLIGHT_VERSION, 'the report must name its producer version');
  assert.deepEqual(
    report.checks.filter((check) => check.kind === 'probed').map((check) => check.id),
    PROBED_CHECKS,
    `the ${platform} report must carry every probed check exactly once, in order`,
  );
  assert.equal(report.blockers.length, 0, 'a passing report must carry no blockers');
  assert.equal(report.platform, platform);
  assert.equal(
    report.expectedArch,
    EXPECTED_ARCHITECTURES[platform],
    'the report must state the architecture it certifies',
  );
  assert.equal(report.wsl, false, 'the report must state whether the host is WSL');
  assert.equal(
    report.attestation.present,
    true,
    'the report must state that an attestation was consulted',
  );
  assert.deepEqual(
    report.checks.filter((check) => check.kind === 'attested').map((check) => check.id),
    REQUIRED_ATTESTED_FACTS.map((fact) => fact.id),
    'the attested checks must be exactly the required facts, never fewer',
  );
  const clientsCheck = report.checks.find((check) => check.id === 'clients-installed');
  for (const clientId of CERTIFIED_CLIENTS) {
    assert.ok(
      clientsCheck.detail.includes(clientId),
      `the clients-installed detail must record ${clientId}'s resolved version (pinned-versions fact)`,
    );
  }
}

// ── every named blocker a defective host produces ───────────────────────────────────────────────

// WSL is refused BY NAME — it satisfies neither the linux nor the win32 cell, and the launch
// decision refuses a WSL receipt, so a WSL host can never produce certifying evidence.
const wslHost = fakeHost('linux', { wsl: true });
assert.ok(blockedReason(wslHost, 'native-platform').includes('WSL'), 'the blocker must name WSL');
assert.ok(
  wslHost.checks.find((check) => check.id === 'native-platform').reason.includes('NEITHER'),
  'the blocker must state WSL satisfies NEITHER cell',
);

// A GitHub-hosted runner is not a native desktop and can never certify a vendor cell.
const hostedHost = fakeHost('linux', {
  env: { RUNNER_ENVIRONMENT: 'github-hosted', DISPLAY: ':0' },
});
assert.ok(
  blockedReason(hostedHost, 'native-platform').includes('GitHub-hosted'),
  'the blocker must name the hosted runner',
);
assert.ok(
  blockedReason(hostedHost, 'native-platform').includes('self-hosted, certification'),
  'the blocker must tell the operator which labels to register',
);

// An unsupported --platform is refused with the valid platforms listed, not guessed at.
const unsupportedHost = runHostPreflight({
  requestedPlatform: 'freebsd',
  hostPlatform: 'freebsd',
  hostArch: 'x64',
  hostNode: '22.11.0',
  wsl: () => false,
  env: {},
  spawn: fakeSpawn({}),
  resolveBinary: PASSING_BINARY,
  resolveDesktopBackend: PASSING_BACKEND,
  attestationPath: '/x.json',
  exists: () => true,
  readJson: () => FULL_ATTESTATION,
  homedir: '/h',
});
const unsupportedReason = blockedReason(unsupportedHost, 'native-platform');
for (const platform of Object.keys(EXPECTED_ARCHITECTURES)) {
  assert.ok(
    unsupportedReason.includes(platform),
    'the refusal must list every certification platform',
  );
}

// The architecture the launch promise names — mismatched hosts are blocked, not recorded.
const wrongArchHost = fakeHost('darwin', { arch: 'x64' });
const wrongArchReason = blockedReason(wrongArchHost, 'architecture');
assert.ok(wrongArchReason.includes('arm64'), 'the blocker must name the expected architecture');
assert.ok(wrongArchReason.includes('x64'), 'the blocker must name the actual architecture');

// Vendor certification runs on Node 22; any other major is a named blocker.
const wrongNodeHost = fakeHost('darwin', { node: '20.18.0' });
const wrongNodeReason = blockedReason(wrongNodeHost, 'node-22');
assert.ok(wrongNodeReason.includes('Node 22'), 'the blocker must name the required Node major');
assert.ok(wrongNodeReason.includes('20.18.0'), 'the blocker must name the observed Node version');

// Headless desktops, per platform: no Aqua session, no display, no interactive Windows session.
assert.ok(
  blockedReason(
    fakeHost('darwin', {
      spawn: fakeSpawn({ ...PROVISIONED_PROBES.darwin, 'launchctl managername': 'Background\n' }),
    }),
    'interactive-desktop',
  ).includes('Aqua'),
  'the macOS blocker must name the missing Aqua session',
);
assert.ok(
  blockedReason(fakeHost('linux', { env: {} }), 'interactive-desktop').includes('DISPLAY'),
  'the linux blocker must name the missing display',
);
assert.ok(
  blockedReason(
    fakeHost('win32', {
      spawn: fakeSpawn({
        ...PROVISIONED_PROBES.win32,
        'powershell.exe -NoProfile -Command [Environment]::UserInteractive': 'False\n',
      }),
    }),
    'interactive-desktop',
  ).includes('UserInteractive'),
  'the Windows blocker must name the non-interactive session',
);

// A probe that cannot run is a named blocker, not a crash: a host where pmset is missing is
// exactly a host to name.
const deadProbeHost = fakeHost('darwin', {
  spawn: () => ({ error: new Error('spawn pmset ENOENT') }),
});
assert.ok(
  blockedReason(deadProbeHost, 'sleep-and-lock-disabled').includes('failed to start'),
  'a probe that fails to start must be a named blocker',
);

// Sleep and lock, per platform: every blocker names the setting and the observed value.
const darwinSleepHost = fakeHost('darwin', {
  spawn: fakeSpawn({
    ...PROVISIONED_PROBES.darwin,
    'pmset -g': 'Battery Power:\nCurrently in use:\n sleep          15\n displaysleep   0\n',
  }),
});
assert.ok(
  blockedReason(darwinSleepHost, 'sleep-and-lock-disabled').includes('15 minutes'),
  'the macOS sleep blocker must name the observed minutes',
);
const darwinMissingSettingHost = fakeHost('darwin', {
  spawn: fakeSpawn({
    ...PROVISIONED_PROBES.darwin,
    'pmset -g': 'Battery Power:\nCurrently in use:\n displaysleep   0\n',
  }),
});
assert.ok(
  blockedReason(darwinMissingSettingHost, 'sleep-and-lock-disabled').includes('"sleep"'),
  'a setting pmset does not report must be named, not assumed',
);
const linuxIdleHost = fakeHost('linux', {
  spawn: fakeSpawn({
    ...PROVISIONED_PROBES.linux,
    'gsettings get org.gnome.desktop.session idle-delay': 'uint32 300\n',
  }),
});
assert.ok(
  blockedReason(linuxIdleHost, 'sleep-and-lock-disabled').includes('idle-delay'),
  'the linux blocker must name the idle setting',
);
const linuxLockHost = fakeHost('linux', {
  spawn: fakeSpawn({
    ...PROVISIONED_PROBES.linux,
    'gsettings get org.gnome.desktop.screensaver lock-enabled': 'true\n',
  }),
});
assert.ok(
  blockedReason(linuxLockHost, 'sleep-and-lock-disabled').includes('lock'),
  'the linux blocker must name the screensaver lock',
);
const win32SleepHost = fakeHost('win32', {
  spawn: fakeSpawn({
    ...PROVISIONED_PROBES.win32,
    'powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE':
      'Power Setting GUID: 29f6c1db-86da-48c5-9fdb-93cd2733c1c4\n  Current AC Power Setting Index: 0x0000012c\n  Current DC Power Setting Index: 0x00000000\n',
  }),
});
assert.ok(
  blockedReason(win32SleepHost, 'sleep-and-lock-disabled').includes('standby'),
  'the Windows blocker must name the standby setting',
);
const win32SaverHost = fakeHost('win32', {
  spawn: fakeSpawn({
    ...PROVISIONED_PROBES.win32,
    'reg query HKCU\\Control Panel\\Desktop /v ScreenSaveActive':
      'HKEY_CURRENT_USER\\Control Panel\\Desktop\n    ScreenSaveActive    REG_SZ    1\n',
  }),
});
assert.ok(
  blockedReason(win32SaverHost, 'sleep-and-lock-disabled').includes('ScreenSaveActive'),
  'the Windows blocker must name the screen-saver setting',
);

// The desktop backend: a host that cannot resolve its automation helper is named HERE, before any
// editor launches — the blocked reason passes through verbatim, like the scenario harness's own
// preflight.
assert.equal(
  fakeHost('darwin', {
    resolveDesktopBackend: () => ({
      status: 'blocked',
      reason: 'no swift helper toolchain on PATH',
    }),
  }).checks.find((check) => check.id === 'desktop-backend').reason,
  'no swift helper toolchain on PATH',
  'the backend blocker must pass the resolver reason through unchanged',
);

// A missing client binary is a blocker naming the client, and stops the sweep: queueing cells for
// an uninstalled client is exactly the indefinitely-queued launch the preflight exists to prevent.
const cursorMissingHost = fakeHost('darwin', {
  resolveBinary: (spec) =>
    spec.displayName === 'Cursor'
      ? {
          status: 'blocked',
          reason: 'no Cursor executable found on PATH (tried: cursor, Cursor.app)',
        }
      : { status: 'pass', binary: '/usr/local/bin/client', version: '1.2.3' },
});
assert.ok(
  blockedReason(cursorMissingHost, 'clients-installed').includes('Cursor'),
  'the clients-installed blocker must name the missing client',
);

// ── the attested facts are never silently satisfied ──────────────────────────────────────────────

// No attestation file at all: one blocker PER FACT, each naming where the attestation should live.
const unattestedHost = fakeHost('darwin', { attestation: null });
assert.equal(unattestedHost.status, 'blocked', 'a host without an attestation must be blocked');
assert.equal(unattestedHost.attestation.present, false);
assert.equal(unattestedHost.blockers.length, REQUIRED_ATTESTED_FACTS.length);
const unattestedChecks = unattestedHost.checks.filter((check) => check.kind === 'attested');
assert.deepEqual(
  unattestedChecks.map((check) => check.id),
  REQUIRED_ATTESTED_FACTS.map((fact) => fact.id),
);
for (const check of unattestedChecks) {
  assert.equal(check.status, 'blocked');
  assert.ok(
    check.reason.includes('operator attestation'),
    'each blocker must point at the attestation',
  );
  assert.ok(
    check.reason.includes('$KCRIB_CERTIFICATION_ATTESTATION') ||
      check.reason.includes('certification-host.json'),
    'each blocker must name where the attestation should live',
  );
}

// An incomplete attestation: the missing FACT is named; the affirmed facts stay green.
const incompleteAttestation = {
  ...FULL_ATTESTATION,
  facts: { ...FULL_ATTESTATION.facts, noUnrelatedUserProjects: undefined },
};
const incompleteHost = fakeHost('darwin', { attestation: incompleteAttestation });
assert.equal(incompleteHost.blockers.length, 1, 'only the unaffirmed fact may block');
assert.ok(
  blockedReason(incompleteHost, 'noUnrelatedUserProjects').includes('unrelated user projects'),
  'the blocker must name the unaffirmed requirement',
);
assert.ok(
  incompleteHost.checks.find((check) => check.id === 'dedicatedVendorTestAccounts').status ===
    'pass',
  'affirmed facts stay green',
);

// clientsSignedIn must list EVERY advertised client — a partial list names the missing clients.
const partialSignInHost = fakeHost('linux', {
  attestation: {
    ...FULL_ATTESTATION,
    facts: { ...FULL_ATTESTATION.facts, clientsSignedIn: ['claude'] },
  },
});
const partialSignInReason = blockedReason(partialSignInHost, 'clientsSignedIn');
for (const clientId of CERTIFIED_CLIENTS.slice(1)) {
  assert.ok(partialSignInReason.includes(clientId), 'the blocker must name every missing client');
}

// An unattributed or undated attestation is no attestation.
assert.ok(
  blockedReason(
    fakeHost('darwin', { attestation: { ...FULL_ATTESTATION, operator: '' } }),
    'attestation-operator',
  ).includes('operator'),
  'a missing operator identity must be a named blocker',
);
assert.ok(
  blockedReason(
    fakeHost('darwin', { attestation: { ...FULL_ATTESTATION, recordedAt: 'yesterday' } }),
    'attestation-recorded-at',
  ).includes('recordedAt'),
  'a non-ISO recordedAt must be a named blocker',
);
// A date-shaped but invalid or timezone-less timestamp is still no date: the recordedAt drives
// every later age check on this attestation, so "2026-13-99T..." or a missing Z must not pass.
for (const bad of ['2026-13-99T25:99:99Z', '2026-09-14T00:00:00']) {
  assert.equal(
    blockedReason(
      fakeHost('darwin', { attestation: { ...FULL_ATTESTATION, recordedAt: bad } }),
      'attestation-recorded-at',
    ).includes('recordedAt'),
    true,
    `a date-shaped but invalid recordedAt (${bad}) must be a named blocker`,
  );
}

// The passing clientsSignedIn detail echoes back ONLY the advertised client ids — the attestation
// is operator input, and a stray value it happens to carry must not travel into the report.
const extraSignInHost = fakeHost('darwin', {
  attestation: {
    ...FULL_ATTESTATION,
    facts: {
      ...FULL_ATTESTATION.facts,
      clientsSignedIn: [...CERTIFIED_CLIENTS, 'ops@corp.example'],
    },
  },
});
const extraSignInCheck = extraSignInHost.checks.find((check) => check.id === 'clientsSignedIn');
assert.equal(extraSignInCheck.status, 'pass');
assert.equal(
  extraSignInCheck.detail,
  CERTIFIED_CLIENTS.join(', '),
  'the pass detail must list the advertised clients, never raw attestation values',
);

// An unparseable file names ITS unreadability on every fact it could not affirm — and never
// echoes the parse error, because a JSON.parse SyntaxError embeds a quoted snippet of the file's
// own bytes (an uploaded report must not carry attestation-file contents).
const unreadableHost = fakeHost('darwin', {
  attestation: { readError: 'Unexpected token < in JSON at position 0 ("attestation secret")' },
});
assert.ok(unreadableHost.attestation.loadError, 'the report must carry the load error');
assert.equal(unreadableHost.attestation.loadError, 'the attestation file is not valid JSON');
assert.equal(unreadableHost.blockers.length, REQUIRED_ATTESTED_FACTS.length + 2);
for (const blocker of unreadableHost.blockers) {
  assert.ok(
    blocker.includes('not valid JSON'),
    `every blocker must name the unparseable attestation: ${blocker}`,
  );
}
for (const blocker of unreadableHost.blockers) {
  assert.ok(
    !blocker.includes('attestation secret'),
    'no blocker may echo bytes of the attestation file',
  );
}

// An IO failure names its errno, not the error message (which can carry the path's owner or mode).
const ioErrorHost = fakeHost('darwin', {
  attestation: { readError: 'EACCES: permission denied', readErrorCode: 'EACCES' },
});
assert.equal(
  ioErrorHost.attestation.loadError,
  'the attestation file cannot be read (EACCES)',
  'an unreadable file must name the errno',
);

// ── the report lists EVERY blocker, never just the first ────────────────────────────────────────

const multiBlockerHost = fakeHost('darwin', { arch: 'x64', attestation: null });
assert.equal(
  multiBlockerHost.blockers.length,
  1 + REQUIRED_ATTESTED_FACTS.length,
  'an operator fixing a host needs every missing piece in one pass',
);
assert.ok(
  multiBlockerHost.blockers.some((reason) => reason.includes('arm64')),
  'the architecture blocker must be listed alongside the attestation blockers',
);
assert.ok(
  multiBlockerHost.blockers.some((reason) => reason.includes('operator attestation')),
  'the attestation blockers must be listed alongside the architecture blocker',
);

// ── a platform mismatch skips the probes rather than fabricating them ────────────────────────────

const mismatchHost = runHostPreflight({
  requestedPlatform: 'win32',
  hostPlatform: 'darwin',
  hostArch: 'arm64',
  hostNode: '22.11.0',
  wsl: () => false,
  env: {},
  spawn: fakeSpawn({}),
  clients: [],
  resolveBinary: PASSING_BINARY,
  resolveDesktopBackend: PASSING_BACKEND,
  attestationPath: '/x.json',
  exists: () => true,
  readJson: () => FULL_ATTESTATION,
  homedir: '/h',
});
assert.equal(mismatchHost.status, 'blocked');
const mismatchReason = blockedReason(mismatchHost, 'native-platform');
assert.ok(
  mismatchReason.includes('win32') && mismatchReason.includes('darwin'),
  'the blocker must name the mismatch',
);
assert.deepEqual(
  mismatchHost.checks.filter((check) => check.kind === 'probed').map((check) => check.id),
  PROBED_CHECKS,
  'the report shape stays stable: every probed check appears exactly once',
);
for (const check of mismatchHost.checks.filter((check) => check.kind === 'probed').slice(1)) {
  assert.equal(check.status, 'skipped', `${check.id} must be skipped on a platform mismatch`);
  assert.ok(check.reason.includes('not probed'), 'the skip reason must say it was not probed');
}

// ── the per-platform desktop lock ───────────────────────────────────────────────────────────────

const lockRoot = mkdtempSync(join(tmpdir(), 'host-preflight-test-'));
process.on('exit', () => rmSync(lockRoot, { recursive: true, force: true }));
const lockDir = join(lockRoot, 'locks');
mkdirSync(lockDir, { recursive: true });

// Acquire: the lock file records the holder.
const lock = acquireDesktopLock('darwin', { lockDir, now: () => '2026-09-14T00:00:00Z' });
assert.equal(lock.status, 'acquired');
const holder = JSON.parse(readFileSync(join(lockDir, 'darwin.lock'), 'utf8'));
assert.equal(holder.platform, 'darwin');
assert.equal(holder.pid, process.pid);
assert.equal(holder.startedAt, '2026-09-14T00:00:00Z');

// A second run is BLOCKED and names the live holder by pid — two runs must never share a desktop.
const second = acquireDesktopLock('darwin', { lockDir });
assert.equal(second.status, 'blocked');
assert.ok(
  second.reason.includes(`pid ${process.pid}`),
  'the blocker must name the live holder pid',
);
assert.ok(
  second.reason.includes('serialized per platform'),
  'the blocker must state the serialization rule, not just refuse',
);

// A DIFFERENT platform takes its own lock: serialization is per platform, not global.
const linuxLock = acquireDesktopLock('linux', { lockDir, now: () => '2026-09-14T00:00:00Z' });
assert.equal(linuxLock.status, 'acquired', 'the linux lock must be independent of the darwin lock');

// Release makes the lock available again.
lock.release();
linuxLock.release();
const relock = acquireDesktopLock('darwin', { lockDir });
assert.equal(relock.status, 'acquired', 'a released lock must be acquirable again');
relock.release();

// A stale holder (a crashed run that never released) is stolen.
writeFileSync(
  join(lockDir, 'darwin.lock'),
  JSON.stringify({ platform: 'darwin', pid: 999_999, startedAt: '2026-01-01T00:00:00Z' }),
);
const stolen = acquireDesktopLock('darwin', { lockDir, isPidAlive: () => false });
assert.equal(stolen.status, 'acquired', 'a dead holder must be stolen, not held forever');
stolen.release();

// An unparseable FRESH payload is presumed mid-acquisition (open('wx') creates the path before the
// payload write): blocking here is the point — unlinking it would steal the lock from a live run
// microseconds from holding it.
writeFileSync(join(lockDir, 'darwin.lock'), 'not json at all');
const freshGarbage = acquireDesktopLock('darwin', { lockDir, isPidAlive: () => false });
assert.equal(freshGarbage.status, 'blocked', 'a fresh unparseable payload must not be stolen');
assert.ok(
  freshGarbage.reason.includes('mid-acquisition'),
  'the blocker must state the mid-acquisition hypothesis',
);
assert.ok(
  freshGarbage.reason.includes('serialized per platform'),
  'the blocker must state the serialization rule',
);
// Once the same garbage is older than the grace window (simulated by advancing the clock past it),
// it is a run that died mid-write and is stolen — the lock never wedges on old garbage.
const staleGarbage = acquireDesktopLock('darwin', {
  lockDir,
  isPidAlive: () => false,
  clock: () => Date.now() + 60_000,
});
assert.equal(
  staleGarbage.status,
  'acquired',
  'an unparseable payload older than the grace window must be stolen',
);
staleGarbage.release();

// A lock the filesystem refuses to create is a NAMED refusal, not an uncaught exception wedging
// the suite — EACCES on a read-only temp dir must reach the operator as an actionable blocker.
const eacces = new Error('EACCES: permission denied');
eacces.code = 'EACCES';
const refusedLock = acquireDesktopLock('darwin', {
  lockDir,
  open: () => {
    throw eacces;
  },
});
assert.equal(refusedLock.status, 'blocked', 'a creatable-lock failure must block, not throw');
assert.ok(refusedLock.reason.includes('EACCES'), 'the refusal must name the errno');
assert.ok(refusedLock.reason.includes('cannot be created'), 'the refusal must state what failed');

// A LIVE holder wins, even while a stealer is racing: blocked, named by pid.
writeFileSync(
  join(lockDir, 'darwin.lock'),
  JSON.stringify({ platform: 'darwin', pid: 4242, startedAt: 'x' }),
);
const liveBlocked = acquireDesktopLock('darwin', { lockDir, isPidAlive: () => true });
assert.equal(liveBlocked.status, 'blocked');
assert.ok(liveBlocked.reason.includes('pid 4242'));
// Release the planted lock so the temp dir is clean for the next test run.
acquireDesktopLock('darwin', { lockDir, isPidAlive: () => false }).release();

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────

const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
assert.equal(help.status, 0, `--help must exit 0\n${help.stderr}`);
assert.ok(help.stdout.includes('usage:'), '--help must print usage');
assert.ok(
  help.stdout.includes('certification-host.json'),
  '--help must tell the operator where the attestation lives',
);

// Importing the module must not run the CLI (the desktop scenario harness imports these helpers).
const importOnly = spawnSync(
  process.execPath,
  [
    '-e',
    `import(${JSON.stringify(cliPath)}).then((m) => { if (typeof m.runHostPreflight !== 'function') process.exit(3); })`,
  ],
  { encoding: 'utf8' },
);
assert.equal(importOnly.status, 0, `importing the module must not run main\n${importOnly.stderr}`);

// A --platform that does not match this host: exit 1, a parseable report, and the mismatch named —
// fast, because the platform probes are skipped (the otherPlatform pick keeps this true on any host).
const otherPlatform = process.platform === 'win32' ? 'darwin' : 'win32';
const jsonPath = join(lockRoot, 'mismatch-report.json');
const mismatchRun = spawnSync(
  process.execPath,
  [cliPath, '--platform', otherPlatform, '--json', jsonPath],
  { encoding: 'utf8' },
);
assert.equal(mismatchRun.status, 1, 'a blocked preflight must exit 1');
assert.ok(mismatchRun.stderr.includes('BLOCKED'), 'stderr must state the blocked verdict');
assert.ok(
  mismatchRun.stderr.includes('This host is not provisioned'),
  'stderr must state the consequence: the cell stays NO-GO',
);
const mismatchCliReport = JSON.parse(readFileSync(jsonPath, 'utf8'));
assert.equal(mismatchCliReport.status, 'blocked');
const nativeCheck = mismatchCliReport.checks.find((check) => check.id === 'native-platform');
assert.equal(nativeCheck.status, 'blocked');
assert.ok(
  nativeCheck.reason.includes(otherPlatform) && nativeCheck.reason.includes(process.platform),
  'the blocker must name both the requested platform and this host',
);

// The CLI finds the attestation through $KCRIB_CERTIFICATION_ATTESTATION, not just --attestation:
// a runner that exports only the env var must get its attestation consulted. The mismatched
// --platform keeps the platform probes skipped (fast on any host), so the ONLY thing this run
// proves is the env-var resolution and the attested checks it green-lights.
const envAttestationPath = join(lockRoot, 'certification-host.json');
writeFileSync(envAttestationPath, `${JSON.stringify(FULL_ATTESTATION, null, 2)}\n`);
const envJsonPath = join(lockRoot, 'env-report.json');
const envRun = spawnSync(
  process.execPath,
  [cliPath, '--platform', otherPlatform, '--json', envJsonPath],
  {
    encoding: 'utf8',
    env: { ...process.env, KCRIB_CERTIFICATION_ATTESTATION: envAttestationPath },
  },
);
assert.equal(envRun.status, 1, 'the mismatch still blocks the run');
const envCliReport = JSON.parse(readFileSync(envJsonPath, 'utf8'));
assert.equal(
  envCliReport.attestation.present,
  true,
  'the env-var attestation must be consulted by the CLI',
);
assert.equal(
  envCliReport.attestation.path,
  envAttestationPath,
  'the report must name the env-resolved attestation path',
);
for (const check of envCliReport.checks.filter((check) => check.kind === 'attested')) {
  assert.equal(
    check.status,
    'pass',
    `${check.id} must pass against the env-resolved full attestation`,
  );
}

// ── the desktop scenario CLI honors the lock: a held platform desktop is refused before launch ───
// This is the serialization rule's user-visible face: client-desktop-certify.mjs acquires this same
// lock after arg validation, so a second run pointed at the same desktop refuses (exit 1) instead
// of racing the first for the active session. Valid args are supplied so the ONLY thing that can
// stop the run is the held lock.
const { execFileSync } = await import('node:child_process');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const fixtureDir = join(lockRoot, 'fixture-repo');
mkdirSync(fixtureDir, { recursive: true });
const packageFile = join(lockRoot, 'candidate.tgz');
writeFileSync(packageFile, 'not a real tarball — only existence is validated before the lock\n');
const heldLock = acquireDesktopLock(process.platform);
assert.equal(heldLock.status, 'acquired', 'the test must hold the platform desktop lock first');
const lockRefusal = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('./client-desktop-certify.mjs', import.meta.url)),
    '--scenario',
    'copilot',
    '--package',
    packageFile,
    '--candidate-commit',
    head,
    '--fixture-repo',
    fixtureDir,
    '--out',
    join(lockRoot, 'receipts'),
  ],
  { encoding: 'utf8' },
);
assert.equal(
  lockRefusal.status,
  1,
  `a held desktop must refuse to start, got ${lockRefusal.status}`,
);
assert.match(
  lockRefusal.stderr,
  /REFUSES to start/,
  'the refusal must follow the harness refusal shape',
);
assert.match(
  lockRefusal.stderr,
  /serialized per platform/,
  'the refusal must state the serialization rule',
);
assert.match(
  lockRefusal.stderr,
  new RegExp(`pid ${process.pid}`),
  'the refusal must name the live holder by pid',
);
// And once released, the same CLI proceeds past the lock (its internal preflight then blocks it on
// the unprovisioned host — proving the run reached the scenario engine, i.e. the release worked).
heldLock.release();
const postRelease = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('./client-desktop-certify.mjs', import.meta.url)),
    '--scenario',
    'copilot',
    '--package',
    packageFile,
    '--candidate-commit',
    head,
    '--fixture-repo',
    fixtureDir,
    '--out',
    join(lockRoot, 'receipts'),
  ],
  { encoding: 'utf8', timeout: 120_000 },
);
assert.notEqual(postRelease.status, null, 'the post-release run must have completed');
assert.doesNotMatch(
  postRelease.stderr,
  /serialized per platform/,
  'a released lock must let the next run through to the engine',
);
// The positive leg of the same proof: once past the lock, the run reaches the scenario engine,
// whose honesty gate on this unprovisioned host prints its NOT CERTIFIED verdict — a positive
// marker that the run progressed, so a future regression that fails BEFORE the engine (but after
// the lock) cannot pass vacuously on the doesNotMatch above.
assert.match(
  postRelease.stdout,
  /NOT CERTIFIED ->/,
  'the post-release run must reach the engine (its verdict is printed), not just avoid the lock refusal',
);

console.log('host preflight tests ok');
