/**
 * Tests for the native editor certification scenarios: the automation contract, the platform
 * desktop backends, the versioned selector law, and the scenario engine.
 *
 * THE HARD PART TO TEST is the same one the headless harness faces, one level deeper: this
 * machinery exists to drive REAL GUI editors, and no CI host has a display, a signed-in editor or
 * a validated selector set. The honest output of the scenario engine on such a host is a NAMED
 * BLOCKER — never a fabricated pass — and the tests below assert exactly that: every resolution
 * the engine can reach on this host ends in a blocker that names the missing provision, and the
 * blocked receipt still validates under the version-3 contract the launch decision consumes.
 *
 * WHAT CAN be tested for real, is: the nine-operation contract is exactly the plan's nine verbs
 * in order; every platform helper implements all nine in its dispatch table (structurally pinned,
 * so a helper that drops an operation fails here instead of half-running a scenario on a GUI
 * host); selector sets that pin screen coordinates are rejected outright; a selector set whose
 * testedVersions nobody recorded resolves to a named blocker; and the shared envelope protocol
 * round-trips through a stub helper, so the engine's parsing of helper output is exercised without
 * any accessibility API.
 *
 * NO GUI, NO DISPLAY, NO NETWORK, and no host binaries are probed or spawned: the engine's
 * preflight resolutions (editor, backend) are INJECTED by the tests below, so the only processes
 * this suite spawns are this repo's own node — plus the one `git rev-parse` at module load that
 * names the commit under test.
 *
 * Run: node scripts/desktop-backend.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFICATION_LEGS,
  CERTIFIED_CLIENTS,
  certificationCell,
  validateClientCertificationReceipt,
} from './client-certification-evidence.mjs';
import { clientSpec } from './client-certify.mjs';
import {
  DESKTOP_DRIVER_VERSION,
  DESKTOP_SCENARIOS,
  DESKTOP_TIMEOUTS,
  SCENARIO_STEPS,
  certifyDesktopCell,
  connectInstruction,
  desktopCells,
  desktopScenario,
  historyInstruction,
} from './client-desktop-certify.mjs';
import {
  AUTOMATION_CONTRACT,
  DESKTOP_BACKENDS,
  backendInvocation,
  invokeBackend,
  resolveDesktopBackend,
} from './desktop-backends.mjs';
import {
  SCENARIO_CONTROL_IDS,
  loadSelectorSets,
  resolveSelectors,
  selectorSetProblems,
} from './desktop-selectors.mjs';
import { POLICY_PLATFORMS } from './launch-policy.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const HEAD = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

/** Same digest shape the harness and recorder use, so a re-hash is comparable to the declared one. */
const sha256File = (path) =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

const failures = [];
function report(label, ok, message) {
  if (ok) process.stdout.write(`  ok   ${label}\n`);
  else {
    failures.push(`${label}: ${message}`);
    process.stderr.write(`  FAIL ${label}\n    ${message}\n`);
  }
}
function check(label, fn) {
  try {
    fn();
    report(label, true);
  } catch (error) {
    report(label, false, error.message);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    report(label, true);
  } catch (error) {
    report(label, false, error.message);
  }
}

// ─── 0. connected memory in the scenario (receipt format 4) ────────────────────────────────────
check(
  'the owner scenario records and later retrieves connected memory; the shared prompt does not',
  () => {
    const tag = 'certify-0123456789abcdef';
    const connect = connectInstruction(tag);
    assert.match(connect, /op="graph_propose"/);
    assert.ok(connect.includes(`topic:${tag}-v2`) && connect.includes('predicate="supersedes"'));
    const history = historyInstruction(tag);
    assert.match(history, /memory_graph tool with op="history"/);
    assert.ok(history.includes(`topic:${tag}-v1`));
    // The foreign plant reuses scenarioPrompt, so graph instructions must never live in it.
    for (const scenario of DESKTOP_SCENARIOS) {
      assert.ok(!scenario.scenarioPrompt.includes('graph_propose'));
    }
  },
);

// ─── 1. the automation contract ──────────────────────────────────────────────────────────────────

process.stdout.write('\n[desktop] the automation contract\n');

check('the contract is exactly the nine plan operations, in the plan order', () => {
  assert.deepEqual(AUTOMATION_CONTRACT, [
    'inspectSession',
    'launchApplication',
    'findElement',
    'invokeElement',
    'setText',
    'sendKeys',
    'waitForState',
    'captureDiagnostics',
    'terminateApplication',
  ]);
});

check('every certification platform has exactly one desktop backend', () => {
  assert.deepEqual(
    Object.keys(DESKTOP_BACKENDS).sort(),
    [...POLICY_PLATFORMS].sort(),
    'the backends and the launch policy must name the same platforms — a policy platform with no ' +
      'desktop backend can never run its GUI cells, and a backend for an uncertified platform ' +
      'certifies nothing',
  );
  for (const platform of POLICY_PLATFORMS) {
    const backend = DESKTOP_BACKENDS[platform];
    assert.ok(backend.technology, `${platform} must name its accessibility technology`);
    assert.ok(
      (Array.isArray(backend.interpreterCandidates) && backend.interpreterCandidates.length > 0) ||
        (Array.isArray(backend.compilerCandidates) && backend.compilerCandidates.length > 0),
      `${platform} must name the runtime that runs or builds its helper — an interpreter on PATH or the machine compiler the backend compiles the helper with`,
    );
    if (Array.isArray(backend.compilerCandidates)) {
      assert.ok(
        Array.isArray(backend.references) && backend.references.length > 0,
        `${platform} must name the framework assemblies its helper compiles against`,
      );
    }
  }
});

check('every helper source ships in the checkout and implements all nine operations', () => {
  for (const platform of POLICY_PLATFORMS) {
    const backend = DESKTOP_BACKENDS[platform];
    const helperPath = resolve(HERE, backend.helperSource);
    assert.ok(
      existsSync(helperPath),
      `${platform} helper source is missing: ${backend.helperSource}`,
    );
    const source = readFileSync(helperPath, 'utf8');
    for (const operation of AUTOMATION_CONTRACT) {
      assert.ok(
        source.includes(`"${operation}"`),
        `${platform} helper has no dispatch entry for ${operation} — the scenario would lose this step mid-run on a GUI host`,
      );
    }
  }
});

// ─── 2. backend resolution and the envelope protocol ─────────────────────────────────────────────

process.stdout.write('\n[desktop] backend resolution and the wire protocol\n');

check('an unsupported platform is a named blocker, not an exception', () => {
  const result = resolveDesktopBackend('sunos');
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /no desktop automation backend for platform sunos/);
});

check('a missing helper source names the exact path that is absent', () => {
  const result = resolveDesktopBackend('darwin', {
    exists: () => false,
    which: () => '/usr/bin/swift',
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /helper source is missing/);
  assert.match(result.reason, /mac-helper\.swift/);
});

check('a missing win32 compiler names every candidate that was tried', () => {
  // The helper source exists; every Framework compiler candidate is absent: the backend must name
  // the compiler paths it looked for and the provisioning action, never a bare "cannot automate".
  const result = resolveDesktopBackend('win32', {
    exists: (path) => typeof path === 'string' && path.endsWith('win-helper.cs'),
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /csc\.exe/);
  assert.match(result.reason, /provision the desktop automation runtime/);
});

check(
  'a win32 host compiles the helper with its own csc, and an unchanged helper is compiled once',
  () => {
    let compiles = 0;
    let outArgument = null;
    const compiledExes = new Set();
    // The stub filesystem starts with the helper SOURCE and the Framework compiler; the exe a
    // compile produces is added to it, so the second resolution finds the cached artifact and must
    // not compile again.
    const options = {
      exists: (path) =>
        typeof path === 'string' &&
        (path.endsWith('win-helper.cs') || path.endsWith('csc.exe') || compiledExes.has(path)),
      spawn: (compiler, args) => {
        compiles += 1;
        outArgument = args.find((argument) => argument.startsWith('/out:'));
        compiledExes.add(outArgument?.slice('/out:'.length) ?? '');
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const first = resolveDesktopBackend('win32', options);
    assert.equal(first.status, 'pass');
    assert.equal(first.compiled, true);
    assert.ok(first.interpreter.endsWith('.exe'), 'the resolved runtime is the compiled exe');
    assert.match(
      outArgument ?? '',
      /crib-win-helper-[0-9a-f]{16}\.exe/,
      'the cached exe must be keyed by the helper source digest',
    );
    const second = resolveDesktopBackend('win32', options);
    assert.equal(second.status, 'pass');
    assert.equal(second.interpreter, first.interpreter);
    assert.equal(compiles, 1, 'an unchanged helper source must reuse the cached exe');
  },
);

check('a win32 compile failure is a named blocker before any editor launches', () => {
  const result = resolveDesktopBackend('win32', {
    exists: (path) =>
      typeof path === 'string' && (path.endsWith('win-helper.cs') || path.endsWith('csc.exe')),
    spawn: () => ({ status: 1, stdout: '', stderr: 'error CS1009: a real compile error' }),
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /failed to compile/);
  assert.match(result.reason, /CS1009/);
});

check('a compiled helper runs as the executable itself — no helper-path argument', () => {
  const invocation = backendInvocation(
    {
      backend: DESKTOP_BACKENDS.win32,
      helperPath: 'C:\\h\\win-helper.cs',
      interpreter: 'C:\\tmp\\crib-win-helper-0123456789abcdef.exe',
      compiled: true,
    },
    'inspectSession',
    { pid: 1 },
    'win32',
  );
  assert.deepEqual(invocation.args, ['inspectSession', JSON.stringify({ pid: 1 })]);
});

check('a resolved backend carries its helper path and interpreter', () => {
  const result = resolveDesktopBackend('linux', {
    which: (name) => (name === 'python3' ? '/usr/bin/python3' : undefined),
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.interpreter, '/usr/bin/python3');
  assert.ok(result.helperPath.endsWith('linux-helper.py'));
});

check('an operation outside the contract is refused before anything spawns', () => {
  const resolved = resolveDesktopBackend('linux', {
    which: () => '/usr/bin/python3',
  });
  assert.throws(
    () => backendInvocation(resolved, 'clickAtPoint', {}),
    /unknown automation operation: clickAtPoint/,
  );
});

check('a .cmd interpreter shim on win32 is invoked through cmd.exe, never a shell string', () => {
  const invocation = backendInvocation(
    {
      backend: DESKTOP_BACKENDS.win32,
      helperPath: 'C:\\h\\win-helper.cs',
      interpreter: 'C:\\dotnet-script.cmd',
    },
    'inspectSession',
    { pid: 1 },
    'win32',
  );
  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
});

check('invokeBackend refuses an unresolved backend by name', () => {
  assert.throws(
    () => invokeBackend({ status: 'blocked', reason: 'no interpreter found' }, 'inspectSession'),
    /desktop backend is not resolved \(no interpreter found\)/,
  );
});

// The envelope protocol, exercised against a stub helper speaking the shared wire format: the
// engine's parsing of helper output is real code under test, with no accessibility API involved.
const stubDir = mkdtempSync(join(tmpdir(), 'crib-desktop-stub-'));
const stubHelper = join(stubDir, 'stub-helper.mjs');
writeFileSync(
  stubHelper,
  [
    'const [operation, payloadJson] = process.argv.slice(2);',
    'const payload = JSON.parse(payloadJson || "{}");',
    "if (operation === 'waitForState') {",
    '  console.log(JSON.stringify({ ok: true, operation, result: { matched: true, echo: payload } }));',
    '} else if (payload.explode) {',
    "  console.log(JSON.stringify({ ok: false, operation, error: 'the control refused the operation' }));",
    '  process.exit(1);',
    '} else {',
    "  console.log('not json at all');",
    '}',
  ].join('\n'),
);
const stubResolved = {
  status: 'pass',
  backend: DESKTOP_BACKENDS.linux,
  helperPath: stubHelper,
  interpreter: process.execPath,
};

check('a stub helper result round-trips through the envelope', () => {
  const result = invokeBackend(stubResolved, 'waitForState', { pid: 4242 });
  assert.equal(result.matched, true);
  assert.equal(result.echo.pid, 4242);
});

check('a helper refusal becomes a named error carrying the operation', () => {
  assert.throws(
    () => invokeBackend(stubResolved, 'inspectSession', { pid: 1, explode: true }),
    /inspectSession failed: the control refused the operation/,
  );
});

check('unparseable helper output is a named error, never a silent empty result', () => {
  assert.throws(
    () => invokeBackend(stubResolved, 'findElement', { pid: 1 }),
    /findElement returned unparseable output/,
  );
});

rmSync(stubDir, { recursive: true, force: true });

// ─── 3. the selector law ─────────────────────────────────────────────────────────────────────────

process.stdout.write('\n[desktop] the versioned selector law\n');

const shippedSets = loadSelectorSets();

check('the shipped store carries one set per scenario per platform (nine cells)', () => {
  const keys = shippedSets.map((set) => `${set.scenario}/${set.platform}`).sort();
  assert.equal(keys.length, 9, `expected 9 selector sets, found ${keys.length}`);
  assert.equal(new Set(keys).size, 9, 'each scenario/platform pair must appear exactly once');
  for (const scenario of Object.keys(SCENARIO_CONTROL_IDS)) {
    for (const platform of POLICY_PLATFORMS) {
      assert.ok(
        keys.includes(`${scenario}/${platform}`),
        `no selector set for ${scenario}/${platform}`,
      );
    }
  }
});

check(
  'every shipped set is structurally valid (the law holds for what we ship, not just tests)',
  () => {
    for (const set of shippedSets) {
      const problems = selectorSetProblems(set, set.scenario);
      assert.deepEqual(problems, [], `${set.scenario}/${set.platform}: ${problems.join('; ')}`);
    }
  },
);

check(
  'every shipped set resolves to a NAMED blocker until a GUI host records tested versions',
  () => {
    // The honesty gate this whole module exists to enforce: the shipped sets carry empty
    // testedVersions on purpose, so no host — including this one — can inherit selectors nobody
    // validated. Every one of the nine cells must refuse, naming the unrecorded versions.
    for (const set of shippedSets) {
      const result = resolveSelectors(shippedSets, {
        scenario: set.scenario,
        platform: set.platform,
        editorVersion: '1.99.9',
        editor: set.editor,
      });
      assert.equal(result.status, 'blocked', `${set.scenario}/${set.platform} resolved`);
      assert.match(
        result.reason,
        /no tested editor versions/,
        `${set.scenario}/${set.platform} must name the unrecorded tested versions`,
      );
    }
  },
);

check("a version outside testedVersions never inherits a neighbouring version's selectors", () => {
  const base = shippedSets.find((s) => s.scenario === 'copilot' && s.platform === 'darwin');
  const tested = { ...base, testedVersions: ['1.90.0'] };
  const result = resolveSelectors([tested], {
    scenario: 'copilot',
    platform: 'darwin',
    editorVersion: '1.91.0',
    editor: 'vscode',
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /editor version 1\.91\.0 has no tested selector set/);
  assert.match(result.reason, /tested: 1\.90\.0/);
});

check('a recorded version with a valid set resolves — the path a GUI host unlocks', () => {
  const base = shippedSets.find((s) => s.scenario === 'windsurf' && s.platform === 'linux');
  const tested = { ...base, testedVersions: ['2.0.0'] };
  const result = resolveSelectors([tested], {
    scenario: 'windsurf',
    platform: 'linux',
    editorVersion: '2.0.0',
    editor: 'windsurf',
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.set.scenario, 'windsurf');
});

check('a selector set naming a different editor than the scenario is a named blocker', () => {
  const base = shippedSets.find((s) => s.scenario === 'vscode' && s.platform === 'darwin');
  const mismatched = { ...base, testedVersions: ['1.90.0'], editor: 'windsurf' };
  const result = resolveSelectors([mismatched], {
    scenario: 'vscode',
    platform: 'darwin',
    editorVersion: '1.90.0',
    editor: 'vscode',
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /targets windsurf, not vscode/);
});

check('a fixed-coordinate selector is rejected — the plan forbids positions as control', () => {
  const base = shippedSets.find((s) => s.scenario === 'copilot' && s.platform === 'darwin');
  const positional = {
    ...base,
    controls: { ...base.controls, chatSubmit: { ...base.controls.chatSubmit, x: 640, y: 480 } },
  };
  const problems = selectorSetProblems(positional, 'copilot');
  assert.ok(
    problems.some((p) => /fixed-coordinate selector for chatSubmit/.test(p)),
    `the coordinate selector must be named: ${problems.join('; ')}`,
  );
});

check('a set missing a scenario control names the control the scenario cannot reach', () => {
  const base = shippedSets.find((s) => s.scenario === 'vscode' && s.platform === 'win32');
  const withoutToggle = { ...base, controls: { ...base.controls } };
  withoutToggle.controls.cribServerToggle = undefined;
  const problems = selectorSetProblems(withoutToggle, 'vscode');
  assert.ok(
    problems.some((p) =>
      /missing control: the vscode scenario cannot reach cribServerToggle/.test(p),
    ),
    `the missing control must be named: ${problems.join('; ')}`,
  );
});

// ─── 4. the scenario shape ───────────────────────────────────────────────────────────────────────

process.stdout.write('\n[desktop] the scenario shape\n');

check("the three distinct client modes are the plan's three scenarios", () => {
  assert.deepEqual(
    DESKTOP_SCENARIOS.map((s) => s.mode),
    ['copilot', 'vscode', 'windsurf'],
  );
  for (const scenario of DESKTOP_SCENARIOS) {
    assert.ok(
      CERTIFIED_CLIENTS.includes(scenario.mode),
      `${scenario.mode} must be an advertised client for the launch matrix to consume its receipt`,
    );
    assert.ok(clientSpec(scenario.clientSpecId), `${scenario.mode} has no driver spec`);
    assert.ok(scenario.displayName, `${scenario.mode} must name what it certifies`);
    assert.match(
      scenario.scenarioPrompt,
      /crib MCP server/,
      `${scenario.mode}'s prompt must exercise the MCP server, not just chat`,
    );
    assert.ok(scenario.verifyPrompt, `${scenario.mode} must carry a reopen-verification prompt`);
  }
});

check('the seven plan steps are present in the plan order', () => {
  assert.deepEqual(
    SCENARIO_STEPS.map((step) => step.id),
    [
      'launchProfile',
      'openFixture',
      'enableMcpServer',
      'submitPrompt',
      'observeResults',
      'interruptEditor',
      'reopenAndVerify',
    ],
  );
  for (const step of SCENARIO_STEPS) {
    assert.ok(step.requirement, `${step.id} must state what it requires`);
  }
});

check('the nine GUI cells are three client modes across three platforms', () => {
  const cells = desktopCells();
  assert.equal(cells.length, 9, `expected 9 GUI cells, found ${cells.length}`);
  const keys = new Set(cells.map((cell) => `${cell.mode}/${cell.platform}`));
  for (const scenario of DESKTOP_SCENARIOS) {
    for (const platform of POLICY_PLATFORMS) {
      assert.ok(
        keys.has(`${scenario.mode}/${platform}`),
        `no cell for ${scenario.mode}/${platform}`,
      );
    }
  }
});

check('the plan timeout defaults are pinned as constants', () => {
  assert.deepEqual(DESKTOP_TIMEOUTS, {
    UI_TRANSITION_MS: 60_000,
    VENDOR_TURN_MS: 300_000,
    SCENARIO_MS: 1_800_000,
  });
});

// ─── 5. the blocked scenario engine (the executable honesty gate) ─────────────────────────────────

process.stdout.write('\n[desktop] the blocked scenario engine\n');

// The scenario's own preflight order, exercised through the real engine: platform first, so an
// uncertified platform is named even when every later check would fail too. BOTH preflight
// resolutions are injected — the backend stub below is blocked-shaped and is never consulted
// (the platform blocker fires first), but injecting it keeps this test off the real resolver
// entirely, so a future backend that probes host PATH can never leak in through here.
await checkAsync('an uncertified platform is the first named blocker', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'crib-desktop-preflight-'));
  const fixtureRepo = join(workspace, 'fixture');
  const packagePath = join(workspace, 'candidate.tgz');
  mkdirSync(fixtureRepo);
  writeFileSync(packagePath, 'not really a tarball');
  try {
    const { receipt, legs } = await certifyDesktopCell({
      scenario: desktopScenario('copilot'),
      platform: 'sunos',
      packagePath,
      candidateCommit: HEAD,
      fixtureRepo,
      outDir: join(workspace, 'receipts'),
      editorResolver: () => ({ status: 'pass', binary: '/opt/test/bin/code', version: '1.99.9' }),
      backendResolver: () => ({
        status: 'blocked',
        reason: 'injected: sunos resolves no desktop automation backend',
      }),
    });
    assert.equal(receipt.platform.os, 'sunos');
    const notPassed = Object.values(legs).filter((leg) => leg.status !== 'pass');
    assert.ok(notPassed.length > 0, 'a cell on an uncertified platform must not pass');
    assert.match(
      receipt.blockedReason,
      /platform sunos is not a certification platform/,
      'the platform blocker must be named first',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

await checkAsync(
  'a missing fixture repository is a named blocker, never an operator project',
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'crib-desktop-fixture-'));
    const packagePath = join(workspace, 'candidate.tgz');
    writeFileSync(packagePath, 'not really a tarball');
    try {
      const { receipt } = await certifyDesktopCell({
        scenario: desktopScenario('vscode'),
        platform: process.platform,
        packagePath,
        candidateCommit: HEAD,
        fixtureRepo: join(workspace, 'absent-fixture'),
        outDir: join(workspace, 'receipts'),
        editorResolver: () => ({ status: 'pass', binary: '/opt/test/bin/code', version: '1.99.9' }),
        backendResolver: () => ({
          status: 'pass',
          backend: DESKTOP_BACKENDS[process.platform],
          helperPath: 'stub-helper',
          interpreter: process.execPath,
        }),
      });
      assert.match(
        receipt.blockedReason,
        /fixture repository is missing/,
        'the absent fixture must be named',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

// THE MAIN HONESTY GATE: on a host with no validated selector set — which is every host until a
// GUI operator records tested versions — the engine must produce a BLOCKED, non-certifying
// receipt that still validates, carries both principals' digests, and lands under the same cell
// name the headless harness uses, so the matrix consumes GUI evidence with no special casing.
await checkAsync(
  'the engine emits a blocked v4 receipt that validates and feeds the launch matrix',
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'crib-desktop-blocked-'));
    const fixtureRepo = join(workspace, 'fixture');
    const packagePath = join(workspace, 'candidate.tgz');
    const outDir = join(workspace, 'receipts');
    mkdirSync(fixtureRepo);
    writeFileSync(packagePath, 'not really a tarball');
    try {
      const scenario = desktopScenario('copilot');
      const { receipt, legs, receiptPath } = await certifyDesktopCell({
        scenario,
        platform: process.platform,
        packagePath,
        candidateCommit: HEAD,
        fixtureRepo,
        outDir,
        // The provisioning facts this host cannot supply are injected as passes, because this
        // check is about what the engine does when the SELECTORS are the honest blocker: it must
        // still produce a blocked, validating receipt naming exactly that gate.
        editorResolver: () => ({ status: 'pass', binary: '/opt/test/bin/code', version: '1.99.9' }),
        backendResolver: () => ({
          status: 'pass',
          backend: DESKTOP_BACKENDS[process.platform],
          helperPath: 'stub-helper',
          interpreter: process.execPath,
        }),
      });

      // the receipt contract
      assert.equal(receipt.format, 'knowledge-crib-client-certification');
      assert.equal(receipt.formatVersion, 4);
      assert.equal(receipt.client.id, 'copilot');
      assert.equal(receipt.client.driverVersion, DESKTOP_DRIVER_VERSION);
      assert.equal(receipt.client.certificationMode, 'copilot');
      assert.equal(receipt.product.commit, HEAD);
      assert.equal(receipt.product.packageSha256, sha256File(packagePath));
      assert.ok(receipt.capture.capturedAt, 'the capture must be timestamped');

      // the honesty: nothing passes, and the reason is named
      const statuses = Object.values(legs).map((leg) => leg.status);
      assert.ok(
        statuses.every((status) => status !== 'pass'),
        'a blocked cell must not carry a passing leg',
      );
      assert.ok(
        statuses.every((status) => ['fail', 'blocked', 'not-run'].includes(status)),
        `unexpected leg statuses: ${statuses.join(', ')}`,
      );
      assert.ok(receipt.blockedReason, 'a blocked cell must name why');
      assert.match(
        receipt.blockedReason,
        /no tested editor versions/,
        `the blockedReason must name the selector gate, not a five-way maybe: ${receipt.blockedReason}`,
      );

      // the two principals stay distinct even when nothing ran
      assert.notEqual(receipt.principalMarkers.owner, receipt.principalMarkers.foreign);

      // the legs the validator demands unconditionally
      assert.equal(legs.handshake.source, 'vendor-client');
      assert.equal(legs.toolUse.source, 'vendor-client');

      // the eight legs of the contract, none absent, none passing
      assert.deepEqual(
        Object.keys(legs).sort(),
        [...CERTIFICATION_LEGS].sort(),
        'a desktop receipt must carry exactly the eight legs the launch decision reads',
      );

      // the receipt lands in the outDir under the matrix's cell name, and validates there
      assert.equal(
        receiptPath,
        join(outDir, `client-copilot-${process.platform}-${process.arch}.json`),
      );
      assert.ok(
        existsSync(
          join(outDir, `${scenario.mode}-${process.platform}-${process.arch}-desktop-run.log`),
        ),
      );
      validateClientCertificationReceipt(receipt, { evidenceRoot: outDir });
      // The matrix's own cell key: a desktop receipt lands in the SAME cell the headless
      // harness names, so GUI evidence feeds the launch decision with no special casing.
      assert.equal(certificationCell(receipt), `copilot/${process.platform}`);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

// ─── 6. the CLI refusals ──────────────────────────────────────────────────────────────────────────

process.stdout.write('\n[desktop] the in-scenario failure paths\n');

// The two failure paths INSIDE the engine, with every provisioning fact injected so the only thing
// under test is what the engine does when the editor UI itself refuses: (a) a session with no
// signed-in surface must stop the scenario right there and name the surface — never continue and
// never fabricate; (b) a control lookup that fails mid-scenario (selector drift) must crash into a
// receipt that RETAINS what the run established before the drift, so an operator can tell drift
// from a provisioning gap. The stub helper speaks the shared wire envelope over the full contract;
// its launchApplication spawns a REAL sacrificial child the test itself owns (a node process that
// sleeps) and reports THAT child's pid — never a hardcoded number, which could collide with a live
// host process and make the engine's teardown signal a process the run never launched.
function writeScenarioStubHelper(dir, { tree, refuseFindElement }) {
  const helper = join(dir, 'scenario-stub-helper.mjs');
  writeFileSync(
    helper,
    [
      'import { spawn } from "node:child_process";',
      'const [operation, payloadJson] = process.argv.slice(2);',
      'const payload = JSON.parse(payloadJson || "{}");',
      `const tree = ${JSON.stringify(tree)};`,
      `const refuseFindElement = ${refuseFindElement ? 'true' : 'false'};`,
      'if (operation === "launchApplication") {',
      '  const child = spawn(',
      '    process.execPath,',
      '    ["-e", "setTimeout(() => {}, 600000)"],',
      '    { stdio: "ignore", detached: true },',
      '  );',
      '  child.unref();',
      '  console.log(JSON.stringify({ ok: true, operation, result: { pid: child.pid } }));',
      '} else if (operation === "captureDiagnostics") {',
      '  console.log(JSON.stringify({ ok: true, operation, result: { tree } }));',
      '} else if (operation === "findElement" && refuseFindElement) {',
      '  console.log(JSON.stringify({ ok: false, operation,',
      '    error: `no element matched role=${JSON.stringify(payload.role)} name=${JSON.stringify(payload.name)}` }));',
      '} else {',
      '  console.log(JSON.stringify({ ok: true, operation, result: {} }));',
      '}',
    ].join('\n'),
  );
  return helper;
}

// Everything both failure tests share: a fixture repo whose .vscode/mcp.json satisfies preflight, a
// non-tarball candidate (the installer leg is honestly blocked and the engine proceeds), an editor
// resolved by injection, and the SHIPPED selector set for this platform with one recorded version —
// so preflight passes and the engine's own behaviour is the only variable left.
function scenarioCellFactory(workspace, stubHelper) {
  const fixtureRepo = join(workspace, 'fixture');
  const packagePath = join(workspace, 'candidate.tgz');
  const outDir = join(workspace, 'receipts');
  mkdirSync(join(fixtureRepo, '.vscode'), { recursive: true });
  writeFileSync(join(fixtureRepo, '.vscode', 'mcp.json'), '{}\n');
  writeFileSync(packagePath, 'not really a tarball');
  const shipped = loadSelectorSets().find(
    (set) => set.scenario === 'copilot' && set.platform === process.platform,
  );
  const selectorSets = [{ ...shipped, testedVersions: ['1.99.9'] }];
  return {
    outDir,
    run: () =>
      certifyDesktopCell({
        scenario: desktopScenario('copilot'),
        platform: process.platform,
        packagePath,
        candidateCommit: HEAD,
        fixtureRepo,
        outDir,
        selectorSets,
        editorResolver: () => ({ status: 'pass', binary: '/opt/test/bin/code', version: '1.99.9' }),
        backendResolver: () => ({
          status: 'pass',
          backend: DESKTOP_BACKENDS[process.platform],
          helperPath: stubHelper,
          interpreter: process.execPath,
        }),
      }),
  };
}

await checkAsync(
  'an unsigned editor session is the first named blocker — the scenario never starts',
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'crib-desktop-unsigned-'));
    try {
      const stubHelper = writeScenarioStubHelper(workspace, {
        // No element anywhere in the tree names the signed-in Copilot surface, and findElement
        // would refuse too — the assertion below proves the engine stopped BEFORE any control step.
        tree: [{ name: 'Menu Bar', children: [{ name: 'File', children: [] }] }],
        refuseFindElement: true,
      });
      const { run, outDir } = scenarioCellFactory(workspace, stubHelper);
      const { receipt, legs, behaviours } = await run();

      assert.equal(receipt.formatVersion, 4);
      assert.equal(behaviours.vendorBinaryResolved.status, 'pass');
      assert.equal(behaviours.vendorAuthenticated.status, 'blocked');
      assert.match(
        behaviours.vendorAuthenticated.reason,
        /no signed-in Copilot surface/,
        'the unsigned session must name the surface that is absent',
      );
      assert.equal(
        receipt.blockedReason,
        behaviours.vendorAuthenticated.reason,
        'the first named blocker must be the unsigned session, not a later echo',
      );
      const statuses = Object.values(legs).map((leg) => leg.status);
      assert.ok(
        statuses.every((status) => status === 'blocked'),
        `an unsigned session blocks every leg: ${statuses.join(', ')}`,
      );
      assert.equal(legs.handshake.source, 'vendor-client');
      assert.deepEqual(
        Object.keys(legs).sort(),
        [...CERTIFICATION_LEGS].sort(),
        'the blocked receipt must still carry exactly the eight legs',
      );
      validateClientCertificationReceipt(receipt, { evidenceRoot: outDir });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

await checkAsync(
  'a control that cannot be found mid-scenario crashes into a receipt that keeps what passed',
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'crib-desktop-drift-'));
    try {
      const stubHelper = writeScenarioStubHelper(workspace, {
        // The signed-in surface IS present, so the engine passes the sign-in gate and dies on the
        // first control lookup — selector drift, the failure an operator must be able to name.
        tree: [{ name: 'Editor', children: [{ name: 'Copilot', children: [] }] }],
        refuseFindElement: true,
      });
      const { run, outDir } = scenarioCellFactory(workspace, stubHelper);
      const { receipt, legs, behaviours, receiptPath } = await run();

      // what the run established BEFORE the drift must survive on the receipt
      assert.equal(behaviours.vendorBinaryResolved.status, 'pass');
      assert.equal(
        behaviours.vendorAuthenticated.status,
        'pass',
        'the signed-in pass must survive the later crash — erasing it would read as a sign-in failure',
      );
      assert.equal(behaviours.configGeneratedByInstaller.status, 'blocked');
      assert.equal(receipt.blockedReason, behaviours.configGeneratedByInstaller.reason);

      // the crash shape: everything after the drift is blocked BY NAME, never absent
      const crashShape =
        /the scenario engine stopped before attempting this behaviour: findElement failed: no element matched/;
      assert.match(behaviours.handshakeThroughVendorClient.reason, crashShape);
      assert.match(behaviours.toolInvocationThroughVendorClient.reason, crashShape);
      assert.equal(legs.handshake.status, 'blocked');
      assert.match(legs.handshake.detail ?? '', crashShape);

      const statuses = Object.values(legs).map((leg) => leg.status);
      assert.ok(
        statuses.every((status) => status !== 'pass'),
        'no leg may pass on a scenario that drifted',
      );
      assert.deepEqual(
        Object.keys(legs).sort(),
        [...CERTIFICATION_LEGS].sort(),
        'the crashed receipt must still carry exactly the eight legs',
      );
      assert.equal(
        receiptPath,
        join(outDir, `client-copilot-${process.platform}-${process.arch}.json`),
      );
      assert.equal(certificationCell(receipt), `copilot/${process.platform}`);
      validateClientCertificationReceipt(receipt, { evidenceRoot: outDir });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

process.stdout.write('\n[desktop] the CLI refusals\n');

check('the CLI refuses to start without its required inputs (exit 2)', () => {
  const run = spawnSync(process.execPath, [join(HERE, 'client-desktop-certify.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 2, `no-args must exit 2, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, /REFUSES to start/);
  assert.match(run.stderr, /--scenario/);
  assert.match(run.stderr, /--candidate-commit/);
  assert.match(run.stderr, /--fixture-repo/);
  assert.match(run.stderr, /--out/);
});

check('the CLI refuses a --platform that is not this host (exit 2)', () => {
  const other = POLICY_PLATFORMS.find((platform) => platform !== process.platform);
  const run = spawnSync(
    process.execPath,
    [
      join(HERE, 'client-desktop-certify.mjs'),
      '--scenario',
      'copilot',
      '--candidate-commit',
      'a'.repeat(40),
      '--fixture-repo',
      HERE,
      '--platform',
      other,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(
    run.status,
    2,
    `the mismatched platform must exit 2, got ${run.status}: ${run.stderr}`,
  );
  assert.match(
    run.stderr,
    new RegExp(`--platform ${other} does not match this host`),
    'the refusal must name the host it would fabricate evidence about',
  );
});

check('an unknown scenario mode is refused by name (exit 2)', () => {
  const run = spawnSync(
    process.execPath,
    [join(HERE, 'client-desktop-certify.mjs'), '--scenario', 'emacs'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--scenario must be one of: copilot, vscode, windsurf/);
});

check('a candidate commit that is not HEAD is refused — certify the bytes you built', () => {
  const run = spawnSync(
    process.execPath,
    [
      join(HERE, 'client-desktop-certify.mjs'),
      '--scenario',
      'copilot',
      '--package',
      'absent.tgz',
      '--candidate-commit',
      '0'.repeat(40),
      '--fixture-repo',
      'absent-dir',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /is not HEAD/);
});

check('an uncertified --platform is refused up front (exit 2)', () => {
  const run = spawnSync(
    process.execPath,
    [
      join(HERE, 'client-desktop-certify.mjs'),
      '--scenario',
      'copilot',
      '--package',
      'absent.tgz',
      '--candidate-commit',
      HEAD,
      '--fixture-repo',
      'absent-dir',
      '--platform',
      'sunos',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--platform must be one of/);
});

// ─── summary ─────────────────────────────────────────────────────────────────────────────────────

process.stdout.write(
  `\n${failures.length === 0 ? 'all desktop-backend tests ok' : `${failures.length} desktop-backend test(s) FAILED`}\n`,
);
if (failures.length > 0) {
  process.stderr.write('\nFAILURES:\n');
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
