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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Build the shipped package ONCE for this collection pass, and report its digest.
 *
 * This is ordering-critical, for a reason that is not obvious. `pnpm pack` resolves `workspace:*`
 * to a concrete version at pack time and rewrites the dependency keys in a non-deterministic ORDER
 * — the contents are byte-identical, but the manifest's key order varies, so every build produces a
 * different tarball digest. Three consecutive builds of one clean commit here produced three
 * distinct hashes.
 *
 * That makes "rebuild the package" a destructive act in the middle of an evidence pass: receipts
 * are bound to a package digest, so rebuilding silently invalidates every receipt already collected
 * against the previous artifact — including a vendor certification that cost a human a signed-in
 * client and part of an account quota. The install check therefore only SMOKES the package; the
 * build happens here, before anything is measured, and the digest is printed so the operator can
 * see which artifact the whole pass describes.
 */
function buildPackageOnce() {
  const log = join(logsDir, 'installer-build.log');
  process.stdout.write('  building the package once for this pass…');
  const built = runStep('corepack', ['pnpm@9.15.0', 'installer:build'], log);
  if (!built.ok) {
    process.stdout.write('\r  package build FAILED — see logs/installer-build.log\n');
    process.exit(1);
  }
  const tarball = join(REPO_ROOT, 'dist/installers/knowledge-crib-0.1.0/knowledge-crib-0.1.0.tgz');
  const digest = `sha256:${createHash('sha256').update(readFileSync(tarball)).digest('hex')}`;
  process.stdout.write(`\r  package built: ${digest}\n`);
  // A vendor receipt already sitting in this directory was collected against a DIFFERENT artifact
  // unless its digest matches. Saying so here is the difference between an operator re-running one
  // command and an operator debugging a NO-GO they cannot explain.
  const existing = join(receiptsDir, 'client-claude-darwin.json');
  if (existsSync(existing)) {
    try {
      const prior = JSON.parse(readFileSync(existing, 'utf8'));
      if (prior.product?.packageSha256 && prior.product.packageSha256 !== digest) {
        process.stdout.write(
          `  NOTE: the existing vendor receipt certifies ${prior.product.packageSha256}, which is\n` +
            '        not this artifact. It must be recollected, or the decision will refuse the cell.\n',
        );
      }
    } catch {
      // A malformed receipt is the decision's problem to report, not this script's.
    }
  }
  return digest;
}

const packageSha256 = buildPackageOnce();

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
    // Deliberately does NOT rebuild: the package is built ONCE, before any check runs, and every
    // receipt in this pass describes that one artifact. See buildPackageOnce().
    command: 'pnpm installer:smoke-userdir (against the package built once for this pass)',
    run: (log) => runStep('corepack', ['pnpm@9.15.0', 'installer:smoke-userdir'], log),
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
    `package  -> ${packageSha256}\n` +
    `receipts -> ${receiptsDir}\n`,
);
if (failed.length) process.exitCode = 1;
