/**
 * Run every acceptance check the launch policy requires a receipt for, in one pass, against the
 * CURRENT candidate — then write one typed receipt per check from the step that actually ran it.
 *
 * Why this exists as a script rather than a runbook: receipts are candidate-bound, so any product
 * change invalidates the whole set and they must ALL be recollected together at the final commit.
 * Doing that by hand is how a stale receipt survives a rebuild and certifies a candidate that no
 * longer exists. One command, one candidate, one timestamped set.
 *
 * A check that fails still writes its receipt, with status "fail". That is deliberate: the decision
 * must be able to say WHICH acceptance failed, and a missing receipt and a failed one are different
 * facts. What it will not do is skip a check and leave the type absent — absence is a blocker.
 *
 * The vendor client cell is NOT collected here. It needs the real vendor application, signed in, on
 * a real host (scripts/client-certify-claude.mjs) — a thing no CI job and no unattended script can
 * honestly produce.
 *
 * Usage: node scripts/collect-acceptance-receipts.mjs --out <dir> [--skip <type>,...]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy } from './launch-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
}

/** Run a command, tee its output to `logPath`, and report whether it succeeded. */
function runStep(command, args, logPath) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3_600_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const body =
    `$ ${command} ${args.join(' ')}\n` +
    `exit ${result.status} after ${((Date.now() - started) / 1000).toFixed(1)}s\n\n` +
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(logPath, body);
  return { ok: result.status === 0, ms: Date.now() - started, stdout: result.stdout ?? '' };
}

const argv = process.argv.slice(2);
const outDir = resolve(flag(argv, '--out', 'receipts'));
const skip = new Set(
  (flag(argv, '--skip', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const receiptsDir = join(outDir, 'receipts');
const logsDir = join(outDir, 'logs');
mkdirSync(receiptsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

const { policy, sha256: policySha256 } = loadLaunchPolicy();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain=v1'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();
if (dirty) {
  process.stderr.write(
    `refusing to collect: the working tree is dirty, so the receipts would name a commit that is not what was tested.\n${dirty}\n`,
  );
  process.exit(2);
}

process.stdout.write(`collecting acceptance receipts for ${commit} under ${policySha256}\n\n`);

/**
 * The checks, in the order a human would run them: cheapest first, so a broken build is reported in
 * seconds rather than after the twenty-minute freshness workload.
 */
const CHECKS = [
  {
    type: 'adapter',
    command: 'pnpm installer:test',
    run: (log) => runStep('corepack', ['pnpm@9.15.0', 'installer:test'], log),
  },
  {
    type: 'security-privacy',
    command: 'pnpm security:battery && pnpm security:check',
    run: (log) => {
      const a = runStep('corepack', ['pnpm@9.15.0', 'security:battery'], `${log}.battery`);
      const b = runStep('corepack', ['pnpm@9.15.0', 'security:check'], log);
      return { ok: a.ok && b.ok, ms: a.ms + b.ms, stdout: b.stdout };
    },
  },
  {
    type: 'recovery',
    command: 'vitest run memory-crash-recovery memory-portable',
    run: (log) =>
      runStep(
        'corepack',
        [
          'pnpm@9.15.0',
          '--filter',
          'knowledge-crib',
          'exec',
          'vitest',
          'run',
          'src/memory-crash-recovery.test.ts',
          'src/memory-portable.test.ts',
        ],
        log,
      ),
  },
  {
    type: 'native-service',
    command:
      'vitest run freshness-service freshness-concurrency freshness-subprocess freshness-child',
    run: (log) =>
      runStep(
        'corepack',
        [
          'pnpm@9.15.0',
          '--filter',
          'knowledge-crib',
          'exec',
          'vitest',
          'run',
          'src/freshness-service.test.ts',
          'src/freshness-concurrency.test.ts',
          'src/freshness-subprocess.test.ts',
          'src/freshness-child.test.ts',
        ],
        log,
      ),
  },
  {
    type: 'browser',
    command: 'pnpm verify:browser',
    run: (log) => runStep('corepack', ['pnpm@9.15.0', 'verify:browser'], log),
  },
  {
    type: 'install',
    command: 'pnpm installer:build && pnpm installer:smoke-userdir',
    run: (log) => {
      const a = runStep('corepack', ['pnpm@9.15.0', 'installer:build'], `${log}.build`);
      if (!a.ok) return a;
      return runStep('corepack', ['pnpm@9.15.0', 'installer:smoke-userdir'], log);
    },
  },
  {
    type: 'freshness',
    command: 'node scripts/freshness-adoption-check.mjs',
    // The freshness harness writes its OWN receipt: it carries per-transition samples and a p95 the
    // generic writer knows nothing about.
    ownReceipt: true,
    run: (log) =>
      runStep(
        'node',
        ['scripts/freshness-adoption-check.mjs', '--out', join(receiptsDir, 'freshness.json')],
        log,
      ),
  },
];

const results = [];
for (const check of CHECKS) {
  if (!policy.receiptTypes.includes(check.type)) continue;
  if (skip.has(check.type)) {
    process.stdout.write(`  ${check.type.padEnd(18)} SKIPPED by --skip (this is a blocker)\n`);
    continue;
  }
  const logPath = join(logsDir, `${check.type}.log`);
  process.stdout.write(`  ${check.type.padEnd(18)} running…`);
  const outcome = check.run(logPath);
  process.stdout.write(
    `\r  ${check.type.padEnd(18)} ${outcome.ok ? 'pass' : 'FAIL'} (${(outcome.ms / 1000).toFixed(0)}s)\n`,
  );
  results.push({ type: check.type, ok: outcome.ok });
  if (check.ownReceipt) continue;
  const receipt = join(receiptsDir, `${check.type}.json`);
  const write = spawnSync(
    'node',
    [
      'scripts/write-receipt.mjs',
      check.type,
      '--out',
      receipt,
      '--command',
      check.command,
      '--artifact',
      logPath,
      '--status',
      outcome.ok ? 'pass' : 'fail',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (write.status !== 0) {
    process.stderr.write(`  could not write the ${check.type} receipt: ${write.stderr}\n`);
    process.exitCode = 1;
  }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length} checks, ${failed.length} failed${failed.length ? `: ${failed.map((f) => f.type).join(', ')}` : ''}\n` +
    `receipts -> ${receiptsDir}\n`,
);
if (failed.length) process.exitCode = 1;
