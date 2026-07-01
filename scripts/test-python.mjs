import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function pythonCandidates(platform = process.platform) {
  if (platform === 'win32') {
    return [
      { command: 'py', prefixArgs: ['-3'] },
      { command: 'python', prefixArgs: [] },
      { command: 'python3', prefixArgs: [] },
    ];
  }
  return [
    { command: 'python3', prefixArgs: [] },
    { command: 'python', prefixArgs: [] },
  ];
}

export function findPython(platform = process.platform) {
  for (const candidate of pythonCandidates(platform)) {
    const probe = spawnSync(candidate.command, [...candidate.prefixArgs, '--version'], {
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('Python 3 is required to run the worker test suite');
}

export function runPythonTests() {
  const python = findPython();
  execFileSync(
    python.command,
    [...python.prefixArgs, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
    { cwd: resolve(repoRoot, 'python'), stdio: 'inherit' },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPythonTests();
}
