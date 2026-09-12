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
 * The vendor client cells are NOT collected here. They need the real vendor application, signed in,
 * on a real host (scripts/client-certify.mjs) — a thing no CI job and no unattended script can
 * honestly produce.
 *
 * Usage:
 *   node scripts/collect-acceptance-receipts.mjs --out <dir> [--skip <type>,...]
 *
 *   # certifying mode: describe bytes that already exist, and change nothing
 *   node scripts/collect-acceptance-receipts.mjs --out <dir> \
 *     --package dist/installers/knowledge-crib-0.1.0/knowledge-crib-0.1.0.tgz \
 *     --candidate-commit <40-hex HEAD>
 *
 * CERTIFYING MODE EXISTS BECAUSE OF THE ORDER THE LAUNCH RUNS IN. The package is built once, in one
 * job, and every artifact of the launch — all twenty-one vendor cells and every acceptance check —
 * must describe that SAME one. If this script rebuilt the package it would write receipts binding a
 * different digest from the one the vendor cells certified, and the decision would (correctly) refuse
 * the whole set. So `--package` means: hash what you were handed, never rebuild it, and refuse if
 * anything during the pass changes those bytes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy } from './launch-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
}
const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

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

// ── the candidate this pass describes ────────────────────────────────────────────────────────────
// Two modes, one rule: every receipt written below binds the same {commit, packageSha256}. What
// differs is only who produced the package — this script, or a job upstream that had to build it
// once so that twenty-one vendor cells could all describe the same bytes.
//
// These refusals are checked BEFORE the working-tree check on purpose. What was typed on the command
// line is a static fact about the invocation, and an operator who mistyped a commit should hear
// about it immediately rather than after an unrelated `git status` verdict that may change under them.
const suppliedPackage = flag(argv, '--package', undefined);
const declaredCommit = flag(argv, '--candidate-commit', undefined);

// A supplied artifact MUST say which commit it came from, and that commit must be the one checked
// out. A tarball carries no provenance — nothing inside it records the revision — so without this
// the only thing tying the bytes to the source is the operator's memory, which is exactly how a
// stale receipt survives a rebuild and certifies a candidate that no longer exists.
if (declaredCommit !== undefined) {
  if (!/^[0-9a-f]{40}$/.test(declaredCommit)) {
    die(
      `--candidate-commit must be the full 40-hex commit, got ${JSON.stringify(declaredCommit)}.\n  A short or abbreviated revision can be ambiguous, and an ambiguous binding certifies nothing.`,
    );
  }
  if (declaredCommit !== commit) {
    die(
      `refusing to collect: --candidate-commit ${declaredCommit} is not the checked-out commit.\n  HEAD is ${commit}. Certifying a commit you are not standing on means the evidence and the\n  source it describes are different things.`,
    );
  }
}
if (suppliedPackage !== undefined && declaredCommit === undefined) {
  die(
    '--package requires --candidate-commit.\n' +
      '  A tarball does not record the revision it was built from, so a supplied artifact with no\n' +
      '  declared commit writes receipts that bind bytes to nothing.',
  );
}
if (suppliedPackage !== undefined) {
  const resolved = resolve(suppliedPackage);
  if (!existsSync(resolved)) {
    die(`--package points at ${resolved}, which does not exist.`);
  }
}

const dirty = execFileSync('git', ['status', '--porcelain=v1'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();
if (dirty) {
  die(
    `refusing to collect: the working tree is dirty, so the receipts would name a commit that is not what was tested.\n${dirty}`,
  );
}

process.stdout.write(`collecting acceptance receipts for ${commit} under ${policySha256}\n\n`);

const DEFAULT_TARBALL = join(
  REPO_ROOT,
  'dist/installers/knowledge-crib-0.1.0/knowledge-crib-0.1.0.tgz',
);

const hashPackage = (path) =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

/**
 * Report every vendor receipt already in this directory that certifies a DIFFERENT artifact.
 *
 * Saying so is the difference between an operator re-running one command and an operator debugging a
 * NO-GO they cannot explain. It reads every `client-*.json` rather than one hardcoded filename,
 * because the cells are named per client, OS and architecture — a check pinned to `claude` on darwin
 * would stay silent about the twenty cells most likely to be stale.
 */
function noteStaleVendorReceipts(receiptsDir, digest) {
  let names;
  try {
    names = readdirSync(receiptsDir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => /^client-.*\.json$/.test(n)).sort()) {
    try {
      const prior = JSON.parse(readFileSync(join(receiptsDir, name), 'utf8'));
      const certified = prior.product?.packageSha256 ?? prior.evidence?.packageSha256;
      if (certified && certified !== digest) {
        process.stdout.write(
          `  NOTE: ${name} certifies ${certified},\n        which is not this artifact. It must be recollected, or the decision will refuse the cell.\n`,
        );
      }
    } catch {
      // A malformed receipt is the decision's problem to report, not this script's.
    }
  }
}

/**
 * Resolve the candidate artifact this pass describes, WITHOUT ever rebuilding it in certifying mode.
 *
 * The build path is ordering-critical, for a reason that is not obvious. `pnpm pack` resolves
 * `workspace:*` to a concrete version at pack time and rewrites the dependency keys in a
 * non-deterministic ORDER — the contents are byte-identical, but the manifest's key order varies, so
 * every build produces a different tarball digest. Three consecutive builds of one clean commit here
 * produced three distinct hashes.
 *
 * That makes "rebuild the package" a destructive act in the middle of an evidence pass: receipts are
 * bound to a package digest, so rebuilding silently invalidates every receipt already collected
 * against the previous artifact — including a vendor certification that cost a human a signed-in
 * client and part of an account quota. So in certifying mode the bytes are taken as given, and in
 * build mode the build happens here, before anything is measured.
 */
function resolveCandidate() {
  if (suppliedPackage !== undefined) {
    // Existence was already checked with the other argument refusals, above.
    const path = resolve(suppliedPackage);
    const digest = hashPackage(path);
    process.stdout.write(`  describing the supplied artifact (not rebuilt): ${digest}\n`);
    noteStaleVendorReceipts(receiptsDir, digest);
    return { path, digest, rebuilt: false };
  }

  const log = join(logsDir, 'installer-build.log');
  process.stdout.write('  building the package once for this pass…');
  const built = runStep('corepack', ['pnpm@9.15.0', 'installer:build'], log);
  if (!built.ok) {
    process.stdout.write('\r  package build FAILED — see logs/installer-build.log\n');
    process.exit(1);
  }
  const digest = hashPackage(DEFAULT_TARBALL);
  process.stdout.write(`\r  package built: ${digest}\n`);
  noteStaleVendorReceipts(receiptsDir, digest);
  return { path: DEFAULT_TARBALL, digest, rebuilt: true };
}

const candidate = resolveCandidate();
const packageSha256 = candidate.digest;

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
    // Deliberately does NOT rebuild: the package is resolved ONCE, before any check runs, and every
    // receipt in this pass describes that one artifact. See resolveCandidate(). The re-hash after
    // this check is what makes that ordering an enforced property rather than a comment.
    command: candidate.rebuilt
      ? 'pnpm installer:smoke-userdir (against the package built once for this pass)'
      : 'pnpm installer:smoke-userdir (against the supplied candidate, never rebuilt)',
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
const skipped = [];
for (const check of CHECKS) {
  if (!policy.receiptTypes.includes(check.type)) continue;
  if (skip.has(check.type)) {
    // No receipt is written, so the type is ABSENT, and an absent required type is a blocker in the
    // decision. Recorded here rather than only printed, because a summary that counted only the
    // checks it ran would report a complete pass over an incomplete set of checks.
    skipped.push(check.type);
    process.stdout.write(
      `  ${check.type.padEnd(18)} SKIPPED by --skip — no receipt written, so this type is absent, and absence is a blocker\n`,
    );
    continue;
  }
  const logPath = join(logsDir, `${check.type}.log`);
  process.stdout.write(`  ${check.type.padEnd(18)} running…`);
  const outcome = check.run(logPath);
  process.stdout.write(
    `\r  ${check.type.padEnd(18)} ${outcome.ok ? 'pass' : 'FAIL'} (${(outcome.ms / 1000).toFixed(0)}s)\n`,
  );
  // The artifact has to be the SAME artifact at the end of the check as at the start. A check that
  // rebuilds the package — or a stray build beside this pass — silently re-points every receipt after
  // it at unverified bytes and every receipt before it at bytes that no longer exist. The whole point
  // of a candidate-bound receipt is that one digest describes the entire launch, so two digests are
  // not a warning, they are the pass being invalid.
  const after = hashPackage(candidate.path);
  if (after !== packageSha256) {
    process.stderr.write(
      `\n  the ${check.type} check CHANGED the candidate artifact.\n    before  ${packageSha256}\n    after   ${after}\n  Refusing to continue: every receipt in this pass must describe one artifact.\n  Nothing after this point was collected, and the receipts here are void. Log: ${logPath}\n`,
    );
    process.exit(1);
  }
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
  `\n${results.length} checks, ${failed.length} failed${failed.length ? `: ${failed.map((f) => f.type).join(', ')}` : ''}\n${skipped.length ? `${skipped.length} skipped, and each one is a blocker: ${skipped.join(', ')}\n` : ''}candidate -> ${commit}\npackage   -> ${packageSha256}${candidate.rebuilt ? '' : ' (supplied, not rebuilt)'}\nreceipts  -> ${receiptsDir}\n`,
);
// A skipped check is a blocker, so an incomplete pass exits non-zero too. `--skip` is an operator
// escape hatch for a deliberate partial run, and it stays useful — but a script whose exit status
// reads as success after required checks were skipped would let a chained CI step treat an incomplete
// set of receipts as a green pass. Absence is never consent, and neither is status 0.
if (failed.length || skipped.length) process.exitCode = 1;
