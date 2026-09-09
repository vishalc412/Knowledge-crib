/**
 * Certify ONE client/platform cell with a real vendor run: Claude Code on this host.
 *
 * The distinction this script exists to respect: a protocol harness that speaks MCP proves the
 * protocol, not the client. What certifies a cell is the vendor's own application launching the
 * candidate build, completing a handshake, calling tools, and — after an interruption — resuming an
 * authorized session. So this drives the real `claude` binary in print mode against an isolated
 * profile whose MCP config points at the INSTALLED candidate package, not at a source checkout.
 *
 * The legs, in order:
 *   1. install the exact candidate tarball into an isolated prefix (no global mutation)
 *   2. generate the client config through `crib mcp install` (the shipped path, not a hand-write)
 *   3. launch the vendor client and prove handshake + tool use
 *   4. record a uniquely tagged authorized memory through the client
 *   5. interrupt the client mid-session (SIGKILL, not a graceful exit)
 *   6. restart it and recover the prior authorized session
 *   7. plant a FOREIGN principal's record and prove it never appears in the owner's output
 *
 * Every leg writes to a transcript that the receipt hashes. A leg that cannot run fails the cell
 * rather than being skipped — the whole point of the exercise is that "not run" is visible.
 *
 * Usage: node scripts/client-certify-claude.mjs --out <receipts-dir> [--keep]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy } from './launch-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

const sha256File = (path) =>
  `sha256:${createHash('sha256').update(readFileBytes(path)).digest('hex')}`;

function readFileBytes(path) {
  return execFileSync('cat', [path]);
}

/** Append to the transcript AND echo, so a watching operator sees the same bytes the receipt hashes. */
function makeLog(path) {
  return (line) => {
    appendFileSync(path, `${line}\n`);
    process.stdout.write(`${line}\n`);
  };
}

/** Run a command, capturing everything into the transcript. Never throws — legs report status. */
function run(log, label, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
    ...options,
  });
  const ms = Date.now() - started;
  log(`\n$ ${command} ${args.join(' ')}   [${label}, ${ms}ms, exit ${result.status}]`);
  if (result.stdout?.trim()) log(result.stdout.trim().slice(0, 4000));
  if (result.stderr?.trim()) log(`stderr: ${result.stderr.trim().slice(0, 2000)}`);
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const outDir = resolve(flag(argv, '--out', 'receipts'));
  const { sha256: policySha256 } = loadLaunchPolicy();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty =
    execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }).trim().length > 0;

  const workspace = mkdtempSync(join(tmpdir(), 'crib-certify-claude-'));
  const home = join(workspace, 'home');
  const prefix = join(home, 'npm-global');
  const project = join(workspace, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(prefix, { recursive: true });
  const transcript = join(workspace, 'claude-vendor-run.log');
  writeFileSync(transcript, '');
  const log = makeLog(transcript);

  const tag = `certify-${createHash('sha256').update(`${commit}:${Date.now()}`).digest('hex').slice(0, 12)}`;
  const legs = {};
  let clientVersion = 'unknown';

  try {
    log(`# Claude Code vendor certification — candidate ${commit} (dirty=${dirty})`);
    log(`# host ${hostname()} ${process.platform}/${process.arch} node ${process.version}`);
    log(`# policy ${policySha256}`);
    log(`# unique tag ${tag}`);

    const version = run(log, 'client version', 'claude', ['--version']);
    clientVersion = (version.stdout ?? '').trim().split(' ')[0] || 'unknown';

    // ── leg 1: install the exact candidate package into an isolated prefix ────
    const bundleDir = join(REPO_ROOT, 'dist/installers/knowledge-crib-0.1.0');
    const tarball = join(bundleDir, 'knowledge-crib-0.1.0.tgz');
    const deps = execFileSync('ls', [bundleDir], { encoding: 'utf8' })
      .split('\n')
      .filter((n) => n.endsWith('.tgz') && n !== 'knowledge-crib-0.1.0.tgz')
      .map((n) => join(bundleDir, n));
    const install = run(
      log,
      'leg 1: install candidate into an isolated prefix',
      'npm',
      ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', ...deps, tarball],
      { env: { ...process.env, HOME: home, npm_config_prefix: prefix }, timeoutMs: 600_000 },
    );
    legs.install = install.status === 0;
    mkdirSync(join(home, '.crib', 'memory'), { recursive: true });
    const cribBin = join(prefix, 'bin', 'crib');
    const packageSha256 = sha256File(tarball);

    // A minimal project the client will open. The graph must exist before the server serves it.
    writeFileSync(
      join(project, 'src', 'a.ts'),
      'export function certifiedSymbol(): number { return 1; }\n',
    );
    execFileSync('git', ['-C', project, 'init', '-q']);
    execFileSync('git', ['-C', project, 'config', 'user.email', 'certify@example.invalid']);
    execFileSync('git', ['-C', project, 'config', 'user.name', 'certify']);
    execFileSync('git', ['-C', project, 'add', '-A']);
    execFileSync('git', ['-C', project, 'commit', '-qm', 'base']);
    // The vendor client runs under the OPERATOR's real profile, because a Claude Code with an
    // empty HOME has no credentials and exits in 100ms — an unauthenticated client cannot certify
    // anything. What IS isolated is everything of crib's: the installed package, the memory stores,
    // the registry and the project. CLAUDE_PROJECT_DIR is stripped because this process is itself
    // running inside Claude Code, and inheriting it made `crib mcp install` resolve the REAL
    // repository instead of the scenario project.
    const { CLAUDE_PROJECT_DIR: _inherited, ...cleanEnv } = process.env;
    const cribState = {
      KCRIB_MEMORY_DIR: join(home, '.crib', 'memory'),
      KCRIB_REGISTRY_DIR: join(home, '.crib'),
    };
    const clientEnv = { ...cleanEnv, npm_config_prefix: prefix, ...cribState };
    run(log, 'index the project with the INSTALLED binary', cribBin, ['index', project], {
      env: clientEnv,
      timeoutMs: 600_000,
    });
    run(log, 'initialize memory', cribBin, ['memory', 'init'], {
      env: clientEnv,
      cwd: project,
    });

    // ── leg 2: generate the client config through the shipped path ───────────
    const config = run(
      log,
      'leg 2: generate client config',
      cribBin,
      // NOTE: the CLI's flag is `--global`, not `--scope`. An unrecognised `--scope project` has
      // its VALUE swallowed as the repo path (the parser pushes any non-dash token as a
      // positional), which silently wrote the config to `<cwd>/project`. Project scope is the
      // default, so the flag is simply omitted here.
      ['mcp', 'install', '--ide', 'claude', '--bin', cribBin, project],
      { env: clientEnv, cwd: project },
    );
    const configPath = join(project, '.mcp.json');
    // The shipped installer writes command+args; the operator adds the env that isolates crib's
    // stores for this run. Disclosed rather than hidden: the receipt hashes the FINAL file.
    const generated = JSON.parse(readFileBytes(configPath).toString('utf8'));
    generated.mcpServers['knowledge-crib'].env = {
      ...cribState,
      KCRIB_PRINCIPAL_ID: 'principal:owner',
    };
    writeFileSync(configPath, `${JSON.stringify(generated, null, 2)}\n`);
    legs.configuration =
      config.status === 0 && generated.mcpServers['knowledge-crib'].command === cribBin;
    run(log, 'the generated config (with the operator env block)', 'cat', [configPath]);

    // A second config differing ONLY in principal — used to plant a foreign record through the
    // same vendor client, so the exclusion is proved end to end rather than at the store layer.
    const foreignConfigPath = join(project, '.mcp.foreign.json');
    const foreignConfig = JSON.parse(JSON.stringify(generated));
    foreignConfig.mcpServers['knowledge-crib'].env = {
      ...cribState,
      KCRIB_PRINCIPAL_ID: 'principal:someone-else',
    };
    writeFileSync(foreignConfigPath, `${JSON.stringify(foreignConfig, null, 2)}\n`);

    /** Drive the REAL vendor client, one non-interactive turn, with the project's MCP config. */
    const claude = (label, prompt, extra = [], config = configPath) =>
      run(
        log,
        label,
        'claude',
        [
          '-p',
          prompt,
          '--mcp-config',
          config,
          // Only crib's own verbs are allowed, so the run cannot wander into the filesystem or the
          // network to satisfy a prompt. (`--max-turns` does not exist in Claude Code 2.1.x — the
          // bound here is the allowlist plus the per-call timeout, not a turn counter.)
          '--allowedTools',
          'mcp__knowledge-crib__query,mcp__knowledge-crib__memory,mcp__knowledge-crib__memory_observe,mcp__knowledge-crib__memory_recall,mcp__knowledge-crib__status',
          ...extra,
        ],
        { env: clientEnv, cwd: project, timeoutMs: 300_000 },
      );

    // ── leg 3: handshake + tool use through the vendor client ────────────────
    const handshake = claude(
      'leg 3: vendor handshake + tool use',
      `Use the knowledge-crib MCP server. Call its query tool with q="certifiedSymbol" and reply with ONLY the id of the first hit.`,
    );
    legs.protocol =
      handshake.status === 0 && /certifiedSymbol/.test(`${handshake.stdout}${handshake.stderr}`);

    // ── leg 4: record a uniquely tagged authorized memory through the client ──
    const record = claude(
      'leg 4: record a tagged authorized intake',
      `Use the knowledge-crib MCP memory tool with op="intake_create", original="${tag}", summary="vendor certification run ${tag}", outcome="prove a Claude Code session records and later recovers an authorized intake", phase="executing", actor="claude-code-certification". Then reply with ONLY the returned intake id.`,
    );
    legs.recordedMemory = record.status === 0 && /intake:/.test(`${record.stdout}`);

    // ── leg 5: interrupt a session mid-flight (SIGKILL, not a clean exit) ─────
    const interrupted = spawnSync(
      'bash',
      [
        '-c',
        `claude -p 'Call the knowledge-crib status tool with op="health" and then wait.' --mcp-config ${JSON.stringify(configPath)} --allowedTools mcp__knowledge-crib__status & pid=$!; sleep 6; kill -9 $pid; wait $pid 2>/dev/null; echo "killed $pid"`,
      ],
      { encoding: 'utf8', env: clientEnv, cwd: project, timeout: 120_000 },
    );
    log(`\n$ [leg 5: interrupt] exit ${interrupted.status}`);
    log((interrupted.stdout ?? '').trim().slice(0, 1000));
    legs.interrupted = /killed \d+/.test(interrupted.stdout ?? '');

    // ── leg 6: restart the client and recover the authorized session ──────────
    const resumed = claude(
      'leg 6: restart + recover the prior authorized session',
      `Use the knowledge-crib MCP memory tool with op="handoff". Reply with ONLY the word FOUND if any intake's original field contains "${tag}", otherwise reply MISSING.`,
    );
    const resumedText = `${resumed.stdout}`;
    legs.authorizedResume = resumed.status === 0 && /FOUND/.test(resumedText);

    // ── leg 7: a FOREIGN principal's record must never reach the owner ────────
    // Planted directly into the local store under another principal id, then the owner's own
    // client is asked to recall it. Absence here is the boundary holding.
    const foreignMarker = `foreign-${tag}`;
    const plant = claude(
      'leg 7: plant a foreign-principal record through the client',
      `Use the knowledge-crib MCP memory tool with op="capture", subject="topic:foreign", observation="${foreignMarker} belongs to another principal", actor="other-principal". Reply with ONLY the returned id.`,
      [],
      foreignConfigPath,
    );
    // The record must EXIST for the exclusion to mean anything: a plant that silently failed would
    // make this leg pass for the wrong reason.
    const plantedVisible = claude(
      'leg 7: the foreign principal can see its own record',
      `Use the knowledge-crib MCP memory_recall tool with q="${foreignMarker}" and includePending=true. Reply with ONLY the word PRESENT if any result contains "${foreignMarker}", otherwise ABSENT.`,
      [],
      foreignConfigPath,
    );
    legs.foreignRecordPlanted = plant.status === 0 && /PRESENT/.test(`${plantedVisible.stdout}`);

    const foreign = claude(
      'leg 7: the owner must not see it',
      `Use the knowledge-crib MCP memory_recall tool with q="${foreignMarker}" and includePending=true. Reply with ONLY the word LEAKED if any returned memory contains "${foreignMarker}", otherwise reply CLEAN.`,
    );
    legs.foreignPrincipalExcluded =
      foreign.status === 0 &&
      !/LEAKED/.test(`${foreign.stdout}`) &&
      legs.foreignRecordPlanted === true;

    const runtimePass =
      legs.protocol && legs.recordedMemory && legs.interrupted && legs.authorizedResume;

    log('\n# legs');
    for (const [name, ok] of Object.entries(legs))
      log(`  ${name.padEnd(26)} ${ok ? 'pass' : 'FAIL'}`);

    // ── the receipt ──────────────────────────────────────────────────────────
    mkdirSync(outDir, { recursive: true });
    const archivedTranscript = join(outDir, 'claude-darwin-vendor-run.log');
    execFileSync('cp', [transcript, archivedTranscript]);
    const receipt = {
      format: 'knowledge-crib-client-certification',
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      policySha256,
      product: { commit, packageSha256 },
      client: { id: 'claude', version: clientVersion },
      platform: { os: process.platform, arch: process.arch, node: process.version },
      evidence: {
        configuration: {
          status: legs.configuration ? 'pass' : 'fail',
          configSha256: sha256File(configPath),
        },
        protocol: {
          status: legs.protocol ? 'pass' : 'not-run',
          source: 'vendor-client',
          transcriptSha256: sha256File(archivedTranscript),
        },
        runtime: {
          status: runtimePass ? 'pass' : 'fail',
          source: 'vendor-client',
          recordedMemory: legs.recordedMemory === true,
          interrupted: legs.interrupted === true,
          authorizedResume: legs.authorizedResume === true,
          foreignPrincipalExcluded: legs.foreignPrincipalExcluded === true,
          uniqueTag: tag,
          logPath: 'claude-darwin-vendor-run.log',
          logSha256: sha256File(archivedTranscript),
          attestation: {
            operator: userInfo().username,
            host: hostname(),
            capturedAt: new Date().toISOString(),
          },
        },
      },
    };
    const receiptPath = join(outDir, 'client-claude-darwin.json');
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `\nclaude/darwin runtime: ${runtimePass ? 'PASS' : 'FAIL'} -> ${receiptPath}\n`,
    );
    if (!runtimePass) process.exitCode = 1;
  } finally {
    if (!argv.includes('--keep')) rmSync(workspace, { recursive: true, force: true });
    else process.stdout.write(`workspace kept at ${workspace}\n`);
  }
}

await main();
