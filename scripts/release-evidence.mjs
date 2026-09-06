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

export const RELEASE_EVIDENCE_FORMAT_VERSION = 1;

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** Construct the portable contract independently from machine collection. */
export function buildReleaseEvidence(input) {
  const modelReady = input.embedder?.state === 'installed';
  const gateFailures = (input.launchGate?.gates ?? []).filter((g) => !g.pass).map((g) => g.id);
  const failures = [
    ...(input.git?.dirty ? ['clean-commit'] : []),
    ...(!modelReady ? ['semantic-model'] : []),
    ...gateFailures,
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
    gates: input.launchGate?.gates ?? [],
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
  return buildReleaseEvidence({
    generatedAt: new Date().toISOString(),
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
