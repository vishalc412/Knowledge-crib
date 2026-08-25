/**
 * js-coverage-check — the M2.5 plain-JS coverage gate.
 *
 * Pins the plan's M2.5 gate intent: "plain-JS fixture repo indexes with parity coverage."
 *
 * Before M2.5 the TS extractor admitted only `.ts/.tsx/.mts/.cts`; `.js/.jsx/.mjs/.cjs` files got a
 * Phase-1 `file` node but no extractor claimed them, so Phase 2 (`if (!extractor) continue`) dropped
 * them — no symbols, no edges. M2.5 extends the extractor's `EXTS` to the JS family (the syntactic
 * `createSourceFile` engine parses JS/JSX just as well as TS; no `allowJs`/program needed) and stamps
 * those nodes `lang: 'javascript'`.
 *
 * Asserts (parity = JS files produce the same KIND of graph a TS file would, not just a file node):
 *   (1) Coverage — each of `.js`, `.jsx`, `.mjs`, `.cjs` yields ≥1 `symbol` node tagged
 *       `lang: 'javascript'` (functions/classes surfaced, not dropped).
 *   (2) Edges — the fixture produces ≥1 `member-of` edge (symbol → file) and ≥1 `calls` edge
 *       (verify → helper in calc.js), proving the symbol + intra-file-call passes run on JS.
 *   (3) No false TS tag — no symbol node from the JS fixture is tagged `lang: 'typescript'`.
 *   (4) Determinism — two indexes of the same fixture produce identical node-id + edge-id sets.
 *
 * release:verify builds every package before any gate runs, so the dynamic imports resolve.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const FIXTURE = join(REPO, 'packages', 'pipeline', 'fixtures', 'plain-js');
const NOW = '2026-01-01T00:00:00.000Z';

const core = await import(
  pathToFileURL(resolve(REPO, 'packages', 'core', 'dist', 'index.js')).href
);
const pipeline = await import(
  pathToFileURL(resolve(REPO, 'packages', 'pipeline', 'dist', 'index.js')).href
);
const { SoulStore, newManifest } = core;
const { indexRepo } = pipeline;

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  js-coverage:check FAIL — ${msg}\n`);
  failed++;
};

const buildSoul = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-jscov-'));
  const soul = new SoulStore(dir, { manifest: newManifest({ now: NOW }) });
  soul.load();
  return { dir, soul };
};

const sig = (soul) => {
  const nodes = [...soul.iterate('symbol')]
    .map((n) => `${n.id}|${n.lang ?? ''}|${n.qualifiedName ?? ''}`)
    .sort()
    .join(',');
  const edges = [...soul.iterateEdges()]
    .map((e) => `${e.id}|${e.src}|${e.dst}|${e.rel}`)
    .sort()
    .join(',');
  return `${nodes}::${edges}`;
};

try {
  const a = buildSoul();
  const b = buildSoul();
  try {
    await indexRepo(a.soul, FIXTURE, { now: NOW });
    await indexRepo(b.soul, FIXTURE, { now: NOW });

    const symbols = [...a.soul.iterate('symbol')];
    const jsSyms = symbols.filter((s) => s.lang === 'javascript');
    const tsSyms = symbols.filter((s) => s.lang === 'typescript');

    // (1) Coverage — each JS extension yields ≥1 javascript-tagged symbol.
    const exts = new Set(['.js', '.jsx', '.mjs', '.cjs']);
    const covered = new Set();
    for (const s of jsSyms) {
      for (const ext of exts) {
        if ((s.file ?? '').endsWith(ext)) covered.add(ext);
      }
    }
    const missing = [...exts].filter((e) => !covered.has(e));
    if (missing.length > 0) {
      fail(`coverage gap: no javascript-tagged symbol for ${missing.join(', ')}`);
    } else {
      process.stdout.write(
        `  js-coverage:check — coverage: .js/.jsx/.mjs/.cjs each yield ≥1 lang:javascript symbol (${jsSyms.length} total)\n`,
      );
    }

    // (2) Edges — member-of + calls present (parity with the TS path).
    const edges = [...a.soul.iterateEdges()];
    const memberOf = edges.filter((e) => e.rel === 'member-of').length;
    const calls = edges.filter((e) => e.rel === 'calls').length;
    if (memberOf < 1) fail(`parity: no member-of edges (got ${memberOf})`);
    else process.stdout.write(`  js-coverage:check — member-of edges: ${memberOf}\n`);
    if (calls < 1) fail(`parity: no calls edges (got ${calls})`);
    else process.stdout.write(`  js-coverage:check — calls edges: ${calls}\n`);

    // (3) No false TS tag — the JS fixture must not stamp any symbol lang:typescript.
    if (tsSyms.length > 0) {
      fail(`${tsSyms.length} symbol(s) from the JS fixture tagged lang:typescript (false TS tag)`);
    } else {
      process.stdout.write(
        '  js-coverage:check — no JS-fixture symbol falsely tagged lang:typescript\n',
      );
    }

    // (4) Determinism — two indexes identical.
    if (sig(a.soul) !== sig(b.soul)) {
      fail('nondeterministic: two indexes of the plain-js fixture diverged');
    } else {
      process.stdout.write('  js-coverage:check — deterministic across two indexes\n');
    }
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  js-coverage:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\njs-coverage:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\njs-coverage:check — all assertions passed\n');
