#!/usr/bin/env node
/**
 * The native editor certification scenarios — one scenario engine, platform desktop backends.
 *
 * Three client modes have no supported non-interactive entrypoint (VS Code's agent, Windsurf's
 * Cascade, and Copilot's Agent-mode turn run inside the editor), so certifying them means driving
 * the real desktop application. The plan fixes how: each scenario launches a DEDICATED TEST
 * PROFILE of the exact editor, opens the isolated fixture repository, enables the generated MCP
 * server through the actual UI, submits the scenario prompt, observes the protocol events and the
 * durable results, interrupts the EDITOR PROCESS TREE, reopens, and verifies authorized continuity
 * — unattended, through the platform accessibility tree (never fixed screen coordinates), under
 * versioned selectors recorded for the exact tested editor versions.
 *
 * The receipts are version-3 client-certification receipts, byte-compatible with the headless
 * harness: same eight legs, same vendor-asserting source law, same validator. A scenario cell is
 * named `client-<mode>-<platform>-<arch>.json`, so the launch matrix and launch decision consume
 * GUI-run evidence with no special casing.
 *
 * HONESTY GATE: the shipped selector sets carry EMPTY testedVersions — no GUI host has validated
 * any selector set yet — so on this host every scenario resolves to a NAMED BLOCKER and produces a
 * blocked, non-certifying receipt that still validates. That is the correct output here: real GUI
 * runs need a display, an automation interpreter, a signed-in editor and a provisioned fixture, and
 * a harness that fabricated a pass without them would be certifying a lie. Human sign-in and host
 * provisioning may happen beforehand; once they have, no operator intervention may complete a run.
 *
 * Usage:
 *   node scripts/client-desktop-certify.mjs --scenario copilot --package <candidate.tgz> \
 *     --candidate-commit <40-hex> --fixture-repo <path> [--platform <this host's platform>] \
 *     [--out <dir>] [--keep]
 *
 * --platform defaults to the running host and must equal it: the scenario drives the host's real
 * desktop, so a --platform naming another OS is refused rather than recorded as evidence.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERTIFIED_CLIENTS } from './client-certification-evidence.mjs';
import {
  CERTIFICATION_BEHAVIOURS,
  applyIsolationEnv,
  buildForeignConfig,
  buildLegs,
  clientSpec,
  commandLineMatches,
  confirmTermination,
  isWsl,
  killProcessTree,
  launchableCommand,
  processAlive,
  processTree,
  resolveBinary,
  sanitizeOutput,
  whichSync,
  wireProtocolRecorder,
} from './client-certify.mjs';
import {
  RECORDER_VERSION,
  findCompletedOperation,
  operationCount,
  recordingProblems,
  serverCommandSha256,
} from './client-protocol-recorder.mjs';
import { invokeBackend, resolveDesktopBackend } from './desktop-backends.mjs';
import { loadSelectorSets, resolveSelectors } from './desktop-selectors.mjs';
import { acquireDesktopLock } from './host-preflight.mjs';
import { POLICY_PLATFORMS, loadLaunchPolicy } from './launch-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Bumped when the scenario engine's shape changes, so a receipt names the engine that wrote it. */
export const DESKTOP_DRIVER_VERSION = '1.0.0';

/**
 * The plan's timeout defaults, as constants so the suite can pin the numbers the scenario actually
 * waits under: 60 seconds for UI transitions, five minutes for a vendor turn, 30 minutes per
 * client scenario.
 */
export const DESKTOP_TIMEOUTS = {
  UI_TRANSITION_MS: 60_000,
  VENDOR_TURN_MS: 300_000,
  SCENARIO_MS: 1_800_000,
};

/**
 * The seven steps every scenario performs, in the plan's order. Exported as data so the suite can
 * pin the order a receipt's legs were earned in, and the scenario log can narrate the same steps
 * an operator would watch.
 */
export const SCENARIO_STEPS = [
  { id: 'launchProfile', requirement: 'launch a dedicated test profile of the exact editor' },
  { id: 'openFixture', requirement: 'open the isolated fixture repository' },
  { id: 'enableMcpServer', requirement: 'enable the generated MCP server through the actual UI' },
  { id: 'submitPrompt', requirement: 'submit the scenario prompt through the editor' },
  { id: 'observeResults', requirement: 'observe protocol events and durable results' },
  { id: 'interruptEditor', requirement: 'interrupt the editor process tree' },
  { id: 'reopenAndVerify', requirement: 'reopen and verify authorized continuity' },
];

/**
 * The three distinct client modes the plan defines, each with its own editor and UI surface. The
 * `mode` is also the receipt's client id — copilot, vscode and windsurf are all advertised clients
 * in the launch policy, so the matrix consumes these receipts without a translation layer.
 */
export const DESKTOP_SCENARIOS = [
  {
    mode: 'copilot',
    editor: 'vscode',
    displayName: 'VS Code with GitHub Copilot in Agent mode',
    clientSpecId: 'copilot',
    signedInSurface: { name: 'Copilot' },
    scenarioPrompt:
      'Use the crib MCP server to record an authorized intake memory about the function ' +
      'certifiedSymbol, then tell me it is recorded.',
    verifyPrompt: 'Use the crib MCP server to recall the authorized intake about certifiedSymbol.',
  },
  {
    mode: 'vscode',
    editor: 'vscode',
    displayName: 'VS Code host-level MCP discovery',
    clientSpecId: 'vscode',
    signedInSurface: { name: 'Chat' },
    scenarioPrompt:
      'Use the crib MCP server to record an authorized intake memory about the function ' +
      'certifiedSymbol, then tell me it is recorded.',
    verifyPrompt: 'Use the crib MCP server to recall the authorized intake about certifiedSymbol.',
  },
  {
    mode: 'windsurf',
    editor: 'windsurf',
    displayName: 'Windsurf Cascade',
    clientSpecId: 'windsurf',
    signedInSurface: { name: 'Cascade' },
    scenarioPrompt:
      'Use the crib MCP server to record an authorized intake memory about the function ' +
      'certifiedSymbol, then tell me it is recorded.',
    verifyPrompt: 'Use the crib MCP server to recall the authorized intake about certifiedSymbol.',
  },
];

export function desktopScenario(mode) {
  return DESKTOP_SCENARIOS.find((scenario) => scenario.mode === mode);
}

/** The nine GUI cells: three client modes across the three certification platforms. */
export function desktopCells(platforms = POLICY_PLATFORMS) {
  return DESKTOP_SCENARIOS.flatMap((scenario) =>
    platforms.map((platform) => ({ mode: scenario.mode, platform })),
  );
}

// ─── local helpers (client-certify keeps its copies private; these mirror them exactly) ─────────

const sha256 = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const sha256File = (path) =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

/** Append to the transcript AND echo, so a watching operator sees the bytes the receipt hashes. */
function makeLog(path) {
  return (line) => {
    const text = String(line);
    appendFileSync(path, `${text}\n`);
    process.stdout.write(`${text}\n`);
  };
}

function resolveLaunchable(command, args = []) {
  if (command.includes('/') || command.includes('\\')) return launchableCommand(command, args);
  return launchableCommand(whichSync(command) ?? command, args);
}

/** Run a command, capturing everything into the transcript. Never throws — legs report status. */
function run(log, label, command, args, options = {}) {
  const started = Date.now();
  const launch = resolveLaunchable(command, args);
  const result = spawnSync(launch.command, launch.args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const ms = Date.now() - started;
  log(`\n$ ${command} ${args.join(' ')}   [${label}, ${ms}ms, exit ${result.status}]`);
  return result;
}

function gitDirty() {
  try {
    const status = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    return status.trim().length > 0;
  } catch {
    return true; // no answer is not a clean tree; the receipt says so rather than guessing
  }
}

/** Copy a recording into the receipt's outDir and describe it, or null when it does not exist. */
function archivedRecording(source, outDir, name) {
  try {
    if (!source || !existsSync(source)) return null;
    cpSync(source, join(outDir, name));
    return { path: name, sha256: sha256File(join(outDir, name)) };
  } catch {
    return null;
  }
}

/** The parsed recording for one side, or null when absent or invalid — null is a refusal, not empty. */
function protocolRead(path) {
  if (!existsSync(path)) return null;
  try {
    const recording = JSON.parse(readFileSync(path, 'utf8'));
    return recordingProblems(recording).length === 0 ? recording : null;
  } catch {
    return null;
  }
}

/** The one line a reader needs when a cell could not be certified. */
function describeBlock(behaviours, notPassed) {
  const blocked = CERTIFICATION_BEHAVIOURS.map((b) => behaviours[b.id]).filter(
    (v) => v?.status === 'blocked',
  );
  if (blocked.length > 0) return blocked[0].reason;
  const failed = CERTIFICATION_BEHAVIOURS.map((b) => behaviours[b.id]).find(
    (v) => v?.status === 'fail',
  );
  if (failed) return failed.reason ?? 'the scenario failed a certification leg';
  return `legs not passed: ${notPassed.join(', ')}`;
}

// ─── the scenario engine ───────────────────────────────────────────────────────────────────────

/**
 * Certify one desktop scenario cell end to end and persist its version-3 receipt.
 *
 * Mirrors `certifyCell` from the headless harness: the eleven behaviours, the eight legs, the same
 * receipt contract. The difference is the driver — instead of a vendor CLI turn, the scenario drives
 * the native editor through the platform accessibility backend under the versioned selector set.
 *
 * Exported so a test can drive the whole engine; on a host with no validated selector set (which is
 * every host today) the honest result is a BLOCKED, non-certifying receipt that still validates.
 */
export async function certifyDesktopCell(options) {
  const {
    scenario,
    platform = process.platform,
    arch = process.arch,
    packagePath,
    candidateCommit,
    fixtureRepo,
    outDir,
    keep = false,
    operator = userInfo().username,
    selectorSets = loadSelectorSets(),
    // Injectable so the suite can make preflight deterministic on a host that has none of the
    // provisions: the tests supply a resolved or blocked editor/backend instead of probing PATH.
    editorResolver = resolveBinary,
    backendResolver = resolveDesktopBackend,
  } = options;
  const spec = clientSpec(scenario.clientSpecId);
  // The EDITOR is resolved by its own spec, not the client's: the copilot scenario certifies the
  // Copilot agent INSIDE VS Code, and conflating the two would launch the `copilot` terminal CLI
  // as the editor — a scenario that never opens a window, judged against the wrong selector set.
  const editorSpec = clientSpec(scenario.editor);
  const { sha256: policySha256 } = loadLaunchPolicy();

  const workspace = mkdtempSync(join(tmpdir(), `crib-desktop-${scenario.mode}-`));
  const home = join(workspace, 'home');
  const prefix = join(home, 'npm-global');
  const cribHome = join(home, '.crib');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(join(cribHome, 'memory'), { recursive: true });
  const transcript = join(workspace, `${scenario.mode}-${platform}-desktop-run.log`);
  writeFileSync(transcript, '');
  const log = makeLog(transcript);

  const tag = `desktop-${createHash('sha256').update(`${candidateCommit}:${Date.now()}:${scenario.mode}`).digest('hex').slice(0, 16)}`;
  const foreignMarker = `foreign-${tag}`;
  const ownerPrincipal = `principal:${scenario.mode}-desktop-owner`;
  const foreignPrincipal = `principal:${scenario.mode}-desktop-foreign`;
  const recorderPath = join(HERE, 'client-protocol-recorder.mjs');
  const ownerRecordingPath = join(
    workspace,
    `${scenario.mode}-${platform}-${arch}-owner-recording.json`,
  );
  const foreignRecordingPath = join(
    workspace,
    `${scenario.mode}-${platform}-${arch}-foreign-recording.json`,
  );
  const protocolMarkers = [tag, foreignMarker, 'certifiedSymbol', 'intake:'];
  const configPath = join(fixtureRepo ?? '.', ...spec.configRelPath);

  const { CLAUDE_PROJECT_DIR: _inherited, ...cleanEnv } = process.env;
  const clientEnv = {
    ...cleanEnv,
    npm_config_prefix: prefix,
    KCRIB_MEMORY_DIR: join(cribHome, 'memory'),
    KCRIB_REGISTRY_DIR: cribHome,
  };

  const behaviours = {};
  const record = (results) => Object.assign(behaviours, results);
  let closeReport = null;
  let crash;
  const launchedPids = [];
  const deadline = Date.now() + DESKTOP_TIMEOUTS.SCENARIO_MS;

  const packageSha256 = sha256File(packagePath);
  const cribBin = join(prefix, 'bin', process.platform === 'win32' ? 'crib.cmd' : 'crib');
  let editorBinary = null;
  let editorVersion = null;
  let backend = null;
  let selectors = null;
  let ctx = null;

  try {
    log(`# ${scenario.displayName} desktop certification — candidate ${candidateCommit}`);
    log(`# host ${hostname()} ${platform}/${arch} node ${process.version} wsl=${isWsl()}`);
    log(`# policy ${policySha256}`);
    log(`# desktop driver ${DESKTOP_DRIVER_VERSION}`);
    log(`# run tag ${tag} (the tag is a digest; no prompt, secret or memory body is archived)`);

    // ── preflight: the named blockers, resolved BEFORE anything launches ────────────────────
    const blockers = [];
    if (!POLICY_PLATFORMS.includes(platform)) {
      blockers.push(
        `platform ${platform} is not a certification platform (${POLICY_PLATFORMS.join(', ')})`,
      );
    }
    backend = backendResolver(platform);
    if (backend.status === 'blocked') blockers.push(backend.reason);
    if (!fixtureRepo || !existsSync(fixtureRepo)) {
      blockers.push(
        `the isolated fixture repository is missing (${fixtureRepo ?? 'no --fixture-repo supplied'}) — a scenario must open the fixture, never an operator project`,
      );
    }
    const editor = editorResolver(editorSpec);
    if (editor.status === 'pass') {
      editorBinary = editor.binary;
      editorVersion = editor.version;
      record({
        vendorBinaryResolved: { status: 'pass', detail: `${editor.binary} ${editor.version}` },
      });
    } else {
      blockers.push(editor.reason);
      record({ vendorBinaryResolved: { status: 'blocked', reason: editor.reason } });
    }
    const selectorResult = resolveSelectors(selectorSets, {
      scenario: scenario.mode,
      platform,
      editorVersion: editorVersion ?? 'unknown',
      editor: scenario.editor,
    });
    if (selectorResult.status === 'pass') selectors = selectorResult.set;
    else blockers.push(selectorResult.reason);
    if (!existsSync(configPath)) {
      blockers.push(
        `the generated MCP config is absent from the fixture (${spec.configRelPath.join('/')}) — run the installer path before the editor can discover the candidate`,
      );
    }
    for (const blocker of blockers) log(`# BLOCKED: ${blocker}`);

    if (blockers.length === 0) {
      await driveScenario({
        log,
        scenario,
        spec,
        platform,
        backend,
        selectors,
        editorBinary,
        editorVersion,
        fixtureRepo,
        workspace,
        prefix,
        packagePath,
        cribBin,
        cribHome,
        clientEnv,
        configPath,
        recorderPath,
        ownerRecordingPath,
        foreignRecordingPath,
        ownerPrincipal,
        foreignPrincipal,
        protocolMarkers,
        foreignMarker,
        tag,
        record,
        launchedPids,
        deadline,
        onCrash: (reason) => {
          crash = reason;
        },
        onContext: (built) => {
          ctx = built;
        },
        onClosed: (report) => {
          closeReport = report;
        },
      });
    } else {
      // Everything the scenario never attempted is blocked by the FIRST named blocker — never
      // absent, which would read as "not required". vendorBinaryResolved keeps its own verdict.
      for (const { id } of CERTIFICATION_BEHAVIOURS) {
        if (!behaviours[id]) {
          behaviours[id] = {
            status: 'blocked',
            reason:
              id === 'vendorBinaryResolved'
                ? blockers[0]
                : `the scenario never launched: ${blockers[0]}`,
          };
        }
      }
      closeReport = 'not-run';
    }
  } catch (error) {
    crash = String(error?.message ?? error);
    log(`\n# the scenario engine stopped before finishing: ${crash}`);
  }

  // Anything the engine never reported is blocked by name — never absent.
  for (const { id } of CERTIFICATION_BEHAVIOURS) {
    if (!behaviours[id]) {
      behaviours[id] = {
        status: 'blocked',
        reason: crash
          ? `the scenario engine stopped before attempting this behaviour: ${crash}`
          : 'the scenario engine did not report this behaviour',
      };
    }
  }

  try {
    log('\n# behaviours');
    for (const { id } of CERTIFICATION_BEHAVIOURS) {
      const value = behaviours[id];
      log(`  ${id.padEnd(36)} ${value.status}${value.reason ? ` — ${value.reason}` : ''}`);
    }

    // ── the receipt ─────────────────────────────────────────────────────────────────────────
    mkdirSync(outDir, { recursive: true });
    const logName = `${scenario.mode}-${platform}-${arch}-desktop-run.log`;
    const archived = join(outDir, logName);
    cpSync(transcript, archived);

    const legs = buildLegs(behaviours, logName, sha256File(archived));
    const notPassed = Object.entries(legs)
      .filter(([, leg]) => leg.status !== 'pass')
      .map(([name]) => name);

    const receipt = {
      format: 'knowledge-crib-client-certification',
      formatVersion: 3,
      generatedAt: new Date().toISOString(),
      policySha256,
      product: { commit: candidateCommit, packageSha256 },
      client: {
        id: scenario.mode,
        version: editorVersion ?? 'unknown',
        driverVersion: DESKTOP_DRIVER_VERSION,
        certificationMode: scenario.mode,
      },
      platform: {
        os: platform,
        arch,
        node: process.version,
        ...(isWsl() && platform === 'linux' ? { wsl: true } : {}),
      },
      runId: sha256(`${candidateCommit}:${scenario.mode}:desktop:${tag}`),
      capture: {
        hostname: hostname(),
        operator,
        capturedAt: new Date().toISOString(),
        dirty: gitDirty(),
      },
      principalMarkers: { owner: sha256(ownerPrincipal), foreign: sha256(foreignPrincipal) },
      ...(ctx?.ownerConfigSha256 && ctx?.foreignConfigSha256
        ? {
            configurations: {
              owner: {
                sha256: ctx.ownerConfigSha256,
                principalSha256: sha256(ownerPrincipal),
                format: spec.configFormat,
                stores: {
                  memoryDirSha256: sha256(ctx.cribMemoryDir),
                  registryDirSha256: sha256(ctx.cribRegistryDir),
                },
                serverCommandSha256: ctx.serverCommandSha256 ?? null,
              },
              foreign: {
                sha256: ctx.foreignConfigSha256,
                principalSha256: sha256(foreignPrincipal),
                format: spec.configFormat,
                stores: {
                  memoryDirSha256: sha256(ctx.cribMemoryDir),
                  registryDirSha256: sha256(ctx.cribRegistryDir),
                },
                serverCommandSha256: ctx.serverCommandSha256 ?? null,
              },
            },
          }
        : {}),
      protocol: {
        recorderVersion: RECORDER_VERSION,
        ownerRecording: archivedRecording(
          ctx?.ownerRecordingPath,
          outDir,
          `${scenario.mode}-${platform}-${arch}-owner-recording.json`,
        ),
        foreignRecording: archivedRecording(
          ctx?.foreignRecordingPath,
          outDir,
          `${scenario.mode}-${platform}-${arch}-foreign-recording.json`,
        ),
      },
      legs,
      vendor: {
        processIdentity: editorBinary
          ? `${scenario.displayName} ${editorVersion ?? 'unknown'} (${editorBinary})`
          : null,
        interruptedProcess: ctx?.interruptEvidence
          ? {
              pid: ctx.interruptEvidence.targetPid,
              verifiedCommand: ctx.interruptEvidence.targetCommand,
              tree: ctx.interruptEvidence.tree,
              killed: ctx.interruptEvidence.killed,
              terminated: ctx.interruptEvidence.terminated,
            }
          : null,
        transcriptPath: logName,
        transcriptSha256: sha256File(archived),
      },
      teardown: closeReport ?? 'unknown',
      ...(notPassed.length > 0 ? { blockedReason: describeBlock(behaviours, notPassed) } : {}),
    };
    const receiptPath = join(outDir, `client-${scenario.mode}-${platform}-${arch}.json`);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return { receipt, behaviours, legs, archived, receiptPath };
  } finally {
    for (const pid of launchedPids) {
      if (processAlive(pid)) {
        killProcessTree(pid);
        await confirmTermination(pid, 5_000);
      }
    }
    if (!keep) rmSync(workspace, { recursive: true, force: true });
    else process.stdout.write(`workspace kept at ${workspace}\n`);
  }
}

// ─── the seven steps, driven through the automation contract ───────────────────────────────────

/**
 * The real GUI scenario. Runs only when preflight found no named blocker — which, until a GUI host
 * records tested editor versions in the selector store, is never. Every step uses accessibility
 * roles/identifiers/names through the backend contract; the keyboard command that opens the command
 * palette is the DOCUMENTED one for the platform, never a screen position.
 */
async function driveScenario(env) {
  const {
    log,
    scenario,
    spec,
    backend,
    selectors,
    editorBinary,
    editorVersion,
    fixtureRepo,
    workspace,
    prefix,
    packagePath,
    cribBin,
    clientEnv,
    configPath,
    recorderPath,
    ownerRecordingPath,
    foreignRecordingPath,
    ownerPrincipal,
    foreignPrincipal,
    protocolMarkers,
    foreignMarker,
    tag,
    record,
    launchedPids,
    deadline,
    onCrash,
    onContext,
    onClosed,
  } = env;

  const profileDir = join(workspace, 'editor-profile');
  const extensionsDir = join(workspace, 'editor-extensions');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  let pid = null;
  let operationsBeforeRestart = 0;
  // The wiring facts the receipt hashes — built when the recorder is wired, extended with the
  // interruption evidence at step 6. A local (not threaded through callbacks) so the foreign turn
  // and the reopen read the SAME object the receipt will.
  let context = null;
  let interruptEvidence = null;
  // The foreign principal's planted-and-confirmed evidence pair, captured during the plant turn —
  // the exclusion leg is only allowed to pass when the foreign work demonstrably existed.
  let plantedEvidence = null;
  // Set when the exclusion leg has already been recorded (the plant turn names a blocker), so the
  // post-restart check never overwrites it with a vacuous verdict.
  let exclusionSettled = false;

  const scenarioBudget = () => {
    if (Date.now() > deadline) {
      throw new Error(
        `the scenario exceeded its ${DESKTOP_TIMEOUTS.SCENARIO_MS / 60_000}-minute client scenario budget`,
      );
    }
  };

  const launchEditor = async (reason) => {
    scenarioBudget();
    log(`\n## step: launch a dedicated test profile (${reason})`);
    const launched = invokeBackend(backend, 'launchApplication', {
      command: editorBinary,
      args: [
        '--user-data-dir',
        profileDir,
        '--extensions-dir',
        extensionsDir,
        '--new-window',
        fixtureRepo,
      ],
      cwd: fixtureRepo,
    });
    pid = launched.pid;
    launchedPids.push(pid);
    // A UI transition budget, not a fixed sleep: the helper refuses to answer for an app that has
    // not registered in the accessibility tree yet, so polling IS the wait.
    const readyDeadline = Date.now() + DESKTOP_TIMEOUTS.UI_TRANSITION_MS;
    for (;;) {
      try {
        invokeBackend(backend, 'inspectSession', { pid });
        return pid;
      } catch (error) {
        if (Date.now() > readyDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };

  const killEditor = async () => {
    // The identity is verified BEFORE the kill: the leg's claim is "the EDITOR was killed", and a
    // harness that killed the wrong process tree would be certifying an interruption it never made.
    const tree = processTree(pid);
    const targetCommand = tree[0]?.command;
    if (!commandLineMatches(targetCommand, editorBinary)) {
      throw new Error(
        `the editor process ${pid} does not name ${editorBinary} (${targetCommand ?? 'unreadable'})`,
      );
    }
    const killed = killProcessTree(pid);
    const terminated = await confirmTermination(pid, 10_000);
    if (!killed || !terminated) {
      throw new Error('the editor process tree could not be terminated');
    }
    return { targetPid: pid, targetCommand, tree, killed, terminated };
  };

  const control = (id) => selectors.controls[id];
  const findControl = (id) =>
    invokeBackend(backend, 'findElement', {
      pid,
      role: control(id).role,
      name: control(id).name,
      identifier: control(id).identifier,
    });
  const waitForControl = (id, timeoutMs = DESKTOP_TIMEOUTS.UI_TRANSITION_MS) =>
    invokeBackend(backend, 'waitForState', {
      pid,
      role: control(id).role,
      name: control(id).name,
      timeoutMs,
    });
  const completedOps = (path, fromIndex = 0) => {
    const recording = protocolRead(path);
    if (!recording) return 0;
    return Math.max(0, operationCount(recording) - fromIndex);
  };

  try {
    // ── configure: the installer path writes the config; the recorder is wired into it ───────
    log('\n## configure: install the candidate and generate the MCP config');
    const install = run(
      log,
      'fixture: install the candidate into an isolated prefix',
      'npm',
      ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', resolve(packagePath)],
      { env: clientEnv, timeoutMs: 600_000 },
    );
    if (install.status === 0 && existsSync(cribBin)) {
      const generated = run(
        log,
        'fixture: generate the MCP config through the installer path',
        cribBin,
        // The flags the SHIPPED CLI parses: --ide, --bin and a positional project path. The
        // --client/--scope spellings do not exist in cmdMcp, and a driver that passed them would
        // silently install nothing and then judge a config no editor ever discovered.
        ['mcp', 'install', '--ide', spec.installerIde, '--bin', cribBin, fixtureRepo],
        { env: clientEnv, cwd: fixtureRepo, timeoutMs: 120_000 },
      );
      const wireContext = {
        configPath,
        recorderPath,
        ownerRecordingPath,
        ownerPrincipal,
        protocolMarkers,
        cribMemoryDir: clientEnv.KCRIB_MEMORY_DIR,
        cribRegistryDir: clientEnv.KCRIB_REGISTRY_DIR,
      };
      if (generated.status === 0 && existsSync(configPath)) {
        record({ configGeneratedByInstaller: { status: 'pass' } });
        try {
          // The isolating env is added to the config the installer wrote BEFORE the recorder is
          // wired into it — the same disclosed operator step the headless harness performs. Without
          // it the editor-spawned server would write the operator's real ~/.crib and run with no
          // principal, so the exclusion boundary would be default-vs-foreign and the receipt's
          // store digests would hash paths nothing ever used.
          applyIsolationEnv(wireContext, spec);
          const original = wireProtocolRecorder(wireContext, spec);
          const foreignConfig = buildForeignConfig(
            { ...wireContext, foreignRecordingPath, foreignPrincipal },
            spec,
            readFileSync(configPath, 'utf8'),
          );
          const ownerConfigSha256 = sha256File(configPath);
          const foreignConfigSha256 = sha256(foreignConfig);
          const targetsCandidate = commandLineMatches(original.server, cribBin);
          if (targetsCandidate) {
            record({ configTargetsInstalledCandidate: { status: 'pass' } });
          } else {
            record({
              configTargetsInstalledCandidate: {
                status: 'fail',
                reason: `the generated config launches ${original.server}, not the installed candidate`,
              },
            });
          }
          context = {
            ...wireContext,
            foreignRecordingPath,
            foreignPrincipal,
            ownerConfigSha256,
            foreignConfigSha256,
            serverCommandSha256: serverCommandSha256(original.server, original.serverArgs),
            foreignConfig,
            // The exact owner bytes to restore before the reopened-editor phase, so the foreign
            // swap can never leak into the continuity check the receipt certifies.
            ownerConfigBytes: readFileSync(configPath, 'utf8'),
          };
          onContext(context);
        } catch (error) {
          record({
            configTargetsInstalledCandidate: {
              status: 'fail',
              reason: `the generated config could not be isolated and wired: ${sanitizeOutput(
                String(error?.message ?? error),
              )}`,
            },
          });
        }
      } else {
        record({
          configGeneratedByInstaller: {
            status: 'fail',
            reason: 'the installer path did not write a config the editor can discover',
          },
        });
      }
    } else {
      record({
        configGeneratedByInstaller: {
          status: 'blocked',
          reason: 'the candidate package could not be installed into the isolated prefix',
        },
      });
    }

    // ── step 1 + 2: launch the dedicated profile with the fixture repository open ────────────
    await launchEditor('the scenario opens the isolated fixture repository');
    log(
      '## step: open the isolated fixture repository (launched with the fixture as its workspace)',
    );

    // ── signed-in check: an editor with no signed-in session certifies nothing ────────────────
    const diagnostics = invokeBackend(backend, 'captureDiagnostics', { pid });
    // The signed-in surface must appear as an ELEMENT NAME in the accessibility tree, matched
    // exactly. A substring over the serialized diagnostics would also match the surface name
    // appearing inside some unrelated element's description or identifier while the session is
    // signed out — the vacuous pass this walk exists to prevent.
    const elementNames = (rows) =>
      Array.isArray(rows)
        ? rows.flatMap((row) => [
            typeof row?.name === 'string' ? row.name : null,
            ...elementNames(row?.children),
          ])
        : [];
    const signedIn = elementNames(diagnostics.tree).includes(scenario.signedInSurface.name);
    record({
      vendorAuthenticated: signedIn
        ? { status: 'pass' }
        : {
            status: 'blocked',
            reason: `the editor session shows no signed-in ${scenario.signedInSurface.name} surface — human sign-in may happen beforehand, but an unsigned session certifies nothing`,
          },
    });
    if (!signedIn) return;

    // ── step 3: enable the generated MCP server through the actual UI ─────────────────────
    scenarioBudget();
    log('\n## step: enable the generated MCP server through the actual UI');
    await findControl('commandPalette');
    if (scenario.mode === 'copilot') {
      await invokeBackend(backend, 'invokeElement', {
        pid,
        ...control('agentModeIndicator'),
      });
    }
    await invokeBackend(backend, 'invokeElement', { pid, ...control('cribServerToggle') });
    await waitForControl('sessionNotice');
    log('the UI reports the crib MCP server connected');

    // ── step 4: submit the scenario prompt through the editor ──────────────────────────────
    scenarioBudget();
    log('\n## step: submit the scenario prompt through the editor');
    await waitForControl('chatInput');
    await invokeBackend(backend, 'setText', {
      pid,
      ...control('chatInput'),
      // The per-run tag rides IN the prompt, the same law as the headless harness: the vendor turn
      // must carry the marker into its memory operation, or the record leg has nothing to find.
      text: `${scenario.scenarioPrompt} Original="${tag}".`,
    });
    await invokeBackend(backend, 'invokeElement', { pid, ...control('chatSubmit') });

    // ── step 5: observe protocol events and durable results ────────────────────────────────
    // A VENDOR TURN budget, and NO blind retry: the engine waits for the request to COMPLETE in
    // the recorded protocol traffic before it judges anything, and if the record request did not
    // complete it reports that by name instead of issuing another write — an unconfirmed mutation
    // retried blindly is exactly how a receipt ends up certifying a duplicate it never observed.
    scenarioBudget();
    log('\n## step: observe protocol events and durable results');
    const turnDeadline = Date.now() + DESKTOP_TIMEOUTS.VENDOR_TURN_MS;
    let ownerRecording = null;
    for (;;) {
      ownerRecording = protocolRead(ownerRecordingPath);
      const done =
        ownerRecording &&
        findCompletedOperation(ownerRecording, { method: 'tools/call', requestMarker: tag });
      if (done) break;
      if (Date.now() > turnDeadline) {
        record({
          authorizedRecordThroughVendorClient: {
            status: 'blocked',
            reason:
              'the authorized record request did not complete within the vendor-turn budget — inspect ' +
              'whether the request completed before issuing another write',
          },
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const initialize = ownerRecording
      ? findCompletedOperation(ownerRecording, { method: 'initialize' })
      : null;
    record({
      handshakeThroughVendorClient: initialize
        ? {
            status: 'pass',
            protocol: [
              { recording: 'owner', operation: initialize.index, request: initialize.operation.id },
            ],
          }
        : {
            status: 'fail',
            reason: 'no completed MCP initialize was recorded from the editor session',
          },
    });
    const toolCall = ownerRecording
      ? findCompletedOperation(ownerRecording, { method: 'tools/call' })
      : null;
    record({
      toolInvocationThroughVendorClient: toolCall
        ? {
            status: 'pass',
            protocol: [
              { recording: 'owner', operation: toolCall.index, request: toolCall.operation.id },
            ],
          }
        : { status: 'fail', reason: 'no completed tool call was recorded from the editor session' },
    });
    const recordCall = ownerRecording
      ? findCompletedOperation(ownerRecording, { method: 'tools/call', requestMarker: tag })
      : null;
    if (recordCall) {
      record({
        authorizedRecordThroughVendorClient: {
          status: 'pass',
          protocol: [
            { recording: 'owner', operation: recordCall.index, request: recordCall.operation.id },
          ],
        },
      });
    }

    // The durable result: the tagged intake must exist in the ISOLATED journal the candidate
    // writes to — "the editor printed success" is not a durable result.
    const durable = run(
      log,
      'observe: query the durable intake',
      cribBin,
      ['memory', 'recall', tag],
      {
        env: clientEnv,
        cwd: fixtureRepo,
        timeoutMs: 120_000,
      },
    );
    log(sanitizeOutput(`${durable.stdout ?? ''}${durable.stderr ?? ''}`).trim());

    // ── the foreign principal plants over the SAME stores, through the editor's config ────
    scenarioBudget();
    log('\n## the foreign principal plants durable work through the same stores');
    if (context) {
      writeFileSync(configPath, context.foreignConfig);
      await killEditor(); // reuse the kill path so the foreign turn gets its own editor process
      await launchEditor('the foreign principal session');
      await waitForControl('chatInput');
      await invokeBackend(backend, 'setText', {
        pid,
        ...control('chatInput'),
        // The same record the owner made, tagged with the FOREIGN marker, plus the recall that
        // confirms the plant from the foreign principal's own side — a record nobody can retrieve
        // was never durable, and an exclusion proof about work that never existed is vacuous.
        text: `${scenario.scenarioPrompt} Original="${foreignMarker}". Then use the crib MCP server to recall your own work: reply with ONLY the word PRESENT if the recall shows an intake whose original contains "${foreignMarker}", otherwise ABSENT.`,
      });
      await invokeBackend(backend, 'invokeElement', { pid, ...control('chatSubmit') });
      const foreignDeadline = Date.now() + DESKTOP_TIMEOUTS.VENDOR_TURN_MS;
      let foreignRecording = null;
      let createEvidence = null;
      for (;;) {
        foreignRecording = protocolRead(foreignRecordingPath);
        createEvidence = foreignRecording
          ? findCompletedOperation(foreignRecording, {
              method: 'tools/call',
              requestMarker: foreignMarker,
            })
          : null;
        if (createEvidence) break;
        if (Date.now() > foreignDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await killEditor();
      // The owner config goes back in before the continuity phase, so the reopened editor is the
      // owner's session again.
      writeFileSync(configPath, context.ownerConfigBytes);
      if (!createEvidence) {
        // A silent skip here would leave the exclusion leg passing vacuously: nothing was planted,
        // so nothing could leak, and the boundary was never exercised. Named and blocked instead.
        record({
          foreignPrincipalExclusion: {
            status: 'blocked',
            reason:
              'the foreign principal record request did not complete within the vendor-turn budget, ' +
              'so no durable foreign work exists to test the exclusion boundary against',
          },
        });
        exclusionSettled = true;
      } else {
        // createEvidence here is the raw findCompletedOperation result — { operation, index } — so
        // the confirm search must resume from its numeric .index. (The headless harness can write
        // `createEvidence.operation + 1` only because its protocolMatch hands back a receipt-shaped
        // ref whose .operation IS the index; the shapes must not be conflated.)
        const confirmEvidence = findCompletedOperation(foreignRecording, {
          method: 'tools/call',
          resultMarker: foreignMarker,
          fromIndex: createEvidence.index + 1,
        });
        plantedEvidence = confirmEvidence
          ? {
              createEvidence,
              confirmEvidence,
              // The owner-side op the exclusion claim is made about: the resumed handoff after the
              // restart, whose result must not carry the foreign marker.
              resumedEvidence: null,
            }
          : null;
      }
      await launchEditor('the owner session reopened with the owner config');
    }

    // ── step 6: interrupt the editor process tree ──────────────────────────────────────────
    scenarioBudget();
    log('\n## step: interrupt the editor process tree');
    if (pid) {
      interruptEvidence = await killEditor();
      context = { ...(context ?? {}), interruptEvidence };
      onContext(context);
    }
    // The resumed-evidence floor is captured AFTER the interruption — the headless harness does
    // the same — so only an operation the REOPENED editor completes can count as resumed
    // evidence, never something the killed process recorded earlier. Unconditional on purpose:
    // a floor left at its 0 default would let pre-restart operations pose as resumed evidence
    // whenever the foreign-wiring path above is skipped.
    operationsBeforeRestart = completedOps(ownerRecordingPath);

    // ── step 7: reopen and verify authorized continuity ────────────────────────────────────
    scenarioBudget();
    log('\n## step: reopen and verify authorized continuity');
    await launchEditor('the interrupted editor reopens against the same state');
    await waitForControl('chatInput');
    await invokeBackend(backend, 'setText', {
      pid,
      ...control('chatInput'),
      text: scenario.verifyPrompt,
    });
    await invokeBackend(backend, 'invokeElement', { pid, ...control('chatSubmit') });
    const resumeDeadline = Date.now() + DESKTOP_TIMEOUTS.VENDOR_TURN_MS;
    let resumed = null;
    for (;;) {
      const recording = protocolRead(ownerRecordingPath);
      // Any completed memory op after the floor counts — the headless mirror deliberately does
      // the same. A requestMarker cannot be required here: the reopened editor is directed to
      // RECALL the intake (a memory_recall {q} request carries no 'intake:' literal), and the
      // recorder stamps markers only on literal substring matches.
      resumed = recording
        ? findCompletedOperation(recording, {
            method: 'tools/call',
            tool: 'memory',
            fromIndex: operationsBeforeRestart,
          })
        : null;
      if (resumed) break;
      if (Date.now() > resumeDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    record({
      // "A process launched" is not "a session restarted": the leg's evidence is the COMPLETED
      // memory operation the reopened editor produced after the interruption floor. Without a
      // protocol reference the receipt's version-3 validator rejects the whole evidence directory,
      // and without a named failure a relaunched window that never reconnected would certify a
      // restart that never resumed.
      vendorProcessRestarted: resumed
        ? {
            status: 'pass',
            detail: 'a fresh editor process started against the same state',
            protocol: [
              { recording: 'owner', operation: resumed.index, request: resumed.operation.id },
            ],
          }
        : {
            status: 'fail',
            reason:
              'the reopened editor produced no completed memory operation after the interruption ' +
              'floor — a relaunched window is not a restarted session',
          },
      authorizedSessionResumed: resumed
        ? {
            status: 'pass',
            protocol: [
              { recording: 'owner', operation: resumed.index, request: resumed.operation.id },
            ],
          }
        : {
            status: 'fail',
            reason:
              'the reopened editor did not recover the authorized session the killed one recorded',
          },
    });
    // The boundary: the owner's retrieval must not surface the foreign principal's marker.
    const ownerView = run(
      log,
      'verify: the owner recalls without the foreign marker',
      cribBin,
      ['memory', 'recall', tag],
      { env: clientEnv, cwd: fixtureRepo, timeoutMs: 120_000 },
    );
    if (!exclusionSettled) {
      if (ownerView.status !== 0) {
        record({
          foreignPrincipalExclusion: {
            status: 'blocked',
            reason: `the durable recall could not run (exit ${ownerView.status}), so the exclusion boundary was never exercised`,
          },
        });
      } else {
        const leaked = `${ownerView.stdout ?? ''}`.includes(foreignMarker);
        if (plantedEvidence) {
          plantedEvidence.resumedEvidence = resumed
            ? {
                recording: 'owner',
                operation: resumed.index,
                request: resumed.operation.id,
              }
            : null;
        }
        record({
          foreignPrincipalExclusion: leaked
            ? {
                status: 'fail',
                reason: "another principal's durable work reached the owner",
              }
            : plantedEvidence?.resumedEvidence
              ? {
                  status: 'pass',
                  protocol: [
                    {
                      recording: 'foreign',
                      operation: plantedEvidence.createEvidence.index,
                      request: plantedEvidence.createEvidence.operation.id,
                    },
                    {
                      recording: 'foreign',
                      operation: plantedEvidence.confirmEvidence.index,
                      request: plantedEvidence.confirmEvidence.operation.id,
                    },
                    plantedEvidence.resumedEvidence,
                  ],
                }
              : {
                  status: 'fail',
                  reason: plantedEvidence
                    ? 'the reopened owner session produced no recall to test the boundary against, so the exclusion was never exercised'
                    : 'the foreign record was created but its confirmation recall never completed, so the exclusion was never exercised against proven-foreign work',
                },
        });
      }
    }
    record({ vendorProcessInterrupted: { status: 'pass' } });
  } catch (error) {
    onCrash(String(error?.message ?? error));
  } finally {
    for (const launched of launchedPids) {
      if (processAlive(launched)) {
        killProcessTree(launched);
        await confirmTermination(launched, 5_000);
      }
    }
    onClosed('clean');
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const mode = flag(argv, '--scenario');
  const packagePath = flag(argv, '--package');
  const candidateCommit = flag(argv, '--candidate-commit');
  const fixtureRepo = flag(argv, '--fixture-repo');
  const platform = flag(argv, '--platform', process.platform);
  const outDir = resolve(flag(argv, '--out', 'client-certification-receipts'));
  const keep = argv.includes('--keep');

  const problems = [];
  const scenario = desktopScenario(mode);
  if (!scenario) {
    problems.push(
      `--scenario must be one of: ${DESKTOP_SCENARIOS.map((s) => s.mode).join(', ')} (got ${JSON.stringify(mode)})`,
    );
  }
  if (scenario && !CERTIFIED_CLIENTS.includes(scenario.mode)) {
    problems.push(`${scenario.mode} is not an advertised client in the launch policy`);
  }
  if (!packagePath)
    problems.push(
      '--package <candidate-tarball> is required — a receipt must bind the bytes it certified',
    );
  else if (!existsSync(packagePath)) problems.push(`--package ${packagePath} does not exist`);
  if (!candidateCommit || !/^[a-f0-9]{40}$/.test(candidateCommit)) {
    problems.push('--candidate-commit must be a full 40-hex commit');
  } else {
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (head !== candidateCommit) {
      problems.push(
        `--candidate-commit ${candidateCommit} is not HEAD (${head}); certify the commit whose harness produced the evidence`,
      );
    }
  }
  if (!fixtureRepo) {
    problems.push(
      '--fixture-repo <path> is required — the scenario must open the isolated fixture',
    );
  } else if (!existsSync(fixtureRepo)) {
    problems.push(`--fixture-repo ${fixtureRepo} does not exist`);
  }
  if (!POLICY_PLATFORMS.includes(platform)) {
    problems.push(
      `--platform must be one of: ${POLICY_PLATFORMS.join(', ')} (got ${JSON.stringify(platform)})`,
    );
  } else if (platform !== process.platform) {
    problems.push(
      `--platform ${platform} does not match this host (${process.platform}) — a GUI scenario drives this host's real desktop, so certifying another platform from here would fabricate the evidence`,
    );
  }
  if (problems.length) {
    process.stderr.write(
      `client-desktop-certify REFUSES to start:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exit(2);
  }

  // GUI execution is SERIALIZED per platform: never two runs sharing one active desktop. The
  // workflow deliberately has NO job-level concurrency group — it would cancel the queued matrix
  // cells — so serialization is the ONE registered runner per platform (Actions queues every
  // further cell indefinitely). This lock is the same guarantee for every run the workflow does
  // NOT schedule (a manual invocation, a second runner pointed at the same desktop). Taken after
  // arg validation so the engine and its suite stay unaffected, and released in a finally so a
  // blocked or crashed run never wedges the platform.
  const desktopLock = acquireDesktopLock(platform);
  if (desktopLock.status !== 'acquired') {
    process.stderr.write(`client-desktop-certify REFUSES to start:\n  - ${desktopLock.reason}\n`);
    process.exit(1);
  }

  let cell;
  try {
    cell = await certifyDesktopCell({
      scenario,
      platform,
      packagePath: resolve(packagePath),
      candidateCommit,
      fixtureRepo: resolve(fixtureRepo),
      outDir,
      keep,
    });
  } finally {
    desktopLock.release();
  }
  const { receipt, legs, receiptPath } = cell;

  const notPassed = Object.entries(legs).filter(([, leg]) => leg.status !== 'pass');
  const runtimeVerified = notPassed.length === 0;
  process.stdout.write(
    `\n${mode}/${platform}/${process.arch}: ${runtimeVerified ? 'RUNTIME-VERIFIED' : 'NOT CERTIFIED'} -> ${receiptPath}\n`,
  );
  if (!runtimeVerified) {
    process.stdout.write(`  ${receipt.blockedReason}\n`);
    process.stdout.write(
      '  This cell stays uncertified: an unavailable editor, backend or untested selector set is a named ' +
        'NO-GO blocker for the launch decision, never a warning.\n',
    );
    process.exitCode = 1;
  }
}

// Importable for tests without running the CLI: `main` only fires when this file IS the entry point.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
