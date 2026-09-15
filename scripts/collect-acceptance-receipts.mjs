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
 *
 * THE CANDIDATE IS A BUNDLE, NOT A TARBALL (Task 3). `--package` names the root package of an
 * installer bundle; before anything runs, the pass verifies the bundle's manifest and every bundled
 * workspace package against the checksums the manifest recorded at build time, installs the bundle
 * ONCE into an isolated prefix, and hands that installed executable explicitly to the
 * installed-product checks (adapter, install, freshness). Package hashing alone never established
 * which executable a check exercised — a receipt can only name bytes it was HANDED. Before and after
 * EVERY check the whole bundle is re-hashed, so a check that rebuilds or replaces any part of the
 * candidate is refused, not noticed.
 *
 * Source-level suites (browser, recovery, native-service, security-privacy) still run and still
 * write receipts — marked `product.source: "workspace"`. They are regression evidence, kept separate
 * from the installed-product acceptance evidence so the decision can tell which is which; the
 * installed-product drivers for those classes arrive with the later certification tasks.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleDigests,
  digestsDiffer,
  installCandidate,
  verifyBundle,
} from './candidate-bundle.mjs';
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

/** Run a command, tee its output to `logPath`, and report its ACTUAL completion status. */
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
  // exitCode is the fact the receipt's status is DERIVED from. A spawn that died without a status
  // (timeout kill, signal) gets -1 — never a silent 0.
  return {
    ok: result.status === 0,
    ms: Date.now() - started,
    stdout: result.stdout ?? '',
    exitCode: result.status ?? -1,
  };
}

const hashPackage = (path) =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

/**
 * Refuse a receipts directory that already holds this pass's kind of evidence.
 *
 * The guarantee is exactly this: the RECEIPTS directory must not already hold a previous pass's
 * acceptance receipts (or their unparseable residue) when this pass starts collecting. Vendor
 * receipts (`client-*.json`) are the one thing allowed: the cells download them into place, and
 * this pass only ever reads them. The guarantee is deliberately narrower than "the whole --out is
 * fresh": `manifest.json` inside the cell directory is written by the separate manifest step,
 * which overwrites its own output on every re-run, and a half-finished pass never reaches the
 * upload at all — the refusal here is about a STANDING receipt being read as this pass's work,
 * either aggregated as if this pass produced it or sitting in a failed check's place and reading
 * as a pass that never happened.
 */
export function assertUnusedReceiptsDir(receiptsDir) {
  let names;
  try {
    names = readdirSync(receiptsDir);
  } catch {
    return; // nothing there to reuse
  }
  for (const name of names
    .filter((n) => n.endsWith('.json') && !/^client-.*\.json$/.test(n))
    .sort()) {
    let prior;
    try {
      prior = JSON.parse(readFileSync(join(receiptsDir, name), 'utf8'));
    } catch {
      throw new Error(
        `${receiptsDir} already holds ${name}, which is not readable JSON.
Evidence directories are never reused — give this pass its own --out.`,
      );
    }
    if (prior?.format === 'knowledge-crib-acceptance-receipt') {
      throw new Error(
        `${receiptsDir} already holds ${name}, a receipt from a previous pass.
Evidence directories are never reused — give this pass its own --out.`,
      );
    }
  }
}

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
 * The checks, in the order a human would run them: cheapest first, so a broken build is reported in
 * seconds rather than after the twenty-minute freshness workload.
 *
 * Mode-aware (Task 3): certifying passes exercise the INSTALLED candidate — the adapter probe runs
 * the installed executable directly (no pnpm, no pack, nothing that could rebuild or replace the
 * candidate mid-pass), the install cycle names the SUPPLIED bundle instead of discovering
 * mtime-newest, and freshness measures the installed CLI via --cli. Build mode keeps
 * `pnpm installer:test` for the adapter check (there is nothing installed yet to certify) and
 * points the other installed-product checks at the bundle it just built — through the same
 * explicit-bundle and --cli seams, so both modes differ only in WHO produced the bytes, never in
 * how they are verified.
 *
 * Each descriptor carries `product` — 'installed-candidate' or 'workspace' — which the receipt
 * writer records, so source-level regression evidence never masquerades as installed-product
 * acceptance evidence.
 *
 * Every check also carries `spawns`: the commands it runs, as DATA. The display `command` and the
 * `run` closure are both DERIVED from the same step objects, so a check can never show one command
 * while executing another — a receipt's command string is evidence, and evidence allowed to drift
 * from execution is a claim, not a fact. The multi-command security check composes its two steps
 * by hand (each constituent keeps its own exit code), but over the same step constants.
 */
const step = (command, args) => ({ command, args, display: `${command} ${args.join(' ')}` });

export function resolveChecks({ mode, candidate, bundleDir, installed, receiptsDir, passRunId }) {
  const installedBin = installed?.bins?.direct;
  const runSpawn = (spawn) => (log) => runStep(spawn.command, spawn.args, log);
  const single = (type, product, spawn, extra = {}) => ({
    type,
    product,
    spawns: [spawn],
    command: spawn.display,
    run: runSpawn(spawn),
    ...extra,
  });

  const adapterSpawn =
    mode === 'certifying'
      ? step('node', ['scripts/installed-adapter-check.mjs', '--bin', installedBin])
      : step('corepack', ['pnpm@9.15.0', 'installer:test']);
  const securityBattery = step('corepack', ['pnpm@9.15.0', 'security:battery']);
  const securityChecker = step('corepack', ['pnpm@9.15.0', 'security:check']);
  const recoverySpawn = step('corepack', [
    'pnpm@9.15.0',
    '--filter',
    'knowledge-crib',
    'exec',
    'vitest',
    'run',
    'src/memory-crash-recovery.test.ts',
    'src/memory-portable.test.ts',
  ]);
  const nativeServiceSpawn = step('corepack', [
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
  ]);
  const browserSpawn = step('corepack', ['pnpm@9.15.0', 'verify:browser']);
  // The installed-product install cycle: the FULL bundle (not a discovery of mtime-newest) is
  // named explicitly, so the check cannot drift onto an artifact some other step just packed.
  const installSpawn = step('node', [
    'scripts/install-smoke.mjs',
    '--user-dir',
    '--bundle',
    bundleDir,
  ]);
  const freshnessOut = join(receiptsDir, 'freshness.json');
  const freshnessSpawn = step('node', [
    'scripts/freshness-adoption-check.mjs',
    '--out',
    freshnessOut,
    '--package',
    candidate.path,
    '--run-id',
    passRunId,
    '--cli',
    installedBin,
  ]);

  const checks = [
    single('adapter', mode === 'certifying' ? 'installed-candidate' : 'workspace', adapterSpawn),
    {
      type: 'security-privacy',
      product: 'workspace',
      spawns: [securityBattery, securityChecker],
      command: [securityBattery.display, securityChecker.display].join(' && '),
      // Two commands, each archived with its OWN exit code. The battery passing while the checker
      // fails (or vice versa) is a different fact from "the check failed", and a single merged
      // verdict would let the failing half hide behind its sibling.
      run: (log) => {
        const a = runStep(securityBattery.command, securityBattery.args, `${log}.battery`);
        const b = runStep(securityChecker.command, securityChecker.args, log);
        return {
          ok: a.ok && b.ok,
          ms: a.ms + b.ms,
          stdout: b.stdout,
          commandResults: [
            { command: securityBattery.display, exitCode: a.exitCode },
            { command: securityChecker.display, exitCode: b.exitCode },
          ],
        };
      },
    },
    single('recovery', 'workspace', recoverySpawn),
    single('native-service', 'workspace', nativeServiceSpawn),
    single('browser', 'workspace', browserSpawn),
    single('install', 'installed-candidate', installSpawn),
    // The freshness harness writes its OWN receipt: it carries per-transition samples and a p95 the
    // generic writer knows nothing about. It receives the same --package, --run-id and installed
    // CLI this pass binds every other receipt with, so its v2 envelope — including the product
    // identity — describes the same candidate. `ownReceipt` is the path the harness writes to, so
    // the pass reads back exactly the file the spawn was told to produce.
    single('freshness', 'installed-candidate', freshnessSpawn, { ownReceipt: freshnessOut }),
  ];
  return checks;
}

export async function collectAcceptanceReceipts() {
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
  const mode = suppliedPackage !== undefined ? 'certifying' : 'build';

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
  // Like the argument refusals above, this is a static fact about the invocation, checked BEFORE
  // the working-tree verdict: an operator who pointed --out at a directory a previous pass
  // already filled should hear that immediately, not after a git-status run that may change under
  // them.
  try {
    assertUnusedReceiptsDir(receiptsDir);
  } catch (error) {
    die(`refusing to collect: ${error.message}`);
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
  // One run identity for the whole pass. Every receipt in this directory carries the same runId, so
  // a stale receipt left by a PREVIOUS pass is identifiable as foreign instead of blending in — and
  // the decision can refuse two receipts that claim one run but disagree.
  const passRunId = randomUUID();

  // ── verify the bundle, then install it once (Task 3) ────────────────────────────────────────────
  // The candidate is a bundle directory: manifest + every workspace package + the installers. The
  // pass refuses to describe a bundle whose bytes disagree with the checksums its own manifest
  // recorded at build time — certifying modified bytes is certifying an unknown artifact — and the
  // same verification applies in build mode, so a partial or corrupted build fails HERE, at the
  // boundary, instead of inside whatever check first touches the missing package.
  const bundleDir = dirname(candidate.path);
  let verified;
  try {
    verified = verifyBundle({ bundleDir, tarball: candidate.path });
  } catch (error) {
    die(`refusing to collect: the candidate bundle failed verification.\n  ${error.message}`);
  }
  const { manifest } = verified;
  const baseline = bundleDigests(bundleDir, manifest);

  // Install the verified bundle into an isolated prefix ONCE. Every installed-product check below
  // is HANDED this executable, so a receipt's product identity names bytes this pass installed and
  // hashed — not whatever a check's own discovery might have found. The prefix is a temp directory
  // created by this pass and removed by it; nothing on the host is configured.
  const prefix = mkdtempSync(join(tmpdir(), 'knowledge-crib-candidate-'));
  let installed;
  try {
    process.stdout.write('  installing the candidate bundle into an isolated prefix…');
    let installLog;
    try {
      const result = installCandidate({ bundleDir, manifest, prefix });
      installed = { bins: result.bins, executableSha256: result.executableSha256 };
      installLog = result.log;
    } catch (error) {
      // `return`, not process.exit: the finally below must still remove this pass's temp prefix.
      // The install transcript is archived on failure too — a log that exists only on success
      // hides exactly the npm run an operator needs to read.
      if (error.log) writeFileSync(join(logsDir, 'install-candidate.log'), error.log);
      process.stdout.write(`\r  candidate install FAILED: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(logsDir, 'install-candidate.log'), installLog);
    process.stdout.write(
      `\r  candidate installed: ${installed.bins.direct}\n  executable -> ${installed.executableSha256}\n`,
    );

    const CHECKS = resolveChecks({
      mode,
      candidate,
      bundleDir,
      installed,
      receiptsDir,
      passRunId,
    });

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
      // The bundle must be the SAME bundle at the end of the check as at the start — and the same as
      // the baseline the pass verified before anything ran. A check that rebuilds any part of the
      // candidate (the old adapter check packed, mid-pass) or replaces a package silently re-points
      // every receipt after it at unverified bytes and every receipt before it at bytes that no
      // longer exist. The whole point of a candidate-bound receipt is that one set of digests
      // describes the entire launch, so any movement is not a warning, it is the pass being invalid.
      const beforeCheck = bundleDigests(bundleDir, manifest);
      const outcome = check.run(logPath);
      const afterCheck = bundleDigests(bundleDir, manifest);
      const moved = [
        ...digestsDiffer(beforeCheck, afterCheck),
        ...digestsDiffer(baseline, afterCheck),
      ];
      if (moved.length > 0) {
        process.stderr.write(
          `\n  the ${check.type} check CHANGED the candidate bundle (${[...new Set(moved)].join(', ')}).\n  Refusing to continue: every receipt in this pass must describe one artifact.\n  Nothing after this point was collected, and the receipts here are void. Log: ${logPath}\n`,
        );
        // `process.exitCode`, not process.exit: the finally below must still remove this pass's
        // temp prefix — process.exit skips finally, and a refused pass must not leak a full
        // node_modules onto the runner on top of refusing.
        process.exitCode = 1;
        return;
      }
      // The installed prefix is a fact the receipts vouch for by hash, so it is re-asserted after
      // EVERY check, not only the installed-product ones: any check that replaced or removed the
      // installed CLI (a self-update path, an overwrite) would let every later installed-candidate
      // receipt name bytes this pass never hashed. The freshness receipt's own product identity is
      // only as good as the executable still being the one installCandidate produced.
      if (
        !existsSync(installed.bins.direct) ||
        hashPackage(installed.bins.direct) !== installed.executableSha256
      ) {
        process.stderr.write(
          `\n  the ${check.type} check changed the installed candidate executable (${installed.bins.direct}).\n  Refusing to continue: installed-candidate receipts name the executable this pass installed,\n  and anything after a swap certifies bytes nobody verified. Log: ${logPath}\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `\r  ${check.type.padEnd(18)} ${outcome.ok ? 'pass' : 'FAIL'} (${(outcome.ms / 1000).toFixed(0)}s)\n`,
      );
      results.push({ type: check.type, ok: outcome.ok });
      if (check.ownReceipt) {
        // The freshness harness writes its own receipt; this pass accepts it only if it binds the
        // SAME installed executable the pass handed it via --cli. A receipt naming other bytes —
        // or carrying no product identity at all — is not acceptance evidence for this candidate,
        // whatever the harness's exit code said. A missing or unparsable receipt is tolerated only
        // when the check itself failed: the failure already fails the pass, and a harness that died
        // mid-run may legitimately never have reached its write.
        let own = null;
        if (existsSync(check.ownReceipt)) {
          try {
            own = JSON.parse(readFileSync(check.ownReceipt, 'utf8'));
          } catch {
            own = null;
          }
        }
        if (outcome.ok && own?.product?.executableSha256 !== installed.executableSha256) {
          process.stderr.write(
            `\n  the freshness harness's own receipt does not bind this pass's installed executable\n  (expected product.executableSha256 ${installed.executableSha256}, found ${own?.product?.executableSha256 ?? 'no parsable receipt'}).\n  Refusing to continue: the receipt would certify bytes this pass did not verify. Log: ${logPath}\n`,
          );
          process.exitCode = 1;
          return;
        }
        continue;
      }
      // The archived command results: every constituent command with its actual exit code. A
      // multi-command check (the security battery + its checker) archives one entry per command; a
      // single-command check archives the one command that ran. `--status` is deliberately NOT passed:
      // the writer derives status from these facts, which is what stops a nonzero exit from being
      // written down as a pass.
      const commandResults = outcome.commandResults ?? [
        { command: check.command, exitCode: outcome.exitCode },
      ];
      const receipt = join(receiptsDir, `${check.type}.json`);
      // Artifact paths are stored relative to `outDir` (never machine-absolute): the evidence tree is
      // copied to the launch judge — `~/crib-launch-evidence/<date>/` to another machine, or an artifact
      // download in CI — and a receipt naming this machine's absolute path certifies nowhere else. The
      // decision resolves them against the receipts root it is handed: the cell directory that
      // contains the receipt in the release workflow's `--cells` layout.
      //
      // `--product-source` records WHICH product the check exercised, and an installed-candidate
      // receipt must name (the hash of) the executable it ran — a receipt claiming the installed
      // product without binding the executable bytes certifies a claim nobody checked.
      const write = spawnSync(
        'node',
        [
          'scripts/write-receipt.mjs',
          check.type,
          '--out',
          receipt,
          '--package',
          candidate.path,
          '--run-id',
          passRunId,
          '--artifact-root',
          outDir,
          '--artifact',
          relative(outDir, logPath),
          '--product-source',
          check.product,
          ...(check.product === 'installed-candidate'
            ? ['--executable', installed.bins.direct]
            : []),
          ...commandResults.flatMap((result) => [
            '--command',
            result.command,
            '--exit-code',
            String(result.exitCode),
          ]),
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
      `\n${results.length} checks, ${failed.length} failed${failed.length ? `: ${failed.map((f) => f.type).join(', ')}` : ''}\n${skipped.length ? `${skipped.length} skipped, and each one is a blocker: ${skipped.join(', ')}\n` : ''}candidate -> ${commit}\npackage   -> ${packageSha256}${candidate.rebuilt ? '' : ' (supplied, not rebuilt)'}\nexecutable -> ${installed.executableSha256}\nreceipts  -> ${receiptsDir}\n`,
    );
    // A skipped check is a blocker, so an incomplete pass exits non-zero too. `--skip` is an operator
    // escape hatch for a deliberate partial run, and it stays useful — but a script whose exit status
    // reads as success after required checks were skipped would let a chained CI step treat an incomplete
    // set of receipts as a green pass. Absence is never consent, and neither is status 0.
    if (failed.length || skipped.length) process.exitCode = 1;
  } finally {
    // The isolated install prefix is this pass's own temp directory; leaving it behind would leak a
    // full node_modules per pass on every CI runner.
    rmSync(prefix, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await collectAcceptanceReceipts();
}
