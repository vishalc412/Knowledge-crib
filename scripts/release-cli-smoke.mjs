import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function smokeCli(cliPath = resolve('packages/cli/dist/bin.js')) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'knowledge-crib-cli-smoke-'));
  // `KCRIB_REGISTRY_DIR` (the documented override in `registry.ts`) points the spawned CLI at a
  // throwaway registry instead of the developer's REAL `~/.crib/registry.json`.
  //
  // Without it this smoke run registered its temp project into the real global registry and then
  // `rmSync`'d the project — leaving a permanently dead entry behind on every run. That is not
  // hypothetical: the real registry had grown to 10,465 dead `/var/folders` entries in a 3.28 MB file
  // that every single `crib index` rewrites in full, because `release-verify.mjs` runs this smoke.
  // The smoke must not mutate user state — it is a release check, not a user action.
  const registryDir = mkdtempSync(join(tmpdir(), 'knowledge-crib-cli-smoke-registry-'));
  const env = { ...process.env, KCRIB_REGISTRY_DIR: registryDir };
  try {
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ name: 'knowledge-crib-smoke', private: true, type: 'module' }, null, 2)}\n`,
    );
    const sourcePath = join(projectRoot, 'src', 'math.ts');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(
      sourcePath,
      'export function double(value: number): number {\n  return value * 2;\n}\n',
    );

    execFileSync(process.execPath, [cliPath, 'index', projectRoot], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const output = execFileSync(process.execPath, [cliPath, 'status', projectRoot], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(output);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(registryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = smokeCli();
  console.log(`release CLI smoke ok - ${status.stats.nodes} nodes, ${status.stats.edges} edges`);
}
