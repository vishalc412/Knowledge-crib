import { execFileSync } from 'node:child_process';
/**
 * fuzz-check — the M3.5 parser-fuzz gate.
 *
 * Pins the plan's M3.5 intent — "any byte sequence → extractor terminates in budget, never throws,
 * valid node set — per extractor" — against the SHIPPED extractor fleet, with real teeth: each
 * extract runs in a worker_threads isolate under a per-call wall-clock budget, so a SYNC HANG (the
 * PL/SQL `recover()` infinite-loop class) is caught by worker termination, not swallowed by a
 * blocked event loop. fast-check inputs are SEEDED (seed=1) → reproducible input-for-input.
 *
 * The fleet size is NOT hardcoded here. It is read from the policy's `fuzz.minimumExtractors` and
 * asserted against what actually ships, because a comment counting extractors is a comment that
 * goes stale the day one is added (this file said "9" for a fleet of ten), while a receipt claiming
 * a sweep is evidence only if the sweep covered the fleet it names.
 *
 * Two phases:
 *
 *   (1) SELF-TEST (the detector regression): run the 3 test-only fakes (hang / throw / invalid)
 *       with a tiny budget + 4 iterations, and assert the detector catches EACH failure class:
 *         - __fuzz_fake_hang  → hang > 0   (worker terminated on budget timeout)
 *         - __fuzz_fake_throw → throw > 0  (extract threw → contract violation recorded)
 *         - __fuzz_fake_invalid → invalid > 0 (malformed node → structural validator flagged it)
 *       If the self-test fails, the detector itself is broken and the real fuzz numbers are
 *       meaningless — exit 1 before fuzzing anything. This is the vitest-cannot-test-it piece
 *       (Node can't run a .ts worker under the repo's >=22.5 floor; the sync-hang property is only
 *       provable with a terminate()-able thread), living here in the build-gated gate per the M3.4
 *       parallel-check precedent.
 *
 *   (2) REAL FUZZ: for each shipped extractor, run `iterations` seeded inputs and assert
 *       ok === iterations (0 throw / 0 hang / 0 invalid). On any failure, print up to 3
 *       reproducers (exact (extractor, idx, text, reason)) and exit 1.
 *
 * Usage:
 *   node scripts/fuzz-check.mjs                # smoke: 1000 iterations/extractor (release:verify)
 *   node scripts/fuzz-check.mjs --iterations 1000000   # nightly: 10^6/extractor (fuzz:nightly)
 *   node scripts/fuzz-check.mjs --iterations 1000000 --receipt out/fuzz-deep.json \
 *     --package dist/installers/knowledge-crib-0.1.0/knowledge-crib-0.1.0.tgz
 *
 * `--receipt` makes this a CANDIDATE-BOUND deep run: the transcript is archived beside the receipt,
 * the receipt binds to the commit, the package digest and the policy digest, and it carries the
 * seed, the iteration count, the extractor list and every failure. A deep receipt is REFUSED (exit
 * 2) when the requested sweep is smaller than the policy requires — a smoke run wearing the deep
 * receipt's name is worse than no receipt, because it reads as coverage.
 *
 * release:verify builds every package before any gate runs, so the dynamic import of the built
 * parsers dist resolves. A standalone `pnpm fuzz:check` is guarded: if dist/fuzz-worker.js is
 * missing, the parsers package is built first.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadLaunchPolicy, policyFuzzRequirements } from './launch-policy.mjs';
import { buildReceipt } from './write-receipt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
/**
 * The compiled worker, at the path the pool actually loads (see `extractor-fuzz.ts`, which resolves
 * it as `fuzz-worker.js` alongside its own compiled file). This guard used to point at
 * `dist/fuzz-worker.js`, one directory too high — a path that never exists, so the guard never
 * short-circuited and every `pnpm fuzz:check` silently ran a full TypeScript build first. A guard
 * that is always true is not a guard, and inside the nightly it also meant the "execute deep fuzz"
 * step was doing a build the workflow had already claimed to do.
 */
const PARSERS_DIST = resolve(REPO, 'packages', 'parsers', 'dist', 'fuzz', 'fuzz-worker.js');

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

// --- args ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const receiptPath = flag(argv, '--receipt');
const packagePath = flag(argv, '--package');
const logPath = flag(argv, '--log', receiptPath ? `${receiptPath}.log` : undefined);
let iterations = 1000; // smoke default; nightly overrides via --iterations 1000000
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--iterations' && argv[i + 1]) {
    iterations = Number.parseInt(argv[i + 1], 10);
    i++;
  }
}

const { policy, sha256: policySha256 } = loadLaunchPolicy();
const requirements = policyFuzzRequirements(policy);

// --- build guard (standalone `pnpm fuzz:check`) ------------------------------------------------
if (!existsSync(PARSERS_DIST)) {
  process.stdout.write(
    '$ corepack pnpm@9.15.0 -F @knowledge-crib/parsers build (fuzz worker missing)\n',
  );
  execFileSync('corepack', ['pnpm@9.15.0', '-F', '@knowledge-crib/parsers', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

const { runFuzz, runFakeselfTest, FUZZ_EXTRACTORS } = await import(
  pathToFileURL(resolve(REPO, 'packages', 'parsers', 'dist', 'index.js')).href
);

let failed = 0;
/** Every line the run emits, so the archived transcript is what the operator saw — not a summary. */
const transcript = [];
function say(line) {
  transcript.push(line);
  process.stdout.write(`${line}\n`);
}
function fail(msg) {
  const line = `  fuzz:check FAIL — ${msg}`;
  transcript.push(line);
  process.stderr.write(`${line}\n`);
  failed++;
}
/**
 * Flush the transcript to disk, and write the candidate-bound `fuzz-deep` receipt from the file
 * that was just written.
 *
 * The ORDER is the whole point. The receipt pins the transcript's sha256, so any line appended
 * after the receipt was built leaves a receipt whose own evidence no longer hashes to what the
 * receipt claims — a receipt invalidated by the script that produced it. So this is the last write
 * to the log on every path, and its own status lines go straight to stdout rather than through
 * `say()` (which would append them to the transcript after the digest was taken).
 *
 * Called on PASS, on FAIL and on an abort: a missing receipt and a failed one are different facts,
 * and the abort path is exactly where a reader most needs to know the detector itself was broken.
 */
function finish(status, details) {
  const archived = archiveTranscript();
  if (!receiptPath) return;
  const receipt = buildReceipt({
    type: 'fuzz-deep',
    now: new Date().toISOString(),
    argv: [
      '--command',
      `node scripts/fuzz-check.mjs --iterations ${iterations}`,
      '--status',
      status,
      ...(archived ? ['--artifact', archived] : []),
      ...(packagePath ? ['--package', packagePath] : []),
    ],
    details: {
      workload: requirements.workload,
      seed: requirements.seed,
      iterations,
      ...details,
    },
  });
  mkdirSync(dirname(resolve(receiptPath)), { recursive: true });
  writeFileSync(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `fuzz-deep receipt (${receipt.status}) -> ${receiptPath}\n` +
      `  transcript -> ${archived ?? '(not archived)'}\n` +
      `  policy ${policySha256}\n`,
  );
}

/** Flush the transcript to disk. The last caller of this must be `finish()`. */
function archiveTranscript() {
  if (!logPath) return undefined;
  mkdirSync(dirname(resolve(logPath)), { recursive: true });
  writeFileSync(resolve(logPath), `${transcript.join('\n')}\n`);
  return resolve(logPath);
}

/**
 * Refuse a deep receipt for a shallow sweep, BEFORE doing the work.
 *
 * The policy owns these numbers; a run may not certify itself against a target it picked. Without
 * this, `--receipt fuzz-deep.json --iterations 1000` would produce a file that looks exactly like a
 * nightly's, and the decision would have to be the only thing standing between a smoke test and a
 * claim of a million-case sweep.
 */
if (receiptPath) {
  const problems = [];
  if (iterations < requirements.requiredIterations) {
    problems.push(
      `--iterations ${iterations} is below the policy's required ${requirements.requiredIterations}`,
    );
  }
  if (packagePath && !existsSync(packagePath)) {
    problems.push(`--package ${packagePath} does not exist`);
  }
  if (problems.length) {
    process.stderr.write(
      `fuzz:check REFUSES to write a fuzz-deep receipt:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}
  A deep receipt for a smaller sweep is a smoke run wearing the deep receipt's name.
  Fix: raise --iterations, or run without --receipt.
`,
    );
    process.exit(2);
  }
}

// --- phase 1: detector self-test ----------------------------------------------------------------
say('');
say('[fuzz:check] phase 1 — detector self-test (3 fakes, budget 200ms, 4 iters each)');
try {
  const self = await runFakeselfTest(200, 4);
  if (self.hang.hang <= 0)
    fail(
      `self-test: hang fake produced hang=${self.hang.hang} (expected >0) — detector missed a sync hang`,
    );
  if (self.throw.throw <= 0)
    fail(
      `self-test: throw fake produced throw=${self.throw.throw} (expected >0) — detector missed a thrown extract`,
    );
  if (self.invalid.invalid <= 0)
    fail(
      `self-test: invalid fake produced invalid=${self.invalid.invalid} (expected >0) — structural validator missed a malformed node`,
    );
  // And the inverse: each fake must NOT misattribute (hang fake shouldn't also report throws, etc.)
  if (self.hang.throw > 0 || self.hang.invalid > 0)
    fail(
      `self-test: hang fake misattributed (throw=${self.hang.throw} invalid=${self.hang.invalid})`,
    );
  if (self.throw.hang > 0 || self.throw.invalid > 0)
    fail(
      `self-test: throw fake misattributed (hang=${self.throw.hang} invalid=${self.throw.invalid})`,
    );
  if (self.invalid.hang > 0 || self.invalid.throw > 0)
    fail(
      `self-test: invalid fake misattributed (hang=${self.invalid.hang} throw=${self.invalid.throw})`,
    );
  if (failed === 0)
    say(
      `  self-test OK — hang=${self.hang.hang} throw=${self.throw.throw} invalid=${self.invalid.invalid} (each >0, no misattribution)`,
    );
} catch (err) {
  fail(`self-test threw: ${err instanceof Error ? err.message : String(err)}`);
}

if (failed > 0) {
  process.stderr.write(
    '\n[fuzz:check] detector self-test FAILED — aborting before real fuzz (numbers would be meaningless)\n',
  );
  // A receipt, not a silence. It declares zero extractors and zero cases, so a consumer refuses it
  // by name on the policy's fleet floor rather than having to infer "absent" from a missing file.
  finish('fail', {
    extractors: [],
    extractorCount: 0,
    requiredExtractors: requirements.minimumExtractors,
    totalCases: 0,
    perCallBudgetMs: requirements.perCallBudgetMs,
    failures: [],
    blockedReason: 'detector self-test failed — the deep sweep was never started',
  });
  process.exit(1);
}

// --- the fleet the sweep claims to cover --------------------------------------------------------
// Read from the shipped module, compared against the policy's floor. Ten is the floor, not the
// expectation: shipping an eleventh extractor must raise the coverage of every future deep run,
// and shipping a REMOVED one must fail here rather than quietly shrinking the sweep.
if (FUZZ_EXTRACTORS.length < requirements.minimumExtractors) {
  process.stderr.write(
    `fuzz:check FAIL — only ${FUZZ_EXTRACTORS.length} extractors are registered, but the policy requires at least ${requirements.minimumExtractors}. The sweep would cover less than the receipt claims.\n`,
  );
  finish('fail', {
    extractors: FUZZ_EXTRACTORS.map((spec) => spec.name),
    extractorCount: FUZZ_EXTRACTORS.length,
    requiredExtractors: requirements.minimumExtractors,
    totalCases: 0,
    perCallBudgetMs: requirements.perCallBudgetMs,
    failures: [],
    blockedReason: `only ${FUZZ_EXTRACTORS.length} extractors registered, below the policy floor of ${requirements.minimumExtractors}`,
  });
  process.exit(1);
}

// --- phase 2: real fuzz over every shipped extractor --------------------------------------------
say('');
say(
  `[fuzz:check] phase 2 — real fuzz: ${iterations} iters/extractor × ${FUZZ_EXTRACTORS.length} extractors (seed=${requirements.seed}, budget ${requirements.perCallBudgetMs}ms)`,
);
const perExtractor = [];
const reproducers = [];
for (const spec of FUZZ_EXTRACTORS) {
  const o = await runFuzz(spec.name, {
    iterations,
    budgetMs: requirements.perCallBudgetMs,
    seed: requirements.seed,
  });
  const bad = o.throw + o.hang + o.invalid;
  perExtractor.push({
    extractor: spec.name,
    ok: o.ok,
    throw: o.throw,
    hang: o.hang,
    invalid: o.invalid,
  });
  if (bad > 0) {
    fail(
      `${spec.name}: ${bad} bad inputs (ok=${o.ok}/${iterations} throw=${o.throw} hang=${o.hang} invalid=${o.invalid})`,
    );
    for (const r of o.reproducers.slice(0, 3)) {
      const text =
        r.text.length > 120 ? `${r.text.slice(0, 120)}…(${r.text.length} chars)` : r.text;
      const line =
        `    reproducer — ${r.extractor} idx=${r.idx} outcome=${r.outcome}${r.reason ? ` reason="${r.reason}"` : ''}` +
        `\n      text=${JSON.stringify(text)}`;
      transcript.push(line);
      process.stderr.write(`${line}\n`);
      reproducers.push({
        extractor: r.extractor,
        idx: r.idx,
        outcome: r.outcome,
        reason: r.reason ?? null,
        text: r.text.slice(0, 400),
      });
    }
  } else {
    say(`  ${spec.name.padEnd(22)} ok=${o.ok}/${iterations} ✓`);
  }
}

const totalCases = iterations * FUZZ_EXTRACTORS.length;
say('');

// The summary enters the transcript BEFORE the receipt is built: the receipt pins the transcript's
// sha256, so the log has to be final by the time the receipt describes it.
if (failed === 0) {
  say(
    `[fuzz:check] PASS — all ${FUZZ_EXTRACTORS.length} extractors clean across ${iterations} iters (0 throw / 0 hang / 0 invalid)`,
  );
} else {
  const line = `[fuzz:check] FAIL — ${failed} extractor(s) failed (reproducers above)`;
  transcript.push(line);
  process.stderr.write(`\n${line}\n`);
}

finish(failed === 0 ? 'pass' : 'fail', {
  extractors: perExtractor.map((e) => e.extractor),
  extractorCount: perExtractor.length,
  requiredExtractors: requirements.minimumExtractors,
  totalCases,
  perCallBudgetMs: requirements.perCallBudgetMs,
  failures: reproducers,
  selfTest: 'detector self-test passed (hang/throw/invalid each detected, none misattributed)',
});

process.exit(failed === 0 ? 0 : 1);
