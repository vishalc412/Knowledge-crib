/**
 * credential-check — the WP3 hygiene gate for credential-shaped text in shipped code.
 *
 * Plan requirement (developer-trust-plan.md §WP3, bullet 6): "Extend existing dependency updates
 * with dependency-risk, license, secret, and release-artifact checks." This is the third of those
 * four; `dep-risk-check.mjs` and `license-check.mjs` are its siblings.
 *
 * WHAT THIS IS: a textual filter over the git-tracked tree for strings that have the SHAPE of a live
 * credential. It is deliberately offline and deterministic — it reads the working tree, touches no
 * network, and returns the same verdict twice in a row.
 *
 * WHAT THIS IS NOT, stated here so the limit is a known one rather than a silent one:
 *   - It does not know a match is live. A revoked key and an active one are the same string to a
 *     regex; only the pattern's shape is checked, never the issuer.
 *   - It does NOT scan git HISTORY. A credential committed and deleted in a later commit is still in
 *     the pack, and this check will report green. History scanning is a separate, much heavier job
 *     (`git log -p` over every blob); until it exists, "no hit" means "not in the current tree".
 *   - It reads tracked text only. A credential in an untracked file, a build artifact, or a binary is
 *     outside the walk, and the report prints those counts so the walk's reach is visible.
 *
 * OUTPUT DISCIPLINE: a finding never prints the matched value. Printing it would copy the credential
 * into CI logs and terminal scrollback — the exact leak this check exists to prevent. Findings print
 * a redacted prefix and the length, which is enough to identify and rotate, and not enough to use.
 *
 * ALLOWLIST (scripts/credential-scan-allowlist.json): every entry needs a `reason`, and an entry that
 * no longer matches anything is itself a failure — a stale allowlist is how a gate quietly stops
 * checking. That is the same ratchet shape as boundaries-baseline.json: it may shrink without
 * ceremony, and it cannot rot in place.
 *
 * Usage:  node scripts/credential-check.mjs [--root <dir>] [--allowlist <file>] [--json]
 * Exit 0 = no un-allowlisted hit; 1 = at least one hit (each is printed, redacted).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const REPO = rootIndex >= 0 ? resolve(argv[rootIndex + 1]) : resolve(__dirname, '..');
const JSON_OUT = argv.includes('--json');
const allowlistIndex = argv.indexOf('--allowlist');
const ALLOWLIST_PATH =
  allowlistIndex >= 0
    ? resolve(argv[allowlistIndex + 1])
    : join(REPO, 'scripts', 'credential-scan-allowlist.json');

/**
 * Patterns that are credential-shaped on their own — a match is a finding with no context needed.
 * Each `id` is the allowlist key, so an exception names the pattern it excepts rather than a line.
 *
 * NOTE for maintainers: never paste a full example token into this block or its comments. The
 * scanner reads this file too, so a live-shaped example here becomes a permanent self-finding.
 * The regex sources below are safe by construction (their own literals cannot match themselves);
 * prose examples must be mangled the same way.
 */
const PATTERNS = [
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{40,}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'basic-auth-url', re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/gi },
];

/**
 * The rule for values with no recognisable prefix: a credential-named key assigned a quoted literal.
 * Entropy filters it, so `token: none` and `password: process.env.DB_PASSWORD` stay quiet.
 */
const ASSIGNMENT_KEYS =
  /\b(?:api[_-]?key|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|passphrase|credential)\b\s*[:=]\s*['"]([^'"\n]{16,})['"]/gi;

/** Values that are obviously not credentials, even when assigned to a credential-named key. */
const VALUE_SAFE_RES = [
  /^process\.env\./,
  /^import\.meta\.env\./,
  /^[<>{[]/, // a placeholder: "<your-key>", "${TOKEN}"
  /^(?:test|fake|dummy|example|placeholder|redacted|changeme|xxx+)[-_]/i,
];

/** Shannon entropy per character — a long random string clears 3.5; prose and identifiers do not. */
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.crib', '.git', '.turbo']);
/** Lockfiles and generated bundles carry long opaque strings by construction; scanning them would
 *  produce noise, not findings. Counted, so the exclusion has a number attached to it. */
const SKIP_FILE_RES = [/^pnpm-lock\.yaml$/, /^package-lock\.json$/, /\.min\.(?:js|css)$/, /\.map$/];
const BINARY_RE =
  /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|wasm|onnx|bin|node|dylib|so|dll|exe|woff2?)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const failures = [];
const fail = (detail) => failures.push(detail);
const toRepoPath = (abs) => relative(REPO, abs).split('\\').join('/');

/**
 * Tracked files, or — when the tree is not a git work tree (a synthetic fixture, a copied export) —
 * a directory walk. `via` is reported so a reader can tell which one produced the list: the git path
 * excludes everything .gitignore'd, and the walk path does not, which changes what a green run means.
 */
function collectFiles() {
  let via = 'git ls-files';
  let listed = [];
  const git = (args) =>
    execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    // `git ls-files` lists the WHOLE repository, so pointing --root at a subdirectory of a repo
    // would silently scan the parent's tracked files and report them as if they were the root's.
    // Confirm the work tree top is the root being checked first; if it is not, walk instead.
    //
    // Both sides go through realpath: on macOS a mkdtemp root is /var/folders/... which is a symlink
    // to /private/var/folders/..., and git reports the RESOLVED top. Comparing the unresolved root
    // would never match, silently dropping to the walk — and the walk does NOT honour .gitignore, so
    // a green run would then mean something different from what this file says it means.
    if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(REPO)) {
      throw new Error('root is not the work tree top');
    }
    listed = git(['ls-files', '-z']).split('\0').filter(Boolean);
  } catch {
    via = 'directory walk (not a git work tree root)';
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else {
          listed.push(toRepoPath(join(dir, entry.name)));
        }
      }
    };
    walk(REPO);
  }
  const files = [];
  const skipped = { binary: 0, generated: 0, oversized: 0, missing: 0 };
  for (const rel of listed.sort()) {
    const abs = join(REPO, rel);
    if (BINARY_RE.test(rel)) {
      skipped.binary++;
      continue;
    }
    if (SKIP_FILE_RES.some((re) => re.test(rel))) {
      skipped.generated++;
      continue;
    }
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      skipped.missing++;
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) {
      skipped.oversized++;
      continue;
    }
    const body = readFileSync(abs);
    if (body.includes(0)) {
      skipped.binary++;
      continue;
    }
    files.push({ rel, text: body.toString('utf8') });
  }
  return { files, skipped, via, trackedTotal: listed.length };
}

/** Redacted enough to identify and rotate, not enough to use. */
function redact(value) {
  if (value.length <= 8) return `${'*'.repeat(value.length)} (${value.length} chars)`;
  return `${value.slice(0, 4)}…${'*'.repeat(4)} (${value.length} chars)`;
}

const { files, skipped, via, trackedTotal } = collectFiles();
const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const entries = allowlist.entries ?? [];

const findings = [];
for (const { rel, text } of files) {
  const seen = new Set(); // one finding per (file, pattern) — a long line can match many times
  const add = (pattern, value, index) => {
    const key = `${rel}\u0000${pattern}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      path: rel,
      pattern,
      redacted: redact(value),
      line: text.slice(0, index).split('\n').length,
    });
  };
  for (const { id, re } of PATTERNS) {
    for (const match of text.matchAll(re)) add(id, match[0], match.index);
  }
  for (const match of text.matchAll(ASSIGNMENT_KEYS)) {
    const value = match[1];
    if (VALUE_SAFE_RES.some((re) => re.test(value))) continue;
    if (entropy(value) < 3.5) continue;
    add('entropy-assignment', value, match.index);
  }
}

const matchedEntries = new Set();
for (const finding of findings) {
  const entry = entries.find((e) => e.path === finding.path && e.pattern === finding.pattern);
  if (entry) {
    matchedEntries.add(entry);
    finding.allowlisted = true;
    finding.reason = entry.reason;
    continue;
  }
  fail(
    `[${finding.pattern}] ${finding.path}:${finding.line} — ${finding.redacted} (no allowlist entry)`,
  );
}
// The ratchet, in the other direction: an exception that excepts nothing is removed or it rots.
for (const entry of entries) {
  if (!matchedEntries.has(entry)) {
    fail(
      `stale allowlist entry (${entry.path} / ${entry.pattern}) matches nothing — remove it from scripts/credential-scan-allowlist.json, or restore the code it excepted`,
    );
  }
}

const report = {
  root: REPO,
  scannedVia: via,
  trackedFiles: trackedTotal,
  textFilesScanned: files.length,
  skipped,
  allowlistEntries: entries.length,
  findings: findings.map((f) => ({
    path: f.path,
    pattern: f.pattern,
    line: f.line,
    redacted: f.redacted,
    allowlisted: Boolean(f.allowlisted),
    reason: f.reason,
  })),
  failures,
};

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
} else {
  const line = (label, value) => process.stdout.write(`  ${label.padEnd(34)} ${value}\n`);
  process.stdout.write('credential-check\n');
  line('allowlist', toRepoPath(ALLOWLIST_PATH));
  line('file list via', via);
  line('files: tracked / text-scanned', `${trackedTotal} / ${files.length}`);
  line(
    'skipped (binary/generated/oversized)',
    `${skipped.binary} / ${skipped.generated} / ${skipped.oversized}`,
  );
  line('findings / allowlisted', `${findings.length} / ${matchedEntries.size}`);
  if (failures.length) {
    process.stdout.write(`\nFAIL — ${failures.length} finding(s):\n`);
    for (const detail of failures) process.stdout.write(`  ${detail}\n`);
  } else {
    process.stdout.write('\nPASS — no credential-shaped text outside the allowlist\n');
  }
}

process.exitCode = failures.length ? 1 : 0;
