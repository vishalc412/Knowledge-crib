#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchableCommand, sanitizeOutput, whichSync } from './client-certify.mjs';
/**
 * Platform desktop-control backends for the native editor certification scenarios.
 *
 * The plan is explicit about HOW a desktop driver may control an editor: through the platform's
 * accessibility tree — roles, identifiers, names, and documented keyboard commands — never through
 * fixed screen coordinates, which break on the first layout change and say nothing about WHICH
 * control was actually hit. Each supported platform therefore gets a helper program that speaks one
 * common automation contract, implemented over that platform's accessibility API:
 *
 *   darwin → Swift helper over Apple Accessibility (AXUIElement)
 *   win32  → C# helper over Microsoft UI Automation
 *   linux  → Python helper over GNOME AT-SPI (pyatspi)
 *
 * The helpers are SHIPPED AS SOURCE next to this file (scripts/lib/desktop/). A certification host
 * resolves the runtime itself, which is a deliberate provisioning gate: a host that cannot resolve
 * the runtime is named as blocked, rather than discovering mid-scenario that every control
 * operation fails. Nothing is installed or downloaded: darwin and linux resolve an interpreter
 * `which`-style from PATH, and win32 compiles the helper locally with the machine's own .NET
 * Framework compiler (C:\Windows\Microsoft.NET\...\csc.exe — present on every Windows install),
 * caching the exe keyed by the helper source's digest, so importing this module is safe on every
 * host, including CI: resolution is PATH probing, a source-file existence check and — on win32
 * only, at resolve time — one local compile through the machine's own toolchain.
 *
 * The one wire protocol, shared by all three helpers: the operation name and a JSON payload arrive
 * as argv, and exactly one JSON envelope goes back on stdout —
 *   {"ok": true,  "operation": "<operation>", "result": {...}}
 *   {"ok": false, "operation": "<operation>", "error": "no element matched role=..."}
 * The envelope keeps the scenario engine free of per-platform parsing: every platform difference
 * lives behind the same nine verbs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The common automation contract — exactly the nine operations the plan names, in the plan's order.
 * The scenario engine and every helper dispatch over THIS list, never over a private copy, so a
 * helper that silently drops an operation fails the coverage check in the suite instead of shipping
 * a backend that cannot perform a step the scenario needs.
 */
export const AUTOMATION_CONTRACT = [
  'inspectSession',
  'launchApplication',
  'findElement',
  'invokeElement',
  'setText',
  'sendKeys',
  'waitForState',
  'captureDiagnostics',
  'terminateApplication',
];

/** How long the one-shot local win32 compile may take before it is named as blocked. */
const WIN_COMPILE_TIMEOUT_MS = 120_000;

/**
 * The desktop backend for each certification platform. `helperSource` is repo-relative on purpose:
 * the path is resolvable from THIS file, so a checkout always finds its own helpers, and a missing
 * helper file is a named blocker naming the exact path that is absent.
 */
export const DESKTOP_BACKENDS = {
  darwin: {
    id: 'darwin',
    technology: 'Apple Accessibility APIs (AXUIElement)',
    helperSource: 'lib/desktop/mac-helper.swift',
    // `swift` runs a .swift source directly; it ships with Xcode Command Line Tools.
    interpreterCandidates: ['swift'],
  },
  win32: {
    id: 'win32',
    technology: 'Microsoft UI Automation',
    helperSource: 'lib/desktop/win-helper.cs',
    // The helper is written as C# 5 for the .NET Framework compiler that is part of every Windows
    // install, so the win32 backend needs NO provisioned toolchain: it compiles the shipped source
    // with the machine's own csc and caches the exe beside the helper digest in the temp dir.
    compilerCandidates: [
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
    ],
    references: [
      'System.dll',
      'System.Core.dll',
      'System.Windows.Forms.dll',
      'UIAutomationClient.dll',
      'UIAutomationTypes.dll',
      'System.Web.Extensions.dll',
    ],
  },
  linux: {
    id: 'linux',
    technology: 'GNOME AT-SPI (pyatspi)',
    helperSource: 'lib/desktop/linux-helper.py',
    interpreterCandidates: ['python3'],
  },
};

/**
 * Where the locally compiled win32 helper exe is cached: keyed by the helper SOURCE's digest, so a
 * checkout whose helper changed can never reuse the exe an older source produced, and an unchanged
 * helper is compiled exactly once per machine.
 */
function cachedWinHelperExe(helperPath) {
  const source = readFileSync(helperPath, 'utf8');
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return join(tmpdir(), `crib-win-helper-${digest}.exe`);
}

/**
 * Compile the win32 helper with the machine's own Framework csc. Returns {exePath} on success or
 * {error} naming the compiler and its diagnostics — the compile happens at RESOLVE time, so a host
 * without a usable UI Automation toolchain is blocked before a scenario launches any editor, not
 * mid-scenario.
 */
function compileWinHelper(compiler, helperPath, backend, options) {
  const exists = options.exists ?? existsSync;
  const spawn = options.spawn ?? spawnSync;
  let exePath;
  try {
    exePath = cachedWinHelperExe(helperPath);
  } catch (error) {
    return {
      error: `the UI Automation helper source could not be read for compilation: ${error.message}`,
    };
  }
  if (exists(exePath)) return { exePath, cached: true };
  const compiled = spawn(
    compiler,
    [
      '/nologo',
      `/out:${exePath}`,
      ...backend.references.map((reference) => `/r:${reference}`),
      helperPath,
    ],
    { encoding: 'utf8', timeout: WIN_COMPILE_TIMEOUT_MS },
  );
  if (compiled.error) {
    return {
      error: `the UI Automation helper failed to compile with ${compiler}: ${compiled.error.message}`,
    };
  }
  if (compiled.status !== 0) {
    return {
      error:
        `the UI Automation helper failed to compile with ${compiler} (exit ${compiled.status}): ` +
        `${sanitizeOutput(`${compiled.stderr ?? ''}`.trim()).slice(0, 500)}`,
    };
  }
  if (!exists(exePath)) {
    return { error: `the compiler reported success but no helper exe appeared at ${exePath}` };
  }
  return { exePath };
}

/**
 * Resolve the desktop backend for a platform: the helper SOURCE must exist in this checkout, and a
 * runtime that can run it must be available — an interpreter on PATH for darwin/linux, or the
 * machine's own Framework compiler for win32 (which locally compiles the helper and caches the
 * exe). Every failure is a named blocker — "the macOS automation interpreter is not installed" is
 * a provisioning fact an operator can act on, while a generic "cannot automate this platform" is
 * not.
 *
 * `options.which` / `options.exists` / `options.spawn` are injectable so the suite can exercise
 * every resolution branch on any host, including the platforms this host is not.
 */
export function resolveDesktopBackend(platform, options = {}) {
  const backend = DESKTOP_BACKENDS[platform];
  if (!backend) {
    return {
      status: 'blocked',
      reason: `no desktop automation backend for platform ${platform} (supported: ${Object.keys(DESKTOP_BACKENDS).join(', ')})`,
    };
  }
  const which = options.which ?? whichSync;
  const exists = options.exists ?? existsSync;
  const helperPath = resolve(HERE, backend.helperSource);
  if (!exists(helperPath)) {
    return {
      status: 'blocked',
      reason: `${backend.technology} helper source is missing from the checkout: ${backend.helperSource}`,
    };
  }
  if (backend.interpreterCandidates) {
    const interpreter = backend.interpreterCandidates
      .map((name) => which(name))
      .find((resolved) => resolved !== undefined);
    if (!interpreter) {
      return {
        status: 'blocked',
        reason: `no ${backend.technology} interpreter found on PATH (tried: ${backend.interpreterCandidates.join(', ')}) — provision the desktop automation runtime before a GUI scenario can run`,
      };
    }
    return { status: 'pass', backend, helperPath, interpreter };
  }
  if (backend.compilerCandidates) {
    const compiler = backend.compilerCandidates
      .map((candidate) => (exists(candidate) ? candidate : undefined))
      .find((resolved) => resolved !== undefined);
    if (!compiler) {
      return {
        status: 'blocked',
        reason: `no ${backend.technology} compiler found on this host (tried: ${backend.compilerCandidates.join(', ')}) — provision the desktop automation runtime before a GUI scenario can run`,
      };
    }
    const compiled = compileWinHelper(compiler, helperPath, backend, options);
    if (compiled.error) {
      return { status: 'blocked', reason: compiled.error };
    }
    return {
      status: 'pass',
      backend,
      helperPath,
      interpreter: compiled.exePath,
      compiled: true,
    };
  }
  return {
    status: 'blocked',
    reason: `the ${platform} desktop backend declares no runtime (neither interpreterCandidates nor compilerCandidates)`,
  };
}

/**
 * How to spawn one contract operation: an interpreted helper runs as `[interpreter, helperPath,
 * operation, payloadJson]`; a LOCALLY COMPILED helper is the executable itself, so the helper path
 * argument is gone: `[exe, operation, payloadJson]`. Either way the command is mapped through the
 * platform-safe launch rules (a `.cmd` interpreter shim on Windows is invoked through cmd.exe with
 * its own argv slots, never a shell string). The operation must be in the contract — an operation
 * outside it is a wiring bug, and failing loudly here is the only way the operator sees it before a
 * scenario half-runs.
 */
export function backendInvocation(
  { backend, helperPath, interpreter, compiled },
  operation,
  payload = {},
  platform = process.platform,
) {
  if (!AUTOMATION_CONTRACT.includes(operation)) {
    throw new Error(
      `unknown automation operation: ${operation} (contract: ${AUTOMATION_CONTRACT.join(', ')})`,
    );
  }
  const args = compiled
    ? [operation, JSON.stringify(payload)]
    : [helperPath, operation, JSON.stringify(payload)];
  return launchableCommand(interpreter, args, platform);
}

/**
 * Run one contract operation and return the helper's `result`. Every failure mode is a NAMED error
 * carrying the operation, never a bare spawn status: a findElement that could not find the enable
 * control names the role and name it lost; exit code 127 does not. Helper stdout is sanitized
 * before it can enter an error message — the helpers traverse the accessibility tree, which can
 * contain anything an editor chose to render.
 *
 * The spawn timeout follows the PAYLOAD's own budget when the operation carries one (waitForState
 * declares its UI-transition deadline), plus a grace margin for helper startup — a helper killed
 * at exactly its state-deadline has not timed out, the operation inside it has.
 */
export function invokeBackend(resolved, operation, payload = {}, options = {}) {
  if (!resolved || resolved.status !== 'pass') {
    throw new Error(`desktop backend is not resolved (${resolved?.reason ?? 'unknown'})`);
  }
  const { command, args } = backendInvocation(resolved, operation, payload, options.platform);
  const payloadBudget =
    typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
      ? payload.timeoutMs + 15_000
      : 60_000;
  const run = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? payloadBudget,
    ...(options.env ? { env: options.env } : {}),
  });
  if (run.error) {
    throw new Error(
      `${operation} failed to start the ${resolved.backend.technology} helper: ${run.error.message}`,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse((run.stdout ?? '').trim() || 'null');
  } catch {
    throw new Error(
      `${operation} returned unparseable output from the ${resolved.backend.technology} helper (exit ${run.status})`,
    );
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new Error(`${operation} returned no JSON envelope (exit ${run.status})`);
  }
  if (envelope.ok !== true) {
    throw new Error(
      `${operation} failed: ${sanitizeOutput(envelope.error ?? 'the helper reported no error')}`,
    );
  }
  return envelope.result;
}
