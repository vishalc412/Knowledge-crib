/**
 * Installed-product adapter probe (Task 3).
 *
 * The acceptance pass's adapter check used to run `pnpm installer:test` — a SOURCE-level suite that
 * packs and exercises the workspace copy, not the candidate a launch is being asked to certify. A
 * launch receipt that says "adapter" must describe the INSTALLED product's protocol behavior: the
 * managed block the installed executable writes, the list/status surface it exposes, and the
 * removal that preserves sibling bytes. This script exercises exactly that, and — because the
 * defect was a check that could rebuild the candidate mid-pass — it contains no pnpm, no pack, no
 * install of anything: it only RUNS the executable it is handed.
 *
 * Usage:
 *   node scripts/installed-adapter-check.mjs --bin <installed dist/cli.js>
 *
 * The project under test is a scratch git repo with a pre-existing CLAUDE.md sibling, and HOME is
 * pointed at a scratch directory so an installed product can never touch a real user config while
 * being certified.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADAPTER_BEGIN = '<!-- crib:start -->';
export const ADAPTER_END = '<!-- crib:end -->';
export const MANDATORY_MARK = 'Knowledge-crib is MANDATORY in this repository';

/**
 * The protocol block the INSTALLED product must write. Exported so the unit suite pins the
 * contract without running an executable: markers present, in order, carrying the mandatory rule.
 */
export function assertManagedBlock(content, label = 'CLAUDE.md') {
  const begin = content.indexOf(ADAPTER_BEGIN);
  const end = content.indexOf(ADAPTER_END);
  if (begin === -1) {
    throw new Error(
      `${label}: the installed product wrote no crib managed block (no ${ADAPTER_BEGIN})`,
    );
  }
  if (end === -1 || end < begin) {
    throw new Error(
      `${label}: managed block opened but never closed (no ${ADAPTER_END} after start)`,
    );
  }
  const block = content.slice(begin, end);
  if (!block.includes(MANDATORY_MARK)) {
    throw new Error(
      `${label}: managed block does not carry the mandatory protocol rule (missing "${MANDATORY_MARK}")`,
    );
  }
  return { begin, end };
}

/**
 * After removal, the block must be GONE and the sibling content byte-identical to what was there
 * before the adapter was ever installed — "removing an adapter does not remove memory" and not
 * anyone else's instructions either.
 */
export function assertBlockRemoved(content, originalSibling, label = 'CLAUDE.md') {
  if (content.includes(ADAPTER_BEGIN) || content.includes(ADAPTER_END)) {
    throw new Error(`${label}: adapter removal left managed-block markers behind`);
  }
  if (!content.includes(originalSibling)) {
    throw new Error(`${label}: adapter removal destroyed pre-existing sibling content`);
  }
}

/** Run the installed executable once and refuse anything but a clean exit. */
function runInstalled(bin, args, { cwd, env }) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd,
    env,
  });
  if (result.error) throw result.error;
  return { ...result, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function die(message, extra = '') {
  process.stderr.write(`installed-adapter-check: ${message}\n${extra}`);
  process.exitCode = 1;
}

export async function main() {
  const argv = process.argv.slice(2);
  const binIndex = argv.indexOf('--bin');
  const bin = binIndex >= 0 ? argv[binIndex + 1] : undefined;
  if (!bin) {
    die(
      '--bin is required: the installed candidate executable (dist/cli.js) must be passed explicitly — this probe never discovers or builds anything',
    );
    return;
  }
  if (!existsSync(bin)) {
    die(`--bin does not exist: ${bin}`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'installed-adapter-'));
  try {
    // Isolated HOME so the installed product can never read or write a real user config during
    // certification, and a scratch git project so no adapter path resolves outside this temp tree.
    const home = join(scratch, 'home');
    const project = join(scratch, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '--quiet'], { cwd: project, encoding: 'utf8' });

    const sibling = '# Project notes\n\nPre-existing instructions an operator wrote by hand.\n';
    const instructionFile = join(project, 'CLAUDE.md');
    writeFileSync(instructionFile, sibling);

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // No client configuration may leak in from the certifying machine's real environment.
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      npm_config_prefix: join(home, '.npm-global'),
    };

    const log = [];
    const step = (name, result) => {
      if (result.status !== 0) {
        die(`step "${name}" exited ${result.status}`, `${result.stderr}\n${result.stdout}`);
        return false;
      }
      log.push(`$ ${name}\n${result.stdout}`);
      return true;
    };

    // 1. install: the installed product writes its managed block into claude's instruction file.
    if (
      !step(
        'adapters install --client claude',
        runInstalled(bin, ['adapters', 'install', '--client', 'claude', project], {
          cwd: project,
          env,
        }),
      )
    )
      return;
    const installed = readFileSync(instructionFile, 'utf8');
    assertManagedBlock(installed);
    if (!installed.includes(sibling)) {
      die('adapters install destroyed pre-existing CLAUDE.md content');
      return;
    }

    // 2. list: the installed product reports the adapter as present.
    const listed = runInstalled(bin, ['adapters', 'list', '--client', 'claude', project], {
      cwd: project,
      env,
    });
    if (!step('adapters list --client claude', listed)) return;
    if (!/claude:\s*present/.test(listed.stdout)) {
      die('adapters list does not report the claude adapter as present', listed.stdout);
      return;
    }

    // 3. status: the installed product's state report runs clean.
    if (
      !step(
        'adapters status --client claude --json',
        runInstalled(bin, ['adapters', 'status', '--client', 'claude', '--json', project], {
          cwd: project,
          env,
        }),
      )
    )
      return;

    // 4. remove: the block goes away, the sibling content stays.
    if (
      !step(
        'adapters remove --client claude',
        runInstalled(bin, ['adapters', 'remove', '--client', 'claude', project], {
          cwd: project,
          env,
        }),
      )
    )
      return;
    assertBlockRemoved(readFileSync(instructionFile, 'utf8'), 'Pre-existing instructions');

    process.stdout.write(
      `installed adapter check ok (${bin})\n${log.map((entry) => entry.split('\n')[0]).join('\n')}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
