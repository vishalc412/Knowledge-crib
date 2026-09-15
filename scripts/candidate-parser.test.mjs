/**
 * Candidate-binding tests (Task 9 regressions).
 *
 * The deep-fuzz harness used to import `runFuzz` from the CHECKOUT's `packages/parsers/dist`
 * while writing a receipt that named the candidate bundle — a receipt describing bytes that never
 * executed. These tests pin the closed loop: a candidate bundle is installed into an isolated
 * prefix, the sweep imports the parser from that INSTALLATION, the executed worker/grammar bytes
 * are verified against the packed tarball, and a deliberately different parser build planted in
 * the checkout changes NOTHING because the checkout is not being tested.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertResolvesInsidePrefix,
  copyInputGeneratorIntoPrefix,
  prepareCandidateParser,
  resolveRuntimeDependencies,
  verifyInstalledParsersAgainstBundle,
} from './candidate-parser.mjs';

const root = mkdtempSync(join(tmpdir(), 'candidate-parser-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Pack a directory-shaped package (files map + package.json fields) into an npm-style tarball. */
function pack(dir, tarballName, { pkg, files }) {
  const staging = join(root, 'staging', tarballName);
  // Staging dirs are reused across packs of the same tarball name; stale files from a previous
  // pack would silently ride into the new tarball (a "missing worker" fixture that ships one).
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'package'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(staging, 'package', rel)), { recursive: true });
    writeFileSync(join(staging, 'package', rel), content);
  }
  writeFileSync(join(staging, 'package', 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const tgz = join(dir, tarballName);
  const packed = spawnSync('tar', ['-czf', tgz, '-C', staging, 'package']);
  assert.equal(packed.status, 0, `packing ${tarballName} failed: ${packed.stderr}`);
  return tgz;
}

/** The candidate parsers package the sweep is supposed to execute: a module carrying a MARKER.
 * Ten extractors (the policy's fleet floor), because the end-to-end harness run below must pass
 * fuzz-check.mjs's own fleet check — a one-extractor fake would abort at the floor and the e2e
 * would only ever exercise the failure path. */
const CANDIDATE_INDEX = [
  "export const __fuzzSource = 'candidate-build';",
  'export const FUZZ_EXTRACTORS = [...Array.from({ length: 10 }, (_, i) => ({ name: `planted-${i}` }))];',
  'export async function runFuzz(name, opts) {',
  '  return { extractor: name, iterations: opts.iterations, ok: opts.iterations, throw: 0, hang: 0, invalid: 0, reproducers: [] };',
  '}',
  'export async function runFakeselfTest() {',
  '  return { hang: { hang: 1, throw: 0, invalid: 0 }, throw: { throw: 1, hang: 0, invalid: 0 }, invalid: { invalid: 1, hang: 0, throw: 0 } };',
  '}',
  '',
].join('\n');
const CANDIDATE_WORKER = '// the packaged worker bytes — hashed against the tarball member\n';
const CANDIDATE_GRAMMAR = 'candidate wasm bytes\n';

/** An ESM-only workspace dependency, mirroring the real @knowledge-crib/soul-schema: `type:
 * module` with an exports map that has no `require` condition and no `./package.json` subpath.
 * Entry-level CJS resolution cannot see it (ERR_PACKAGE_PATH_NOT_EXPORTED) — the first version
 * of the runtime-dep guard used exactly that probe and refused every real candidate bundle at
 * binding; the fixture pins that the directory-level guard resolves it anyway. */
const ESM_ONLY_PACKAGE_JSON = `${JSON.stringify(
  {
    name: '@knowledge-crib/soul-schema',
    version: '0.1.0',
    type: 'module',
    exports: { '.': { import: './index.js' }, './schemas/*': './schemas/*.json' },
  },
  null,
  2,
)}\n`;

/** A minimal but structurally real bundle: manifest + root + parsers + soul-schema packages and
 * both installers. The parsers package declares the ESM-only dependency, like the real one. */
function makeBundle(dir, { parsersIndex = CANDIDATE_INDEX, mutate } = {}) {
  mkdirSync(dir, { recursive: true });
  pack(dir, 'knowledge-crib-0.1.0.tgz', {
    pkg: { name: 'knowledge-crib', version: '0.1.0' },
    files: { 'dist/cli.js': 'export {};\n' },
  });
  pack(dir, 'knowledge-crib-soul-schema-0.1.0.tgz', {
    pkg: JSON.parse(ESM_ONLY_PACKAGE_JSON),
    files: { 'index.js': 'export const x = 1;\n' },
  });
  pack(dir, 'knowledge-crib-parsers-0.1.0.tgz', {
    pkg: {
      name: '@knowledge-crib/parsers',
      version: '0.1.0',
      dependencies: { '@knowledge-crib/soul-schema': '0.1.0' },
    },
    files: {
      'dist/index.js': parsersIndex,
      'dist/fuzz/fuzz-worker.js': CANDIDATE_WORKER,
      'grammars/tree-sitter-php.wasm': CANDIDATE_GRAMMAR,
    },
  });
  const installers = { macos: 'install-macos.sh', windows: 'install-windows.ps1' };
  const checksums = [
    'knowledge-crib-0.1.0.tgz',
    'knowledge-crib-soul-schema-0.1.0.tgz',
    'knowledge-crib-parsers-0.1.0.tgz',
  ].map((file) => ({ file, sha256: sha256Hex(readFileSync(join(dir, file))) }));
  for (const file of Object.values(installers)) {
    const bytes = file.endsWith('.ps1') ? '# ps\n' : '#!/bin/sh\n';
    writeFileSync(join(dir, file), bytes);
    checksums.push({ file, sha256: sha256Hex(bytes) });
  }
  const manifest = {
    name: 'knowledge-crib',
    version: '0.1.0',
    tag: 'knowledge-crib-0.1.0',
    package: 'knowledge-crib-0.1.0.tgz',
    packages: [
      'knowledge-crib-0.1.0.tgz',
      // The parsers package DEPENDS on soul-schema, and installCandidate installs exactly
      // manifest.packages in one npm invocation — a dependency tarball absent from this list
      // never lands in the prefix, and the runtime-dep walk-up then refuses the bundle with a
      // false "install incomplete" (the failure mode the old entry-level probe always had).
      'knowledge-crib-soul-schema-0.1.0.tgz',
      'knowledge-crib-parsers-0.1.0.tgz',
    ],
    installers,
    checksums,
  };
  if (mutate) mutate(manifest, dir);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestChecksums: checksums };
}

/** A checkout-shaped directory: the input generator at its node_modules root, and (optionally) a
 * DELIBERATELY DIFFERENT parser build planted where the old harness used to fuzz from. */
function makeRepo(dir, { plantDifferentParserBuild = true } = {}) {
  mkdirSync(join(dir, 'node_modules', 'fast-check'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'fast-check', 'package.json'),
    `${JSON.stringify({ name: 'fast-check', version: '0.0.0-fake', main: 'index.js' })}\n`,
  );
  writeFileSync(
    join(dir, 'node_modules', 'fast-check', 'index.js'),
    'export const sample = () => [];\n',
  );
  if (plantDifferentParserBuild) {
    // The planted build: what the harness WOULD have executed before the candidate binding. Its
    // marker is deliberately different so any leak back into the checkout shows up as a wrong byte.
    mkdirSync(join(dir, 'packages', 'parsers', 'dist', 'fuzz'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'parsers', 'dist', 'index.js'),
      "export const __fuzzSource = 'checkout-build';\n",
    );
    writeFileSync(
      join(dir, 'packages', 'parsers', 'dist', 'fuzz', 'fuzz-worker.js'),
      '// the CHECKOUT worker bytes\n',
    );
  }
  return dir;
}

// ── the planted-checkout regression: candidate fuzz bytes come from the installation ──────────────
// A deliberately different parser build sits in the checkout (both as a workspace dist and as the
// module a bare checkout import would load). The candidate sweep must execute the INSTALLED
// candidate's bytes anyway — that is the whole meaning of a candidate-bound receipt.
const bundleDir = join(root, 'bundle');
const { manifest } = makeBundle(bundleDir);
const repo = makeRepo(join(root, 'checkout'));
const prefix = join(root, 'prefix');
const provenance = prepareCandidateParser({
  packagePath: join(bundleDir, 'knowledge-crib-0.1.0.tgz'),
  repo,
  prefix,
});

const candidate = await import(provenance.moduleUrl);
assert.equal(
  candidate.__fuzzSource,
  'candidate-build',
  'the sweep must execute the INSTALLED candidate parser, not the checkout build',
);
assert.ok(
  candidate.__fuzzSource !== 'checkout-build',
  'a candidate-bound run that executes the planted checkout build is the Task 9 defect',
);
assert.ok(
  typeof candidate.runFuzz === 'function' && Array.isArray(candidate.FUZZ_EXTRACTORS),
  'the installed candidate must expose the fuzz API the harness drives',
);

// ── the receipt's provenance: package, worker, and grammar hashes, verified against the bundle ────
assert.equal(provenance.candidate.package, 'knowledge-crib-0.1.0.tgz');
assert.equal(provenance.candidate.parsersPackage, 'knowledge-crib-parsers-0.1.0.tgz');
assert.equal(
  provenance.candidate.parsersPackageSha256,
  `sha256:${manifest.checksums.find((c) => c.file === 'knowledge-crib-parsers-0.1.0.tgz').sha256}`,
  'the recorded parser package hash must be the manifest-declared bundle checksum',
);
assert.equal(
  provenance.candidate.worker.path,
  join('dist', 'fuzz', 'fuzz-worker.js'),
  'the worker path is receipt-shaped (relative to the parsers package), never machine-absolute',
);
assert.equal(
  provenance.candidate.worker.sha256,
  `sha256:${sha256Hex(CANDIDATE_WORKER)}`,
  'the recorded worker hash must be the exact packaged bytes',
);
assert.equal(provenance.candidate.grammars.length, 1);
assert.equal(provenance.candidate.grammars[0].path, join('grammars', 'tree-sitter-php.wasm'));
assert.equal(
  provenance.candidate.grammars[0].sha256,
  `sha256:${sha256Hex(CANDIDATE_GRAMMAR)}`,
  'the recorded grammar hash must be the exact packaged bytes',
);
assert.ok(provenance.candidate.isolatedPrefix, 'the provenance must state the prefix was isolated');
assert.ok(
  provenance.candidate.runtimeDependencies.includes('fast-check'),
  'the input generator must resolve inside the isolated prefix (recorded as a runtime dependency)',
);
assert.ok(
  provenance.candidate.runtimeDependencies.includes('@knowledge-crib/soul-schema'),
  'an ESM-only dependency (no "require" condition, no ./package.json subpath) must still resolve ' +
    'inside the prefix — the old entry-level probe refused every real bundle with ERR_PACKAGE_PATH_NOT_EXPORTED',
);

// ── the input generator is copied into the prefix, not resolved from the checkout ──────────────────
const generatorDir = join(prefix, 'lib', 'node_modules', 'fast-check');
assert.ok(
  readFileSync(join(generatorDir, 'index.js'), 'utf8').includes('sample'),
  'the copied generator must be real files in the prefix (dereferenced, not a symlink back)',
);

// ── byte verification: tampered installed bytes are refused ───────────────────────────────────────
const tamperDir = join(root, 'tamper');
const tamperBundle = join(tamperDir, 'bundle');
makeBundle(tamperBundle);
const tamperPrefix = join(tamperDir, 'prefix');
const tampered = prepareCandidateParser({
  packagePath: join(tamperBundle, 'knowledge-crib-0.1.0.tgz'),
  repo: makeRepo(join(tamperDir, 'checkout')),
  prefix: tamperPrefix,
});
assert.doesNotThrow(() =>
  verifyInstalledParsersAgainstBundle({
    parsersTarball: join(tamperBundle, 'knowledge-crib-parsers-0.1.0.tgz'),
    parsersDir: join(tamperPrefix, 'lib', 'node_modules', '@knowledge-crib', 'parsers'),
    files: [join('dist', 'fuzz', 'fuzz-worker.js'), join('grammars', 'tree-sitter-php.wasm')],
  }),
);
// Swap the installed worker for the CHECKOUT's deliberately different bytes: verification must
// refuse, because those are not the packaged candidate bytes.
writeFileSync(
  join(
    tamperPrefix,
    'lib',
    'node_modules',
    '@knowledge-crib',
    'parsers',
    'dist',
    'fuzz',
    'fuzz-worker.js',
  ),
  '// the CHECKOUT worker bytes\n',
);
assert.throws(
  () =>
    verifyInstalledParsersAgainstBundle({
      parsersTarball: join(tamperBundle, 'knowledge-crib-parsers-0.1.0.tgz'),
      parsersDir: join(tamperPrefix, 'lib', 'node_modules', '@knowledge-crib', 'parsers'),
      files: [join('dist', 'fuzz', 'fuzz-worker.js'), join('grammars', 'tree-sitter-php.wasm')],
    }),
  /does not match the candidate bundle's packaged bytes/,
  'installed bytes that differ from the packed tarball must be refused',
);
// A tarball missing a file the sweep executes is refused too. (Tested directly: a bundle
// without the worker never gets past prepareCandidateParser, which reads the installed grammars
// directory before it verifies bytes — this pins the byte-verifier's own refusal.)
const missingDir = join(root, 'missing');
const missingBundle = join(missingDir, 'bundle');
mkdirSync(missingBundle, { recursive: true });
pack(missingBundle, 'knowledge-crib-parsers-0.1.0.tgz', {
  pkg: { name: '@knowledge-crib/parsers', version: '0.1.0' },
  files: { 'dist/index.js': CANDIDATE_INDEX }, // no worker, no grammars
});
const missingParsersDir = join(missingDir, 'installed', '@knowledge-crib', 'parsers');
mkdirSync(join(missingParsersDir, 'dist'), { recursive: true });
writeFileSync(join(missingParsersDir, 'dist', 'index.js'), CANDIDATE_INDEX);
assert.throws(
  () =>
    verifyInstalledParsersAgainstBundle({
      parsersTarball: join(missingBundle, 'knowledge-crib-parsers-0.1.0.tgz'),
      parsersDir: missingParsersDir,
      files: [join('dist', 'fuzz', 'fuzz-worker.js')],
    }),
  /does not contain/,
  'a candidate bundle without the worker the sweep spawns must be refused',
);

// ── the no-checkout guard: runtime dependencies must resolve inside the prefix ────────────────────
assert.throws(
  () =>
    assertResolvesInsidePrefix(join(repo, 'packages', 'parsers', 'dist', 'index.js'), {
      prefix,
      repo,
      label: 'planted-parser',
    }),
  /SOURCE CHECKOUT/,
  'a dependency resolving back into the checkout must be refused by name',
);
assert.doesNotThrow(() =>
  assertResolvesInsidePrefix(join(prefix, 'lib', 'node_modules', 'fast-check', 'index.js'), {
    prefix,
    repo,
    label: 'generator',
  }),
);

// The realistic leak: a symlinked dependency pointing back into the checkout. require.resolve
// follows symlinks to the REAL path, so the guard must catch it — this is exactly how a
// "candidate-bound" run quietly becomes a checkout run.
rmSync(generatorDir, { recursive: true, force: true });
symlinkSync(join(repo, 'node_modules', 'fast-check'), generatorDir);
assert.throws(
  () => resolveRuntimeDependencies({ modulePath: provenance.modulePath, prefix, repo }),
  /SOURCE CHECKOUT/,
  'a runtime dependency that symlinks back into the source checkout must fail the run',
);
rmSync(generatorDir, { recursive: true, force: true });

// ── a modified bundle is refused before anything installs ─────────────────────────────────────────
const modifiedDir = join(root, 'modified');
const modifiedBundle = join(modifiedDir, 'bundle');
makeBundle(modifiedBundle);
writeFileSync(
  join(modifiedBundle, 'knowledge-crib-parsers-0.1.0.tgz'),
  "swapped bytes wearing the candidate tarball's name\n",
);
assert.throws(
  () =>
    prepareCandidateParser({
      packagePath: join(modifiedBundle, 'knowledge-crib-0.1.0.tgz'),
      repo: makeRepo(join(modifiedDir, 'checkout'), { plantDifferentParserBuild: false }),
      prefix: join(modifiedDir, 'prefix'),
    }),
  /does not match its manifest checksum/,
  'a bundle whose bytes disagree with its own manifest is not a candidate',
);

// ── the generator copy is self-contained: it carries its runtime deps with it ─────────────────────
const copyRoot = join(root, 'copy-src');
const pnpmStore = join(copyRoot, 'node_modules', '.pnpm', 'fast-check@0.0.0-fake', 'node_modules');
mkdirSync(join(pnpmStore, 'fast-check'), { recursive: true });
mkdirSync(join(pnpmStore, 'pure-rand'), { recursive: true });
writeFileSync(
  join(pnpmStore, 'fast-check', 'package.json'),
  `${JSON.stringify({ name: 'fast-check', version: '0.0.0-fake', main: 'index.js', dependencies: { 'pure-rand': '^0.0.0' } })}\n`,
);
writeFileSync(join(pnpmStore, 'fast-check', 'index.js'), 'export {};\n');
// pnpm nests the dependency in .pnpm — a root-level copy would miss it; resolution must find it
// from the PARENT package's real dir, not the repo root (repo/node_modules/pure-rand absent).
writeFileSync(
  join(pnpmStore, 'pure-rand', 'package.json'),
  `${JSON.stringify({ name: 'pure-rand', version: '0.0.0-fake' })}\n`,
);
// pnpm's node_modules/fast-check is a symlink into .pnpm — resolve through it, like the real repo.
mkdirSync(join(copyRoot, 'node_modules'), { recursive: true });
symlinkSync(join(pnpmStore, 'fast-check'), join(copyRoot, 'node_modules', 'fast-check'));
const copied = copyInputGeneratorIntoPrefix({
  repo: copyRoot,
  prefix: join(copyRoot, 'prefix'),
});
assert.deepEqual(
  copied,
  ['fast-check', 'pure-rand'],
  'the generator copy must include transitive runtime deps',
);

// ── end to end: EXECUTE the harness against a planted candidate and read the receipt ─────────────
// The source pins in fuzz-check.test.mjs are presence tests — reviewers applied the reorder and
// delete mutations of the candidate-binding block to /tmp copies and the whole suite stayed green,
// because a regex over the source proves the binding is WRITTEN, not that it RUNS. This closes the
// loop by spawning the real fuzz-check.mjs with --package and asserting the receipt describes the
// bytes that executed: the worker hash and the extractor names come from the INSTALLED candidate
// (planted-0..planted-9). A harness reordered or edited into importing the checkout's
// packages/parsers/dist instead reports the checkout build's extractors and fails the deep-equal.
const e2eDir = join(root, 'e2e');
const e2eBundle = join(e2eDir, 'bundle');
makeBundle(e2eBundle);
const e2eReceipt = join(e2eDir, 'fuzz-deep.json');
const e2eRun = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('./fuzz-check.mjs', import.meta.url)),
    '--iterations',
    '1000000',
    '--receipt',
    e2eReceipt,
    '--package',
    join(e2eBundle, 'knowledge-crib-0.1.0.tgz'),
  ],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
assert.equal(
  e2eRun.status,
  0,
  `a candidate-bound deep run over a clean planted bundle must pass; got exit ${e2eRun.status}\n${e2eRun.stderr}`,
);
const e2e = JSON.parse(readFileSync(e2eReceipt, 'utf8'));
assert.equal(e2e.status, 'pass', 'the receipt must record a passing deep run');
assert.equal(
  e2e.details.candidate.worker.sha256,
  `sha256:${sha256Hex(CANDIDATE_WORKER)}`,
  'the receipt must hash the exact planted worker bytes — the bytes that ran',
);
assert.deepEqual(
  e2e.details.extractors,
  Array.from({ length: 10 }, (_, i) => `planted-${i}`),
  "the receipt must name the INSTALLED candidate build's extractor fleet — a run that fell back " +
    "to the checkout dist would report the checkout build's extractors instead",
);
assert.equal(e2e.details.totalCases, 10_000_000, '10 extractors × 10^6 cases must be accounted');
assert.equal(e2e.details.failures.length, 0, 'the planted candidate must report zero failures');

console.log('candidate parser binding tests ok');
