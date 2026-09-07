/**
 * bootstrap — clone to fully-wired in one command.
 *
 * The published installers (`scripts/build-installers.mjs` → `install.sh` / `install.ps1`) already
 * take a user from "nothing" to "wired repository" in one step. This script is the same promise for
 * someone working from a git checkout of this repository, where there is no tarball to install:
 * install workspace dependencies, build every package, put `crib` on PATH, then run `crib setup`
 * against the target repository.
 *
 * It is a THIN orchestrator on purpose. Every step is a command that already exists and is already
 * covered by tests; re-implementing any of them here would create a second thing to keep correct,
 * and the steps that matter (integrity-pinned model install, non-clobbering config writes) are
 * exactly the ones that must not be re-implemented casually.
 *
 *   node scripts/bootstrap.mjs [target-repo]     everything, into the current repo by default
 *   node scripts/bootstrap.mjs --no-embed        skip the ~2.1 GB model download
 *   node scripts/bootstrap.mjs --no-link         do not `pnpm link --global` the CLI
 *   node scripts/bootstrap.mjs --skip-build      reuse an existing build (fast re-runs)
 *
 * Exit codes: non-zero if dependency install, build, or `crib setup` fails. Global linking is
 * best-effort — it is a convenience (a `crib` on PATH), and a sandbox that forbids writing to the
 * global bin directory must not turn a successful build into a failed bootstrap.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PNPM = ['corepack', ['pnpm@9.15.0']];
const REQUIRED_NODE = [22, 5];

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const positional = argv.find((a) => !a.startsWith('-'));
const target = resolve(positional ?? process.cwd());

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts });
}

function nodeVersionOk() {
  const [major, minor] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  const [reqMajor, reqMinor] = REQUIRED_NODE;
  return major > reqMajor || (major === reqMajor && minor >= reqMinor);
}

if (!nodeVersionOk()) {
  process.stderr.write(
    `knowledge-crib requires Node ${REQUIRED_NODE.join('.')} or newer (found ${process.versions.node}).\nThe soul backend uses node:sqlite, which is not available before that release.\n`,
  );
  process.exit(1);
}

process.stdout.write(`knowledge-crib bootstrap\n  checkout: ${REPO}\n  target:   ${target}\n`);

try {
  step('installing workspace dependencies');
  run(PNPM[0], [...PNPM[1], 'install']);

  if (has('--skip-build')) {
    process.stdout.write('\n▸ build skipped (--skip-build)\n');
  } else {
    step('building every package');
    run(PNPM[0], [...PNPM[1], '-r', 'run', 'build']);
  }
} catch (err) {
  process.stderr.write(`\nbootstrap failed during install/build: ${err.message}\n`);
  process.exit(1);
}

if (has('--no-link')) {
  process.stdout.write('\n▸ global link skipped (--no-link)\n');
} else {
  step('putting `crib` on PATH (pnpm link --global)');
  try {
    run(PNPM[0], [...PNPM[1], '--dir', join(REPO, 'packages', 'cli'), 'link', '--global']);
  } catch (err) {
    // Best-effort by design: a sandbox with no writable global bin dir still has a working build,
    // and the setup step below runs the built CLI by path rather than through PATH.
    process.stderr.write(
      `  warning: could not link globally (${err.message.split('\n')[0]}).\n` +
        `  Use the built CLI directly: node ${join(REPO, 'packages', 'cli', 'dist', 'cli.js')}\n`,
    );
  }
}

const cli = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
if (!existsSync(cli)) {
  process.stderr.write(`\nbootstrap failed: ${cli} was not built.\n`);
  process.exit(1);
}

step(`wiring ${target}`);
// Pass the setup-relevant flags straight through, so `--no-embed` / `--embed-model small` /
// `--ide <id>` mean the same thing here as they do on `crib setup` itself.
const BOOTSTRAP_ONLY = new Set(['--no-link', '--skip-build']);
const VALUE_FLAGS = new Set(['--ide', '--embed-model', '--embed-from']);
const setupArgs = [target];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--') || BOOTSTRAP_ONLY.has(a)) continue;
  setupArgs.push(a);
  if (VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) setupArgs.push(argv[++i]);
}

try {
  run(process.execPath, [cli, 'setup', ...setupArgs], { cwd: target });
} catch (err) {
  process.stderr.write(`\nbootstrap: \`crib setup\` failed — ${err.message.split('\n')[0]}\n`);
  process.exit(1);
}

process.stdout.write('\n✓ bootstrap complete.\n');
