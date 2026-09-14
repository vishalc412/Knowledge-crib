import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationEvidenceError,
  loadClientCertificationReceipts,
} from './client-certification-evidence.mjs';
import { renderClientCertificationMatrix } from './client-certification-matrix.mjs';
import {
  RECORDER_VERSION,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
} from './client-protocol-recorder.mjs';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const CAPTURED_AT = '2026-09-08T00:00:00.000Z';
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The isolated stores both principals share — the whole point is one journal, two identities. */
const SHARED_STORES = {
  journal: '/tmp/crib-certification-memory',
  repository: '/tmp/crib-certification-registry',
};

/** A protocol reference: the archived recording, the completed operation, and its request id. */
const protocolRef = (recording, operation) => ({
  recording,
  operation,
  request: `fixture-${recording}-${operation}`,
});

/** Every leg passing, each protocol leg citing the completed operation it rests on. */
const allPassLegs = (overrides = {}) => ({
  configuration: { status: 'pass' },
  handshake: { status: 'pass', source: 'vendor-client', protocol: [protocolRef('owner', 1)] },
  toolUse: { status: 'pass', source: 'vendor-client', protocol: [protocolRef('owner', 3)] },
  record: { status: 'pass', protocol: [protocolRef('owner', 3)] },
  interruption: { status: 'pass' },
  restart: { status: 'pass', protocol: [protocolRef('owner', 7)] },
  authorizedResume: { status: 'pass', protocol: [protocolRef('owner', 9)] },
  foreignPrincipalExclusion: {
    status: 'pass',
    protocol: [protocolRef('foreign', 1), protocolRef('owner', 9)],
  },
  ...overrides,
});

/** The recorder transcript attributed to one side's principal, in the shape the recorder writes. */
function fixtureRecordingBytes(name, side, principalSha256) {
  return `${JSON.stringify({
    format: RECORDING_FORMAT,
    formatVersion: RECORDING_FORMAT_VERSION,
    recorderVersion: RECORDER_VERSION,
    recordedAt: CAPTURED_AT,
    principalSha256,
    serverCommandSha256: SHA_A,
    sessions: [{ id: `session-${name}-${side}` }],
    operations: Array.from({ length: 10 }, (_, index) => ({
      id: `op-${name}-${side}-${index}`,
      method: 'tools/call',
      status: 'completed',
      tool: 'memory',
    })),
  })}\n`;
}

/** The log and both recordings a certifying fixture rests on, hashed exactly as the receipt cites them. */
function fixtureArtifacts(name) {
  const logBytes = `record -> interrupt -> restart -> authorized resume (${name}.log)\n`;
  return {
    logBytes,
    ownerBytes: fixtureRecordingBytes(name, 'owner', SHA_A),
    foreignBytes: fixtureRecordingBytes(name, 'foreign', SHA_B),
  };
}

/**
 * A complete version-3 certifying receipt. The renderer is a pure leg-and-cell consumer, so these
 * in-memory fixtures need no artifacts on disk — the ones written out for the CLI path below do,
 * because there the loader re-hashes every artifact the receipt cites.
 */
const v3Receipt = (name = 'codex', overrides = {}) => {
  const { logBytes, ownerBytes, foreignBytes } = fixtureArtifacts(name);
  return {
    format: 'knowledge-crib-client-certification',
    formatVersion: 3,
    generatedAt: CAPTURED_AT,
    policySha256: SHA_A,
    product: { commit: COMMIT, packageSha256: SHA_A },
    client: { id: 'codex', version: '0.42.0', driverVersion: '1.0.0', certificationMode: 'codex' },
    platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
    runId: `run-matrix-${name}`,
    capture: { hostname: 'fixture-host', operator: 'fixture-operator', capturedAt: CAPTURED_AT },
    principalMarkers: { owner: SHA_A, foreign: SHA_B },
    configurations: {
      owner: {
        sha256: SHA_A,
        principalSha256: SHA_A,
        stores: SHARED_STORES,
        serverCommandSha256: SHA_A,
      },
      foreign: {
        sha256: SHA_B,
        principalSha256: SHA_B,
        stores: SHARED_STORES,
        serverCommandSha256: SHA_A,
      },
    },
    protocol: {
      ownerRecording: {
        path: `recordings/${name}-owner-recording.json`,
        sha256: digestOf(ownerBytes),
      },
      foreignRecording: {
        path: `recordings/${name}-foreign-recording.json`,
        sha256: digestOf(foreignBytes),
      },
    },
    vendor: {
      processIdentity: 'codex 0.42.0 (/usr/local/bin/codex, pid 4711)',
      logPath: `logs/${name}.log`,
      logSha256: digestOf(logBytes),
    },
    legs: allPassLegs(),
    ...overrides,
  };
};

/**
 * The schema version three replaced: legs and a vendor transcript, but no protocol evidence. It
 * stays LOADABLE as history and can never cover a cell — the migration story the renderer has to
 * keep telling without pretending the run happened somewhere other than the native platform.
 */
const v2Receipt = (overrides = {}) => ({
  format: 'knowledge-crib-client-certification',
  formatVersion: 2,
  generatedAt: CAPTURED_AT,
  policySha256: SHA_A,
  product: { commit: COMMIT, packageSha256: SHA_A },
  client: { id: 'codex', version: '0.42.0', driverVersion: '1.0.0', certificationMode: 'codex' },
  platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
  runId: 'run-matrix-legacy',
  capture: { hostname: 'fixture-host', operator: 'fixture-operator', capturedAt: CAPTURED_AT },
  principalMarkers: { owner: SHA_A, foreign: SHA_B },
  vendor: {
    processIdentity: 'codex 0.42.0 (/usr/local/bin/codex, pid 4711)',
    logPath: 'logs/codex.log',
    logSha256: SHA_A,
  },
  legs: allPassLegs(),
  ...overrides,
});

/**
 * The grid rows of a rendered document, as cell arrays. The summary table above has three columns
 * and the grid header is a row too, so filtering on the eight-column shape and dropping the header
 * isolates the cells without depending on the grid's position.
 */
const gridRows = (doc) =>
  doc
    .split('\n')
    .filter((line) => line.startsWith('| ') && line.endsWith(' |'))
    .map((line) => line.slice(2, -2).split(' | '))
    .filter((cells) => cells.length === 8 && cells[0] !== 'Client');

const gridRow = (doc, client, platform) =>
  gridRows(doc).find((cells) => cells[0] === client && cells[1] === platform);

const rendered = renderClientCertificationMatrix([v3Receipt()]);

assert.match(rendered, /\| Codex \| runtime verified \| macOS arm64 \(0\.42\.0\) \|/);
assert.match(rendered, /\| Claude Code \| not certified \| — \|/);
assert.doesNotMatch(rendered, /configuration verified.*Codex/);

// The summary is computed per CLIENT across every platform, so it can read stronger than any single
// cell: seven rows would let a reader take seven of twenty-one cells for done, which is the exact
// overstatement the launch decision refuses. The grid is the only place the boundary is legible, so
// it must carry every advertised cell — certified or not, no waivers.
assert.equal(gridRows(rendered).length, 21);
assert.deepEqual(
  new Set(gridRows(rendered).map((cells) => cells[1])),
  new Set(['macOS', 'Linux', 'Windows']),
);

// A certified cell shows the evidence itself, not a summary of it — including the candidate commit
// and the date the run was captured. Without a receipt directory the link is an em-dash, never a
// guessed path.
assert.deepEqual(gridRow(rendered, 'Codex', 'macOS'), [
  'Codex',
  'macOS',
  'runtime verified',
  '0.42.0',
  'arm64 / v22.23.1',
  `\`${COMMIT.slice(0, 12)}\``,
  CAPTURED_AT.slice(0, 10),
  '—',
]);

// An uncertified cell shows the state and nothing else. A plausible version, commit or date beside an
// uncertified cell would be a fabricated record of a run that never happened.
for (const cells of gridRows(rendered)) {
  if (cells[2] === 'not certified') assert.deepEqual(cells.slice(3), ['—', '—', '—', '—', '—']);
}
assert.deepEqual(gridRow(rendered, 'Claude Code', 'macOS'), [
  'Claude Code',
  'macOS',
  'not certified',
  '—',
  '—',
  '—',
  '—',
  '—',
]);

// A WSL receipt (process.platform 'linux', platform.wsl true) satisfies every leg and still is not a
// native runtime, so the row discloses the run and never presents it as a native Linux pass. This is
// the same judgement the launch decision makes: the table must not contradict it.
const wslRendered = renderClientCertificationMatrix([
  v3Receipt('matrix-wsl', {
    client: { id: 'cursor', version: '1.0.0', driverVersion: '1', certificationMode: 'cursor' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
  }),
]);
assert.match(
  wslRendered,
  /\| Cursor \| runtime evidence only \(not a native runtime\) \| WSL x64 \(1\.0\.0\) \|/,
);
assert.doesNotMatch(wslRendered, /\| Cursor \| runtime verified \|/);
assert.doesNotMatch(wslRendered, /Linux x64/);

// The same judgement in the cell, where it matters most: a WSL run reports process.platform 'linux',
// so it lands on the Linux cell, and that cell must read as NOT met — the state says the run was not
// a native runtime and the host column names WSL outright, so the row cannot be counted as a pass.
const wslCell = gridRow(wslRendered, 'Cursor', 'Linux');
assert.equal(wslCell[2], 'runtime evidence only (not a native runtime)');
assert.equal(wslCell[4], 'WSL x64 / v22.23.1');
assert.equal(
  gridRows(wslRendered).find((cells) => cells[0] === 'Cursor' && cells[2] === 'runtime verified'),
  undefined,
);

// A native linux pass beside the WSL run still certifies the cell, and the row shows the stronger
// evidence — the disclosure is about the evidence displayed, not a permanent mark on the client.
const nativeBesideWsl = renderClientCertificationMatrix([
  v3Receipt('matrix-wsl', {
    client: { id: 'cursor', version: '1.0.0', driverVersion: '1', certificationMode: 'cursor' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
  }),
  v3Receipt('matrix-native', {
    client: { id: 'cursor', version: '1.0.0', driverVersion: '1', certificationMode: 'cursor' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
  }),
]);
assert.match(nativeBesideWsl, /\| Cursor \| runtime verified \| Linux x64 \(1\.0\.0\) \|/);

// The cell picks the stronger evidence by rank, not by arrival order — the WSL run is listed first
// here, and letting file order decide would let the weaker evidence displace the stronger.
const nativeCell = gridRow(nativeBesideWsl, 'Cursor', 'Linux');
assert.equal(nativeCell[2], 'runtime verified');
assert.equal(nativeCell[4], 'x64 / v22.23.1');

// A Copilot-shaped test client's protocol evidence is labelled protocol evidence only and is never
// presented as a runtime claim; a vendor-client protocol probe keeps the plain label. Only a
// schema-1 receipt can express this at all: the certifying schema refuses a test-client handshake.
const testClientRendered = renderClientCertificationMatrix([
  {
    client: { id: 'copilot', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    product: { commit: COMMIT, packageSha256: SHA_A },
    generatedAt: CAPTURED_AT,
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass', source: 'test-client' },
      runtime: { status: 'not-run' },
    },
  },
]);
assert.match(testClientRendered, /\| GitHub Copilot \| protocol evidence only \(test client\) \|/);
assert.match(
  testClientRendered,
  /\| GitHub Copilot \| protocol evidence only \(test client\) \| Linux x64 \(1\.0\.0\) \|/,
);
assert.doesNotMatch(testClientRendered, /GitHub Copilot \| runtime verified/);

const vendorProtocolRendered = renderClientCertificationMatrix([
  {
    client: { id: 'copilot', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    product: { commit: COMMIT, packageSha256: SHA_A },
    generatedAt: CAPTURED_AT,
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass', source: 'vendor-client' },
      runtime: { status: 'not-run' },
    },
  },
]);
assert.match(vendorProtocolRendered, /\| GitHub Copilot \| protocol verified \|/);
// The renderer's fixed legend paragraph always explains the "protocol evidence only" label, so
// scope this check to the GitHub Copilot row rather than the whole document.
assert.doesNotMatch(vendorProtocolRendered, /\| GitHub Copilot \| protocol evidence only/);

// A version-2 receipt is readable history that can no longer cover a cell, and the row must say
// WHAT it is: a legacy schema. The one fact it may not state is the WSL label's — that the run
// happened somewhere other than the native platform — because a v2 receipt was a native run, and
// the public table may not claim the run happened where it did not.
const legacyRendered = renderClientCertificationMatrix([v2Receipt()]);
assert.match(legacyRendered, /\| Codex \| runtime evidence only \(legacy receipt schema\) \|/);
assert.doesNotMatch(legacyRendered, /\| Codex \| runtime verified/);
assert.doesNotMatch(legacyRendered, /\| Codex \| runtime evidence only \(not a native runtime\)/);
assert.equal(
  gridRow(legacyRendered, 'Codex', 'macOS')[2],
  'runtime evidence only (legacy receipt schema)',
);

// The test-client relabel applies to the cell too, so a probe that merely speaks the protocol shape
// cannot be counted as a cell pass; a vendor-client protocol probe keeps the plain label.
assert.equal(
  gridRow(testClientRendered, 'GitHub Copilot', 'Linux')[2],
  'protocol evidence only (test client)',
);
assert.equal(gridRow(vendorProtocolRendered, 'GitHub Copilot', 'Linux')[2], 'protocol verified');

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'client-certification-matrix.mjs');
const DOCS_TEMPLATE = [
  '# capability matrix',
  '',
  '<!-- client-certification:generated:start -->',
  'stale placeholder',
  '<!-- client-certification:generated:end -->',
  '',
].join('\n');

const runMatrix = (docs, receipts, args = []) =>
  spawnSync(process.execPath, [SCRIPT, '--docs', docs, '--receipts', receipts, ...args], {
    encoding: 'utf8',
  });

/** A certifying version-3 receipt backed by a real log AND both recordings under `receiptsDir`. */
function writeRuntimeReceipt(receiptsDir, name, runtime = {}) {
  const { logBytes, ownerBytes, foreignBytes } = fixtureArtifacts(name);
  mkdirSync(join(receiptsDir, 'logs'), { recursive: true });
  writeFileSync(join(receiptsDir, 'logs', `${name}.log`), logBytes);
  mkdirSync(join(receiptsDir, 'recordings'), { recursive: true });
  writeFileSync(join(receiptsDir, 'recordings', `${name}-owner-recording.json`), ownerBytes);
  writeFileSync(join(receiptsDir, 'recordings', `${name}-foreign-recording.json`), foreignBytes);
  return v3Receipt(name, {
    client: { id: 'codex', version: '1.0.0', driverVersion: '1.0.0', certificationMode: 'codex' },
    vendor: {
      processIdentity: 'codex 1.0.0 (/usr/local/bin/codex, pid 4711)',
      logPath: `logs/${name}.log`,
      logSha256: digestOf(logBytes),
    },
    ...runtime,
  });
}

const root = mkdtempSync(join(tmpdir(), 'crib-certification-matrix-'));
try {
  // Receipt removal flips state: a runtime-verified row degrades to not certified once its
  // receipt is gone, and --check reports the previously generated document as stale in between.
  const flipDir = join(root, 'flip');
  const flipDocs = join(root, 'flip-capability-matrix.md');
  const flipReceipt = 'client-codex-darwin-arm64.json';
  mkdirSync(flipDir);
  writeFileSync(flipDocs, DOCS_TEMPLATE);
  // Named the way the certifier names it — `client-<client>-<platform>-<arch>.json` — so the run
  // below also proves that main() hands the receipt directory to the renderer. If it did not, every
  // link in the shipped document would silently degrade to an em-dash and a reader could not reach
  // the evidence the table claims.
  writeFileSync(
    join(flipDir, flipReceipt),
    `${JSON.stringify(writeRuntimeReceipt(flipDir, 'client-codex-darwin-arm64'))}\n`,
  );
  assert.equal(runMatrix(flipDocs, flipDir).status, 0);
  let flipDoc = readFileSync(flipDocs, 'utf8');
  assert.match(flipDoc, /\| Codex \| runtime verified \| macOS arm64 \(1\.0\.0\) \|/);
  assert.deepEqual(gridRow(flipDoc, 'Codex', 'macOS'), [
    'Codex',
    'macOS',
    'runtime verified',
    '1.0.0',
    'arm64 / v22.23.1',
    `\`${COMMIT.slice(0, 12)}\``,
    CAPTURED_AT.slice(0, 10),
    `[\`${flipReceipt}\`](launch/client-certification-receipts/${flipReceipt})`,
  ]);
  assert.equal(runMatrix(flipDocs, flipDir, ['--check']).status, 0);

  unlinkSync(join(flipDir, flipReceipt));
  const stale = runMatrix(flipDocs, flipDir, ['--check']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale/);

  assert.equal(runMatrix(flipDocs, flipDir).status, 0);
  flipDoc = readFileSync(flipDocs, 'utf8');
  assert.match(flipDoc, /\| Codex \| not certified \| — \|/);
  assert.doesNotMatch(flipDoc, /Codex \| runtime verified/);
  assert.equal(runMatrix(flipDocs, flipDir, ['--check']).status, 0);

  // The link is looked up, never assumed. A receipt under a name the certifier would not produce —
  // here the pre-WP2 `codex-darwin.json` — renders an em-dash, because a public table may not point
  // at a file it has not looked for and a 404 is not evidence.
  const strayDir = join(root, 'stray');
  mkdirSync(strayDir);
  writeFileSync(join(strayDir, 'codex-darwin.json'), `${JSON.stringify(v3Receipt())}\n`);
  const strayRendered = renderClientCertificationMatrix([v3Receipt()], {
    receiptDirectory: strayDir,
  });
  assert.equal(gridRow(strayRendered, 'Codex', 'macOS')[2], 'runtime verified');
  assert.equal(gridRow(strayRendered, 'Codex', 'macOS')[7], '—');

  // Validation coupling: generation loads receipts through the validator, so a malformed receipt
  // in the directory makes it refuse rather than render a runtime-verified row.
  const refuseDir = join(root, 'refuse');
  const refuseDocs = join(root, 'refuse-capability-matrix.md');
  mkdirSync(refuseDir);
  writeFileSync(refuseDocs, DOCS_TEMPLATE);
  const malformed = writeRuntimeReceipt(refuseDir, 'codex-darwin');
  // A test client that merely speaks the protocol is the sharpest case: it can produce a transcript,
  // and the certifying schema refuses it outright rather than leaving a reader to notice.
  malformed.legs.handshake = { status: 'pass', source: 'test-client' };
  writeFileSync(join(refuseDir, 'codex-darwin.json'), `${JSON.stringify(malformed)}\n`);
  assert.throws(() => loadClientCertificationReceipts(refuseDir), CertificationEvidenceError);
  assert.throws(() => loadClientCertificationReceipts(refuseDir), /vendor-client/);
  const refused = runMatrix(refuseDocs, refuseDir);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /vendor-client/);
  assert.doesNotMatch(readFileSync(refuseDocs, 'utf8'), /runtime verified/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('client certification matrix tests ok');
