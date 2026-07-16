/**
 * M2.3 linker gate — pins the embedding-cosine linker's recall-up over the M7 TF-IDF baseline on the
 * docs-semantic fixture, with precision held.
 *
 * Asserts:
 *   (1) Strict catch — the inflection pair (`validateInput` vs "validation logic …") is linked by the
 *       embedding backend but NOT by TF-IDF (no stemmer ⇒ "validation" ≠ "validate" ⇒ no shared term).
 *   (2) Recall-up — embedding emits at least as many INFERRED references edges as TF-IDF on the same
 *       deterministic soul.
 *   (3) Precision held — no INFERRED edge is ever `describes`, and the unrelated `rotate` symbol (key
 *       rotation) carries no INFERRED references edge from the validation section.
 *   (4) Determinism — two embedding runs produce byte-identical edge sets.
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built core
 * + pipeline dist resolve.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const FIXTURE = join(REPO, 'packages', 'pipeline', 'fixtures', 'docs-semantic');
const NOW = '2026-01-01T00:00:00.000Z';

const core = await import(resolve(REPO, 'packages', 'core', 'dist', 'index.js'));
const pipeline = await import(resolve(REPO, 'packages', 'pipeline', 'dist', 'index.js'));
const { SoulStore, newManifest } = core;
const { indexRepo } = pipeline;
const { runSemanticLink } = await import(
  resolve(REPO, 'packages', 'pipeline', 'dist', 'linker', 'index.js')
);

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  linker:check FAIL — ${msg}\n`);
  failed++;
};

const fixtureSoul = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crib-linker-'));
  const soul = new SoulStore(dir, { manifest: newManifest({ now: NOW }) });
  soul.load();
  return { dir, soul };
};

const referencesEdges = (soul) => [...soul.iterateEdges('references')];
const describesEdges = (soul) => [...soul.iterateEdges('describes')];
const findSym = (soul, qn) => [...soul.iterate('symbol')].find((n) => n.qualifiedName === qn);

// Build a deterministic-only soul, then run each backend against a fresh copy so the two edge sets
// are independent (runSemanticLink mutates the soul in place).
const base = fixtureSoul();
try {
  await indexRepo(base.soul, FIXTURE, { now: NOW });
  const validateInput = findSym(base.soul, 'validateInput');
  const rotate = findSym(base.soul, 'TokenService.rotate');
  if (!validateInput) fail('fixture did not surface validateInput symbol');
  if (!rotate) fail('fixture did not surface TokenService.rotate symbol');

  const runMode = (mode) => {
    const { dir, soul } = fixtureSoul();
    return indexRepo(soul, FIXTURE, { now: NOW }).then(() => {
      const added = runSemanticLink(soul, FIXTURE, undefined, { mode }).added;
      return { dir, soul, added, edges: referencesEdges(soul), describes: describesEdges(soul) };
    });
  };

  const tfidf = await runMode('tfidf');
  const emb1 = await runMode('embedding');
  const emb2 = await runMode('embedding');

  const linkedTo = (run, id) => run.edges.filter((e) => e.dst === id && e.method === 'semantic');

  // (1) Strict catch.
  const tfidfHitsValidate = validateInput ? linkedTo(tfidf, validateInput.id).length : -1;
  const embHitsValidate = validateInput ? linkedTo(emb1, validateInput.id).length : -1;
  if (!(tfidfHitsValidate === 0 && embHitsValidate >= 1)) {
    fail(
      `strict catch not satisfied: tfidf→validateInput=${tfidfHitsValidate} ` +
        `embedding→validateInput=${embHitsValidate} (need tfidf=0, embedding≥1)`,
    );
  } else {
    process.stdout.write(
      '  linker:check — strict inflection catch: embedding linked validateInput (tfidf missed)\n',
    );
  }

  // (2) Recall-up.
  if (!(emb1.added >= tfidf.added)) {
    fail(`embedding recall not ≥ tfidf: tfidf.added=${tfidf.added} embedding.added=${emb1.added}`);
  } else {
    process.stdout.write(
      `  linker:check — recall held/improved: tfidf.added=${tfidf.added} embedding.added=${emb1.added}\n`,
    );
  }

  // (3a) Precision — no INFERRED edge is ever describes.
  const inferredDescribes = [...emb1.describes, ...emb1.edges].filter(
    (e) => e.provenance === 'INFERRED' && e.rel === 'describes',
  );
  if (inferredDescribes.length > 0) {
    fail(`INFERRED edge promoted to describes: ${inferredDescribes.length}`);
  } else {
    process.stdout.write('  linker:check — no INFERRED edge promoted to describes\n');
  }

  // (3b) Precision — rotate (unrelated to validation) carries no INFERRED references edge.
  if (rotate) {
    const inferredRotate = linkedTo(emb1, rotate.id);
    if (inferredRotate.length > 0) {
      fail(
        `embedding linked unrelated rotate: ${inferredRotate.length} INFERRED references edge(s)`,
      );
    } else {
      process.stdout.write('  linker:check — unrelated rotate not linked (precision held)\n');
    }
  }

  // (4) Determinism — two embedding runs identical.
  const sig = (run) =>
    run.edges
      .filter((e) => e.method === 'semantic')
      .map((e) => `${e.src}|${e.dst}|${e.confidence}|${e.evidence?.by}|${e.evidence?.score}`)
      .sort()
      .join(',');
  if (sig(emb1) !== sig(emb2)) {
    fail('embedding linker nondeterministic across two runs');
  } else {
    process.stdout.write('  linker:check — deterministic across two embedding runs\n');
  }

  for (const r of [base, tfidf, emb1, emb2]) rmSync(r.dir, { recursive: true, force: true });
} catch (err) {
  process.stderr.write(`  linker:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nlinker:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nlinker:check — all assertions passed\n');
