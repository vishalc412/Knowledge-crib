/**
 * dep-risk-check — the WP3 hygiene gate for known advisories in the dependency tree.
 *
 * Plan requirement (developer-trust-plan.md §WP3, bullet 6): "Extend existing dependency updates
 * with dependency-risk, license, secret, and release-artifact checks." This is the first of those
 * four; `credential-check.mjs` and `license-check.mjs` are its siblings.
 *
 * WHAT THIS IS: a reachability filter over `pnpm audit` advisories. It asks one question per
 * advisory — can a dependency WE SHIP pull it in? — and gates on the answer rather than on the raw
 * advisory count.
 *
 * WHY REACHABILITY IS THE POLICY, and not a severity threshold. `pnpm audit` audits the whole
 * workspace, including the test runner's own transitive tree (vitest → vite → postcss → nanoid),
 * which is never shipped to anyone. Gating a release on that set means every unrelated advisory
 * upstream publishes against vitest turns the release red, and the predictable result is a gate
 * everyone learns to bypass. So the split is by reachability:
 *   - An advisory reachable from a **runtime** dependency FAILS the gate, at any severity. This is
 *     the set that can be present in a user's install.
 *   - An advisory reachable only through **dev** dependencies is REPORTED — with its GHSA id and
 *     severity, in the plain-text output, not just the JSON — and does not gate. It is a backlog
 *     item, and it is visible in every release log rather than silently dropped.
 *
 * HOW REACHABILITY IS DECIDED. `pnpm audit` reports each finding as a chain of importers, e.g.
 * `. > vitest@3.2.7 > vite@6.4.3 > postcss@8.5.15 > nanoid@3.3.15`. The first hop after the importer
 * is always a DIRECT dependency of that importer, so it decides everything below it: if that first
 * hop is a dependency used only as a devDependency anywhere in the workspace, the whole chain is
 * dev-only. Names that appear as a runtime dependency of ANY package are excluded from the dev-only
 * set, so a package that is dev-only in one workspace and runtime in another is classified as
 * runtime — the classification errs strict, which is the safe direction.
 *
 * WHAT THIS IS NOT, stated here so the limit is a known one rather than a silent one:
 *   - It does not read the advisory database itself; it reads what `pnpm audit` fetched. An advisory
 *     published after the last audit is invisible until this runs again.
 *   - `pnpm audit` needs the registry. Offline, the command fails and the check reports
 *     **UNAVAILABLE** — a third outcome, distinct from pass and fail. By default UNAVAILABLE exits
 *     non-zero, because a release gate that goes green when it could not check is a false green.
 *     `--allow-unavailable` downgrades it to a loud warning for local runs; the release gate does
 *     not pass that flag.
 *   - Reachability is not exploitability. A runtime-reachable advisory fails here even where the
 *     vulnerable code path is not exercised by this project — that judgement is a human's, and the
 *     baseline is where it is recorded.
 *
 * BASELINE (scripts/dep-risk-baseline.json): entries keyed by GHSA id, each with a `reason`, for a
 * runtime-reachable advisory that has been reviewed and accepted. An entry that matches no current
 * advisory is itself a failure — the same ratchet as the other hygiene gates, so an acceptance
 * cannot outlive the advisory it accepted.
 *
 * Usage:  node scripts/dep-risk-check.mjs [--root <dir>] [--baseline <file>] [--audit <file>]
 *           [--deps <file>] [--json] [--allow-unavailable]
 *   --audit <file>  read a pre-fetched `pnpm audit --json` document instead of invoking pnpm. This
 *                   is what makes the policy testable against trees this repository does not have,
 *                   and it is the only way to test the offline path deterministically.
 *   --deps <file>   read a pre-fetched `pnpm list -r --json --depth 0` document instead of invoking
 *                   pnpm. Paired with --audit it makes the whole gate synthetic, so the reachability
 *                   rule can be tested against a dev-only and a runtime tree without installing
 *                   either.
 * Exit 0 = no un-accepted runtime-reachable advisory; 1 = at least one; 2 = could not check.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const REPO = resolve(flagValue('--root') ?? join(__dirname, '..'));
const JSON_OUT = argv.includes('--json');
const ALLOW_UNAVAILABLE = argv.includes('--allow-unavailable');
const BASELINE_PATH = resolve(
  flagValue('--baseline') ?? join(REPO, 'scripts', 'dep-risk-baseline.json'),
);
const AUDIT_FILE = flagValue('--audit');
const DEPS_FILE = flagValue('--deps');

const failures = [];
const fail = (detail) => failures.push(detail);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Tally one row per value of `keyOf`. Counted by mutation, not by rebuilding the accumulator. */
function tally(rows, keyOf) {
  const counts = {};
  for (const row of rows) {
    const key = keyOf(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ─── inputs ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The audit document. `pnpm audit` exits 1 when advisories EXIST, which is not a command failure, so
 * stdout is parsed regardless of the exit status and only a genuinely unparseable result counts as
 * unavailable.
 */
function readAudit() {
  if (AUDIT_FILE) {
    const source = `--audit ${relative(REPO, resolve(AUDIT_FILE))}`;
    // An injected document that does not parse is UNAVAILABLE, exactly like an unreachable registry:
    // both mean the check could not read its input, and neither is a verdict about the dependency tree.
    try {
      return { source, doc: readJson(AUDIT_FILE) };
    } catch (error) {
      return { source, doc: null, unavailable: true, detail: error?.message ?? 'unparseable' };
    }
  }
  const source = 'pnpm audit --json';
  try {
    const stdout = execFileSync('corepack', ['pnpm@9.15.0', 'audit', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      // corepack ships as a .cmd shim on Windows, which execFileSync cannot launch without a shell.
      shell: process.platform === 'win32',
    });
    return { source, doc: JSON.parse(stdout) };
  } catch (error) {
    // Exit 1 with a parseable document is the normal "advisories found" path, not an error.
    try {
      return { source, doc: JSON.parse(error?.stdout ?? '') };
    } catch {
      return { source, doc: null, unavailable: true, detail: error?.message ?? 'no output' };
    }
  }
}

/** Direct dependency names, split by whether any workspace package uses them at runtime. */
function readDependencySplit() {
  const source = DEPS_FILE
    ? `--deps ${relative(REPO, resolve(DEPS_FILE))}`
    : 'pnpm list -r --json --depth 0';
  let packages;
  try {
    if (DEPS_FILE) {
      packages = readJson(DEPS_FILE);
    } else {
      packages = JSON.parse(
        execFileSync('corepack', ['pnpm@9.15.0', 'list', '-r', '--json', '--depth', '0'], {
          cwd: REPO,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: process.platform === 'win32',
        }),
      );
    }
  } catch (error) {
    return {
      source,
      runtime: new Set(),
      dev: new Set(),
      devOnly: new Set(),
      unavailable: true,
      detail: error?.message,
    };
  }
  const runtime = new Set();
  const dev = new Set();
  for (const entry of packages) {
    for (const name of Object.keys(entry.dependencies ?? {})) runtime.add(name);
    for (const name of Object.keys(entry.devDependencies ?? {})) dev.add(name);
  }
  // A name used at runtime ANYWHERE is runtime; only names never used at runtime are dev-only.
  const devOnly = new Set([...dev].filter((name) => !runtime.has(name)));
  return { source, runtime, dev, devOnly };
}

const audit = readAudit();
const split = readDependencySplit();
let baselineEntries = [];
try {
  baselineEntries = readJson(BASELINE_PATH).entries ?? [];
} catch {
  baselineEntries = [];
}

/** Flatten advisories into one row each, with its reachability decided. Sorted for determinism. */
function classify(doc, dependencySplit) {
  const rows = [];
  for (const id of Object.keys(doc?.advisories ?? {})) {
    const advisory = doc.advisories[id];
    const paths = [...new Set((advisory.findings ?? []).flatMap((finding) => finding.paths ?? []))];
    const hops = new Set();
    let runtimePath = null;
    for (const path of paths) {
      const parts = path.split(' > ');
      const firstHop = parts.length > 1 ? parts[1] : null;
      if (!firstHop) continue;
      const name = firstHop.replace(/@[^@]*$/, '');
      hops.add(name);
      // Strict: unknown names are NOT dev-only. A hop the split does not know about is treated as
      // runtime, so an unrecognised chain fails loudly rather than passing as if it were a test tool.
      if (!dependencySplit.devOnly.has(name)) runtimePath ??= path;
    }
    rows.push({
      ghsa: advisory.github_advisory_id ?? `pnpm:${id}`,
      module: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      vulnerable: advisory.vulnerable_versions,
      patched: advisory.patched_versions,
      firstHops: [...hops].sort(),
      reachability: runtimePath ? 'runtime' : paths.length ? 'dev-only' : 'unknown',
      runtimePath,
      versions: [...new Set((advisory.findings ?? []).map((f) => f.version))].sort(),
    });
  }
  return rows.sort((a, b) => a.ghsa.localeCompare(b.ghsa));
}

// ─── verdict ─────────────────────────────────────────────────────────────────────────────────────

if (audit.unavailable || split.unavailable) {
  const which = [audit.unavailable ? audit.source : null, split.unavailable ? split.source : null]
    .filter(Boolean)
    .join(' and ');
  const detail = audit.detail ?? split.detail ?? '';
  process.stdout.write(
    `dep-risk-check: UNAVAILABLE — ${which} could not be read (${detail}). ` +
      `${ALLOW_UNAVAILABLE ? 'Downgraded by --allow-unavailable.' : 'This is a failure: a release gate that goes green without checking is a false green.'}\n`,
  );
  process.exitCode = ALLOW_UNAVAILABLE ? 0 : 2;
} else {
  const rows = classify(audit.doc, split);
  const matchedEntries = new Set();
  const bySeverity = tally(rows, (r) => r.severity);
  const byReachability = tally(rows, (r) => r.reachability);

  for (const row of rows) {
    if (row.reachability !== 'runtime') continue;
    const entry = baselineEntries.find((e) => e.ghsa === row.ghsa);
    if (entry) {
      matchedEntries.add(entry);
      row.accepted = true;
      row.reason = entry.reason;
      continue;
    }
    fail(
      `[${row.severity}] ${row.ghsa} — ${row.module} ${row.vulnerable} (patched ${row.patched}): ${row.title}\n      reachable from a RUNTIME dependency via ${row.runtimePath}`,
    );
  }
  for (const entry of baselineEntries) {
    if (!matchedEntries.has(entry)) {
      fail(
        `stale baseline entry (${entry.ghsa}) matches no current advisory — remove it from scripts/dep-risk-baseline.json, or restore the dependency it accepted`,
      );
    }
  }

  const devOnly = rows.filter((r) => r.reachability === 'dev-only');
  const report = {
    root: REPO,
    source: audit.source,
    dependencySplitSource: split.source,
    baseline: relative(REPO, BASELINE_PATH),
    auditedDependencies: audit.doc?.metadata?.vulnerabilities
      ? audit.doc.metadata.totalDependencies
      : null,
    advisories: rows.length,
    bySeverity,
    byReachability,
    devOnly: devOnly.map((r) => ({
      ghsa: r.ghsa,
      module: r.module,
      severity: r.severity,
      versions: r.versions,
    })),
    baselineEntriesMatched: matchedEntries.size,
    baselineEntries: baselineEntries.length,
    failures,
  };

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  } else {
    const line = (label, value) => process.stdout.write(`  ${label.padEnd(34)} ${value}\n`);
    process.stdout.write('dep-risk-check\n');
    line('advisories via', audit.source);
    line('dependencies audited', report.auditedDependencies ?? '(not reported)');
    line('advisories', rows.length);
    line(
      'by severity (crit/high/mod/low)',
      `${bySeverity.critical ?? 0} / ${bySeverity.high ?? 0} / ${bySeverity.moderate ?? 0} / ${bySeverity.low ?? 0}`,
    );
    line(
      'by reachability (runtime/dev-only/unknown)',
      `${byReachability.runtime ?? 0} / ${byReachability['dev-only'] ?? 0} / ${byReachability.unknown ?? 0}`,
    );
    line('baseline entries matched', `${matchedEntries.size} / ${baselineEntries.length}`);
    if (devOnly.length) {
      process.stdout.write(
        '\n  dev-only advisories — REPORTED, not gated (they cannot reach a released artifact):\n',
      );
      for (const row of devOnly) {
        process.stdout.write(
          `    [${row.severity}] ${row.ghsa} — ${row.module} ${row.versions.join(', ')}\n`,
        );
      }
    }
    if (failures.length) {
      process.stdout.write(`\nFAIL — ${failures.length} issue(s):\n`);
      for (const detail of failures) process.stdout.write(`  ${detail}\n`);
    } else {
      process.stdout.write(
        `\nPASS — no advisory reachable from a runtime dependency (${byReachability['dev-only'] ?? 0} dev-only advisory(s) reported above)\n`,
      );
    }
  }

  process.exitCode = failures.length ? 1 : 0;
}
