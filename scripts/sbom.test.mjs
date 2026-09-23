/**
 * Unit tests for the WP3 SBOM generator.
 *
 * Built as a whole tree in a tmpdir and driven with `--root`, `--licenses` and `--tree`, so every
 * invariant can be shown FIRING on a violating document and QUIET on its compliant twin. The
 * invariants are the only thing standing between this script and emitting a document that looks like
 * an SBOM but that a consumer cannot actually use — a missing license, a ref that resolves to
 * nothing, two components sharing one identity. A generator tested only on a healthy tree has never
 * taken any of those branches.
 *
 * Two properties beyond the invariants are asserted, because both are release-artifact properties
 * rather than formatting ones:
 *   - DETERMINISM. The same tree must produce byte-identical output once the timestamp is pinned.
 *     An artifact that changes when nothing changed cannot be compared or archived.
 *   - NOTHING IS WRITTEN ON FAILURE. A document that failed its own invariants must not be left on
 *     disk where the next release step would pick it up.
 *
 * The purl encoding is pinned too: a scoped package's scope is a NAMESPACE, so `@scope/name` must
 * become `pkg:npm/%40scope/name` — percent-encoded `@`, literal `/`. Getting that wrong yields a
 * purl that does not resolve, which is invisible until someone tries to look the component up.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SBOM = join(HERE, 'sbom.mjs');

const roots = [];

/** pnpm's license→packages document: an OBJECT keyed by expression, so several one-entry maps here
 *  merge into one. Written as an array of maps to keep each fixture readable. */
const licensesOf = (maps) => Object.assign({}, ...maps);

/** pnpm's `list -r --json --depth Infinity` document. */
const treeOf = (entries) => entries;

/**
 * Build a tree in a fresh tmpdir: a root manifest, an optional workspace package, and the two
 * injected pnpm documents. Returns { root, out, audit } so a test can read back what was written.
 */
function fixture({
  licenses = licensesOf([{ MIT: [{ name: 'ext-lib', versions: ['1.0.0'], license: 'MIT' }] }]),
  tree = treeOf([]),
  rootManifest = { name: 'fixture-root', version: '0.0.0', license: 'Apache-2.0' },
  workspacePackages = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sbom-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(rootManifest, null, 2));
  for (const pkg of workspacePackages) {
    const dir = join(root, pkg.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg.manifest, null, 2));
  }
  const licensesPath = join(root, 'licenses.json');
  const treePath = join(root, 'tree.json');
  writeFileSync(licensesPath, JSON.stringify(licenses, null, 2));
  writeFileSync(treePath, JSON.stringify(tree, null, 2));
  return { root, licensesPath, treePath, out: join(root, 'sbom.cdx.json') };
}

/** Run the generator. `raw` lets a test inject a non-JSON input as-is. */
function run({ licensesPath, treePath, root, out }, extraArgs = []) {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        SBOM,
        '--root',
        root,
        '--licenses',
        licensesPath,
        '--tree',
        treePath,
        '--out',
        out,
        '--json',
        ...extraArgs,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    stdout = error.stdout ?? '';
    status = error.status;
    // A gate that CRASHES produces no JSON, and swallowing the reason would turn "the generator
    // threw" into "the assertions could not parse the output" — the wrong bug, reported twice.
    if (!stdout.trim().startsWith('{') && error.stderr) process.stderr.write(error.stderr);
  }
  return { status, stdout, report: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null };
}

try {
  // ─── the compliant twin: a well-formed document, all invariants quiet ───────
  {
    const files = fixture({
      licenses: licensesOf([
        {
          MIT: [
            {
              name: 'ext-lib',
              versions: ['1.0.0'],
              license: 'MIT',
              homepage: 'https://example.test',
            },
          ],
        },
      ]),
      workspacePackages: [
        {
          dir: 'packages/core',
          manifest: { name: '@knowledge-crib/core', version: '1.0.0', license: 'Apache-2.0' },
        },
      ],
    });
    // A workspace package is only detected when the tree reports a `path` inside the root, and a
    // workspace link reports `link:../core` rather than a version — both are what this pins.
    writeFileSync(
      files.treePath,
      JSON.stringify(
        treeOf([
          {
            name: 'fixture-root',
            version: '0.0.0',
            path: files.root,
            private: true,
            dependencies: {
              '@knowledge-crib/core': {
                from: '@knowledge-crib/core',
                version: 'link:../core',
                dependencies: {
                  'ext-lib': {
                    from: 'ext-lib',
                    version: '1.0.0',
                    resolved: 'https://registry.npmjs.org/ext-lib/-/ext-lib-1.0.0.tgz',
                  },
                },
              },
            },
          },
          {
            name: '@knowledge-crib/core',
            version: '1.0.0',
            path: join(files.root, 'packages/core'),
            dependencies: {},
          },
        ]),
        null,
        2,
      ),
    );
    const { status, report } = run(files);
    assert.equal(
      status,
      0,
      `a well-formed tree must pass; got ${JSON.stringify(report?.failures)}`,
    );
    assert.equal(report.failures.length, 0);
    assert.equal(report.components, 2, 'one external + one workspace component');
    assert.ok(report.edges >= 2, 'the graph must carry the root→core and core→ext-lib edges');
    assert.ok(existsSync(files.out), 'a passing run must write the document');

    const bom = JSON.parse(readFileSync(files.out, 'utf8'));
    assert.equal(bom.bomFormat, 'CycloneDX');
    assert.equal(bom.specVersion, '1.5');
    assert.ok(
      bom.$schema.includes('cyclonedx'),
      'the schema URL must be emitted so a consumer can validate',
    );
    // The purl encoding rule, pinned: scope is a namespace, `@` percent-encoded, `/` literal.
    assert.ok(
      bom.components.some((c) => c.purl === 'pkg:npm/%40knowledge-crib/core@1.0.0'),
      'a scoped package must encode its scope as pkg:npm/%40scope/name — a bare @ does not resolve',
    );
    assert.ok(
      bom.components.some((c) => c.purl === 'pkg:npm/ext-lib@1.0.0'),
      'an unscoped package must be pkg:npm/name@version',
    );
    assert.deepEqual(
      bom.components.find((c) => c.name === 'ext-lib').licenses,
      [{ license: { id: 'MIT' } }],
      'a bare SPDX id must be emitted as `id`, not as an expression',
    );
    // The primary component is the subject, not a dependency.
    assert.equal(bom.metadata.component.purl, 'pkg:npm/fixture-root@0.0.0');
    assert.ok(
      !bom.components.some((c) => c.name === 'fixture-root'),
      'the primary component must not also appear in the component list',
    );
  }

  // ─── I3: a component with no license FAILS ──────────────────────────────────
  {
    const files = fixture({
      licenses: licensesOf([{ MIT: [{ name: 'ext-lib', versions: ['1.0.0'], license: 'MIT' }] }]),
      workspacePackages: [
        { dir: 'packages/bare', manifest: { name: 'bare-pkg', version: '1.0.0' } },
      ],
    });
    writeFileSync(
      files.treePath,
      JSON.stringify(
        treeOf([
          {
            name: 'bare-pkg',
            version: '1.0.0',
            path: join(files.root, 'packages/bare'),
            dependencies: {},
          },
        ]),
        null,
        2,
      ),
    );
    const { status, report } = run(files);
    assert.equal(
      status,
      1,
      'a package with unknown terms must be visible as such, not passed over',
    );
    assert.match(report.failures.join('\n'), /I3: pkg:npm\/bare-pkg@1\.0\.0/);
    assert.ok(!existsSync(files.out), 'a failing run must NOT write the document');
  }

  // ─── I4: a dependency edge to an unknown component FAILS ────────────────────
  {
    const files = fixture();
    writeFileSync(
      files.treePath,
      JSON.stringify(
        treeOf([
          {
            name: 'fixture-root',
            version: '0.0.0',
            path: files.root,
            dependencies: { 'ghost-lib': { from: 'ghost-lib', version: '9.9.9' } },
          },
        ]),
        null,
        2,
      ),
    );
    const { status, report } = run(files);
    assert.equal(
      status,
      1,
      'a ref that resolves to nothing makes the document unusable to a consumer',
    );
    assert.match(report.failures.join('\n'), /I4: .*ghost-lib/);
  }

  // ─── I1: two components sharing one identity FAIL ───────────────────────────
  {
    const files = fixture({
      licenses: licensesOf([
        { MIT: [{ name: 'dup-lib', versions: ['1.0.0'], license: 'MIT' }] },
        { ISC: [{ name: 'dup-lib', versions: ['1.0.0'], license: 'ISC' }] },
      ]),
    });
    const { status, report } = run(files);
    assert.equal(status, 1, 'one identity must mean one component');
    assert.match(report.failures.join('\n'), /I1: .*duplicate bom-ref/);
  }

  // ─── I5: an empty component list FAILS ──────────────────────────────────────
  {
    const files = fixture({ licenses: licensesOf([{}]) });
    const { status, report } = run(files);
    assert.equal(
      status,
      1,
      'a document describing nothing is not a valid SBOM — zero components passes every other check',
    );
    assert.match(report.failures.join('\n'), /I5: .*EMPTY/);
  }

  // ─── determinism: the same tree, byte-identical once the timestamp is pinned ─
  {
    const files = fixture();
    const pinned = { ...process.env, SOURCE_DATE_EPOCH: '1700000000' };
    const render = (out) =>
      execFileSync(
        process.execPath,
        [
          SBOM,
          '--root',
          files.root,
          '--licenses',
          files.licensesPath,
          '--tree',
          files.treePath,
          '--out',
          out,
        ],
        { encoding: 'utf8', env: pinned, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    render(join(files.root, 'a.json'));
    render(join(files.root, 'b.json'));
    assert.equal(
      readFileSync(join(files.root, 'a.json'), 'utf8'),
      readFileSync(join(files.root, 'b.json'), 'utf8'),
      'two runs over one tree must be byte-identical — including the derived serialNumber',
    );
    // And the one non-deterministic field is the timestamp: unpinned, the report must say so.
    const { report } = run(files);
    assert.equal(
      report.timestampPinned,
      false,
      'the report must admit when the timestamp was NOT pinned',
    );
  }

  // ─── an unreadable input is UNAVAILABLE, and exits 2 ────────────────────────
  {
    const files = fixture();
    writeFileSync(files.licensesPath, 'not json at all');
    const { status, stdout } = run(files);
    assert.equal(
      status,
      2,
      'an input that could not be read is neither a pass nor an invariant failure',
    );
    assert.match(stdout, /UNAVAILABLE/);
    assert.ok(!existsSync(files.out), 'and nothing may be written');
  }

  // ─── a well-formed document in the WRONG shape is UNAVAILABLE, not a crash ──
  {
    // An array where pnpm emits an object keyed by expression. This is the mistake a hand-written
    // or stale injected document makes, and the failure mode without this check is a TypeError
    // partway through rendering — which reads as a bug in the generator, not in the input.
    const files = fixture({ licenses: [{ MIT: [{ name: 'ext-lib', versions: ['1.0.0'] }] }] });
    const { status, stdout } = run(files);
    assert.equal(status, 2, 'a shape mismatch is an input problem, reported as UNAVAILABLE');
    assert.match(stdout, /expected an object mapping/, 'and it must NAME the expected shape');
    assert.ok(!existsSync(files.out));
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('sbom tests ok\n');
