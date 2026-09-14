/**
 * Tests for the vendor-certification harness.
 *
 * THE HARD PART TO TEST is that this script must produce a receipt which is (a) valid under the
 * version-3 contract, and (b) honest — a cell whose vendor runtime could not actually be exercised
 * comes back UNCERTIFIED with a named reason, never a fabricated pass. The tests below drive the
 * real `certifyCell` against FAKE vendor binaries and a deliberately broken environment, because
 * that is the one path this host can actually reach: on a machine with no signed-in vendor accounts
 * and no native Linux/Windows runner, the honest output of this harness is exactly a blocked,
 * non-certifying receipt. Asserting that it emits one — and that the receipt still validates — is
 * asserting the behaviour that matters most, not a stand-in for it.
 *
 * THE v3 ADDITION is that passing legs are judged from recorded PROTOCOL traffic, not from the
 * words the client printed. That claim is only as good as the two scenarios that pin it: a client
 * that prints every expected word and never spawns a server must fail every leg by name (the v2
 * false positive, rebuilt), and a client that actually speaks the protocol against a shared-journal
 * stub must pass the six protocol-dependent legs with a receipt naming two distinct principals.
 *
 * NO VENDOR ACCOUNT, NO NETWORK, NO REAL PACKAGE: the fake binaries are a few lines of shell and
 * node, the "candidate" is either a file that is not a tarball (so the isolated install fails by
 * design) or a stub package, and the assertions are on the resulting verdict.
 *
 * Run: node scripts/client-certify.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { delimiter, join, resolve } from 'node:path';
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
  buildForeignConfig,
  certifyCell,
  clientSpec,
  commandLineMatches,
  confirmTermination,
  executableCandidates,
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
import { serverCommandSha256 } from './client-protocol-recorder.mjs';
import { POLICY_CLIENTS } from './launch-policy.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const HEAD = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

/** Same digest shape the harness and recorder use, so a re-hash is comparable to the declared one. */
const sha256File = (path) =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

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

// ─── 2b. the recorder wiring: owner and foreign configurations over one shared store ─────────────
// "Create owner and foreign configurations that share the same isolated journal and repository,
// carry different authenticated principal IDs, launch the same installed candidate, use the
// vendor-specific configuration mechanism, and are individually hashed and recorded."

process.stdout.write(
  '\n[client-certify] the recorder wiring builds two principals over one store\n',
);

/** The ctx subset wireProtocolRecorder/buildForeignConfig consume, against fixtures on disk. */
function recorderCtx(dir, name) {
  return {
    configPath: join(dir, name),
    recorderPath: join(HERE, 'client-protocol-recorder.mjs'),
    ownerRecordingPath: join(dir, 'owner-recording.json'),
    foreignRecordingPath: join(dir, 'foreign-recording.json'),
    ownerPrincipal: 'principal:claude-owner',
    foreignPrincipal: 'principal:claude-foreign',
    protocolMarkers: ['certify-abc123', 'foreign-certify-abc123', 'certifiedSymbol', 'intake:'],
  };
}

const fakeCribBin = '/opt/crib-prefix/bin/crib';
const claudeSpec = clientSpec('claude');

function writeJsonFixture(ctx) {
  writeFileSync(
    ctx.configPath,
    `${JSON.stringify(
      {
        mcpServers: {
          'knowledge-crib': {
            command: fakeCribBin,
            args: ['serve', '.'],
            env: {
              KCRIB_MEMORY_DIR: '/tmp/crib-home/memory',
              KCRIB_REGISTRY_DIR: '/tmp/crib-home',
              KCRIB_PRINCIPAL_ID: ctx.ownerPrincipal,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function writeTomlFixture(ctx) {
  // The codex-style managed block the installer writes, plus the env sub-table isolation appends.
  writeFileSync(
    ctx.configPath,
    [
      '# >>> knowledge-crib managed >>>',
      '[mcp_servers.knowledge-crib]',
      `command = ${JSON.stringify(fakeCribBin)}`,
      'args = ["serve", "."]',
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 60',
      '# <<< knowledge-crib managed <<<',
      '',
      '[mcp_servers.knowledge-crib.env]',
      `KCRIB_MEMORY_DIR = ${JSON.stringify('/tmp/crib-home/memory')}`,
      `KCRIB_REGISTRY_DIR = ${JSON.stringify('/tmp/crib-home')}`,
      `KCRIB_PRINCIPAL_ID = ${JSON.stringify(ctx.ownerPrincipal)}`,
      '',
    ].join('\n'),
  );
}

/** Recompute the identity digest over the config's declared server launch, both sides of the wire. */
function declaredServerCommandSha256(config) {
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;
  const server = parsed.mcpServers?.['knowledge-crib'] ?? parsed.servers?.['knowledge-crib'];
  const args = server.args ?? [];
  const at = (flag) => args.indexOf(flag);
  // The wired config launches the recorder, whose own --server/-- argument pair names the real one.
  return serverCommandSha256(args[at('--server') + 1], args.slice(at('--') + 1));
}

check('JSON: the recorder is wired between the client and the candidate, env intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'claude.json');
  writeJsonFixture(ctx);
  const original = wireProtocolRecorder(ctx, claudeSpec, ctx.ownerPrincipal);
  assert.equal(
    original.server,
    fakeCribBin,
    'the original launch must be captured before rewiring',
  );
  assert.deepEqual(original.serverArgs, ['serve', '.']);

  const final = JSON.parse(readFileSync(ctx.configPath, 'utf8'));
  const server = final.mcpServers['knowledge-crib'];
  assert.equal(
    server.command,
    process.execPath,
    'the config must launch node, not the candidate directly',
  );
  assert.equal(server.args[0], ctx.recorderPath, 'the first arg must be the recorder shim');
  const at = (flag) => server.args.indexOf(flag);
  assert.ok(at('--server') !== -1 && server.args[at('--server') + 1] === fakeCribBin);
  assert.ok(at('--record') !== -1 && server.args[at('--record') + 1] === ctx.ownerRecordingPath);
  assert.ok(at('--principal') !== -1 && server.args[at('--principal') + 1] === ctx.ownerPrincipal);
  assert.equal(server.args[at('--markers') + 1], ctx.protocolMarkers.join(','));
  assert.deepEqual(server.args.slice(at('--') + 1), ['serve', '.']);
  assert.equal(
    server.env.KCRIB_PRINCIPAL_ID,
    ctx.ownerPrincipal,
    'the isolation env must survive rewiring',
  );
  assert.equal(server.env.KCRIB_MEMORY_DIR, '/tmp/crib-home/memory');
});

check('JSON: the foreign config swaps principal and recording, and NOTHING else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'claude.json');
  writeJsonFixture(ctx);
  wireProtocolRecorder(ctx, claudeSpec, ctx.ownerPrincipal);
  const ownerFinal = readFileSync(ctx.configPath, 'utf8');
  const foreignText = buildForeignConfig(ctx, claudeSpec, ownerFinal);

  const foreign = JSON.parse(foreignText);
  const server = foreign.mcpServers['knowledge-crib'];
  assert.equal(
    server.env.KCRIB_PRINCIPAL_ID,
    ctx.foreignPrincipal,
    'the principal must be swapped',
  );
  assert.equal(server.env.KCRIB_PRINCIPAL_ID !== ctx.ownerPrincipal, true);
  // The shared stores are the point: both principals work over the SAME journal and repository.
  assert.equal(server.env.KCRIB_MEMORY_DIR, '/tmp/crib-home/memory');
  assert.equal(server.env.KCRIB_REGISTRY_DIR, '/tmp/crib-home');
  assert.ok(
    !foreignText.includes(ctx.ownerPrincipal),
    'the owner principal leaked into the foreign config',
  );
  assert.ok(!foreignText.includes(ctx.ownerRecordingPath), 'the owner recording path leaked');
  const at = (flag) => server.args.indexOf(flag);
  assert.equal(server.args[0], ctx.recorderPath, 'the foreign config still launches the same shim');
  assert.equal(server.args[at('--principal') + 1], ctx.foreignPrincipal);
  assert.equal(server.args[at('--record') + 1], ctx.foreignRecordingPath);

  // Both configurations launch the SAME installed candidate, provable from the configs alone.
  const ownerConfig = JSON.parse(ownerFinal);
  assert.equal(
    declaredServerCommandSha256(ownerConfig),
    declaredServerCommandSha256(foreign),
    'owner and foreign must launch the same server command',
  );
  assert.equal(
    declaredServerCommandSha256(ownerConfig),
    serverCommandSha256(fakeCribBin, ['serve', '.']),
    'the wired config must name the original candidate launch',
  );
});

check('TOML: the managed block is rewired in place, env sub-table preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'toml-config');
  const tomlSpec = { ...claudeSpec, configFormat: 'toml' };
  writeTomlFixture(ctx);
  const original = wireProtocolRecorder(ctx, tomlSpec, ctx.ownerPrincipal);
  assert.equal(original.server, fakeCribBin, 'the TOML original launch must be captured too');

  const final = readFileSync(ctx.configPath, 'utf8');
  assert.ok(
    final.includes(`command = ${JSON.stringify(process.execPath)}`),
    'node must replace the candidate',
  );
  assert.ok(final.includes(ctx.recorderPath), 'the recorder path must appear in args');
  assert.ok(
    final.includes("'--server'") || final.includes('"--server"'),
    'the server flag must be spliced in',
  );
  assert.ok(
    final.includes(JSON.stringify(fakeCribBin).replace(/"/g, '')) || final.includes(fakeCribBin),
  );
  assert.ok(
    final.includes(`KCRIB_MEMORY_DIR = ${JSON.stringify('/tmp/crib-home/memory')}`),
    'the env sub-table must survive',
  );
  assert.ok(
    final.includes(ctx.ownerPrincipal),
    'the owner principal must be present before the swap',
  );
  assert.ok(
    final.includes('[mcp_servers.knowledge-crib.env]'),
    'the env sub-table header must survive',
  );
});

check('TOML: the foreign swap re-principals the managed block only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'toml-config');
  const tomlSpec = { ...claudeSpec, configFormat: 'toml' };
  writeTomlFixture(ctx);
  wireProtocolRecorder(ctx, tomlSpec, ctx.ownerPrincipal);
  const ownerFinal = readFileSync(ctx.configPath, 'utf8');
  const foreignText = buildForeignConfig(ctx, tomlSpec, ownerFinal);
  assert.ok(!foreignText.includes(ctx.ownerPrincipal), 'the owner principal survived the swap');
  assert.ok(
    !foreignText.includes(ctx.ownerRecordingPath),
    'the owner recording path survived the swap',
  );
  assert.ok(foreignText.includes(ctx.foreignPrincipal), 'the foreign principal must be present');
  assert.ok(
    foreignText.includes(ctx.foreignRecordingPath),
    'the foreign recording path must be present',
  );
  assert.ok(
    foreignText.includes(`KCRIB_MEMORY_DIR = ${JSON.stringify('/tmp/crib-home/memory')}`),
    'the shared store must survive',
  );
  assert.ok(
    foreignText.includes('[mcp_servers.knowledge-crib]'),
    'the managed block must remain a block',
  );
});

check('a config with no knowledge-crib entry is refused, in both directions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'claude.json');
  writeFileSync(ctx.configPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  assert.throws(
    () => wireProtocolRecorder(ctx, claudeSpec, ctx.ownerPrincipal),
    /knowledge-crib.* entry/,
  );
  const ownerFinal = readFileSync(ctx.configPath, 'utf8');
  assert.throws(() => buildForeignConfig(ctx, claudeSpec, ownerFinal), /carries no .* entry/);
});

check('TOML without the managed block is refused, not silently skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'toml-config');
  const tomlSpec = { ...claudeSpec, configFormat: 'toml' };
  writeFileSync(ctx.configPath, '[mcp_servers.something-else]\ncommand = "/bin/false"\n');
  assert.throws(
    () => wireProtocolRecorder(ctx, tomlSpec, ctx.ownerPrincipal),
    /managed TOML block/,
  );
});

check('a TOML foreign swap with no owner principal to replace is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-wire-test-'));
  const ctx = recorderCtx(dir, 'toml-config');
  const tomlSpec = { ...claudeSpec, configFormat: 'toml' };
  writeTomlFixture(ctx);
  wireProtocolRecorder(ctx, tomlSpec, ctx.ownerPrincipal);
  const ownerFinal = readFileSync(ctx.configPath, 'utf8')
    .split(ctx.ownerPrincipal)
    .join('principal:somebody-else');
  assert.throws(
    () => buildForeignConfig(ctx, tomlSpec, ownerFinal),
    /does not carry the value to re-principal/,
  );
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
 * The v2 false positive, rebuilt as a regression. This client prints every word the v2 harness
 * word-matched on — the queried id, an intake id, FOUND, PRESENT, CLEAN — and never once launches
 * MCP server the config names. Under v2 it certified every leg; under v3 each leg must refuse by
 * name, because the recordings those legs are judged from do not exist.
 */
function writeWordEchoVendor(dir, name) {
  const path = join(dir, name);
  // The turn argv is `-p <prompt> --mcp-config …`, so $2 is the prompt. Case order matters: the
  // plant prompt contains BOTH "twice" and "intake_create", and "twice" must win.
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "9.9.9 (word-echo vendor)"; exit 0;;',
      '  auth) echo \'{"loggedIn":true}\'; exit 0;;',
      'esac',
      'prompt=$2',
      'case "$prompt" in',
      '  *"status tool"*) echo waiting; exit 0;;',
      '  *"query tool"*) echo "certifiedSymbol"; exit 0;;',
      '  *twice*) echo "PRESENT"; exit 0;;',
      '  *"intake_create"*) echo "intake:never-created"; exit 0;;',
      '  *"FOUND"*) echo "FOUND"; exit 0;;',
      '  *"LEAKED"*) echo "CLEAN"; exit 0;;',
      '  *) echo "{}"; exit 0;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A vendor client that actually speaks MCP. It reads the config the harness wired, launches the
 * server entry that config names (the recorder, in a certified run), and invokes the tools the
 * prompts ask for over newline-delimited JSON-RPC. It is a fixture on the CLIENT side of the wire,
 * so every leg the harness judges from protocol traffic is exercised for real — including the
 * foreign principal's plant, which runs through the swapped-in foreign config like any real
 * client would.
 */
function writeCooperatingVendor(dir, name) {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      '',
      'const args = process.argv.slice(2);',
      "const say = (text) => { process.stdout.write(String(text) + '\\n'); };",
      '',
      "if (args[0] === '--version') { say('9.9.9 (cooperating vendor)'); process.exit(0); }",
      "if (args[0] === 'auth') { say('{\"loggedIn\":true}'); process.exit(0); }",
      '',
      "const promptIndex = args.indexOf('-p');",
      "const configIndex = args.indexOf('--mcp-config');",
      "if (promptIndex === -1 || configIndex === -1) { say('{}'); process.exit(0); }",
      'const prompt = args[promptIndex + 1];',
      'const configPath = args[configIndex + 1];',
      '',
      'let server = null;',
      'try {',
      "  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
      "  server = (parsed.mcpServers || parsed.servers || {})['knowledge-crib'] || null;",
      '} catch {',
      '  server = null;',
      '}',
      "if (!server) { say('{}'); process.exit(0); }",
      '',
      'const child = spawn(server.command, server.args || [], {',
      '  env: Object.assign({}, process.env, server.env || {}),',
      "  stdio: ['pipe', 'pipe', 'inherit'],",
      '});',
      '',
      'let nextId = 1;',
      'const pending = new Map();',
      "let outBuffer = '';",
      "child.stdout.setEncoding('utf8');",
      "child.stdout.on('data', (chunk) => {",
      '  outBuffer += chunk;',
      "  let newline = outBuffer.indexOf('\\n');",
      '  while (newline !== -1) {',
      '    const line = outBuffer.slice(0, newline);',
      '    outBuffer = outBuffer.slice(newline + 1);',
      "    newline = outBuffer.indexOf('\\n');",
      '    if (line.trim().length === 0) continue;',
      '    let message;',
      '    try { message = JSON.parse(line); } catch { continue; }',
      '    if (message.id === undefined || message.id === null) continue;',
      '    const waiter = pending.get(String(message.id));',
      '    if (!waiter) continue;',
      '    pending.delete(String(message.id));',
      '    waiter(message.result === undefined ? null : message.result);',
      '  }',
      '});',
      '',
      'const call = (method, params) =>',
      '  new Promise((resolve) => {',
      '    const id = nextId;',
      '    nextId += 1;',
      '    pending.set(String(id), resolve);',
      "    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');",
      '  });',
      '',
      'const textOf = (result) =>',
      "  Array.isArray(result && result.content) && typeof result.content[0].text === 'string'",
      '    ? result.content[0].text',
      '    : JSON.stringify(result);',
      '',
      'const pairsOf = (text) => {',
      '  const pairs = {};',
      '  for (const match of text.matchAll(/([A-Za-z_]+)="([^"]*)"/g)) pairs[match[1]] = match[2];',
      '  return pairs;',
      '};',
      '',
      'const firstQuotedAfter = (text, needle) => {',
      '  const at = text.indexOf(needle);',
      '  if (at === -1) return null;',
      '  const match = /"([^"]*)"/.exec(text.slice(at + needle.length));',
      '  return match ? match[1] : null;',
      '};',
      '',
      '(async () => {',
      "  await call('initialize', {",
      "    protocolVersion: '2025-06-18',",
      '    capabilities: {},',
      "    clientInfo: { name: 'cooperating-vendor', version: '9.9.9' },",
      '  });',
      '',
      "  if (prompt.includes('status tool')) {",
      '    // The interrupt leg needs the client still alive when the harness comes to kill it:',
      '    // answer the status call, then hold the process open until something interrupts it.',
      "    const result = await call('tools/call', { name: 'status', arguments: { op: 'health' } });",
      '    say(textOf(result));',
      '    child.stdin.end();',
      '    setInterval(() => {}, 60000);',
      '    return;',
      '  }',
      '',
      "  if (prompt.includes('query tool')) {",
      "    const q = firstQuotedAfter(prompt, 'q=') || 'certifiedSymbol';",
      "    const result = await call('tools/call', { name: 'query', arguments: { q } });",
      '    say(textOf(result));',
      "  } else if (prompt.includes('twice')) {",
      '    const pairs = pairsOf(prompt);',
      "    await call('tools/call', { name: 'memory', arguments: {",
      "      op: 'intake_create',",
      '      original: pairs.original,',
      '      summary: pairs.summary,',
      '      outcome: pairs.outcome,',
      '      phase: pairs.phase,',
      '      actor: pairs.actor,',
      '    } });',
      "    const handoff = await call('tools/call', { name: 'memory', arguments: { op: 'handoff' } });",
      "    say(textOf(handoff).includes(pairs.original || String.fromCharCode(0)) ? 'PRESENT' : 'ABSENT');",
      "  } else if (prompt.includes('intake_create')) {",
      '    const pairs = pairsOf(prompt);',
      "    const result = await call('tools/call', { name: 'memory', arguments: {",
      "      op: 'intake_create',",
      '      original: pairs.original,',
      '      summary: pairs.summary,',
      '      outcome: pairs.outcome,',
      '      phase: pairs.phase,',
      '      actor: pairs.actor,',
      '    } });',
      '    say(textOf(result));',
      "  } else if (prompt.includes('FOUND')) {",
      "    const tag = firstQuotedAfter(prompt, 'contains ');",
      "    const result = await call('tools/call', { name: 'memory', arguments: { op: 'handoff' } });",
      "    say(tag && textOf(result).includes(tag) ? 'FOUND' : 'MISSING');",
      "  } else if (prompt.includes('LEAKED')) {",
      "    const marker = firstQuotedAfter(prompt, 'contains ');",
      "    const result = await call('tools/call', { name: 'memory', arguments: { op: 'handoff' } });",
      "    say(marker && textOf(result).includes(marker) ? 'LEAKED' : 'CLEAN');",
      '  } else {',
      "    say('{}');",
      '  }',
      '',
      '  child.stdin.end();',
      '  const giveUp = setTimeout(() => process.exit(0), 5000);',
      "  child.on('exit', () => { clearTimeout(giveUp); process.exit(0); });",
      '})();',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A vendor client that MASQUERADES. It answers --version and the sign-in probe exactly like a real
 * client, and when the interrupt prompt arrives it opens a REAL MCP session through a helper child —
 * but the process that stays alive at the launched pid is `sleep`: the script execs into it, so the
 * target's own image no longer names the vendor path. The protocol activity is genuine (the
 * recorder records it, which is what opens the observed-activity gate), yet no node of the live
 * tree IS the vendor client. A harness that identified its target by basename, or that certified
 * any killed tree, would pass this client; one that matches the resolved executable path against
 * the full-argv tree must refuse — and the receipt must still show the kill LANDED, because the
 * refusal is about identity, not about the signal failing.
 */
function writeMasqueradingVendor(dir, name) {
  const helperPath = join(dir, 'masquerade-helper.js');
  writeFileSync(
    helperPath,
    [
      '#!/usr/bin/env node',
      '// The MCP half of the masquerade: a REAL session against the server the config names (the',
      '// recorder, in a certified run), so protocol activity is genuine. The masquerade lives in the',
      '// process table, not the protocol: the client script execs into `sleep`, so the vendor path',
      '// only ever appears on THIS helper — a child process, not the client.',
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      '',
      'const configPath = process.argv[2];',
      'if (!configPath) process.exit(0);',
      'let server = null;',
      'try {',
      "  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));",
      "  server = (parsed.mcpServers || parsed.servers || {})['knowledge-crib'] || null;",
      '} catch {',
      '  server = null;',
      '}',
      'if (!server) process.exit(0);',
      '',
      'const child = spawn(server.command, server.args || [], {',
      '  env: Object.assign({}, process.env, server.env || {}),',
      "  stdio: ['pipe', 'pipe', 'inherit'],",
      '});',
      '// The session must complete, so drain the server side; the recorder needs its bytes flowing.',
      "child.stdout.setEncoding('utf8');",
      "child.stdout.on('data', () => {});",
      'child.stdin.write(',
      '  JSON.stringify({',
      "    jsonrpc: '2.0',",
      '    id: 1,',
      "    method: 'initialize',",
      '    params: {',
      "      protocolVersion: '2025-06-18',",
      '      capabilities: {},',
      "      clientInfo: { name: 'masquerading-vendor', version: '9.9.9' },",
      '    },',
      "  }) + '\\n');",
      '// Stay alive until the tree is killed: the point is a live session for the harness to interrupt.',
      "child.on('exit', () => process.exit(0));",
      'setInterval(() => {}, 60000);',
      '',
    ].join('\n'),
  );
  chmodSync(helperPath, 0o755);

  const path = join(dir, name);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      '# The client half of the masquerade: a real vendor surface everywhere except the one place the',
      '# interruption leg cares about — the process that survives at the launched pid.',
      'if [ "$1" = "--version" ]; then',
      '  echo "9.9.9 (masquerading vendor)"',
      '  exit 0',
      'fi',
      'if [ "$1" = "auth" ]; then',
      '  echo \'{"loggedIn":true}\'',
      '  exit 0',
      'fi',
      'case "$*" in',
      '  *"status tool"*)',
      '    # The interrupt prompt: open the session in a child, then replace this image with sleep so',
      '    # no live process at the target pid names the vendor path.',
      '    config=',
      '    prev=',
      '    for arg in "$@"; do',
      '      if [ "$prev" = "--mcp-config" ]; then',
      '        config=$arg',
      '      fi',
      '      prev=$arg',
      '    done',
      '    if [ -n "$config" ]; then',
      '      node "$(dirname "$0")/masquerade-helper.js" "$config" &',
      '    fi',
      '    exec sleep 300',
      '    ;;',
      '  *)',
      "    echo '{}'",
      '    exit 0',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A crib stub that SERVES the MCP protocol — the server side of the fake wire. It installs a config
 * naming itself, and in `serve` mode it answers newline-delimited JSON-RPC like the real server
 * would: initialize, query, status, and the two memory ops the certification prompts exercise. Its
 * store is keyed by KCRIB_PRINCIPAL_ID, so an intake created under the foreign principal is
 * genuinely invisible to the owner's handoff — the exclusion boundary the v3 scenario proves is
 * real, not asserted.
 */
function servingCribSource() {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '',
    'const args = process.argv.slice(2);',
    '',
    "if (args[0] === 'mcp' && args[1] === 'install') {",
    '  // The vendor-specific configuration mechanism the installer step exercises: write the config',
    '  // the harness expects, naming the exact --bin it was handed.',
    '  const binFlag = args.indexOf("--bin");',
    '  const bin = binFlag !== -1 ? args[binFlag + 1] : process.argv[1];',
    '  const project = args[args.length - 1];',
    '  fs.mkdirSync(project, { recursive: true });',
    '  fs.writeFileSync(',
    "    path.join(project, '.mcp.json'),",
    "    JSON.stringify({ mcpServers: { 'knowledge-crib': { command: bin, args: ['serve', '.'], env: {} } } }, null, 2) + '\\n',",
    '  );',
    '  process.exit(0);',
    '}',
    '',
    "if (args[0] === 'index' || (args[0] === 'memory' && args[1] === 'init')) process.exit(0);",
    '',
    "if (args[0] !== 'serve') process.exit(0);",
    '',
    "const principal = process.env.KCRIB_PRINCIPAL_ID || 'unknown-principal';",
    "const storePath = path.join(process.env.KCRIB_MEMORY_DIR || '.', 'stub-store.json');",
    '',
    'const readStore = () => {',
    '  try {',
    "    return JSON.parse(fs.readFileSync(storePath, 'utf8'));",
    '  } catch {',
    '    return {};',
    '  }',
    '};',
    '',
    'const respond = (id, result) => {',
    `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');`,
    '};',
    '',
    'const textResult = (id, text) => respond(id, { content: [{ type: "text", text }] });',
    '',
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  let newline = buffer.indexOf('\\n');",
    '  while (newline !== -1) {',
    '    const line = buffer.slice(0, newline);',
    '    buffer = buffer.slice(newline + 1);',
    "    newline = buffer.indexOf('\\n');",
    '    if (line.trim().length === 0) continue;',
    '    let message;',
    '    try { message = JSON.parse(line); } catch { continue; }',
    '    if (message.id === undefined || message.id === null) continue;',
    "    if (message.method === 'initialize') {",
    '      respond(message.id, {',
    `        sessionId: 'stub-' + principal,`,
    "        protocolVersion: '2025-06-18',",
    '        capabilities: {},',
    "        serverInfo: { name: 'knowledge-crib', version: '0.1.0' },",
    '      });',
    '      continue;',
    '    }',
    "    if (message.method !== 'tools/call') {",
    '      respond(message.id, { content: [{ type: "text", text: "unsupported method" }] });',
    '      continue;',
    '    }',
    '    const tool = message.params && message.params.name;',
    '    const params = (message.params && message.params.arguments) || {};',
    "    if (tool === 'query') {",
    `      textResult(message.id, 'first hit: ' + (params.q || '') + ' (certifiedSymbol verified)');`,
    '      continue;',
    '    }',
    "    if (tool === 'status') {",
    '      textResult(message.id, JSON.stringify({ op: params.op, status: "ok" }));',
    '      continue;',
    '    }',
    "    if (tool === 'memory') {",
    "      if (params.op === 'intake_create') {",
    '        const store = readStore();',
    '        const mine = store[principal] || (store[principal] = []);',
    '        mine.push({',
    '          original: params.original,',
    '          summary: params.summary,',
    '          outcome: params.outcome,',
    '          phase: params.phase,',
    '          actor: params.actor,',
    '        });',
    '        fs.mkdirSync(path.dirname(storePath), { recursive: true });',
    "        fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\\n');",
    `        textResult(message.id, 'created intake:' + mine.length + ' original=' + params.original + ' summary=' + params.summary);`,
    '        continue;',
    '      }',
    "      if (params.op === 'handoff') {",
    '        const mine = readStore()[principal] || [];',
    '        textResult(message.id,',
    `          'handoff: ' + mine.length + ' intakes: ' +`,
    `            mine.map((record) => 'intake original=' + record.original + ' summary=' + record.summary).join(' | '));`,
    '        continue;',
    '      }',
    `      textResult(message.id, 'memory: unsupported op ' + params.op);`,
    '      continue;',
    '    }',
    `    textResult(message.id, 'unknown tool ' + tool);`,
    '  }',
    '});',
    "process.stdin.on('end', () => process.exit(0));",
    '',
  ].join('\n');
}

/**
 * A real, installable tarball whose `crib` binary exits 0 and does nothing else — or, with
 * `{ serve: true }`, one that answers the MCP protocol like the real server would.
 *
 * This is the strongest available test of the harness's honesty. Everything a cell needs in order to
 * be certifiable succeeds here: the package installs, `crib` resolves, the vendor client is signed in
 * and exits 0 on every prompt it is handed. If the harness could be satisfied by a stub, this run
 * would come back RUNTIME-VERIFIED — and a client that prints nothing is not a client that reached
 * the MCP server. So the assertion is that it still FAILS, leg by leg, with a named reason.
 */
function makeStubTarball(dir, { serve = false } = {}) {
  const pkg = join(dir, 'stub-package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: 'knowledge-crib', version: '0.1.0', bin: { crib: './crib.js' } }, null, 2)}\n`,
  );
  const crib = join(pkg, 'crib.js');
  writeFileSync(crib, serve ? servingCribSource() : '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(crib, 0o755);
  execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: pkg, stdio: 'pipe' });
  const tarball = join(dir, 'knowledge-crib-0.1.0.tgz');
  assert.ok(existsSync(tarball), `npm pack produced no tarball at ${tarball}`);
  return tarball;
}

async function runEndToEnd({
  signedIn,
  stubPackage = false,
  serve = false,
  vendor = 'fake',
  activityTimeoutMs = 20_000,
  terminationTimeoutMs = 5_000,
}) {
  const scratch = mkdtempSync(join(tmpdir(), 'crib-certify-test-'));
  const bin = join(scratch, 'bin');
  const out = join(scratch, 'receipts');
  const packageDir = join(scratch, 'pkg');
  mkdirSync(bin, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  if (vendor === 'wordEcho') writeWordEchoVendor(bin, 'claude');
  else if (vendor === 'cooperating') writeCooperatingVendor(bin, 'claude');
  else if (vendor === 'masquerading') writeMasqueradingVendor(bin, 'claude');
  else writeFakeVendor(bin, 'claude', { signedIn });
  // Two candidate shapes, and the difference between them is the point of having both. Without a
  // tarball the install fails and the run never reaches a turn — which is how a real host with no
  // package behaves, and the receipt must say so rather than throwing. With one, every prerequisite
  // succeeds and the run reaches every leg, so the legs themselves are what must refuse.
  let fakePackage;
  if (stubPackage) {
    fakePackage = makeStubTarball(packageDir, { serve });
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
      // The real run waits minutes for observed session activity and termination; the same code
      // paths run in seconds here, which is the only way the fixture legs stay testable.
      activityTimeoutMs,
      terminationTimeoutMs,
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
    assert.equal(onDisk.formatVersion, 3, 'on-disk receipt must be version 3');
    assert.equal(onDisk.client.driverVersion, DRIVER_VERSION);
  });

  check('the receipt VALIDATES against the version-3 contract', () => {
    // It must validate even though it certifies nothing: a blocked receipt that cannot be loaded is
    // indistinguishable from a missing cell, and the decision needs to name it.
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 3);
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

  check('the stub receipt still validates against the version-3 contract', () => {
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 3);
    assert.equal(validated.legs.handshake.source, 'vendor-client');
  });

  rmSync(scratch, { recursive: true, force: true });
}

// ─── 3c. the v2 false positive, rebuilt: word-echoing must certify nothing ─────────────────────────
// The v2 harness passed a leg when the right word appeared in an exit-0 turn. This client prints
// every one of those words — the queried id, an intake id, FOUND, PRESENT, CLEAN — and never once
// launches the server its config names. Under v3 every protocol-dependent leg must refuse BY NAME,
// while the prerequisites pass, proving the refusals are about the missing wire and nothing else.

process.stdout.write('\n[client-certify] a word-echoing client certifies nothing under v3\n');

let wordEchoRun;
try {
  wordEchoRun = await runEndToEnd({
    signedIn: true,
    stubPackage: true,
    serve: true,
    vendor: 'wordEcho',
  });
} catch (error) {
  failures.push(`word-echo run threw: ${error.message}`);
  process.stderr.write(
    `  FAIL the word-echo run threw instead of writing a receipt\n    ${error.message}\n`,
  );
}

if (wordEchoRun) {
  const { result, out, scratch } = wordEchoRun;

  check('the word-echo run has every prerequisite, so its refusals are about the wire', () => {
    assert.equal(result.behaviours.vendorBinaryResolved.status, 'pass');
    assert.equal(result.behaviours.vendorAuthenticated.status, 'pass');
    assert.equal(result.behaviours.configGeneratedByInstaller.status, 'pass');
    assert.equal(result.behaviours.configTargetsInstalledCandidate.status, 'pass');
  });

  check('every protocol-dependent leg refuses the echoed word by name', () => {
    const expected = {
      handshake: /a printed word is not a handshake/,
      toolUse: /no tool result returned to the vendor client/,
      record: /a printed id is not a record/,
      restart: /a printed answer is not a restarted session/,
      authorizedResume: /a printed word is not a recovered session/,
      foreignPrincipalExclusion: /never exercised on the wire/,
    };
    for (const [leg, pattern] of Object.entries(expected)) {
      assert.equal(result.legs[leg].status, 'fail', `${leg} did not fail`);
      assert.match(
        result.legs[leg].detail,
        pattern,
        `${leg} must name the protocol gap, not the printed word`,
      );
    }
  });

  check('a client that never launches a server cannot pass the interrupt leg either', () => {
    assert.equal(result.legs.interruption.status, 'fail');
    assert.match(
      result.legs.interruption.detail,
      /exited \(0\) before it could be interrupted/,
      'the interruption refusal must name the pre-kill exit',
    );
  });

  check('only the configuration leg passes, and no recording exists to appeal to', () => {
    const passed = CERTIFICATION_LEGS.filter((leg) => result.legs[leg].status === 'pass');
    assert.deepEqual(
      passed,
      ['configuration'],
      `a word-echoing client passed: ${passed.join(', ')}`,
    );
    // No server was ever launched, so no recorder ever ran: the null recordings ARE the finding.
    assert.equal(
      result.receipt.protocol.ownerRecording,
      null,
      'an owner recording exists without a session',
    );
    assert.equal(
      result.receipt.protocol.foreignRecording,
      null,
      'a foreign recording exists without a session',
    );
  });

  check('the word-echo receipt still validates against the version-3 contract', () => {
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 3);
  });

  rmSync(scratch, { recursive: true, force: true });
}

// ─── 3d. the real shared-journal scenario: two principals, one store, on the wire ──────────────────
// The positive control for the whole v3 design. A client that actually speaks MCP runs against a
// stub server whose store is keyed by principal, over one shared journal: the six protocol legs
// must PASS, each judged from recorded protocol traffic, and the receipt must name two distinct
// principals whose configurations hash differently but launch the same candidate.

process.stdout.write(
  '\n[client-certify] a protocol-speaking client proves the shared-journal boundary\n',
);

let cooperatingRun;
try {
  cooperatingRun = await runEndToEnd({
    signedIn: true,
    stubPackage: true,
    serve: true,
    vendor: 'cooperating',
  });
} catch (error) {
  failures.push(`cooperating run threw: ${error.message}`);
  process.stderr.write(
    `  FAIL the cooperating run threw instead of writing a receipt\n    ${error.message}\n`,
  );
}

if (cooperatingRun) {
  const { result, out, scratch } = cooperatingRun;

  check('the six protocol-dependent legs PASS, each with protocol references', () => {
    for (const leg of [
      'handshake',
      'toolUse',
      'record',
      'restart',
      'authorizedResume',
      'foreignPrincipalExclusion',
    ]) {
      assert.equal(
        result.legs[leg].status,
        'pass',
        `${leg} did not pass against the speaking client`,
      );
      assert.ok(
        Array.isArray(result.legs[leg].protocol) && result.legs[leg].protocol.length > 0,
        `${leg} passed without protocol references`,
      );
    }
  });

  check('the exclusion leg cites BOTH sides of the wire, owner and foreign', () => {
    const cited = new Set(
      result.legs.foreignPrincipalExclusion.protocol.map((ref) => ref.recording),
    );
    assert.ok(cited.has('foreign'), 'the exclusion pass never cited the foreign recording');
    assert.ok(cited.has('owner'), 'the exclusion pass never cited the owner recording');
  });

  check('the receipt names two distinct principals over one shared store and one candidate', () => {
    const receipt = result.receipt;
    assert.equal(receipt.formatVersion, 3);
    const { owner, foreign } = receipt.configurations;
    assert.ok(owner && foreign, 'both configurations must be recorded');
    assert.notEqual(
      owner.principalSha256,
      foreign.principalSha256,
      'owner and foreign must carry different principal digests',
    );
    assert.equal(owner.principalSha256, receipt.principalMarkers.owner);
    assert.deepEqual(
      owner.stores,
      foreign.stores,
      'the two principals must share the SAME journal and repository',
    );
    assert.equal(
      owner.serverCommandSha256,
      foreign.serverCommandSha256,
      'both configurations must launch the same server command',
    );
    assert.ok(owner.serverCommandSha256, 'the server command digest must be recorded');
    assert.notEqual(
      owner.sha256,
      foreign.sha256,
      'the two configs must hash differently (principal differs)',
    );
  });

  check('both recordings are archived, re-hashable, and attributed to their principals', () => {
    const receipt = result.receipt;
    for (const [side, configuration] of [
      ['ownerRecording', receipt.configurations.owner],
      ['foreignRecording', receipt.configurations.foreign],
    ]) {
      const entry = receipt.protocol[side];
      assert.ok(entry, `${side} was not archived`);
      const archivedPath = join(out, entry.path);
      assert.ok(existsSync(archivedPath), `the archived ${side} is missing at ${entry.path}`);
      assert.equal(
        sha256File(archivedPath),
        entry.sha256,
        `the archived ${side} does not match the digest the receipt declares`,
      );
      const recording = JSON.parse(readFileSync(archivedPath, 'utf8'));
      assert.equal(
        recording.principalSha256,
        configuration.principalSha256,
        `${side} must be attributed to its principal's digest`,
      );
      assert.equal(
        recording.serverCommandSha256,
        configuration.serverCommandSha256,
        `${side} must name the same server command its configuration launches`,
      );
      assert.ok(recording.operations.length > 0, `${side} recorded no protocol traffic`);
    }
  });

  check('every leg passes, and the interruption receipt proves the intended process died', () => {
    // Full-argv identity makes the node-shebang fixture identifiable — its command line names the
    // resolved vendor path — so the interruption leg runs for real on this host: the vendor client
    // is matched in the tree, signalled, and its termination CONFIRMED, and the receipt archives
    // that proof instead of assuming it.
    const notPassed = CERTIFICATION_LEGS.filter((leg) => result.legs[leg].status !== 'pass');
    assert.deepEqual(notPassed, [], `unexpected non-passing legs: ${notPassed.join(', ')}`);
    assert.equal(
      result.receipt.blockedReason,
      undefined,
      'an all-pass receipt must not carry a blockedReason',
    );
    const interrupted = result.receipt.vendor.interruptedProcess;
    assert.ok(interrupted, 'the receipt must archive interruptedProcess evidence');
    assert.ok(Number.isInteger(interrupted.pid), 'the interrupted pid must be an integer');
    assert.equal(interrupted.killed, true, 'the kill signal must be confirmed delivered');
    assert.equal(
      interrupted.terminated,
      true,
      'termination must be confirmed, never assumed from a signal',
    );
    assert.ok(
      Array.isArray(interrupted.tree) && interrupted.tree.length > 0,
      'the killed process tree must be archived',
    );
    assert.match(
      interrupted.verifiedCommand,
      /<prompt:redacted /,
      'the archived command line must carry the redacted prompt, not the prompt itself',
    );
    assert.ok(
      !interrupted.verifiedCommand.includes('status tool'),
      'the interrupt prompt must not survive into the archived command line',
    );
  });

  check('the shared-journal receipt validates against the version-3 contract', () => {
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 3);
  });

  check('no principal string or fixture marker survives into any archived artifact', () => {
    const receiptJson = JSON.stringify(result.receipt);
    const transcript = readFileSync(join(out, result.receipt.vendor.transcriptPath), 'utf8');
    for (const text of [receiptJson, transcript]) {
      assert.ok(!text.includes('principal:claude-owner'), 'the raw owner principal leaked');
      assert.ok(!text.includes('principal:claude-foreign'), 'the raw foreign principal leaked');
      assert.ok(!/foreign-certify-[0-9a-f]+/.test(text), 'the raw foreign marker leaked');
    }
  });

  rmSync(scratch, { recursive: true, force: true });
}

// ─── 3e. native launch, process identity, and the masquerading client ────────────────────────────
// The Task-6 launch regressions. Three of the plan's named cases are already pinned above — early
// process exit (§3c: the client exits 0 before it could be interrupted), restart without a session
// (§3b: "returned no answer"), and failed authentication (§3: "not signed in") — so this section
// covers the rest: PATH resolution through hostile directory names, a missing binary, the Windows
// launcher shims, full-argv process identity, an honest kill, and the client whose MCP session
// lives in a CHILD process while the launched image is no longer the vendor.

process.stdout.write('\n[client-certify] native launch and process identity\n');

check('whichSync resolves a binary through a PATH directory with spaces and Unicode', () => {
  // The old harness delegated this to `which`; the Node walk must not be worse than the shell at
  // the one thing shells are good at, and PATH entries with spaces and non-ASCII bytes are common.
  const dir = join(tmpdir(), 'crib chemin certifié – tâche');
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, 'claude');
  writeFileSync(binPath, '#!/bin/sh\necho 9.9.9\n');
  chmodSync(binPath, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}${delimiter}${originalPath}`;
    assert.equal(whichSync('claude'), binPath);
    // resolveBinary must pass through the same PATH walk and probe the resolved absolute file.
    const resolved = resolveBinary(clientSpec('claude'));
    assert.equal(resolved.status, 'pass');
    assert.equal(resolved.resolvedPath, binPath);
    assert.equal(resolved.version, '9.9.9');
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

check('resolveBinary refuses by name when no vendor executable is on PATH', () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = tmpdir();
    const resolved = resolveBinary(clientSpec('claude'));
    assert.equal(resolved.status, 'blocked');
    assert.match(resolved.reason, /no Claude Code executable found on PATH/);
  } finally {
    process.env.PATH = originalPath;
  }
});

check('a Windows .cmd launcher is invoked through cmd.exe, never a shell', () => {
  const launch = launchableCommand('C:\\Tools\\crib.cmd', ['-p', 'x'], 'win32');
  assert.deepEqual(launch, {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'C:\\Tools\\crib.cmd', '-p', 'x'],
  });
  // CVE-2024-27964: a .cmd file is interpreted by cmd.exe and Node cannot exec it directly — and
  // `shell: true` would re-parse every argument into an injection surface. The /c form with each
  // argument as its own argv element is the one that does neither. Everything else launches as
  // itself, on every platform.
  assert.deepEqual(launchableCommand('C:\\Tools\\claude.exe', ['-p'], 'win32'), {
    command: 'C:\\Tools\\claude.exe',
    args: ['-p'],
  });
  assert.deepEqual(launchableCommand('/usr/local/bin/claude', ['-p'], 'linux'), {
    command: '/usr/local/bin/claude',
    args: ['-p'],
  });
});

check('executableCandidates enumerates a bare name the way the Windows loader would', () => {
  assert.deepEqual(executableCandidates('claude', 'win32', '.COM;.EXE;.CMD'), [
    'claude',
    'claude.com',
    'claude.exe',
    'claude.cmd',
  ]);
  // A name that already carries a PATHEXT extension, or a path separator, is not a PATH search.
  assert.deepEqual(executableCandidates('claude.cmd', 'win32', '.COM;.EXE;.CMD'), ['claude.cmd']);
  assert.deepEqual(executableCandidates('bin\\claude', 'win32'), ['bin\\claude']);
  assert.deepEqual(executableCandidates('bin/claude', 'linux'), ['bin/claude']);
  // Non-Windows never appends extensions to a bare name.
  assert.deepEqual(executableCandidates('claude', 'linux'), ['claude']);
});

check('commandLineMatches identifies a process by its full executable path in argv', () => {
  // The whole point of full-argv identity: a Node-launched CLI shows as `node /path/claude …`, and
  // the resolved path is the only honest needle. A basename would match anything; a merely similar
  // path must not count.
  assert.equal(commandLineMatches('node /x/bin/claude -p hi', '/x/bin/claude'), true);
  assert.equal(commandLineMatches('sleep 300', '/x/bin/claude'), false);
  assert.equal(commandLineMatches('node /x/other/claude -p hi', '/x/bin/claude'), false);
  assert.equal(commandLineMatches(undefined, '/x/bin/claude'), false);
});

// confirmTermination is async, so the process probes run at top level — this file already runs its
// e2e scenarios under top-level await — and report through check() like every other case.
let live = null;
try {
  const LIVE_MARK = 'crib-live-process-probe';
  live = spawn(process.execPath, ['-e', `setInterval(() => {}, 60000) /* ${LIVE_MARK} */`], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 500));
  check('a live process is visible in its own process tree with its full argv', () => {
    assert.equal(processAlive(live.pid), true);
    const tree = processTree(live.pid);
    assert.ok(Array.isArray(tree) && tree.length > 0, 'no tree was produced for a live pid');
    assert.equal(tree[0].pid, live.pid, 'the tree root must be the target pid');
    assert.match(
      tree[0].command ?? '',
      new RegExp(LIVE_MARK),
      'the tree root must carry the full argv, not a basename',
    );
  });
  const signalled = killProcessTree(live.pid);
  const confirmed = await confirmTermination(live.pid, 5_000);
  check('killProcessTree signals a live tree and confirmTermination confirms its death', () => {
    assert.equal(signalled, true, 'a live process must be signalled');
    assert.equal(confirmed, true, 'a killed process must be confirmed dead');
    assert.equal(processAlive(live.pid), false, 'the pid must be gone after the confirmed kill');
  });
} catch (error) {
  failures.push(`live-process probe: ${error.message}`);
  process.stderr.write(`  FAIL the live-process probe threw\n    ${error.message}\n`);
} finally {
  if (live?.pid && processAlive(live.pid)) killProcessTree(live.pid);
}

try {
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const signalled = killProcessTree(dead.pid);
  const confirmed = await confirmTermination(dead.pid, 1_000);
  check('an already-dead pid cannot be signalled, but its death confirms immediately', () => {
    assert.ok(Number.isInteger(dead.pid), 'spawnSync must report the child pid');
    assert.equal(signalled, false, 'killProcessTree must not claim a kill on a dead pid');
    assert.equal(confirmed, true, 'an already-dead pid confirms as terminated');
  });
} catch (error) {
  failures.push(`dead-pid probe: ${error.message}`);
  process.stderr.write(`  FAIL the dead-pid probe threw\n    ${error.message}\n`);
}

// ─── 3f. the masquerading client: the kill lands on a child, never on the vendor ─────────────────
// The MCP-child-only termination case. Every prerequisite succeeds, the protocol session is REAL
// (the recorder observes it, so the observed-activity gate opens), and the process tree the harness
// kills really dies — but the launched image exec'd into `sleep` and only a CHILD ever spoke the
// protocol. An interruption leg that certified this run would certify killing a subprocess as
// "interrupting the vendor client"; the identity refusal is the one defence against it.

process.stdout.write(
  '\n[client-certify] an MCP-child masquerade cannot certify as an interruption\n',
);

let masqueradingRun;
try {
  masqueradingRun = await runEndToEnd({
    signedIn: true,
    stubPackage: true,
    serve: true,
    vendor: 'masquerading',
  });
} catch (error) {
  failures.push(`masquerading run threw: ${error.message}`);
  process.stderr.write(
    `  FAIL the masquerading run threw instead of writing a receipt\n    ${error.message}\n`,
  );
}

if (masqueradingRun) {
  const { result, out, scratch } = masqueradingRun;

  check('the masquerading client is refused by IDENTITY, not by a failed kill', () => {
    assert.equal(result.legs.interruption.status, 'fail', 'the masquerade was certified');
    assert.match(
      result.legs.interruption.detail,
      /showed no .* client/,
      'the refusal must name the identity gap',
    );
    const interrupted = result.receipt.vendor.interruptedProcess;
    assert.ok(interrupted, 'the refused kill must still archive its evidence');
    assert.equal(
      interrupted.killed,
      true,
      'the signal was delivered — the refusal is about identity, not about a failed signal',
    );
    assert.equal(
      interrupted.terminated,
      true,
      'the tree really died — a confirmed MCP-child kill is a real kill, and still not an interruption',
    );
    const commands = (interrupted.tree ?? []).map((node) => node.command ?? '');
    assert.ok(commands.length > 0, 'the killed tree must be archived');
    assert.ok(
      commands.some(
        (command) => /^sleep( |$)/.test(command) || command.includes('masquerade-helper'),
      ),
      `the killed tree must be the masquerading one (sleep image + helper child): ${JSON.stringify(commands)}`,
    );
    assert.ok(
      !commands.some((command) => command.includes('bin/claude')),
      'no killed node may name the vendor path — that is the masquerade the leg must refuse',
    );
  });

  check('the masquerading receipt still validates against the version-3 contract', () => {
    // A refused interruption is a finding, and a receipt that cannot be loaded is a missing cell.
    const validated = validateClientCertificationReceipt(result.receipt, { evidenceRoot: out });
    assert.equal(validated.formatVersion, 3);
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
