/**
 * Compatibility wrapper: certify the Claude Code cell.
 *
 * This USED to be the whole harness — one script, one client. It is now a thin forwarder to
 * `scripts/client-certify.mjs`, which certifies any of the seven clients through one driver table.
 * The wrapper exists so that every existing invocation keeps working unchanged:
 *
 *   node scripts/client-certify-claude.mjs --out <receipts-dir> [--keep]
 *
 * is exactly
 *
 *   node scripts/client-certify.mjs --client claude --package <bundle.tgz> \
 *     --candidate-commit <HEAD> --out <receipts-dir> [--keep]
 *
 * WHY A WRAPPER AND NOT A SECOND IMPLEMENTATION. The old script's seven legs were Claude-specific,
 * and the one behaviour it recorded as two facts (interrupt and restart) is precisely what a
 * version-1 receipt could not express. Keeping a second copy of the leg logic alive here would mean
 * two places to forget a leg and two receipts that mean different things — the exact drift the
 * single harness was written to remove. So this delegates the RUN, and never re-implements a leg.
 *
 * It still resolves the two things the old script resolved for itself: the candidate tarball in the
 * local installer bundle, and the commit it is certifying (HEAD — certifying a commit you are not
 * standing on means the harness that produced the evidence is not the harness under audit).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

const argv = process.argv.slice(2);
const outDir = resolve(flag(argv, '--out', 'receipts'));
const keep = argv.includes('--keep');

// A bundle produced by `pnpm build:installers` holds the candidate tarball beside its dependency
// tarballs. This is the default the old script used; --package overrides it for a candidate built
// elsewhere (the release workflow builds once in one job and hands the same bytes to every cell).
const bundleDir = join(REPO_ROOT, 'dist/installers/knowledge-crib-0.1.0');
const defaultPackage = join(bundleDir, 'knowledge-crib-0.1.0.tgz');
const packagePath = resolve(flag(argv, '--package', defaultPackage));

const problems = [];
if (!existsSync(packagePath)) {
  problems.push(
    `no candidate package at ${packagePath}\n  Build one first: corepack pnpm@9.15.0 build:installers`,
  );
}
let commit = null;
try {
  commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch (error) {
  problems.push(`could not read HEAD: ${error.message}`);
}
if (problems.length) {
  process.stderr.write(
    `client-certify-claude REFUSES to start:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
  );
  process.exit(2);
}

process.stdout.write(
  'client-certify-claude: forwarding to scripts/client-certify.mjs --client claude\n' +
    '  (this script is a compatibility wrapper; the harness lives in client-certify.mjs)\n',
);

// stdio inherit + the child's own exit code. `execFileSync` THROWS on a non-zero status, so the
// status has to be re-read from the error and re-raised: a wrapper that let the throw become an
// unhandled exception, or caught it and exited 0, would turn a blocked cell into a silent success —
// the one outcome this harness exists to prevent.
try {
  execFileSync(
    process.execPath,
    [
      join(HERE, 'client-certify.mjs'),
      '--client',
      'claude',
      '--package',
      packagePath,
      '--candidate-commit',
      commit,
      '--out',
      outDir,
      ...(keep ? ['--keep'] : []),
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = 0;
} catch (error) {
  process.exitCode = typeof error?.status === 'number' ? error.status : 1;
}
