#!/usr/bin/env node
/**
 * Run the automated checks the UI release gate requires and record their exit codes in
 * checks.json (default docs/a11y/checks.json). The file is a receipt of commands
 * actually executed at a recorded HEAD — the gate reads it; nothing here decides the outcome.
 *
 *   node scripts/ui-release-checks.mjs [--out <file>] [--only unit,browser]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PNPM = ['corepack', 'pnpm@9.15.0'];
export const CHECK_COMMANDS = {
  unit: [...PNPM, '-r', 'run', 'test'],
  typecheck: [...PNPM, '-r', 'run', 'typecheck'],
  browser: [...PNPM, 'run', 'verify:browser'],
  security: [...PNPM, 'run', 'security:check'],
  package: [...PNPM, 'run', 'pack:check'],
};

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const out = resolve(outFlag >= 0 ? argv[outFlag + 1] : 'docs/a11y/checks.json');
const onlyFlag = argv.indexOf('--only');
const names = onlyFlag >= 0 ? argv[onlyFlag + 1].split(',') : Object.keys(CHECK_COMMANDS);

const record = {
  head: git(['rev-parse', 'HEAD']),
  dirty: (git(['status', '--porcelain']) ?? '').length > 0,
  startedAt: new Date().toISOString(),
};
for (const name of names) {
  const command = CHECK_COMMANDS[name];
  if (!command) {
    process.stderr.write(`unknown check: ${name}\n`);
    process.exitCode = 2;
    continue;
  }
  const started = Date.now();
  process.stdout.write(`▶ ${name}: ${command.join(' ')}\n`);
  const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  record[name] = {
    command: command.join(' '),
    exitCode: typeof run.status === 'number' ? run.status : 1,
    durationMs: Date.now() - started,
  };
}
record.finishedAt = new Date().toISOString();
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`recorded ${names.length} check(s) in ${out}\n`);
