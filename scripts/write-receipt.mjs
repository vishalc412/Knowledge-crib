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
 * Usage:
 *   node scripts/write-receipt.mjs <type> --out receipts/install.json \
 *     --command "pnpm installer:smoke" [--artifact <path>...] [--status pass|fail] \
 *     [--p95-ms <n> --workload <name>]
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

export function buildReceipt({ type, argv, now = new Date().toISOString() }) {
  const { policy, sha256: policySha256 } = loadLaunchPolicy();
  if (!policy.receiptTypes.includes(type)) {
    throw new Error(
      `unknown receipt type ${type}; the launch policy declares ${policy.receiptTypes.join(', ')}`,
    );
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
