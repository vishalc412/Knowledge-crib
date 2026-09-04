import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { neutralProtocolBody } from './adapters.js';

/**
 * P0.1 regression — the protocol-to-CLI contract. `neutralProtocolBody` (adapters.ts) is spliced
 * into the instruction file of every IDE client and tells agents to run the `crib …` commands it
 * names. Those names are generated from the same source tree this test lives in, so the contract
 * is checkable: EVERY `crib …` command the protocol text names must resolve to a real CLI
 * command/subcommand in the BUILT `dist/cli.js`. If someone adds a command name to the protocol
 * text without implementing it (the exact bug P0.1 fixed — `crib memory recall` was named but did
 * not exist), this test fails.
 *
 * MCP tool names (`brief`, `memory_observe`) are intentionally out of scope: they are served by
 * `crib serve`, not dispatched by the CLI.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-protocol-cmds-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Extract every backticked `crib …` command phrase the protocol text names. */
function protocolCribPhrases(): string[] {
  const body = neutralProtocolBody();
  const out: string[] = [];
  const re = /`crib ([^`]+)`/g;
  for (const m of body.matchAll(re)) out.push(m[1]!.trim());
  return out;
}

/**
 * Expand one phrase into the argv lists to check. Strips quoted placeholders ("<query>") and
 * expands slash alternatives token-by-token (`crib memory propose/attest` → two commands) so the
 * shorthand the protocol text uses still covers every named subcommand.
 */
function argvVariants(phrase: string): string[][] {
  const tokens = phrase
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('<') && !t.startsWith('"'));
  const variants: string[][] = [[]];
  for (const token of tokens) {
    const alternatives = token.includes('/') ? token.split('/') : [token];
    const next: string[][] = [];
    for (const v of variants) for (const alt of alternatives) next.push([...v, alt]);
    variants.splice(0, variants.length, ...next);
  }
  return variants.filter((v) => v.length > 0);
}

/** Run the built CLI with the given argv in an empty dir — command resolution only, no fixture. */
function runCli(argv: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [CLI, ...argv], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? 1, stderr: (err.stderr ?? '').trim() };
  }
}

describe('neutral protocol text — every `crib …` command it names exists', () => {
  it('the protocol names at least one crib command (the extraction itself is not bit-rotted)', () => {
    const phrases = protocolCribPhrases();
    expect(phrases.length).toBeGreaterThan(0);
    // The recall fallback is the load-bearing one — the reason P0.1 exists.
    expect(phrases.some((p) => p.startsWith('memory recall'))).toBe(true);
  });

  it('each named command resolves in the built CLI (no "unknown command"/"unknown … subcommand")', () => {
    const phrases = protocolCribPhrases();
    expect(phrases.length).toBeGreaterThan(0);
    for (const phrase of phrases) {
      for (const argv of argvVariants(phrase)) {
        const r = runCli(argv);
        expect(
          r.stderr,
          `protocol names \`crib ${phrase}\` → ran \`crib ${argv.join(' ')}\``,
        ).not.toContain('unknown command:');
        expect(
          r.stderr,
          `protocol names \`crib ${phrase}\` → ran \`crib ${argv.join(' ')}\``,
        ).not.toMatch(/unknown \S+ subcommand:/);
      }
    }
  });
});
