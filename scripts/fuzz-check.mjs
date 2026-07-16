import { execFileSync } from 'node:child_process';
/**
 * fuzz-check — the M3.5 parser-fuzz gate.
 *
 * Pins the plan's M3.5 intent — "any byte sequence → extractor terminates in budget, never throws,
 * valid node set — per extractor" — against the SHIPPED 9-extractor fleet, with real teeth: each
 * extract runs in a worker_threads isolate under a per-call wall-clock budget, so a SYNC HANG (the
 * PL/SQL `recover()` infinite-loop class) is caught by worker termination, not swallowed by a
 * blocked event loop. fast-check inputs are SEEDED (seed=1) → reproducible input-for-input.
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
 *   (2) REAL FUZZ: for each of the 9 shipped extractors, run `iterations` seeded inputs and assert
 *       ok === iterations (0 throw / 0 hang / 0 invalid). On any failure, print up to 3
 *       reproducers (exact (extractor, idx, text, reason)) and exit 1.
 *
 * Usage:
 *   node scripts/fuzz-check.mjs                # smoke: 1000 iterations/extractor (release:verify)
 *   node scripts/fuzz-check.mjs --iterations 1000000   # nightly: 10^6/extractor (fuzz:nightly)
 *
 * release:verify builds every package before any gate runs, so the dynamic import of the built
 * parsers dist resolves. A standalone `pnpm fuzz:check` is guarded: if dist/fuzz-worker.js is
 * missing, the parsers package is built first.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const PARSERS_DIST = resolve(REPO, 'packages', 'parsers', 'dist', 'fuzz-worker.js');

// --- args ---------------------------------------------------------------------------------------
let iterations = 1000; // smoke default; nightly overrides via --iterations 1000000
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--iterations' && argv[i + 1]) {
    iterations = Number.parseInt(argv[i + 1], 10);
    i++;
  }
}

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
  resolve(REPO, 'packages', 'parsers', 'dist', 'index.js')
);

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  fuzz:check FAIL — ${msg}\n`);
  failed++;
};

// --- phase 1: detector self-test ----------------------------------------------------------------
process.stdout.write(
  '\n[fuzz:check] phase 1 — detector self-test (3 fakes, budget 200ms, 4 iters each)\n',
);
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
    process.stdout.write(
      `  self-test OK — hang=${self.hang.hang} throw=${self.throw.throw} invalid=${self.invalid.invalid} (each >0, no misattribution)\n`,
    );
} catch (err) {
  fail(`self-test threw: ${err instanceof Error ? err.message : String(err)}`);
}

if (failed > 0) {
  process.stderr.write(
    '\n[fuzz:check] detector self-test FAILED — aborting before real fuzz (numbers would be meaningless)\n',
  );
  process.exit(1);
}

// --- phase 2: real fuzz over the 9 shipped extractors -------------------------------------------
process.stdout.write(
  `\n[fuzz:check] phase 2 — real fuzz: ${iterations} iters/extractor × ${FUZZ_EXTRACTORS.length} extractors (seed=1, budget 1000ms)\n`,
);
for (const spec of FUZZ_EXTRACTORS) {
  const o = await runFuzz(spec.name, { iterations, budgetMs: 1000, seed: 1 });
  const bad = o.throw + o.hang + o.invalid;
  if (bad > 0) {
    fail(
      `${spec.name}: ${bad} bad inputs (ok=${o.ok}/${iterations} throw=${o.throw} hang=${o.hang} invalid=${o.invalid})`,
    );
    for (const r of o.reproducers.slice(0, 3)) {
      const text =
        r.text.length > 120 ? `${r.text.slice(0, 120)}…(${r.text.length} chars)` : r.text;
      process.stderr.write(
        `    reproducer — ${r.extractor} idx=${r.idx} outcome=${r.outcome}${r.reason ? ` reason="${r.reason}"` : ''}\n      text=${JSON.stringify(text)}\n`,
      );
    }
  } else {
    process.stdout.write(`  ${spec.name.padEnd(22)} ok=${o.ok}/${iterations} ✓\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`\n[fuzz:check] ${failed} extractor(s) failed — see reproducers above\n`);
  process.exit(1);
}
process.stdout.write(
  `\n[fuzz:check] PASS — all ${FUZZ_EXTRACTORS.length} extractors clean across ${iterations} iters (0 throw / 0 hang / 0 invalid)\n`,
);
