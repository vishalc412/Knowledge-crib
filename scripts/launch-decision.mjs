/** Produce a deliberately small, auditable developer-launch decision from release evidence. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function evaluateLaunchDecision(evidence) {
  const blockers = [
    ...(evidence?.acceptance?.requiredFailures ?? []),
    ...((evidence?.certification?.required === true &&
      evidence.certification.missingRuntimeCells) ||
      []),
  ];
  return {
    decision: blockers.length === 0 && evidence?.acceptance?.pass === true ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
  };
}

function main() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--evidence');
  const path = resolve(
    index >= 0 ? (argv[index + 1] ?? 'release-evidence.json') : 'release-evidence.json',
  );
  const decision = evaluateLaunchDecision(JSON.parse(readFileSync(path, 'utf8')));
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  if (decision.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
