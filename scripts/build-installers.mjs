import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliPackagePath = join(repoRoot, 'packages', 'cli', 'package.json');
const packageDirs = [
  'packages/soul-schema',
  'packages/core',
  'packages/parsers',
  'packages/ui',
  'packages/mcp',
  'packages/pipeline',
  'packages/cli',
];

export function normalizePackageVersion(pkg) {
  if (!pkg?.name || !pkg?.version) throw new Error('package name and version are required');
  const safeName = String(pkg.name)
    .replace(/^@/, '')
    .replace(/[^\w.-]+/g, '-');
  const version = String(pkg.version);
  return {
    name: String(pkg.name),
    version,
    tag: `${safeName}-${version}`,
  };
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function shellTarballArgs(tarballNames) {
  return tarballNames.map((name) => `"$SCRIPT_DIR/${name}"`).join(' ');
}

function powershellTarballArgs(tarballNames) {
  return tarballNames.map((name) => `"$PSScriptRoot\\${name}"`).join(' ');
}

export function installSh(tarballNames) {
  const tarballs = Array.isArray(tarballNames) ? tarballNames : [tarballNames];
  return `#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CACHE_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/knowledge-crib-npm-cache.XXXXXX")
cleanup() {
  rm -rf "$CACHE_DIR"
}
trap cleanup EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "Knowledge-crib requires Node.js 20 or newer. Install Node, then rerun this installer." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Knowledge-crib requires npm. Install Node.js with npm, then rerun this installer." >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "Could not determine the installed Node.js version." >&2
    exit 1
    ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Knowledge-crib requires Node.js 20 or newer; found Node.js $(node --version)." >&2
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/SHA256SUMS.txt" ]; then
  echo "Installer bundle is missing SHA256SUMS.txt." >&2
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then
  (cd "$SCRIPT_DIR" && shasum -a 256 -c SHA256SUMS.txt)
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$SCRIPT_DIR" && sha256sum -c SHA256SUMS.txt)
else
  echo "A SHA-256 verifier (shasum or sha256sum) is required." >&2
  exit 1
fi

npm install -g --cache "$CACHE_DIR" --no-audit --no-fund ${shellTarballArgs(tarballs)}
echo "Knowledge-crib installed. Run: crib --help"
`;
}

export function installPs1(tarballNames) {
  const tarballs = Array.isArray(tarballNames) ? tarballNames : [tarballNames];
  return `$ErrorActionPreference = "Stop"
$CacheDir = Join-Path ([System.IO.Path]::GetTempPath()) ("knowledge-crib-npm-cache-" + [System.Guid]::NewGuid().ToString("N"))

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Knowledge-crib requires Node.js 20 or newer. Install Node, then rerun this installer."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "Knowledge-crib requires npm. Install Node.js with npm, then rerun this installer."
}

$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 20) {
  throw "Knowledge-crib requires Node.js 20 or newer; found $(node --version)."
}

$ChecksumPath = Join-Path $PSScriptRoot "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $ChecksumPath -PathType Leaf)) {
  throw "Installer bundle is missing SHA256SUMS.txt."
}
$VerifiedFiles = 0
foreach ($Line in Get-Content -LiteralPath $ChecksumPath) {
  if ([string]::IsNullOrWhiteSpace($Line)) { continue }
  if ($Line -notmatch '^([a-fA-F0-9]{64})  (.+)$') {
    throw "Invalid checksum line: $Line"
  }
  $Expected = $Matches[1].ToLowerInvariant()
  $TargetPath = Join-Path $PSScriptRoot $Matches[2]
  if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
    throw "Installer bundle is missing $($Matches[2])."
  }
  $Actual = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    throw "Checksum verification failed for $($Matches[2])."
  }
  $VerifiedFiles++
}
if ($VerifiedFiles -eq 0) {
  throw "SHA256SUMS.txt did not contain any files."
}

try {
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  & npm install -g --cache "$CacheDir" --no-audit --no-fund ${powershellTarballArgs(tarballs)}
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
  }
  Write-Host "Knowledge-crib installed. Run: crib --help"
} finally {
  Remove-Item -Recurse -Force $CacheDir -ErrorAction SilentlyContinue
}
`;
}

function readCliPackage() {
  return JSON.parse(readFileSync(cliPackagePath, 'utf8'));
}

function writeText(path, text, mode) {
  writeFileSync(path, text, 'utf8');
  if (mode !== undefined) chmodSync(path, mode);
}

function run(cmd, args, opts = {}) {
  process.stdout.write(`$ ${[cmd, ...args].join(' ')}\n`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts });
}

export function buildInstallers({ outRoot = join(repoRoot, 'dist', 'installers') } = {}) {
  const pkg = readCliPackage();
  const release = normalizePackageVersion(pkg);
  const stagingDir = join(outRoot, '.staging');
  const bundleDir = join(outRoot, release.tag);

  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(bundleDir, { recursive: true });

  for (const packageDir of packageDirs) {
    run('corepack', ['pnpm@9.15.0', 'pack', '--pack-destination', stagingDir], {
      cwd: packageDir,
    });
  }

  const tarballNames = readdirSync(stagingDir)
    .filter((name) => name.endsWith('.tgz'))
    .sort((a, b) => {
      const rank = (name) => {
        const index = packageDirs.findIndex((dir) => name.includes(dir.split('/').at(-1)));
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  if (tarballNames.length !== packageDirs.length) {
    throw new Error(`Expected ${packageDirs.length} packed tarballs, found ${tarballNames.length}`);
  }

  for (const tarballName of tarballNames) {
    copyFileSync(join(stagingDir, tarballName), join(bundleDir, tarballName));
  }

  const cliTarball = tarballNames.find((name) => name === `${release.tag}.tgz`);
  if (!cliTarball) throw new Error(`Could not find CLI tarball ${release.tag}.tgz`);

  const macInstaller = 'install-macos.sh';
  const winInstaller = 'install-windows.ps1';
  writeText(join(bundleDir, macInstaller), installSh(tarballNames), 0o755);
  writeText(join(bundleDir, winInstaller), installPs1(tarballNames));

  const files = [...tarballNames, macInstaller, winInstaller];
  const checksums = files.map((file) => {
    const data = readFileSync(join(bundleDir, file));
    return { file, sha256: sha256Hex(data) };
  });

  const manifest = {
    name: release.name,
    version: release.version,
    tag: release.tag,
    package: cliTarball,
    packages: tarballNames,
    installers: {
      macos: macInstaller,
      windows: winInstaller,
    },
    checksums,
    generatedAt: new Date().toISOString(),
    requirements: {
      node: '>=20',
      npm: 'bundled with Node.js',
    },
  };

  writeText(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeText(
    join(bundleDir, 'SHA256SUMS.txt'),
    `${checksums.map((entry) => `${entry.sha256}  ${entry.file}`).join('\n')}\n`,
  );

  rmSync(stagingDir, { recursive: true, force: true });
  process.stdout.write(`Installer bundle written to ${bundleDir}\n`);
  return { bundleDir, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildInstallers();
}
