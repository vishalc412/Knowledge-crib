/**
 * Acceptance collector check table (Task 3 regressions).
 *
 * The collector used to be a top-level script with a hardcoded check list, so nothing could pin
 * WHICH product its checks exercised — and the one check that proved adapter behavior ran
 * `pnpm installer:test`, a source-level suite that packs the workspace mid-pass. A certifying pass
 * must instead run the INSTALLED candidate: the adapter probe runs the installed executable
 * (nothing that can rebuild or replace the candidate), the install cycle names the SUPPLIED bundle,
 * and freshness measures the installed CLI. These tests pin the check table for both modes, plus
 * the writer's product flags and the freshness harness's fast refusal on a bad --cli.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChecks } from './collect-acceptance-receipts.mjs';
import { receiptProduct } from './freshness-adoption-check.mjs';
import { assertBlockRemoved, assertManagedBlock } from './installed-adapter-check.mjs';
import { buildReceipt } from './write-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(HERE, '..'));

const root = mkdtempSync(join(tmpdir(), 'collector-checks-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const candidate = { path: '/bundle/knowledge-crib-0.1.0.tgz' };
const bundleDir = '/bundle/knowledge-crib-0.1.0';
const installed = {
  bins: { direct: '/prefix/lib/node_modules/knowledge-crib/dist/cli.js' },
  executableSha256: `sha256:${'f'.repeat(64)}`,
};
const receiptsDir = join(root, 'receipts');
const passRunId = '00000000-0000-0000-0000-000000000000';

const byType = (checks, type) => checks.find((c) => c.type === type);

// ── certifying mode: installed-product checks are HANDED the installed candidate ─────────────────
const certifying = resolveChecks({
  mode: 'certifying',
  candidate,
  bundleDir,
  installed,
  receiptsDir,
  passRunId,
});

// The adapter check runs the installed executable directly — no pnpm, no pack, nothing that can
// rebuild or replace the candidate mid-pass (the old check packed the workspace inside the pass).
// The spawn is pinned as DATA: what the receipt displays and what actually executes are the same
// object, so they can never drift apart.
const certifyingAdapter = byType(certifying, 'adapter');
assert.equal(certifyingAdapter.product, 'installed-candidate');
assert.deepEqual(certifyingAdapter.spawns, [
  {
    command: 'node',
    args: ['scripts/installed-adapter-check.mjs', '--bin', installed.bins.direct],
    display: `node scripts/installed-adapter-check.mjs --bin ${installed.bins.direct}`,
  },
]);
assert.ok(
  !/pnpm|pack/.test(JSON.stringify(certifyingAdapter.spawns)),
  'the certifying adapter check must not invoke pnpm or pack anything',
);

// The install cycle names the SUPPLIED bundle — never an mtime discovery of what some other step
// just built.
const certifyingInstall = byType(certifying, 'install');
assert.equal(certifyingInstall.product, 'installed-candidate');
assert.deepEqual(certifyingInstall.spawns, [
  {
    command: 'node',
    args: ['scripts/install-smoke.mjs', '--user-dir', '--bundle', bundleDir],
    display: `node scripts/install-smoke.mjs --user-dir --bundle ${bundleDir}`,
  },
]);

// Freshness measures the INSTALLED CLI, and its spawn carries the SAME binding every other
// receipt gets: the candidate package, the pass run id, and the installed executable.
const certifyingFreshness = byType(certifying, 'freshness');
assert.equal(certifyingFreshness.product, 'installed-candidate');
const freshnessArgs = [
  'scripts/freshness-adoption-check.mjs',
  '--out',
  join(receiptsDir, 'freshness.json'),
  '--package',
  candidate.path,
  '--run-id',
  passRunId,
  '--cli',
  installed.bins.direct,
];
assert.deepEqual(certifyingFreshness.spawns, [
  { command: 'node', args: freshnessArgs, display: `node ${freshnessArgs.join(' ')}` },
]);
// The harness's own receipt is read back from exactly the path the spawn writes to — one constant,
// so the read-back can never inspect a different file than the one produced.
assert.equal(certifyingFreshness.ownReceipt, join(receiptsDir, 'freshness.json'));

// The source-level suites stay, and stay marked as workspace evidence — regression evidence kept
// separate from installed-product acceptance evidence, not deleted.
for (const type of ['security-privacy', 'recovery', 'native-service', 'browser']) {
  assert.equal(
    byType(certifying, type).product,
    'workspace',
    `${type} stays source-level in Task 3 and must say so`,
  );
}
// Display commands are DERIVED from the spawn steps, so what a receipt records is what actually
// ran — corepack and all, not a friendlier alias.
assert.equal(byType(certifying, 'browser').command, 'corepack pnpm@9.15.0 verify:browser');
assert.equal(
  byType(certifying, 'security-privacy').command,
  'corepack pnpm@9.15.0 security:battery && corepack pnpm@9.15.0 security:check',
);
assert.deepEqual(byType(certifying, 'security-privacy').spawns, [
  {
    command: 'corepack',
    args: ['pnpm@9.15.0', 'security:battery'],
    display: 'corepack pnpm@9.15.0 security:battery',
  },
  {
    command: 'corepack',
    args: ['pnpm@9.15.0', 'security:check'],
    display: 'corepack pnpm@9.15.0 security:check',
  },
]);

// ── build mode: same seams, different producer ────────────────────────────────────────────────────
const build = resolveChecks({
  mode: 'build',
  candidate,
  bundleDir,
  installed,
  receiptsDir,
  passRunId,
});
// There is nothing installed yet at build time, so the adapter check stays source-level — and says so.
assert.equal(byType(build, 'adapter').product, 'workspace');
assert.deepEqual(byType(build, 'adapter').spawns, [
  {
    command: 'corepack',
    args: ['pnpm@9.15.0', 'installer:test'],
    display: 'corepack pnpm@9.15.0 installer:test',
  },
]);
// The installed-product seams (explicit bundle, --cli) are the SAME in both modes — only who
// produced the bytes differs.
assert.ok(byType(build, 'install').spawns[0].args.includes(bundleDir));
assert.ok(byType(build, 'freshness').spawns[0].args.includes(installed.bins.direct));
assert.equal(byType(build, 'install').product, 'installed-candidate');
assert.equal(byType(build, 'freshness').product, 'installed-candidate');

// ── the writer records WHICH product a receipt describes ─────────────────────────────────────────
const pkgBytes = 'candidate bytes\n';
const pkgPath = join(root, 'candidate.tgz');
writeFileSync(pkgPath, pkgBytes);
const exeBytes = 'installed cli bytes\n';
const exePath = join(root, 'cli.js');
writeFileSync(exePath, exeBytes);
const shaOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const base = [
  '--package',
  pkgPath,
  '--command',
  'node scripts/installed-adapter-check.mjs',
  '--exit-code',
  '0',
  '--artifact',
  exePath,
];
const installedReceipt = buildReceipt({
  type: 'adapter',
  argv: [...base, '--product-source', 'installed-candidate', '--executable', exePath],
});
assert.deepEqual(installedReceipt.product, {
  source: 'installed-candidate',
  executableSha256: shaOf(exeBytes),
});
// Workspace receipts carry the field too — uniform schema, honest source.
const workspaceReceipt = buildReceipt({
  type: 'browser',
  argv: [...base, '--product-source', 'workspace'],
});
assert.deepEqual(workspaceReceipt.product, { source: 'workspace' });
assert.deepEqual(buildReceipt({ type: 'browser', argv: base }).product, { source: 'workspace' });
// An installed-candidate receipt without the executable it ran is a claim about unhashed bytes.
assert.throws(
  () =>
    buildReceipt({ type: 'adapter', argv: [...base, '--product-source', 'installed-candidate'] }),
  /--executable is required/,
);
assert.throws(
  () =>
    buildReceipt({
      type: 'adapter',
      argv: [
        ...base,
        '--product-source',
        'installed-candidate',
        '--executable',
        join(root, 'nope.js'),
      ],
    }),
  /--executable does not exist/,
);
assert.throws(
  () => buildReceipt({ type: 'browser', argv: [...base, '--product-source', 'somewhere-else'] }),
  /--product-source must be workspace or installed-candidate/,
);

// ── the freshness harness writes the SAME product schema the generic writer does ───────────────────
// Two writers, one schema: a workspace receipt carries ONLY `source` (nothing was installed), an
// installed-candidate receipt carries the executable hash. Before this was extracted, the harness
// stamped an executableSha256 onto WORKSPACE receipts too — a field the decision never asks for and
// a divergence from the writer its receipts must be interchangeable with.
assert.deepEqual(receiptProduct({ cliPath: undefined }), { source: 'workspace' });
assert.deepEqual(receiptProduct({ cliPath: exePath, cliFile: exePath }), {
  source: 'installed-candidate',
  executableSha256: shaOf(exeBytes),
});

// ── the freshness harness refuses a bad --cli BEFORE building its fixture ────────────────────────
// The refusal is what makes "pass its executable explicitly" testable cheaply: a typo'd --cli
// exits in milliseconds instead of after a full workload on the WRONG product.
const freshArgs = [
  'scripts/freshness-adoption-check.mjs',
  '--out',
  join(root, 'freshness.json'),
  '--package',
  pkgPath,
  '--cli',
  join(root, 'no-such-cli.js'),
];
const refused = spawnSync(process.execPath, freshArgs, { cwd: REPO_ROOT, encoding: 'utf8' });
assert.equal(refused.status, 2, 'a bad --cli must refuse (exit 2), not run the workload');
assert.match(refused.stderr, /--cli points at .* which does not exist/);
// A missing --package still refuses the same way it always did.
const noPkg = spawnSync(
  process.execPath,
  ['scripts/freshness-adoption-check.mjs', '--out', join(root, 'freshness.json')],
  { cwd: REPO_ROOT, encoding: 'utf8' },
);
assert.equal(noPkg.status, 2);
assert.match(noPkg.stderr, /--package/);

// ── the installed-adapter probe's byte contracts (pure halves — no executable needed) ───────────
// The block the installed product must write: markers present, in order, carrying the rule.
const goodBlock =
  'pre-existing notes\n<!-- crib:start -->\nKnowledge-crib is MANDATORY in this repository\n<!-- crib:end -->\n';
assert.deepEqual(assertManagedBlock(goodBlock), {
  begin: goodBlock.indexOf('<!-- crib:start -->'),
  end: goodBlock.indexOf('<!-- crib:end -->'),
});
assert.throws(() => assertManagedBlock('no block at all'), /no <!-- crib:start -->/);
assert.throws(
  () => assertManagedBlock('<!-- crib:start -->Knowledge-crib is MANDATORY in this repository'),
  /opened but never closed/,
);
assert.throws(
  () => assertManagedBlock('<!-- crib:start -->a placeholder block<!-- crib:end -->'),
  /does not carry the mandatory protocol rule/,
);
// After removal: markers gone, sibling content intact.
assert.doesNotThrow(() => assertBlockRemoved('pre-existing notes\n', 'pre-existing notes'));
assert.throws(
  () => assertBlockRemoved('<!-- crib:start -->x<!-- crib:end -->', 'notes'),
  /left managed-block markers behind/,
);
assert.throws(
  () => assertBlockRemoved('something else\n', 'pre-existing notes'),
  /destroyed pre-existing sibling content/,
);

// ── installed-adapter-check main(): end to end against a stub CLI ──────────────────────────────────
// main() used to be untested orchestration — exactly the layer where a guard can be silently
// dropped and every suite stays green. A stub CLI implements the four adapter verbs against the
// project's CLAUDE.md, so the probe's full sequence (install → assert → list → status → remove →
// assert) runs for real without building a candidate. The stub is .mjs because it lives in the
// system tmpdir, where a bare .js would be parsed as CommonJS.
const stubDir = join(root, 'stub');
mkdirSync(stubDir);
const stubBin = join(stubDir, 'stub-cli.mjs');
writeFileSync(
  stubBin,
  `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const BEGIN = '<!-- crib:start -->';
const END = '<!-- crib:end -->';
const RULE = 'Knowledge-crib is MANDATORY in this repository';
const argv = process.argv.slice(2);
const verb = argv[1];
const project = argv[argv.length - 1];
const file = \`\${project}/CLAUDE.md\`;
const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
if (verb === 'install') {
  const block =
    process.env.STUB_OMIT_RULE === '1' ? \`\${BEGIN}placeholder\${END}\n\` : \`\${BEGIN}\n\${RULE}\n\${END}\n\`;
  writeFileSync(file, content + block);
} else if (verb === 'list') {
  process.stdout.write('claude: present\\n');
} else if (verb === 'status') {
  process.stdout.write('{}\\n');
} else if (verb === 'remove') {
  writeFileSync(file, content.replace(new RegExp(\`\${BEGIN}[\\\\s\\\\S]*?\${END}\\\\n?\`), ''));
}
`,
);
const probe = (args, env = process.env) =>
  spawnSync(process.execPath, ['scripts/installed-adapter-check.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
// The full happy path: install writes the block beside the sibling, list reports present, remove
// restores the file byte-for-byte.
const ok = probe(['--bin', stubBin]);
assert.equal(ok.status, 0, `stub e2e must pass: ${ok.stderr}`);
assert.match(ok.stdout, /installed adapter check ok/);
// Argument refusals fire before anything is spawned.
const noBin = probe([]);
assert.equal(noBin.status, 1);
assert.match(noBin.stderr, /--bin is required/);
const ghostBin = probe(['--bin', join(root, 'no-such-cli.js')]);
assert.equal(ghostBin.status, 1);
assert.match(ghostBin.stderr, /--bin does not exist/);
// A product that installs a block WITHOUT the mandatory rule is refused — the probe checks the
// CONTENT it was asked to certify, not just the exit codes of the commands it ran.
const omitRule = probe(['--bin', stubBin], { ...process.env, STUB_OMIT_RULE: '1' });
assert.equal(omitRule.status, 1);
assert.match(omitRule.stderr, /does not carry the mandatory protocol rule/);

console.log('collector check tests ok');
