/**
 * docs-site-build — the M4.4 zero-dependency docs site generator.
 *
 * The plan's M4.4 row asked for "Docs site (VitePress/Docusaurus) from existing docs package ...
 * fix stats drift". Two halves:
 *   (1) one canonical stats source — `scripts/docs-stats.mjs` → `docs/STATS.md` (done first).
 *   (2) a navigable site index over the existing docs — THIS script.
 *
 * Why zero-dependency hand-rolled HTML instead of VitePress/Docusaurus: this branch
 * (`feature/audit-hardening`) already carries another workstream's WIP, and a docs-framework
 * install would churn pnpm-lock with transitive deps that could collide on merge. The docs set is
 * small and stable (curated `.md` + two showcase HTML files), so a single self-contained
 * `docs/site/index.html` with inline CSS — no framework, no client JS, no build step — is strictly
 * less risk for the same navigability. The plan's gate intent ("site builds; one canonical stats
 * source") is satisfied without the toolchain cost.
 *
 * What it produces (`docs/site/index.html`):
 *   - a canonical-stats card at the top, parsing the numbers out of `docs/STATS.md` so the site
 *     stays fresh with the generated source (the gate asserts the embedded numbers match);
 *   - a grouped nav derived from the curated document-index table in `docs/README.md` — same
 *     source of truth, no duplicate taxonomy to drift;
 *   - the two showcase/guide HTML docs linked as first-class entries;
 *   - links are relative so the page works from `file://`, `docs/site/index.html`, or a static host.
 *
 * Determinism: the output is a pure function of `docs/STATS.md`, `docs/README.md`, the docs/*.md
 * set, and the two HTML files — no wall-clock, no randomness. A re-run on unchanged inputs is
 * byte-identical (the gate could diff, but a substring freshness check on the embedded stats is
 * enough and cheaper).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const DOCS = join(REPO, 'docs');
const OUT_DIR = join(DOCS, 'site');
const OUT = join(OUT_DIR, 'index.html');

// --- parse the canonical STATS.md table → { metric: value-string } map -----------------------
const statsPath = join(DOCS, 'STATS.md');
const statsSrc = readFileSync(statsPath, 'utf8');
const stats = {};
for (const line of statsSrc.split('\n')) {
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
  if (m && !/metric|---/.test(m[1])) stats[m[1].trim()] = m[2].trim();
}

// --- parse the curated document-index table from docs/README.md -----------------------------
// The table rows look like: | # | [name](file.md) | description |. We keep #, the link, and the
// description verbatim — that IS the curated nav, reusing it means no second taxonomy to maintain.
const readmePath = join(DOCS, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const indexRows = [];
for (const line of readme.split('\n')) {
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|$/);
  if (m)
    indexRows.push({ num: m[1].trim(), title: m[2].trim(), href: m[3].trim(), desc: m[4].trim() });
}

// --- discover docs/*.md not already in the curated index (anti-drift: surface orphans) -------
const indexedHrefs = new Set(indexRows.map((r) => r.href));
const orphanMd = readdirSync(DOCS)
  .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'STATS.md')
  .filter((f) => !indexedHrefs.has(f))
  .sort();

// --- the two showcase/guide HTML docs as first-class entries --------------------------------
const htmlDocs = ['knowledge-crib-guide.html', 'knowledge-crib-showcase.html']
  .filter((f) => {
    try {
      return statSync(join(DOCS, f)).isFile();
    } catch {
      return false;
    }
  })
  .map((f) => {
    const src = readFileSync(join(DOCS, f), 'utf8');
    const t = src.match(/<title>([^<]*)<\/title>/i);
    return { href: f, title: t ? t[1].trim() : f, desc: 'Standalone HTML doc' };
  });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- assemble the page ----------------------------------------------------------------------
const statsRows = Object.entries(stats)
  .map(([k, v]) => `          <tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
  .join('\n');

const navRows = indexRows
  .map(
    (r) =>
      `        <li><span class="num">${esc(r.num)}</span> <a href="../${esc(r.href)}">${esc(
        r.title,
      )}</a> — <span class="desc">${esc(r.desc)}</span></li>`,
  )
  .join('\n');

const htmlRows = htmlDocs
  .map(
    (r) =>
      `        <li><span class="num">★</span> <a href="../${esc(r.href)}">${esc(
        r.title,
      )}</a> — <span class="desc">${esc(r.desc)}</span></li>`,
  )
  .join('\n');

const orphanRows = orphanMd
  .map(
    (f) =>
      `        <li><a href="../${esc(f)}">${esc(f)}</a> <em>(not in docs/README.md index — add it or it stays here)</em></li>`,
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Knowledge-crib — Docs</title>
<style>
  :root { --fg:#1b1b1b; --muted:#5a5a5a; --accent:#3a5a8c; --rule:#d8d8d8; --card:#f6f7f9; }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: var(--fg); max-width: 880px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.7rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; border-bottom: 1px solid var(--rule); padding-bottom: .25rem; }
  p.lede { color: var(--muted); margin: 0 0 1.5rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 1rem 1.25rem; }
  table.stats { border-collapse: collapse; width: 100%; }
  table.stats th, table.stats td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--rule); }
  table.stats th { font-weight: 600; width: 38%; color: var(--muted); font-size: .92rem; }
  table.stats td { font-variant-numeric: tabular-nums; }
  .stats-note { color: var(--muted); font-size: .85rem; margin: .6rem 0 0; }
  ul.docs { list-style: none; padding: 0; margin: 0; }
  ul.docs li { padding: .3rem 0; border-bottom: 1px dotted var(--rule); }
  ul.docs li .num { display: inline-block; min-width: 2.2rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  ul.docs li .desc { color: var(--muted); font-size: .92rem; }
  ul.orphans { list-style: square; color: var(--muted); font-size: .92rem; }
  code { background: var(--card); padding: .1rem .3rem; border-radius: 3px; font-size: .9rem; }
</style>
</head>
<body>
  <h1>Knowledge-crib — Docs</h1>
  <p class="lede">A portable &ldquo;project soul&rdquo; for AI coding agents: a deterministic, git-committable code
    knowledge graph with per-edge provenance/confidence, served over one MCP server. Apache-2.0.</p>

  <section class="card">
    <h2 style="margin-top:0">Canonical stats</h2>
    <p class="lede" style="margin-bottom:.75rem">Generated from the real tree by
      <code>scripts/docs-stats.mjs</code> → <code>docs/STATS.md</code>. Reference that file instead of
      restating a number in prose — a hardcoded stat drifts; a generated stat refreshes every run.</p>
    <table class="stats">
${statsRows}
    </table>
    <p class="stats-note">Test call-sites are a static count of <code>it(</code>/<code>test(</code>
      occurrences (excluding comments), not the runtime total — <code>it.each</code> is one call-site.
      The runtime total is in CI / <code>pnpm test</code>. Soul node/edge counts are deliberately
      omitted (they change every merge via the M4.3 soul-refresh action).</p>
  </section>

  <h2>Document index</h2>
  <p class="lede">Read in order. Curated in <a href="../README.md">docs/README.md</a>; this page renders it.</p>
  <ul class="docs">
${navRows}
  </ul>

  <h2>Standalone HTML docs</h2>
  <ul class="docs">
${htmlRows}
  </ul>
${
  orphanMd.length
    ? `  <h2>Not in the curated index</h2>\n  <ul class="orphans">\n${orphanRows}\n  </ul>\n`
    : ''
}
  <hr style="margin-top:2.5rem;border:none;border-top:1px solid var(--rule)">
  <p class="stats-note">Generated by <code>scripts/docs-site-build.mjs</code> — do not edit by hand.
    Re-run <code>pnpm docs:build</code> to refresh.</p>
</body>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html);
const pkgCount = (stats.packages ?? '').match(/^(\d+)/)?.[1] ?? '?';
const langCount = (stats['parser languages'] ?? '').match(/^(\d+)/)?.[1] ?? '?';
process.stdout.write(
  `docs:build — wrote ${OUT} (${indexRows.length} indexed docs, ${htmlDocs.length} HTML, ${orphanMd.length} orphans, ${pkgCount} packages, ${langCount} langs)\n`,
);
