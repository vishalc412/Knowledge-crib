/**
 * Receipt contract for advertised AI-client support.
 *
 * Configuration and protocol probes are useful evidence, but they deliberately cannot promote a
 * client to `runtime-verified`. That label is reserved for a receipt from the vendor client which
 * completed record -> interruption/restart -> authorized resume on the named operating system.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

/** Validate the complete receipt before it may influence public support language. */
export function validateClientCertificationReceipt(receipt) {
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
    'product.commit must be a full git commit',
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
    typeof receipt.platform.arch === 'string' && receipt.platform.arch.trim(),
    'platform.arch is required',
  );
  assert(
    typeof receipt.platform.node === 'string' && /^v\d+/.test(receipt.platform.node),
    'platform.node is required',
  );
  assert(receipt.evidence && typeof receipt.evidence === 'object', 'evidence is required');
  passEvidence(receipt.evidence.configuration, 'configuration', 'configSha256');
  optionalEvidence(receipt.evidence.protocol, 'protocol', 'transcriptSha256');
  const runtime = receipt.evidence.runtime;
  optionalEvidence(runtime, 'runtime', 'logSha256');
  if (runtime.status === 'pass') {
    assert(
      runtime.source === 'vendor-client',
      'runtime evidence must be produced by a vendor-client',
    );
    assert(runtime.recordedMemory === true, 'runtime evidence must record memory');
    assert(runtime.interrupted === true, 'runtime evidence must include interruption/restart');
    assert(runtime.authorizedResume === true, 'runtime evidence must include authorized resume');
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
      const receipt = validateClientCertificationReceipt(parsed);
      const cell = `${receipt.client.id}/${receipt.platform.os}/${receipt.platform.arch}`;
      assert(!cells.has(cell), `duplicate certification cell: ${cell}`);
      cells.add(cell);
      return receipt;
    });
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
      .map((receipt) => `${receipt.client.id}/${receipt.platform.os}`),
  );
  return CERTIFIED_CLIENTS.flatMap((client) =>
    platforms
      .filter((platform) => !observed.has(`${client}/${platform}`))
      .map((platform) => `${client}/${platform}`),
  );
}
