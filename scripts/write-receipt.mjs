import { execFileSync } from 'node:child_process';
/**
 * Write ONE typed acceptance receipt.
 *
 * A release manifest used to infer install/browser/recovery coverage from a unit-test total, which
 * is how a workflow could pass while never running any of them. Each of those checks now writes its
 * own receipt, from the step that actually ran it, AFTER it succeeded — so the receipt's existence
 * means the command completed, not that it was scheduled. The launch decision requires one receipt
 * per policy receipt type and refuses the missing ones by name.
 *
 * Two vocabularies, one writer. An ACCEPTANCE type (`install`, `browser`, …) is collected once per
 * OS/Node cell; a GLOBAL type (`fuzz-deep`) is collected once per candidate. Both are policy-
 * declared and both are refused if the policy does not know the name — a receipt for a type nobody
 * requires is not evidence, it is a typo that looks like progress.
 *
 * Usage:
 *   node scripts/write-receipt.mjs <type> --out receipts/install.json \
 *     --command "pnpm installer:smoke" [--artifact <path>...] [--status pass|fail] \
 *     [--package <candidate-tarball>] [--p95-ms <n>] [--workload <name>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy } from './launch-policy.mjs';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function flags(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[++i]);
  return out.filter(Boolean);
}

/**
 * Build a receipt envelope. Exported so a check that ALREADY knows what it measured (the fuzz
 * harness, which owns its own transcript and its own per-extractor results) can write its receipt
 * in-process rather than re-describing itself to a second script on a command line — a description
 * that could disagree with what actually ran.
 *
 * `details` carries check-specific facts (a deep sweep's seed, iterations, extractor list and
 * failures). It is nested rather than spread so a detail can never overwrite an envelope field like
 * `status` or `candidateCommit`: the envelope is the part the decision reads structurally, and a
 * producer must not be able to rewrite it by choosing a field name.
 */
export function buildReceipt({ type, argv, now = new Date().toISOString(), details }) {
  const { policy, sha256: policySha256 } = loadLaunchPolicy();
  const known = [...policy.receiptTypes, ...policy.globalReceiptTypes];
  if (!known.includes(type)) {
    throw new Error(`unknown receipt type ${type}; the launch policy declares ${known.join(', ')}`);
  }
  const artifacts = flags(argv, '--artifact').map((path) => {
    if (!existsSync(path)) throw new Error(`receipt artifact does not exist: ${path}`);
    return { path, sha256: sha256(readFileSync(path)) };
  });
  const status = flag(argv, '--status', 'pass');
  if (status === 'pass' && artifacts.length === 0) {
    throw new Error(
      `a passing ${type} receipt must reference at least one --artifact; a claim with nothing behind it is not evidence`,
    );
  }
  // The candidate ARTIFACT, not the candidate source. A receipt that binds only to a commit cannot
  // notice that the tarball it certifies was rebuilt — and a rebuilt tarball is a different product
  // even when the commit is identical (`pnpm pack` is not byte-reproducible here).
  const packagePath = flag(argv, '--package');
  if (packagePath && !existsSync(packagePath)) {
    throw new Error(`receipt package does not exist: ${packagePath}`);
  }
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    commit = undefined;
  }
  const p95 = flag(argv, '--p95-ms');
  return {
    format: 'knowledge-crib-acceptance-receipt',
    formatVersion: 1,
    type,
    status,
    recordedAt: now,
    candidateCommit: commit,
    ...(packagePath ? { candidatePackageSha256: sha256(readFileSync(packagePath)) } : {}),
    policySha256,
    command: flag(argv, '--command', ''),
    platform: { os: process.platform, arch: process.arch, node: process.version },
    runner:
      process.env.GITHUB_ACTIONS === 'true'
        ? { provider: 'github-actions', runId: process.env.GITHUB_RUN_ID }
        : { provider: 'local', host: hostname() },
    artifacts,
    ...(p95 !== undefined ? { p95Ms: Number(p95) } : {}),
    ...(flag(argv, '--workload') ? { workload: flag(argv, '--workload') } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const type = argv[0];
  if (!type || type.startsWith('--')) {
    process.stderr.write('usage: write-receipt.mjs <type> --out <path> --command "..."\n');
    process.exitCode = 1;
    return;
  }
  const out = resolve(flag(argv, '--out', `receipts/${type}.json`));
  const receipt = buildReceipt({ type, argv });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${type} receipt (${receipt.status}) -> ${out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
