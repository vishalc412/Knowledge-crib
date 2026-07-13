#!/usr/bin/env node
/**
 * `crib` / `knowledge-crib` launcher — the canonical npm bin entry.
 *
 * Two responsibilities that MUST run before `node:sqlite` is loaded (the
 * core soul backend uses it, and it is the reason Node ≥ 22.5 is required):
 *
 * 1. Node version guard — print a clear, actionable message and exit 1
 *    on an unsupported runtime instead of letting `node:sqlite` throw an
 *    opaque `MODULE_NOT_FOUND` / experimental crash.
 * 2. Suppress the noisy `node:sqlite` ExperimentalWarning from stderr so
 *    the installed CLI stays quiet for end users and MCP clients.
 *
 * Both happen here, in this thin module, before `cli.js` is dynamically
 * imported. Static imports are hoisted and evaluated before a module
 * body runs, so `cli.ts` itself cannot do this — its `@knowledge-crib/core`
 * import loads `node:sqlite` first.
 */
const REQUIRED_NODE = '22.5.0';

function nodeVersionOk(): boolean {
  const parts = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  const reqParts = REQUIRED_NODE.split('.').map((n) => Number.parseInt(n, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const reqMajor = reqParts[0] ?? 0;
  const reqMinor = reqParts[1] ?? 0;
  return major > reqMajor || (major === reqMajor && minor >= reqMinor);
}

if (!nodeVersionOk()) {
  process.stderr.write(
    `knowledge-crib requires Node ${REQUIRED_NODE} or newer (found ${process.versions.node}).\nUpgrade Node, then re-run \`crib\`.\n`,
  );
  process.exit(1);
}

// Silence the one node:sqlite ExperimentalWarning; let every other warning through.
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning, ctorOrOptions, code, ctor) => {
  const text = typeof warning === 'string' ? warning : String(warning);
  if (/SQLite is an experimental feature/i.test(text)) return;
  return originalEmitWarning(warning, ctorOrOptions as never, code, ctor);
}) as typeof process.emitWarning;

// Dynamic import: cli.js self-invokes main(process.argv) on load.
export {};
await import('./cli.js');
