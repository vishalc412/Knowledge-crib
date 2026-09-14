/**
 * The candidate bundle: the one artifact every receipt in an acceptance pass describes.
 *
 * Task 3's defect was that package hashing alone does not establish which executable a check
 * exercised — and that the collector never verified the bundle it was handed. A bundle is not one
 * tarball: it is a manifest plus every bundled workspace package plus the platform installers,
 * and a check that swaps any of those mid-pass silently re-points the whole launch at unverified
 * bytes. So certifying mode now does what an operator would do by hand, before anything runs:
 *
 *   1. read the bundle's own manifest (refuse a directory that is not a bundle);
 *   2. require every declared package tarball to exist and to match the checksum the manifest
 *      recorded when the bundle was BUILT — a digest that disagrees means the bundle was modified
 *      after packing, and certifying modified bytes is certifying an unknown artifact;
 *   3. hash the manifest and every package before and after EVERY check, so a check that rebuilds
 *      or replaces the candidate (the old adapter check packed, mid-pass) is refused, not noticed;
 *   4. install the bundle ONCE into an isolated prefix and hand that installed executable to the
 *      checks that exercise the product, so a receipt can name the executable it actually ran.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expectedBinPaths, npmCommand, npmInstallArgs } from './install-smoke.mjs';

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Read and structurally validate a bundle manifest. Throws — callers die() with the message. */
export function readBundleManifest(bundleDir) {
  const manifestPath = join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `candidate bundle has no manifest.json: ${bundleDir} — certification requires the bundle directory, not a bare tarball`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `candidate bundle manifest is not valid JSON (${manifestPath}): ${error.message}`,
    );
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error(
      `candidate bundle manifest declares no packages (${manifestPath}) — nothing to certify`,
    );
  }
  return { manifest, manifestPath };
}

/**
 * Verify the bundle a certifying pass was handed: the manifest must declare the supplied tarball
 * as its ROOT package, every declared package must exist, and every package's bytes must match
 * the checksum the manifest recorded at build time. Returns the manifest and a digest per package.
 */
export function verifyBundle({ bundleDir, tarball }) {
  const { manifest, manifestPath } = readBundleManifest(bundleDir);
  if (tarball !== undefined) {
    const supplied = basename(tarball);
    if (typeof manifest.package === 'string' && supplied !== manifest.package) {
      throw new Error(
        `--package must be the candidate bundle's root package ${manifest.package}, got ${supplied}`,
      );
    }
    if (!manifest.packages.includes(supplied)) {
      throw new Error(
        `--package ${supplied} is not one of the candidate bundle's packages (${manifest.packages.join(', ')})`,
      );
    }
  }
  const checksums = new Map(
    (Array.isArray(manifest.checksums) ? manifest.checksums : [])
      .filter((entry) => typeof entry?.file === 'string' && typeof entry?.sha256 === 'string')
      .map((entry) => [entry.file, entry.sha256]),
  );
  if (checksums.size === 0) {
    throw new Error(
      `candidate bundle manifest declares no checksums (${manifestPath}) — the bundle's own integrity cannot be established`,
    );
  }
  const digests = {};
  for (const name of manifest.packages) {
    const path = join(bundleDir, name);
    if (!existsSync(path)) {
      throw new Error(`candidate bundle is missing package tarball: ${path}`);
    }
    const hex = sha256Hex(readFileSync(path));
    digests[name] = `sha256:${hex}`;
    const declared = checksums.get(name);
    if (declared === undefined) {
      throw new Error(`candidate bundle manifest does not declare a checksum for ${name}`);
    }
    if (declared !== hex) {
      throw new Error(
        `candidate bundle package ${name} does not match its manifest checksum\n  manifest ${declared}\n  actual   ${hex}\nThe bundle was modified after it was built; certifying it would certify unknown bytes.`,
      );
    }
  }
  // The installers are part of what the install cycle EXECUTES, and the manifest records their
  // checksums at build time like any package. Checking existence alone (the earlier version) meant a
  // swapped installer kept installing the same tarballs while running whatever the swap put there —
  // and the original script's own `shasum -c` self-check lives INSIDE the file being swapped, so a
  // replacement simply omits it. Installer bytes are verified, not just present.
  if (manifest.installers && typeof manifest.installers === 'object') {
    for (const [platform, file] of Object.entries(manifest.installers)) {
      if (typeof file !== 'string') continue;
      const path = join(bundleDir, file);
      if (!existsSync(path)) {
        throw new Error(`candidate bundle declares a missing ${platform} installer: ${path}`);
      }
      const declared = checksums.get(file);
      if (declared === undefined) {
        throw new Error(
          `candidate bundle manifest does not declare a checksum for the ${platform} installer ${file}`,
        );
      }
      const hex = sha256Hex(readFileSync(path));
      digests[file] = `sha256:${hex}`;
      if (declared !== hex) {
        throw new Error(
          `candidate bundle's ${platform} installer ${file} does not match its manifest checksum\n  manifest ${declared}\n  actual   ${hex}\nThe bundle was modified after it was built; certifying it would certify unknown bytes.`,
        );
      }
    }
  }
  return { manifest, manifestPath, digests };
}

/**
 * Digest one bundle file — or the 'missing' sentinel when it is gone. A check that DELETES a
 * declared file mid-pass must reach the guard's refusal naming that file, not crash on ENOENT
 * before the guard can speak; the sentinel keeps deletion a comparable fact.
 */
function digestFile(path) {
  if (!existsSync(path)) return 'missing';
  return `sha256:${sha256Hex(readFileSync(path))}`;
}

/**
 * The bundle state a pass guards: manifest bytes, every declared package tarball, and the
 * installers the install cycle executes. Compared before and after EVERY check — two different
 * maps mean the pass is over. Excluding the installers here would leave the one file the install
 * check runs as a shell script unguarded while every tarball it installs is watched.
 */
export function bundleDigests(bundleDir, manifest) {
  const digests = { 'manifest.json': digestFile(join(bundleDir, 'manifest.json')) };
  for (const name of manifest.packages) {
    digests[name] = digestFile(join(bundleDir, name));
  }
  if (manifest.installers && typeof manifest.installers === 'object') {
    for (const file of Object.values(manifest.installers)) {
      if (typeof file === 'string') digests[file] = digestFile(join(bundleDir, file));
    }
  }
  return digests;
}

/** Every key whose digest moved between two `bundleDigests` maps (added, removed or changed). */
export function digestsDiffer(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => before[key] !== after[key],
  );
}

/**
 * The installed executable, proven present. Split from installCandidate so the bin contract is
 * testable without a real npm install: the collector's checks receive THIS file's path and hash.
 */
export function assertInstalled(prefix) {
  const bins = expectedBinPaths(prefix);
  if (!existsSync(bins.direct)) {
    throw new Error(`the installed candidate did not place its CLI at ${bins.direct}`);
  }
  return {
    bins,
    executableSha256: `sha256:${sha256Hex(readFileSync(bins.direct))}`,
  };
}

/**
 * Install the verified bundle into an isolated global prefix, once per pass. Uses the same npm
 * route the platform installers use (all tarballs together, offline-frendly fetch settings), with
 * none of the installer script's convenience side effects — this prefix exists so checks can be
 * HANDED the installed executable, not so anything is configured.
 */
export function installCandidate({ bundleDir, manifest, prefix, env = process.env }) {
  const tarballs = manifest.packages.map((name) => join(bundleDir, name));
  const npm = npmCommand(npmInstallArgs(prefix, tarballs));
  const started = Date.now();
  const result = spawnSync(npm.command, npm.args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env,
    // A wedged npm (stuck lock, hung fetch, a prompt on a pipe stdin that never closes) must fail
    // the pass in bounded time, not hang the collector forever with no diagnostic — every other
    // spawned command in the pass is already bounded.
    timeout: 15 * 60_000,
  });
  const log =
    `$ ${npm.command} ${npm.args.join(' ')}\n` +
    `exit ${result.status} after ${((Date.now() - started) / 1000).toFixed(1)}s\n\n` +
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    const error = new Error(
      `installing the candidate bundle into ${prefix} failed (exit ${result.status ?? -1})\n${(result.stderr ?? result.stdout ?? '').slice(-2000)}`,
    );
    // The transcript rides the error so the collector can archive logs/install-candidate.log on
    // FAILURE too — a log that exists only on success hides exactly the run an operator needs.
    error.log = log;
    throw error;
  }
  return { ...assertInstalled(prefix), log };
}
