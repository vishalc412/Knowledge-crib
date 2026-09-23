#!/usr/bin/env node
/**
 * WP4 §10.5 — the retrieval-arm guards in `scripts/bench/locate-eval.mjs`.
 *
 * WHY THIS SUITE EXISTS. `locate-eval.mjs` scores change localisation against a tree's index, and the
 * arm it scores under is a property of that index, not a flag on the script: `crib query` opens
 * lexically and only fuses when the index carries vectors AND the on-device tier loads for them
 * (`cli.ts` `cmdQuery` → `upgradeIndexToVectors`). Before this change the arm was ambient and
 * undisclosed, so two runs against two index states produced two MRR columns a reader could not
 * attribute — a number whose meaning depends on an unstated condition.
 *
 * The fix introduced four rules. Each is driven here as a subprocess against a synthetic fixture, and
 * each is shown FIRING ON A VIOLATION and QUIET ON ITS COMPLIANT TWIN, because a guard that only ever
 * refuses is indistinguishable from a guard that refuses everything:
 *
 *   R1 leak check      a tree not at the corpus base is refused before measurement.
 *   R2 arm spelling    `--arm` accepts c0|c1 and rejects anything else.
 *   R3 c1 needs vectors  `--arm c1` against a vectorless index is refused PRE-FLIGHT — before the
 *                      run is paid for — because no tier state can make it true.
 *   R4 arm readable    an unreadable/missing index refuses rather than scoring under an unknown arm.
 *   R5 verified, not inferred  a vector-carrying index whose tier does NOT load is reported as
 *                      `c0-lexical-only` with `servedLexically: true`, not as hybrid. This is the
 *                      rule a single index probe cannot implement, and the reason the stderr of the
 *                      real `crib query` subprocesses is read at all.
 *   R6 post-run mismatch  `--arm c1` against that same degraded tree is refused with the POST-RUN
 *                      wording ("the run measured"), proving the refusal is decided by what the run
 *                      did rather than by what the index looked like.
 *   R7 the live arm   when a tier IS installed, the same vector-carrying tree reports
 *                      `c1-hybrid-rrf-rerank` and `servedLexically: false`, and `--arm c0` against it
 *                      is refused. SKIPS (with the reason stated) on a machine with no tier, because
 *                      the hybrid arm genuinely cannot be measured there — that skip is itself an
 *                      assertion of the contract, not leniency.
 *
 * The fixtures never need a multi-GB build for the non-hybrid rules: "carries vectors" is three rows
 * in `vector_meta`, which is exactly what every reader of the arm consults.
 *
 * Run: node scripts/bench/locate-eval.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const HARNESS = join(REPO, 'scripts', 'bench', 'locate-eval.mjs');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const TIER = join(homedir(), '.crib', 'embed', 'manifest.json');

/** The embedder id every real build on this machine records; only the id/dim pair is read. */
const VECTOR_META = [
  ['embedderId', 'multilingual-e5-large-1024-sym'],
  ['dim', '1024'],
  ['textVersion', '2'],
];

/**
 * A fresh-machine env: an isolated HOME with no embed home, so `resolveCodeVectorEmbedder` fails and
 * the CLI takes its degradation path. The convention is `packages/cli/src/cli.test.ts`'s — a control
 * fixture must not inherit whatever tier the machine happens to have installed.
 */
function freshEnv() {
  const home = mkdtempSync(join(tmpdir(), 'locate-arm-home-'));
  return { ...process.env, HOME: home, KCRIB_EMBED_HOME: undefined };
}

/** A git repo at one commit, holding one small source file. Returns its sha. */
function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'locate-arm-tree-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: dir });
  const src = join(dir, 'src', 'thing.ts');
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, 'export function renameFixtureHelper(): string {\n  return "fixture";\n}\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'feat(core): add the fixture helper'], { cwd: dir });
  return dir;
}

/** The tree's single commit — the only value `--base-tree` accepts for a fixture corpus. */
function head(tree) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim();
}

/** Build a real index in the fixture tree. A 2-file repo: cheap, and no fixture of crib's own. */
function indexTree(tree, env) {
  const r = spawnSync(process.execPath, [CLI, 'index', '.'], { cwd: tree, encoding: 'utf8', env });
  assert.equal(r.status, 0, `fixture index failed: ${r.stderr}`);
  const db = join(tree, '.crib', 'index', 'crib.sqlite');
  assert.ok(existsSync(db), 'the fixture index must exist');
  return db;
}

/**
 * Make the index CARRY vectors without building any.
 *
 * The arm logic reads `vector_meta` and nothing else — a real `--vectors` build would need the
 * multi-GB tier, and would still say exactly these three things. Planting the state is the whole
 * point: it isolates "the index has vectors" from "the tier can serve them", which is the pair R5
 * exists to distinguish.
 */
function plantVectors(db) {
  const sql = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const db = new DatabaseSync(process.argv[1]);',
    'db.exec("CREATE TABLE IF NOT EXISTS vector_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");',
    'const up = db.prepare("INSERT OR REPLACE INTO vector_meta (k, v) VALUES (?, ?)");',
    `for (const [k, v] of ${JSON.stringify(VECTOR_META)}) up.run(k, v);`,
    'db.close();',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', sql, db], { encoding: 'utf8' });
  assert.equal(r.status, 0, `planting vectors failed: ${r.stderr}`);
}

/** A one-task corpus naming the tree's own commit, so only the arm rules can refuse a run. */
function writeCorpus(base) {
  const path = join(mkdtempSync(join(tmpdir(), 'locate-arm-corpus-')), 'corpus.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        repo: 'fixture',
        base,
        head: base,
        tasks: [
          {
            id: 'fixture-task',
            author: 'fixture',
            date: '2026-01-01T00:00:00+00:00',
            question: 'feat(core): rename the fixture helper\n\nThe body mentions a helper.',
            type: 'feat',
            scope: 'core',
            expectedFiles: ['src/thing.ts'],
            unreachableFiles: [],
            strippedTokens: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

/** Run the harness. Never throws: these rules are asserted on status, stdout and stderr. */
function run(args, env = freshEnv()) {
  const r = spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const env = freshEnv();
const tree = makeTree();
const base = head(tree);
const db = indexTree(tree, env);
const corpus = writeCorpus(base);
const ARGS = ['--corpus', corpus, '--base-tree', tree, '--limit', '1'];

// R1 — the leak check, violation and twin.
{
  const wrong = writeCorpus('0'.repeat(40));
  const bad = run(['--corpus', wrong, '--base-tree', tree, '--limit', '1'], env);
  assert.equal(bad.status, 2, 'R1: a tree not at the corpus base must be refused');
  assert.match(bad.stderr, /the corpus base/, 'R1: the refusal must name the corpus base by name');
  assert.match(
    bad.stderr,
    /the leak this corpus is designed to prevent/,
    'R1: the refusal must name the defect',
  );

  const good = run(ARGS, env);
  assert.equal(good.status, 0, `R1 twin: the matching base must score: ${good.stderr}`);
  process.stdout.write('  ✓ R1: a tree off the corpus base is refused; the matching tree scores\n');
}

// R2 — the arm spelling, violation and twin.
{
  const typo = run([...ARGS, '--arm', 'c3'], env);
  assert.equal(typo.status, 2, 'R2: an unknown --arm value must be refused');
  assert.match(typo.stderr, /--arm must be c0 or c1 \(got "c3"\)/, 'R2: the refusal must quote it');

  const twin = run([...ARGS, '--arm', 'c0'], env);
  assert.equal(twin.status, 0, `R2 twin: --arm c0 on a vectorless tree must score: ${twin.stderr}`);
  process.stdout.write('  ✓ R2: `--arm c3` is refused; `--arm c0` is accepted\n');
}

// R3 — `--arm c1` against a vectorless index: refused, and refused BEFORE the run.
{
  const c1 = run([...ARGS, '--arm', 'c1'], env);
  assert.equal(c1.status, 2, 'R3: --arm c1 without vectors must be refused');
  assert.match(c1.stderr, /holds no vectors/, 'R3: the refusal must say the index carries none');
  assert.match(
    c1.stderr,
    /crib index \. --vectors/,
    'R3: the refusal must name the build command that would make it true',
  );
  // Non-vacuous: this is the PRE-FLIGHT wording. If the guard had been written post-run it would say
  // "the run measured", and the difference is the whole claim — no 61-task run is paid for.
  assert.doesNotMatch(
    c1.stderr,
    /the run measured/,
    'R3: the refusal must happen pre-flight, not after scoring',
  );
  process.stdout.write(
    '  ✓ R3: `--arm c1` without vectors is refused pre-flight, naming the fix\n',
  );
}

// R4 — an arm that cannot be read is not an arm to score under.
{
  const nowhere = join(tmpdir(), 'locate-arm-does-not-exist', 'crib.sqlite');
  const bad = run([...ARGS, '--db', nowhere], env);
  assert.equal(bad.status, 2, 'R4: an unreadable index must be refused');
  assert.match(bad.stderr, /cannot determine the retrieval arm/, 'R4: the refusal must say why');

  const twin = run([...ARGS, '--db', db], env);
  assert.equal(twin.status, 0, `R4 twin: an explicit readable --db must score: ${twin.stderr}`);
  process.stdout.write('  ✓ R4: an unreadable index is refused; an explicit readable one scores\n');
}

// R5 — the arm is VERIFIED against the run, not inferred from the index.
plantVectors(db);
{
  const hybridIndexNoTier = run([...ARGS, '--json'], env);
  assert.equal(
    hybridIndexNoTier.status,
    0,
    `R5: a vector-carrying index with no tier must still score: ${hybridIndexNoTier.stderr}`,
  );
  const report = JSON.parse(hybridIndexNoTier.stdout);
  assert.equal(
    report.index.carriesVectors,
    true,
    'R5: the fixture index must be seen as carrying vectors',
  );
  assert.equal(
    report.index.servedLexically,
    true,
    'R5: the CLI must be seen to have fallen back to lexical service',
  );
  assert.equal(
    report.arm,
    'c0-lexical-only',
    'R5: an index whose vectors cannot be queried yields a LEXICAL number, and must be labelled so',
  );
  assert.match(
    report.index.vectorNote,
    /carries .* vectors/,
    'R5: the report must carry the CLI-grade reason for the fallback',
  );

  const text = run(ARGS, env);
  assert.equal(text.status, 0, `R5 text twin: must score: ${text.stderr}`);
  assert.match(
    text.stdout,
    /⚠ the CLI reported it could not serve the vectors, so these numbers are lexical/,
    'R5: a lexical number under a vectorised index must be flagged in the human report too',
  );
  process.stdout.write(
    '  ✓ R5: a vector-carrying index whose tier is missing reports c0 + servedLexically, never c1\n',
  );
}

// R6 — the same tree, asked for c1: refused on what the RUN did, not on what the index held.
{
  const c1 = run([...ARGS, '--arm', 'c1'], env);
  assert.equal(c1.status, 2, 'R6: --arm c1 on a degraded tree must be refused');
  assert.match(
    c1.stderr,
    /the run measured c0-lexical-only/,
    'R6: the refusal must be decided post-run — the index DOES carry vectors, the run did not serve them',
  );
  assert.match(c1.stderr, /warning: this index carries code vectors/, 'R6: it must quote the CLI');
  process.stdout.write(
    '  ✓ R6: `--arm c1` on a degraded tree is refused with the run-measured reason\n',
  );
}

// R7 — the live arm, when this machine can actually serve vectors.
if (!existsSync(TIER)) {
  // Not leniency: with no tier the hybrid arm is unmeasurable here, and the contract for that case is
  // that the harness reports lexical + servedLexically rather than inventing a hybrid number — which
  // R5 has just asserted. The skip is a check on the contract, and it says so.
  const report = JSON.parse(run([...ARGS, '--json'], env).stdout);
  assert.equal(
    report.arm,
    'c0-lexical-only',
    'R7 skip-branch: with no tier installed the arm must be c0, never a hybrid it cannot measure',
  );
  process.stdout.write(
    `  – R7: SKIPPED — no embedding tier at ${TIER}; R5 covers the contract that applies instead\n`,
  );
} else {
  // R7 inherits the REAL environment: the tier lives in the user's embed home, and a fixture env with
  // that home removed would measure R5 a second time instead of the live arm.
  const live = run([...ARGS, '--json'], process.env);
  assert.equal(live.status, 0, `R7: the live hybrid arm must score: ${live.stderr}`);
  const report = JSON.parse(live.stdout);
  assert.equal(report.index.carriesVectors, true, 'R7: the index carries vectors');
  assert.equal(report.arm, 'c1-hybrid-rrf-rerank', 'R7: a served vector channel is the hybrid arm');
  assert.equal(
    report.index.servedLexically,
    false,
    'R7: nothing fell back, so nothing may claim it did',
  );

  const c0 = run([...ARGS, '--arm', 'c0'], process.env);
  assert.equal(c0.status, 2, 'R7: asking for c0 on a live hybrid tree must be refused');
  assert.match(c0.stderr, /the run measured c1-hybrid-rrf-rerank/, 'R7: the mirror refusal fires');
  process.stdout.write('  ✓ R7: the live arm is c1 and `--arm c0` is refused against it\n');
}

process.stdout.write('locate-eval: PASS\n');
