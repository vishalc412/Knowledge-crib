/**
 * boundaries-check — the WP3 maintenance-risk gate.
 *
 * Plan requirement (developer-trust-plan.md §WP3, bullet 5): "Add enforced package-dependency
 * boundaries, import-cycle detection, and a ratchet preventing new unjustified unsafe casts,
 * suppressions, or unused exports."
 *
 * Rules, each failing with the file that broke it:
 *
 *   R1 runtime boundary     A non-test source file in package P may import `@knowledge-crib/X` only
 *                           when X is declared in P's `dependencies` or `peerDependencies`. An import
 *                           that resolves only because pnpm hoisted it is not a declared edge.
 *   R2 dev boundary         A TEST file may additionally use P's `devDependencies` — the only extra
 *                           grant tests get. Everything else is still R1/R3.
 *   R3 containment          A non-test source file may not import by RELATIVE path outside its own
 *                           package. A production file that reaches `../../../scripts/*.mjs` (or
 *                           another package's `src`) has escaped both its boundary and its build.
 *                           Test files may reach repo tooling under `scripts/fixtures/` — that is an
 *                           existing, deliberate fixture-generator pattern.
 *   R4 package cycles       Zero value-import cycles between packages.
 *   R5 file cycles          RATCHET: the set of value-import cycle components inside packages must
 *                           equal the frozen baseline, exactly. New cycles fail; the baseline cannot
 *                           grow without a reviewer seeing the change in
 *                           `scripts/boundaries-baseline.json`.
 *   R6 suppressions         RATCHET: per-package counts of `@ts-ignore`, `@ts-expect-error`,
 *                           `biome-ignore`, `eslint-disable`, `as any` and `<any>` may not exceed the
 *                           baseline. Counts that DROP are fine (and this check never rewrites the
 *                           baseline file — shrinking it is a deliberate commit).
 *   R7 coverage debt        RATCHET: relative specifiers this textual parser cannot resolve, and
 *                           `.ts` files under skipped directories, are counted. A check that silently
 *                           sees less than it did yesterday is worse than one that shouts.
 *
 * Honesty (read this before trusting a green run):
 *   - This is a TEXTUAL parser, not a type-aware one. It reads import/export specifiers; it does not
 *     follow re-exports through barrels, resolve tsconfig `paths`, or see conditional requires. The
 *     unresolved count in R7 is the size of that blind spot, printed on every run.
 *   - Type-only edges are excluded from cycle detection because a type cycle has no runtime effect,
 *     and they are counted separately so the exclusion is visible rather than assumed.
 *   - Scope is `packages/<pkg>/src` and `packages/<pkg>/test` — shipped modules plus first-party
 *     executable tests. Outside the walk, and COUNTED in the report rather than silently skipped:
 *     `packages/<pkg>/fixtures/**` (test data), the `*.config.ts` build configs at package roots, and
 *     `packages/ui/web/*.js` (browser assets with no module graph). `scripts/` is out of scope too —
 *     it is tooling that deliberately imports built `dist` by path, so a package-boundary rule would
 *     report its normal behaviour as a violation.
 *   - "Unused exports" is NOT implemented: proving an export unused needs a project-wide symbol
 *     analysis (tsc reports unused LOCALS, not exports), and a grep-shaped approximation would be a
 *     gate that fails on prose. Stated here so the omission is a known limit, not a silent one.
 *
 * Usage:  node scripts/boundaries-check.mjs [--root <dir>] [--baseline <file>] [--json]
 * Exit 0 = all rules hold; 1 = at least one rule failed (the failures are printed).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const REPO = rootIndex >= 0 ? resolve(argv[rootIndex + 1]) : resolve(__dirname, '..');
const JSON_OUT = argv.includes('--json');
// The baseline belongs to the TREE being checked, not to the copy of this script that is running —
// so it resolves under REPO. That is what lets the unit test point the gate at a synthetic workspace
// and give it that workspace's own frozen numbers; `--baseline` overrides for one-off runs.
const baselineIndex = argv.indexOf('--baseline');
const BASELINE_PATH =
  baselineIndex >= 0
    ? resolve(argv[baselineIndex + 1])
    : join(REPO, 'scripts', 'boundaries-baseline.json');
const BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'fixtures', '.crib']);
const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;
const SUPPRESSION_RES = {
  'ts-ignore': /@ts-ignore/g,
  'ts-expect-error': /@ts-expect-error/g,
  'biome-ignore': /biome-ignore/g,
  'eslint-disable': /eslint-disable/g,
  'as any': /\bas any\b/g,
  'angle-bracket-any': /<any>/g,
};

const failures = [];
const fail = (rule, detail) => failures.push({ rule, detail });
const toRepoPath = (abs) => relative(REPO, abs).split('\\').join('/');
/** A path under the tree being checked prints relative; anything outside it prints absolute. */
const relativize = (abs) => {
  const rel = relative(REPO, abs);
  return rel.startsWith('..') ? abs : rel.split('\\').join('/');
};

/** The workspace's declared packages, keyed by directory name. */
function readWorkspace() {
  const packagesDir = join(REPO, 'packages');
  const info = {};
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    info[dir] = {
      name: manifest.name,
      runtime: new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })),
      dev: new Set(Object.keys(manifest.devDependencies ?? {})),
    };
  }
  return info;
}

/**
 * Every source file under `packages/<pkg>/src` and `packages/<pkg>/test`.
 *
 * `test/` is walked because it holds real first-party executable code (`packages/cli/test/browser/*.ts`
 * drives the shipped UI in a browser) and the plan's exit criterion is "all first-party executable
 * code is covered by applicable checks". Files skipped by SKIP_DIRS are counted (R7) so the walk's
 * blind spot has a number attached to it instead of reading as full coverage.
 */
function collectSources() {
  const files = [];
  let skipped = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path);
      } else if (SOURCE_RE.test(entry.name)) {
        files.push(path);
      }
    }
  };
  const packagesDir = join(REPO, 'packages');
  for (const dir of readdirSync(packagesDir)) {
    for (const sub of ['src', 'test']) {
      const path = join(packagesDir, dir, sub);
      if (existsSync(path) && statSync(path).isDirectory()) walk(path);
    }
    // `packages/<pkg>/fixtures` sits BESIDE src, so the walk above never reaches it — count it here,
    // otherwise the R7 fixtures figure would be a structural zero that reads like full coverage.
    const fixtures = join(packagesDir, dir, 'fixtures');
    if (existsSync(fixtures) && statSync(fixtures).isDirectory())
      skipped += countSourceFiles(fixtures);
  }
  return { files, skipped };
}

function countSourceFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) n += countSourceFiles(path);
    else if (SOURCE_RE.test(entry.name)) n++;
  }
  return n;
}

/**
 * Build/tooling configs (`vitest.config.ts`, `playwright.config.ts`) sit at the package root, outside
 * the source walk. They are linted by biome, but they are not part of the source module graph the
 * boundary and cycle rules describe — a config importing `vitest/config` makes no claim about how the
 * package is assembled. Counted so the exclusion is a stated number rather than an omission.
 */
function countBuildConfigs() {
  let n = 0;
  const packagesDir = join(REPO, 'packages');
  for (const dir of readdirSync(packagesDir)) {
    for (const name of readdirSync(join(packagesDir, dir), { withFileTypes: true })) {
      if (name.isFile() && SOURCE_RE.test(name.name) && /\.config\./.test(name.name)) n++;
    }
  }
  return n;
}

/**
 * Import/export specifiers in one file, classified. `kind` is `value` or `type`; `specifier` is the
 * raw text between quotes. Re-exports (`export ... from`) are included: a barrel that re-exports is
 * still an edge.
 */
function readSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  const ADD = (raw, kind) => found.push({ specifier: raw, kind });
  // `import ... from 'x'` / `export ... from 'x'` / `import 'x'` / `import('x')`, single or multi line.
  const fromRe = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(fromRe)) {
    ADD(match[3], match[1] ? 'type' : 'value');
  }
  const bareRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(bareRe)) ADD(match[1], 'value');
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(dynamicRe)) ADD(match[1], 'value');
  return found;
}

/** Resolve a relative specifier to a file inside the workspace, mirroring Node's ESM + TS rewriting. */
function resolveRelative(fromFile, specifier, known) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.(js|mjs|cjs|jsx)$/, '.ts'),
    base.replace(/\.(js|mjs|cjs|jsx)$/, '.tsx'),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && known.has(resolve(candidate))) return resolve(candidate);
  }
  return null;
}

/** Tarjan's SCC over `adj`, returning only components with more than one member (real cycles). */
function findCycles(nodes, adj) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return components;
}

const workspace = readWorkspace();
const byName = Object.fromEntries(Object.entries(workspace).map(([dir, info]) => [info.name, dir]));
const { files, skipped } = collectSources();
const known = new Set(files.map((f) => resolve(f)));

const packageEdges = new Set();
const fileAdj = new Map();
const unresolved = [];
const dataImports = [];
const suppressionCounts = {};
let typeOnlyEdges = 0;

for (const file of files) {
  const relativePath = toRepoPath(file);
  const pkg = relativePath.split('/')[1];
  const isTest = TEST_RE.test(relativePath);
  const specifiers = readSpecifiers(file);
  const valueTargets = new Set();

  for (const { specifier, kind } of specifiers) {
    if (specifier.startsWith('@knowledge-crib/')) {
      const target = byName[specifier.match(/^(@[^/]+\/[^/]+)/)?.[1]];
      if (!target) {
        fail('R1', `${relativePath} imports unknown workspace package '${specifier}'`);
        continue;
      }
      if (kind === 'type') {
        typeOnlyEdges++;
        continue;
      }
      packageEdges.add(`${pkg}->${target}`);
      const declaredRuntime = target === pkg || workspace[pkg].runtime.has(workspace[target].name);
      const declaredDev = isTest && workspace[pkg].dev.has(workspace[target].name);
      if (!declaredRuntime && !declaredDev) {
        fail(
          'R1/R2',
          `${relativePath} imports ${workspace[target].name}, not declared in packages/${pkg}/package.json (runtime: ${
            [...workspace[pkg].runtime].join(', ') || 'none'
          }; dev: ${[...workspace[pkg].dev].join(', ') || 'none'})`,
        );
      }
    } else if (specifier.startsWith('.')) {
      if (kind === 'type') {
        typeOnlyEdges++;
        continue;
      }
      // A JSON import is DATA, not a module edge: it cannot create a value cycle and has no package
      // identity of its own. Counted, so the category is visible rather than silently dropped.
      if (specifier.endsWith('.json')) {
        dataImports.push(`${relativePath} -> ${specifier}`);
        continue;
      }
      const target = resolveRelative(file, specifier, known);
      if (!target) {
        unresolved.push(`${relativePath} -> ${specifier}`);
        continue;
      }
      const targetPath = toRepoPath(target);
      const targetPkg = targetPath.split('/')[1];
      if (targetPkg !== pkg) {
        fail('R3', `${relativePath} reaches ${targetPath} by relative path across packages`);
        continue;
      }
      valueTargets.add(target);
    }
  }
  fileAdj.set(resolve(file), valueTargets);

  const source = readFileSync(file, 'utf8');
  for (const [kind, re] of Object.entries(SUPPRESSION_RES)) {
    const count = [...source.matchAll(re)].length;
    if (!count) continue;
    suppressionCounts[pkg] ??= {};
    suppressionCounts[pkg][kind] = (suppressionCounts[pkg][kind] ?? 0) + count;
  }
}

// R3, production containment: a non-test file may not import out of `packages/` by relative path.
// `resolveRelative` only sees files inside the walk, so an escape to `scripts/` shows up as an
// unresolved specifier with `..` in it — that is the signal, and it must be a failure in production
// code and coverage debt in tests (the deliberate `scripts/fixtures/` pattern).
for (const entry of [...unresolved]) {
  const [file, specifier] = entry.split(' -> ');
  if (!specifier.includes('..')) continue;
  if (TEST_RE.test(file)) continue;
  fail('R3', `${file} escapes the workspace by relative path '${specifier}'`);
}

// R4: package-level cycles over VALUE edges only.
const pkgNodes = Object.keys(workspace);
const pkgAdj = new Map(pkgNodes.map((p) => [p, new Set()]));
for (const edge of packageEdges) {
  const [a, b] = edge.split('->');
  if (a !== b) pkgAdj.get(a).add(b);
}
for (const component of findCycles(pkgNodes, pkgAdj)) {
  fail('R4', `package import cycle: ${component.join(' -> ')}`);
}

// R5: file-level cycles, ratcheted against the frozen baseline.
const fileCycles = findCycles([...fileAdj.keys()], fileAdj).map((component) =>
  component.map((f) => toRepoPath(f)).sort(),
);
const baselineCycles = BASELINE.fileCycles.map((component) => [...component].sort());
const signature = (components) =>
  components
    .map((c) => c.join('#'))
    .sort()
    .join('||');
const currentSignature = signature(fileCycles);
const baselineSignature = signature(baselineCycles);
if (currentSignature !== baselineSignature) {
  for (const component of fileCycles) {
    if (!baselineCycles.some((b) => signature([b]) === signature([component]))) {
      fail('R5', `NEW import cycle (not in the baseline): ${component.join(' -> ')}`);
    }
  }
  for (const component of baselineCycles) {
    if (!fileCycles.some((c) => signature([c]) === signature([component]))) {
      fail(
        'R5',
        `frozen cycle is gone or changed: ${component.join(' -> ')} — if it was broken on purpose, remove it from scripts/boundaries-baseline.json in the same commit`,
      );
    }
  }
}

// R6: suppression ratchet — may shrink, may not grow.
for (const [pkg, counts] of Object.entries(suppressionCounts)) {
  for (const [kind, count] of Object.entries(counts)) {
    const allowed = BASELINE.suppressions[pkg]?.[kind] ?? 0;
    if (count > allowed) {
      fail(
        'R6',
        `packages/${pkg} now has ${count} ${kind} marker(s) (baseline ${allowed}) — justify and raise the baseline, or remove one`,
      );
    }
  }
}

// R7: coverage debt — the parser's blind spot may not silently grow.
if (unresolved.length > BASELINE.unresolvedRelativeSpecifiers) {
  fail(
    'R7',
    `${unresolved.length} relative specifiers did not resolve (baseline ${BASELINE.unresolvedRelativeSpecifiers}) — the walk is seeing less than it did, so a green run would mean less than it used to`,
  );
}
if (skipped > BASELINE.skippedSourceFilesInFixtures) {
  fail(
    'R7',
    `${skipped} .ts files sit under skipped fixtures/ dirs (baseline ${BASELINE.skippedSourceFilesInFixtures})`,
  );
}

const report = {
  root: REPO,
  filesWalked: files.length,
  packages: pkgNodes.length,
  packageEdges: packageEdges.size,
  packageCycles: findCycles(pkgNodes, pkgAdj).length,
  fileCycles: fileCycles.length,
  fileCycleList: fileCycles,
  typeOnlyEdges,
  unresolvedRelativeSpecifiers: unresolved.length,
  unresolvedList: unresolved,
  dataImports: dataImports.length,
  skippedSourceFilesInFixtures: skipped,
  buildConfigFilesOutsideWalk: countBuildConfigs(),
  suppressionCounts,
  failures,
};

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
} else {
  const line = (label, value) => process.stdout.write(`  ${label.padEnd(34)} ${value}\n`);
  process.stdout.write('boundaries-check\n');
  line('baseline', relativize(BASELINE_PATH));
  line('packages / source files walked', `${pkgNodes.length} / ${files.length}`);
  line('declared package edges', packageEdges.size);
  line('package cycles (R4)', report.packageCycles);
  line('file cycles (R5, frozen)', `${fileCycles.length} / ${baselineCycles.length}`);
  line('type-only edges excluded from cycles', typeOnlyEdges);
  line('JSON data imports (not edges)', dataImports.length);
  line(
    'unresolved relative specifiers (R7)',
    `${unresolved.length} / ${BASELINE.unresolvedRelativeSpecifiers}`,
  );
  line('skipped .ts under fixtures/ (R7)', `${skipped} / ${BASELINE.skippedSourceFilesInFixtures}`);
  process.stdout.write(
    `  suppression markers (R6)            ${Object.entries(suppressionCounts)
      .map(([pkg, counts]) => `${pkg}:${Object.values(counts).reduce((a, b) => a + b, 0)}`)
      .join(' ')}\n`,
  );
  if (failures.length) {
    process.stdout.write(`\nFAIL — ${failures.length} violation(s):\n`);
    for (const { rule, detail } of failures) process.stdout.write(`  [${rule}] ${detail}\n`);
  } else {
    process.stdout.write('\nPASS — no boundary, cycle, or ratchet violation\n');
  }
}

process.exitCode = failures.length ? 1 : 0;
