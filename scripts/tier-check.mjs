/**
 * tier-check — the M2.7 model-tier-hints gate.
 *
 * Pins the plan's M2.7 gate intent: "enrich_next items carry tier; skill documents cost."
 *
 * `enrich_next` now stamps every work item with `suggestedTier` ∈ `{fast, balanced, powerful}` — a
 * deterministic recommendation for which model tier a host should author that artifact with — and
 * mirrors it on `costEstimate.perItem[i].tier` so a dispatcher can route from either surface. The crib
 * never calls a model; the tier is a contract the host reads. Routing by it is the single biggest
 * cost lever on the enrichment queue (symbols are the bulk by count; the bible is rare).
 *
 * This gate drives the real `Verbs.enrichNext` surface over a built soul and asserts:
 *   (1) Items carry `suggestedTier` — a string in the allowed set, on every item the batch returns.
 *   (2) Mapping by layer — symbol-layer items are `fast`; the skeleton system pass is `balanced`.
 *   (3) `costEstimate.perItem` carries `tier` matching each item's `suggestedTier`.
 *   (4) The crib-enrich SKILL.md documents the cost model (tier table + multiplier + the $/pass formula),
 *       so the contract the host reads is the one the code emits.
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * core + mcp dist resolve.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const NOW = '2026-01-01T00:00:00.000Z';

const core = await import(resolve(REPO, 'packages', 'core', 'dist', 'index.js'));
const soulSchema = await import(resolve(REPO, 'packages', 'soul-schema', 'dist', 'index.js'));
const mcp = await import(resolve(REPO, 'packages', 'mcp', 'dist', 'index.js'));
const { SoulStore, SqliteIndexStore, newManifest } = core;
const { idFor, contentHash } = soulSchema;
const { Verbs } = mcp;

const ALLOWED_TIERS = new Set(['fast', 'balanced', 'powerful']);

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  tier:check FAIL — ${msg}\n`);
  failed++;
};

/** Build a soul with three symbols so the symbol enrich layer has pending targets to return. */
const buildSoul = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-tier-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'loan.ts'),
    [
      'function assess(amount: number, score: number): string {',
      '  const risk = amount * 0.4 + score * 0.6;',
      '  return risk > 700 ? "decline" : "approve";',
      '}',
      'function helper(n: number): number { return Math.round(n * 100) / 100; }',
      'function handle(req: unknown): string { return assess(50000, 600); }',
      '',
    ].join('\n'),
  );
  const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();

  const mk = (name, start, end) => ({
    id: idFor({ kind: 'symbol', path: 'src/loan.ts', qualifiedName: name, startLine: start }),
    kind: 'symbol',
    type: 'function',
    name,
    qualifiedName: name,
    file: 'src/loan.ts',
    span: { start, end },
    lang: 'typescript',
    hash: contentHash(name),
  });
  const assess = mk('assess', 1, 4);
  const helper = mk('helper', 5, 6);
  const handle = mk('handle', 7, 8);
  soul.putNodes([assess, helper, handle]);
  soul.commit(NOW);
  const index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  return { repo, soul, index };
};

try {
  const base = buildSoul();
  try {
    const v = new Verbs({ soul: base.soul, index: base.index, repoRoot: base.repo });

    // (1) + (2) + (3) symbol layer — items are `fast`.
    const symbolBatch = v.enrichNext({ layer: 'symbol', limit: 10 });
    const sItems = symbolBatch.items;
    if (!Array.isArray(sItems) || sItems.length === 0) {
      fail(`symbol layer returned no items (items=${JSON.stringify(sItems)?.slice(0, 120)})`);
    } else {
      let allFast = true;
      for (const it of sItems) {
        if (typeof it.suggestedTier !== 'string' || !ALLOWED_TIERS.has(it.suggestedTier)) {
          fail(`symbol item ${it.targetId} has invalid suggestedTier=${String(it.suggestedTier)}`);
          allFast = false;
        } else if (it.suggestedTier !== 'fast') {
          fail(`symbol item ${it.targetId} expected tier 'fast', got '${it.suggestedTier}'`);
          allFast = false;
        }
      }
      if (allFast) {
        process.stdout.write(
          `  tier:check — symbol layer: ${sItems.length} item(s) all carry suggestedTier='fast'\n`,
        );
      }
      // (3) costEstimate.perItem mirrors tier.
      const perItem = symbolBatch.costEstimate?.perItem;
      if (!Array.isArray(perItem) || perItem.length !== sItems.length) {
        fail(
          `symbol costEstimate.perItem missing or length mismatch (got ${perItem?.length}, want ${sItems.length})`,
        );
      } else {
        let mirrorOk = true;
        for (let i = 0; i < sItems.length; i++) {
          const p = perItem[i];
          if (typeof p?.tier !== 'string' || !ALLOWED_TIERS.has(p.tier)) {
            fail(`perItem[${i}] invalid tier=${String(p?.tier)}`);
            mirrorOk = false;
          } else if (p.tier !== sItems[i].suggestedTier) {
            fail(
              `perItem[${i}].tier='${p.tier}' != item.suggestedTier='${sItems[i].suggestedTier}'`,
            );
            mirrorOk = false;
          } else if (p.targetId !== sItems[i].targetId) {
            fail(`perItem[${i}].targetId='${p.targetId}' != item.targetId='${sItems[i].targetId}'`);
            mirrorOk = false;
          }
        }
        if (mirrorOk) {
          process.stdout.write(
            `  tier:check — symbol costEstimate.perItem: tier mirrors suggestedTier on all ${sItems.length} item(s)\n`,
          );
        }
      }
    }

    // (2) skeleton system pass — `balanced`.
    const skeletonBatch = v.enrichNext({ layer: 'system', skeleton: true });
    const skItems = skeletonBatch.items;
    if (!Array.isArray(skItems) || skItems.length !== 1) {
      fail(`skeleton system pass expected 1 item, got ${skItems?.length}`);
    } else {
      const t = skItems[0].suggestedTier;
      if (t !== 'balanced') {
        fail(`skeleton system item expected tier 'balanced', got '${String(t)}'`);
      } else {
        process.stdout.write(
          `  tier:check — skeleton system pass: item carries suggestedTier='balanced'\n`,
        );
      }
      const skPer = skeletonBatch.costEstimate?.perItem;
      if (!Array.isArray(skPer) || skPer.length !== 1 || skPer[0]?.tier !== 'balanced') {
        fail(`skeleton costEstimate.perItem[0].tier expected 'balanced', got ${skPer?.[0]?.tier}`);
      }
    }

    // (4) SKILL.md documents the cost model — the contract the host reads.
    const skillPath = resolve(REPO, 'packages', 'cli', 'skills', 'crib-enrich', 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf8');
    const markers = [
      /suggestedTier/,
      /Model-tier hints/i,
      /symbol.*fast/i,
      /balanced/,
      /powerful/,
      /TIER_COST_MULTIPLIER|tierMultiplier|tier multiplier/i,
      /\$pass|Σ_items|per enrichment pass/i,
    ];
    const missing = markers.filter((re) => !re.test(skill));
    if (missing.length > 0) {
      fail(`SKILL.md missing cost-model markers: ${missing.map((r) => r.source).join(', ')}`);
    } else {
      process.stdout.write(
        '  tier:check — SKILL.md documents tier table + multiplier + $/pass formula\n',
      );
    }
  } finally {
    rmSync(base.repo, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  tier:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\ntier:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\ntier:check — all assertions passed\n');
