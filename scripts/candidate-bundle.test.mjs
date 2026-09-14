/**
 * Candidate-bundle verification (Task 3 regressions).
 *
 * Certifying mode used to hash ONE tarball and call the launch verified — while never checking
 * the bundle's manifest, its other seven workspace packages, or the installers. A bundle whose
 * bytes disagree with its own manifest checksums is not a candidate, it is a modified artifact
 * wearing a candidate's name. These tests pin every refusal closed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertInstalled,
  bundleDigests,
  digestsDiffer,
  installCandidate,
  readBundleManifest,
  verifyBundle,
} from './candidate-bundle.mjs';

const root = mkdtempSync(join(tmpdir(), 'candidate-bundle-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A minimal but structurally real bundle: manifest + two packages + both installers, checksums matching bytes. */
function makeBundle(dir, { mutate } = {}) {
  mkdirSync(dir, { recursive: true });
  const packages = ['knowledge-crib-0.1.0.tgz', 'knowledge-crib-memory-0.1.0.tgz'];
  const installers = { macos: 'install-macos.sh', windows: 'install-windows.ps1' };
  const checksums = [];
  for (const name of packages) {
    const bytes = `${name} bytes\n`;
    writeFileSync(join(dir, name), bytes);
    checksums.push({ file: name, sha256: sha256Hex(bytes) });
  }
  // The installers are checksummed like any package — the install cycle EXECUTES them, so the
  // manifest must vouch for their bytes too.
  for (const file of Object.values(installers)) {
    const bytes = file.endsWith('.ps1') ? '# ps\n' : '#!/bin/sh\n';
    writeFileSync(join(dir, file), bytes);
    checksums.push({ file, sha256: sha256Hex(bytes) });
  }
  const manifest = {
    name: 'knowledge-crib',
    version: '0.1.0',
    tag: 'knowledge-crib-0.1.0',
    package: packages[0],
    packages,
    installers,
    checksums,
  };
  if (mutate) mutate(manifest, dir);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, packages };
}

// ── readBundleManifest: a directory that is not a bundle is refused ───────────────────────────────
assert.throws(() => readBundleManifest(join(root, 'empty')), /no manifest\.json/);
const badJson = join(root, 'bad-json');
mkdirSync(badJson);
writeFileSync(join(badJson, 'manifest.json'), '{not json');
assert.throws(() => readBundleManifest(badJson), /not valid JSON/);
const noPackages = join(root, 'no-packages');
mkdirSync(noPackages);
writeFileSync(join(noPackages, 'manifest.json'), JSON.stringify({ name: 'x', packages: [] }));
assert.throws(() => readBundleManifest(noPackages), /declares no packages/);

// ── verifyBundle: the supplied tarball must be the bundle's own root package ─────────────────────
const good = join(root, 'good');
makeBundle(good);
const verified = verifyBundle({ bundleDir: good, tarball: join(good, 'knowledge-crib-0.1.0.tgz') });
assert.equal(verified.manifest.package, 'knowledge-crib-0.1.0.tgz');
assert.equal(
  verified.digests['knowledge-crib-memory-0.1.0.tgz'],
  `sha256:${sha256Hex('knowledge-crib-memory-0.1.0.tgz bytes\n')}`,
  'every bundled package is digested, not just the root one',
);
// An unrelated tarball is refused even when it exists on disk.
assert.throws(
  () => verifyBundle({ bundleDir: good, tarball: join(good, 'knowledge-crib-memory-0.1.0.tgz') }),
  /must be the candidate bundle's root package/,
);
// A tarball that is neither the root nor a declared package is refused (the root-package guard
// fires first: a non-root tarball can never pass as the candidate, whatever else the manifest says).
writeFileSync(join(good, 'stranger.tgz'), 'stranger\n');
assert.throws(
  () => verifyBundle({ bundleDir: good, tarball: join(good, 'stranger.tgz') }),
  /root package|not one of the candidate bundle's packages/,
);

// ── verifyBundle: the bundle's bytes must match what its manifest recorded ───────────────────────
const noChecksums = join(root, 'no-checksums');
makeBundle(noChecksums, {
  mutate: (manifest) => {
    manifest.checksums = [];
  },
});
assert.throws(
  () => verifyBundle({ bundleDir: noChecksums }),
  /declares no checksums/,
  'a bundle with no declared checksums has no integrity to check against',
);
const unchecksummed = join(root, 'unchecksummed');
makeBundle(unchecksummed, {
  mutate: (manifest) => {
    manifest.packages.push('extra.tgz');
  },
});
writeFileSync(join(unchecksummed, 'extra.tgz'), 'extra\n');
assert.throws(
  () => verifyBundle({ bundleDir: unchecksummed }),
  /does not declare a checksum for extra\.tgz/,
);
const tampered = join(root, 'tampered');
makeBundle(tampered);
// Modify a NON-root package after packing: the old single-tarball hash guard would never see it.
writeFileSync(join(tampered, 'knowledge-crib-memory-0.1.0.tgz'), 'swapped bytes\n');
assert.throws(
  () => verifyBundle({ bundleDir: tampered, tarball: join(tampered, 'knowledge-crib-0.1.0.tgz') }),
  /knowledge-crib-memory[\s\S]*does not match its manifest checksum/,
  'a workspace package modified after packing must refuse certification',
);
const missingTarball = join(root, 'missing-tarball');
makeBundle(missingTarball);
rmSync(join(missingTarball, 'knowledge-crib-memory-0.1.0.tgz'));
assert.throws(() => verifyBundle({ bundleDir: missingTarball }), /missing package tarball/);
const missingInstaller = join(root, 'missing-installer');
makeBundle(missingInstaller);
rmSync(join(missingInstaller, 'install-windows.ps1'));
assert.throws(() => verifyBundle({ bundleDir: missingInstaller }), /missing windows installer/);
// A swapped installer is refused, not just a missing one: the install cycle EXECUTES this file, so
// bytes that disagree with the manifest mean the pass would run whatever the swap put there.
const tamperedInstaller = join(root, 'tampered-installer');
makeBundle(tamperedInstaller);
writeFileSync(join(tamperedInstaller, 'install-macos.sh'), '#!/bin/sh\necho swapped\n');
assert.throws(
  () => verifyBundle({ bundleDir: tamperedInstaller }),
  /install-macos\.sh[\s\S]*does not match its manifest checksum/,
  'an installer modified after packing must refuse certification',
);
// A manifest that checksums the packages but not the installers leaves the one executable file
// unvouched-for — refused, because the installer self-check lives INSIDE the file it would check.
const unchecksummedInstaller = join(root, 'unchecksummed-installer');
makeBundle(unchecksummedInstaller, {
  mutate: (manifest) => {
    manifest.checksums = manifest.checksums.filter((entry) => !entry.file.endsWith('.ps1'));
  },
});
assert.throws(
  () => verifyBundle({ bundleDir: unchecksummedInstaller }),
  /does not declare a checksum for the windows installer/,
);

// ── bundleDigests + digestsDiffer: the guard a pass re-checks around EVERY check ─────────────────
const digests = bundleDigests(good, verified.manifest);
assert.deepEqual(
  Object.keys(digests).sort(),
  [
    'install-macos.sh',
    'install-windows.ps1',
    'knowledge-crib-0.1.0.tgz',
    'knowledge-crib-memory-0.1.0.tgz',
    'manifest.json',
  ].sort(),
  'the guard covers the manifest, every package, AND the installers the install cycle executes',
);
assert.deepEqual(
  digestsDiffer(digests, bundleDigests(good, verified.manifest)),
  [],
  'an untouched bundle differs nowhere',
);
// Swap a non-root package: the digest guard must name it.
writeFileSync(join(good, 'knowledge-crib-memory-0.1.0.tgz'), 'mutated\n');
assert.deepEqual(digestsDiffer(digests, bundleDigests(good, verified.manifest)), [
  'knowledge-crib-memory-0.1.0.tgz',
]);
writeFileSync(
  join(good, 'knowledge-crib-memory-0.1.0.tgz'),
  'knowledge-crib-memory-0.1.0.tgz bytes\n',
);
// A manifest edit mid-pass is caught too.
writeFileSync(
  join(good, 'manifest.json'),
  `${JSON.stringify({ ...verified.manifest, version: '9.9.9' })}\n`,
);
assert.deepEqual(digestsDiffer(digests, bundleDigests(good, verified.manifest)), ['manifest.json']);
writeFileSync(join(good, 'manifest.json'), `${JSON.stringify(verified.manifest, null, 2)}\n`);
assert.deepEqual(digestsDiffer(digests, bundleDigests(good, verified.manifest)), []);
// A check that DELETES a declared file is a comparable fact, not an ENOENT crash: the digest map
// records 'missing' so the guard's refusal can NAME the file that vanished mid-pass.
const deleted = bundleDigests(good, verified.manifest);
rmSync(join(good, 'knowledge-crib-memory-0.1.0.tgz'));
const afterDelete = bundleDigests(good, verified.manifest);
assert.equal(afterDelete['knowledge-crib-memory-0.1.0.tgz'], 'missing');
assert.deepEqual(digestsDiffer(deleted, afterDelete), ['knowledge-crib-memory-0.1.0.tgz']);
writeFileSync(
  join(good, 'knowledge-crib-memory-0.1.0.tgz'),
  'knowledge-crib-memory-0.1.0.tgz bytes\n',
);
assert.deepEqual(digestsDiffer(deleted, bundleDigests(good, verified.manifest)), []);
// Added and removed keys are both movement — hand-built maps, so the union-of-keys filter is pinned
// directly rather than only through file mutations above.
assert.deepEqual(digestsDiffer({ a: 'x' }, { a: 'x', b: 'y' }), ['b'], 'an added key is movement');
assert.deepEqual(digestsDiffer({ a: 'x', b: 'y' }, { a: 'x' }), ['b'], 'a removed key is movement');
assert.deepEqual(digestsDiffer({ a: 'x' }, { a: 'x' }), [], 'identical maps differ nowhere');

// ── assertInstalled / installCandidate: the bin contract is proven, not assumed ──────────────────
// assertInstalled refuses a prefix with no CLI in place — the check that turns a silent npm exit 0
// into a named failure when the installed product did not actually land.
assert.throws(() => assertInstalled(join(root, 'nothing-installed')), /did not place its CLI/);
// installCandidate refuses when npm fails (a nonexistent prefix path on an unwritable parent).
const unwritable = join(root, 'no-such-dir', 'prefix');
assert.throws(
  () =>
    installCandidate({
      bundleDir: good,
      manifest: verified.manifest,
      prefix: unwritable,
    }),
  /installing the candidate bundle into .* failed/,
);

console.log('candidate bundle tests ok');
