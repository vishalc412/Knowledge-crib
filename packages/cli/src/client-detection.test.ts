/**
 * Client detection — `crib init` must wire the editor the developer actually uses, and nothing else.
 *
 * Reported from a real onboarding: a developer working in GitHub Copilot ran `crib init` and got
 * `GEMINI.md`, `.windsurfrules`, `.cursor/rules/crib.mdc`, `AGENTS.md` and `CLAUDE.md` written into
 * their repository — while `.github/copilot-instructions.md`, the one file their agent reads, was
 * buried among them. `--ide` defaulted to `all`, and the instruction-adapter step ignored `--ide`
 * entirely (it was hardcoded to `all`), so even naming a client did not stop the spray.
 *
 * Unrequested files in a repository are not a harmless default: they get committed, reviewed, and
 * inherited by everyone who clones it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_BEGIN,
  ADAPTER_END,
  detectClients,
  installCaptureHooks,
  mcpIdeForClient,
} from './adapters.js';
import { installMcp } from './mcp-install.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-detect-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** An environment with none of the signals any client sets — the "no evidence" baseline. */
const BARE: NodeJS.ProcessEnv = {};

describe('detectClients — environment signals', () => {
  it.each([
    ['claude', { CLAUDECODE: '1' }],
    ['claude', { CLAUDE_CODE_ENTRYPOINT: 'cli' }],
    ['cursor', { CURSOR_TRACE_ID: 'abc' }],
    ['cursor', { TERM_PROGRAM: 'cursor' }],
    ['windsurf', { TERM_PROGRAM: 'windsurf' }],
    ['codex', { CODEX_SANDBOX: '1' }],
    ['gemini', { GEMINI_CLI: '1' }],
    // VS Code's own agent IS Copilot, so a VS Code session resolves to the copilot adapter.
    ['copilot', { TERM_PROGRAM: 'vscode' }],
    ['copilot', { VSCODE_PID: '4242' }],
  ] as const)('identifies %s from %o', (expected, env) => {
    const detection = detectClients(repo, env);
    expect(detection.clients).toEqual([expected]);
    expect(detection.signals[0]?.source).toBe('env');
  });

  it('prefers the FORK over VS Code when a fork sets both (Cursor and Windsurf are VS Code forks)', () => {
    // A Cursor session also carries VSCODE_* variables. Resolving that to `copilot` would write
    // `.github/copilot-instructions.md` for a Cursor user.
    const detection = detectClients(repo, { CURSOR_TRACE_ID: 'x', VSCODE_PID: '1' });
    expect(detection.clients[0]).toBe('cursor');
  });

  it('reports NOTHING rather than guessing when no signal is present', () => {
    expect(detectClients(repo, BARE).clients).toEqual([]);
  });

  it('ignores a variable that merely implies a vendor relationship', () => {
    // Holding a Gemini API key does not mean the Gemini CLI is driving this session.
    expect(detectClients(repo, { GEMINI_API_KEY: 'sk-test' }).clients).toEqual([]);
  });
});

describe('detectClients — repository signals', () => {
  it('falls back to repository configuration when no client is running', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const detection = detectClients(repo, BARE);
    expect(detection.clients).toEqual(['claude']);
    expect(detection.signals[0]).toMatchObject({ source: 'repo', evidence: '.claude' });
  });

  it('does NOT treat crib’s own generated file as evidence the user runs that client', () => {
    // The decisive case. After one over-broad install every repo contains GEMINI.md; counting it
    // as proof of a Gemini user would make the original mistake permanent and self-justifying.
    writeFileSync(
      join(repo, 'GEMINI.md'),
      `${ADAPTER_BEGIN}\nthe crib protocol block\n${ADAPTER_END}\n`,
    );
    expect(detectClients(repo, BARE).clients).toEqual([]);
  });

  it('DOES treat a user-authored file as evidence, even once crib has spliced its block in', () => {
    writeFileSync(
      join(repo, 'GEMINI.md'),
      `# My own Gemini instructions\n\nUse tabs.\n\n${ADAPTER_BEGIN}\nblock\n${ADAPTER_END}\n`,
    );
    expect(detectClients(repo, BARE).clients).toEqual(['gemini']);
  });

  it('lets a running client override stale repository configuration', () => {
    mkdirSync(join(repo, '.gemini'), { recursive: true });
    // What is running now beats what was configured once.
    expect(detectClients(repo, { CLAUDECODE: '1' }).clients).toEqual(['claude']);
  });
});

/**
 * `isCribFootprint` — the WP2.5 self-justification guard. Crib's own install writes
 * `.claude/settings.json` (hooks) and `.cursor/mcp.json` (the MCP entry) — the very paths the
 * repo-signal lane reads. Without this suppression, `crib adapters install` would manufacture
 * `client-detected` evidence for every client it just configured, and the four-state report
 * (WP2.5) could never show a gap between "configured" and "actually present".
 */
describe('detectClients — crib’s own footprint is not client evidence', () => {
  it('does NOT detect claude from the settings.json crib’s hook writer produced', () => {
    installCaptureHooks(repo, { client: 'claude', scope: 'project', home: repo });
    expect(detectClients(repo, BARE).clients).not.toContain('claude');
  });

  it('does NOT detect cursor from the mcp.json crib’s MCP writer produced', () => {
    installMcp(repo, { ide: 'cursor', scope: 'project', bin: '/bin/crib' });
    expect(detectClients(repo, BARE).clients).not.toContain('cursor');
  });

  it('does NOT detect codex from the config.toml managed block crib wrote', () => {
    installMcp(repo, { ide: 'codex', scope: 'project', bin: '/bin/crib' });
    expect(detectClients(repo, BARE).clients).not.toContain('codex');
  });

  it('DOES detect a client when the user has real content alongside crib’s managed block', () => {
    // The user's own hooks in the same settings.json prove a Claude Code user exists here;
    // suppression must not swallow genuine evidence to protect its own honesty rule.
    installCaptureHooks(repo, { client: 'claude', scope: 'project', home: repo });
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
    // The writer's own buckets are SessionStart/Stop/PostToolUse; add the user's hook alongside.
    settings.hooks.Stop ??= [];
    settings.hooks.Stop.push({
      matcher: 'Write',
      hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }],
    });
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
    expect(detectClients(repo, BARE).clients).toContain('claude');
  });

  it('DOES detect a client whose config file has a sibling server crib did not write', () => {
    installMcp(repo, { ide: 'cursor', scope: 'project', bin: '/bin/crib' });
    const mcp = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
    mcp.mcpServers['my-own-server'] = { command: '/usr/local/bin/other', args: [] };
    writeFileSync(join(repo, '.cursor', 'mcp.json'), JSON.stringify(mcp, null, 2));
    expect(detectClients(repo, BARE).clients).toContain('cursor');
  });

  it('still counts an EMPTY .claude directory as user evidence (pinned pre-WP2.5 behavior)', () => {
    // A user who created `.claude` by hand but put nothing in it still chose Claude Code; only
    // non-empty crib-managed content is a footprint.
    mkdirSync(join(repo, '.claude'), { recursive: true });
    expect(detectClients(repo, BARE).clients).toEqual(['claude']);
  });
});

describe('mcpIdeForClient', () => {
  it('maps copilot onto the vscode config writer (.vscode/mcp.json IS the Copilot config)', () => {
    expect(mcpIdeForClient('copilot')).toBe('vscode');
  });

  it('leaves every other client on its own config', () => {
    for (const id of ['claude', 'cursor', 'codex', 'windsurf', 'gemini'] as const) {
      expect(mcpIdeForClient(id)).toBe(id);
    }
  });
});
