import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, memoryRecordId } from '../packages/memory/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

export function expectedBinPaths(prefix, platform = process.platform) {
  if (platform === 'win32') {
    const bin = path.win32.join(prefix, 'crib.cmd');
    return {
      bin,
      primary: bin,
      direct: path.win32.join(prefix, 'node_modules', 'knowledge-crib', 'dist', 'cli.js'),
    };
  }

  const bin = path.posix.join(prefix, 'bin', 'crib');
  return {
    bin,
    primary: bin,
    direct: path.posix.join(prefix, 'lib', 'node_modules', 'knowledge-crib', 'dist', 'cli.js'),
  };
}

export function installedBinCommand(bin, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    // Pass the .cmd path and --help as SEPARATE args (no pre-quoting, no /s). run() invokes this
    // via execFileSync with shell:false, so Node escapes each arg for the cmd.exe command line
    // itself. The earlier form — a single pre-quoted arg `"/c", `"${bin}" --help"` — was double-
    // escaped: Node re-wrapped that one arg (spaces + embedded quotes) and escaped the inner
    // quotes to `\"`, so cmd.exe /s /c received `\"C:\…\crib.cmd\" --help` and treated the literal
    // `\"…\"` as the program name ("is not recognized as an internal or external command").
    // With separate args Node quotes only a spaced path (`"C:\Program Files\…\crib.cmd"`), and
    // cmd.exe /c's quote rule resolves the program + passes --help through — for both spaced and
    // non-spaced paths. /s is dropped: it disabled the helpful /c quote-stripping that made the
    // spaced-path case work.
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', bin, '--help'],
    };
  }

  return { command: bin, args: ['--help'] };
}

export function installerCommand(bundleDir, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.win32.join(bundleDir, 'install-windows.ps1'),
      ],
    };
  }

  return { command: 'sh', args: [path.posix.join(bundleDir, 'install-macos.sh')] };
}

export function findInstallerBundle(outRoot = join(repoRoot, 'dist', 'installers')) {
  if (!existsSync(outRoot)) throw new Error(`No installer bundles found under ${outRoot}`);
  const candidates = readdirSync(outRoot)
    .filter((name) => name.startsWith('knowledge-crib-'))
    .map((name) => {
      const bundleDir = join(outRoot, name);
      const manifestPath = join(bundleDir, 'manifest.json');
      if (!existsSync(manifestPath)) return undefined;
      return {
        bundleDir,
        manifestPath,
        mtimeMs: statSync(manifestPath).mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!candidates[0]) throw new Error(`No installer bundles found under ${outRoot}`);
  return candidates[0];
}

function run(cmd, args, opts = {}) {
  process.stdout.write(`$ ${[cmd, ...args].join(' ')}\n`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function runCapture(cmd, args, opts = {}) {
  process.stdout.write(`$ ${[cmd, ...args].join(' ')}\n`);
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

export function validateSmokeStatus(status) {
  if (status?.indexed !== true) {
    throw new Error('Installed CLI smoke did not produce an indexed graph');
  }
  if (!Number.isFinite(status?.stats?.nodes) || status.stats.nodes <= 0) {
    throw new Error('Installed CLI smoke did not extract any nodes');
  }
  return status;
}

export function npmInstallArgs(prefix, tarballs) {
  const allTarballs = Array.isArray(tarballs) ? tarballs : [tarballs];
  return [
    'install',
    '-g',
    '--prefix',
    prefix,
    '--cache',
    join(prefix, '.npm-cache'),
    '--fetch-retries',
    '1',
    '--fetch-retry-mintimeout',
    '1000',
    '--fetch-retry-maxtimeout',
    '5000',
    '--fetch-timeout',
    '15000',
    '--no-audit',
    '--no-fund',
    ...allTarballs,
  ];
}

export function smokeInstall({ outRoot = join(repoRoot, 'dist', 'installers') } = {}) {
  const bundle = findInstallerBundle(outRoot);

  const manifest = JSON.parse(readFileSync(bundle.manifestPath, 'utf8'));
  const packageNames = manifest.packages ?? [manifest.package];
  const tarballs = packageNames.map((name) => join(bundle.bundleDir, name));
  for (const tarball of tarballs) {
    if (!existsSync(tarball))
      throw new Error(`Installer bundle is missing package tarball: ${tarball}`);
  }

  const prefix = mkdtempSync(join(tmpdir(), 'knowledge-crib-install-'));
  try {
    const installer = installerCommand(bundle.bundleDir);
    // install-macos.sh (WP1 convenience) runs `crib setup .` against whatever directory it is
    // invoked from, gated on that directory being inside a git work tree. Without an isolated
    // cwd here, that "wherever it is invoked from" is THIS SCRIPT'S caller — the developer's own
    // checkout when this smoke runs locally — and setup would silently rewrite its real adapter
    // configs (.mcp.json, .codex/config.toml, .gemini/settings.json). `prefix` is a fresh tmpdir
    // and never a git repo, so the installer's auto-setup step takes its "not inside a git
    // repository" no-op branch instead (see the plan rule: an evidence run must not dirty the
    // checkout it certifies).
    run(installer.command, installer.args, {
      cwd: prefix,
      env: { ...process.env, npm_config_prefix: prefix },
    });

    const bins = expectedBinPaths(prefix);
    if (!existsSync(bins.direct)) {
      throw new Error(`Installed package did not contain its CLI entry point at ${bins.direct}`);
    }
    if (existsSync(bins.primary)) {
      const invocation = installedBinCommand(bins.primary);
      run(invocation.command, invocation.args);
    } else {
      run(process.execPath, [bins.direct, '--help']);
    }

    const projectRoot = join(prefix, 'smoke-project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ name: 'installed-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
    );
    writeFileSync(
      join(projectRoot, 'src', 'math.ts'),
      'export function triple(value: number): number {\n  return value * 3;\n}\n',
    );

    run(process.execPath, [bins.direct, 'index', projectRoot]);
    const status = validateSmokeStatus(
      JSON.parse(runCapture(process.execPath, [bins.direct, 'status', projectRoot])),
    );
    process.stdout.write(
      `installer smoke ok - installed ${manifest.package}; indexed ${status.stats.nodes} nodes\n`,
    );
    return status;
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

/**
 * WP1.6 — the spaces/non-ASCII user-dir scenario. `Users/jöhn doe` exercises BOTH failure families at
 * once: the space breaks unquoted shell/argv path handling, and the non-ASCII ö breaks any
 * byte-oriented path assumption (and on Windows would land in a different code page under cmd.exe).
 * Everything user-scoped hangs off that home: the npm global prefix, the crib project, and the client
 * MCP config, so the whole install → configure → reinstall → uninstall cycle runs under it.
 */
export function userDirScenarioPaths(root) {
  const home = join(root, 'Users', 'jöhn doe');
  return {
    home,
    prefix: join(home, 'npm-global'),
    project: join(home, 'Projects', 'smoke project'),
  };
}

/** Env under which the installer + installed CLI must both work for a relocated user dir. */
export function userDirEnv(paths) {
  // HOME (darwin/linux) and USERPROFILE (win32) are what Node's os.homedir() reads — crib resolves
  // its user-scoped paths through homedir(), so pointing both at the scenario home relocates every
  // user-scoped write the CLI makes. npm picks the prefix up from npm_config_prefix.
  return {
    ...process.env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    npm_config_prefix: paths.prefix,
  };
}

// ─── WP7.6 — the uninstall-with-memory fixture ─────────────────────────────────
//
// The config-preservation legs above prove the CLIENT CONFIG survives reinstall/uninstall, but a
// user's real fear is their MEMORY (`.crib/memory`). This fixture seeds one record into each store
// the smoke can reach — a global record under the scenario home's `~/.crib/memory/global` and a
// team record under the scenario project's `.crib/memory/team` (the `paths.ts` layout: local +
// global live under `~/.crib`, team inside the repo) — then requires the SAME records to answer
// recall from the REINSTALLED bin with byte-identical store files.

/** The two memory store roots the user-dir scenario seeds + digests (the paths.ts layout). */
export function scenarioMemoryRoots(paths) {
  return {
    global: join(paths.home, '.crib', 'memory', 'global'),
    team: join(paths.project, '.crib', 'memory', 'team'),
  };
}

/**
 * The repoId the installed `crib index` minted for the scenario project (the team record's scope
 * must carry it, and it must match what the reinstalled bin resolves on recall). `readRepoId`'s
 * resolution order mirrored: `<cribDir>/crib.json` first, then the registry under the scenario home.
 */
export function scenarioRepoId(paths) {
  const cribJson = join(paths.project, '.crib', 'crib.json');
  try {
    const id = JSON.parse(readFileSync(cribJson, 'utf8'))?.repo?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  } catch {
    // unreadable/absent manifest → fall through to the registry
  }
  try {
    const registry = JSON.parse(readFileSync(join(paths.home, '.crib', 'registry.json'), 'utf8'));
    const cribDir = resolve(paths.project, '.crib');
    const entry = Object.values(registry?.projects ?? {}).find(
      (candidate) => resolve(candidate?.cribDir ?? '') === cribDir,
    );
    if (typeof entry?.repoId === 'string' && entry.repoId.length > 0) return entry.repoId;
  } catch {
    // unreadable/absent registry → fall through to the throw
  }
  throw new Error(`could not resolve the scenario project's repoId under ${paths.project}`);
}

/**
 * A recall-eligible record for the smoke fixture: a `decision` carried by a human attestation
 * (admissible for decisions, and it needs NO code anchor — `revalidateHumanAttestation` keeps it
 * valid+current, so the fixture asserts survival, not grounding). Content-addressed id via the
 * memory package's own `memoryRecordId`, mirroring the repo's memory test fixtures.
 */
export function smokeMemoryRecord({ kind = 'decision', subject, claim, scope, actor, at }) {
  const evidence = [
    {
      kind: 'human-attestation',
      verdict: 'valid',
      checkedAt: at,
      actor,
      tty: true,
      attestedAt: at,
    },
  ];
  const input = {
    kind,
    subject,
    claim,
    scope,
    appliesTo: [],
    evidence,
    authorship: { actor, kind: 'agent', tool: 'knowledge-crib install smoke' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: at,
  };
}

/** SHA-256 every regular file under `rootDir`, keyed by path relative to `rootDir`. */
export function fileDigests(rootDir) {
  if (!existsSync(rootDir)) return {};
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) {
        out[path.relative(rootDir, target)] = createHash('sha256')
          .update(readFileSync(target))
          .digest('hex');
      }
    }
  };
  walk(rootDir);
  return out;
}

/**
 * Seed both stores through the memory package API and capture the survival contract: the record
 * ids + a digest of every file under each store root, taken AFTER the last write so the baseline
 * is exactly what an uninstall+reinstall must leave untouched.
 *
 * `KCRIB_MEMORY_DIR` pins the seeding to `<scenario home>/.crib/memory` explicitly: `memoryHome`
 * falls back to `os.homedir()` of THIS harness process when the override is absent, and that
 * homedir is the real user home, not the scenario home the `env` object carries. The path is the
 * same one the installed bin resolves on recall (its subprocess reads `HOME` from `env`).
 */
export function seedScenarioMemory({ paths, env, at = new Date().toISOString() }) {
  const repoId = scenarioRepoId(paths);
  const storeEnv = { ...env, KCRIB_MEMORY_DIR: join(paths.home, '.crib', 'memory') };
  const globalRecord = smokeMemoryRecord({
    subject: 'topic:install-smoke',
    claim: 'knowledge-crib install smoke: global memory survives uninstall and reinstall',
    scope: { boundary: 'global' },
    actor: 'install-smoke',
    at,
  });
  const teamRecord = smokeMemoryRecord({
    subject: 'topic:install-smoke',
    claim: 'knowledge-crib install smoke: team memory survives uninstall and reinstall',
    scope: { boundary: 'repo', repoId },
    actor: 'install-smoke',
    at,
  });
  MemoryStore.global({ env: storeEnv }).upsertEntries('records', [globalRecord]);
  MemoryStore.team(join(paths.project, '.crib'), {
    repoRoot: paths.project,
    env: storeEnv,
  }).upsertEntries('records', [teamRecord]);

  const roots = scenarioMemoryRoots(paths);
  return {
    records: { global: globalRecord, team: teamRecord },
    roots,
    digests: { global: fileDigests(roots.global), team: fileDigests(roots.team) },
  };
}

/**
 * The survival verdict: every seeded record id must still be returned by the reinstalled bin's
 * recall, and every store file must be byte-identical (no file added, removed, or rewritten).
 * `recall` is the parsed `crib memory recall --json` projection; `digests` the post-cycle digests
 * in the same `{ global, team }` shape `seedScenarioMemory` captured.
 */
export function validateMemorySurvived({ seed, recall, digests }) {
  const ids = new Set((recall?.memories ?? []).map((m) => m?.id));
  for (const [name, record] of Object.entries(seed.records)) {
    if (!ids.has(record.id)) {
      throw new Error(
        `memory record ${name} (${record.id}) did not survive uninstall + reinstall — recall did not return it`,
      );
    }
  }
  for (const name of Object.keys(seed.digests)) {
    const before = seed.digests[name];
    const after = digests?.[name] ?? {};
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (rel) => before[rel] !== after[rel],
    );
    if (changed.length > 0) {
      throw new Error(
        `memory store "${name}" changed across uninstall + reinstall: ${changed.join(', ')}`,
      );
    }
  }
  return true;
}

/**
 * WP1.6 smoke: install → verify → index → wire client config → REINSTALL (upgrade) with the client
 * config preserved → seed memory → UNINSTALL with the client config + memory preserved →
 * REINSTALL and prove the SAME memory records still answer recall, byte-identical (WP7.6). Every
 * path in the flow sits under a `Users/jöhn doe`-style home (space + non-ASCII) on the platform's
 * native separator.
 */
export function smokeUserDirInstall({ outRoot = join(repoRoot, 'dist', 'installers') } = {}) {
  const bundle = findInstallerBundle(outRoot);
  const manifest = JSON.parse(readFileSync(bundle.manifestPath, 'utf8'));

  const root = mkdtempSync(join(tmpdir(), 'knowledge-crib-userdir-'));
  const paths = userDirScenarioPaths(root);
  const env = userDirEnv(paths);
  try {
    mkdirSync(paths.home, { recursive: true });

    // install — the bundle scripts must survive a HOME/prefix containing a space and non-ASCII.
    const installer = installerCommand(bundle.bundleDir);
    // See smokeInstall's matching comment: without an isolated cwd, install-macos.sh's
    // post-install `crib setup .` runs against this script's own invoker (the developer's real
    // checkout when run locally) instead of the scenario's throwaway home. `paths.home` is never
    // a git work tree, so the installer's auto-setup step no-ops there.
    run(installer.command, installer.args, { cwd: paths.home, env });

    const bins = expectedBinPaths(paths.prefix);
    if (!existsSync(bins.primary)) {
      throw new Error(`Installer did not place the bin at ${bins.primary}`);
    }
    if (!existsSync(bins.direct)) {
      throw new Error(`Installed package did not contain its CLI entry point at ${bins.direct}`);
    }

    // The installed bin itself is invoked through its spaced path (installedBinCommand quotes it
    // correctly per platform — see its own doc comment for the cmd.exe escaping history).
    const invocation = installedBinCommand(bins.primary);
    run(invocation.command, invocation.args, { env });

    // index + status a project that ALSO lives under the spaced home.
    mkdirSync(join(paths.project, 'src'), { recursive: true });
    writeFileSync(
      join(paths.project, 'package.json'),
      `${JSON.stringify({ name: 'user-dir-smoke', private: true, type: 'module' }, null, 2)}\n`,
    );
    writeFileSync(
      join(paths.project, 'src', 'math.ts'),
      'export function triple(value: number): number {\n  return value * 3;\n}\n',
    );
    run(process.execPath, [bins.direct, 'index', paths.project], { env });
    validateSmokeStatus(
      JSON.parse(runCapture(process.execPath, [bins.direct, 'status', paths.project], { env })),
    );

    // Wire a client MCP config: the embedded command must carry the SPACED bin path verbatim.
    // project scope is cmdMcp's default (`--global` switches it); --bin pins the embedded command
    // to the installed bin so the smoke does not depend on `which crib` finding the temp prefix.
    run(
      process.execPath,
      [bins.direct, 'mcp', 'install', '--ide', 'claude', '--bin', bins.primary],
      {
        cwd: paths.project,
        env,
      },
    );
    const mcpConfigPath = join(paths.project, '.mcp.json');
    if (!existsSync(mcpConfigPath)) {
      throw new Error(`crib mcp install did not write ${mcpConfigPath}`);
    }
    const entry = JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers?.['knowledge-crib'];
    if (!entry) {
      throw new Error(`${mcpConfigPath} has no knowledge-crib server entry`);
    }
    if (entry.command !== bins.primary) {
      throw new Error(
        `client config command does not carry the spaced bin path: expected ${bins.primary}, got ${entry.command}`,
      );
    }
    const configBeforeReinstall = readFileSync(mcpConfigPath, 'utf8');

    // reinstall (the same flow an upgrade takes): the install must be idempotent AND must not
    // clobber the client config the earlier install wrote. cwd: paths.home, same reason as above.
    run(installer.command, installer.args, { cwd: paths.home, env });
    if (!existsSync(bins.primary)) {
      throw new Error('Reinstall did not leave the bin in place');
    }
    run(invocation.command, invocation.args, { env });
    if (readFileSync(mcpConfigPath, 'utf8') !== configBeforeReinstall) {
      throw new Error(
        'Reinstall modified the client MCP config — PATH + client config must be preserved',
      );
    }

    // WP7.6 — seed REAL memory before the destructive leg: one global record in the scenario
    // home's ~/.crib/memory plus one team record in <project>/.crib/memory, with ids + file
    // digests captured. The config legs above cannot speak for this data: a user who reinstalls
    // must get their MEMORY back, not just their client config.
    const seed = seedScenarioMemory({ paths, env });

    // uninstall: the package leaves, the client config the user already wired STAYS.
    // manifest.name is the npm package name ("knowledge-crib"); manifest.package is the tarball
    // filename, which npm rm would not accept.
    run('npm', ['rm', '-g', '--prefix', paths.prefix, manifest.name], { env });
    if (existsSync(bins.primary) || existsSync(bins.direct)) {
      throw new Error(`Uninstall left crib files behind under ${paths.prefix}`);
    }
    if (!existsSync(mcpConfigPath)) {
      throw new Error('Uninstall removed the client MCP config — it must be preserved');
    }
    if (readFileSync(mcpConfigPath, 'utf8') !== configBeforeReinstall) {
      throw new Error('Uninstall modified the client MCP config — it must be preserved');
    }

    // WP7.6 — reinstall after the uninstall, then prove the seeded memory survived the whole
    // client-removal/uninstall/reinstall cycle: the same records answer recall through the
    // REINSTALLED bin and the store files are byte-identical. cwd: paths.home, same reason above.
    run(installer.command, installer.args, { cwd: paths.home, env });
    if (!existsSync(bins.primary)) {
      throw new Error('Reinstall after the uninstall did not restore the bin');
    }
    const recall = JSON.parse(
      runCapture(
        process.execPath,
        [bins.direct, 'memory', 'recall', 'memory survives uninstall', '--json'],
        {
          cwd: paths.project,
          env,
        },
      ),
    );
    validateMemorySurvived({
      seed,
      recall,
      digests: {
        global: fileDigests(seed.roots.global),
        team: fileDigests(seed.roots.team),
      },
    });
    if (readFileSync(mcpConfigPath, 'utf8') !== configBeforeReinstall) {
      throw new Error(
        'Reinstall after uninstall modified the client MCP config — it must be preserved',
      );
    }

    process.stdout.write(
      `user-dir smoke ok - install/reinstall/uninstall/reinstall under ${paths.home}; client config + memory preserved\n`,
    );
    return { home: paths.home, prefix: paths.prefix };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--user-dir')) smokeUserDirInstall();
  else smokeInstall();
}
