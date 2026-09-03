/**
 * ifhash-check — the M2.6 change-aware cache gate.
 *
 * Pins the plan's M2.6 gate intent: "repeat agent session token cost measurably drops."
 *
 * `context`/`dossier`/`source` results land in the agent's INPUT context window as tool results —
 * re-sending an unchanged 50 KB dossier on every repeat call burns input tokens for nothing. The
 * stateless ifHash cache lets the client echo the `hash` a prior call returned; when the rebuilt
 * response is byte-identical, the body collapses to `{ unchanged: true, hash }`.
 *
 * This gate measures the actual drop: serializes the full response and the cached stub, and asserts
 * the stub is a small fraction of the full body (the "measurably drops" evidence), across all three
 * verbs (context with a body + edges, source, dossier).
 *
 * Asserts:
 *   (1) Collapse — a repeat call with the matching `ifHash` returns `{ unchanged: true, hash }` with
 *       NO body, for context / source / dossier.
 *   (2) Drop — the cached stub's serialized size is < 10% of the full response (a ≥ 10× reduction)
 *       AND the saved bytes are non-trivial (> 100), so the gate cannot pass on a near-empty body.
 *   (3) Determinism — two independent full calls produce identical hashes (stateless, no time/random).
 *   (4) No false unchanged — a stale `ifHash` returns the full body, not `{ unchanged: true }`.
 *   (5) Memory ops — a FRESH `memorySearch` (evaluator wired) and `memoryRecall` run the same
 *       collapse / determinism / no-false-unchanged assertions over a real team store: a wall
 *       clock anywhere in the memory response (the `evaluatedAt` regression) would break all
 *       three permanently. The size-drop assertion is skipped for these (small bodies).
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * core + mcp dist resolve.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { SoulStore, SqliteIndexStore, newManifest } = core;
const { idFor, contentHash, edgeId } = soulSchema;
const { Verbs } = mcp;

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  ifhash:check FAIL — ${msg}\n`);
  failed++;
};

const size = (obj) => JSON.stringify(obj).length;

/** Build a soul with a real source file + caller/callee edges so context/source carry a non-trivial
 * body. assess calls helper; handle calls assess → context surfaces callers + callees + a body. The
 * assess body is deliberately long (a multi-line risk computation) so the rehydrated source is ~3 KB
 * — the realistic migration-analyst case the "measurably drops" gate is about (a 99-byte stub vs a
 * multi-KB body, not a 99-byte stub vs a 400-byte skeleton). */
const buildSoul = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-ifhash-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  const assessLines = [
    'function assess(amount: number, score: number): string {',
    '  // Compute a weighted risk score from the loan amount and the applicant credit score.',
    '  const base = amount * 0.4 + score * 0.6;',
    '  let adjustment = 0;',
    '  if (amount > 50000) adjustment += (amount - 50000) * 0.0001;',
    '  if (score < 700) adjustment += (700 - score) * 0.05;',
    '  if (score < 580) adjustment += (580 - score) * 0.12;',
    '  const risk = base + adjustment;',
    '  const tier = risk > 700 ? "decline" : risk > 500 ? "review" : "approve";',
    '  const stamped = helper(risk);',
    '  const note = [tier, "score=" + stamped, "amount=" + amount, "credit=" + score].join("; ");',
    '  // Persist the decision trail for audit; the regulator wants every factor on the record.',
    '  const trail = { base, adjustment, risk, tier, stamped, note };',
    '  if (tier === "decline") return "DECLINED: " + note;',
    '  if (tier === "review") return "REVIEW: " + note;',
    '  return "APPROVED: " + note;',
    '}',
    'function helper(n: number): number {',
    '  return Math.round(n * 100) / 100;',
    '}',
    'function handle(req: unknown): string {',
    '  return assess(50000, 600);',
    '}',
    '',
  ];
  writeFileSync(join(repo, 'src', 'loan.ts'), assessLines.join('\n'));
  const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();

  const assess = {
    id: idFor({ kind: 'symbol', path: 'src/loan.ts', qualifiedName: 'assess', startLine: 1 }),
    kind: 'symbol',
    type: 'function',
    name: 'assess',
    qualifiedName: 'assess',
    file: 'src/loan.ts',
    span: { start: 1, end: 16 },
    lang: 'typescript',
    hash: contentHash('assess'),
  };
  const helper = {
    id: idFor({ kind: 'symbol', path: 'src/loan.ts', qualifiedName: 'helper', startLine: 17 }),
    kind: 'symbol',
    type: 'function',
    name: 'helper',
    qualifiedName: 'helper',
    file: 'src/loan.ts',
    span: { start: 17, end: 18 },
    lang: 'typescript',
    hash: contentHash('helper'),
  };
  const handle = {
    id: idFor({ kind: 'symbol', path: 'src/loan.ts', qualifiedName: 'handle', startLine: 19 }),
    kind: 'symbol',
    type: 'function',
    name: 'handle',
    qualifiedName: 'handle',
    file: 'src/loan.ts',
    span: { start: 19, end: 21 },
    lang: 'typescript',
    hash: contentHash('handle'),
  };
  soul.putNodes([assess, helper, handle]);
  soul.putEdges([
    {
      id: edgeId({ src: assess.id, dst: helper.id, rel: 'calls' }),
      src: assess.id,
      dst: helper.id,
      rel: 'calls',
      method: 'static',
      confidence: 1,
      provenance: 'EXTRACTED',
    },
    {
      id: edgeId({ src: handle.id, dst: assess.id, rel: 'calls' }),
      src: handle.id,
      dst: assess.id,
      rel: 'calls',
      method: 'static',
      confidence: 1,
      provenance: 'EXTRACTED',
    },
  ]);
  soul.commit(NOW);
  const index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  return { repo, soul, index, assessId: assess.id };
};

try {
  const base = buildSoul();
  try {
    const v = new Verbs({ soul: base.soul, index: base.index, repoRoot: base.repo });
    const id = base.assessId;

    const cases = [
      {
        name: 'context (withSource)',
        full: () => v.context({ id, withSource: true }),
        cached: (hash) => v.context({ id, withSource: true, ifHash: hash }),
      },
      {
        name: 'source',
        full: () => v.source({ id }),
        cached: (hash) => v.source({ id, ifHash: hash }),
      },
      {
        name: 'dossier',
        full: () => v.dossier({ id }),
        cached: (hash) => v.dossier({ id, ifHash: hash }),
      },
    ];

    for (const c of cases) {
      const first = c.full();
      const hash = first.hash;
      if (typeof hash !== 'string' || !/^blake3:[0-9a-f]{64}$/.test(hash)) {
        fail(`${c.name}: first call did not return a blake3 hash (got ${hash})`);
        continue;
      }
      const cached = c.cached(hash);

      // (1) Collapse — unchanged:true, no body.
      if (cached.unchanged !== true || cached.hash !== hash) {
        fail(`${c.name}: cached call did not collapse to { unchanged:true, hash }`);
      } else {
        process.stdout.write(
          `  ifhash:check — ${c.name}: repeat call collapsed to { unchanged:true, hash }\n`,
        );
      }
      // the body must be gone
      if (
        cached.node !== undefined ||
        cached.source !== undefined ||
        cached.callers !== undefined
      ) {
        fail(`${c.name}: cached stub still carries body fields`);
      }

      // (2) Drop — stub is < 10% of full (a ≥ 10× reduction) AND saved bytes are non-trivial (> 100),
      // so the gate cannot pass on an empty/near-empty response. 10× is the "measurably drops" floor:
      // a 99-byte stand-in for a multi-KB body is the dramatic drop the M2.6 gate is about.
      const fullBytes = size(first);
      const cachedBytes = size(cached);
      const ratio = cachedBytes / fullBytes;
      const saved = fullBytes - cachedBytes;
      if (ratio >= 0.1) {
        fail(
          `${c.name}: stub not a measurable drop — ${cachedBytes}/${fullBytes} = ${(ratio * 100).toFixed(1)}% (need < 10%)`,
        );
      } else if (saved < 100) {
        fail(
          `${c.name}: saved bytes trivial (${saved}) — gate cannot pass on a near-empty response`,
        );
      } else {
        process.stdout.write(
          `  ifhash:check — ${c.name}: ${fullBytes} → ${cachedBytes} bytes (${saved} saved, ${(ratio * 100).toFixed(2)}% of full)\n`,
        );
      }

      // (3) Determinism — two independent full calls → identical hash.
      const again = c.full();
      if (again.hash !== hash) {
        fail(`${c.name}: nondeterministic hash across two full calls`);
      }

      // (4) No false unchanged — a stale ifHash returns the full body.
      const stale = c.cached('blake3:deadbeef');
      if (stale.unchanged === true) {
        fail(`${c.name}: stale ifHash wrongly collapsed to unchanged:true`);
      } else if (stale.hash !== hash) {
        fail(`${c.name}: stale-ifHash response hash diverged from a clean rebuild`);
      } else {
        process.stdout.write(
          `  ifhash:check — ${c.name}: stale ifHash returns full body (no false unchanged)\n`,
        );
      }
    }

    // ─── memory ops — the adversarial-verify regression pin ─────────────────────
    // "All memory verbs honour ifHash" (docs) only holds if the response carries NO wall clock.
    // A FRESH search (evaluator + evalCtx wired) is the exact path that used to stamp
    // `evaluatedAt: now()` into provenance + every hit's freshness — making the hash differ on
    // every call so the cache could NEVER collapse. These cases pin that: the search must be
    // fresh AND hash-stable across independent calls.
    const memory = await import(
      pathToFileURL(resolve(REPO, 'packages', 'memory', 'dist', 'index.js')).href
    );
    const memHome = mkdtempSync(join(tmpdir(), 'crib-ifhash-mem-'));
    const memReg = mkdtempSync(join(tmpdir(), 'crib-ifhash-reg-'));
    try {
      const memEnv = { ...process.env, KCRIB_MEMORY_DIR: memHome, KCRIB_REGISTRY_DIR: memReg };
      const cribDir = join(base.repo, '.crib');
      writeFileSync(join(cribDir, 'crib.json'), JSON.stringify({ repo: { id: 'r-ifhash' } }));
      const team = memory.MemoryStore.team(cribDir, { env: memEnv, now: () => NOW });
      const subject = base.assessId;
      const quote = 'const base = amount * 0.4 + score * 0.6;';
      const input = {
        kind: 'fact',
        subject,
        claim: 'assess computes the base risk from amount and score',
        scope: { boundary: 'repo', repoId: 'r-ifhash' },
        appliesTo: [subject],
        evidence: [
          {
            kind: 'source-quote',
            verdict: 'valid',
            checkedAt: NOW,
            soulId: subject,
            quote,
            targetHash: `blake3:${'a'.repeat(64)}`,
          },
        ],
        authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
      };
      team.upsertEntry('records', {
        id: memory.memoryRecordId(input),
        schemaVersion: '1',
        ...input,
        verdicts: {
          trust: 'team',
          evidence: 'valid',
          applicability: 'current',
          lifecycle: 'active',
        },
        createdAt: NOW,
      });
      const evaluator = new memory.MemoryEvaluator();
      const evalCtx = { soul: new memory.SoulStoreSoulPort(base.soul, base.repo) };
      const memVerbs = new Verbs({
        soul: base.soul,
        index: base.index,
        repoRoot: base.repo,
        memory: { team, evaluator, evalCtx },
      });

      const memCases = [
        {
          name: 'memory search (FRESH — the wall-clock regression path)',
          bodyless: ['hits'],
          fresh: (res) => res.provenance?.fresh === true,
          full: () => memVerbs.memorySearch({ q: 'assess' }),
          cached: (hash) => memVerbs.memorySearch({ q: 'assess', ifHash: hash }),
        },
        {
          name: 'memory recall',
          bodyless: ['memories'],
          fresh: () => true,
          full: () => memVerbs.memoryRecall({ q: 'assess' }),
          cached: (hash) => memVerbs.memoryRecall({ q: 'assess', ifHash: hash }),
        },
      ];

      for (const c of memCases) {
        const first = c.full();
        if (c.fresh(first) !== true) {
          fail(`${c.name}: expected the fresh path (the regression path), got otherwise`);
        }
        const hash = first.hash;
        if (typeof hash !== 'string' || !/^blake3:[0-9a-f]{64}$/.test(hash)) {
          fail(`${c.name}: first call did not return a blake3 hash (got ${hash})`);
          continue;
        }
        const cached = c.cached(hash);
        // (1) Collapse — unchanged:true, no body.
        if (cached.unchanged !== true || cached.hash !== hash) {
          fail(`${c.name}: cached call did not collapse to { unchanged:true, hash }`);
        } else {
          process.stdout.write(
            `  ifhash:check — ${c.name}: repeat call collapsed to { unchanged:true, hash }\n`,
          );
        }
        for (const field of c.bodyless) {
          if (cached[field] !== undefined) {
            fail(`${c.name}: cached stub still carries the body field '${field}'`);
          }
        }
        // NOTE: the size-drop assertion is intentionally NOT applied to the memory cases — the
        // record bodies here are small, so the byte ratio is not the signal; the COLLAPSE and
        // the DETERMINISM of a FRESH response are (a wall clock would break both permanently).
        // (3) Determinism — two independent full calls → identical hash, fresh or not.
        const again = c.full();
        if (again.hash !== hash) {
          fail(`${c.name}: nondeterministic hash across two full calls (wall clock leaked?)`);
        } else {
          process.stdout.write(
            `  ifhash:check — ${c.name}: two independent calls hash identical (deterministic)\n`,
          );
        }
        // (4) No false unchanged — a stale ifHash returns the full body.
        const stale = c.cached('blake3:deadbeef');
        if (stale.unchanged === true) {
          fail(`${c.name}: stale ifHash wrongly collapsed to unchanged:true`);
        } else if (stale.hash !== hash) {
          fail(`${c.name}: stale-ifHash response hash diverged from a clean rebuild`);
        } else {
          process.stdout.write(
            `  ifhash:check — ${c.name}: stale ifHash returns full body (no false unchanged)\n`,
          );
        }
      }
    } finally {
      rmSync(memHome, { recursive: true, force: true });
      rmSync(memReg, { recursive: true, force: true });
    }
  } finally {
    rmSync(base.repo, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  ifhash:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nifhash:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nifhash:check — all assertions passed\n');
