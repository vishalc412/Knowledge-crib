/**
 * Local MuleSoft sample-project acceptance gate (MUnit-hardening Task 6).
 *
 * A license-safe, hermetic acceptance checker that indexes a Mule project (a directory OR a
 * `.zip`/`.jar` archive) with the built knowledge-crib CLI and asserts the extracted graph matches
 * an exact topology baseline. NO proprietary code is required: the companion fixture
 * `scripts/fixtures/synthetic-mule-project.mjs` generates a deterministic synthetic Mule 4 app from
 * scratch that exercises every extraction path (flows, subflows, flow-refs, choices, transforms,
 * inline DataWeave, listeners, APIKit routes, outbound HTTP, error handlers, production + test
 * DataWeave modules, MUnit tests + mocks, unresolved external-flow placeholders) at known counts.
 *
 * SECURITY (the locked constraint: keys + references only, never values):
 *   - asserts NO property node carries a raw `value` (sensitive files are key-only / value-redacted),
 *   - asserts NO semantic node is emitted from generated report JavaScript (`reports/assets/js/`).
 *
 * The baseline is the synthetic corpus. A real project (e.g. the supplied `sapi-billing` ZIP) will
 * differ in counts — the checker still prints its measured table so a human can inspect a live
 * sample, and still enforces the two security canaries (which hold for any project). Run it:
 *   `node scripts/check-mule-sample.mjs --archive /abs/path/to/mule-project-or-zip`
 *
 * The checker never copies or stages the archive itself — directory inputs are scanned in place,
 * archive inputs reuse the CLI's own content-addressed staging cache (`~/.crib/imports/<sha>/source`)
 * only to count inline DataWeave `#[...]` blocks (which are a source-text metric, not a graph node).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_DIST = join(REPO_ROOT, 'packages/cli/dist/cli.js');

/** The synthetic-corpus baseline. `inlineDw2` is a source-text count (the `#[...]` DataWeave
 *  blocks), not a graph node; the rest are graph counts. */
export const EXPECTED = {
  flows: 18,
  subflows: 7,
  flowRefs: 39,
  choices: 10,
  transforms: 27,
  inlineDw2: 30,
  listeners: 2,
  apiOperations: 8,
  outboundCalls: 4,
  errorHandlers: 15,
  productionDwl: 1,
  testDwl: 21,
  munitTests: 6,
  mocks: 6,
  externalFlowTargets: 3,
};

/** Recursively read every JSONL record under `dir` (the partitioned soul shards). */
function readShards(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...readShards(p));
    else if (p.endsWith('.jsonl'))
      for (const line of readFileSync(p, 'utf8').split('\n'))
        if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

/** Count `#[` occurrences in every `.xml` file under `sourceRoot` (inline DataWeave 2 blocks). */
function countInlineDw2(sourceRoot) {
  let n = 0;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith('.xml')) n += (readFileSync(p, 'utf8').match(/#\[/g) || []).length;
    }
  };
  if (existsSync(sourceRoot)) walk(sourceRoot);
  return n;
}

/** Resolve the on-disk source tree the pipeline indexed: a directory input IS its source; an
 *  archive input is staged by the CLI at `<importsDir>/<sha256(resolve(path))>/source` (the same
 *  content-addressed cache `prepared-source` uses — reusing the CLI's staging, not our own). */
function sourceRootFor(archivePath) {
  const st = statSync(archivePath);
  if (st.isDirectory()) return archivePath;
  const importsDir = process.env.KCRIB_IMPORTS_DIR || join(homedir(), '.crib', 'imports');
  const baseDir = join(
    importsDir,
    createHash('sha256')
      .update(Buffer.from(resolve(archivePath)))
      .digest('hex'),
  );
  return join(baseDir, 'source');
}

/** Compute every topology count + security canary from the extracted soul. */
function measure(nodes, sourceRoot) {
  const by = (pred) => nodes.filter(pred);
  const file = (n) => n.file || n.path || '';
  return {
    counts: {
      flows: by((n) => n.type === 'flow').length,
      subflows: by((n) => n.type === 'subflow').length,
      flowRefs: by((n) => n.kind === 'statement' && n.meta?.semanticKind === 'flow-ref').length,
      choices: by(
        (n) =>
          n.kind === 'statement' &&
          n.meta?.semanticKind === 'router' &&
          n.meta?.operation === 'choice',
      ).length,
      transforms: by((n) => n.kind === 'statement' && n.meta?.semanticKind === 'transform').length,
      inlineDw2: countInlineDw2(sourceRoot),
      listeners: by((n) => n.kind === 'route' && n.meta?.semanticKind === 'source').length,
      apiOperations: by((n) => n.kind === 'route' && n.lang === 'raml').length,
      outboundCalls: by((n) => n.kind === 'http-call').length,
      errorHandlers: by((n) => n.kind === 'exception-handler').length,
      productionDwl: by(
        (n) => n.type === 'module' && n.lang === 'dataweave' && !file(n).includes('src/test/'),
      ).length,
      testDwl: by(
        (n) => n.type === 'module' && n.lang === 'dataweave' && file(n).includes('src/test/'),
      ).length,
      munitTests: by((n) => n.type === 'test').length,
      mocks: by((n) => n.kind === 'statement' && n.meta?.munitKind === 'mock').length,
      externalFlowTargets: by((n) => n.type === 'external-flow').length,
    },
    canaries: {
      // A property node must never persist its value — sensitive files are key-only / redacted.
      propertiesWithRawValue: by((n) => n.type === 'property' && n.value !== undefined).length,
      // Generated report/asset JavaScript must yield zero SEMANTIC nodes (a `file` manifest entry is
      // expected for every discovered file — the canary is about extraction altitude, not discovery).
      reportJsSymbols: by((n) => file(n).startsWith('reports/assets/js/') && n.kind !== 'file')
        .length,
    },
  };
}

/**
 * Index `archivePath` (absolute path to a Mule directory or `.zip`/`.jar`) and verify the extracted
 * graph against {@link EXPECTED}. Returns `{ counts, canaries, passed, mismatches }`. Throws on
 * invalid input or a CLI index failure.
 */
export function checkMuleSample(archivePath, opts = {}) {
  assert.ok(archivePath, 'checkMuleSample: archivePath is required');
  assert.ok(
    isAbsolute(archivePath),
    `checkMuleSample: --archive must be absolute, got ${archivePath}`,
  );
  assert.ok(existsSync(archivePath), `checkMuleSample: --archive not found: ${archivePath}`);
  assert.ok(
    existsSync(CLI_DIST),
    `checkMuleSample: built CLI not found at ${CLI_DIST} — run \`corepack pnpm@9.15.0 build\` first`,
  );

  const cribDir = mkdtempSync(join(tmpdir(), 'mule-check-crib-'));
  try {
    // Index into a throwaway crib dir. The CLI stages archives itself; directories are indexed in place.
    execFileSync(process.execPath, [CLI_DIST, 'index', archivePath, '--crib-dir', cribDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`crib index failed for ${archivePath}:\n${err.stderr || err.message}`);
  }

  const nodes = readShards(join(cribDir, 'graph/extracted/nodes'));
  const sourceRoot = sourceRootFor(archivePath);
  const { counts, canaries } = measure(nodes, sourceRoot);

  // Optional synthetic-only secret canary: the caller knows the planted secret string (the live
  // sample does not) and asserts it never persists in the extracted graph (keys + references only).
  if (opts.secretCanary) {
    const escaped = opts.secretCanary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    canaries.secretHits = (JSON.stringify(nodes).match(new RegExp(escaped, 'g')) || []).length;
  }

  const mismatches = [];
  for (const key of Object.keys(EXPECTED))
    if (counts[key] !== EXPECTED[key])
      mismatches.push({ metric: key, expected: EXPECTED[key], actual: counts[key] });
  const canaryFailures = Object.entries(canaries).filter(([, v]) => v !== 0);
  const passed = mismatches.length === 0 && canaryFailures.length === 0;
  return { counts, canaries, passed, mismatches, canaryFailures, nodes: nodes.length };
}

/** Render a one-row-per-metric table (measured vs expected) for human inspection. */
function renderTable(counts, canaries, mismatches) {
  const rows = [];
  for (const key of Object.keys(EXPECTED)) {
    const exp = EXPECTED[key];
    const got = counts[key];
    const ok = got === exp;
    const flag = mismatches.some((m) => m.metric === key) ? 'FAIL' : 'ok';
    rows.push(
      `  ${key.padEnd(20)} ${String(got).padStart(4)} / ${String(exp).padStart(4)}  ${flag}`,
    );
  }
  rows.push('  --- security canaries (must be 0) ---');
  for (const [k, v] of Object.entries(canaries))
    rows.push(`  ${k.padEnd(20)} ${String(v).padStart(4)}`);
  return rows.join('\n');
}

// When invoked directly as `node scripts/check-mule-sample.mjs --archive <path>`, validate input,
// run the check, print the table, and exit nonzero on any mismatch (topology or canary). The is-main
// guard prevents the CLI/usage branch from firing when the test imports this module.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const ai = argv.indexOf('--archive');
  const archivePath = ai >= 0 ? argv[ai + 1] : undefined;
  if (!archivePath || !isAbsolute(archivePath)) {
    process.stderr.write('usage: node scripts/check-mule-sample.mjs --archive <absolute-path>\n');
    process.exitCode = 2;
  } else if (!existsSync(archivePath)) {
    process.stderr.write(`error: --archive not found: ${archivePath}\n`);
    process.exitCode = 2;
  } else {
    const { counts, canaries, passed, mismatches, canaryFailures, nodes } =
      checkMuleSample(archivePath);
    process.stdout.write(`MuleSoft sample acceptance — ${nodes} nodes\n`);
    process.stdout.write(`${renderTable(counts, canaries, mismatches)}\n`);
    if (mismatches.length)
      process.stderr.write(
        `\n${mismatches.length} topology mismatch(es):\n${mismatches
          .map((m) => `  ${m.metric}: expected ${m.expected}, got ${m.actual}`)
          .join('\n')}\n`,
      );
    if (canaryFailures.length)
      process.stderr.write(
        `\n${canaryFailures.length} security canary failure(s):\n${canaryFailures.map(([k, v]) => `  ${k}: ${v} (must be 0)`).join('\n')}\n`,
      );
    if (!passed) process.exitCode = 1;
  }
}
