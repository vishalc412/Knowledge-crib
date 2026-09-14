#!/usr/bin/env node
/**
 * Certification-only transparent stdio recorder (receipt schema v3).
 *
 * The v2 harness judged its legs from the vendor client's STDOUT: a leg passed when the right word
 * appeared in the right exit-0 turn. That proves the client PRINTED something, never that a tool was
 * actually invoked — a client that echoes the expected vocabulary certifies every leg without ever
 * speaking to the server. This shim closes that gap by tapping the protocol itself: it is inserted
 * between the vendor client and the candidate server, forwards every byte unchanged in both
 * directions, and records what actually crossed the wire — request ids, methods, tool names,
 * completion status, and marker evaluations — while never answering a request or invoking a tool
 * itself. A fabricated response is impossible by construction: the shim never writes to stdout
 * except to relay the server's own bytes.
 *
 * Sanitization is a property of the recording, not a scrubbing pass: synthetic fixture markers are
 * evaluated over the raw bytes BEFORE archiving, and only the booleans are archived, keyed by the
 * marker's digest — never the marker text, never the raw request or result bodies. The raw principal
 * id is likewise recorded only as a digest, so the recording attributes each operation to a
 * principal without ever carrying a principal string. The harness later checks those booleans
 * against the words the vendor printed, and a leg passes only when BOTH agree: the client said the
 * tool worked, and the protocol shows a completed operation.
 *
 * Usage (the harness rewrites the config's command to this shape):
 *   node client-protocol-recorder.mjs --server <cribBin> --record <recording.json> \
 *     --principal <principalId> --markers <m1,m2,...> -- <original server args...>
 *
 * Each session APPENDS to the recording file: a fresh shim loads any existing recording, refuses to
 * merge one attributed to a different principal (attributing a foreign principal's traffic to the
 * owner is exactly the confusion the exclusion leg exists to detect), and flushes atomically
 * (temp file + rename) after every completed operation — so an interrupted session keeps the
 * operations it completed before the kill, and a crash never leaves a half-written file behind.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bumped when the recording's shape changes, so a receipt names the recorder that produced it. */
export const RECORDER_VERSION = '1.0.0';
export const RECORDING_FORMAT = 'knowledge-crib-protocol-recording';
export const RECORDING_FORMAT_VERSION = 1;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TOOL_NAME_LIMIT = 200;

/** The digest a marker (or principal) is archived under — the marker text itself is never stored. */
export function markerDigest(marker) {
  return `sha256:${createHash('sha256').update(String(marker)).digest('hex')}`;
}

/**
 * Identity of the server being launched: the exact command the vendor client was configured to
 * spawn. Owner and foreign configurations launch the SAME candidate, so their recordings carry the
 * same digest — and a receipt whose two configurations disagree names a run that did not.
 */
export function serverCommandSha256(server, serverArgs = []) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([server, ...serverArgs]))
    .digest('hex')}`;
}

/**
 * Parse the shim's own argv. Strict on purpose: a config that launches the shim without a server,
 * a recording path or a principal is a broken wiring, and failing loudly at startup is the only
 * way the operator sees it — a silent no-op recorder certifies a run by recording nothing.
 */
export function parseRecorderArgs(argv) {
  const parsed = {
    server: undefined,
    record: undefined,
    principal: undefined,
    markers: [],
    serverArgs: [],
  };
  let index = 0;
  const takeValue = (flag) => {
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    return value;
  };
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') {
      parsed.serverArgs = argv.slice(index + 1);
      return parsed;
    }
    if (arg === '--server') parsed.server = takeValue(arg);
    else if (arg === '--record') parsed.record = takeValue(arg);
    else if (arg === '--principal') parsed.principal = takeValue(arg);
    else if (arg === '--markers') {
      // Markers are synthetic fixture tokens minted by the harness; commas inside a marker are not
      // supported and never occur — the harness mints hex-suffixed tokens and fixed words.
      parsed.markers = takeValue(arg)
        .split(',')
        .map((marker) => marker.trim())
        .filter((marker) => marker.length > 0);
    } else throw new Error(`unknown recorder argument: ${arg}`);
  }
  if (
    parsed.server === undefined ||
    parsed.record === undefined ||
    parsed.principal === undefined
  ) {
    throw new Error('--server, --record and --principal are all required');
  }
  return parsed;
}

/** The skeleton every recording starts from: identity up front, operations and sessions appended. */
export function emptyRecording({ principal, server, serverArgs = [] }) {
  return {
    format: RECORDING_FORMAT,
    formatVersion: RECORDING_FORMAT_VERSION,
    recorderVersion: RECORDER_VERSION,
    recordedAt: null,
    principalSha256: markerDigest(principal),
    serverCommandSha256: serverCommandSha256(server, serverArgs),
    sessions: [],
    operations: [],
  };
}

/**
 * Merge a previous recording into this session's document. REFUSES (returns null) when the existing
 * file belongs to a different principal or server command: merging it would attribute another
 * principal's operations to this one, which is precisely the boundary the exclusion leg checks.
 * A corrupt file is likewise refused rather than partially salvaged — a truncated merge is a
 * recording that lies about what crossed the wire.
 */
export function mergeRecording(base, addition) {
  const problemsBase = recordingProblems(base);
  const problemsAddition = recordingProblems(addition);
  if (problemsBase.length > 0 || problemsAddition.length > 0) return null;
  if (base.principalSha256 !== addition.principalSha256) return null;
  if (base.serverCommandSha256 !== addition.serverCommandSha256) return null;
  return {
    ...addition,
    recordedAt: addition.recordedAt ?? base.recordedAt,
    sessions: [...base.sessions, ...addition.sessions],
    operations: [...base.operations, ...addition.operations],
  };
}

/**
 * Structural problems with a recording (an empty array is valid). Pure, so the evidence validator
 * can judge a recording read from disk with the same rules the recorder wrote it under.
 */
export function recordingProblems(recording) {
  const problems = [];
  const push = (problem) => problems.push(problem);
  if (!recording || typeof recording !== 'object') return ['recording must be an object'];
  if (recording.format !== RECORDING_FORMAT) push(`unknown recording format: ${recording.format}`);
  if (recording.formatVersion !== RECORDING_FORMAT_VERSION) {
    push(`unsupported recording format version: ${recording.formatVersion}`);
  }
  if (typeof recording.recorderVersion !== 'string' || recording.recorderVersion.length === 0) {
    push('recorderVersion is required');
  }
  if (typeof recording.principalSha256 !== 'string' || !SHA256.test(recording.principalSha256)) {
    push('principalSha256 must be a sha256 digest');
  }
  if (
    typeof recording.serverCommandSha256 !== 'string' ||
    !SHA256.test(recording.serverCommandSha256)
  ) {
    push('serverCommandSha256 must be a sha256 digest');
  }
  if (
    recording.recordedAt !== null &&
    (typeof recording.recordedAt !== 'string' || Number.isNaN(Date.parse(recording.recordedAt)))
  ) {
    push('recordedAt must be null or ISO-8601');
  }
  if (!Array.isArray(recording.sessions)) push('sessions must be an array');
  else {
    for (const session of recording.sessions) {
      if (!session || typeof session !== 'object' || typeof session.id !== 'string') {
        push('every session must carry a string id');
        break;
      }
    }
  }
  if (!Array.isArray(recording.operations)) push('operations must be an array');
  else {
    for (const operation of recording.operations) {
      if (
        !operation ||
        typeof operation !== 'object' ||
        typeof operation.id !== 'string' ||
        typeof operation.method !== 'string' ||
        (operation.status !== 'completed' && operation.status !== 'errored')
      ) {
        push('every operation must carry id, method and a completed/errored status');
        break;
      }
      if (
        operation.tool !== null &&
        operation.tool !== undefined &&
        typeof operation.tool !== 'string'
      ) {
        push('operation.tool must be a bounded string or null');
        break;
      }
      for (const markerset of ['requestMarkers', 'resultMarkers']) {
        const markers = operation[markerset];
        if (markers === undefined) continue;
        if (!markers || typeof markers !== 'object' || Array.isArray(markers)) continue;
        for (const [key, value] of Object.entries(markers)) {
          if (!SHA256.test(key) || value !== true) {
            push(`operation.${markerset} entries must be sha256-keyed true flags`);
            break;
          }
        }
      }
    }
  }
  return problems;
}

/**
 * The correlated-evidence query: the first COMPLETED operation matching the criteria.
 *
 * `fromIndex` exists because the recording accumulates across a cell's sessions — the restart leg
 * must find an operation that happened AFTER the interruption, not the record turn that preceded
 * it. `absentResultMarker` is the exclusion check: an operation whose result did NOT echo the
 * foreign marker is the boundary holding, and it only means something paired with the
 * foreign recording's plant/confirm operations, which is why the harness never passes it alone.
 */
export function findCompletedOperation(recording, criteria = {}) {
  const operations = Array.isArray(recording?.operations) ? recording.operations : [];
  for (let index = criteria.fromIndex ?? 0; index < operations.length; index++) {
    const operation = operations[index];
    if (!operation || operation.status !== 'completed') continue;
    if (criteria.method && operation.method !== criteria.method) continue;
    if (criteria.tool && operation.tool !== criteria.tool) continue;
    if (
      criteria.requestMarker &&
      operation.requestMarkers?.[markerDigest(criteria.requestMarker)] !== true
    ) {
      continue;
    }
    if (
      criteria.resultMarker &&
      operation.resultMarkers?.[markerDigest(criteria.resultMarker)] !== true
    ) {
      continue;
    }
    if (
      criteria.absentResultMarker &&
      operation.resultMarkers?.[markerDigest(criteria.absentResultMarker)] === true
    ) {
      continue;
    }
    return { operation, index };
  }
  return null;
}

/** The number of operations recorded so far — the restart leg's "after this point" floor. */
export function operationCount(recording) {
  return Array.isArray(recording?.operations) ? recording.operations.length : 0;
}

/**
 * Split a byte stream into lines without ever decoding across a UTF-8 character boundary: chunks
 * are concatenated as BYTES and only complete newline-terminated slices are decoded. Forwarding
 * never goes through here — only the tap does — but a corrupted tap would still mis-record
 * protocol text, and UTF-8 continuation bytes never contain 0x0A, so splitting on it is safe.
 */
function makeLineTap(onLine) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > 0) onLine(line.toString('utf8'));
      newline = buffer.indexOf(0x0a);
    }
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const parsed = parseRecorderArgs(process.argv.slice(2));
  let doc = emptyRecording(parsed);
  if (existsSync(parsed.record)) {
    try {
      const previous = JSON.parse(readFileSync(parsed.record, 'utf8'));
      const merged = mergeRecording(previous, doc);
      // A previous recording with a different attribution is refused, not merged: this session
      // starts fresh and its operations append after nothing, so any earlier principal's evidence
      // cannot silently count for this one.
      if (merged) doc = merged;
    } catch {
      // An unparseable leftover cannot be attributed to anyone; starting fresh keeps the failure
      // with the run that produced it rather than poisoning this one.
    }
  }

  const flush = () => {
    doc.recordedAt = new Date().toISOString();
    const temp = `${parsed.record}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(temp, parsed.record);
  };

  const pending = new Map();
  let child;
  try {
    child = spawn(parsed.server, parsed.serverArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  } catch (error) {
    // A recording exists even for a server that never started: its absence would otherwise read as
    // "no protocol traffic", which is a different finding from "the candidate binary is broken".
    doc.serverSpawnError = String(error?.message ?? error);
    flush();
    process.exitCode = 127;
    return;
  }

  const onMessage = (text, direction) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // A non-JSON line is forwarded regardless; it is not protocol traffic to record.
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.id !== null && message.method !== undefined) {
      // A REQUEST: evaluate markers over the raw params now (pre-redaction), archive only flags.
      const paramsText = JSON.stringify(message.params ?? {});
      const requestMarkers = {};
      for (const marker of parsed.markers) {
        if (paramsText.includes(marker)) requestMarkers[markerDigest(marker)] = true;
      }
      pending.set(String(message.id), {
        method: typeof message.method === 'string' ? message.method : null,
        tool:
          message.method === 'tools/call' && typeof message.params?.name === 'string'
            ? message.params.name.slice(0, TOOL_NAME_LIMIT)
            : null,
        requestMarkers,
      });
      return;
    }
    if (direction === 'response' && message.id !== undefined && message.id !== null) {
      const request = pending.get(String(message.id));
      if (!request) return;
      pending.delete(String(message.id));
      const resultText = JSON.stringify(message.result ?? message.error ?? {});
      const resultMarkers = {};
      for (const marker of parsed.markers) {
        if (resultText.includes(marker)) resultMarkers[markerDigest(marker)] = true;
      }
      doc.operations.push({
        id: String(message.id),
        method: request.method,
        tool: request.tool,
        status: message.error ? 'errored' : 'completed',
        requestMarkers: request.requestMarkers,
        resultMarkers,
      });
      if (request.method === 'initialize' && !message.error) {
        const sessionId = message.result?.sessionId;
        doc.sessions.push({
          id: typeof sessionId === 'string' ? sessionId : `session-${doc.sessions.length + 1}`,
        });
      }
      flush();
    }
  };

  const tapIn = makeLineTap((line) => onMessage(line, 'request'));
  const tapOut = makeLineTap((line) => onMessage(line, 'response'));

  // Byte-for-byte forwarding. The tap OBSERVES; it never transforms, and the shim never writes
  // stdout except to relay the server's own bytes — a fabricated response is not representable.
  process.stdin.on('data', (chunk) => {
    tapIn(chunk);
    child.stdin.write(chunk);
  });
  process.stdin.on('end', () => child.stdin.end());
  child.stdout.on('data', (chunk) => {
    tapOut(chunk);
    process.stdout.write(chunk);
  });
  child.on('error', (error) => {
    doc.serverSpawnError = String(error?.message ?? error);
    flush();
    // A failed spawn raises 'error' WITHOUT a following 'exit' event, so the shim must exit here
    // or it would hang with the exit code set and never taken.
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    flush();
    process.exit(code ?? (signal ? 1 : 0));
  });
  // An interrupted session keeps the operations it completed: flush on the way out of a signal.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      flush();
      process.exit(128 + (signal === 'SIGTERM' ? 15 : 2));
    });
  }
}

// The recorder is a CLI, but its pure helpers are imported by the harness and its tests — so main
// runs only when this file is the entry point, never on import.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
