#!/usr/bin/env node
/**
 * The certification host preflight (Task 10).
 *
 * The twenty-one native vendor cells are scheduled onto THREE physical machines, and the workflow
 * cannot satisfy those machines by itself — it can only refuse to lie about them. This preflight is
 * the refusal: it runs on a certification runner BEFORE any expensive cell work starts, and turns
 * every missing piece of host provisioning into a NAMED blocker the operator can act on. A host
 * without infrastructure fails HERE, in seconds, with its blocker recorded — never as a
 * five-minute certification run that ends in "not signed in", and never as a launch left
 * indefinitely queued waiting for a runner that cannot exist.
 *
 * WHAT IS PROBED vs WHAT IS ATTESTED — the distinction is the honesty gate:
 *
 *   PROBED (this file verifies them mechanically):
 *     - native identity: --platform must equal the host's process.platform, WSL is refused by name
 *       (it satisfies neither the linux nor the win32 cell), and a GitHub-HOSTED runner is refused
 *       because a hosted runner is by definition not a native desktop;
 *     - the architecture the launch promise names (darwin arm64, linux x64, win32 x64 — the plan's
 *       initial native host targets, stated explicitly in every report);
 *     - Node 22 (vendor certification's Node — the six-cell product matrix, not this host's job);
 *     - a logged-in interactive desktop (launchctl managername Aqua on macOS, DISPLAY or
 *       WAYLAND_DISPLAY on Linux, an interactive Windows session);
 *     - sleep and screen-lock interruptions disabled for the whole run (pmset on macOS, gsettings
 *       on the GNOME/AT-SPI host, powercfg + ScreenSaveActive on Windows);
 *     - a resolvable desktop-automation backend (the same resolver the scenarios use);
 *     - every advertised client binary, recording each resolved version so the report states the
 *       exact client versions the cells will drive.
 *
 *   ATTESTED (a program cannot probe them; they are never silently satisfied): dedicated vendor
 *     test accounts, every client signed in, the accessibility permission the helper needs,
 *     credentials in vendor-supported secure storage, and no unrelated user projects in the
 *     certification account. These live in an operator attestation file on the HOST (never in the
 *     repository, never in repository secrets): an explicit JSON document naming the operator and
 *     the recorded date. A missing file, a missing fact or a fact that is merely true-by-default
 *     is a NAMED blocker — the preflight has no way to check a keychain from a workflow, so the
 *     honest outcome is "unattested", not "pass".
 *
 * Usage:
 *   node scripts/host-preflight.mjs [--platform darwin|linux|win32] [--json <path>]
 *     [--attestation <path>] [--help]
 *
 * Exit 0 = the host is provisioned for certification; exit 1 = blocked, with every blocker printed
 * and (with --json) a machine-readable report written outside the checkout.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERTIFIED_CLIENTS } from './client-certification-evidence.mjs';
import { clientSpec, isWsl, resolveBinary, sanitizeOutput } from './client-certify.mjs';
import { resolveDesktopBackend } from './desktop-backends.mjs';

/** Bumped when the preflight's check set or report shape changes, so a report names its producer. */
export const PREFLIGHT_VERSION = '1.0.0';

/**
 * The plan's initial native host targets, stated explicitly because reports must name the
 * architecture they certify: macOS arm64, Linux x64, Windows x64. Node 24 and other architectures
 * are the six-cell product matrix's business — additional certification architectures require
 * their own evidence, which starts with a deliberate change HERE.
 */
export const EXPECTED_ARCHITECTURES = {
  darwin: 'arm64',
  linux: 'x64',
  win32: 'x64',
};

/** The Node major every vendor certification cell runs on. */
export const REQUIRED_NODE_MAJOR = 22;

/** The checks a machine can run itself. Exported so the suite pins the exact check set. */
export const PROBED_CHECKS = [
  'native-platform',
  'hosted-runner',
  'architecture',
  'node-22',
  'interactive-desktop',
  'sleep-and-lock-disabled',
  'desktop-backend',
  'clients-installed',
];

/**
 * The provisioning facts a program cannot probe. `shape` states what an attestation must carry:
 * 'boolean-true' facts must be literally true, the 'client-list' fact must list EVERY advertised
 * client by id. Nothing here is ever satisfied by absence of evidence.
 */
export const REQUIRED_ATTESTED_FACTS = [
  {
    id: 'dedicatedVendorTestAccounts',
    shape: 'boolean-true',
    requirement:
      'dedicated vendor test accounts exist for certification — personal accounts are never certification credentials',
  },
  {
    id: 'clientsSignedIn',
    shape: 'client-list',
    requirement: 'every advertised client is signed in with its dedicated test account',
  },
  {
    id: 'accessibilityPermissionsGranted',
    shape: 'boolean-true',
    requirement:
      'the desktop automation helper holds the accessibility permission its platform requires (macOS Accessibility, Linux AT-SPI D-Bus access, Windows UI Automation session access)',
  },
  {
    id: 'credentialsInVendorSecureStorage',
    shape: 'boolean-true',
    requirement:
      'client credentials live only in vendor-supported secure storage (the platform keychain or the vendor profile store) — never in repository secrets or plain files',
  },
  {
    id: 'noUnrelatedUserProjects',
    shape: 'boolean-true',
    requirement: 'the certification account holds no unrelated user projects',
  },
];

/** How long any single host probe may run before it is named as blocked. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * How long an unparseable desktop-lock payload may stay unstealable: open('wx') creates the lock
 * path before the payload write, so a fresh garbage/empty payload is presumed to be a live run
 * mid-acquisition; one older than this window is a run that died mid-write and is stolen.
 */
const UNPARSEABLE_LOCK_GRACE_MS = 30_000;

/** Where the operator attestation lives when neither --attestation nor the env var names it. */
export function defaultAttestationPath(home = homedir()) {
  return join(home, '.config', 'knowledge-crib', 'certification-host.json');
}

/** A display-safe form of an attestation path: absolute paths are fine for the operator who owns
 * the host, but reports travel (workflow logs), so the default path is shown relative to home. */
function displayPath(path, home) {
  const shown = home && path.startsWith(home) ? `~${relative(home, path)}` : path;
  return shown;
}

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

/** One host probe through the injectable spawn seam. Never throws: a probe that cannot run is a
 * named blocker, not a crash — a host where pmset is missing is exactly a host to name. */
function probe(spawn, command, args) {
  let run;
  try {
    run = spawn(command, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, detail: `the ${command} probe failed to start: ${error.message}` };
  }
  if (run.error) {
    return { ok: false, detail: `the ${command} probe failed to start: ${run.error.message}` };
  }
  if (run.status !== 0) {
    return {
      ok: false,
      detail: `${command} exited ${run.status}: ${sanitizeOutput(`${run.stderr ?? ''}`.trim()).slice(0, 200)}`,
    };
  }
  return { ok: true, text: `${run.stdout ?? ''}` };
}

const blocked = (reason) => ({ status: 'blocked', reason });
const pass = (detail) => ({ status: 'pass', ...(detail === undefined ? {} : { detail }) });

// ─── the probed checks ─────────────────────────────────────────────────────────────────────────

/**
 * Native identity: the preflight certifies the host it RUNS on (a --platform naming another OS is
 * refused rather than recorded, exactly like the desktop scenario harness), WSL is refused BY NAME
 * (the launch decision refuses a WSL receipt, so a WSL host can never produce certifying evidence),
 * and GitHub-hosted runners are refused because a hosted runner is not a native desktop.
 */
function checkNativePlatform({ requestedPlatform, hostPlatform, wsl, env }) {
  if (!EXPECTED_ARCHITECTURES[requestedPlatform]) {
    return blocked(
      `--platform ${requestedPlatform} is not a certification platform ` +
        `(${Object.keys(EXPECTED_ARCHITECTURES).join(', ')})`,
    );
  }
  if (requestedPlatform !== hostPlatform) {
    return blocked(
      `--platform ${requestedPlatform} does not match this host (${hostPlatform}) — the preflight validates the machine it runs on, so certifying another platform from here would fabricate the evidence`,
    );
  }
  if (wsl()) {
    return blocked(
      'this host is WSL, and WSL satisfies NEITHER the linux nor the win32 certification cell: ' +
        'the launch decision refuses a WSL receipt by name — provision a NATIVE host',
    );
  }
  if (env?.RUNNER_ENVIRONMENT === 'github-hosted') {
    return blocked(
      'this is a GitHub-hosted runner — a hosted runner is not a native desktop and can never ' +
        'certify a vendor cell; register the machine with the labels self-hosted, certification, <platform>',
    );
  }
  return pass();
}

function checkHostedRunner({ env }) {
  if (env?.RUNNER_ENVIRONMENT === 'github-hosted') {
    return blocked(
      'this is a GitHub-hosted runner — a hosted runner is not a native desktop and can never ' +
        'certify a vendor cell; register the machine with the labels self-hosted, certification, <platform>',
    );
  }
  return pass();
}

/**
 * The architecture the launch promise names. Reports state expected and actual explicitly so the
 * support matrix can carry the exact (platform, architecture) it certified.
 */
function checkArchitecture({ requestedPlatform, hostArch }) {
  const expected = EXPECTED_ARCHITECTURES[requestedPlatform];
  if (hostArch !== expected) {
    return blocked(
      `the launch promise certifies ${requestedPlatform} on ${expected}; this host is ${hostArch} — additional architectures require their own evidence, which starts with a deliberate change to the preflight, not with a mismatched host`,
    );
  }
  return pass(`${requestedPlatform}/${hostArch}`);
}

function checkNode({ hostNode }) {
  const major = Number.parseInt(hostNode.split('.')[0] ?? '0', 10);
  if (major !== REQUIRED_NODE_MAJOR) {
    return blocked(
      `vendor certification runs on Node ${REQUIRED_NODE_MAJOR}; this host runs Node ${hostNode} — a cell whose Node differs from the certification contract is not the evidence the policy asks for`,
    );
  }
  return pass(`Node ${hostNode}`);
}

/**
 * A logged-in interactive desktop. Each platform's probe is the platform's own way of saying "a
 * human session with a display is attached": launchctl's manager name on macOS (Aqua is the GUI
 * session; System/Background are not), the display variables on Linux, and the .NET user-interactive
 * flag on Windows.
 */
function checkInteractiveDesktop({ requestedPlatform, spawn, env }) {
  if (requestedPlatform === 'darwin') {
    const run = probe(spawn, 'launchctl', ['managername']);
    if (!run.ok) return blocked(run.detail);
    const manager = run.text.trim();
    if (manager !== 'Aqua') {
      return blocked(
        `this macOS host has no logged-in Aqua desktop session (launchctl managername: ${sanitizeOutput(manager)}) — an unattended GUI scenario drives the real desktop`,
      );
    }
    return pass('Aqua session');
  }
  if (requestedPlatform === 'linux') {
    const display = env?.DISPLAY ?? env?.WAYLAND_DISPLAY ?? '';
    if (!display) {
      return blocked(
        'no interactive desktop session on this linux host: neither DISPLAY nor WAYLAND_DISPLAY is set — ' +
          'a GUI scenario needs a logged-in desktop, not a headless shell',
      );
    }
    return pass(
      display.startsWith('wayland') || env?.WAYLAND_DISPLAY ? 'Wayland session' : 'X11 session',
    );
  }
  const run = probe(spawn, 'powershell.exe', [
    '-NoProfile',
    '-Command',
    '[Environment]::UserInteractive',
  ]);
  if (!run.ok) return blocked(run.detail);
  const interactive = run.text.trim();
  if (interactive !== 'True') {
    return blocked(
      `this Windows host reports a non-interactive session (UserInteractive: ${sanitizeOutput(interactive)}) — the certification account must be signed in to its interactive desktop`,
    );
  }
  return pass('interactive session');
}

/**
 * Sleep and screen-lock interruptions disabled for the WHOLE run: a desktop that sleeps or locks
 * mid-scenario voids an unattended certification the receipt then claims happened. Every platform's
 * probe reads the platform's own power settings, and every failure names the setting and the
 * observed value — "sleep is enabled (15 minutes)" is actionable, "host not ready" is not.
 */
function checkSleepAndLock({ requestedPlatform, spawn }) {
  if (requestedPlatform === 'darwin') {
    const run = probe(spawn, 'pmset', ['-g']);
    if (!run.ok) return blocked(run.detail);
    // Only the "Currently in use:" block is this host's live configuration; the per-profile blocks
    // below it describe batteries the host may not even have.
    const inUse = run.text.split('Currently in use:')[1] ?? '';
    // Real hosts annotate assertion lines: `sleep 0 (sleep prevented by powerd, caffeinate)` — the
    // parenthesized suffix is powerd reporting WHO holds the assertion, not a different value, so
    // the regex tolerates it; a fixed `^\s*([a-z]+)\s+(\d+)$` would false-block exactly the hosts
    // that DID disable sleep and ran caffeinate, which are the certified hosts.
    const settings = new Map(
      [...inUse.matchAll(/^\s*([a-z]+)\s+(\d+)(?:\s+\(.*)?$/gm)].map((m) => [m[1], Number(m[2])]),
    );
    for (const setting of ['sleep', 'displaysleep']) {
      const minutes = settings.get(setting);
      if (minutes === undefined) {
        return blocked(
          `the macOS power settings do not report "${setting}" (pmset -g) — a host whose sleep configuration cannot be read is not a certified host`,
        );
      }
      if (minutes !== 0) {
        return blocked(
          `the host's ${setting === 'sleep' ? 'system sleep' : 'display sleep'} is enabled at ${minutes} minutes — disable sleep and display sleep for the whole scheduled run: a desktop that sleeps mid-scenario voids the certification`,
        );
      }
    }
    return pass('sleep 0, displaysleep 0');
  }
  if (requestedPlatform === 'linux') {
    const idle = probe(spawn, 'gsettings', ['get', 'org.gnome.desktop.session', 'idle-delay']);
    if (!idle.ok) {
      return blocked(
        `${idle.detail} — the linux certification host is a GNOME desktop (its automation backend is AT-SPI), so its session idle settings must be readable`,
      );
    }
    if (idle.text.trim() !== 'uint32 0') {
      return blocked(
        `the session idle delay is ${sanitizeOutput(idle.text.trim())} — an idle desktop suspends the GUI mid-scenario; set idle-delay to 0 (never)`,
      );
    }
    const lock = probe(spawn, 'gsettings', [
      'get',
      'org.gnome.desktop.screensaver',
      'lock-enabled',
    ]);
    if (!lock.ok) return blocked(lock.detail);
    if (lock.text.trim() !== 'false') {
      return blocked(
        'the GNOME screensaver lock is enabled — a locked screen is exactly the unattended-scenario interruption the host must not have; set lock-enabled to false',
      );
    }
    return pass('idle-delay 0, screensaver lock disabled');
  }
  const standby = probe(spawn, 'powercfg', ['/q', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']);
  if (!standby.ok) return blocked(standby.detail);
  const ac = /Current AC Power Setting Index:\s*(0x[0-9a-f]+)/i.exec(standby.text)?.[1];
  const dc = /Current DC Power Setting Index:\s*(0x[0-9a-f]+)/i.exec(standby.text)?.[1];
  for (const [label, value] of [
    ['AC', ac],
    ['DC', dc],
  ]) {
    if (value === undefined) {
      return blocked(
        `the Windows sleep settings do not report the ${label} standby idle (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE)`,
      );
    }
    if (value !== '0x00000000') {
      return blocked(
        `the ${label} standby idle is ${value} seconds — disable system sleep for the whole scheduled run: a desktop that sleeps mid-scenario voids the certification`,
      );
    }
  }
  const saver = probe(spawn, 'reg', [
    'query',
    'HKCU\\Control Panel\\Desktop',
    '/v',
    'ScreenSaveActive',
  ]);
  if (!saver.ok) return blocked(saver.detail);
  const active = /ScreenSaveActive\s+REG_SZ\s+(\S+)/.exec(saver.text)?.[1];
  if (active === undefined) {
    return blocked(
      'the Windows screen-saver setting is unreadable (reg query ... /v ScreenSaveActive)',
    );
  }
  // ScreenSaveActive is a REG_SZ value: reg query prints its data VERBATIM, so a disabled screen
  // saver is the plain string "0" — not the 0x0 a REG_DWORD would print. Accept both so the check
  // follows the value, not a guessed encoding; anything else (an enabled saver prints "1") blocks.
  if (active !== '0' && active !== '0x0') {
    return blocked(
      `the screen saver is active (ScreenSaveActive ${active}) — an active screen saver drags the lock screen over the desktop mid-scenario; set ScreenSaveActive to 0`,
    );
  }
  return pass('standby idle 0, screen saver off');
}

/**
 * The same desktop-automation backend resolver the scenarios use, so a host that cannot resolve its
 * helper is named HERE (before any editor launches) instead of mid-scenario.
 */
function checkDesktopBackend({ requestedPlatform, resolveBackend }) {
  const resolved = resolveBackend(requestedPlatform);
  if (resolved.status === 'blocked') return blocked(resolved.reason);
  return pass(resolved.backend.technology);
}

/**
 * Every advertised client binary, with its resolved version recorded in the report — the report
 * then states the exact client versions the cells drove, which is the pinned-versions fact the
 * support matrix carries.
 */
function checkClientsInstalled({ clients, resolveBinary: resolve }) {
  const installed = [];
  for (const clientId of clients) {
    const resolved = resolve(clientSpec(clientId));
    if (resolved.status === 'blocked') return blocked(resolved.reason);
    installed.push({ client: clientId, version: resolved.version });
  }
  return pass(installed.map((entry) => `${entry.client} ${entry.version}`).join(', '));
}

// ─── the attested checks ────────────────────────────────────────────────────────────────────────

/** Resolve which attestation file this run consults: explicit --attestation, the
 * KCRIB_CERTIFICATION_ATTESTATION env var (set in the runner's own environment, never a secret),
 * or the host default under the operator's home. */
export function resolveAttestationPath(options = {}) {
  if (options.attestationPath) return options.attestationPath;
  if (options.env?.KCRIB_CERTIFICATION_ATTESTATION)
    return options.env.KCRIB_CERTIFICATION_ATTESTATION;
  return defaultAttestationPath(options.homedir);
}

/**
 * Evaluate every required attested fact against the operator attestation. The attestation is the
 * ONLY source for these facts — the preflight never infers them — so each fact produces exactly one
 * check, blocked with the fact's requirement named when the attestation is absent, malformed, or
 * does not carry it.
 */
function attestedChecks({ attestation }) {
  const checks = [];
  if (!attestation.present) {
    for (const fact of REQUIRED_ATTESTED_FACTS) {
      checks.push({
        id: fact.id,
        kind: 'attested',
        ...blocked(
          `unattested: ${fact.requirement} — record it in the operator attestation ` +
            `(${attestation.where}); a fact a program cannot probe is never silently satisfied`,
        ),
      });
    }
    return checks;
  }
  const facts = attestation.facts ?? {};
  for (const fact of REQUIRED_ATTESTED_FACTS) {
    const value = facts[fact.id];
    if (fact.shape === 'boolean-true' && value !== true) {
      checks.push({
        id: fact.id,
        kind: 'attested',
        ...blocked(`the attestation does not affirm: ${fact.requirement}`),
      });
    } else if (fact.shape === 'client-list') {
      const signedIn = Array.isArray(value) ? value : [];
      const missing = CERTIFIED_CLIENTS.filter((clientId) => !signedIn.includes(clientId));
      if (missing.length > 0) {
        checks.push({
          id: fact.id,
          kind: 'attested',
          ...blocked(
            `the attestation does not list these clients as signed in: ${missing.join(', ')} — ` +
              `every advertised client (${CERTIFIED_CLIENTS.join(', ')}) must be signed in`,
          ),
        });
      } else {
        // Echo back only the ADVERTISED client ids, never the raw list: the attestation is operator
        // input, and a signedIn value like ["claude", "cursor", "personal-account@example.com"] must
        // not travel into an uploaded report just because it passed the check.
        checks.push({
          id: fact.id,
          kind: 'attested',
          status: 'pass',
          detail: CERTIFIED_CLIENTS.filter((clientId) => signedIn.includes(clientId)).join(', '),
        });
      }
    } else {
      checks.push({ id: fact.id, kind: 'attested', status: 'pass' });
    }
  }
  if (!attestation.operator) {
    checks.push({
      id: 'attestation-operator',
      kind: 'attested',
      ...blocked(
        'the attestation carries no operator identity — an unattributed attestation is no attestation',
      ),
    });
  }
  // A full ISO-8601 instant, not just a year-shaped prefix: "2026-13-99Tnot-a-date" must not count,
  // because the recordedAt drives every later age check on this attestation.
  const recordedAt = attestation.recordedAt ?? '';
  const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
    recordedAt,
  );
  if (!isoDate || Number.isNaN(Date.parse(recordedAt))) {
    checks.push({
      id: 'attestation-recorded-at',
      kind: 'attested',
      ...blocked(
        'the attestation carries no ISO-8601 recordedAt date — an undated attestation cannot age or be re-checked',
      ),
    });
  }
  return checks;
}

/**
 * Load the operator attestation: present-or-absent plus (when present) the raw document, with its
 * own named blockers for an unreadable or non-JSON file. `options.exists` / `options.readJson` are
 * the injectable seams the suite uses to exercise every branch without writing an attestation to a
 * real operator home.
 */
function loadAttestation(options) {
  const exists = options.exists ?? existsSync;
  const readJson = options.readJson ?? ((path) => JSON.parse(readFileSync(path, 'utf8')));
  const home = options.homedir ?? homedir();
  const path = resolveAttestationPath(options);
  const where = `--attestation, $KCRIB_CERTIFICATION_ATTESTATION, or ${displayPath(defaultAttestationPath(home), home)}`;
  if (!exists(path)) {
    return { present: false, path: displayPath(path, home), where };
  }
  try {
    const document = readJson(path);
    if (!document || typeof document !== 'object') {
      return {
        present: true,
        path: displayPath(path, home),
        where,
        facts: {},
        operator: '',
        recordedAt: '',
        loadError: 'the attestation file is not a JSON object',
      };
    }
    return {
      present: true,
      path: displayPath(path, home),
      where,
      facts: document.facts,
      operator: document.operator,
      recordedAt: document.recordedAt,
    };
  } catch (error) {
    // Never echo error.message: a JSON.parse SyntaxError embeds a QUOTED SNIPPET of the file's own
    // bytes, so an unreadable attestation's contents would travel into reports and workflow logs.
    // IO failures name their errno; parse failures stay generic.
    const ioError = typeof error.code === 'string' && error.code.startsWith('E');
    return {
      present: true,
      path: displayPath(path, home),
      where,
      facts: {},
      operator: '',
      recordedAt: '',
      loadError: ioError
        ? `the attestation file cannot be read (${error.code})`
        : 'the attestation file is not valid JSON',
    };
  }
}

// ─── the preflight itself ───────────────────────────────────────────────────────────────────────

/**
 * Run every check and return the full report. The report is COMPLETE, never first-blocker-only:
 * an operator fixing a host needs every missing piece in one pass, so a blocked run lists every
 * blocker. Every host fact is injectable (`options.*`) so the suite exercises every branch on any
 * host — including the platforms this host is not.
 *
 * Check order is the report's order: native identity first, and if the preflight is not running on
 * the platform it was asked to certify, the platform-specific probes are SKIPPED with the reason
 * stated — probing a darwin host's binaries for a win32 request would be evidence about nothing.
 */
export function runHostPreflight(options = {}) {
  const requestedPlatform = options.requestedPlatform ?? process.platform;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  const hostNode = options.hostNode ?? process.versions.node;
  const wsl = options.wsl ?? isWsl;
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const clients = options.clients ?? CERTIFIED_CLIENTS;
  const resolveClientBinary = options.resolveBinary ?? resolveBinary;
  const resolveBackend = options.resolveDesktopBackend ?? resolveDesktopBackend;

  const checks = [];
  const record = (id, kind, result) => {
    checks.push({ id, kind, ...result });
  };

  const native = checkNativePlatform({ requestedPlatform, hostPlatform, wsl, env });
  record('native-platform', 'probed', native);

  // When the native identity does not hold (wrong platform, WSL, a hosted runner), probing this
  // host's desktop would be evidence about nothing — so every remaining probe is SKIPPED with the
  // reason stated, and the run reports blocked on the identity alone. The skipped statuses keep the
  // report shape stable (every PROBED_CHECKS id appears exactly once) while never fabricating a
  // probe result the host cannot honestly produce.
  if (native.status !== 'pass') {
    for (const id of PROBED_CHECKS.slice(1)) {
      record(id, 'probed', {
        status: 'skipped',
        reason: `not probed: the native-platform check did not pass, so no probe of this host could produce evidence for ${requestedPlatform}`,
      });
    }
  } else {
    record('hosted-runner', 'probed', checkHostedRunner({ env }));
    record('architecture', 'probed', checkArchitecture({ requestedPlatform, hostArch }));
    record('node-22', 'probed', checkNode({ hostNode }));
    record(
      'interactive-desktop',
      'probed',
      checkInteractiveDesktop({ requestedPlatform, spawn, env }),
    );
    record('sleep-and-lock-disabled', 'probed', checkSleepAndLock({ requestedPlatform, spawn }));
    record('desktop-backend', 'probed', checkDesktopBackend({ requestedPlatform, resolveBackend }));
    record(
      'clients-installed',
      'probed',
      checkClientsInstalled({ clients, resolveBinary: resolveClientBinary }),
    );
  }

  // Thread the resolved env through: `options.env` is undefined in the CLI path, so without this
  // spread, resolveAttestationPath would never consult $KCRIB_CERTIFICATION_ATTESTATION and a
  // runner that exports only the env var would report the attestation as absent.
  const attestation = loadAttestation({ ...options, env });
  for (const check of attestedChecks({ attestation })) {
    if (attestation.loadError && check.kind === 'attested' && check.status !== 'pass') {
      // The file exists but cannot be read: name THAT, once, on top of the facts it could not affirm.
      checks.push({
        ...check,
        reason: `${attestation.loadError} (${attestation.path}); ${check.reason}`,
      });
    } else {
      checks.push(check);
    }
  }

  const blockers = checks
    .filter((check) => check.status === 'blocked')
    .map((check) => check.reason);
  return {
    version: PREFLIGHT_VERSION,
    status: blockers.length > 0 ? 'blocked' : 'pass',
    platform: requestedPlatform,
    hostPlatform,
    arch: hostArch,
    expectedArch: EXPECTED_ARCHITECTURES[requestedPlatform] ?? null,
    nodeVersion: hostNode,
    wsl: wsl(),
    attestation: {
      path: attestation.path,
      present: attestation.present,
      ...(attestation.loadError ? { loadError: attestation.loadError } : {}),
    },
    checks,
    blockers,
  };
}

// ─── per-platform desktop serialization ─────────────────────────────────────────────────────────

/**
 * The per-platform desktop lock: GUI execution is SERIALIZED per platform — never two runs sharing
 * one active desktop. The workflow deliberately has NO job-level concurrency group — it would
 * CANCEL the queued matrix cells (one running + one pending, newest arrival wins) — so
 * serialization inside the workflow is the ONE registered runner per platform, which queues every
 * further cell indefinitely. This lock is the same guarantee for every run the workflow does NOT
 * schedule (a manual invocation, a second runner pointed at the same desktop): the scenario
 * acquires it before anything launches and releases it on exit.
 *
 * The lock is a temp-dir file taken with O_EXCL, holding the holder's pid and start time. A holder
 * that is no longer alive (a crashed run that never released) is STOLEN — the steal is itself
 * exclusive: the unlink plus O_EXCL pair either wins the lock or observes a new live holder and
 * reports it by pid. An UNPARSEABLE payload is treated as a holder that may still be ACQUIRING
 * (open('wx') creates the path before the payload write): it blocks until the file is older than
 * the grace window, and only a payload that has stayed garbage that long — a crashed run that died
 * mid-write — is stolen. Unlinking a fresh empty lock would steal it out from under a live run.
 */
export function acquireDesktopLock(platform, options = {}) {
  const lockDir = options.lockDir ?? join(tmpdir(), 'knowledge-crib-desktop-locks');
  const lockPath = join(lockDir, `${platform}.lock`);
  const isPidAlive =
    options.isPidAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process exists but belongs to another user — still alive.
        return error.code === 'EPERM';
      }
    });
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock ?? (() => Date.now());
  const stat = options.stat ?? statSync;
  const mkdir = options.mkdir ?? mkdirSync;
  const open = options.open ?? openSync;
  const write = options.write ?? writeSync;
  const close = options.close ?? closeSync;
  const readFile = options.readFile ?? readFileSync;
  const unlink = options.unlink ?? unlinkSync;
  mkdir(lockDir, { recursive: true });
  const payload = `${JSON.stringify({ platform, pid: process.pid, startedAt: now() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = open(lockPath, 'wx');
      try {
        write(fd, payload);
      } finally {
        close(fd);
      }
      return {
        status: 'acquired',
        lockPath,
        release: () => {
          try {
            unlink(lockPath);
          } catch {
            // Already gone: a stale-lock steal from a later run, or the temp dir was cleaned. The
            // lock was advisory-while-held; releasing something already gone is a no-op.
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        // A lock the filesystem refuses to create is a named refusal, not a crash: EACCES on a
        // read-only temp dir, EMFILE with no fds left — either way the operator gets an
        // actionable fact instead of an uncaught exception that wedges the suite.
        return {
          status: 'blocked',
          reason: `the ${platform} desktop lock cannot be created (${error.code ?? 'unknown error'}) — resolve the filesystem problem under ${lockDir}; GUI execution cannot be serialized until the lock is creatable`,
        };
      }
      let holder = null;
      let parseable = true;
      try {
        holder = JSON.parse(readFile(lockPath, 'utf8'));
      } catch {
        holder = null;
        parseable = false;
      }
      if (!parseable) {
        // open('wx') creates the path BEFORE the payload write, so a contender can read an empty
        // or half-written file in that window — unlinking it here would steal the lock from a live
        // run that is microseconds from holding it. Only a payload that has been garbage longer
        // than the grace window (a run that crashed mid-write) is stale enough to steal.
        let mtimeMs = 0;
        try {
          mtimeMs = stat(lockPath).mtimeMs;
        } catch {
          // Vanished between the failed parse and the stat: the steal's unlink is then a no-op and
          // the retry observes whatever a new arrival created — falling through is safe either way.
        }
        if (clock() - mtimeMs < UNPARSEABLE_LOCK_GRACE_MS) {
          return {
            status: 'blocked',
            reason: `the ${platform} desktop lock file is mid-acquisition by another run (created just now) — GUI execution is serialized per platform: two runs must never share the active desktop; retry once the holder finishes acquiring`,
          };
        }
      } else if (holder?.pid && isPidAlive(holder.pid)) {
        return {
          status: 'blocked',
          reason: `another run (pid ${holder.pid}, started ${holder.startedAt ?? 'unknown'}) holds the ${platform} desktop lock — GUI execution is serialized per platform: two runs must never share the active desktop; queue behind the holder instead of racing it`,
        };
      }
      // Stale holder (a crashed run that never released): remove it and retry once. If a new run
      // took the lock between the unlink and the retry, the retry reads ITS pid and reports it.
      try {
        unlink(lockPath);
      } catch {
        // Someone else stole it first — the retry observes whatever is there now.
      }
    }
  }
  return {
    status: 'blocked',
    reason: `the ${platform} desktop lock could not be acquired after a stale-holder steal — another run is almost certainly racing for the same desktop; retry once the lock is free`,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────

function usage() {
  return [
    'usage: node scripts/host-preflight.mjs [--platform darwin|linux|win32] [--json <path>]',
    '       [--attestation <path>]',
    '',
    'Validates that THIS host is provisioned for native vendor certification, producing named',
    'blockers (exit 1) for every missing piece of provisioning — never a silent pass.',
    'The operator attestation is found via --attestation, $KCRIB_CERTIFICATION_ATTESTATION, or',
    `~/.config/knowledge-crib/certification-host.json; it must affirm: ${REQUIRED_ATTESTED_FACTS.map((f) => f.id).join(', ')}.`,
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const requestedPlatform = flag(argv, '--platform', process.platform);
  const jsonPath = flag(argv, '--json');
  const attestationPath = flag(argv, '--attestation');
  const report = runHostPreflight({ requestedPlatform, attestationPath });

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.status === 'blocked') {
    process.stderr.write(
      `certification host preflight: BLOCKED (${report.blockers.length} blocker(s))\n${report.blockers.map((reason) => `  - ${reason}`).join('\n')}\nThis host is not provisioned for certification: the cell stays NO-GO until every blocker is resolved.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `certification host preflight: PASS — ${report.platform}/${report.arch}, ${report.checks.length} checks, ` +
      `attested by ${report.attestation.path}\n`,
  );
}

// Importable for tests without running the CLI: main only fires when this file IS the entry point.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
