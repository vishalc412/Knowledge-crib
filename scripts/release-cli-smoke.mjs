import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function smokeCli(cliPath = resolve('packages/cli/dist/cli.js')) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'knowledge-crib-cli-smoke-'));
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
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const output = execFileSync(process.execPath, [cliPath, 'status', projectRoot], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(output);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = smokeCli();
  console.log(`release CLI smoke ok - ${status.stats.nodes} nodes, ${status.stats.edges} edges`);
}
