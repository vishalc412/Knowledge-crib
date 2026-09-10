/**
 * Receipt contract for advertised AI-client support.
 *
 * Configuration and protocol probes are useful evidence, but they deliberately cannot promote a
 * client to `runtime-verified`. That label is reserved for a receipt from the vendor client which
 * completed record -> interruption/restart -> authorized resume on the named operating system.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const CERTIFICATION_EVIDENCE_FORMAT_VERSION = 1;
export const CERTIFIED_CLIENTS = [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'windsurf',
  'gemini',
  'vscode',
];
const PLATFORM_IDS = new Set(['darwin', 'linux', 'win32']);
const PROTOCOL_SOURCES = new Set(['vendor-client', 'test-client']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export class CertificationEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CertificationEvidenceError';
  }
}

function assert(condition, message) {
  if (!condition) throw new CertificationEvidenceError(message);
}

function sha(value, label) {
  assert(typeof value === 'string' && SHA256.test(value), `${label} must be a sha256 digest`);
}

function passEvidence(value, label, hashKey) {
  assert(value && typeof value === 'object', `${label} evidence is required`);
  assert(value.status === 'pass', `${label} evidence must pass`);
  sha(value[hashKey], `${label}.${hashKey}`);
}

function optionalEvidence(value, label, hashKey) {
  assert(value && typeof value === 'object', `${label} evidence is required`);
  assert(
    value.status === 'pass' || value.status === 'not-run',
    `${label} evidence has an invalid status`,
  );
  if (value.status === 'pass') sha(value[hashKey], `${label}.${hashKey}`);
}

/**
 * Protocol probes may be run by the vendor client or by a test client that merely speaks the same
 * protocol shape (a Copilot-shaped harness, for example). The source is required whenever protocol
 * evidence is claimed so the matrix can label test-client rows as evidence-only; a `not-run`
 * placeholder carries no claim and needs no source.
 */
function protocolEvidence(value, label, hashKey) {
  optionalEvidence(value, label, hashKey);
  if (value.status === 'pass') {
    assert(
      PROTOCOL_SOURCES.has(value.source),
      `${label} evidence must declare its source: vendor-client or test-client`,
    );
  }
}

/**
 * Resolve a runtime evidence file (transcript or log) inside the receipts area and return its
 * absolute path. The path must stay under the area and the file must exist on disk.
 */
function resolveEvidenceFile(root, path, label) {
  assert(typeof path === 'string' && path.trim(), `${label} must be a non-empty path`);
  const resolved = resolve(root, path);
  assert(resolved.startsWith(`${root}${sep}`), `${label} escapes the receipts area: ${path}`);
  assert(
    existsSync(resolved),
    `${label} references a file missing from the receipts area: ${path}`,
  );
  return resolved;
}

/**
 * Validate the complete receipt before it may influence public support language.
 *
 * `options.evidenceRoot` is the receipts area (the directory the receipts are loaded from). It is
 * required whenever a receipt claims a vendor-client runtime pass, so the referenced transcript or
 * log file can be located and its digest verified — a hand-typed receipt with no artifact behind it
 * cannot certify a runtime.
 */
export function validateClientCertificationReceipt(receipt, options = {}) {
  assert(receipt && typeof receipt === 'object', 'receipt must be an object');
  assert(
    receipt.format === 'knowledge-crib-client-certification',
    'unsupported certification receipt format',
  );
  assert(
    receipt.formatVersion === CERTIFICATION_EVIDENCE_FORMAT_VERSION,
    'unsupported certification receipt version',
  );
  assert(!Number.isNaN(Date.parse(receipt.generatedAt)), 'generatedAt must be ISO-8601');
  assert(receipt.product && typeof receipt.product === 'object', 'product is required');
  assert(
    typeof receipt.product.commit === 'string' && COMMIT.test(receipt.product.commit),
    `product.commit is a bad commit: expected a full 40-hex git commit, got ${JSON.stringify(
      receipt.product.commit,
    )}`,
  );
  sha(receipt.product.packageSha256, 'product.packageSha256');
  assert(receipt.client && typeof receipt.client === 'object', 'client is required');
  assert(
    CERTIFIED_CLIENTS.includes(receipt.client.id),
    `unknown certified client: ${receipt.client.id}`,
  );
  assert(
    typeof receipt.client.version === 'string' && receipt.client.version.trim(),
    'client.version is required',
  );
  assert(receipt.platform && typeof receipt.platform === 'object', 'platform is required');
  assert(PLATFORM_IDS.has(receipt.platform.os), `unsupported platform: ${receipt.platform.os}`);
  assert(
    receipt.platform.wsl === undefined || typeof receipt.platform.wsl === 'boolean',
    'platform.wsl must be a boolean',
  );
  assert(
    receipt.platform.wsl !== true || receipt.platform.os === 'linux',
    'platform.wsl is only valid on linux receipts',
  );
  assert(
    typeof receipt.platform.arch === 'string' && receipt.platform.arch.trim(),
    'platform.arch is required',
  );
  assert(
    typeof receipt.platform.node === 'string' && /^v\d+/.test(receipt.platform.node),
    'platform.node must be a Node release starting with v, for example v22.23.1',
  );
  assert(receipt.evidence && typeof receipt.evidence === 'object', 'evidence is required');
  passEvidence(receipt.evidence.configuration, 'configuration', 'configSha256');
  protocolEvidence(receipt.evidence.protocol, 'protocol', 'transcriptSha256');
  const runtime = receipt.evidence.runtime;
  optionalEvidence(runtime, 'runtime', 'logSha256');
  if (runtime.status === 'pass') {
    assert(
      runtime.source === 'vendor-client',
      'runtime evidence must be produced by a vendor-client',
    );
    // The policy the run was collected under. Requirements can change (a new gate, a new platform,
    // a client version floor); a receipt that predates the change must not silently satisfy the
    // stricter promise, so the binding is recorded in the receipt itself and compared by the
    // launch decision (A02).
    sha(receipt.policySha256, 'policySha256');
    // Attribution, not attestation. A digest proves a file did not change since it was hashed; it
    // says nothing about who produced it. Naming the operator, the host and the capture time makes
    // a self-authored run identifiable AS one, which is what the matrix has to disclose.
    assert(
      runtime.attestation && typeof runtime.attestation === 'object',
      'runtime evidence must carry an attestation naming who ran it and where',
    );
    for (const field of ['operator', 'host', 'capturedAt']) {
      assert(
        typeof runtime.attestation[field] === 'string' && runtime.attestation[field].trim(),
        `runtime.attestation.${field} is required`,
      );
    }
    assert(
      !Number.isNaN(Date.parse(runtime.attestation.capturedAt)),
      'runtime.attestation.capturedAt must be ISO-8601',
    );
    assert(runtime.recordedMemory === true, 'runtime evidence must record memory');
    assert(runtime.interrupted === true, 'runtime evidence must include interruption/restart');
    assert(runtime.authorizedResume === true, 'runtime evidence must include authorized resume');
    // The principal boundary is part of the runtime promise, not decoration: a receipt whose
    // exclusion leg failed (or was never run — a blocked launch records false) must not validate
    // as a pass. Old receipts predating the leg fail loudly here and must be re-collected, which
    // is the A02 law: a receipt taken under looser requirements never silently satisfies a
    // stricter promise.
    assert(
      runtime.foreignPrincipalExcluded === true,
      'runtime evidence must exclude a foreign principal',
    );
    const artifacts = [];
    if (runtime.transcriptPath !== undefined) {
      artifacts.push({
        path: runtime.transcriptPath,
        digest: runtime.transcriptSha256,
        pathLabel: 'runtime.transcriptPath',
        digestLabel: 'runtime.transcriptSha256',
      });
    }
    if (runtime.logPath !== undefined) {
      artifacts.push({
        path: runtime.logPath,
        digest: runtime.logSha256,
        pathLabel: 'runtime.logPath',
        digestLabel: 'runtime.logSha256',
      });
    }
    assert(
      artifacts.length > 0,
      'runtime evidence must reference a transcriptPath or logPath under the receipts area',
    );
    assert(
      typeof options.evidenceRoot === 'string' && options.evidenceRoot.trim(),
      'runtime evidence requires an evidence root to verify its transcript or log file',
    );
    const root = resolve(options.evidenceRoot);
    for (const artifact of artifacts) {
      const resolved = resolveEvidenceFile(root, artifact.path, artifact.pathLabel);
      const digest = `sha256:${createHash('sha256').update(readFileSync(resolved)).digest('hex')}`;
      assert(
        artifact.digest === digest,
        `${artifact.digestLabel} does not match the ${artifact.path} file`,
      );
    }
  }
  return receipt;
}

/**
 * Load a directory atomically from the release point of view: any malformed or duplicate cell
 * invalidates the whole evidence set rather than allowing a best-effort promotion claim.
 */
export function loadClientCertificationReceipts(directory) {
  if (!existsSync(directory)) return [];
  const cells = new Set();
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      } catch (error) {
        throw new CertificationEvidenceError(
          `unreadable certification receipt ${name}: ${error.message}`,
        );
      }
      // An operator pointing --certification-receipts at a directory that ALSO holds acceptance
      // receipts is an easy mistake (the two live side by side in an evidence pass), and throwing
      // "unsupported certification receipt format" on `adapter.json` explains nothing. A file that
      // positively identifies as another known artifact type is skipped; anything unrecognised
      // still throws, because a malformed CERTIFICATION receipt must never be silently ignored —
      // that would turn a broken receipt into a missing cell, which is the failure this whole
      // module exists to make visible.
      if (parsed?.format === 'knowledge-crib-acceptance-receipt') return undefined;
      const receipt = validateClientCertificationReceipt(parsed, { evidenceRoot: directory });
      const cell = `${receipt.client.id}/${receipt.platform.os}/${receipt.platform.arch}${
        receipt.platform.wsl ? '/wsl' : ''
      }`;
      assert(!cells.has(cell), `duplicate certification cell: ${cell}`);
      cells.add(cell);
      return receipt;
    })
    .filter((receipt) => receipt !== undefined);
}

/** Public state is derived from valid receipts only — there is no hand-maintained override. */
export function certificationSummary(receipts) {
  const result = Object.fromEntries(CERTIFIED_CLIENTS.map((client) => [client, 'not-certified']));
  for (const receipt of receipts) {
    const status =
      receipt.evidence.runtime.status === 'pass'
        ? 'runtime-verified'
        : receipt.evidence.protocol.status === 'pass'
          ? 'protocol-verified'
          : 'configuration-verified';
    const previous = result[receipt.client.id];
    if (
      previous === 'not-certified' ||
      (previous === 'configuration-verified' && status !== 'configuration-verified') ||
      (previous === 'protocol-verified' && status === 'runtime-verified')
    ) {
      result[receipt.client.id] = status;
    }
  }
  return result;
}

export function missingRuntimeCertificationCells(
  receipts,
  platforms = ['darwin', 'linux', 'win32'],
) {
  const observed = new Set(
    receipts
      .filter((receipt) => receipt.evidence.runtime.status === 'pass')
      // A WSL run reports process.platform 'linux' but is not a native-Linux runtime
      // certification; it can never satisfy the native `${client}/linux` cell.
      .filter((receipt) => receipt.platform.wsl !== true)
      .map((receipt) => `${receipt.client.id}/${receipt.platform.os}`),
  );
  return CERTIFIED_CLIENTS.flatMap((client) =>
    platforms
      .filter((platform) => !observed.has(`${client}/${platform}`))
      .map((platform) => `${client}/${platform}`),
  );
}
