/**
 * Certify ONE client/platform cell with a real vendor run.
 *
 * The distinction this script exists to respect: a harness that speaks MCP proves the protocol, not
 * the client. What certifies a cell is the VENDOR'S OWN APPLICATION launching the candidate build,
 * completing a handshake, calling tools, and — after its process is killed — restarting and
 * recovering an authorized session. So every driver below drives a real vendor binary; none of them
 * can produce a certifying receipt by speaking the protocol itself.
 *
 * ONE harness, seven drivers. The clients differ in what they are CALLED, how they report a version,
 * how they report being signed in, where their MCP config lives, and how one non-interactive turn is
 * issued. Those differences are a table ({@link CLIENT_SPECS}); the eleven behaviours the promise
 * requires are {@link CERTIFICATION_BEHAVIOURS}, verified once, for every client. Seven bespoke
 * implementations of the same eleven checks would be eleven chances to forget one — the failure this
 * shape removes structurally rather than by review.
 *
 * Usage:
 *   node scripts/client-certify.mjs --client <id> --package <tarball> \
 *     --candidate-commit <sha> --out <receipts-dir> [--keep]
 *
 * WHAT IS NOT ARCHIVED. The transcript this script writes is the artifact a receipt hashes, and it
 * must be safe to attach to a public release. So:
 *   * SECRETS are absent by construction — the harness reads exit statuses, never credentials, and
 *     the vendor clients read their own profiles. No step prints an environment value.
 *   * RAW PROMPTS are absent by construction — a turn is logged as `<bin> -p <redacted prompt:
 *     sha256:…>`, so the prompt is checkable without being present. Redacting at the logging
 *     boundary is a property of the file, not a scrubbing pass that can miss one.
 *   * MEMORY BODIES are absent because no tool RESULT is logged verbatim: the harness logs exit
 *     status, and a marker token it minted itself. The one exception is a bounded, redacted tail of
 *     client output, kept because "the client printed nothing and exited 1" is undiagnosable without
 *     it.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERTIFIED_CLIENTS } from './client-certification-evidence.mjs';
import {
  RECORDER_VERSION,
  findCompletedOperation,
  operationCount,
  recordingProblems,
  serverCommandSha256,
} from './client-protocol-recorder.mjs';
import { loadLaunchPolicy } from './launch-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Bumped when a driver's behaviour changes, so a receipt names the driver that produced it. */
export const DRIVER_VERSION = '1.0.0';

/**
 * The eleven behaviours every driver must attempt, in the order they are attempted.
 *
 * The harness verifies this list against the driver — a driver that silently stops attempting one
 * fails at the checklist rather than shipping a receipt that is quietly narrower than the promise.
 */
export const CERTIFICATION_BEHAVIOURS = [
  {
    id: 'vendorBinaryResolved',
    phase: 'preflight',
    requirement: 'the vendor binary exists and reports a version',
  },
  {
    id: 'vendorAuthenticated',
    phase: 'preflight',
    requirement: 'the vendor client is signed in — a signed-out client certifies nothing',
  },
  {
    id: 'configGeneratedByInstaller',
    phase: 'configure',
    requirement: 'the MCP config came from the shipped `crib mcp install` path, not a hand-write',
  },
  {
    id: 'configTargetsInstalledCandidate',
    phase: 'configure',
    requirement: 'that config launches the INSTALLED candidate package, not a source checkout',
  },
  {
    id: 'handshakeThroughVendorClient',
    phase: 'invoke',
    requirement: 'the vendor client completes an MCP handshake with the candidate',
  },
  {
    id: 'toolInvocationThroughVendorClient',
    phase: 'invoke',
    requirement: 'the vendor client invokes a crib tool and the result returns to it',
  },
  {
    id: 'authorizedRecordThroughVendorClient',
    phase: 'invoke',
    requirement: 'the vendor client records a uniquely tagged authorized intake',
  },
  {
    id: 'vendorProcessInterrupted',
    phase: 'interrupt',
    requirement: 'the VENDOR CLIENT process is killed mid-session — not merely its MCP subprocess',
  },
  {
    id: 'vendorProcessRestarted',
    phase: 'restartAndResume',
    requirement: 'a fresh vendor client process starts against the same state',
  },
  {
    id: 'authorizedSessionResumed',
    phase: 'restartAndResume',
    requirement: 'that process recovers the authorized session the killed one recorded',
  },
  {
    id: 'foreignPrincipalExclusion',
    phase: 'restartAndResume',
    requirement: "another principal's durable work never reaches the owner",
  },
];

/**
 * The eight legs, mapped from the eleven behaviours. The legs are what the RECEIPT carries, because
 * they are the promise; the behaviours are how the harness checks itself, because they are finer.
 * `vendorProcessInterrupted` covers two legs, which is exactly the pair a version-1 receipt recorded
 * as one fact and therefore could never certify.
 */
export const LEG_BEHAVIOURS = {
  configuration: ['configGeneratedByInstaller', 'configTargetsInstalledCandidate'],
  handshake: ['handshakeThroughVendorClient'],
  toolUse: ['toolInvocationThroughVendorClient'],
  record: ['authorizedRecordThroughVendorClient'],
  interruption: ['vendorProcessInterrupted'],
  restart: ['vendorProcessRestarted'],
  authorizedResume: ['authorizedSessionResumed'],
  foreignPrincipalExclusion: ['foreignPrincipalExclusion'],
};

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

const sha256 = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const sha256File = (path) =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

/**
 * Sanitize a bounded window of client output for the archived transcript.
 *
 * The last resort, not the first line of defence: prompts and tool results are already never logged
 * verbatim. This catches the residue — a client that echoes back a credential it read from its own
 * profile, or a memory body that arrived in an error message. Deliberately over-eager: a redaction
 * that fires on innocent text costs a readable log, and one that misses costs a leaked secret.
 */
export function sanitizeOutput(text, extraRedactions = []) {
  let out = String(text ?? '');
  for (const needle of extraRedactions) {
    if (needle) out = out.split(needle).join('<redacted:marker>');
  }
  return (
    out
      .replace(/\b(sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, '<redacted:token>')
      .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer <redacted>')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted:jwt>')
      .replace(
        /("?(?:api[_-]?key|token|secret|password|authorization)"?\s*[:=]\s*)"[^"]*"/gi,
        '$1"<redacted>"',
      )
      // The UNQUOTED form, which is how these appear in the places that matter most: a shell export,
      // a `--token=…` argument, a client's own diagnostics. Length-gated at 6 characters so ordinary
      // prose ("token: none") survives — over-eager here costs a readable log; a miss costs a secret.
      .replace(
        /\b((?:api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password)\s*[:=]\s*)(?![<"'])(\S{6,})/gi,
        '$1<redacted>',
      )
  );
}

/** Append to the transcript AND echo, so a watching operator sees the same bytes the receipt hashes. */
function makeLog(path) {
  return (line) => {
    const text = String(line);
    appendFileSync(path, `${text}\n`);
    process.stdout.write(`${text}\n`);
  };
}

/**
 * The command line of a live process, or undefined when it cannot be read.
 *
 * Needed because the interruption leg's whole claim is "the VENDOR CLIENT was killed". A PID on its
 * own cannot support that claim: the vendor client spawns an MCP server child, and a harness that
 * killed the child and called it an interruption would be certifying a leg it never exercised. So
 * the identity of the process is read BEFORE it is killed and recorded with the leg.
 */
export function processCommand(pid) {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined;
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    }
    if (process.platform === 'win32') {
      const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
      }).trim();
      const name = /^"([^"]+)"/.exec(csv)?.[1];
      return name || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Kill a process AND its children.
 *
 * On POSIX the child is spawned `detached`, so it leads its own process group — killing the GROUP is
 * what makes the interruption honest for a client that spawned helpers. On Windows `taskkill /T`
 * walks the tree. Either way the TARGET is the vendor process, and its identity was verified by the
 * caller first.
 */
export function killProcessTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    return result.status === 0;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Is this a WSL host?
 *
 * WSL reports `process.platform === 'linux'` from a Windows machine. It is not a native Linux
 * runtime and can never satisfy a native linux cell, so the harness must DISCOVER this rather than
 * leave the field absent — an absent flag reads as "native", which is the claim under test.
 */
export function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// ─── the driver table ───────────────────────────────────────────────────────────────────────────
//
// `installerIde` is the id passed to `crib mcp install --ide`, and it is NOT always the client id:
// GitHub Copilot reuses VS Code's MCP config (`packages/cli/src/adapters.ts`), so asking the
// installer for `copilot` would be asking it for a writer that does not exist.
//
// `configRelPath` is where each client looks for that config, taken from the shipped writers in
// `packages/cli/src/mcp-install.ts` — so the harness and the installer agree by construction rather
// than by a second copy of the layout that can drift. `projectScoped: true` means the client finds
// it by cwd, which is why those drivers pass no flag and let a wrong assumption fail loudly at the
// handshake instead of silently running against no server.
//
// `headless: null` marks a client with NO non-interactive entrypoint. The vendored editors run their
// agent inside a GUI session; there is no supported way to drive one turn from a shell. That is a
// real, permanent limit of the vendor runtime — so those drivers report BLOCKED by name and cannot
// certify, which is the honest outcome and the one the launch policy requires.
const CLIENT_SPECS = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    binaries: ['claude'],
    versionArgs: ['--version'],
    installerIde: 'claude',
    configRelPath: ['.mcp.json'],
    configFormat: 'json-mcpServers',
    projectScoped: true,
    authProbe: { args: ['auth', 'status'], parse: (out) => JSON.parse(out)?.loggedIn === true },
    authHint:
      'Run `claude auth login`. The CLI keeps its own credentials — a signed-in desktop app does not cover it.',
    headless: {
      args: (prompt, ctx) => [
        '-p',
        prompt,
        '--mcp-config',
        ctx.configPath,
        // Only crib's own verbs are allowed, so a run cannot wander into the filesystem or the
        // network to satisfy a prompt. (`--max-turns` does not exist in Claude Code 2.1.x — the
        // bound is the allowlist plus the per-call timeout, not a turn counter.)
        '--allowedTools',
        'mcp__knowledge-crib__query,mcp__knowledge-crib__memory,mcp__knowledge-crib__memory_observe,mcp__knowledge-crib__memory_recall,mcp__knowledge-crib__status',
      ],
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    binaries: ['codex'],
    versionArgs: ['--version'],
    installerIde: 'codex',
    configRelPath: ['.codex', 'config.toml'],
    configFormat: 'toml',
    projectScoped: false,
    // Codex reads its MCP servers from $CODEX_HOME/config.toml, so the run points CODEX_HOME at the
    // scenario's own tree. That is the isolation: the operator's real ~/.codex is never read.
    homeEnvVar: 'CODEX_HOME',
    homeRelPath: '.codex',
    authProbe: {
      args: ['login', 'status'],
      parse: (out, status) => status === 0 || /logged in/i.test(out),
    },
    authHint: 'Run `codex login`.',
    headless: { args: (prompt) => ['exec', prompt] },
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    binaries: ['cursor-agent', 'cursor'],
    versionArgs: ['--version'],
    installerIde: 'cursor',
    configRelPath: ['.cursor', 'mcp.json'],
    configFormat: 'json-mcpServers',
    projectScoped: true,
    authProbe: {
      args: ['status'],
      parse: (out, status) => status === 0 && !/not (logged in|authenticated)/i.test(out),
    },
    authHint: 'Run `cursor-agent login` (or sign in through the Cursor editor).',
    headless: { args: (prompt) => ['-p', prompt] },
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    binaries: ['gemini'],
    versionArgs: ['--version'],
    installerIde: 'gemini',
    configRelPath: ['.gemini', 'settings.json'],
    configFormat: 'json-mcpServers',
    projectScoped: true,
    authProbe: { args: ['--version'], parse: (_out, status) => status === 0 },
    authHint:
      'Set the credential the Gemini CLI expects (GEMINI_API_KEY, or sign in for the free tier).',
    headless: { args: (prompt) => ['-p', prompt] },
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binaries: ['copilot'],
    versionArgs: ['--version'],
    installerIde: 'vscode', // Copilot reuses VS Code's MCP config — see packages/cli/src/adapters.ts
    configRelPath: ['.vscode', 'mcp.json'],
    configFormat: 'json-servers',
    projectScoped: true,
    authProbe: { args: ['--version'], parse: (_out, status) => status === 0 },
    authHint:
      'Run `gh auth login` and ensure the Copilot CLI entitlement is active for the account.',
    headless: { args: (prompt) => ['-p', prompt] },
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    // Windsurf ships no supported non-interactive entrypoint: its agent runs inside the editor. A
    // driver that invented one would be certifying a path no user has.
    headless: null,
    installerIde: 'windsurf',
    configRelPath: ['.codeium', 'windsurf', 'mcp_config.json'],
    configFormat: 'json-mcpServers',
    projectScoped: false,
    binaries: ['windsurf'],
    versionArgs: ['--version'],
    authHint:
      'Windsurf has no headless mode; certification needs a supported non-interactive entrypoint from the vendor.',
  },
  {
    id: 'vscode',
    displayName: 'Visual Studio Code',
    headless: null,
    installerIde: 'vscode',
    configRelPath: ['.vscode', 'mcp.json'],
    configFormat: 'json-servers',
    projectScoped: true,
    binaries: ['code'],
    versionArgs: ['--version'],
    authHint:
      'VS Code has no headless agent turn; its agent is Copilot, which is certified as its own cell.',
  },
];

export const CLIENT_IDS = CLIENT_SPECS.map((spec) => spec.id);

/**
 * The driver spec for one client.
 *
 * Exported for the tests: exercising the harness against a FAKE vendor binary is the only way to run
 * its seven state machines without owning seven signed-in vendor accounts, and doing that needs the
 * spec the CLI would have looked up.
 */
export function clientSpec(clientId) {
  return CLIENT_SPECS.find((spec) => spec.id === clientId);
}

/** Run a command, capturing everything into the transcript. Never throws — legs report status. */
function run(log, label, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  const ms = Date.now() - started;
  log(`\n$ ${command} ${args.join(' ')}   [${label}, ${ms}ms, exit ${result.status}]`);
  return result;
}

/**
 * Build ONE driver from its spec.
 *
 * The interface is fixed — `preflight / configure / invoke / interrupt / restartAndResume / close` —
 * so the harness can drive any client without knowing which one it has. Each method returns
 * behaviour results keyed by {@link CERTIFICATION_BEHAVIOURS} id; a behaviour it could not attempt
 * comes back `blocked` with a reason, never absent.
 */
function createDriver(spec) {
  const blocked = (ids, reason) =>
    Object.fromEntries(ids.map((id) => [id, { status: 'blocked', reason }]));
  const behaviourIds = (phase) =>
    CERTIFICATION_BEHAVIOURS.filter((b) => b.phase === phase).map((b) => b.id);

  return {
    id: spec.id,
    spec,
    displayName: spec.displayName,

    /** preflight — resolve the vendor binary and prove it is signed in. */
    preflight(ctx) {
      if (!spec.binaries) {
        return blocked(
          behaviourIds('preflight'),
          `no vendor executable is declared for ${spec.id} on ${process.platform}`,
        );
      }
      if (!spec.headless) {
        return {
          vendorBinaryResolved: resolveBinary(spec),
          vendorAuthenticated: {
            status: 'blocked',
            reason: `the ${spec.displayName} vendor runtime has no supported non-interactive entrypoint, so sign-in cannot be exercised`,
          },
        };
      }
      const resolved = resolveBinary(spec);
      if (resolved.status !== 'pass') {
        return {
          vendorBinaryResolved: resolved,
          vendorAuthenticated: {
            status: 'blocked',
            reason: `the ${spec.displayName} executable was not found, so sign-in could not be probed`,
          },
        };
      }
      ctx.vendorBin = resolved.binary;
      ctx.vendorVersion = resolved.version;
      const auth = spawnSync(resolved.binary, spec.authProbe.args, {
        encoding: 'utf8',
        timeout: 60_000,
        env: ctx.clientEnv,
        cwd: ctx.project,
      });
      ctx.log(
        sanitizeOutput(
          `$ ${basename(resolved.binary)} ${spec.authProbe.args.join(' ')}   [preflight: sign-in, exit ${auth.status}]`,
        ),
      );
      let authed = false;
      try {
        authed = spec.authProbe.parse(auth.stdout ?? '', auth.status) === true;
      } catch {
        authed = false;
      }
      return {
        vendorBinaryResolved: resolved,
        vendorAuthenticated: authed
          ? { status: 'pass' }
          : {
              status: 'blocked',
              reason: `${spec.displayName} is not signed in on this host. ${spec.authHint}`,
            },
      };
    },

    /** configure — generate the config through the SHIPPED installer, then isolate crib's stores. */
    configure(ctx) {
      const config = run(
        ctx.log,
        'configure: generate the client config through the shipped installer',
        ctx.cribBin,
        ['mcp', 'install', '--ide', spec.installerIde, '--bin', ctx.cribBin, ctx.project],
        { env: ctx.clientEnv, cwd: ctx.project },
      );
      ctx.configPath = resolve(ctx.project, ...spec.configRelPath);
      const generated = existsSync(ctx.configPath);
      const results = {
        configGeneratedByInstaller: generated
          ? {
              status: config.status === 0 ? 'pass' : 'fail',
              reason: config.status === 0 ? undefined : 'crib mcp install exited non-zero',
            }
          : {
              status: 'fail',
              reason: `the installer wrote no config at ${spec.configRelPath.join('/')}`,
            },
      };
      if (!generated) {
        results.configTargetsInstalledCandidate = {
          status: 'blocked',
          reason: 'no generated config exists to inspect',
        };
        return results;
      }
      // The operator adds the env that isolates crib's stores for this run; the shipped installer
      // writes command+args only. Disclosed rather than hidden — the receipt hashes the FINAL file.
      try {
        applyIsolationEnv(ctx, spec);
      } catch (error) {
        // The installer wrote something this driver cannot read. That is a real finding about the
        // shipped installer, and it must come back as a named failing leg — not as a thrown error
        // that takes the transcript and the receipt with it.
        results.configTargetsInstalledCandidate = {
          status: 'fail',
          reason: `the generated config could not be extended with the isolating env: ${sanitizeOutput(error?.message ?? String(error))}`,
        };
        return results;
      }
      // The recorder is wired into the SAME config the installer wrote, so the legs below are judged
      // from what actually crossed the wire, not from the words the client printed. Without it the
      // run has no protocol evidence at all and every protocol-dependent leg refuses — the honest
      // outcome for a cell whose wire was never tapped, and the one a word-matching client cannot
      // talk its way past.
      try {
        const originalCommand = wireProtocolRecorder(ctx, spec);
        ctx.serverCommandSha256 = serverCommandSha256(
          originalCommand.server,
          originalCommand.serverArgs,
        );
        ctx.ownerConfigSha256 = sha256File(ctx.configPath);
        // The foreign principal's config is derived from the FINAL owner bytes: same journal,
        // repository and candidate, a different authenticated principal, individually hashed.
        ctx.foreignConfig = buildForeignConfig(ctx, spec, readFileSync(ctx.configPath, 'utf8'));
        ctx.foreignConfigSha256 = sha256(ctx.foreignConfig);
      } catch (error) {
        results.configTargetsInstalledCandidate = {
          status: 'fail',
          reason: `the generated config could not be wired with the protocol recorder: ${sanitizeOutput(error?.message ?? String(error))}`,
        };
        return results;
      }
      const final = readFileSync(ctx.configPath, 'utf8');
      // The rewired config launches the recorder with the candidate as its payload, so "points at
      // the candidate" now means the candidate appears as the recorder's --server argument (or, on a
      // config this driver failed to rewire, as the direct command — either way the bytes must
      // name the installed candidate).
      const candidateQuoted = final.includes(`"${ctx.cribBin}"`);
      const throughRecorder = final.includes('"--server"');
      const directCommand = new RegExp(`command"?\\s*[=:]\\s*"${escapeRegExp(ctx.cribBin)}"`).test(
        final,
      );
      results.configTargetsInstalledCandidate =
        candidateQuoted && (throughRecorder || directCommand)
          ? { status: 'pass' }
          : {
              status: 'fail',
              reason: `the generated config does not launch the installed candidate at ${ctx.cribBin}`,
            };
      ctx.log(
        `\n# the final ${spec.configRelPath.join('/')} (isolating env and protocol recorder applied by the operator)`,
      );
      // The wired config is archived in the transcript, and it now carries the recorder's --markers
      // argument and the isolation env's principal — raw fixture tokens and principal IDs that must
      // never survive into evidence, so they are redacted with the same list every turn uses.
      ctx.log(
        sanitizeOutput(readFileSync(ctx.configPath, 'utf8'), [
          ctx.tag,
          ctx.foreignMarker,
          ctx.ownerPrincipal,
          ctx.foreignPrincipal,
        ]),
      );
      return results;
    },

    /** invoke — handshake, tool use, and an authorized record, all through the vendor client. */
    invoke(ctx) {
      const reason = ctx.blockedBecause;
      if (reason) {
        return blocked(
          [
            'handshakeThroughVendorClient',
            'toolInvocationThroughVendorClient',
            'authorizedRecordThroughVendorClient',
          ],
          reason,
        );
      }
      const handshake = ctx.turn(
        'invoke: vendor handshake + tool invocation',
        `Use the knowledge-crib MCP server. Call its query tool with q="certifiedSymbol" and reply with ONLY the id of the first hit.`,
      );
      const handshakeText = `${handshake.stdout ?? ''}${handshake.stderr ?? ''}`;
      // CORRELATED EVIDENCE, not word-matching: the client must have printed the queried id AND the
      // owner's recording must show a COMPLETED query operation whose request carried the fixture
      // marker and whose result carried it back. A client that echoes the vocabulary certifies
      // nothing here — the printed word without the protocol operation is exactly the false
      // positive this leg exists to refuse.
      const handshakeEvidence = protocolMatch(ctx, 'owner', {
        method: 'tools/call',
        tool: 'query',
        requestMarker: 'certifiedSymbol',
        resultMarker: 'certifiedSymbol',
      });
      const handshakeWords = handshake.status === 0 && /certifiedSymbol/.test(handshakeText);
      const handshakeOk = handshakeWords && handshakeEvidence;

      const record = ctx.turn(
        'invoke: record a uniquely tagged authorized intake',
        `Use the knowledge-crib MCP memory tool with op="intake_create", original="${ctx.tag}", summary="vendor certification run ${ctx.tag}", outcome="prove a ${spec.displayName} session records and later recovers an authorized intake", phase="executing", actor="${spec.id}-certification". Then reply with ONLY the returned intake id.`,
      );
      // The record operation is identified by its REQUEST carrying the run tag — the handoff turns
      // below carry no tag in their params, so this uniquely names the intake_create among every
      // other memory call in the recording — and by its RESULT returning an intake id.
      const recordEvidence = protocolMatch(ctx, 'owner', {
        method: 'tools/call',
        tool: 'memory',
        requestMarker: ctx.tag,
        resultMarker: 'intake:',
      });
      const recordWords = record.status === 0 && /intake:/.test(`${record.stdout ?? ''}`);
      const recordOk = recordWords && recordEvidence;
      return {
        handshakeThroughVendorClient: handshakeOk
          ? { status: 'pass', protocol: [handshakeEvidence] }
          : failed(
              handshake,
              handshakeWords
                ? 'the client echoed the queried id, but the protocol recording shows no completed query operation carrying it — a printed word is not a handshake'
                : `handshake exit ${handshake.status}; the tool result did not return the queried id`,
            ),
        // One turn proves both: the handshake leg is "the server was reached", the tool-use leg is
        // "its result came back to the client". A run that reached the server but got nothing back
        // fails here and not above, which is the distinction v1 could not express.
        toolInvocationThroughVendorClient: handshakeOk
          ? { status: 'pass', protocol: [handshakeEvidence] }
          : failed(handshake, 'no tool result returned to the vendor client'),
        authorizedRecordThroughVendorClient: recordOk
          ? { status: 'pass', protocol: [recordEvidence] }
          : failed(
              record,
              recordWords
                ? 'the client printed an intake id, but the protocol recording shows no completed memory operation carrying the run tag — a printed id is not a record'
                : `record exit ${record.status}; no intake id was returned`,
            ),
      };
    },

    /**
     * interrupt — kill the VENDOR CLIENT process, having first proved it IS the vendor client.
     *
     * This is the leg that cannot be faked. The client spawns an MCP server child; killing the child
     * would leave the client running and prove nothing about interruption, so the harness reads the
     * target's command line while it is alive, refuses to call it an interruption unless that
     * command IS the vendor binary, and only then kills the process group.
     */
    async interrupt(ctx) {
      if (ctx.blockedBecause) {
        return blocked(['vendorProcessInterrupted'], ctx.blockedBecause);
      }
      const launched = await ctx.launchDetached(
        'interrupt: launch the vendor client, then kill IT mid-session',
        `Call the knowledge-crib status tool with op="health" and then wait.`,
      );
      if (!launched.ok) {
        return { vendorProcessInterrupted: { status: 'fail', reason: launched.reason } };
      }
      // Read the identity BEFORE the kill: afterwards the process is gone and the claim
      // "the vendor client was interrupted" becomes unfalsifiable.
      const observed = processCommand(launched.pid);
      ctx.log(`# interrupt target pid ${launched.pid} command ${observed ?? '<unreadable>'}`);
      const observedBase = observed ? basename(observed).replace(/\.(exe|cmd|bat)$/i, '') : '';
      const isVendor = spec.binaries.some(
        (name) => observedBase === name.replace(/\.(exe|cmd|bat)$/i, ''),
      );
      const killed = killProcessTree(launched.pid);
      await launched.settle();
      ctx.interruptEvidence = {
        targetPid: launched.pid,
        targetCommand: observed ?? null,
        killed,
      };
      if (!isVendor) {
        return {
          vendorProcessInterrupted: {
            status: 'fail',
            reason: `the killed process was ${JSON.stringify(observedBase || null)}, not the ${spec.displayName} client — killing an MCP subprocess is not interrupting the vendor client`,
          },
        };
      }
      return {
        vendorProcessInterrupted: killed
          ? { status: 'pass' }
          : { status: 'fail', reason: `could not signal the vendor process ${launched.pid}` },
      };
    },

    /**
     * restartAndResume — a fresh client recovers the killed one's authorized session, and a foreign
     * principal's work stays invisible to the owner.
     *
     * The foreign principal is PLANTED AND CONFIRMED in one launch under that principal, then the
     * owner's own client is asked about it. Confirming the plant is what stops the exclusion leg from
     * passing for the wrong reason: an absent record and a successfully hidden one look identical
     * from the owner's side, and only one of them is the boundary holding.
     */
    restartAndResume(ctx) {
      if (ctx.blockedBecause) {
        return blocked(
          ['vendorProcessRestarted', 'authorizedSessionResumed', 'foreignPrincipalExclusion'],
          ctx.blockedBecause,
        );
      }
      // The protocol floor: every operation recorded BEFORE this point belongs to the pre-restart
      // sessions. The restart leg must find an operation that happened AFTER the interruption — a
      // recording accumulates across a cell's sessions, and without a floor the record turn that
      // preceded the kill would satisfy the post-restart legs.
      const floor = operationCount(protocolRead(ctx, 'owner'));
      const restarted = ctx.turn(
        'restartAndResume: fresh process recovers the authorized session',
        `Use the knowledge-crib MCP memory tool with op="handoff". Reply with ONLY the word FOUND if any intake's original field contains "${ctx.tag}", otherwise reply MISSING.`,
      );
      const restartedText = `${restarted.stdout ?? ''}`;
      const restartedOk = restarted.status === 0;
      const found = /FOUND/.test(restartedText);
      // "The client restarted" is NOT "a process exited 0". A stub that prints nothing and returns 0
      // would otherwise certify this leg — the same error `invoke` refuses when it reads a handshake
      // out of an exit status. The restarted client has to have ANSWERED a tool-mediated question:
      // either word proves a live session, and which word it is decides the resume leg below. That
      // distinction is the whole reason restart and resume are two legs and not one.
      const answered = /\b(FOUND|MISSING)\b/.test(restartedText);
      // And the answer has to have CROSSED THE WIRE: a completed memory operation after the floor,
      // whose result carried the tag back for the resume leg. The words alone certify nothing.
      const restartEvidence = protocolMatch(ctx, 'owner', {
        method: 'tools/call',
        tool: 'memory',
        fromIndex: floor,
      });
      const resumeEvidence = protocolMatch(ctx, 'owner', {
        method: 'tools/call',
        tool: 'memory',
        fromIndex: floor,
        resultMarker: ctx.tag,
      });
      const restartedWords = restartedOk && answered;
      const restartOk = restartedWords && restartEvidence;
      const resumeOk = found && resumeEvidence;

      // The floor for the exclusion check: captured AFTER the restarted turn and BEFORE the
      // exclusion turn, so the owner operation that must NOT carry the foreign marker is the
      // exclusion handoff itself — never the earlier turns, whose results predate the plant.
      const ownerExclusionFloor = operationCount(protocolRead(ctx, 'owner'));

      // The foreign principal runs from the SAME config path, its bytes swapped in place: the same
      // journal, repository and candidate as the owner, a different authenticated principal, its
      // traffic attributed to its own recording. Swapping the bytes at the path the client already
      // discovers — rather than pointing it at a second path with a flag only some clients have —
      // is what makes "the vendor-specific configuration mechanism" true for every driver.
      const plant = ctx.foreignTurn(
        "restartAndResume: plant a foreign principal's durable work and confirm it as that principal",
        `Use the knowledge-crib MCP memory tool twice. First with op="intake_create", original="${ctx.foreignMarker}", summary="foreign principal work ${ctx.foreignMarker}", outcome="must never appear in another principal's session", phase="executing", actor="other-principal". Then with op="handoff". Reply with ONLY the word PRESENT if the handoff shows an intake whose original or summary contains "${ctx.foreignMarker}", otherwise ABSENT.`,
      );
      // Planted means BOTH the foreign principal's recording shows the intake_create (its REQUEST
      // carried the foreign marker) AND the confirm handoff's RESULT carried it back to that
      // principal. Absence of the marker on the owner's side proves nothing unless the foreign
      // side actually created and retrieved its own work — an absent record and a hidden one look
      // identical from the owner's side, and only one of them is the boundary holding.
      const createEvidence = protocolMatch(ctx, 'foreign', {
        method: 'tools/call',
        tool: 'memory',
        requestMarker: ctx.foreignMarker,
      });
      const confirmEvidence = createEvidence
        ? protocolMatch(ctx, 'foreign', {
            method: 'tools/call',
            tool: 'memory',
            fromIndex: createEvidence.operation + 1,
            resultMarker: ctx.foreignMarker,
          })
        : null;
      const plantedWords = plant.status === 0 && /PRESENT/.test(`${plant.stdout ?? ''}`);
      const planted = plantedWords && createEvidence && confirmEvidence;

      const foreign = ctx.turn(
        'restartAndResume: the owner must not see it',
        `Use the knowledge-crib MCP memory tool with op="handoff". Reply with ONLY the word LEAKED if any intake's original or summary contains "${ctx.foreignMarker}", otherwise reply CLEAN.`,
      );
      const leaked = /LEAKED/.test(`${foreign.stdout ?? ''}`);
      // The owner's completed handoff after the plant floor, whose result did NOT carry the foreign
      // marker. This is the operation the exclusion claim is actually made about — "the owner
      // printed CLEAN" is a word, and only the protocol shows the owner really asked.
      const exclusionEvidence = protocolMatch(ctx, 'owner', {
        method: 'tools/call',
        tool: 'memory',
        fromIndex: ownerExclusionFloor,
        absentResultMarker: ctx.foreignMarker,
      });
      const exclusionWords = !leaked && foreign.status === 0;
      const exclusionOk = planted && exclusionWords && exclusionEvidence;
      ctx.log(
        `# foreign principal: planted=${planted} leaked=${leaked} protocolEvidence=${Boolean(exclusionEvidence)}`,
      );

      return {
        vendorProcessRestarted: restartOk
          ? { status: 'pass', protocol: [restartEvidence] }
          : failed(
              restarted,
              restartedWords
                ? 'the restarted client answered, but the protocol recording shows no completed memory operation after the interruption — a printed answer is not a restarted session'
                : restartedOk
                  ? 'the restarted client exited 0 but returned no answer to the handoff query, so no session was proven'
                  : `the restarted client exited ${restarted.status}`,
            ),
        authorizedSessionResumed: resumeOk
          ? { status: 'pass', protocol: [resumeEvidence] }
          : failed(
              restarted,
              found
                ? 'the restarted client reported FOUND, but the protocol recording shows no completed handoff whose result carried the run tag — a printed word is not a recovered session'
                : 'the restarted client did not recover the tagged intake',
            ),
        foreignPrincipalExclusion: exclusionOk
          ? { status: 'pass', protocol: [createEvidence, confirmEvidence, exclusionEvidence] }
          : {
              status: 'fail',
              reason: planted
                ? exclusionWords
                  ? 'the owner reported CLEAN, but the protocol recording shows no completed handoff for the owner after the plant — a printed word is not an exclusion proof'
                  : `the owner's client reported the foreign marker (leaked=${leaked}, exit ${foreign.status})`
                : plantedWords
                  ? 'the foreign client reported PRESENT, but its own recording shows no completed create-and-retrieve pair carrying the foreign marker — the exclusion was never exercised on the wire'
                  : 'the foreign intake could not be planted and confirmed, so the exclusion was never exercised',
            },
      };
    },

    /**
     * close — tear down.
     *
     * Every path this run touched lives under the scenario workspace: the npm prefix holding the
     * installed candidate, the crib stores, the config files, the project. The operator's real
     * profile is never opened, so teardown cannot be destructive and the report says so instead of
     * asserting it.
     */
    close(ctx) {
      return { teardown: 'isolated-workspace', workspace: ctx.keep ? ctx.workspace : null };
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A failed leg, whose reason distinguishes "the vendor client said no" from "the harness could not
 * even start it".
 *
 * Those are different findings about a release — one is the client under test, the other is us — and
 * a leg that reported the second as the first would send a reader to the wrong place.
 */
function failed(result, because) {
  return {
    status: 'fail',
    reason: result?.harnessError
      ? `the harness could not launch the vendor client: ${result.harnessError}`
      : because,
  };
}

/** Resolve a vendor executable by trying each declared name, then reading its version. */
function resolveBinary(spec) {
  for (const name of spec.binaries) {
    const probe = spawnSync(name, spec.versionArgs, { encoding: 'utf8', timeout: 60_000 });
    if (probe.error && probe.error.code === 'ENOENT') continue;
    const text = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
    // `code --version` prints the version on the FIRST line and the commit on the next; Claude Code,
    // Cursor and the rest print one token. Taking the first version-shaped token covers both without
    // a per-client parser.
    const version = /v?\d+\.\d+\.\d+(?:[-.\w]*)?/.exec(text)?.[0];
    if (!version) continue;
    return { status: 'pass', binary: name, version, resolvedPath: whichSync(name) ?? name };
  }
  return {
    status: 'blocked',
    reason: `no ${spec.displayName} executable found on PATH (tried: ${spec.binaries.join(', ')})`,
  };
}

function whichSync(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(cmd, [name], { encoding: 'utf8' }).split('\n')[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Add the env that isolates crib's stores to the config the installer just wrote.
 *
 * The installer deliberately writes command+args and leaves env to the operator, so this is the
 * operator's step, performed here and disclosed: the receipt hashes the FINAL file. TOML needs its
 * own sub-table rather than a JSON key, which is why this branches on format instead of mutating one
 * shape.
 */
function applyIsolationEnv(ctx, spec) {
  const env = {
    KCRIB_MEMORY_DIR: ctx.cribMemoryDir,
    KCRIB_REGISTRY_DIR: ctx.cribRegistryDir,
    KCRIB_PRINCIPAL_ID: ctx.ownerPrincipal,
  };
  const raw = readFileSync(ctx.configPath, 'utf8');
  if (spec.configFormat === 'toml') {
    const table = `\n[mcp_servers.knowledge-crib.env]\n${Object.entries(env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join('\n')}\n`;
    writeFileSync(ctx.configPath, `${raw}${table}`);
    return;
  }
  const parsed = JSON.parse(raw);
  const root = spec.configFormat === 'json-servers' ? 'servers' : 'mcpServers';
  const server = parsed?.[root]?.['knowledge-crib'];
  if (!server) throw new Error(`the installer wrote no ${root}['knowledge-crib'] entry`);
  server.env = { ...(server.env ?? {}), ...env };
  writeFileSync(ctx.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Insert the transparent protocol recorder into the config the installer just wrote.
 *
 * The config's command becomes `node client-protocol-recorder.mjs --server <original command>
 * --record <owner recording> --principal <owner principal> --markers … -- <original args>`, so the
 * recorder forwards every byte unchanged between the vendor client and the candidate while tapping
 * the protocol. Returns the ORIGINAL command/args — the identity of the server both configurations
 * launch, which the receipt binds as a digest. Throws on any config shape this driver cannot
 * rewire, so the failure lands in a named failing leg instead of a run with silent no-evidence.
 *
 * Exported for the tests: the TOML splice and the JSON rewrite are the two shapes the shipped
 * installer writes, and each is checkable against a fixture without driving a whole cell.
 */
export function wireProtocolRecorder(ctx, spec) {
  const markersArg = ctx.protocolMarkers.join(',');
  const recorderArgs = (record, principal, original) => [
    ctx.recorderPath,
    '--server',
    original.server,
    '--record',
    record,
    '--principal',
    principal,
    '--markers',
    markersArg,
    '--',
    ...original.serverArgs,
  ];
  const raw = readFileSync(ctx.configPath, 'utf8');
  if (spec.configFormat === 'toml') {
    const TOML_BEGIN = '# >>> knowledge-crib managed >>>';
    const TOML_END = '# <<< knowledge-crib managed <<<';
    const begin = raw.indexOf(TOML_BEGIN);
    const end = raw.indexOf(TOML_END);
    if (begin === -1 || end === -1 || end < begin) {
      throw new Error('the managed TOML block the installer writes is missing or unreadable');
    }
    const block = raw.slice(begin, end + TOML_END.length);
    const commandMatch = /command\s*=\s*("(?:[^"\\]|\\.)*")/.exec(block);
    const argsMatch = /\nargs\s*=\s*\[(.*)\]/.exec(block);
    if (!commandMatch || !argsMatch) {
      throw new Error('the managed TOML block declares no command/args to intercept');
    }
    // The installer writes every string as a TOML basic string escaped by the same rules as JSON
    // (packages/cli/src/mcp-install.ts), so the literals parse as JSON here — win32 backslashes
    // included. Any other escaping is a config this driver must refuse rather than half-read.
    const original = {
      server: JSON.parse(commandMatch[1]),
      serverArgs: JSON.parse(`[${argsMatch[1]}]`),
    };
    const rewired = [
      TOML_BEGIN,
      '[mcp_servers.knowledge-crib]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${recorderArgs(ctx.ownerRecordingPath, ctx.ownerPrincipal, original)
        .map(JSON.stringify)
        .join(', ')}]`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 60',
      TOML_END,
    ].join('\n');
    // Spliced between the markers, so whatever the env step appended after TOML_END survives.
    writeFileSync(
      ctx.configPath,
      `${raw.slice(0, begin)}${rewired}${raw.slice(end + TOML_END.length)}`,
    );
    return original;
  }
  const parsed = JSON.parse(raw);
  const root = spec.configFormat === 'json-servers' ? 'servers' : 'mcpServers';
  const server = parsed?.[root]?.['knowledge-crib'];
  if (!server) throw new Error(`the installer wrote no ${root}['knowledge-crib'] entry`);
  const original = { server: server.command, serverArgs: [...(server.args ?? [])] };
  server.command = process.execPath;
  server.args = recorderArgs(ctx.ownerRecordingPath, ctx.ownerPrincipal, original);
  writeFileSync(ctx.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return original;
}

/**
 * The foreign principal's config, derived from the FINAL owner bytes: the same isolating env values
 * for journal and repository, a different authenticated principal, its traffic attributed to its
 * own recording. TOML is rewritten textually — every value the harness and installer wrote into it
 * is a JSON-escaped basic string, so the exact literal appears and an exact swap cannot corrupt
 * anything around it. JSON is rewritten structurally.
 *
 * Exported for the tests, like `wireProtocolRecorder`: the derivation is what makes the foreign
 * principal the SAME stores and a DIFFERENT identity, and that is checkable against fixtures.
 */
export function buildForeignConfig(ctx, spec, finalOwnerConfig) {
  if (spec.configFormat === 'toml') {
    let out = finalOwnerConfig;
    for (const [from, to] of [
      [JSON.stringify(ctx.ownerPrincipal), JSON.stringify(ctx.foreignPrincipal)],
      [JSON.stringify(ctx.ownerRecordingPath), JSON.stringify(ctx.foreignRecordingPath)],
    ]) {
      if (!out.includes(from)) {
        throw new Error(
          `the final owner config does not carry the value to re-principal (${from})`,
        );
      }
      out = out.split(from).join(to);
    }
    return out;
  }
  const parsed = JSON.parse(finalOwnerConfig);
  const root = spec.configFormat === 'json-servers' ? 'servers' : 'mcpServers';
  const server = parsed?.[root]?.['knowledge-crib'];
  if (!server) {
    throw new Error(
      `the final owner config carries no ${root}['knowledge-crib'] entry to re-principal`,
    );
  }
  server.env = { ...(server.env ?? {}), KCRIB_PRINCIPAL_ID: ctx.foreignPrincipal };
  server.args = (server.args ?? []).map((arg) =>
    arg === ctx.ownerRecordingPath
      ? ctx.foreignRecordingPath
      : arg === ctx.ownerPrincipal
        ? ctx.foreignPrincipal
        : arg,
  );
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * The parsed recording for one principal, or null when it is absent or fails validation. A missing
 * recording is a FINDING ("no protocol traffic was ever tapped"), not an empty success — every
 * protocol-dependent leg treats null as no evidence and refuses.
 */
function protocolRead(ctx, which) {
  const path = which === 'foreign' ? ctx.foreignRecordingPath : ctx.ownerRecordingPath;
  if (!existsSync(path)) return null;
  try {
    const recording = JSON.parse(readFileSync(path, 'utf8'));
    return recordingProblems(recording).length === 0 ? recording : null;
  } catch {
    return null;
  }
}

/**
 * The correlated-evidence query: a COMPLETED operation in one principal's recording matching the
 * criteria, returned as a receipt-shaped reference (which recording, which operation, which
 * request id) or null. Null is a refusal, never a pass.
 */
function protocolMatch(ctx, which, criteria) {
  const recording = protocolRead(ctx, which);
  if (!recording) return null;
  const found = findCompletedOperation(recording, criteria);
  return found ? { recording: which, operation: found.index, request: found.operation.id } : null;
}

/**
 * Copy one principal's recording into the receipt's outDir and describe it, or null when it does not
 * exist. Null is recorded rather than omitted: "no protocol traffic was ever tapped" is a fact the
 * decision needs to read, and the recordings themselves are archived artifacts the validator
 * re-hashes — a claim about the wire that the wire's own file can confirm or refute.
 */
function archivedRecording(source, outDir, name) {
  try {
    if (!source || !existsSync(source)) return null;
    cpSync(source, join(outDir, name));
    return { path: name, sha256: sha256File(join(outDir, name)) };
  } catch {
    return null;
  }
}

/**
 * Certify one cell end to end and return the receipt object.
 *
 * Exported so a test can drive the whole harness against a fake vendor binary — the alternative is
 * that the only way to exercise this code is to own seven signed-in vendor accounts.
 */
export async function certifyCell(options) {
  const { spec, client, packagePath, candidateCommit, outDir, keep = false } = options;
  const { sha256: policySha256 } = loadLaunchPolicy();
  const driver = createDriver(spec);

  const workspace = mkdtempSync(join(tmpdir(), `crib-certify-${spec.id}-`));
  const home = join(workspace, 'home');
  const prefix = join(home, 'npm-global');
  const project = join(workspace, 'project');
  const cribHome = join(home, '.crib');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(prefix, { recursive: true });
  mkdirSync(join(cribHome, 'memory'), { recursive: true });
  const transcript = join(workspace, `${spec.id}-${process.platform}-vendor-run.log`);
  writeFileSync(transcript, '');
  const log = makeLog(transcript);

  const tag = `certify-${createHash('sha256').update(`${candidateCommit}:${Date.now()}:${spec.id}`).digest('hex').slice(0, 16)}`;
  const foreignMarker = `foreign-${tag}`;
  const ownerPrincipal = `principal:${spec.id}-owner`;
  // The foreign principal is a DIFFERENT authenticated principal over the SAME isolated journal and
  // repository — the boundary the exclusion leg is actually about. The recordings are per-principal
  // because traffic must be attributed before anything is redacted, and the markers below are the
  // synthetic fixture tokens the recorder evaluates over the RAW protocol bytes (pre-redaction) and
  // archives ONLY as digest-keyed booleans.
  const foreignPrincipal = `principal:${spec.id}-foreign`;
  const recorderPath = join(HERE, 'client-protocol-recorder.mjs');
  const ownerRecordingPath = join(
    workspace,
    `${spec.id}-${process.platform}-${process.arch}-owner-recording.json`,
  );
  const foreignRecordingPath = join(
    workspace,
    `${spec.id}-${process.platform}-${process.arch}-foreign-recording.json`,
  );
  const protocolMarkers = [tag, foreignMarker, 'certifiedSymbol', 'intake:'];

  // Everything of crib's is isolated; the vendor client runs under the OPERATOR's real profile,
  // because a client with an empty HOME has no credentials and exits in 100ms — an unauthenticated
  // client cannot certify anything. CLAUDE_PROJECT_DIR is stripped because this process may itself
  // be running inside a vendor client, and inheriting it made `crib mcp install` resolve the REAL
  // repository instead of the scenario project.
  const { CLAUDE_PROJECT_DIR: _inherited, ...cleanEnv } = process.env;
  const clientEnv = {
    ...cleanEnv,
    npm_config_prefix: prefix,
    KCRIB_MEMORY_DIR: join(cribHome, 'memory'),
    KCRIB_REGISTRY_DIR: cribHome,
  };

  const behaviours = {};
  const record = (results) => Object.assign(behaviours, results);
  let closeReport;
  let ctx = null;
  let crash;

  // Computed BEFORE the phases, because the receipt must be valid on EVERY path — including the one
  // where the harness itself failed. A receipt that only exists when everything worked cannot
  // report the failures it exists to report.
  const packageSha256 = sha256File(packagePath);
  const cribBin = join(prefix, 'bin', process.platform === 'win32' ? 'crib.cmd' : 'crib');

  try {
    log(`# ${spec.displayName} vendor certification — candidate ${candidateCommit}`);
    log(
      `# host ${hostname()} ${process.platform}/${process.arch} node ${process.version} wsl=${isWsl()}`,
    );
    log(`# policy ${policySha256}`);
    log(`# driver ${DRIVER_VERSION}`);
    log(`# run tag ${tag} (the tag is a digest; no prompt, secret or memory body is archived)`);

    // ── fixture: install the exact candidate tarball into an isolated prefix ──
    const bundleDir = dirname(packagePath);
    const deps = existsSync(bundleDir)
      ? execFileSync('ls', [bundleDir], { encoding: 'utf8' })
          .split('\n')
          .filter((n) => n.endsWith('.tgz') && join(bundleDir, n) !== packagePath)
          .map((n) => join(bundleDir, n))
      : [];
    const install = run(
      log,
      'fixture: install the candidate into an isolated prefix',
      'npm',
      ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', ...deps, packagePath],
      { env: clientEnv, timeoutMs: 600_000 },
    );

    writeFileSync(
      join(project, 'src', 'a.ts'),
      'export function certifiedSymbol(): number { return 1; }\n',
    );
    execFileSync('git', ['-C', project, 'init', '-q']);
    execFileSync('git', ['-C', project, 'config', 'user.email', 'certify@example.invalid']);
    execFileSync('git', ['-C', project, 'config', 'user.name', 'certify']);
    execFileSync('git', ['-C', project, 'add', '-A']);
    execFileSync('git', ['-C', project, 'commit', '-qm', 'base']);
    if (install.status === 0) {
      run(
        log,
        'fixture: index the project with the INSTALLED binary',
        cribBin,
        ['index', project],
        {
          env: clientEnv,
          timeoutMs: 600_000,
        },
      );
      run(log, 'fixture: initialize memory', cribBin, ['memory', 'init'], {
        env: clientEnv,
        cwd: project,
      });
    }

    // ── the driver ───────────────────────────────────────────────────────────
    ctx = {
      log,
      project,
      workspace,
      keep,
      cribBin,
      clientEnv,
      tag,
      foreignMarker,
      ownerPrincipal,
      foreignPrincipal,
      recorderPath,
      ownerRecordingPath,
      foreignRecordingPath,
      protocolMarkers,
      cribMemoryDir: join(cribHome, 'memory'),
      cribRegistryDir: cribHome,
      blockedBecause:
        install.status === 0
          ? undefined
          : `the candidate package failed to install (npm exit ${install.status})`,
      // Both launchers are throw-safe BY CONTRACT. A missing or unresolvable vendor binary makes
      // `spawnSync(undefined, …)` throw a TypeError, and a driver that let that escape would take
      // the whole run down before any receipt was written — turning "not signed in" into "no file",
      // which is exactly the silence this harness exists to remove. So a launch failure comes back
      // as a result carrying `harnessError`, and every leg that reads it reports why.
      turn(label, prompt, configPath = undefined) {
        try {
          const args = spec.headless.args(prompt, ctx);
          const finalArgs = configPath ? ['--mcp-config', configPath, ...args] : args;
          // The prompt is NEVER written to the transcript. What is written is that a turn was
          // issued, its digest, and its exit status — enough to check the run, not enough to leak
          // a prompt.
          log(
            `\n$ ${ctx.vendorBin} <prompt:redacted ${sha256(prompt)}>   [${label}, config ${configPath ?? ctx.configPath}]`,
          );
          const result = spawnSync(ctx.vendorBin, finalArgs, {
            encoding: 'utf8',
            env: clientEnv,
            cwd: project,
            timeout: 300_000,
            maxBuffer: 32 * 1024 * 1024,
          });
          log(`  exit ${result.status}`);
          const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
          if (tail)
            log(
              `  output (redacted, bounded): ${sanitizeOutput(tail.slice(0, 600), [tag, foreignMarker, ownerPrincipal, foreignPrincipal])}`,
            );
          return result;
        } catch (error) {
          const message = sanitizeOutput(error?.message ?? String(error));
          log(`  the vendor client could not be launched: ${message}`);
          return { status: null, stdout: '', stderr: '', harnessError: message };
        }
      },
      /**
       * A turn under the FOREIGN principal's config, byte-swapped in place at the SAME path the
       * owner's turns used. Only some clients accept a --mcp-config flag, but every client
       * discovers its config from the location it already reads — so swapping the bytes (and
       * restoring them in a finally) is the one mechanism that is the vendor's own for all seven
       * drivers. The v2 harness never initialized the foreign configuration at all, which is how
       * "the foreign plant" came to run under the OWNER's principal.
       */
      foreignTurn(label, prompt) {
        // A run whose installer wrote no config has nothing to swap. Throwing here would take the
        // whole restartAndResume phase down and turn three honestly-failing legs into one BLOCKED
        // receipt with a crash reason — so the missing config is reported as the turn's own failure
        // and each leg keeps its own named refusal.
        if (!existsSync(ctx.configPath)) {
          const message = 'the installer wrote no config, so the foreign principal had none to run';
          log(`# foreign turn refused: ${message}`);
          return { status: null, stdout: '', stderr: '', harnessError: message };
        }
        const ownerBytes = readFileSync(ctx.configPath, 'utf8');
        writeFileSync(ctx.configPath, ctx.foreignConfig ?? ownerBytes);
        try {
          log(`# foreign config swapped in (${ctx.foreignConfigSha256 ?? 'unhashed'})`);
          return ctx.turn(label, prompt);
        } finally {
          writeFileSync(ctx.configPath, ownerBytes);
        }
      },
      async launchDetached(label, prompt) {
        try {
          const args = spec.headless.args(prompt, ctx);
          log(`\n$ ${ctx.vendorBin} <prompt:redacted ${sha256(prompt)}>   [${label}, detached]`);
          const child = spawn(ctx.vendorBin, args, {
            env: clientEnv,
            cwd: project,
            detached: true,
            stdio: 'ignore',
          });
          // Give the client time to start, spawn its MCP server and open a session before it dies.
          await new Promise((r) => setTimeout(r, 8_000));
          if (child.exitCode !== null) {
            return {
              ok: false,
              reason: `the vendor client exited (${child.exitCode}) before it could be interrupted`,
            };
          }
          return {
            ok: true,
            pid: child.pid,
            settle: () =>
              new Promise((r) => {
                if (child.exitCode !== null) return r();
                child.once('exit', () => r());
                setTimeout(r, 5_000);
              }),
          };
        } catch (error) {
          const message = sanitizeOutput(error?.message ?? String(error));
          log(`  the vendor client could not be launched detached: ${message}`);
          return {
            ok: false,
            reason: `the harness could not launch the vendor client: ${message}`,
          };
        }
      },
    };

    record(driver.preflight(ctx));
    record(driver.configure(ctx));
    if (behaviours.vendorAuthenticated?.status !== 'pass') {
      ctx.blockedBecause =
        ctx.blockedBecause ??
        behaviours.vendorAuthenticated?.reason ??
        'the vendor client is not signed in';
    }
    record(driver.invoke(ctx));
    record(await driver.interrupt(ctx));
    record(driver.restartAndResume(ctx));
    closeReport = driver.close(ctx);
  } catch (error) {
    // The harness itself broke. That is a finding, and it gets a receipt like any other: every
    // behaviour not yet attempted is reported BLOCKED with the reason, so the cell is honestly
    // uncertified and the operator can see WHY rather than finding an empty directory.
    crash = sanitizeOutput(error?.message ?? String(error));
    log(`\n# the harness stopped before finishing: ${crash}`);
  }

  // Anything the driver never reported is blocked by name — never absent, which would read as
  // "not required".
  for (const { id } of CERTIFICATION_BEHAVIOURS) {
    if (!behaviours[id]) {
      behaviours[id] = {
        status: 'blocked',
        reason: crash
          ? `the harness stopped before attempting this behaviour: ${crash}`
          : 'the driver did not report this behaviour',
      };
    }
  }

  try {
    log('\n# behaviours');
    for (const { id } of CERTIFICATION_BEHAVIOURS) {
      const value = behaviours[id];
      log(`  ${id.padEnd(36)} ${value.status}${value.reason ? ` — ${value.reason}` : ''}`);
    }

    // ── the receipt ──────────────────────────────────────────────────────────
    mkdirSync(outDir, { recursive: true });
    const logName = `${spec.id}-${process.platform}-${process.arch}-vendor-run.log`;
    const archived = join(outDir, logName);
    cpSync(transcript, archived);

    const legs = buildLegs(behaviours, logName, sha256File(archived));
    const notPassed = Object.entries(legs)
      .filter(([, leg]) => leg.status !== 'pass')
      .map(([name]) => name);

    const receipt = {
      format: 'knowledge-crib-client-certification',
      formatVersion: 3,
      generatedAt: new Date().toISOString(),
      policySha256,
      product: { commit: candidateCommit, packageSha256 },
      client: {
        id: spec.id,
        version: ctx?.vendorVersion ?? 'unknown',
        driverVersion: DRIVER_VERSION,
        certificationMode: spec.id,
      },
      platform: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
        ...(isWsl() ? { wsl: true } : {}),
      },
      runId: sha256(`${candidateCommit}:${spec.id}:${tag}`),
      capture: {
        hostname: hostname(),
        operator: client,
        capturedAt: new Date().toISOString(),
        // Disclosed, not refused: the certified artifact is the TARBALL, whose digest is bound
        // above. A dirty checkout cannot change those bytes — it can only mean the run used a
        // harness that differs from the committed one, which a reader is entitled to see.
        dirty: gitDirty(),
      },
      principalMarkers: { owner: sha256(ownerPrincipal), foreign: sha256(foreignMarker) },
      // The two configurations the scenario ran — present only when both were hashed, which is the
      // only state in which a protocol-dependent leg could have passed. Same journal, repository
      // and candidate (the stores and server command digests must agree); DIFFERENT authenticated
      // principals; each config individually hashed so the receipt names the bytes it ran.
      ...(ctx?.ownerConfigSha256 && ctx?.foreignConfigSha256
        ? {
            configurations: {
              owner: {
                sha256: ctx.ownerConfigSha256,
                principalSha256: sha256(ownerPrincipal),
                format: spec.configFormat,
                stores: {
                  memoryDirSha256: sha256(ctx.cribMemoryDir),
                  registryDirSha256: sha256(ctx.cribRegistryDir),
                },
                serverCommandSha256: ctx.serverCommandSha256 ?? null,
              },
              foreign: {
                sha256: ctx.foreignConfigSha256,
                principalSha256: sha256(foreignPrincipal),
                format: spec.configFormat,
                stores: {
                  memoryDirSha256: sha256(ctx.cribMemoryDir),
                  registryDirSha256: sha256(ctx.cribRegistryDir),
                },
                serverCommandSha256: ctx.serverCommandSha256 ?? null,
              },
            },
          }
        : {}),
      // The protocol evidence: which recorder produced the recordings, and where the archived
      // copies are. A null recording is a FINDING (no protocol traffic was tapped on that side),
      // never an omission — the validator refuses any protocol-dependent passing leg whose
      // recording is missing.
      protocol: {
        recorderVersion: RECORDER_VERSION,
        ownerRecording: archivedRecording(
          ctx?.ownerRecordingPath,
          outDir,
          `${spec.id}-${process.platform}-${process.arch}-owner-recording.json`,
        ),
        foreignRecording: archivedRecording(
          ctx?.foreignRecordingPath,
          outDir,
          `${spec.id}-${process.platform}-${process.arch}-foreign-recording.json`,
        ),
      },
      legs,
      vendor: {
        processIdentity: ctx?.vendorBin
          ? `${spec.displayName} ${ctx.vendorVersion ?? 'unknown'} (${ctx.vendorBin})`
          : null,
        transcriptPath: logName,
        transcriptSha256: sha256File(archived),
      },
      teardown: closeReport?.teardown ?? 'unknown',
      ...(notPassed.length > 0
        ? { blockedReason: describeBlock(behaviours, notPassed, spec) }
        : {}),
    };
    // The receipt is PERSISTED here, not by the CLI wrapper. A caller that runs the harness
    // in-process — the tests do — must get the same artifact the operator gets, and a run whose
    // evidence only exists if the caller remembered to save it is a run whose evidence can be lost.
    const receiptPath = join(outDir, `client-${spec.id}-${process.platform}-${process.arch}.json`);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return { receipt, behaviours, legs, archived, receiptPath };
  } finally {
    if (!keep) rmSync(workspace, { recursive: true, force: true });
    else process.stdout.write(`workspace kept at ${workspace}\n`);
  }
}

/** Is the checkout dirty? Unreadable git is reported as dirty, never as clean. */
function gitDirty() {
  try {
    return (
      execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain=v1'], {
        encoding: 'utf8',
      }).trim().length > 0
    );
  } catch {
    return true;
  }
}

/**
 * Map the eleven behaviours onto the eight legs the receipt carries.
 *
 * A leg passes only when EVERY behaviour behind it passed. A leg with any blocked behaviour is
 * `blocked` rather than `fail` — "we could not sign in" and "the client rejected the handshake" are
 * different facts about a release, and collapsing them loses the one a reader needs.
 */
export function buildLegs(behaviours, logName, logDigest) {
  const legs = {};
  for (const [leg, ids] of Object.entries(LEG_BEHAVIOURS)) {
    const values = ids.map((id) => behaviours[id] ?? { status: 'blocked', reason: 'not reported' });
    const status = values.every((v) => v.status === 'pass')
      ? 'pass'
      : values.some((v) => v.status === 'blocked')
        ? 'blocked'
        : values.some((v) => v.status === 'not-run')
          ? 'not-run'
          : 'fail';
    // The two vendor-asserting legs name their source unconditionally. Only `vendor-client` may
    // satisfy them, and the loader refuses the receipt outright if either says otherwise — so a
    // harness that merely spoke the protocol could not produce a version-2 receipt at all.
    // A PASSING leg also carries the protocol references its behaviours were judged from: which
    // recording, which operation, which request id. The validator re-reads those recordings from
    // the archived artifacts, so a leg's pass is checkable against the wire, not just against the
    // receipt's own say-so.
    const protocolRefs =
      status === 'pass'
        ? values.flatMap((v) => (Array.isArray(v?.protocol) ? v.protocol : []))
        : [];
    legs[leg] = {
      status,
      ...(leg === 'handshake' || leg === 'toolUse' ? { source: 'vendor-client' } : {}),
      logPath: logName,
      logSha256: logDigest,
      ...(protocolRefs.length > 0 ? { protocol: protocolRefs } : {}),
      ...(values.find((v) => v.reason)?.reason
        ? { detail: values.find((v) => v.reason).reason }
        : {}),
    };
  }
  return legs;
}

/** The one line a reader needs when a cell could not be certified. */
function describeBlock(behaviours, notPassed, spec) {
  const blocked = CERTIFICATION_BEHAVIOURS.map((b) => behaviours[b.id]).filter(
    (v) => v?.status === 'blocked',
  );
  if (blocked.length > 0) return blocked[0].reason;
  const failed = CERTIFICATION_BEHAVIOURS.map((b) => behaviours[b.id]).find(
    (v) => v?.status === 'fail',
  );
  if (failed) return failed.reason ?? `${spec.displayName} failed a certification leg`;
  return `legs not passed: ${notPassed.join(', ')}`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const client = flag(argv, '--client');
  const packagePath = flag(argv, '--package');
  const candidateCommit = flag(argv, '--candidate-commit');
  const outDir = resolve(flag(argv, '--out', 'client-certification-receipts'));
  const keep = argv.includes('--keep');

  const problems = [];
  if (!client || !CLIENT_IDS.includes(client)) {
    problems.push(
      `--client must be one of: ${CLIENT_IDS.join(', ')} (got ${JSON.stringify(client)})`,
    );
  }
  if (!packagePath)
    problems.push(
      '--package <candidate-tarball> is required — a receipt must bind the bytes it certified',
    );
  else if (!existsSync(packagePath)) problems.push(`--package ${packagePath} does not exist`);
  if (!candidateCommit || !/^[a-f0-9]{40}$/.test(candidateCommit)) {
    problems.push('--candidate-commit must be a full 40-hex commit');
  } else {
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    // Certifying a commit you are not standing on means the DRIVER that produced the evidence is not
    // the driver at the certified commit. The vendor run is about the tarball, but the harness is
    // about this tree, and a receipt that conflates them is not auditable.
    if (head !== candidateCommit) {
      problems.push(
        `--candidate-commit ${candidateCommit} is not HEAD (${head}); certify the commit whose harness produced the evidence`,
      );
    }
  }
  if (problems.length) {
    process.stderr.write(
      `client-certify REFUSES to start:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exit(2);
  }
  if (!CERTIFIED_CLIENTS.includes(client)) {
    process.stderr.write(
      `client-certify: ${client} is not an advertised client in the launch policy\n`,
    );
    process.exit(2);
  }

  const spec = CLIENT_SPECS.find((s) => s.id === client);
  const operator = userInfo().username;
  const { receipt, legs, receiptPath } = await certifyCell({
    spec,
    client: operator,
    packagePath: resolve(packagePath),
    candidateCommit,
    outDir,
    keep,
  });

  const notPassed = Object.entries(legs).filter(([, leg]) => leg.status !== 'pass');
  const runtimeVerified = notPassed.length === 0;
  process.stdout.write(
    `\n${client}/${process.platform}/${process.arch}: ${runtimeVerified ? 'RUNTIME-VERIFIED' : 'NOT CERTIFIED'} -> ${receiptPath}\n`,
  );
  if (!runtimeVerified) {
    process.stdout.write(`  ${receipt.blockedReason}\n`);
    process.stdout.write(
      '  This cell stays uncertified: an unavailable or unsigned vendor runtime is a named NO-GO ' +
        'blocker for the launch decision, never a warning.\n',
    );
    process.exitCode = 1;
  }
}

// Importable for tests without running the CLI: `main` only fires when this file IS the entry point.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
