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
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadClientCertificationReceipts,
  missingRuntimeCertificationCells,
} from './client-certification-evidence.mjs';

export const RELEASE_EVIDENCE_FORMAT_VERSION = 1;

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
    },
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
      required: requiredRuntimeCertification,
      receipts: certificationReceipts.map((receipt) => ({
        client: receipt.client,
        platform: receipt.platform,
        product: receipt.product,
      })),
      missingRuntimeCells,
    },
    acceptance: {
      pass: failures.length === 0 && input.launchGate?.pass === true,
      requiredFailures: failures,
      preregistration: input.launchGate?.preregistration ?? 'docs/bench/launch-gates.md',
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
    manifest.formatVersion === RELEASE_EVIDENCE_FORMAT_VERSION,
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
  return manifest;
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

export async function collectReleaseEvidence(argv = process.argv.slice(2)) {
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
  return buildReleaseEvidence({
    generatedAt: new Date().toISOString(),
    requirePass: argv.includes('--require-pass'),
    git: collectGit(),
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
