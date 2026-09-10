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
import { assertCoversWorkspace } from './workspace-packages.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliPackagePath = join(repoRoot, 'packages', 'cli', 'package.json');
// Dependency order: a package must be packed before anything that depends on it, or the offline
// install resolves the missing one from the public registry instead. `memory` was added to the
// workspace but never added here, so every installer bundle shipped without it and `npm install`
// fell through to registry.npmjs.org for `@knowledge-crib/memory` — which is unpublished, so it
// 404'd. That is why the installer smoke test has failed on every branch since memory landed.
// Order is hand-maintained (dependency order is not derivable from the directory listing), but
// COVERAGE is asserted against the workspace: `assertCoversWorkspace` throws if a publishable
// package is missing here or a listed entry no longer exists. That is the guard the comment above
// describes needing — a new package can no longer be silently omitted from installer bundles.
const packageDirs = assertCoversWorkspace([
  'packages/soul-schema',
  'packages/core',
  'packages/parsers',
  'packages/ui',
  'packages/memory', // core + soul-schema; must precede mcp and cli, which depend on it
  'packages/mcp',
  'packages/pipeline',
  'packages/cli',
]);

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
  // Forward-slash relative specs (./<name>), NOT absolute backslash paths ("$PSScriptRoot\<name>").
  // The installer Push-Location's into $PSScriptRoot (the bundle dir) before invoking npm, so ./<name>
  // resolves against the bundle. Forward-slash relative specs pass through the PS 5.1 -> npm.cmd batch
  // shim -> node argv untouched; an absolute backslash path gets mangled in that native-arg stream
  // (middle path segments stripped -> npm sees D:\<name> -> ENOENT -4058). See installPs1() for the
  // full note.
  return tarballNames.map((name) => `"./${name}"`).join(' ');
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
  echo "Knowledge-crib requires Node.js 22.5 or newer. Install Node, then rerun this installer." >&2
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
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Knowledge-crib requires Node.js 22.5 or newer; found Node.js $(node --version)." >&2
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
echo "Knowledge-crib installed."

# Finish the job. An installer that stops at "installed" leaves the operator to find four more
# commands — index, MCP wiring, instruction files, the embedding model — in an order nothing states,
# and crib is the source of truth for a repository only once all of them have run. So when the
# current directory IS a repository, wire it now.
#
# Gated on a git work tree deliberately: \`crib setup\` indexes the directory it is pointed at, and
# doing that to whatever directory an installer happened to be launched from would be a surprise,
# not a convenience. Two opt-outs, both honoured by \`crib setup\` itself:
#   KCRIB_NO_SETUP=1  install the binary only
#   KCRIB_NO_EMBED=1  set up everything except the on-device model download
# The setup step is reported but never fatal: the binary is installed either way, and a failed
# setup is re-runnable with one command.
#
# crib is invoked through its ABSOLUTE entry point resolved from the npm prefix that was just
# installed into — never a bare \`crib\` PATH lookup. A bare lookup depends on the prefix's bin
# dir already being on the CURRENT shell's PATH: false whenever the operator set a custom npm
# prefix (npm_config_prefix), and false in any installer smoke that installs into an isolated
# prefix on purpose. The old bare form failed there SILENTLY (the || echo swallowed it), so a
# "successful" install had not actually set anything up.
if [ "\${KCRIB_NO_SETUP:-}" = "1" ]; then
  echo "KCRIB_NO_SETUP=1 - skipping repository setup. Run 'crib setup' in your project when ready."
elif command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Setting up $(pwd): index, git hooks, MCP wiring for every client, the agent protocol,"
  echo "the on-device semantic model, and the memory stores."
  NPM_PREFIX=$(npm prefix -g 2>/dev/null | head -n 1 || true)
  CRIB_ENTRY="$NPM_PREFIX/lib/node_modules/knowledge-crib/dist/cli.js"
  if [ -n "$NPM_PREFIX" ] && [ -f "$CRIB_ENTRY" ]; then
    # Make crib usable in THIS shell too (a new shell resolves it via the user PATH).
    case ":$PATH:" in
      *":$NPM_PREFIX/bin:"*) ;;
      *) PATH="$NPM_PREFIX/bin:$PATH"; export PATH ;;
    esac
    node "$CRIB_ENTRY" setup . || echo "crib setup did not complete - re-run it with 'crib setup'." >&2
  else
    echo "Could not resolve the installed crib entry point (prefix: '$NPM_PREFIX')." >&2
    echo "Run 'crib setup' from your project to finish setup." >&2
  fi
else
  echo "Not inside a git repository - run 'crib setup' from your project to finish."
fi
echo "Run: crib --help"
`;
}

export function installPs1(tarballNames) {
  const tarballs = Array.isArray(tarballNames) ? tarballNames : [tarballNames];
  return `$ErrorActionPreference = "Stop"
# Compute a lowercase hex SHA-256 of a file via the .NET crypto API rather than the Get-FileHash
# cmdlet. Get-FileHash ships in Microsoft.PowerShell.Utility on Windows PowerShell 5.1+, but some
# stock 5.1 hosts (notably GitHub windows-latest runners invoked as \`powershell.exe -NoProfile\`)
# fail to auto-load it — "The term 'Get-FileHash' is not recognized" — breaking the installer for
# real users on those hosts. [System.Security.Cryptography.SHA256] is available in Windows
# PowerShell 3.0+ and PowerShell 7, so this is strictly more portable and removes the cmdlet
# dependency. Streaming (OpenRead + ComputeHash(stream)) keeps large tarballs off the heap.
function Get-KcFileHash {
  param([Parameter(Mandatory)][string]$LiteralPath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
      return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}
$CacheDir = Join-Path ([System.IO.Path]::GetTempPath()) ("knowledge-crib-npm-cache-" + [System.Guid]::NewGuid().ToString("N"))

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Knowledge-crib requires Node.js 22.5 or newer. Install Node, then rerun this installer."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "Knowledge-crib requires npm. Install Node.js with npm, then rerun this installer."
}

$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 22) {
  throw "Knowledge-crib requires Node.js 22.5 or newer; found $(node --version)."
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
  $Actual = Get-KcFileHash -LiteralPath $TargetPath
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
  # Install from the bundle dir so the ./<name> tarball specs resolve as local files. Push-Location
  # into $PSScriptRoot (the bundle dir) so npm's CWD is the bundle, then pass forward-slash relative
  # specs. We deliberately do NOT pass "$PSScriptRoot\<name>" here: Windows PowerShell 5.1 hands
  # native-command arguments to npm.cmd through cmd.exe's %* expansion, which mangles quoted
  # backslash paths — the middle path segments get stripped and npm resolves the arg to the drive root
  # (e.g. D:\knowledge-crib-parsers-0.1.0.tgz -> ENOENT -4058, "no such file or directory, open"). The
  # checksum loop above is immune because Join-Path yields an in-process PathInfo used with -LiteralPath
  # (never serialized to a native argv); only this native call serializes a path, so it must avoid
  # backslashes + absolute paths. ./<name> has no backslashes and no escape semantics in any shell, so
  # it survives PS 5.1 -> npm.cmd -> node verbatim, and npm resolves it against CWD ($PSScriptRoot).
  Push-Location -LiteralPath $PSScriptRoot
  try {
    & npm install -g --cache "$CacheDir" --no-audit --no-fund ${powershellTarballArgs(tarballs)}
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code $LASTEXITCODE."
    }
    Write-Host "Knowledge-crib installed."
  } finally {
    Pop-Location
  }

  # Same reasoning as the shell installer: finish the setup rather than hand the operator four more
  # commands. Runs AFTER Pop-Location, so it targets the directory the installer was launched from
  # and never the bundle directory. Opt out with KCRIB_NO_SETUP=1 (binary only) or KCRIB_NO_EMBED=1
  # (everything except the model download). Never fatal - the binary is installed either way.
  #
  # crib runs through its ABSOLUTE entry point resolved from the npm prefix npm just installed
  # into - never a bare \`crib\` PATH lookup. The bare form failed on any host where the prefix's
  # bin dir is not on the CURRENT process PATH: custom npm prefixes (npm_config_prefix), and
  # every installer smoke that installs into an isolated prefix on purpose. This is the exact
  # windows-latest installer failure - \`The term 'crib' is not recognized\` at the setup step.
  # Whether this directory is a git work tree, asked in a way that SURVIVES the answer being "no".
  # \`2>$null\` does not suppress a native command's stderr in PowerShell the way it does in a POSIX
  # shell: git writing "fatal: not a git repository" produces a NativeCommandError record, and under
  # this script's \`$ErrorActionPreference = "Stop"\` that record TERMINATES the installer. The macOS
  # installer takes its no-op branch quietly in the same situation, so installing outside a
  # repository worked everywhere except Windows — where it failed after the package was already
  # installed, leaving a successful install reported as a failed one. Merging stderr into the output
  # stream under a local Continue preference, and judging by $LASTEXITCODE, asks the question
  # without making the negative answer fatal.
  $InsideWorkTree = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $PreviousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $GitAnswer = (& git rev-parse --is-inside-work-tree 2>&1) | Out-String
    $ErrorActionPreference = $PreviousPreference
    $InsideWorkTree = ($LASTEXITCODE -eq 0 -and $GitAnswer.Trim() -eq "true")
  }
  if ($env:KCRIB_NO_SETUP -eq "1") {
    Write-Host "KCRIB_NO_SETUP=1 - skipping repository setup. Run 'crib setup' in your project when ready."
  } elseif ($InsideWorkTree) {
    Write-Host "Setting up $((Get-Location).Path): index, git hooks, MCP wiring for every client,"
    Write-Host "the agent protocol, the on-device semantic model, and the memory stores."
    $NpmPrefix = (& npm prefix -g | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($NpmPrefix)) { $NpmPrefix = Join-Path $env:APPDATA "npm" }
    $CribEntry = Join-Path $NpmPrefix "node_modules\\knowledge-crib\\dist\\cli.js"
    if (Test-Path -LiteralPath $CribEntry) {
      # Immediate availability in THIS process (a new shell resolves crib via the user PATH).
      if (-not ($env:Path -split ';' -contains $NpmPrefix)) { $env:Path = "$NpmPrefix;$env:Path" }
      & node $CribEntry setup .
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "crib setup did not complete - re-run it with 'crib setup'."
      }
    } else {
      Write-Warning "Could not resolve the installed crib entry point under $NpmPrefix - run 'crib setup' from your project."
    }
  } else {
    Write-Host "Not inside a git repository - run 'crib setup' from your project to finish."
  }
  Write-Host "Run: crib --help"
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
  // On Windows, `corepack` is a .cmd shim; execFileSync (shell: false) cannot launch .cmd files
  // directly (ENOENT). Use a shell there so the windows-latest installer:build cell stays green.
  // Same convention as scripts/release-verify.mjs.
  execFileSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
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
      node: '>=22.5.0',
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
