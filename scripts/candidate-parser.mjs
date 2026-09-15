/**
 * candidate-parser — the deep-fuzz gate's candidate binding.
 *
 * The fuzz-deep receipt names a candidate tarball, but the harness it was written for imported
 * `runFuzz`/`FUZZ_EXTRACTORS` from the CHECKOUT's `packages/parsers/dist` — so a deep sweep fuzzed
 * the working tree's build and then wrote a receipt describing the bundle. A receipt that names
 * bytes that never executed is worse than no receipt: it reads as candidate coverage.
 *
 * This module does what an operator would do by hand before trusting a sweep:
 *
 *   1. verify the candidate bundle against its own manifest (reuse candidate-bundle.mjs — a
 *      tarball whose bytes disagree with its manifest is a modified artifact wearing a
 *      candidate's name);
 *   2. install the bundle ONCE into an isolated prefix (the same npm route the platform
 *      installers use — no installer side effects, and nothing configured);
 *   3. point the sweep at the INSTALLED `@knowledge-crib/parsers` — module, worker, and grammars
 *      all resolve relative to the installation, so the bytes under test are the packaged bytes;
 *   4. verify those bytes against the candidate bundle AGAIN, at file level: extract the parsers
 *      tarball and require the installed worker and grammar files to hash identically to the
 *      packed members ("npm does not transform file contents" is an assumption, not evidence);
 *   5. refuse any runtime dependency that resolves outside the prefix — in particular back into
 *      the source checkout, which is how a "candidate-bound" run quietly becomes a checkout run;
 *   6. copy the input GENERATOR (fast-check — a devDependency that the published parsers package
 *      does not ship, but its runFuzz lazy-imports) into the prefix, so the candidate's own
 *      resolution finds it in-prefix at the same version the smoke gate fuzzed with.
 *
 * Everything here is synchronous and throws on refusal; the harness converts a throw into a failed
 * receipt with a blockedReason, the same way a broken detector self-test does.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCandidate, readBundleManifest, verifyBundle } from './candidate-bundle.mjs';

const sha256HexOfFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256Prefixed = (hex) => `sha256:${hex}`;

/** The prefix's node_modules root: npm's global layout differs per platform. */
export function prefixNodeModules(prefix, platform = process.platform) {
  return platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
}

/** Where the installed candidate's `@knowledge-crib/parsers` package lives. */
export function installedParsersDir(prefix, platform = process.platform) {
  return join(prefixNodeModules(prefix, platform), '@knowledge-crib', 'parsers');
}

/**
 * Copy the input generator into the isolated prefix.
 *
 * fast-check is the REPO's devDependency: the published parsers package does not ship it, yet the
 * candidate's runFuzz lazy-imports it at sweep time. Leaving resolution to walk up from the
 * installation would die at the prefix boundary (the bundle cannot contain it), and pointing the
 * candidate back at the checkout's node_modules would fail the no-checkout guard — correctly, since
 * that is exactly the resolution this gate refuses. So the generator is COPIED in, and its own
 * runtime dependencies are collected through the checkout's resolved module graph (pnpm nests them
 * in .pnpm, not at node_modules root) so the copy is complete. The bytes under TEST are unchanged:
 * the candidate's parser, worker, and grammars. Only the input generator — the same version the
 * smoke gate used — rides along.
 */
export function copyInputGeneratorIntoPrefix({
  repo,
  prefix,
  platform = process.platform,
  roots = ['fast-check'],
}) {
  const destRoot = prefixNodeModules(prefix, platform);
  // A transitive dependency resolves from the PARENT package's real directory, not the repo root:
  // pnpm nests pure-rand under .pnpm/fast-check@<v>/node_modules/, invisible to a repo-root
  // resolve. Node's resolver follows the node_modules/fast-check symlink to its real .pnpm path,
  // so a require built from the copied package's dir finds its siblings exactly as at runtime.
  const queue = roots.map((name) => ({ name, from: repo }));
  const seen = new Set();
  const copied = [];
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    // resolve through the owning package's graph (follows pnpm's symlinks to the real package dir)
    let packageDir;
    try {
      packageDir = dirname(
        createRequire(join(from, 'package.json')).resolve(`${name}/package.json`),
      );
    } catch {
      throw new Error(
        `the input generator ${name} is not resolvable from ${from} — build the workspace before a candidate-bound deep sweep`,
      );
    }
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    cpSync(packageDir, join(destRoot, name), { recursive: true, dereference: true, force: true });
    copied.push(name);
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: dep, from: packageDir });
  }
  return copied;
}

// Both sides must pass through realpathSync: on macOS a mkdtemp prefix under /var/folders is
// reported as /var/... while require.resolve returns the realpath /private/var/... — comparing
// a symlink path against a realpath path would refuse every genuinely in-prefix dependency.
const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    // A path that does not exist yet cannot be realpath'd; resolve() is the honest fallback.
    return resolve(path);
  }
};

/**
 * The guard: a resolved runtime dependency must come from inside the isolated prefix. The named
 * trap is resolution back into the SOURCE CHECKOUT — that is how a candidate-bound sweep quietly
 * executes the working tree's build — but any outside-the-prefix resolution means the bytes under
 * test are not the candidate's, so the guard refuses both.
 */
export function assertResolvesInsidePrefix(resolvedPath, { prefix, repo, label }) {
  if (typeof resolvedPath !== 'string' || !isAbsolute(resolvedPath)) {
    throw new Error(
      `candidate runtime dependency ${label} did not resolve to an absolute path: ${resolvedPath}`,
    );
  }
  // relative() is the platform-safe containment test: a path inside the prefix yields a clean
  // relative path; anything outside yields a `..`-prefixed (or absolute, on another root) one.
  const insidePrefix = relative(realPath(prefix), realPath(resolvedPath));
  if (insidePrefix.startsWith('..') || isAbsolute(insidePrefix)) {
    const insideCheckout = relative(realPath(repo), realPath(resolvedPath));
    const checkoutLeak = !insideCheckout.startsWith('..') && !isAbsolute(insideCheckout);
    throw new Error(
      `candidate runtime dependency ${label} resolved outside the isolated prefix (${prefix}): ${resolvedPath}${checkoutLeak ? ' — it resolved back into the SOURCE CHECKOUT' : ''}`,
    );
  }
}

/**
 * Verify the installed parser bytes against the candidate bundle at FILE level. The manifest's
 * checksums vouch for the tarballs as a whole; this pins the three things the sweep actually
 * executes — the worker the pool spawns and the grammar wasm files the tree-sitter ctx loads — to
 * the bytes packed inside the candidate's parsers tarball.
 */
export function verifyInstalledParsersAgainstBundle({ parsersTarball, parsersDir, files }) {
  const extractDir = mkdtempSync(join(tmpdir(), 'fuzz-candidate-tarball-'));
  try {
    // npm-pack tgz members are rooted at `package/`; tar handles pax headers on both bsdtar and GNU tar.
    const tar = spawnSync('tar', ['-xzf', parsersTarball, '-C', extractDir]);
    if (tar.status !== 0) {
      throw new Error(
        `could not extract the candidate parsers tarball to verify its bytes: ${(tar.stderr ?? '').toString().trim()}`,
      );
    }
    for (const file of files) {
      const packed = join(extractDir, 'package', file);
      const installed = join(parsersDir, file);
      if (!existsSync(packed)) {
        throw new Error(
          `candidate parsers byte verification failed: the packed tarball ${basename(parsersTarball)} does not contain ${file} — the sweep names a file the candidate bundle does not ship`,
        );
      }
      if (!existsSync(installed)) {
        throw new Error(
          `candidate parsers byte verification failed: the installed candidate is missing ${file} (${installed})`,
        );
      }
      const packedSha = sha256HexOfFile(packed);
      const installedSha = sha256HexOfFile(installed);
      if (packedSha !== installedSha) {
        throw new Error(
          `the installed ${file} does not match the candidate bundle's packaged bytes\n  bundle   sha256:${packedSha}\n  executed sha256:${installedSha}\nThe prefix does not hold the candidate's parser bytes; fuzzing it would fuzz something else.`,
        );
      }
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/**
 * Resolve a dependency's package DIRECTORY the way Node's own resolver walks node_modules.
 *
 * Entry-level CJS resolution (require.resolve(name)) cannot see packages whose exports map has
 * no "require" condition — the real @knowledge-crib/soul-schema is `type: module` with
 * exports {".": {import}} only, so probing it with createRequire threw
 * ERR_PACKAGE_PATH_NOT_EXPORTED and refused EVERY real candidate bundle at binding, even though
 * the ESM sweep imports it fine. The guard's question is where the dependency's BYTES live, not
 * which entry file loads, and a directory walk answers exactly that.
 */
function resolvePackageDirectory(name, fromDir) {
  const parts = name.split('/');
  const root = name.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', root);
    // A directory wearing the package's name without a package.json is not a resolvable package.
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve every runtime dependency of the sweep's execution graph and prove each one comes from
 * the isolated prefix. The list is the installed parsers package's own `dependencies` (the worker
 * loads them at extract time) plus the input generator's roots (runFuzz lazy-imports fast-check
 * from the installed module's location).
 */
export function resolveRuntimeDependencies({
  modulePath,
  prefix,
  repo,
  generatorRoots = ['fast-check'],
}) {
  const pkg = JSON.parse(
    readFileSync(join(dirname(dirname(resolve(modulePath))), 'package.json'), 'utf8'),
  );
  // modulePath = <parsersDir>/dist/index.js → the package root is two levels up from dist/.
  const names = [...Object.keys(pkg.dependencies ?? {}), ...generatorRoots];
  const resolved = [];
  for (const name of names) {
    const packageDir = resolvePackageDirectory(name, dirname(modulePath));
    if (!packageDir) {
      throw new Error(
        `candidate runtime dependency ${name} is not resolvable from the installed parsers package — the sweep would crash loading it; is the candidate install complete?`,
      );
    }
    assertResolvesInsidePrefix(packageDir, { prefix, repo, label: name });
    resolved.push(name);
  }
  return resolved;
}

/**
 * The deep-fuzz candidate binding, end to end. Verifies the bundle, installs it into `prefix`,
 * locates the installed parsers package, verifies its worker/grammar bytes against the packed
 * tarball, and guards every runtime dependency against resolving outside the prefix. Returns the
 * provenance a fuzz-deep receipt records: which package was fuzzed, and the hashes of the exact
 * parser/worker/grammar bytes that executed. Throws on any refusal — the harness turns that into
 * a failed receipt, not a silent checkout fallback.
 */
export function prepareCandidateParser({
  packagePath,
  repo,
  prefix,
  env = process.env,
  platform = process.platform,
}) {
  const bundleDir = dirname(resolve(packagePath));
  const { manifest } = readBundleManifest(bundleDir);
  verifyBundle({ bundleDir, tarball: packagePath });
  installCandidate({ bundleDir, manifest, prefix, env });

  const parsersPackageFile = manifest.packages.find((name) =>
    /^knowledge-crib-parsers-[^/]*\.tgz$/.test(name),
  );
  if (!parsersPackageFile) {
    throw new Error(
      `the candidate bundle declares no @knowledge-crib/parsers package tarball (${bundleDir}) — there are no packaged parser bytes to fuzz`,
    );
  }
  const declaredChecksum = manifest.checksums?.find((entry) => entry.file === parsersPackageFile);
  if (!declaredChecksum) {
    throw new Error(
      `the candidate bundle manifest declares no checksum for ${parsersPackageFile} — the parser bytes under test cannot be bound`,
    );
  }

  const parsersDir = installedParsersDir(prefix, platform);
  if (!existsSync(parsersDir)) {
    throw new Error(
      `the installed candidate did not place @knowledge-crib/parsers under ${prefixNodeModules(prefix, platform)} — the parsers package never installed, so the sweep has no candidate to fuzz`,
    );
  }
  const modulePath = join(parsersDir, 'dist', 'index.js');
  const moduleRelPath = join('dist', 'index.js');
  const workerRelPath = join('dist', 'fuzz', 'fuzz-worker.js');
  // `._`-prefixed AppleDouble sidecars ride along on macOS installs (npm writes resource forks
  // as siblings); they are filesystem metadata, not grammars, and treating them as candidate
  // bytes would fail the tarball comparison on every macOS run.
  const grammarFiles = readdirSync(join(parsersDir, 'grammars'))
    .filter((name) => name.endsWith('.wasm') && !name.startsWith('._'))
    .sort()
    .map((name) => join('grammars', name));

  copyInputGeneratorIntoPrefix({ repo, prefix, platform });

  verifyInstalledParsersAgainstBundle({
    parsersTarball: join(bundleDir, parsersPackageFile),
    parsersDir,
    // dist/index.js is verified too, not just worker/grammars: it is the dynamically imported
    // entry whose FUZZ_EXTRACTORS decide which extractors run and how outcomes are tallied, so
    // the module that drives the whole sweep must be the packaged bytes, not only the files it
    // spawns. (This also proves modulePath exists — the tarball cannot ship what the sweep
    // imports without the installed copy being present and identical.)
    files: [moduleRelPath, workerRelPath, ...grammarFiles],
  });

  const runtimeDependencies = resolveRuntimeDependencies({ modulePath, prefix, repo });

  return {
    prefix,
    moduleUrl: pathToFileURL(modulePath).href,
    modulePath,
    // receipt-shaped: package NAMES and hashes only, never machine paths (a receipt that embeds
    // absolute paths cannot verify on the machine that judges it — the artifact-path lesson).
    candidate: {
      package: basename(packagePath),
      parsersPackage: parsersPackageFile,
      parsersPackageSha256: sha256Prefixed(declaredChecksum.sha256),
      worker: {
        path: workerRelPath,
        sha256: sha256Prefixed(sha256HexOfFile(join(parsersDir, workerRelPath))),
      },
      grammars: grammarFiles.map((file) => ({
        path: file,
        sha256: sha256Prefixed(sha256HexOfFile(join(parsersDir, file))),
      })),
      runtimeDependencies,
      isolatedPrefix: true,
    },
  };
}
