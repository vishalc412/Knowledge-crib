import { execFileSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  process.stdout.write(`\n$ ${[cmd, ...args].join(' ')}\n`);
  // `corepack` (and other node-distributed CLIs) ship as .cmd shims on Windows;
  // execFileSync(shell:false) can't launch them (ENOENT), so shell them on win32.
  // `node` is a real .exe and never needs a shell — and a shell would MANGLE inline
  // `-e` scripts containing double-quotes: cmd.exe re-parses the arg string and
  // truncates the script at the first ", yielding `SyntaxError: Unexpected end of
  // input`. So shell only the .cmd-shim commands, not `node`. Posix is unaffected
  // (the `&& win32` guard short-circuits to shell:false, byte-identical to before).
  const needsShell = cmd !== 'node' && process.platform === 'win32';
  execFileSync(cmd, args, {
    stdio: 'inherit',
    shell: needsShell,
    ...opts,
  });
}

function pnpm(args) {
  run('corepack', ['pnpm@9.15.0', ...args]);
}

pnpm(['verify']);
pnpm(['test:python']);
pnpm(['release:metadata']);
pnpm(['pack:check']);
pnpm(['budget:check']);
pnpm(['eval:check']);
pnpm(['semantic:check']);
pnpm(['rerank:check']);
pnpm(['linker:check']);
pnpm(['alias:check']);
pnpm(['js-coverage:check']);
pnpm(['ifhash:check']);
pnpm(['tier:check']);
pnpm(['ownership:check']);
pnpm(['federation:check']);
pnpm(['stats:check']);
pnpm(['parallel:check']);
pnpm(['fuzz:check']);
pnpm(['scale:check']);
pnpm(['security:check']);
pnpm(['soul-refresh:check']);
pnpm(['onboarding:check']);
pnpm(['docs-site:check']);
pnpm(['publish:dry-run']);
// crib-cache-stability.test.mjs (run inside installer:test) only rebuilds the gitignored derived
// index when the file is ABSENT — it can't detect a STALE one (e.g. left over from a manual
// `crib index .` in this working tree). Force a fresh index here so installer:test always sees a
// derived index that matches the currently committed soul, regardless of local dev-machine state.
run('node', ['packages/cli/dist/cli.js', 'index', '.'], {
  timeout: 8 * 60_000, // full repo re-parse is ~2-3min locally; allow headroom on slower CI runners
});
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
