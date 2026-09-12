/**
 * Receipt contract for advertised AI-client support.
 *
 * Configuration and protocol probes are useful evidence, but they deliberately cannot promote a
 * client to `runtime-verified`. That label is reserved for a receipt from the vendor client which
 * completed the eight certification legs — configuration, MCP handshake, tool invocation, record,
 * interruption/restart, authorized resume, and foreign-principal exclusion — on the named native
 * operating system, for this exact candidate package, collected under this exact policy.
 *
 * Version 2 is the CERTIFYING schema; version 1 stays readable for diagnostics only. The distinction
 * is not cosmetic. Version 1 recorded interruption and restart as one fact and never separated tool
 * invocation from the handshake, so its receipts cannot express the legs the launch promise now
 * requires — and a receipt that cannot express a required fact cannot certify it. Rather than let a
 * legacy receipt silently satisfy a stricter promise (the A02 failure), only a version-2 receipt may
 * cover a cell; `certifyClientCell` says so by name.
 *
 * The vocabulary is the POLICY's. `CERTIFIED_CLIENTS` and the platform set are re-exported from
 * `launch-policy.mjs` rather than restated here: a second copy of "which clients are advertised" is
 * a second place the promise can drift, and the validator would then happily accept a receipt for a
 * client the policy no longer claims.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { POLICY_CLIENTS, POLICY_PLATFORMS, policyClientVersionFloor } from './launch-policy.mjs';

/** Version 2 certifies. Version 1 is readable so an honest historical failure stays legible. */
export const CERTIFICATION_EVIDENCE_FORMAT_VERSION = 2;
export const SUPPORTED_CERTIFICATION_FORMAT_VERSIONS = [1, 2];

export const CERTIFIED_CLIENTS = [...POLICY_CLIENTS];
const PLATFORM_IDS = new Set(POLICY_PLATFORMS);
const PROTOCOL_SOURCES = new Set(['vendor-client', 'test-client']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

/**
 * The eight legs a certifying receipt must prove. Naming them here — rather than letting each
 * driver invent its own vocabulary — is what makes "missing legs" a structural refusal instead of a
 * gap a reader has to notice.
 */
export const CERTIFICATION_LEGS = [
  'configuration',
  'handshake',
  'toolUse',
  'record',
  'interruption',
  'restart',
  'authorizedResume',
  'foreignPrincipalExclusion',
];
const LEG_STATUSES = ['pass', 'fail', 'blocked', 'not-run'];

/**
 * The legs that assert the VENDOR APPLICATION itself performed the action. A harness that merely
 * speaks the same protocol shape can produce a handshake transcript, and a receipt built from one
 * must never certify a runtime — so these two legs carry an explicit source and only
 * `vendor-client` may satisfy them in the certifying schema.
 */
const VENDOR_ASSERTING_LEGS = ['handshake', 'toolUse'];

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

function nonEmpty(value, label) {
  assert(typeof value === 'string' && value.trim(), `${label} is required`);
}

/** Dotted numeric comparison: `version >= minimum`. Anything unparseable fails closed. */
export function satisfiesMinimumVersion(version, minimum) {
  const parse = (value) =>
    typeof value === 'string' ? value.trim().replace(/^v/, '').split('.').map(Number) : null;
  const actual = parse(version);
  const floor = parse(minimum);
  if (!actual || !floor || actual.some(Number.isNaN) || floor.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(actual.length, floor.length); i++) {
    const a = actual[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The cell a receipt covers: one client on one native platform. */
export function certificationCell(receipt) {
  return `${receipt?.client?.id}/${receipt?.platform?.os}`;
}

/**
 * Normalize any supported receipt onto the ONE leg view.
 *
 * Both schema versions are mapped onto the same eight keys so there is a single implementation of
 * every downstream judgement (`certificationSummary`, `missingRuntimeCertificationCells`,
 * `certifyClientCell`). The mapping is faithful, not generous: every leg is derived from a fact the
 * version actually recorded, and a fact the version never separated stays `not-run` rather than
 * being inferred.
 */
export function receiptLegs(receipt) {
  if (receipt?.formatVersion === 2) {
    return Object.fromEntries(
      CERTIFICATION_LEGS.map((leg) => [leg, receipt.legs?.[leg] ?? { status: 'not-run' }]),
    );
  }
  // Version 1: three evidence blobs. `configuration` is its own leg; `protocol` covered the MCP
  // handshake AND the tool invocation as one combined assertion, so both legs are read from it;
  // the four runtime facts map onto record / interruption / restart / authorized-resume /
  // foreign-principal-exclusion. `interrupted` was a single fact for interruption-and-restart,
  // which is exactly why a v1 receipt cannot certify: the combined claim is weaker than the two
  // separate legs the promise requires.
  const evidence = receipt?.evidence ?? {};
  const protocolPass = evidence.protocol?.status === 'pass';
  const runtimePass = evidence.runtime?.status === 'pass';
  const fromRuntime = (fact) => ({ status: runtimePass && fact === true ? 'pass' : 'not-run' });
  const protocolSource = evidence.protocol?.source;
  // `runtime.interrupted` was ONE fact: "the client was killed and came back". It fills the
  // interruption leg, whose name it shares. It does NOT fill the restart leg — nothing in a
  // version-1 receipt recorded a restart as its own fact, and inferring one from the combined
  // boolean is exactly the generosity that would let a legacy receipt satisfy a stricter promise.
  // So restart stays not-run, and a version-1 receipt therefore tops out at `protocol-verified`:
  // it can never be read, here or in the public matrix, as a runtime pass.
  const neverSeparated = { status: 'not-run' };
  return {
    configuration: { status: evidence.configuration?.status ?? 'not-run' },
    handshake: { status: protocolPass ? 'pass' : 'not-run', source: protocolSource },
    toolUse: { status: protocolPass ? 'pass' : 'not-run', source: protocolSource },
    record: fromRuntime(evidence.runtime?.recordedMemory),
    interruption: fromRuntime(evidence.runtime?.interrupted),
    restart: neverSeparated,
    authorizedResume: fromRuntime(evidence.runtime?.authorizedResume),
    foreignPrincipalExclusion: fromRuntime(evidence.runtime?.foreignPrincipalExcluded),
  };
}

/**
 * The BINDING facts: is this receipt about the build and promise being decided?
 *
 * Split out from `certifyClientCell` because the two failure modes are reported differently. A
 * validator throws — a foreign receipt in an evidence directory is a mistake to stop on. The launch
 * decision NAMES it as a blocker, because the plan requires "a named NO-GO blocker" for each
 * deviation rather than an exception that aborts the aggregate. One implementation, two faces.
 */
export function bindingProblems(receipt, options = {}) {
  const { policy, policySha256, candidate } = options;
  const problems = [];
  const cell = certificationCell(receipt);
  if (candidate?.commit && receipt?.product?.commit !== candidate.commit) {
    problems.push({
      problem: 'client-receipt-foreign-commit',
      cell,
      detail: receipt?.product?.commit,
    });
  }
  if (candidate?.packageSha256 && receipt?.product?.packageSha256 !== candidate.packageSha256) {
    problems.push({
      problem: 'client-receipt-foreign-package',
      cell,
      detail: receipt?.product?.packageSha256,
    });
  }
  if (policySha256 && receipt?.policySha256 !== policySha256) {
    problems.push({
      problem: 'client-receipt-foreign-policy',
      cell,
      detail: receipt?.policySha256,
    });
  }
  // The floor is looked up PER CELL. A client's minimum version can legitimately differ by platform
  // (a date-versioned editor ships different builds per OS), and a client-keyed floor would let the
  // lowest platform's floor certify the highest platform's client.
  const floor = policy
    ? policyClientVersionFloor(policy, receipt?.client?.id, receipt?.platform?.os)
    : undefined;
  if (floor && !satisfiesMinimumVersion(receipt?.client?.version, floor)) {
    problems.push({
      problem: 'client-version-unsupported',
      cell,
      detail: `${receipt?.client?.version ?? 'none'} < ${floor}`,
    });
  }
  return problems;
}

/**
 * Judge ONE receipt as coverage for its cell.
 *
 * Returns `{ok: true, cell}` when the receipt may cover the cell, and
 * `{ok: false, problem, cell, detail}` otherwise. `problem` is a stable code the launch decision
 * turns into a named blocker, so every deviation is reportable without a second vocabulary.
 *
 * The schema check is unconditional and comes FIRST: only the current certifying schema may produce
 * GO, so a version-1 receipt leaves its cell open by name however healthy its legs look. The
 * vendor-asserting legs are checked here too, so a test-client runtime claim fails at the judgement
 * site and not only in the loader that happens to run before it.
 */
export function certifyClientCell(receipt, options = {}) {
  const cell = certificationCell(receipt);
  const fail = (problem, detail) => ({ ok: false, problem, cell, detail });
  if (receipt?.formatVersion !== CERTIFICATION_EVIDENCE_FORMAT_VERSION) {
    return fail(
      'client-cell-uncertified',
      `receipt schema v${receipt?.formatVersion ?? 'unknown'} is not certifying`,
    );
  }
  const [binding] = bindingProblems(receipt, options);
  if (binding) return fail(binding.problem, binding.detail);
  // The vendor-asserting legs must name the client under test as their source. The certifying loader
  // refuses a test-client handshake before such a receipt can reach disk, and enforcing it HERE as
  // well is what makes the rule hold for a receipt that arrives already parsed — which is the mode
  // the launch decision and the public matrix both consume receipts in. Without this, a harness that
  // merely speaks the client's protocol could cover a cell in memory while the on-disk path refused
  // it, and the two consumers of this one judgement would disagree about the same receipt.
  for (const leg of VENDOR_ASSERTING_LEGS) {
    if (receipt?.legs?.[leg]?.source !== 'vendor-client') {
      return fail('client-cell-uncertified', `legs.${leg} was not produced by a vendor-client`);
    }
  }
  // WSL reports process.platform 'linux' from a Windows host. It is not a native Linux or Windows
  // runtime and can never satisfy a native cell, whatever the receipt's other legs show.
  if (receipt?.platform?.wsl === true) {
    return fail('client-cell-uncertified', 'a WSL run is not a native runtime');
  }
  const legs = receiptLegs(receipt);
  const notPassed = CERTIFICATION_LEGS.filter((leg) => legs[leg].status !== 'pass');
  if (notPassed.length > 0) {
    return fail('client-cell-uncertified', `legs not passed: ${notPassed.join(', ')}`);
  }
  // Legs are assertion; the transcript or log is what makes them evidence. A receipt whose legs all
  // read `pass` but which references no runtime artifact is a hand-written claim, and it must not
  // cover a cell even when the validator's disk check is never reached (this function is also the
  // launch decision's entry point, where receipts may arrive already parsed).
  if (receiptArtifacts(receipt).length === 0) {
    return fail(
      'client-cell-uncertified',
      'a certifying receipt references no runtime transcript or log',
    );
  }
  return { ok: true, cell };
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

/** Every transcript/log a receipt declares, with the labels its own field names give it. */
function declaredArtifacts(container, prefix) {
  if (!container || typeof container !== 'object') return [];
  const artifacts = [];
  for (const [pathKey, digestKey] of [
    ['transcriptPath', 'transcriptSha256'],
    ['logPath', 'logSha256'],
  ]) {
    if (container[pathKey] === undefined) continue;
    artifacts.push({
      path: container[pathKey],
      digest: container[digestKey],
      pathLabel: `${prefix}.${pathKey}`,
      digestLabel: `${prefix}.${digestKey}`,
    });
  }
  return artifacts;
}

/**
 * Every transcript/log a receipt declares — the artifacts that make its legs evidence rather than
 * assertion. Pure data inspection, no disk access, so both the validator (which additionally
 * verifies digests against an evidence root) and `certifyClientCell` can ask the same question.
 */
function receiptArtifacts(receipt) {
  return [
    ...declaredArtifacts(receipt?.vendor, 'vendor'),
    ...CERTIFICATION_LEGS.flatMap((leg) => declaredArtifacts(receipt?.legs?.[leg], `legs.${leg}`)),
  ];
}

/** Recompute every declared artifact's digest from disk and refuse a mismatch. */
function verifyArtifacts(artifacts, evidenceRoot) {
  const root = resolve(evidenceRoot);
  for (const artifact of artifacts) {
    sha(artifact.digest, artifact.digestLabel);
    const resolved = resolveEvidenceFile(root, artifact.path, artifact.pathLabel);
    const digest = `sha256:${createHash('sha256').update(readFileSync(resolved)).digest('hex')}`;
    assert(
      artifact.digest === digest,
      `${artifact.digestLabel} does not match the ${artifact.path} file`,
    );
  }
}

function validateVersion1(receipt, options) {
  const passEvidence = (value, label, hashKey) => {
    assert(value && typeof value === 'object', `${label} evidence is required`);
    assert(value.status === 'pass', `${label} evidence must pass`);
    sha(value[hashKey], `${label}.${hashKey}`);
  };
  const optionalEvidence = (value, label, hashKey) => {
    assert(value && typeof value === 'object', `${label} evidence is required`);
    assert(
      value.status === 'pass' || value.status === 'not-run',
      `${label} evidence has an invalid status`,
    );
    if (value.status === 'pass') sha(value[hashKey], `${label}.${hashKey}`);
  };
  /**
   * Protocol probes may be run by the vendor client or by a test client that merely speaks the same
   * protocol shape (a Copilot-shaped harness, for example). The source is required whenever protocol
   * evidence is claimed so the matrix can label test-client rows as evidence-only; a `not-run`
   * placeholder carries no claim and needs no source.
   */
  const protocolEvidence = (value, label, hashKey) => {
    optionalEvidence(value, label, hashKey);
    if (value.status === 'pass') {
      assert(
        PROTOCOL_SOURCES.has(value.source),
        `${label} evidence must declare its source: vendor-client or test-client`,
      );
    }
  };

  assert(receipt.evidence && typeof receipt.evidence === 'object', 'evidence is required');
  passEvidence(receipt.evidence.configuration, 'configuration', 'configSha256');
  protocolEvidence(receipt.evidence.protocol, 'protocol', 'transcriptSha256');
  const runtime = receipt.evidence.runtime;
  optionalEvidence(runtime, 'runtime', 'logSha256');
  if (runtime.status !== 'pass') return;

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
    nonEmpty(runtime.attestation[field], `runtime.attestation.${field}`);
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
  const artifacts = declaredArtifacts(runtime, 'runtime');
  assert(
    artifacts.length > 0,
    'runtime evidence must reference a transcriptPath or logPath under the receipts area',
  );
  assert(
    typeof options.evidenceRoot === 'string' && options.evidenceRoot.trim(),
    'runtime evidence requires an evidence root to verify its transcript or log file',
  );
  verifyArtifacts(artifacts, options.evidenceRoot);
}

function validateVersion2(receipt, options) {
  sha(receipt.policySha256, 'policySha256');
  for (const field of ['driverVersion', 'certificationMode']) {
    nonEmpty(receipt.client[field], `client.${field}`);
  }
  assert(
    CERTIFIED_CLIENTS.includes(receipt.client.certificationMode),
    `unknown certification mode: ${receipt.client.certificationMode}`,
  );
  nonEmpty(receipt.runId, 'runId');

  // Who ran it, where, and when. A digest proves a file is unchanged, never who produced it.
  assert(receipt.capture && typeof receipt.capture === 'object', 'capture is required');
  for (const field of ['hostname', 'operator', 'capturedAt']) {
    nonEmpty(receipt.capture[field], `capture.${field}`);
  }
  assert(
    !Number.isNaN(Date.parse(receipt.capture.capturedAt)),
    'capture.capturedAt must be ISO-8601',
  );

  // Sanitized principal markers. The receipt names the two principals by digest so the exclusion
  // leg is checkable without the marker itself ever entering an artifact.
  assert(
    receipt.principalMarkers && typeof receipt.principalMarkers === 'object',
    'principalMarkers is required',
  );
  sha(receipt.principalMarkers.owner, 'principalMarkers.owner');
  sha(receipt.principalMarkers.foreign, 'principalMarkers.foreign');
  assert(
    receipt.principalMarkers.owner !== receipt.principalMarkers.foreign,
    'the owner and foreign principal markers must differ',
  );

  assert(receipt.legs && typeof receipt.legs === 'object', 'legs is required');
  for (const leg of CERTIFICATION_LEGS) {
    const value = receipt.legs[leg];
    assert(value && typeof value === 'object', `legs.${leg} is required`);
    assert(
      LEG_STATUSES.includes(value.status),
      `legs.${leg}.status is invalid: ${value.status ?? 'unknown'}`,
    );
  }
  // The two vendor-asserting legs state their source unconditionally, and only `vendor-client` may
  // satisfy them. This is the structural refusal of a test-client runtime claim: a harness that
  // speaks the protocol cannot produce a version-2 receipt at all, so it cannot leave a reader to
  // notice that the transcript came from somewhere other than the client under test.
  for (const leg of VENDOR_ASSERTING_LEGS) {
    assert(
      receipt.legs[leg].source === 'vendor-client',
      `legs.${leg} must be produced by a vendor-client`,
    );
  }

  const notPassed = CERTIFICATION_LEGS.filter((leg) => receipt.legs[leg].status !== 'pass');
  if (notPassed.length > 0) {
    // A receipt that could not complete a leg must SAY what stopped it. Silence here reads as
    // "not attempted", which is a different fact from "the account was not signed in".
    nonEmpty(receipt.blockedReason, `blockedReason (legs not passed: ${notPassed.join(', ')})`);
  }

  const artifacts = receiptArtifacts(receipt);
  const certifying = notPassed.length === 0;
  if (certifying) {
    // A certifying receipt is a claim that a real vendor process ran on this host. That claim is
    // only evidence if the transcript or log it points at exists and still hashes to what the
    // receipt recorded — otherwise it is a hand-written assertion.
    assert(
      artifacts.length > 0,
      'a certifying receipt must reference a vendor transcript or log under the receipts area',
    );
    // And the receipt must NAME the vendor executable that produced it. A transcript says what was
    // said, never which binary said it; without the process identity a run by a harness that merely
    // speaks the client's protocol is indistinguishable from the client under test.
    nonEmpty(receipt.vendor?.processIdentity, 'vendor.processIdentity');
    assert(
      typeof options.evidenceRoot === 'string' && options.evidenceRoot.trim(),
      'a certifying receipt requires an evidence root to verify its transcript or log file',
    );
  }
  if (
    artifacts.length > 0 &&
    typeof options.evidenceRoot === 'string' &&
    options.evidenceRoot.trim()
  ) {
    verifyArtifacts(artifacts, options.evidenceRoot);
  }
}

/**
 * Validate the complete receipt before it may influence public support language.
 *
 * `options.evidenceRoot` is the receipts area (the directory the receipts are loaded from). It is
 * required whenever a receipt claims a certification pass, so the referenced transcript or log file
 * can be located and its digest verified — a hand-typed receipt with no artifact behind it cannot
 * certify a runtime.
 *
 * `options.policy` / `options.policySha256` / `options.candidate` are optional and, when supplied,
 * refuse a receipt bound to another policy, commit, package or client version. The launch decision
 * uses `certifyClientCell` directly so it can report the same finding as a named blocker instead of
 * an exception; this is the same judgement in the mode a validator needs.
 */
export function validateClientCertificationReceipt(receipt, options = {}) {
  assert(receipt && typeof receipt === 'object', 'receipt must be an object');
  assert(
    receipt.format === 'knowledge-crib-client-certification',
    'unsupported certification receipt format',
  );
  assert(
    SUPPORTED_CERTIFICATION_FORMAT_VERSIONS.includes(receipt.formatVersion),
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
  nonEmpty(receipt.client.version, 'client.version');
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
  nonEmpty(receipt.platform.arch, 'platform.arch');
  assert(
    typeof receipt.platform.node === 'string' && /^v\d+/.test(receipt.platform.node),
    'platform.node must be a Node release starting with v, for example v22.23.1',
  );

  if (receipt.formatVersion === 2) validateVersion2(receipt, options);
  else validateVersion1(receipt, options);

  const [binding] = bindingProblems(receipt, options);
  if (binding)
    throw new CertificationEvidenceError(
      `${binding.problem}:${binding.cell}:${binding.detail ?? ''}`,
    );
  return receipt;
}

/**
 * Load a directory atomically from the release point of view: any malformed or duplicate cell
 * invalidates the whole evidence set rather than allowing a best-effort promotion claim.
 */
export function loadClientCertificationReceipts(directory) {
  if (!existsSync(directory)) return [];
  const cells = new Set();
  const runIds = new Set();
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
      const cell = `${certificationCell(receipt)}/${receipt.platform.arch}${
        receipt.platform.wsl ? '/wsl' : ''
      }`;
      assert(!cells.has(cell), `duplicate certification cell: ${cell}`);
      cells.add(cell);
      // Two cells may legitimately share a host binary (a Copilot and a VS Code run, say), but each
      // is a separate RUN. A reused run id means one run's evidence is being counted twice.
      if (receipt.formatVersion === 2) {
        assert(!runIds.has(receipt.runId), `duplicate certification run id: ${receipt.runId}`);
        runIds.add(receipt.runId);
      }
      return receipt;
    })
    .filter((receipt) => receipt !== undefined);
}

/** Public state is derived from valid receipts only — there is no hand-maintained override. */
export function certificationSummary(receipts) {
  const result = Object.fromEntries(CERTIFIED_CLIENTS.map((client) => [client, 'not-certified']));
  for (const receipt of receipts) {
    const status = certificationStatus(receipt);
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

/**
 * How strongly ONE receipt supports its client. One implementation, so the public summary and the
 * matrix cannot disagree about what a receipt proves.
 *
 * The runtime tier needs all eight legs — including the interruption/restart pair v1 recorded as a
 * single fact, which is precisely why a v1 receipt can reach `protocol-verified` but never
 * `runtime-verified`.
 */
export function certificationStatus(receipt) {
  const legs = receiptLegs(receipt);
  if (CERTIFICATION_LEGS.every((leg) => legs[leg].status === 'pass')) return 'runtime-verified';
  if (VENDOR_ASSERTING_LEGS.every((leg) => legs[leg].status === 'pass')) return 'protocol-verified';
  return legs.configuration.status === 'pass' ? 'configuration-verified' : 'not-certified';
}

/**
 * The client/platform cells that cannot show a genuine native vendor runtime.
 *
 * A receipt only counts when the CURRENT certifying schema produced it. Schema-1 receipts stay
 * loadable so a historical failure remains readable, but they leave their cell open by name —
 * they cannot express the legs the promise requires.
 */
export function missingRuntimeCertificationCells(receipts, platforms = POLICY_PLATFORMS) {
  const observed = new Set(
    receipts
      .filter((receipt) => certifyClientCell(receipt).ok)
      .map((receipt) => certificationCell(receipt)),
  );
  return CERTIFIED_CLIENTS.flatMap((client) =>
    platforms
      .filter((platform) => !observed.has(`${client}/${platform}`))
      .map((platform) => `${client}/${platform}`),
  );
}
