/**
 * Transparent stdio recorder tests (receipt schema v3, Task 5).
 *
 * The recorder is the piece that makes word-matching insufficient: a leg passes only when the
 * vendor's OUTPUT and the recorded PROTOCOL agree. These tests pin the properties that agreement
 * depends on — byte-for-byte forwarding (the shim never fabricates a response), marker evaluation
 * over the raw bytes before redaction (archived only as digests), flush-after-every-operation
 * (an interrupted session keeps the operations it completed), merge across a restart, and the
 * REFUSAL to merge a recording attributed to a different principal — attributing a foreign
 * principal's traffic to the owner is exactly the confusion the exclusion leg exists to detect.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECORDER_VERSION,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  emptyRecording,
  findCompletedOperation,
  markerDigest,
  mergeRecording,
  operationCount,
  parseRecorderArgs,
  recordingProblems,
  serverCommandSha256,
} from './client-protocol-recorder.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = join(HERE, 'client-protocol-recorder.mjs');
const root = mkdtempSync(join(tmpdir(), 'client-protocol-recorder-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const sha256Of = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────
assert.equal(markerDigest('certify-abc'), sha256Of('certify-abc'));
assert.match(markerDigest('x'), /^sha256:[a-f0-9]{64}$/);
assert.equal(
  serverCommandSha256('/usr/local/bin/crib', ['serve', '.']),
  sha256Of(JSON.stringify(['/usr/local/bin/crib', 'serve', '.'])),
  'the server identity digest covers the command AND its arguments',
);
assert.equal(serverCommandSha256('node'), sha256Of(JSON.stringify(['node'])));
assert.equal(RECORDER_VERSION, '1.0.0');
assert.equal(RECORDING_FORMAT, 'knowledge-crib-protocol-recording');
assert.equal(RECORDING_FORMAT_VERSION, 1);

const args = parseRecorderArgs([
  '--server',
  'node',
  '--record',
  '/tmp/rec.json',
  '--principal',
  'principal:owner',
  '--markers',
  ' a , b ,, ',
  '--',
  'serve',
  '.',
]);
assert.equal(args.server, 'node');
assert.equal(args.record, '/tmp/rec.json');
assert.equal(args.principal, 'principal:owner');
assert.deepEqual(args.markers, ['a', 'b'], 'markers are comma-split, trimmed and non-empty');
assert.deepEqual(args.serverArgs, ['serve', '.']);
assert.throws(() => parseRecorderArgs(['--record', 'x', '--principal', 'p']), /all required/);
assert.throws(() => parseRecorderArgs(['--server', 's', '--principal', 'p']), /all required/);
assert.throws(
  () => parseRecorderArgs(['--server', 's', '--record', 'r', '--principal', 'p', '--wat']),
  /unknown recorder argument/,
);
assert.throws(
  () => parseRecorderArgs(['--server', 's', '--record', 'r', '--principal']),
  /requires a value/,
);

const empty = emptyRecording({
  principal: 'principal:owner',
  server: 'crib',
  serverArgs: ['serve'],
});
assert.deepEqual(recordingProblems(empty), [], 'a fresh recording skeleton is valid');
assert.equal(empty.principalSha256, markerDigest('principal:owner'));
assert.equal(empty.serverCommandSha256, serverCommandSha256('crib', ['serve']));
assert.notEqual(
  emptyRecording({ principal: 'principal:owner', server: 'crib' }).principalSha256,
  emptyRecording({ principal: 'principal:foreign', server: 'crib' }).principalSha256,
  'owner and foreign principals must produce distinct digests',
);

// Structural refusals: each of these shapes is a recording that lies about what crossed the wire.
assert.ok(recordingProblems(null).length > 0);
assert.ok(recordingProblems({ ...empty, format: 'someone-elses' }).length > 0);
assert.ok(recordingProblems({ ...empty, formatVersion: 99 }).length > 0);
assert.ok(recordingProblems({ ...empty, principalSha256: 'deadbeef' }).length > 0);
assert.ok(recordingProblems({ ...empty, serverCommandSha256: 'sha256:xyz' }).length > 0);
assert.ok(recordingProblems({ ...empty, recordedAt: 'yesterday' }).length > 0);
assert.ok(recordingProblems({ ...empty, operations: 'nope' }).length > 0);
assert.ok(
  recordingProblems({
    ...empty,
    operations: [{ id: '1', method: 'tools/call', status: 'never-started' }],
  }).length > 0,
);
assert.ok(
  recordingProblems({
    ...empty,
    operations: [
      { id: '1', method: 'tools/call', status: 'completed', resultMarkers: { notADigest: true } },
    ],
  }).length > 0,
  'marker maps must be keyed by sha256 digests',
);
assert.ok(
  recordingProblems({
    ...empty,
    operations: [
      {
        id: '1',
        method: 'tools/call',
        status: 'completed',
        resultMarkers: { [markerDigest('m')]: false },
      },
    ],
  }).length > 0,
  'a marker flag that is not exactly true is a lie about a lie',
);
assert.ok(recordingProblems({ ...empty, sessions: [{ no: 'id' }] }).length > 0);

// findCompletedOperation: the correlated-evidence query the harness leans on.
const ALPHA = 'alpha-marker';
const sample = {
  ...empty,
  operations: [
    {
      id: '1',
      method: 'initialize',
      tool: null,
      status: 'completed',
      requestMarkers: {},
      resultMarkers: {},
    },
    {
      id: '2',
      method: 'tools/call',
      tool: 'query',
      status: 'completed',
      requestMarkers: { [markerDigest(ALPHA)]: true },
      resultMarkers: { [markerDigest(ALPHA)]: true },
    },
    {
      id: '3',
      method: 'tools/call',
      tool: 'memory',
      status: 'errored',
      requestMarkers: {},
      resultMarkers: {},
    },
    {
      id: '4',
      method: 'tools/call',
      tool: 'memory',
      status: 'completed',
      requestMarkers: {},
      resultMarkers: {},
    },
  ],
};
assert.equal(operationCount(sample), 4);
assert.equal(operationCount({}), 0);
assert.equal(findCompletedOperation(sample).operation.id, '1');
assert.equal(findCompletedOperation(sample, { method: 'tools/call' }).operation.id, '2');
assert.equal(
  findCompletedOperation(sample, { tool: 'memory', method: 'tools/call' }).operation.id,
  '4',
  'the errored op never matches',
);
assert.equal(findCompletedOperation(sample, { tool: 'nope' }), null);
assert.equal(findCompletedOperation(sample, { requestMarker: ALPHA }).operation.id, '2');
assert.equal(findCompletedOperation(sample, { resultMarker: ALPHA }).operation.id, '2');
assert.equal(findCompletedOperation(sample, { resultMarker: 'never-seen' }), null);
assert.equal(
  findCompletedOperation(sample, { absentResultMarker: ALPHA, fromIndex: 1 }).operation.id,
  '4',
  'absentResultMarker finds a completed op whose result did NOT echo the marker',
);
assert.equal(
  findCompletedOperation(sample, { fromIndex: 3, method: 'initialize' }),
  null,
  'fromIndex bounds the search to operations after the floor',
);
assert.equal(
  findCompletedOperation(sample, { absentResultMarker: ALPHA }).operation.id,
  '1',
  'without a floor, absentResultMarker matches any earlier completed op — which is why the harness ALWAYS pairs it with fromIndex',
);

// mergeRecording: append same-attribution sessions, refuse everything else.
const left = emptyRecording({ principal: 'p', server: 'crib' });
left.operations.push({
  id: '1',
  method: 'tools/call',
  tool: 'query',
  status: 'completed',
  requestMarkers: {},
  resultMarkers: {},
});
const right = emptyRecording({ principal: 'p', server: 'crib' });
right.operations.push({
  id: '2',
  method: 'tools/call',
  tool: 'memory',
  status: 'completed',
  requestMarkers: {},
  resultMarkers: {},
});
const merged = mergeRecording(left, right);
assert.equal(merged.operations.length, 2, 'a same-principal restart appends');
const foreign = emptyRecording({ principal: 'other', server: 'crib' });
assert.equal(mergeRecording(left, foreign), null, 'a different principal is refused, never merged');
const otherServer = emptyRecording({ principal: 'p', server: 'different-crib' });
assert.equal(mergeRecording(left, otherServer), null, 'a different server command is refused too');
assert.equal(mergeRecording(left, { broken: true }), null, 'an invalid recording is refused');

// ── end to end against a fake newline-delimited JSON-RPC server ─────────────────────────────
// The fake server is deliberately dumb: it answers initialize with a fixed sessionId and echoes
// tools/call parameters into the result text. That is enough to drive every recorder property.
const fakeServerPath = join(root, 'fake-server.mjs');
writeFileSync(
  fakeServerPath,
  [
    "let pending = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  pending += chunk;',
    "  let index = pending.indexOf('\\n');",
    '  while (index !== -1) {',
    '    const line = pending.slice(0, index);',
    '    pending = pending.slice(index + 1);',
    '    if (line.trim().length > 0) handle(line);',
    "    index = pending.indexOf('\\n');",
    '  }',
    '});',
    "function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }",
    'function handle(line) {',
    '  let message;',
    '  try { message = JSON.parse(line); } catch { return; }',
    '  if (!message || message.method === undefined) return;',
    "  if (message.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-1', protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-crib' } } });",
    "    if (process.env.FAKE_MODE === 'exit3') setImmediate(() => process.exit(3));",
    '    return;',
    '  }',
    "  if (message.method === 'tools/call') {",
    "    if (process.env.FAKE_MODE === 'error') {",
    "      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'boom' } });",
    '      return;',
    '    }',
    "    const text = 'ok ' + (message.params?.q ?? message.params?.op ?? '');",
    "    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });",
    '  }',
    '}',
  ].join('\n'),
);

/**
 * One recorder session. `writes` are Buffers/strings pushed into the recorder's stdin (a single
 * JSON line may be split across writes to stress the byte tap); the session ends when stdin ends
 * and the fake server exits, or earlier when `untilRecordingOperations` operations have been
 * flushed to disk and the recorder is SIGKILLed — the interrupted-session case.
 */
async function runSession({
  mode = '',
  principal,
  markers = [],
  record,
  writes,
  endStdin = true,
  untilRecordingOperations = null,
}) {
  const argv = [
    RECORDER,
    '--server',
    process.execPath,
    '--record',
    record,
    '--principal',
    principal,
  ];
  if (markers.length > 0) argv.push('--markers', markers.join(','));
  argv.push('--', fakeServerPath);
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, FAKE_MODE: mode },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  for (const write of writes) child.stdin.write(write);
  if (untilRecordingOperations !== null) {
    // Poll the RECORDING FILE, not the child: the property under test is that completed operations
    // reach disk before the process dies.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const doc = JSON.parse(readFileSync(record, 'utf8'));
        if (operationCount(doc) >= untilRecordingOperations) break;
      } catch {
        // Not flushed yet — keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGKILL');
  } else if (endStdin) {
    child.stdin.end();
  }
  const { code, signal } = await exited;
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

const jsonLine = (message) => `${JSON.stringify(message)}\n`;

// ── forwarding is byte-for-byte and the recording carries the protocol truth ───────────────────
{
  const record = join(root, 'forward.json');
  const initialize = jsonLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const query = jsonLine({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'query', q: 'alpha-marker' },
  });
  const memory = jsonLine({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'memory', op: 'handoff' },
  });
  const { code, stdout } = await runSession({
    principal: 'principal:owner',
    markers: ['alpha-marker', 'omega-markér'],
    record,
    writes: [initialize, query, memory],
  });
  assert.equal(code, 0, 'recorder must exit 0 when the server does (stderr on failure above)');
  const initializeResponse =
    '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess-1","protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fake-crib"}}}\n';
  const queryResponse =
    '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok alpha-marker"}]}}\n';
  const memoryResponse =
    '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok handoff"}]}}\n';
  assert.equal(
    stdout.toString('utf8'),
    initializeResponse + queryResponse + memoryResponse,
    'stdout must carry EXACTLY the server bytes — the shim never fabricates or transforms',
  );
  const doc = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual(recordingProblems(doc), [], 'the written recording must be valid');
  assert.equal(doc.principalSha256, markerDigest('principal:owner'));
  assert.equal(doc.serverCommandSha256, serverCommandSha256(process.execPath, [fakeServerPath]));
  assert.deepEqual(
    doc.sessions.map((s) => s.id),
    ['sess-1'],
    'initialize responses record the session id',
  );
  assert.equal(doc.operations.length, 3);
  assert.deepEqual(
    doc.operations.map((op) => [op.id, op.method, op.tool, op.status]),
    [
      ['1', 'initialize', null, 'completed'],
      ['2', 'tools/call', 'query', 'completed'],
      ['3', 'tools/call', 'memory', 'completed'],
    ],
  );
  assert.deepEqual(doc.operations[1].requestMarkers, { [markerDigest('alpha-marker')]: true });
  assert.deepEqual(doc.operations[1].resultMarkers, { [markerDigest('alpha-marker')]: true });
  assert.deepEqual(
    doc.operations[2].requestMarkers,
    {},
    'the handoff request carries no marker — this is why the harness needs index floors',
  );
  assert.deepEqual(doc.operations[2].resultMarkers, {});
  assert.equal(
    findCompletedOperation(doc, { tool: 'query', resultMarker: 'alpha-marker' }).operation.id,
    '2',
  );
}

// ── a marker split across stdin chunks (mid UTF-8 character) is still evaluated ────────────────
{
  const record = join(root, 'split-chunk.json');
  const line = jsonLine({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'memory', op: 'omega-markér' },
  });
  const bytes = Buffer.from(line, 'utf8');
  const split = bytes.indexOf(Buffer.from('é', 'utf8')) + 1; // between the two bytes of é
  assert.ok(split > 0 && split < bytes.length, 'the split must land mid-character');
  const { code } = await runSession({
    principal: 'principal:owner',
    markers: ['omega-markér'],
    record,
    writes: [bytes.subarray(0, split), bytes.subarray(split)],
  });
  assert.equal(code, 0);
  const doc = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual(recordingProblems(doc), []);
  assert.deepEqual(
    doc.operations[0].requestMarkers,
    { [markerDigest('omega-markér')]: true },
    'the byte tap must reassemble a marker even when a chunk boundary splits its UTF-8 encoding',
  );
  assert.deepEqual(doc.operations[0].resultMarkers, { [markerDigest('omega-markér')]: true });
}

// ── an error response is recorded as errored, never completed ─────────────────────────────────
{
  const record = join(root, 'errored.json');
  const { code } = await runSession({
    mode: 'error',
    principal: 'principal:owner',
    record,
    writes: [jsonLine({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query' } })],
  });
  assert.equal(code, 0);
  const doc = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(doc.operations[0].status, 'errored');
  assert.equal(
    findCompletedOperation(doc, { tool: 'query' }),
    null,
    'an errored op never satisfies a leg',
  );
}

// ── the recorder propagates the server's exit code ────────────────────────────────────────────
{
  const record = join(root, 'exit3.json');
  const { code } = await runSession({
    mode: 'exit3',
    principal: 'principal:owner',
    record,
    writes: [jsonLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })],
  });
  assert.equal(code, 3, 'the shim must exit with the server’s code, not its own');
  const doc = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual(recordingProblems(doc), []);
  assert.equal(operationCount(doc), 1, 'the initialize op was flushed before the exit');
}

// ── an interrupted session keeps the operations it completed (flush after EVERY op) ────────────
{
  const record = join(root, 'interrupted.json');
  const first = jsonLine({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'query', q: 'alpha-marker' },
  });
  const second = jsonLine({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'memory', op: 'handoff' },
  });
  const { signal } = await runSession({
    principal: 'principal:owner',
    markers: ['alpha-marker'],
    record,
    writes: [first, second],
    endStdin: false,
    untilRecordingOperations: 2,
  });
  assert.equal(signal, 'SIGKILL');
  const doc = JSON.parse(readFileSync(record, 'utf8'));
  assert.deepEqual(recordingProblems(doc), [], 'a SIGKILL mid-stream must leave a VALID recording');
  assert.equal(operationCount(doc), 2, 'both completed operations survived the kill');
  assert.equal(doc.operations[1].tool, 'memory');
}

// ── a restart appends; a different principal is refused ──────────────────────────────────────
{
  const record = join(root, 'restart.json');
  const call = (id) =>
    jsonLine({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'query', q: `q-${id}` } });
  const firstSession = await runSession({
    principal: 'principal:owner',
    record,
    writes: [call(1)],
  });
  assert.equal(firstSession.code, 0);
  const afterFirst = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(operationCount(afterFirst), 1);

  const secondSession = await runSession({
    principal: 'principal:owner',
    record,
    writes: [call(2)],
  });
  assert.equal(secondSession.code, 0);
  const afterRestart = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(afterRestart.principalSha256, markerDigest('principal:owner'));
  assert.equal(operationCount(afterRestart), 2, 'a same-principal restart APPENDS');
  assert.equal(afterRestart.operations[1].id, '2');

  await runSession({ principal: 'principal:foreign', record, writes: [call(3)] });
  const afterForeign = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(afterForeign.principalSha256, markerDigest('principal:foreign'));
  assert.equal(
    operationCount(afterForeign),
    1,
    'a recording attributed to another principal must be REFUSED, not merged — cross-principal attribution is the boundary itself',
  );
  assert.equal(afterForeign.operations[0].id, '3');
}

// ── a server that never starts still produces a recording that names why ───────────────────────
{
  const record = join(root, 'no-server.json');
  const child = spawn(
    process.execPath,
    [
      RECORDER,
      '--server',
      join(root, 'definitely-not-a-binary'),
      '--record',
      record,
      '--principal',
      'principal:owner',
      '--',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.end();
  const { code } = await new Promise((resolve) => child.on('exit', (c) => resolve({ code: c })));
  assert.equal(code, 127, 'a failed spawn must exit 127, not hang');
  const doc = JSON.parse(readFileSync(record, 'utf8'));
  assert.ok(typeof doc.serverSpawnError === 'string' && doc.serverSpawnError.length > 0);
  assert.equal(operationCount(doc), 0);
}

console.log('client protocol recorder tests ok');
