/**
 * Unit tests for the WP3 boundaries gate.
 *
 * The gate is an executable, so these tests drive it as a subprocess against SYNTHETIC workspaces in
 * a tmpdir: each fixture is the smallest tree that can express one rule, and each rule is shown both
 * FIRING on a violation and staying QUIET on the compliant twin. That pairing is the point — a gate
 * that fails on everything and a gate that fails on nothing are equally useless, and only the
 * compliant twin distinguishes them. This mirrors the discipline WP2 earned the hard way: a test
 * that passes either way is recorded as covering nothing.
 *
 * The fixtures also pin the two ratchet directions that are easy to get backwards:
 *   - a count that GROWS past the baseline fails (R6, R7);
 *   - a count that SHRINKS below it passes, because the ratchet tightens and never loosens.
 * And they pin the deliberate carve-outs — a test file using a declared devDependency passes, while
 * the same import from a production file fails.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'boundaries-check.mjs');

const CLEAN_BASELINE = {
  fileCycles: [],
  suppressions: {},
  unresolvedRelativeSpecifiers: 0,
  skippedSourceFilesInFixtures: 0,
};

/** Build a workspace under a fresh tmpdir. `files` maps repo-relative paths to contents. */
function fixture(files, baseline = CLEAN_BASELINE) {
  const root = mkdtempSync(join(tmpdir(), 'boundaries-'));
  const write = (rel, body) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const manifest = (name, { deps = {}, devDeps = {} } = {}) =>
    JSON.stringify({ name, dependencies: deps, devDependencies: devDeps }, null, 2);
  write('packages/a/package.json', manifest('@knowledge-crib/a'));
  write('packages/b/package.json', manifest('@knowledge-crib/b'));
  write('scripts/boundaries-baseline.json', JSON.stringify(baseline, null, 2));
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return root;
}

/** Run the gate against a fixture and return { status, report }. */
function run(root) {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CHECK, '--root', root, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    stdout = error.stdout ?? '';
    status = error.status;
  }
  return {
    status,
    report: JSON.parse(stdout),
    rules: JSON.parse(stdout).failures.map((f) => f.rule),
  };
}

const roots = [];
const withFixture = (files, baseline) => {
  const root = fixture(files, baseline);
  roots.push(root);
  return root;
};

try {
  // ─── the compliant twin: every rule quiet ──────────────────────────────────
  {
    const root = withFixture({
      'packages/a/src/one.ts':
        "import { two } from './two.js';\nimport { b } from '@knowledge-crib/b';\n",
      'packages/a/src/two.ts': 'export const two = 1;\n',
      'packages/b/src/index.ts': 'export const b = 2;\n',
    });
    // Declare the edge the source actually uses, so the compliant twin is genuinely compliant.
    writeFileSync(
      join(root, 'packages/a/package.json'),
      JSON.stringify(
        { name: '@knowledge-crib/a', dependencies: { '@knowledge-crib/b': 'workspace:*' } },
        null,
        2,
      ),
    );
    const { status, rules } = run(root);
    assert.equal(status, 0, `clean tree must pass; got ${JSON.stringify(rules)}`);
  }

  // ─── R1/R2: an undeclared package edge fails; the same edge, declared, passes ─
  {
    const undeclared = withFixture({
      'packages/a/src/one.ts': "import { b } from '@knowledge-crib/b';\nexport const one = b;\n",
      'packages/b/src/index.ts': 'export const b = 2;\n',
    });
    const { status, rules } = run(undeclared);
    assert.equal(status, 1);
    assert.deepEqual(rules, ['R1/R2'], 'an undeclared workspace import must fail exactly once');
  }

  // ─── R2: a TEST file may use a declared devDependency; production may not ───
  {
    const files = {
      'packages/a/src/one.ts': 'export const one = 1;\n',
      'packages/b/src/index.ts': 'export const b = 2;\n',
    };
    const devBaseline = CLEAN_BASELINE;
    // The test file importing b is fine only because b is declared as a DEV dependency of a.
    const testRoot = withFixture(
      {
        ...files,
        'packages/a/src/one.test.ts': "import { b } from '@knowledge-crib/b';\nassert;\n",
      },
      devBaseline,
    );
    writeFileSync(
      join(testRoot, 'packages/a/package.json'),
      JSON.stringify(
        { name: '@knowledge-crib/a', devDependencies: { '@knowledge-crib/b': 'workspace:*' } },
        null,
        2,
      ),
    );
    assert.equal(run(testRoot).status, 0, 'a test file may use a declared devDependency');

    // Identical import, production file, same manifest → fails. The grant is test-only.
    const prodRoot = withFixture(
      {
        ...files,
        'packages/a/src/one.ts': "import { b } from '@knowledge-crib/b';\nexport const one = b;\n",
      },
      devBaseline,
    );
    writeFileSync(
      join(prodRoot, 'packages/a/package.json'),
      JSON.stringify(
        { name: '@knowledge-crib/a', devDependencies: { '@knowledge-crib/b': 'workspace:*' } },
        null,
        2,
      ),
    );
    assert.deepEqual(run(prodRoot).rules, ['R1/R2'], 'production may not use a devDependency');
  }

  // ─── R3: production code may not escape its package by relative path ────────
  {
    const escaping = withFixture({
      'packages/a/src/one.ts': "import { b } from '../../b/src/index.js';\nexport const one = b;\n",
      'packages/b/src/index.ts': 'export const b = 2;\n',
    });
    assert.deepEqual(run(escaping).rules, ['R3'], 'a cross-package relative import must fail');

    // …but the same reach from a TEST file is the repo's deliberate scripts/fixtures pattern. It is
    // permitted by R3, and it is still counted as coverage debt by R7 — the gate's position is that a
    // deliberate blind spot is fine so long as it is a NAMED, frozen number. Hence: no R3 failure,
    // and a baseline that declares the one unresolved specifier.
    const testReach = withFixture(
      {
        'packages/a/src/one.test.ts':
          "import { x } from '../../../scripts/fixtures/helper.mjs';\nassert;\n",
        'scripts/fixtures/helper.mjs': 'export const x = 1;\n',
      },
      { ...CLEAN_BASELINE, unresolvedRelativeSpecifiers: 1 },
    );
    const reachRun = run(testReach);
    assert.equal(reachRun.status, 0, 'the scripts/fixtures reach from a test file is permitted');
    assert.ok(!reachRun.rules.includes('R3'), 'it must not be reported as a boundary escape');
    assert.equal(
      reachRun.report.unresolvedRelativeSpecifiers,
      1,
      'and it must still be counted as declared debt, not hidden',
    );
  }

  // ─── R4: a package cycle fails ──────────────────────────────────────────────
  {
    const root = withFixture({
      'packages/a/src/one.ts': "import { b } from '@knowledge-crib/b';\nexport const one = b;\n",
      'packages/b/src/index.ts':
        "import { one } from '@knowledge-crib/a';\nexport const b = one;\n",
    });
    for (const pkg of ['a', 'b']) {
      const other = pkg === 'a' ? 'b' : 'a';
      const path = join(root, `packages/${pkg}/package.json`);
      writeFileSync(
        path,
        JSON.stringify(
          {
            name: `@knowledge-crib/${pkg}`,
            dependencies: { [`@knowledge-crib/${other}`]: 'workspace:*' },
          },
          null,
          2,
        ),
      );
    }
    const { status, rules } = run(root);
    assert.equal(status, 1);
    assert.ok(rules.includes('R4'), `an inter-package cycle must fail; got ${rules}`);
  }

  // ─── R5: a NEW file cycle fails; the same cycle, frozen, passes ─────────────
  {
    const cyclic = {
      'packages/a/src/one.ts': "import { two } from './two.js';\nexport const one = two;\n",
      'packages/a/src/two.ts': "import { one } from './one.js';\nexport const two = one;\n",
    };
    // Not frozen → the ratchet fires.
    assert.deepEqual(run(withFixture(cyclic)).rules, ['R5']);
    // Frozen at exactly this component → the ratchet is quiet. Same code, different baseline: this
    // is the pair that proves R5 tests the BASELINE rather than the mere existence of a cycle.
    const frozen = {
      ...CLEAN_BASELINE,
      fileCycles: [['packages/a/src/one.ts', 'packages/a/src/two.ts']],
    };
    assert.equal(run(withFixture(cyclic, frozen)).status, 0, 'a frozen cycle is accepted');

    // And a cycle that disappears is reported too: the baseline may not outlive the code it froze.
    // Both directions fire together here — the tree has one cycle the baseline does not know about
    // AND the baseline names a cycle the tree no longer has — so the reviewer sees both halves in one
    // run rather than fixing one and rediscovering the other.
    const stale = {
      ...CLEAN_BASELINE,
      fileCycles: [['packages/a/src/ghost-one.ts', 'packages/a/src/ghost-two.ts']],
    };
    const staleRun = run(withFixture(cyclic, stale));
    assert.equal(staleRun.rules.filter((r) => r === 'R5').length, 2);
    assert.ok(
      staleRun.report.failures.some((f) => /NEW import cycle/.test(f.detail)),
      'the new cycle must be named',
    );
    assert.ok(
      staleRun.report.failures.some((f) => /frozen cycle is gone or changed/.test(f.detail)),
      'the vanished frozen cycle must be named',
    );
  }

  // ─── R6: suppressions may not grow, and may always shrink ───────────────────
  {
    const withMarker = {
      'packages/a/src/one.ts': '// biome-ignore lint/x: reason\nexport const one = 1;\n',
    };
    const allowed = { ...CLEAN_BASELINE, suppressions: { a: { 'biome-ignore': 1 } } };
    assert.equal(run(withFixture(withMarker, allowed)).status, 0, 'at the baseline is allowed');

    // One more marker than the baseline → fails, and the message names the marker and the count.
    const twoMarkers = {
      'packages/a/src/one.ts':
        '// biome-ignore lint/x: reason\n// biome-ignore lint/y: reason\nexport const one = 1;\n',
    };
    const { status, rules, report } = run(withFixture(twoMarkers, allowed));
    assert.equal(status, 1);
    assert.deepEqual(rules, ['R6']);
    assert.match(report.failures[0].detail, /2 biome-ignore marker\(s\) \(baseline 1\)/);

    // Shrinking is always allowed: the ratchet tightens and never loosens.
    const oneMarker = { 'packages/a/src/one.ts': 'export const one = 1;\n' };
    const generous = { ...CLEAN_BASELINE, suppressions: { a: { 'biome-ignore': 5 } } };
    assert.equal(run(withFixture(oneMarker, generous)).status, 0, 'a count below baseline passes');

    // Every marker kind is counted, not just one — a gate that watched only biome-ignore would let
    // `as any` and `@ts-expect-error` through the same hole.
    const kinds = {
      'packages/a/src/one.ts':
        '// @ts-expect-error\nconst x = y as any;\n/* eslint-disable */\nconst z = <any>w;\n',
    };
    const { report: kindReport } = run(withFixture(kinds));
    assert.deepEqual(kindReport.suppressionCounts.a, {
      'ts-expect-error': 1,
      'as any': 1,
      'eslint-disable': 1,
      'angle-bracket-any': 1,
    });
  }

  // ─── R7: coverage debt may not grow silently ────────────────────────────────
  {
    // A specifier that genuinely cannot resolve. The gate must not report a green run over a tree it
    // can only partly see — that is the failure mode the whole rule exists for.
    const blind = {
      'packages/a/src/one.ts': "import { two } from './missing.js';\nexport const one = two;\n",
    };
    const { status, rules, report } = run(withFixture(blind));
    assert.equal(status, 1);
    assert.deepEqual(rules, ['R7']);
    assert.equal(report.unresolvedRelativeSpecifiers, 1);
    assert.match(report.failures[0].detail, /did not resolve/);

    // Debt frozen at its measured size is accepted, so the rule ratchets rather than blocking the
    // work it exists to make visible.
    const frozenDebt = { ...CLEAN_BASELINE, unresolvedRelativeSpecifiers: 1 };
    assert.equal(run(withFixture(blind, frozenDebt)).status, 0, 'frozen debt is accepted');

    // A JSON import is DATA, not a blind spot: it must be counted, and must never be debt.
    const data = {
      'packages/a/src/one.ts': "import s from './schema.json';\nexport const one = s;\n",
    };
    const { status: dataStatus, report: dataReport } = run(withFixture(data));
    assert.equal(dataStatus, 0);
    assert.equal(dataReport.dataImports, 1);
    assert.equal(dataReport.unresolvedRelativeSpecifiers, 0);
  }

  // ─── the type-only exclusion, which is a claim about the graph, not a nicety ─
  {
    // A type-only import creates no runtime cycle. If the gate counted it, it would fail on a shape
    // that cannot misbehave at runtime — and the exclusion must therefore be VISIBLE, not implicit.
    const typeCycle = {
      'packages/a/src/one.ts': "import type { Two } from './two.js';\nexport const one = 1;\n",
      'packages/a/src/two.ts': "import type { One } from './one.js';\nexport const two = 2;\n",
    };
    const { status, report } = run(withFixture(typeCycle));
    assert.equal(status, 0, 'a type-only cycle is not a runtime cycle');
    assert.equal(report.fileCycles, 0);
    assert.equal(report.typeOnlyEdges, 2, 'the excluded edges must be counted, not dropped');

    // The positive control: the SAME two files with value edges DO form a cycle. Without this, the
    // assertion above would also hold for a detector that simply never finds cycles.
    const valueCycle = {
      'packages/a/src/one.ts': "import { two } from './two.js';\nexport const one = two;\n",
      'packages/a/src/two.ts': "import { one } from './one.js';\nexport const two = one;\n",
    };
    assert.equal(run(withFixture(valueCycle)).report.fileCycles, 1);
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('boundaries-check tests ok\n');
