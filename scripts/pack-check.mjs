import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const forbidden = /(^|\/)([^/\s]*\.test\.[^/\s]*|__probe__)(\/|$)/;
const packageDirs = [
  'packages/soul-schema',
  'packages/core',
  'packages/parsers',
  'packages/ui',
  'packages/mcp',
  'packages/pipeline',
  'packages/cli',
];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

const stagingDir = mkdtempSync(join(tmpdir(), 'knowledge-crib-pack-check-'));

try {
  for (const packageDir of packageDirs) {
    run('corepack', ['pnpm@9.15.0', 'pack', '--pack-destination', stagingDir], {
      cwd: packageDir,
    });
  }

  const tarballs = readdirSync(stagingDir).filter((name) => name.endsWith('.tgz'));
  const bad = [];
  const listings = [];

  for (const tarball of tarballs) {
    const listing = run('tar', ['-tf', join(stagingDir, tarball)]);
    listings.push(`\n${tarball}\n${listing}`);
    const entries = listing.split('\n').map((line) => line.trim());
    for (const required of ['package/LICENSE', 'package/NOTICE']) {
      if (!entries.includes(required)) bad.push(`${tarball}: missing ${required}`);
    }
    for (const line of entries) {
      const clean = line.replace(/^package\//, '').trim();
      if (forbidden.test(clean)) bad.push(`${tarball}: ${clean}`);
    }
  }

  if (bad.length > 0) {
    process.stderr.write(`Package tarball validation failed:\n${bad.join('\n')}\n`);
    process.exit(1);
  }

  process.stdout.write(listings.join(''));
  process.stdout.write('pack:check ok - legal files present; no *.test.* or __probe__ files\n');
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
