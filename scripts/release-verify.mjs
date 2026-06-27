import { execFileSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  process.stdout.write(`\n$ ${[cmd, ...args].join(' ')}\n`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function pnpm(args) {
  run('corepack', ['pnpm@9.15.0', ...args]);
}

pnpm(['verify']);
pnpm(['test:python']);
pnpm(['release:metadata']);
pnpm(['pack:check']);
pnpm(['publish:dry-run']);
pnpm(['installer:test']);
pnpm(['installer:build']);
pnpm(['installer:smoke']);
run(
  'node',
  [
    '--input-type=module',
    '-e',
    'import schema from "@knowledge-crib/soul-schema/schemas/node.schema.json" with { type: "json" }; console.log(schema["$schema"])',
  ],
  { cwd: 'packages/cli' },
);
run('node', ['scripts/release-cli-smoke.mjs']);
