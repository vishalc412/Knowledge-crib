import { execFileSync } from 'node:child_process';
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
    run(installer.command, installer.args, {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  smokeInstall();
}
