/**
 * Tests for the vendor-certification harness.
 *
 * THE HARD PART TO TEST is that this script must produce a receipt which is (a) valid under the
 * version-2 contract, and (b) honest — a cell whose vendor runtime could not actually be exercised
 * comes back UNCERTIFIED with a named reason, never a fabricated pass. The tests below drive the
 * real `certifyCell` against a FAKE vendor binary and a deliberately broken environment, because
 * that is the one path this host can actually reach: on a machine with no signed-in vendor accounts
 * and no native Linux/Windows runner, the honest output of this harness is exactly a blocked,
 * non-certifying receipt. Asserting that it emits one — and that the receipt still validates — is
 * asserting the behaviour that matters most, not a stand-in for it.
 *
 * NO VENDOR ACCOUNT, NO NETWORK, NO REAL PACKAGE: the fake binary is four lines of shell, the
 * "candidate" is a file that is not a tarball (so the isolated install fails by design), and the
 * assertions are on the resulting verdict.
 *
 * Run: node scripts/client-certify.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CERTIFICATION_LEGS,
  validateClientCertificationReceipt,
} from './client-certification-evidence.mjs';
import {
  CERTIFICATION_BEHAVIOURS,
  CLIENT_IDS,
  DRIVER_VERSION,
  LEG_BEHAVIOURS,
  certifyCell,
  clientSpec,
  isWsl,
  sanitizeOutput,
} from './client-certify.mjs';
import { POLICY_CLIENTS } from './launch-policy.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const HEAD = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

const failures = [];
function check(label, fn) {
  try {
    fn();
    process.stdout.write(`  ok   ${label}\n`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    process.stderr.write(`  FAIL ${label}\n    ${error.message}\n`);
  }
}

// ─── 1. the behaviour/leg contract ──────────────────────────────────────────────────────────────
// The harness's own shape, checked before it is trusted to check anything else.

process.stdout.write('\n[client-certify] the behaviour and leg contract\n');

check('every advertised client has exactly one driver spec', () => {
  assert.deepEqual(
    [...CLIENT_IDS].sort(),
    [...POLICY_CLIENTS].sort(),
    'the drivers and the launch policy must name the same clients — a policy client with no driver ' +
      'can never be certified, and a driver for an unadvertised client certifies nothing',
  );
  for (const id of POLICY_CLIENTS) {
    assert.ok(clientSpec(id), `no driver spec for ${id}`);
  }
});

check('the eleven required behaviours are present and uniquely named', () => {
  assert.equal(
    CERTIFICATION_BEHAVIOURS.length,
    11,
    `the plan requires 11 behaviours; found ${CERTIFICATION_BEHAVIOURS.length}`,
  );
  const ids = CERTIFICATION_BEHAVIOURS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'behaviour ids must be unique');
  for (const behaviour of CERTIFICATION_BEHAVIOURS) {
    assert.ok(
      ['preflight', 'configure', 'invoke', 'interrupt', 'restartAndResume'].includes(
        behaviour.phase,
      ),
      `${behaviour.id} names a phase the driver interface does not have: ${behaviour.phase}`,
    );
    assert.ok(behaviour.requirement, `${behaviour.id} must state what it requires`);
  }
});

check('every leg maps to real behaviours, and only the two preconditions are unmapped', () => {
  const behaviourIds = new Set(CERTIFICATION_BEHAVIOURS.map((b) => b.id));
  const mapped = new Set();
  for (const leg of CERTIFICATION_LEGS) {
    const ids = LEG_BEHAVIOURS[leg];
    assert.ok(Array.isArray(ids) && ids.length > 0, `leg ${leg} maps to no behaviour`);
    for (const id of ids) {
      assert.ok(behaviourIds.has(id), `leg ${leg} maps to an unknown behaviour: ${id}`);
      mapped.add(id);
    }
  }
  // The two preflight gates are preconditions, not legs: they decide whether the other behaviours
  // are attempted at all, and a driver that reported them as legs would let "the binary was missing"
  // read as one failed check rather than as every check being untested.
  const unmapped = CERTIFICATION_BEHAVIOURS.map((b) => b.id).filter((id) => !mapped.has(id));
  assert.deepEqual(
    unmapped.sort(),
    ['vendorAuthenticated', 'vendorBinaryResolved'],
    'only the two preflight preconditions may sit outside the legs',
  );
});

check('the driver version is declared, so a receipt names the driver that produced it', () => {
  assert.match(DRIVER_VERSION, /^\d+\.\d+\.\d+$/, 'driverVersion must be a semver');
});

// ─── 2. the transcript must be safe to publish ───────────────────────────────────────────────────
// "Secrets, raw prompts, and memory bodies are absent from archived artifacts."

process.stdout.write('\n[client-certify] the archived transcript is sanitized\n');

check('credentials are redacted, in the shapes clients actually echo', () => {
  const raw = [
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc1234567890',
    'sk-abcdefghijklmnopqrstuvwxyz01',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'xoxb-1234567890-abcdefghijkl',
    '"api_key": "live_value_that_must_not_survive"',
    'token=supersecretvalue',
  ].join('\n');
  const out = sanitizeOutput(raw);
  for (const secret of [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'sk-abcdefghijklmnopqrstuvwxyz01',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'xoxb-1234567890-abcdefghijkl',
    'live_value_that_must_not_survive',
    'supersecretvalue',
  ]) {
    assert.ok(!out.includes(secret), `a secret survived sanitization: ${secret}`);
  }
});

check('the run markers are redacted when passed as extra redactions', () => {
  const out = sanitizeOutput('handoff shows certify-abc123 and foreign-certify-abc123', [
    'certify-abc123',
    'foreign-certify-abc123',
  ]);
  assert.ok(!out.includes('certify-abc123'), 'the run tag survived');
  assert.ok(!out.includes('foreign-certify-abc123'), 'the foreign marker survived');
});

// ─── 3. the end-to-end path: a broken environment must yield an honest receipt ───────────────────
// This is the assertion the whole file exists for.

process.stdout.write('\n[client-certify] end-to-end: a cell that cannot be exercised\n');

/** A four-line vendor binary: reports a version, reports being signed in, and does nothing else. */
function writeFakeVendor(dir, name, { signedIn }) {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "9.9.9 (fake vendor)"; exit 0;;',
      `  auth) echo '{"loggedIn":${signedIn}}'; exit 0;;`,
      'esac',
      'echo "{}"',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A real, installable tarball whose `crib` binary exits 0 and does nothing else.
 *
 * This is the strongest available test of the harness's honesty. Everything a cell needs in order to
 * be certifiable succeeds here: the package installs, `crib` resolves, the vendor client is signed in
 * and exits 0 on every prompt it is handed. If the harness could be satisfied by a stub, this run
 * would come back RUNTIME-VERIFIED — and a client that prints nothing is not a client that reached
 * the MCP server. So the assertion is that it still FAILS, leg by leg, with a named reason.
 */
function makeStubTarball(dir) {
  const pkg = join(dir, 'stub-package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: 'knowledge-crib', version: '0.1.0', bin: { crib: './crib.js' } }, null, 2)}\n`,
  );
  const crib = join(pkg, 'crib.js');
  writeFileSync(crib, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(crib, 0o755);
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: pkg, stdio: 'pipe' });
  const tarball = join(dir, 'knowledge-crib-0.1.0.tgz');
  assert.ok(existsSync(tarball), `npm pack produced no tarball at ${tarball}`);
  return tarball;
}

async function runEndToEnd({ signedIn, stubPackage = false }) {
  const scratch = mkdtempSync(join(tmpdir(), 'crib-certify-test-'));
  const bin = join(scratch, 'bin');
  const out = join(scratch, 'receipts');
  const packageDir = join(scratch, 'pkg');
  mkdirSync(bin, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFakeVendor(bin, 'claude', { signedIn });
  // Two candidate shapes, and the difference between them is the point of having both. Without a
  // tarball the install fails and the run never reaches a turn — which is how a real host with no
  // package behaves, and the receipt must say so rather than throwing. With one, every prerequisite
  // succeeds and the run reaches every leg, so the legs themselves are what must refuse.
  let fakePackage;
  if (stubPackage) {
    fakePackage = makeStubTarball(packageDir);
  } else {
    fakePackage = join(packageDir, 'not-a-package.tgz');
    writeFileSync(fakePackage, 'this is not a tarball\n');
  }

  const originalPath = process.env.PATH;
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.env.PATH = `${bin}:${originalPath}`;
  // The harness echoes its transcript to stdout so an operator watching the run sees the same bytes
  // the receipt hashes. In a test that is noise; it is swallowed here and restored below.
  process.stdout.write = () => true;
  try {
    const result = await certifyCell({
      spec: clientSpec('claude'),
      client: 'certify-test',
      packagePath: fakePackage,
      candidateCommit: HEAD,
      outDir: out,
    });
    return { result, out, scratch };
  } finally {
    process.stdout.write = originalWrite;
    process.env.PATH = originalPath;
  }
}

let e2e;
try {
  e2e = await runEndToEnd({ signedIn: false });
} catch (error) {
  failures.push(`end-to-end run threw: ${error.message}`);
  process.stderr.write(
    `  FAIL the harness threw instead of writing a receipt\n    ${error.message}\n`,
  );
}

if (e2e) {
  const { result, out, scratch } = e2e;

  check('the harness WRITES a receipt even though the environment is broken', () => {
    assert.ok(result?.receipt, 'no receipt was produced');
    const file = join(out, `client-claude-${process.platform}-${process.arch}.json`);
    assert.ok(existsSync(file), `no receipt was written at ${file}`);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.formatVersion, 2, 'on-disk receipt must be version 2');
    assert.equal(onDisk.client.driverVersion, DRIVER_VERSION);
  });

  check('the receipt VALIDATES against the version-2 contract', () => {
    // It must validate even though it certifies nothing: a blocked receipt that cannot be loaded is
    // indistinguishable from a missing cell, and the decision needs to name it.
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 2);
  });

  check('no leg claims a pass, because no vendor runtime was exercised', () => {
    for (const leg of CERTIFICATION_LEGS) {
      assert.notEqual(
        result.legs[leg].status,
        'pass',
        `legs.${leg} passed on a run where the candidate package never installed`,
      );
    }
  });

  check('the blocked receipt names WHY, in a reason a reader can act on', () => {
    assert.ok(result.receipt.blockedReason, 'a blocked receipt must carry a blockedReason');
    assert.ok(
      result.receipt.blockedReason.length > 20,
      'the blockedReason must actually explain the block, not gesture at it',
    );
  });

  check('the not-signed-in precondition blocks the legs rather than passing them', () => {
    // The fake reports `loggedIn:false`. The two vendor-asserting legs are the ones a protocol
    // harness could fake, so they are the ones that must be blocked by name here.
    assert.equal(
      result.behaviours.vendorAuthenticated.status,
      'blocked',
      'a client that is not signed in must be blocked, not passed',
    );
    assert.equal(result.legs.handshake.status, 'blocked');
    assert.equal(result.legs.toolUse.status, 'blocked');
    assert.match(
      result.behaviours.vendorAuthenticated.reason,
      /not signed in/i,
      'the reason must say the client is not signed in',
    );
  });

  check('the vendor-asserting legs still declare their source unconditionally', () => {
    for (const leg of ['handshake', 'toolUse']) {
      assert.equal(
        result.legs[leg].source,
        'vendor-client',
        `${leg} must declare vendor-client even when it did not pass — the source is a statement about who produced the evidence, never a reward for passing`,
      );
    }
  });

  check('the archived transcript matches the digest the receipt declares', () => {
    // The whole difference between evidence and assertion: the transcript is a real file that still
    // hashes to what the receipt recorded.
    const path = join(out, result.receipt.vendor.transcriptPath);
    assert.ok(existsSync(path), `transcript missing at ${path}`);
    const digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    assert.equal(
      result.receipt.vendor.transcriptSha256,
      digest,
      'the recorded transcript digest does not match the file on disk',
    );
    for (const leg of CERTIFICATION_LEGS) {
      assert.equal(result.legs[leg].logSha256, digest, `legs.${leg} must point at that same file`);
    }
  });

  check('the archived transcript carries no prompt text and no secret', () => {
    const text = readFileSync(join(out, result.receipt.vendor.transcriptPath), 'utf8');
    // This run never reaches a turn — the install fails — so the strongest claim it can make is the
    // negative one: nothing of the harness's own prompt text is in the archive. The positive claim
    // (a turn WAS issued and logged as a digest) is made by the stubbed run below, where turns exist;
    // asserting it here would be asserting it of a transcript with no turns in it.
    assert.ok(
      !/Use the knowledge-crib MCP server/.test(text),
      'a raw prompt survived into the archived transcript',
    );
    assert.ok(
      !/<prompt:redacted/.test(text),
      'no turn was issued on this path, so a redacted prompt line here would be fabricated',
    );
  });

  check('teardown is scoped to the run workspace, and the receipt names the real host', () => {
    assert.equal(result.receipt.teardown, 'isolated-workspace');
    assert.equal(result.receipt.platform.os, process.platform);
    assert.equal(result.receipt.platform.arch, process.arch);
    assert.equal(
      result.receipt.platform.wsl,
      undefined,
      'a non-WSL host must not carry a wsl flag at all — absent is the native claim, and it is the ' +
        'one under test',
    );
  });

  rmSync(scratch, { recursive: true, force: true });
}

// ─── 3b. the strongest test of honesty: a stub that satisfies every prerequisite ────────────────
// A real tarball installs, the vendor binary resolves, the client is signed in, and every prompt it
// receives exits 0. Nothing left is broken except the client itself — which is exactly the state a
// fabricated certification would be built in. Every leg must still refuse.

process.stdout.write('\n[client-certify] end-to-end: a signed-in stub still cannot certify\n');

let stubbed;
try {
  stubbed = await runEndToEnd({ signedIn: true, stubPackage: true });
} catch (error) {
  failures.push(`the stubbed end-to-end run threw: ${error.message}`);
  process.stderr.write(
    `  FAIL the harness threw instead of writing a receipt\n    ${error.message}\n`,
  );
}

if (stubbed) {
  const { result, out, scratch } = stubbed;

  check('the prerequisites really did succeed, so the refusals below are about the client', () => {
    // Without this the run proves nothing: a cell that failed because the package never installed
    // would look identical from the verdict alone. These two say the environment was sound.
    assert.equal(
      result.behaviours.vendorBinaryResolved.status,
      'pass',
      'the stub vendor binary should have resolved',
    );
    assert.equal(
      result.behaviours.vendorAuthenticated.status,
      'pass',
      'the stub reports being signed in; the preflight must believe it',
    );
  });

  check('a vendor client that exits 0 on every prompt fails the legs it is asserting', () => {
    for (const leg of ['handshake', 'toolUse', 'record', 'restart', 'authorizedResume']) {
      assert.equal(
        result.legs[leg].status,
        'fail',
        `legs.${leg} must fail when the client exits 0 but returns no tool result — an exit status is not a handshake, and a harness that read it as one would certify a stub`,
      );
    }
    assert.notEqual(result.receipt.blockedReason, undefined);
  });

  check('the restart leg refuses a bare exit status, not just a non-zero one', () => {
    // Regression: this leg used to pass on `exit 0` alone, so a stub that printed nothing certified
    // "the vendor client restarted". A restarted client has to have ANSWERED the handoff query.
    assert.equal(result.behaviours.vendorProcessRestarted.status, 'fail');
    assert.match(
      result.behaviours.vendorProcessRestarted.reason,
      /returned no answer/,
      'the restart refusal must name the absent answer, not merely a status',
    );
  });

  check('the legs that cannot be faked refuse by name rather than passing by default', () => {
    // The interruption leg kills the vendor CLIENT. The stub exits before it can be interrupted, and
    // "killing a process that already exited" must come back as a refusal, never as a pass.
    assert.equal(result.legs.interruption.status, 'fail');
    assert.match(
      result.behaviours.vendorProcessInterrupted.reason,
      /exited|not the Claude Code client/,
      'the interruption refusal must name what actually happened',
    );
  });

  check('the shipped installer wrote no config, and that is a failing leg too', () => {
    assert.equal(result.behaviours.configGeneratedByInstaller.status, 'fail');
    assert.match(result.behaviours.configGeneratedByInstaller.reason, /wrote no config/);
  });

  check('no leg at all claims a pass', () => {
    const passed = CERTIFICATION_LEGS.filter((leg) => result.legs[leg].status === 'pass');
    assert.deepEqual(passed, [], 'a stub client certified these legs');
  });

  check('the turns WERE issued, so the refusals above are about their content', () => {
    // This is the assertion the non-tarball run cannot make: there, the install failed and no turn
    // was ever issued, so "the prompt was redacted" was vacuously true of a transcript with no turns.
    const text = readFileSync(join(out, result.receipt.vendor.transcriptPath), 'utf8');
    const issued = text.match(/<prompt:redacted sha256:[0-9a-f]{64}>/g) ?? [];
    assert.ok(
      issued.length >= 4,
      `expected a turn per leg that requires one; found ${issued.length} redacted prompts`,
    );
  });

  check('the archived transcript carries no secret and no raw prompt', () => {
    const text = readFileSync(join(out, result.receipt.vendor.transcriptPath), 'utf8');
    // The prompt is logged as a digest, never as text: the harness mints prompts, so if one of its
    // own sentences survives into the archive, the redaction is not doing its job.
    for (const sentence of [
      'Use the knowledge-crib MCP server',
      'Use the knowledge-crib MCP memory tool',
      'Call the knowledge-crib status tool',
    ]) {
      assert.ok(
        !text.includes(sentence),
        `a raw prompt survived into the archived transcript: ${sentence}`,
      );
    }
    assert.ok(
      /<prompt:redacted sha256:/.test(text),
      'the prompt was not logged as a redacted digest',
    );
  });

  check('the principal markers are recorded as digests, and the marker never leaks as text', () => {
    // The foreign marker is the one string that appears in a prompt AND in an archived output tail,
    // so it is the one that proves the run-marker redaction is actually applied rather than declared.
    const { owner, foreign } = result.receipt.principalMarkers;
    assert.match(
      owner,
      /^sha256:[0-9a-f]{64}$/,
      'the owner principal must be recorded as a digest',
    );
    assert.match(foreign, /^sha256:[0-9a-f]{64}$/, 'the foreign principal must be a digest');
    assert.notEqual(owner, foreign, 'both principals must be distinct');
    const text = readFileSync(join(out, result.receipt.vendor.transcriptPath), 'utf8');
    assert.ok(!text.includes('foreign-certify-'), 'the raw foreign marker leaked into the archive');
  });

  check('the stub receipt still validates against the version-2 contract', () => {
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 2);
    assert.equal(validated.legs.handshake.source, 'vendor-client');
  });

  rmSync(scratch, { recursive: true, force: true });
}

// ─── 4. the driver refusal paths ────────────────────────────────────────────────────────────────

process.stdout.write('\n[client-certify] the CLI refuses what it cannot certify\n');

/** Run the CLI and capture status + output, without letting a non-zero status throw. */
function runCli(args) {
  const probe = spawnSync(process.execPath, [join(HERE, 'client-certify.mjs'), ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return { status: probe.status, out: `${probe.stdout ?? ''}${probe.stderr ?? ''}` };
}

check('an unknown client is refused by name, listing the real ones', () => {
  const { status, out } = runCli(['--client', 'not-a-client', '--package', '/tmp/x.tgz']);
  assert.equal(status, 2, `expected exit 2, got ${status}`);
  assert.match(out, /--client must be one of/);
  for (const id of POLICY_CLIENTS) assert.ok(out.includes(id), `${id} missing from the refusal`);
});

check('a missing --package is refused, because a receipt must bind the bytes it certified', () => {
  const { status, out } = runCli(['--client', 'claude', '--candidate-commit', HEAD]);
  assert.equal(status, 2);
  assert.match(out, /--package <candidate-tarball> is required/);
});

check('a non-HEAD --candidate-commit is refused', () => {
  const other = '0'.repeat(40);
  const { status, out } = runCli([
    '--client',
    'claude',
    '--package',
    join(HERE, 'client-certify.mjs'),
    '--candidate-commit',
    other,
  ]);
  assert.equal(status, 2, `expected exit 2, got ${status}`);
  assert.match(out, /is not HEAD/);
});

check('a short commit is refused, so a receipt can never bind an ambiguous revision', () => {
  const { status, out } = runCli([
    '--client',
    'claude',
    '--package',
    join(HERE, 'client-certify.mjs'),
    '--candidate-commit',
    HEAD.slice(0, 7),
  ]);
  assert.equal(status, 2);
  assert.match(out, /full 40-hex commit/);
});

check('the compatibility wrapper refuses when there is no candidate bundle to certify', () => {
  // It forwards to the real harness; a missing bundle must be a named refusal, not a crash. This
  // host may or may not have built installers, so the wrapper is exercised on the missing-package
  // path it takes when nothing has been built.
  const probe = spawnSync(
    process.execPath,
    [join(HERE, 'client-certify-claude.mjs'), '--out', join(tmpdir(), 'crib-wrapper-test')],
    { encoding: 'utf8', cwd: REPO_ROOT },
  );
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  assert.ok(
    /forwarding to scripts\/client-certify\.mjs --client claude/.test(out) || probe.status === 2,
    `the wrapper must announce the forward or refuse by name; got:\n${out.slice(0, 400)}`,
  );
  assert.ok(
    probe.status === 0 || probe.status === 1 || probe.status === 2,
    `the wrapper must exit with a deliberate status, got ${probe.status}`,
  );
});

check('a WSL host is detected rather than reported as native linux', () => {
  // On darwin this is false by construction; the point is that the function answers with a boolean
  // rather than leaving the field absent, because an ABSENT wsl flag reads as "native".
  assert.equal(typeof isWsl(), 'boolean');
  if (process.platform !== 'linux') assert.equal(isWsl(), false);
});

// ─── verdict ────────────────────────────────────────────────────────────────────────────────────

process.stdout.write('\n');
if (failures.length > 0) {
  process.stderr.write(`client-certify tests FAILED (${failures.length}):\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write('client-certify tests ok\n');
