/**
 * alias-check — the M2.4 alias-dictionary gate.
 *
 * Pins the plan's M2.4 gate intent: "DTI/debt-to-income-class alias queries resolve."
 *
 * The load-bearing case: a class named `DebtToIncomeCalculator`. The FTS5 `unicode61` tokenizer
 * case-folds and strips non-alphanumerics but does NOT split camelCase, so the class name becomes a
 * single token `debttoincomecalculator`. A user query "DTI" tokenizes to `dti`; the MATCH builder
 * turns each token into a prefix match (`dti*`), and `debttoincomecalculator` does NOT start with
 * `dti` — so BM25 misses the class entirely. The alias dictionary maps "DTI" → "debt to income"; the
 * rewrite pass appends the expansion, and "debt" → prefix `debt*` DOES match
 * `debttoincomecalculator`. The acronym query now resolves.
 *
 * Asserts:
 *   (1) Strict miss — raw `index.query({text:"DTI"})` returns ZERO hits to `DebtToIncomeCalculator`
 *       (the FTS token-prefix mismatch that motivates the whole feature).
 *   (2) Resolve — after writing `.crib/graph/semantic/aliases.json` with `DTI → debt to income` and routing the
 *       same query through `Verbs.query`, the calculator class surfaces in the hits.
 *   (3) No-op regression — a Verbs constructed over a soul with NO aliases file behaves identically
 *       to the raw index (empty map ⇒ rewrite is a pure no-op ⇒ "DTI" still misses the class).
 *   (4) Determinism — two `Verbs.query({q:"DTI"})` calls over the same aliased soul return identical
 *       hit id sets.
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * core + mcp dist resolve.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const NOW = '2026-01-01T00:00:00.000Z';

const core = await import(
  pathToFileURL(resolve(REPO, 'packages', 'core', 'dist', 'index.js')).href
);
const soulSchema = await import(
  pathToFileURL(resolve(REPO, 'packages', 'soul-schema', 'dist', 'index.js')).href
);
const mcp = await import(pathToFileURL(resolve(REPO, 'packages', 'mcp', 'dist', 'index.js')).href);
const { SoulStore, SqliteIndexStore, newManifest, writeAliases } = core;
const { idFor, contentHash } = soulSchema;
const { Verbs } = mcp;

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  alias:check FAIL — ${msg}\n`);
  failed++;
};

/** Build a soul carrying only the `DebtToIncomeCalculator` class symbol (no docs, no "dti"/"debt"
 * anywhere else) so the ONLY way to retrieve it is via the camelCase token prefix. */
const buildSoul = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-alias-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  const qn = 'DebtToIncomeCalculator';
  const node = {
    id: idFor({ kind: 'symbol', path: 'src/calc.ts', qualifiedName: qn, startLine: 1 }),
    kind: 'symbol',
    type: 'class',
    name: 'DebtToIncomeCalculator',
    qualifiedName: qn,
    file: 'src/calc.ts',
    span: { start: 1, end: 4 },
    lang: 'typescript',
    hash: contentHash(qn),
  };
  soul.putNodes([node]);
  soul.commit(NOW);
  const index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  return { repo, soul, index, calcId: node.id };
};

try {
  const base = buildSoul();
  try {
    const calcId = base.calcId;

    // (1) Strict miss — raw BM25 "DTI" does not hit the calculator class.
    const rawHits = base.index.query({ text: 'DTI', limit: 10 });
    const rawCalc = rawHits.filter((h) => h.id === calcId);
    if (rawCalc.length !== 0) {
      fail(`strict miss not satisfied: raw "DTI" hit DebtToIncomeCalculator (${rawCalc.length})`);
    } else {
      process.stdout.write(
        '  alias:check — strict miss: raw "DTI" does not hit DebtToIncomeCalculator (token-prefix mismatch)\n',
      );
    }

    // (2) Resolve — write the alias dict, route through Verbs.query, class surfaces.
    writeAliases(join(base.repo, '.crib'), [{ alias: 'DTI', expand: 'debt to income' }]);
    const v = new Verbs({ soul: base.soul, index: base.index, repoRoot: base.repo });
    const res = v.query({ q: 'DTI', limit: 10 });
    const hits = Array.isArray(res.hits) ? res.hits : [];
    const verbCalc = hits.filter((h) => h.id === calcId);
    if (verbCalc.length === 0) {
      fail(
        'resolve not satisfied: Verbs.query("DTI") with alias did not surface DebtToIncomeCalculator',
      );
    } else {
      process.stdout.write(
        '  alias:check — resolve: Verbs.query("DTI") + DTI→"debt to income" surfaces DebtToIncomeCalculator\n',
      );
    }

    // (3) No-op regression — a Verbs over a soul with NO aliases file still misses (empty map no-op).
    const noAlias = buildSoul();
    try {
      const vNoAlias = new Verbs({
        soul: noAlias.soul,
        index: noAlias.index,
        repoRoot: noAlias.repo,
      });
      const resNoAlias = vNoAlias.query({ q: 'DTI', limit: 10 });
      const hitsNoAlias = Array.isArray(resNoAlias.hits) ? resNoAlias.hits : [];
      const noAliasCalc = hitsNoAlias.filter((h) => h.id === noAlias.calcId);
      if (noAliasCalc.length !== 0) {
        fail(
          `no-op regression: empty alias dict still hit the class (${noAliasCalc.length}) — rewrite is not a pure no-op`,
        );
      } else {
        process.stdout.write(
          '  alias:check — no-op: empty alias dict ⇒ "DTI" still misses (rewrite is a pure no-op)\n',
        );
      }
    } finally {
      rmSync(noAlias.repo, { recursive: true, force: true });
    }

    // (4) Determinism — two Verbs.query calls over the same aliased soul return identical hit-id sets.
    const r1 = v.query({ q: 'DTI', limit: 10 });
    const r2 = v.query({ q: 'DTI', limit: 10 });
    const ids1 = (Array.isArray(r1.hits) ? r1.hits : [])
      .map((h) => h.id)
      .sort()
      .join(',');
    const ids2 = (Array.isArray(r2.hits) ? r2.hits : [])
      .map((h) => h.id)
      .sort()
      .join(',');
    if (ids1 !== ids2) {
      fail(`nondeterministic: two Verbs.query("DTI") calls diverged\n  ${ids1}\n  ${ids2}`);
    } else {
      process.stdout.write('  alias:check — deterministic across two Verbs.query calls\n');
    }
  } finally {
    rmSync(base.repo, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  alias:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nalias:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nalias:check — all assertions passed\n');
