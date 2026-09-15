/**
 * Fuzz receipt artifact-path tests (Task 4 regression) and candidate-binding source pins (Task 9).
 *
 * The deep-fuzz harness used to record its transcript with a MACHINE-ABSOLUTE path. The launch
 * decision resolves artifact paths against the receipts root it was handed, and resolve() honours
 * an absolute path VERBATIM — so the transcript digest could never verify once the receipts moved
 * (the CI layout uploads them out of the checkout entirely): every real release run NO-GO'd on
 * `global-receipt-artifact-digest:fuzz-deep`. The producer-side contract — record the artifact
 * RELATIVE to the receipt's own directory, with --artifact-root naming what to resolve it against
 * — is what these tests pin. The decision side (a relative artifact verifying from the receipts
 * root) is already covered by launch-decision.test.mjs's fuzz fixtures.
 *
 * The Task 9 pins below are source-pins for the same reason: importing fuzz-check.mjs runs a
 * million-iteration sweep, so the candidate-binding seams are asserted against the source. Source
 * pins are PRESENCE evidence only — reviewers applied reorder/delete mutations of the binding
 * block and this whole file stayed green — so the EXECUTION proof lives in
 * candidate-parser.test.mjs, which spawns the real harness against a planted bundle and asserts
 * the receipt names the installed build's worker hash and extractor fleet, and in
 * launch-decision.mjs, whose judgeFuzzWorkload refuses a receipt without details.candidate
 * (blocker `fuzz-receipt-unbound-candidate`). These pins document the seams the e2e covers from
 * the harness's own side.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceipt } from './write-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'fuzz-receipt-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const shaOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ── the receipt records its transcript relative to its own directory ─────────────────────────────
// Exactly what the harness produces: a transcript beside the receipt (fuzz-deep.json.log), passed
// with --artifact-root so the writer resolves and hashes it at build time but stores the PATH
// relative — relocatable evidence, the collector's established pattern.
const sweepDir = join(root, 'evidence', 'global');
mkdirSync(sweepDir, { recursive: true });
const transcriptBytes = 'the archived transcript bytes\n';
writeFileSync(join(sweepDir, 'fuzz-deep.json.log'), transcriptBytes);
const pkgBytes = 'candidate tarball bytes\n';
writeFileSync(join(root, 'candidate.tgz'), pkgBytes);

const receipt = buildReceipt({
  type: 'fuzz-deep',
  argv: [
    '--command',
    'node scripts/fuzz-check.mjs --iterations 1000000',
    '--exit-code',
    '0',
    '--status',
    'pass',
    '--artifact',
    'fuzz-deep.json.log',
    '--artifact-root',
    sweepDir,
    '--package',
    join(root, 'candidate.tgz'),
  ],
  details: { workload: 'seeded-deep', seed: 1, iterations: 1000000 },
});
assert.equal(
  receipt.artifacts[0]?.path,
  'fuzz-deep.json.log',
  'the stored artifact path must be the relative name, not the machine-absolute path',
);
assert.ok(!isAbsolute(receipt.artifacts[0].path), 'a stored artifact path must never be absolute');
assert.equal(receipt.artifacts[0].sha256, shaOf(transcriptBytes));
assert.equal(receipt.status, 'pass');

// The property that was broken: the receipt still verifies after its whole directory has MOVED —
// which is what an upload + download between producer and judge is. The decision resolves
// `<receiptsRoot>/<artifact.path>`; a relative path survives that, an absolute one cannot.
const movedDir = join(root, 'downloaded', 'global');
mkdirSync(dirname(movedDir), { recursive: true });
renameSync(sweepDir, movedDir);
const movedArtifact = join(movedDir, receipt.artifacts[0].path);
assert.ok(existsSync(movedArtifact), 'the recorded artifact must resolve from the MOVED root');
assert.equal(shaOf(readFileSync(movedArtifact)), receipt.artifacts[0].sha256);

// The inverse is the old defect: a receipt whose artifact path is absolute pins its evidence to
// the producing machine's directory tree — refuse nothing at build time (the writer cannot know
// the future root), but the PATH FIELD is what a judge resolves, so the contract is on the field.
const absoluteReceipt = buildReceipt({
  type: 'fuzz-deep',
  argv: [
    '--command',
    'node scripts/fuzz-check.mjs --iterations 1000000',
    '--exit-code',
    '0',
    '--status',
    'pass',
    '--artifact',
    join(movedDir, 'fuzz-deep.json.log'),
    '--package',
    join(root, 'candidate.tgz'),
  ],
  details: { workload: 'seeded-deep', seed: 1, iterations: 1000000 },
});
assert.equal(absoluteReceipt.artifacts[0].path, join(movedDir, 'fuzz-deep.json.log'));
assert.ok(
  isAbsolute(absoluteReceipt.artifacts[0].path),
  'a bare --artifact is stored VERBATIM (the writer does not relativize) — the harness must relativize itself',
);

// ── the harness side: fuzz-check.mjs is not importable (importing it runs the sweep), so the
// artifact argv is pinned by reading the source — the exact seam that broke, in the only way it
// can be tested without running a million-iteration fuzz.
const source = readFileSync(join(HERE, 'fuzz-check.mjs'), 'utf8');
assert.match(
  source,
  /'--artifact',\s*relative\(receiptDir,\s*archived\)/,
  'the harness must record the transcript relative to the receipt directory, never machine-absolute',
);
assert.match(
  source,
  /'--artifact-root',\s*receiptDir/,
  'the harness must pass --artifact-root so the writer hashes the transcript at build time',
);

// ── Task 9 pins: the sweep must execute the INSTALLED candidate, not the checkout build ────────────
// fuzz-check.mjs is not importable (importing it runs the sweep), so the candidate-binding seams
// are pinned against the source. The behaviours behind them are tested in
// candidate-parser.test.mjs on fake bundles: a planted checkout build changes nothing, tampered
// installed bytes are refused, and every runtime dependency resolves inside the isolated prefix.
assert.match(
  source,
  /import \{ prepareCandidateParser \} from '\.\/candidate-parser\.mjs'/,
  'the harness must bind the candidate through the candidate-parser module, not a bare checkout import',
);
assert.match(
  source,
  /provenance\s*\?\s*provenance\.moduleUrl\s*:\s*pathToFileURL\(resolve\(REPO, 'packages', 'parsers', 'dist', 'index\.js'\)\)\.href/,
  'a --package run must import the parser from the isolated installation; only a no-package smoke run may use the checkout dist',
);
assert.match(
  source,
  /failures: archivedFailures/,
  'the receipt must archive every reproducer through archivedFailures — slicing failures discards evidence',
);
assert.ok(
  !source.includes('.slice(0, 400)'),
  'no reproducer text may be sliced to 400 chars in the receipt — the archive is full text',
);
assert.ok(
  !/failures:\s*o\.reproducers\.slice/.test(source),
  'the receipt failures field must never be a sliced transcript sample',
);
assert.match(
  source,
  /accounted !== iterations/,
  'the sweep must account every generated case per extractor (ok+throw+hang+invalid === iterations)',
);
assert.match(
  source,
  /const perExtractor = \[\];/,
  'the sweep must collect per-extractor case counts',
);
assert.match(
  source,
  /^\s*perExtractor,$/m,
  'the receipt details must carry the per-extractor counts, not just a fleet total',
);
assert.match(
  source,
  /\.\.\.\(provenance \? \{ candidate: provenance\.candidate \} : \{\}\)/,
  'every receipt from a candidate run — pass or fail — must record which packaged parser bytes executed',
);

// ── the failure archive is CAPPED, and the cap is RECORDED — never a silent truncation ─────────────
// An uncapped full-text archive at fleet scale (a throw regression across ~10^6 cases × 10
// extractors) blows past V8's string-size limit inside JSON.stringify BEFORE writeFileSync — the
// one run that most needs a receipt produced none. The fix is a per-extractor cap whose
// truncation is recorded in details.failuresTruncated, so the archive can never read cleaner
// than the run: perExtractor keeps the un-truncated totals and the seed regenerates every
// truncated input from (extractor, idx).
assert.match(
  source,
  /const FULL_TEXT_FAILURES_PER_EXTRACTOR = \d+;/,
  'the full-text failure archive must be bounded by an explicit per-extractor cap constant',
);
assert.match(
  source,
  /failuresTruncated\.push\(\{/,
  'a capped archive must record what was truncated (extractor, archived, truncated, firstTruncatedIdx)',
);
assert.match(
  source,
  /\.\.\.\(failuresTruncated\.length > 0 \? \{ failuresTruncated \} : \{\}\)/,
  'the receipt details must carry failuresTruncated exactly when truncation happened',
);
assert.match(
  source,
  /const archivedCount = Math\.min\(o\.reproducers\.length, FULL_TEXT_FAILURES_PER_EXTRACTOR\);/,
  'the archived slice must be the capped count — an uncapped push is the RangeError trap',
);

// ── a BLOCKED receipt must be relocatable evidence too: no producer-machine paths ─────────────────
// The binding failure path writes a receipt describing why the run never started. Those error
// messages embed machine paths (the temp prefix, its realpath form, the checkout, the bundle
// directory) — the Task 4 lesson applies to blockedReason exactly as it did to artifact paths: a
// receipt that embeds /var/folders/... verifies on no machine but its own. The transcript keeps
// the verbatim message (it is read on the producing machine); the RECEIPT gets stable tokens.
assert.match(
  source,
  /\[prefixReal, '<candidate-prefix>'\],\s*\[candidatePrefix, '<candidate-prefix>'\],\s*\[REPO, '<repo>'\],\s*\[dirname\(resolve\(packagePath\)\), '<candidate-bundle>'\],/,
  'blockedReason must sanitize every producer-machine path (realpath form first) into stable tokens',
);
assert.match(
  source,
  /`node scripts\/fuzz-check\.mjs \$\{argv\.join\(' '\)\}`/,
  'the receipt must record the invocation AS INVOKED — a candidate-bound deep run and a checkout smoke run must not write identical commandResults',
);

console.log('fuzz receipt artifact tests ok');
