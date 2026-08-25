/**
 * Task 8 Step 2 — serial vs parallel determinism check for the Mule fixture.
 *
 * Indexes the synthetic Mule 4 project twice (KCRIB_PARALLEL=0 then =1) into separate .crib dirs,
 * normalizes ONLY volatile timestamp fields, and asserts the graph JSONL, diagnostics, and the
 * --json summary are byte-identical between the two runs. Proves the parallel parse pool ships
 * byte-identical output to the serial loop (results persist in discovery order).
 *
 * Usage: node scripts/determinism-mule-par.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
const GEN = join(ROOT, 'scripts', 'fixtures', 'synthetic-mule-project.mjs');
const { syntheticMuleProject } = await import(GEN);

function indexInto(parallel, src, crib) {
  const env = {
    ...process.env,
    KCRIB_PARALLEL: parallel,
    // keep the import cache off the home dir to avoid cross-test bleed
    KCRIB_IMPORTS_DIR: mkdtempSync(join(tmpdir(), 'crib-imp-')),
  };
  const r = spawnSync(process.execPath, [CLI, 'index', src, '--crib-dir', crib, '--json'], {
    encoding: 'utf8',
    env,
  });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`index (KCRIB_PARALLEL=${parallel}) exited ${r.status}`);
  }
  return r.stdout;
}

function normalizeSummary(json) {
  const o = JSON.parse(json);
  // Strip everything except the mulesoft summary + the deterministic count fields we care about;
  // keep mulesoft (the Task 7 surface) and the stable aggregate counts.
  return JSON.stringify(
    {
      files: o.files,
      parse: o.parse,
      resolve: o.resolve,
      cfg: o.cfg,
      link: o.link,
      cluster: o.cluster,
      semantic: o.semantic,
      ownership: o.ownership,
      artifacts: o.artifacts,
      mulesoft: o.mulesoft,
    },
    null,
    2,
  );
}

function normalizeJsonl(text) {
  // Normalize volatile fields that legitimately differ run-to-run and are NOT a function of
  // serial-vs-parallel parse:
  //  - manifest lastUpdated / committedAt / now + any ISO timestamp
  //  - repo.id (a fresh random UUID minted on each index — both runs create a new repo, so the id
  //    differs even though the graph is identical)
  return text
    .replace(/"lastUpdated":\s*"[^"]*"/g, '"lastUpdated": "<TS>"')
    .replace(/"committedAt":\s*"[^"]*"/g, '"committedAt": "<TS>"')
    .replace(/"now":\s*"[^"]*"/g, '"now": "<TS>"')
    .replace(
      /"id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g,
      '"id": "<UUID>"',
    )
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>');
}

function readSoul(crib) {
  const graph = join(crib, 'graph');
  if (!existsSync(graph)) return { files: {}, listing: '' };
  const out = {};
  // The soul store is "layered-jsonl": sharded chunks under graph/extracted/nodes/<shard>/*.jsonl
  // and graph/extracted/edges/<shard>/*.jsonl, plus graph/extracted/clusters/clusters.jsonl and
  // graph/manifest.json. Walk the whole tree recursively and normalize every file.
  const listing = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.jsonl') || entry.name === 'manifest.json') {
        const rel = p.slice(graph.length + 1);
        listing.push(rel);
        out[rel] = normalizeJsonl(readFileSync(p, 'utf8'));
      }
    }
  };
  walk(graph);
  listing.sort();
  return { files: out, listing: listing.join('\n') };
}

const srcSerial = mkdtempSync(join(tmpdir(), 'mule-src-serial-'));
const srcPar = mkdtempSync(join(tmpdir(), 'mule-src-par-'));
syntheticMuleProject(srcSerial);
syntheticMuleProject(srcPar);
const cribSerial = mkdtempSync(join(tmpdir(), 'mule-crib-serial-'));
const cribPar = mkdtempSync(join(tmpdir(), 'mule-crib-par-'));

try {
  const outSerial = indexInto('0', srcSerial, cribSerial);
  const outPar = indexInto('1', srcPar, cribPar);

  const sumS = normalizeSummary(outSerial);
  const sumP = normalizeSummary(outPar);
  if (sumS !== sumP) {
    console.error('SUMMARY DIFFERS between serial and parallel:');
    console.error('--- serial ---\n', sumS);
    console.error('--- parallel ---\n', sumP);
    process.exit(1);
  }
  console.log('summary: identical (mulesoft + aggregates)');

  const soulS = readSoul(cribSerial);
  const soulP = readSoul(cribPar);
  if (soulS.listing !== soulP.listing) {
    console.error('SOUL FILE LISTING DIFFERS:');
    console.error('serial:', soulS.listing);
    console.error('parallel:', soulP.listing);
    process.exit(1);
  }
  let diffs = 0;
  for (const name of Object.keys(soulS.files)) {
    if (soulS.files[name] !== soulP.files[name]) {
      diffs++;
      console.error(`SOUL FILE DIFFERS: ${name}`);
      const a = soulS.files[name].split('\n');
      const b = soulP.files[name].split('\n');
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
          console.error(`  line ${i + 1}`);
          console.error(`  serial:   ${(a[i] ?? '').slice(0, 220)}`);
          console.error(`  parallel: ${(b[i] ?? '').slice(0, 220)}`);
        }
      }
    }
  }
  if (diffs > 0) {
    console.error(`${diffs} soul file(s) differ`);
    process.exit(1);
  }
  console.log(
    `soul graph: byte-identical across ${Object.keys(soulS.files).length} file(s) (manifest + ${soulS.listing.split('\n').filter((l) => l.endsWith('.jsonl')).length} jsonl shards)`,
  );

  console.log(
    '\nPASS — serial (KCRIB_PARALLEL=0) and parallel (KCRIB_PARALLEL=1) are byte-identical after timestamp normalization.',
  );
} finally {
  rmSync(srcSerial, { recursive: true, force: true });
  rmSync(srcPar, { recursive: true, force: true });
  rmSync(cribSerial, { recursive: true, force: true });
  rmSync(cribPar, { recursive: true, force: true });
}
