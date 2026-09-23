/**
 * license-check — the WP3 hygiene gate for the license terms of every installed dependency.
 *
 * Plan requirement (developer-trust-plan.md §WP3, bullet 6): "Extend existing dependency updates
 * with dependency-risk, license, secret, and release-artifact checks." This is the second of those
 * four; `credential-check.mjs` and `dep-risk-check.mjs` are its siblings.
 *
 * WHAT THIS IS: a policy check over the LICENSE EXPRESSIONS of the installed dependency tree. It
 * reads `pnpm licenses list --json`, which is served from the local store — no network, no registry,
 * same answer twice in a row.
 *
 * WHAT THIS IS NOT, stated here so the limit is a known one rather than a silent one:
 *   - It does not read LICENSE FILES or source headers. It trusts the `license` field the package
 *     publishes in its own manifest, which is the field a scanner is supposed to read and is also,
 *     occasionally, wrong or stale upstream. Reading the files would be a different and much slower
 *     check, and it is not this one.
 *   - `allowed` here means "the expression names only terms on the permissive list", not "a lawyer
 *     reviewed this". The list is a deliberate, conservative default; anything outside it needs a
 *     human entry in the allowlist, and that entry is the record of the human having looked.
 *   - It does not see a dependency that is declared but not installed, and it does not walk the
 *     lockfile's full transitive graph beyond what pnpm reports as installed.
 *
 * EXPRESSION HANDLING. A license field is a boolean expression, not a word: `MIT OR Apache-2.0`
 * lets the consumer CHOOSE a disjunct, while `A AND B` requires every conjunct. Treating the string
 * as one opaque label gets both of those wrong in opposite directions — it would fail a package that
 * offers MIT as an alternative, and pass a package that requires a copyleft term alongside a
 * permissive one. So the expression is parsed and evaluated with those operators.
 *
 * `WITH` (an exception clause, e.g. `GPL-2.0-only WITH Classpath-exception-2.0`) is NOT evaluated:
 * an exception changes the terms in ways this evaluator cannot model, so it is reported as
 * `unmodelled` and must be allowlisted by a human. Treating it as its base license would pass a
 * file that says `WITH` and read as if the exception had been considered. It has not.
 *
 * ALLOWLIST (scripts/license-allowlist.json): every entry needs a `reason`, and an entry that
 * matches nothing is itself a failure — the same ratchet as scripts/credential-scan-allowlist.json.
 *
 * VACUITY GUARD. An inventory of zero packages PASSES trivially, and it is the shape a broken
 * invocation takes: wrong working directory, an uninstalled tree, a renamed flag. So a zero-package
 * inventory is a FAILURE, not a pass, and the count is printed either way.
 *
 * Usage:  node scripts/license-check.mjs [--root <dir>] [--allowlist <file>] [--licenses <file>] [--json]
 *   --licenses <file>  read a pre-fetched `pnpm licenses list --json` document instead of invoking
 *                      pnpm. This is what makes the policy testable against licenses the installed
 *                      tree does not contain (GPL, unknown, unparseable) without installing them.
 * Exit 0 = every installed package's expression is allowed or allowlisted; 1 = at least one is not.
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
const ALLOWLIST_PATH = resolve(
  flagValue('--allowlist') ?? join(REPO, 'scripts', 'license-allowlist.json'),
);
const LICENSES_FILE = flagValue('--licenses');

/**
 * Permissive terms this project accepts without further review. Kept deliberately SHORT and
 * conservative: a term outside this set is not necessarily forbidden, it is unreviewed, and
 * unreviewed is what the allowlist exists to make explicit.
 */
const ALLOWED_IDENTIFIERS = new Set([
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'X11',
  'Zlib',
]);

const failures = [];
const fail = (detail) => failures.push(detail);

/** Tally one row per value of `keyOf`. Counted by mutation, not by rebuilding the accumulator. */
function tally(rows, keyOf) {
  const counts = {};
  for (const row of rows) {
    const key = keyOf(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ─── the expression evaluator ────────────────────────────────────────────────────────────────────
//
// Grammar:  expr := term (('OR'|'AND') term)* ;  term := '(' expr ')' | IDENT ('WITH' IDENT)?
// Precedence in SPDX is AND over OR; for the yes/no question this gate asks, the two differ only in
// which verdict a mixed expression gets, and being wrong there in the permissive direction is the
// dangerous one. So AND is grouped first, matching SPDX, and the parse is right-to-left associative
// as specified. A parse failure is reported, never guessed at.

/** Split an identifier-bearing expression into tokens, preserving parentheses. */
function tokenize(text) {
  return text.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
}

/**
 * Evaluate one expression against the allowed set.
 * Returns { verdict: 'allowed'|'denied'|'unmodelled'|'unparseable', identifiers, detail }.
 */
function evaluateExpression(text) {
  const tokens = tokenize(String(text ?? '').trim());
  if (tokens.length === 0) {
    return { verdict: 'unparseable', identifiers: [], detail: 'empty license field' };
  }
  const identifiers = [];
  const upper = (token) => token.toUpperCase();
  let pos = 0;
  let sawWith = false;
  let parseError = null;

  // Recursive descent over the token list. Both levels return a boolean; `sawWith` is carried out
  // separately so a `WITH` anywhere in the expression downgrades the whole verdict to `unmodelled`.
  function parseOr() {
    let value = parseAnd();
    while (pos < tokens.length && upper(tokens[pos]) === 'OR') {
      pos++;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }
  function parseAnd() {
    let value = parseTerm();
    while (pos < tokens.length && upper(tokens[pos]) === 'AND') {
      pos++;
      const right = parseTerm();
      value = value && right;
    }
    return value;
  }
  function parseTerm() {
    const token = tokens[pos];
    if (token === '(') {
      pos++;
      const value = parseOr();
      if (tokens[pos] !== ')') throw new Error('unbalanced parenthesis');
      pos++;
      return value;
    }
    if (token === ')' || token === undefined) throw new Error('unexpected end of expression');
    pos++;
    identifiers.push(token);
    if (pos < tokens.length && upper(tokens[pos]) === 'WITH') {
      pos++;
      if (tokens[pos] === undefined) throw new Error('WITH with no exception');
      sawWith = true;
      pos++;
      return true; // neutral; the verdict below is `unmodelled` regardless
    }
    return ALLOWED_IDENTIFIERS.has(token);
  }

  let allowed;
  try {
    allowed = parseOr();
    if (pos !== tokens.length) throw new Error(`trailing tokens from ${tokens[pos]}`);
  } catch (error) {
    parseError = error.message;
  }
  if (parseError) return { verdict: 'unparseable', identifiers, detail: parseError };
  if (sawWith) {
    return {
      verdict: 'unmodelled',
      identifiers,
      detail: 'uses WITH (an exception clause this evaluator does not model)',
    };
  }
  return { verdict: allowed ? 'allowed' : 'denied', identifiers, detail: null };
}

// ─── inventory ───────────────────────────────────────────────────────────────────────────────────

/** Read the license inventory, either from a pinned file or from pnpm's offline listing. */
function readInventory() {
  if (LICENSES_FILE) {
    return {
      source: `--licenses ${relative(REPO, resolve(LICENSES_FILE))}`,
      doc: readJson(LICENSES_FILE),
    };
  }
  try {
    const stdout = execFileSync('corepack', ['pnpm@9.15.0', 'licenses', 'list', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { source: 'pnpm licenses list --json', doc: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error?.stdout ?? '';
    try {
      return { source: 'pnpm licenses list --json', doc: JSON.parse(stdout) };
    } catch {
      return { source: 'pnpm licenses list --json', doc: null, unavailable: true };
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const inventory = readInventory();
const allowlist = (() => {
  try {
    return readJson(ALLOWLIST_PATH).entries ?? [];
  } catch {
    return [];
  }
})();

/** Flatten the license→packages document into one row per (name, version). Sorted for determinism. */
function flatten(doc) {
  const rows = [];
  for (const [expression, packages] of Object.entries(doc ?? {})) {
    for (const entry of packages) {
      for (const version of entry.versions ?? ['<unknown>']) {
        rows.push({ name: entry.name, version, expression: entry.license ?? expression });
      }
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const rows = inventory.unavailable ? [] : flatten(inventory.doc);

if (inventory.unavailable) {
  // Not a pass and not a policy failure: the check could not run. Reported as its own outcome so a
  // green CI cell can never mean "pnpm was missing and we said nothing".
  process.stdout.write('license-check: UNAVAILABLE — could not read the license inventory\n');
  process.exitCode = 2;
} else {
  const matchedEntries = new Set();
  const results = [];
  for (const row of rows) {
    const { verdict, identifiers, detail } = evaluateExpression(row.expression);
    const entry = allowlist.find((e) => e.name === row.name);
    const allowlisted = Boolean(entry);
    if (allowlisted) matchedEntries.add(entry);
    results.push({ ...row, verdict, identifiers, detail, allowlisted, reason: entry?.reason });
    if (verdict === 'allowed' || allowlisted) continue;
    const label =
      verdict === 'denied'
        ? `license not on the permissive list: ${row.expression}`
        : verdict === 'unmodelled'
          ? `license uses WITH, which this evaluator does not model: ${row.expression}`
          : `license expression could not be parsed (${detail}): ${row.expression}`;
    fail(`${row.name}@${row.version} — ${label}`);
  }

  // The ratchet: an exemption that exempts nothing must be removed, or it rots in place.
  for (const entry of allowlist) {
    if (!matchedEntries.has(entry)) {
      fail(
        `stale allowlist entry (${entry.name}) matches no installed package — remove it from scripts/license-allowlist.json, or restore the dependency it excepted`,
      );
    }
  }

  // The vacuity guard: zero packages is a broken invocation, never a clean tree.
  if (rows.length === 0) {
    fail(
      'the license inventory is EMPTY — a check over zero packages passes trivially, so this is a failure: confirm the dependencies are installed and the invocation ran from the repository root',
    );
  }

  const byVerdict = tally(results, (r) => r.verdict);
  const expressions = [...new Set(rows.map((r) => r.expression))].sort();

  const report = {
    root: REPO,
    source: inventory.source,
    allowlist: relative(REPO, ALLOWLIST_PATH),
    packages: rows.length,
    byVerdict,
    expressions,
    allowlistEntries: allowlist.length,
    failures,
  };

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  } else {
    const line = (label, value) => process.stdout.write(`  ${label.padEnd(34)} ${value}\n`);
    process.stdout.write('license-check\n');
    line('inventory via', inventory.source);
    line('packages', rows.length);
    line(
      'verdicts (allowed/denied/unmodelled/unparseable)',
      `${byVerdict.allowed ?? 0} / ${byVerdict.denied ?? 0} / ${byVerdict.unmodelled ?? 0} / ${byVerdict.unparseable ?? 0}`,
    );
    line('allowlist entries matched', `${matchedEntries.size} / ${allowlist.length}`);
    line('distinct expressions', expressions.join(', ') || '(none)');
    if (failures.length) {
      process.stdout.write(`\nFAIL — ${failures.length} issue(s):\n`);
      for (const detail of failures) process.stdout.write(`  ${detail}\n`);
    } else {
      process.stdout.write('\nPASS — every installed package carries a permissive license\n');
    }
  }

  process.exitCode = failures.length ? 1 : 0;
}
