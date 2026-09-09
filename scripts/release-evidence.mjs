/**
 * F07 release evidence manifest.
 *
 * The release gate previously proved that tests executed, while the separately printed memory
 * launch report could contain failed required gates and still exit zero. This command always writes
 * a self-contained receipt first, then exits non-zero under --require-pass when the supported
 * semantic tier is absent or any frozen G1-G8 gate is red.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { cpus, hostname, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadClientCertificationReceipts,
  missingRuntimeCertificationCells,
} from './client-certification-evidence.mjs';
import { loadLaunchPolicy } from './launch-policy.mjs';

/**
 * Schema 2 adds the CANDIDATE IDENTITY that schema 1 left implicit: the shipped package digest, the
 * launch-policy digest the run was judged under, the runner provenance, the command and its exit
 * code, the wall-clock window, and the typed receipts (install, native-service, browser, recovery,
 * security-privacy, freshness, adapter) that a unit-test total was previously allowed to stand in
 * for. Schema 1 manifests stay LOADABLE so honest historical failures can still be read, but they
 * are non-certifying: they cannot express the facts a launch decision now has to check.
 */
export const RELEASE_EVIDENCE_FORMAT_VERSION = 2;
/** Schema versions this reader can parse at all (the newest is the only certifying one). */
export const SUPPORTED_EVIDENCE_FORMAT_VERSIONS = [1, 2];

/**
 * WP9.2 — the frozen gate set the launch decision is allowed to reason about. A report with a
 * deleted gate still computes pass=true via gates.every(), so the evidence builder must fail on
 * any gate id outside this exact set (missing, extra or duplicated).
 */
export const REQUIRED_GATE_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT_ID = /^[a-f0-9]{40}$/;

/** Mirrors CertificationEvidenceError: a structural refusal, never a quality verdict. */
export class ReleaseEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseEvidenceError';
  }
}

function assertEvidence(condition, message) {
  if (!condition) throw new ReleaseEvidenceError(message);
}

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** Construct the portable contract independently from machine collection. */
export function buildReleaseEvidence(input) {
  const modelReady = input.embedder?.state === 'installed';
  const gates = input.launchGate?.gates ?? [];
  const gateFailures = gates.filter((g) => !g.pass).map((g) => g.id);
  const seenGateIds = new Set();
  const duplicateGateIds = new Set();
  for (const gate of gates) {
    if (seenGateIds.has(gate.id)) duplicateGateIds.add(gate.id);
    seenGateIds.add(gate.id);
  }
  const gateSetFailures = [
    ...REQUIRED_GATE_IDS.filter((id) => !seenGateIds.has(id)).map((id) => `gate-set:missing:${id}`),
    ...[...seenGateIds]
      .filter((id) => !REQUIRED_GATE_IDS.includes(id))
      .map((id) => `gate-set:extra:${id}`),
    ...[...duplicateGateIds].map((id) => `gate-set:duplicate:${id}`),
  ];
  const requirePass = input.requirePass === true;
  const requiredRuntimeCertification = input.requireRuntimeCertification === true;
  const certificationReceipts = input.certificationReceipts ?? [];
  const missingRuntimeCells = requiredRuntimeCertification
    ? missingRuntimeCertificationCells(certificationReceipts, input.certificationPlatforms)
    : [];
  const failures = [
    ...(input.git?.dirty ? ['clean-commit'] : []),
    ...(!modelReady ? ['semantic-model'] : []),
    ...(modelReady && input.embedder?.modelVersion === undefined ? ['model-revision'] : []),
    ...(requirePass && !input.launchGate?.scorerVersion ? ['scorer-identity'] : []),
    ...gateFailures,
    ...gateSetFailures,
    ...(missingRuntimeCells.length > 0 ? ['runtime-certification'] : []),
  ];
  return {
    format: 'knowledge-crib-release-evidence',
    formatVersion: RELEASE_EVIDENCE_FORMAT_VERSION,
    generatedAt: input.generatedAt,
    // The candidate this run is evidence FOR. Every downstream check compares against these three
    // facts, so a manifest can no longer be silently applied to a different build (A02).
    candidate: {
      commit: input.git?.commit,
      dirty: input.git?.dirty === true,
      packageSha256: input.packageSha256,
      policySha256: input.policySha256,
    },
    product: {
      name: 'knowledge-crib',
      packages: input.packages,
      schemas: input.schemas,
      clients: input.clients,
    },
    reproducibility: {
      git: input.git,
      platform: input.platform,
      workload: input.workload,
      runner: input.runner,
    },
    // What actually ran, and whether it finished. A manifest generated mid-workflow cannot claim
    // the workflow completed: the exit code and the end timestamp are recorded, not inferred.
    run: {
      command: input.command,
      exitCode: input.exitCode,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    },
    receipts: input.receipts ?? {},
    artifacts: input.artifacts ?? [],
    retrieval: {
      mode: modelReady ? 'on-device-semantic' : 'lexical-fallback',
      scorer: input.launchGate?.scorerVersion ?? 'unknown',
      model:
        input.embedder?.state === 'installed'
          ? {
              id: input.embedder.modelId,
              version: input.embedder.modelVersion,
              embedderId: input.embedder.embedderId,
              dim: input.embedder.dim,
              manifestSha256: input.embedder.manifestSha256,
            }
          : {
              state: input.embedder?.state ?? 'missing',
              reason: input.embedder?.reason ?? 'absent',
            },
    },
    gates,
    certification: {
      // `required` is retained as a RECORD of how this collection was invoked. It is deliberately
      // NOT a switch the launch decision reads: evidence must not select the requirements it is
      // judged against (A01). The decision recomputes coverage from the launch policy.
      invokedWithRuntimeRequirement: requiredRuntimeCertification,
      receipts: certificationReceipts.map((receipt) => ({
        client: receipt.client,
        platform: receipt.platform,
        product: receipt.product,
        policySha256: receipt.policySha256,
        runtimeStatus: receipt.evidence?.runtime?.status ?? 'unknown',
      })),
      // A convenience summary for humans reading the file; the decision recomputes it rather than
      // trusting it, because a precomputed "nothing missing" is exactly what a tampered manifest
      // would claim.
      missingRuntimeCells,
    },
    acceptance: {
      pass: failures.length === 0 && input.launchGate?.pass === true,
      requiredFailures: failures,
      preregistration: input.launchGate?.preregistration ?? 'docs/bench/launch-gates.md',
      // Stated in the artifact itself so a reader cannot mistake a collection verdict for approval.
      note: 'DERIVED OUTPUT of this collection run — not a launch approval. Only scripts/launch-decision.mjs, recomputing from scripts/launch-policy.json, may print a production GO.',
    },
  };
}

export function requiredGateFailures(manifest) {
  return [...manifest.acceptance.requiredFailures];
}

/**
 * WP9.1 — structural validation of a release-evidence manifest BEFORE any launch decision reads
 * acceptance.pass or requiredFailures verbatim. This refuses tampered, omission-ridden and
 * duplicate-ridden manifests; it deliberately does NOT recompute the verdict — a red-but-honest
 * manifest must stay loadable so the decision can report NO-GO with its real blockers. The two
 * acceptance consistency checks below close the original gap: a manifest edited to
 * acceptance.pass=true can no longer survive while its own gates array still shows a failure.
 */
export function validateReleaseEvidence(manifest) {
  assertEvidence(
    manifest && typeof manifest === 'object',
    'release evidence manifest must be an object',
  );
  assertEvidence(
    manifest.format === 'knowledge-crib-release-evidence',
    `unsupported release evidence format: ${manifest.format}`,
  );
  assertEvidence(
    SUPPORTED_EVIDENCE_FORMAT_VERSIONS.includes(manifest.formatVersion),
    `unsupported release evidence version: ${manifest.formatVersion}`,
  );
  assertEvidence(
    manifest.reproducibility?.git && typeof manifest.reproducibility.git === 'object',
    'reproducibility.git is required',
  );
  const git = manifest.reproducibility.git;
  assertEvidence(
    typeof git.commit === 'string' && COMMIT_ID.test(git.commit),
    'reproducibility.git.commit must be a full git commit',
  );
  assertEvidence(
    typeof git.dirtyDigest === 'string' && SHA256_DIGEST.test(git.dirtyDigest),
    'reproducibility.git.dirtyDigest must be a sha256 digest',
  );
  assertEvidence(
    manifest.retrieval?.model && typeof manifest.retrieval.model === 'object',
    'retrieval.model is required',
  );
  if (manifest.retrieval.model.manifestSha256 !== undefined) {
    assertEvidence(
      typeof manifest.retrieval.model.manifestSha256 === 'string' &&
        SHA256_DIGEST.test(manifest.retrieval.model.manifestSha256),
      'retrieval.model.manifestSha256 must be a sha256 digest',
    );
  }
  assertEvidence(
    manifest.product?.schemas && typeof manifest.product.schemas === 'object',
    'product.schemas is required',
  );
  for (const field of ['soul', 'memory', 'evidenceManifest']) {
    assertEvidence(
      manifest.product.schemas[field] !== undefined,
      `product.schemas.${field} is required`,
    );
  }
  assertEvidence(Array.isArray(manifest.gates), 'gates must be an array');
  const gateIds = new Set();
  for (const gate of manifest.gates) {
    assertEvidence(gate && typeof gate === 'object', 'gates entries must be objects');
    assertEvidence(typeof gate.id === 'string' && gate.id, 'gates entries must carry an id');
    assertEvidence(!gateIds.has(gate.id), `duplicate gate id in gates: ${gate.id}`);
    gateIds.add(gate.id);
  }
  assertEvidence(
    manifest.acceptance && typeof manifest.acceptance === 'object',
    'acceptance is required',
  );
  assertEvidence(
    typeof manifest.acceptance.pass === 'boolean',
    'acceptance.pass must be a boolean',
  );
  assertEvidence(
    Array.isArray(manifest.acceptance.requiredFailures),
    'acceptance.requiredFailures must be an array',
  );
  if (manifest.acceptance.pass === true) {
    const redGate = manifest.gates.find((gate) => gate.pass !== true);
    assertEvidence(!redGate, `acceptance.pass is true but gate ${redGate?.id} failed`);
    assertEvidence(
      manifest.acceptance.requiredFailures.length === 0,
      'acceptance.pass is true but acceptance.requiredFailures is non-empty',
    );
  }
  if (manifest.formatVersion >= 2) validateEvidenceIdentity(manifest);
  return manifest;
}

/**
 * The schema-2 identity block: who this evidence is FOR and what actually produced it.
 *
 * Structural only — presence and shape. Whether the values MATCH the candidate under decision is a
 * question for the decision (which knows the candidate); a validator that also judged identity
 * would have to be handed the candidate everywhere it is used, including for diagnostics.
 */
function validateEvidenceIdentity(manifest) {
  const candidate = manifest.candidate;
  assertEvidence(candidate && typeof candidate === 'object', 'candidate is required in schema 2');
  assertEvidence(
    typeof candidate.commit === 'string' && COMMIT_ID.test(candidate.commit),
    'candidate.commit must be a full git commit',
  );
  assertEvidence(typeof candidate.dirty === 'boolean', 'candidate.dirty must be a boolean');
  assertEvidence(
    typeof candidate.packageSha256 === 'string' && SHA256_DIGEST.test(candidate.packageSha256),
    'candidate.packageSha256 must be a sha256 digest of the shipped package',
  );
  assertEvidence(
    typeof candidate.policySha256 === 'string' && SHA256_DIGEST.test(candidate.policySha256),
    'candidate.policySha256 must be the sha256 of the launch policy this run was judged under',
  );
  assertEvidence(
    candidate.commit === manifest.reproducibility?.git?.commit,
    'candidate.commit disagrees with reproducibility.git.commit',
  );

  const platform = manifest.reproducibility?.platform;
  assertEvidence(platform && typeof platform === 'object', 'reproducibility.platform is required');
  for (const field of ['os', 'arch', 'node']) {
    assertEvidence(
      typeof platform[field] === 'string' && platform[field].trim(),
      `reproducibility.platform.${field} is required`,
    );
  }
  const runner = manifest.reproducibility?.runner;
  assertEvidence(runner && typeof runner === 'object', 'reproducibility.runner is required');
  assertEvidence(
    typeof runner.provider === 'string' && runner.provider.trim(),
    'reproducibility.runner.provider is required (for example github-actions or local)',
  );

  const run = manifest.run;
  assertEvidence(run && typeof run === 'object', 'run is required in schema 2');
  assertEvidence(
    typeof run.command === 'string' && run.command.trim(),
    'run.command is required — evidence must name what produced it',
  );
  assertEvidence(
    Number.isInteger(run.exitCode),
    'run.exitCode is required — a run with no exit code did not finish',
  );
  for (const field of ['startedAt', 'endedAt']) {
    assertEvidence(
      typeof run[field] === 'string' && !Number.isNaN(Date.parse(run[field])),
      `run.${field} must be an ISO-8601 timestamp`,
    );
  }
  assertEvidence(
    Date.parse(run.endedAt) >= Date.parse(run.startedAt),
    'run.endedAt precedes run.startedAt',
  );

  assertEvidence(
    manifest.receipts && typeof manifest.receipts === 'object' && !Array.isArray(manifest.receipts),
    'receipts must be an object keyed by receipt type',
  );
  for (const [type, receipt] of Object.entries(manifest.receipts)) {
    assertEvidence(receipt && typeof receipt === 'object', `receipts.${type} must be an object`);
    assertEvidence(
      ['pass', 'fail', 'not-run'].includes(receipt.status),
      `receipts.${type}.status must be pass, fail or not-run`,
    );
    if (receipt.status !== 'pass') continue;
    assertEvidence(
      Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0,
      `receipts.${type} claims a pass but references no artifact`,
    );
    for (const artifact of receipt.artifacts) {
      assertEvidence(
        artifact && typeof artifact.path === 'string' && artifact.path.trim(),
        `receipts.${type} artifact needs a path`,
      );
      assertEvidence(
        typeof artifact.sha256 === 'string' && SHA256_DIGEST.test(artifact.sha256),
        `receipts.${type} artifact ${artifact?.path} needs a sha256 digest`,
      );
    }
  }

  assertEvidence(Array.isArray(manifest.artifacts), 'artifacts must be an array');
  for (const artifact of manifest.artifacts) {
    assertEvidence(
      artifact && typeof artifact.path === 'string' && artifact.path.trim(),
      'artifacts entries need a path',
    );
    assertEvidence(
      typeof artifact.sha256 === 'string' && SHA256_DIGEST.test(artifact.sha256),
      `artifacts entry ${artifact?.path} needs a sha256 digest`,
    );
  }

  for (const gate of manifest.gates) {
    assertEvidence(
      typeof gate.measured === 'number',
      `gate ${gate.id} must carry its measured value in schema 2`,
    );
    assertEvidence(
      typeof gate.threshold === 'number',
      `gate ${gate.id} must carry the threshold it was judged against`,
    );
    assertEvidence(
      gate.comparison === 'gte' || gate.comparison === 'lte',
      `gate ${gate.id} must carry its comparison direction`,
    );
    assertEvidence(typeof gate.pass === 'boolean', `gate ${gate.id} must carry a boolean pass`);
  }
}

/** Atomic publication: a release process never observes a half-written evidence file. */
export function writeReleaseEvidence(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function collectGit() {
  const dirtyPaths = git(['status', '--porcelain=v1'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  return {
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']) || '(detached)',
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
    dirtyDigest: sha256(dirtyPaths.join('\n')),
  };
}

function collectPackages() {
  const files = ['package.json'];
  for (const dir of readdirSync('packages', { withFileTypes: true })) {
    if (dir.isDirectory() && existsSync(`packages/${dir.name}/package.json`)) {
      files.push(`packages/${dir.name}/package.json`);
    }
  }
  return Object.fromEntries(
    files
      .map((path) => JSON.parse(readFileSync(path, 'utf8')))
      .filter((pkg) => pkg.name && pkg.version)
      .map((pkg) => [pkg.name, pkg.version])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function collectSchemas() {
  const memory = readdirSync('packages/memory/src/schema')
    .map((name) => /^record-v(\d+)\.schema\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
  let soul = 'unknown';
  const committed = '.crib/graph/manifest.json';
  if (existsSync(committed))
    soul = JSON.parse(readFileSync(committed, 'utf8')).schemaVersion ?? soul;
  return { soul, memory, evidenceManifest: String(RELEASE_EVIDENCE_FORMAT_VERSION) };
}

function parseClients(argv) {
  const clients = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--client') continue;
    const value = argv[++i] ?? '';
    const split = value.lastIndexOf('@');
    if (split <= 0 || split === value.length - 1) {
      throw new Error('--client must be name@version');
    }
    clients[value.slice(0, split)] = value.slice(split + 1);
  }
  return clients;
}

function certificationOptions(argv) {
  const receiptIndex = argv.indexOf('--certification-receipts');
  const receiptDirectory = resolve(
    receiptIndex >= 0
      ? (argv[receiptIndex + 1] ?? 'docs/launch/client-certification-receipts')
      : 'docs/launch/client-certification-receipts',
  );
  const platformIndex = argv.indexOf('--certification-platforms');
  const certificationPlatforms =
    platformIndex >= 0
      ? (argv[platformIndex + 1] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;
  return {
    requireRuntimeCertification: argv.includes('--require-runtime-certification'),
    certificationReceipts: loadClientCertificationReceipts(receiptDirectory),
    certificationPlatforms,
  };
}

async function collectEmbedder() {
  const { embedHomeDir, loadInstalledEmbedder, verifyInstalledEmbed } = await import(
    '../packages/core/dist/index.js'
  );
  const home = embedHomeDir();
  const verification = verifyInstalledEmbed(home);
  if (!verification.present) return { state: 'missing', reason: 'no installed embed manifest' };
  if (!verification.ok || !verification.manifest) {
    return { state: 'invalid', reason: verification.problems.join('; ') };
  }
  try {
    const embedder = await loadInstalledEmbedder(home);
    if (!embedder) return { state: 'missing', reason: 'manifest disappeared during load' };
    const manifestText = readFileSync(resolve(home, 'manifest.json'));
    return {
      state: 'installed',
      modelId: verification.manifest.modelId,
      modelVersion: verification.manifest.modelVersion,
      embedderId: embedder.id,
      dim: embedder.dim(),
      manifestSha256: sha256(manifestText),
      instance: embedder,
    };
  } catch (error) {
    return { state: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** `--flag value` lookup. */
function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

/**
 * The shipped package's digest. Evidence that cannot name the bytes it is evidence FOR cannot bind
 * a client receipt to a candidate, so this is collected, never assumed: an absent package leaves
 * the field undefined and the validator refuses the manifest.
 */
function collectPackageDigest(argv) {
  const explicit = flag(argv, '--package');
  const candidates = explicit ? [explicit] : [];
  if (!explicit && existsSync('dist/installers')) {
    for (const dir of readdirSync('dist/installers', { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const tarball = `dist/installers/${dir.name}/${dir.name}.tgz`;
      if (existsSync(tarball)) candidates.push(tarball);
    }
  }
  for (const path of candidates) {
    if (existsSync(path)) return { packageSha256: sha256(readFileSync(path)), packagePath: path };
  }
  return {};
}

/** Where this ran. A local run says so rather than dressing itself as CI. */
function collectRunner() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    return {
      provider: 'github-actions',
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      workflow: process.env.GITHUB_WORKFLOW,
      runUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : undefined,
    };
  }
  return { provider: 'local', host: hostname() };
}

/**
 * Typed receipts collected from a directory: one JSON file per receipt type, each written by the
 * step that actually ran it. Loading them here (rather than inferring them from a test total) is
 * what makes a missing install/browser/recovery proof an actionable blocker instead of silence.
 */
function collectReceipts(argv) {
  const directory = resolve(flag(argv, '--receipts', 'receipts'));
  if (!existsSync(directory)) return {};
  const receipts = {};
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
    const type = parsed.type ?? name.slice(0, -5);
    receipts[type] = parsed;
  }
  return receipts;
}

export async function collectReleaseEvidence(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  const embedder = await collectEmbedder();
  const { runLaunchGate } = await import('../packages/memory/dist/bench/launch-eval.js');
  const launchGate = runLaunchGate(
    undefined,
    embedder.state === 'installed'
      ? { strategy: 'semantic-only', embedder: embedder.instance }
      : { strategy: 'lexical-only' },
  );
  const { instance: _instance, ...embedReceipt } = embedder;
  const certification = certificationOptions(argv);
  const { policy: _policy, sha256: policySha256 } = loadLaunchPolicy();
  const { packageSha256, packagePath } = collectPackageDigest(argv);
  return buildReleaseEvidence({
    generatedAt: new Date().toISOString(),
    requirePass: argv.includes('--require-pass'),
    git: collectGit(),
    policySha256,
    ...(packageSha256 ? { packageSha256 } : {}),
    runner: collectRunner(),
    command: flag(argv, '--command', `node scripts/release-evidence.mjs ${argv.join(' ')}`.trim()),
    exitCode: 0,
    startedAt,
    endedAt: new Date().toISOString(),
    receipts: collectReceipts(argv),
    artifacts: packagePath ? [{ path: packagePath, sha256: packageSha256 }] : [],
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      ramBytes: totalmem(),
    },
    packages: collectPackages(),
    schemas: collectSchemas(),
    clients: parseClients(argv),
    embedder: embedReceipt,
    ...certification,
    launchGate,
    workload: {
      name: 'memory-launch-corpus',
      queries: launchGate.corpus.queries,
      records: launchGate.corpus.records,
      scale: launchGate.scale,
    },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = resolve(
    outIdx >= 0 ? (argv[outIdx + 1] ?? 'release-evidence.json') : 'release-evidence.json',
  );
  const manifest = await collectReleaseEvidence(argv);
  writeReleaseEvidence(out, manifest);
  process.stdout.write(
    `release evidence: ${manifest.acceptance.pass ? 'PASS' : 'FAIL'} -> ${out}\n` +
      `  scorer: ${manifest.retrieval.scorer}\n` +
      `  required failures: ${manifest.acceptance.requiredFailures.join(', ') || 'none'}\n`,
  );
  if (argv.includes('--require-pass') && !manifest.acceptance.pass) process.exitCode = 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
