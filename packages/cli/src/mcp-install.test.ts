import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type McpInstallResult, installMcp, listMcp, removeMcp } from './mcp-install.js';

const BIN = '/usr/local/bin/crib';
const NAME = 'knowledge-crib';

let repo: string;
let home: string;
let savedHome: string | undefined;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-mcp-'));
  home = mkdtempSync(join(tmpdir(), 'crib-home-'));
  savedHome = process.env.HOME;
  process.env.HOME = home; // isolate user-scope writes (cursor/codex global)
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) process.env.HOME = undefined;
  else process.env.HOME = savedHome;
});

/** First result of an install/remove call (single-ide calls always return exactly one). */
function first(results: McpInstallResult[]): McpInstallResult {
  return results[0]!;
}

function parse(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('installMcp — claude (project-scope .mcp.json)', () => {
  it('writes mcpServers.knowledge-crib with portable ["serve","."]', () => {
    const r = first(installMcp(repo, { ide: 'claude', scope: 'project', bin: BIN }));
    expect(r.written).toBe(true);
    expect(r.configPath).toBe(join(repo, '.mcp.json'));
    const cfg = parse(r.configPath);
    const entry = (cfg.mcpServers as Record<string, { command: string; args: string[] }>)[NAME]!;
    expect(entry.command).toBe(BIN);
    expect(entry.args).toEqual(['serve', '.']); // portable: project-scope spawns with CWD=root
  });

  it('preserves sibling servers and is idempotent', () => {
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
    );
    installMcp(repo, { ide: 'claude', scope: 'project', bin: BIN });
    const cfg = parse(join(repo, '.mcp.json'));
    expect((cfg.mcpServers as Record<string, unknown>).other).toBeDefined();
    // second run is a no-op
    const second = first(installMcp(repo, { ide: 'claude', scope: 'project', bin: BIN }));
    expect(second.written).toBe(false);
    // sibling still intact after re-run
    expect(
      (parse(join(repo, '.mcp.json')).mcpServers as Record<string, unknown>).other,
    ).toBeDefined();
  });
});

describe('installMcp — cursor (project + global)', () => {
  it('project: writes .cursor/mcp.json with ${workspaceFolder}', () => {
    const r = first(installMcp(repo, { ide: 'cursor', scope: 'project', bin: BIN }));
    expect(r.written).toBe(true);
    expect(existsSync(join(repo, '.cursor', 'mcp.json'))).toBe(true); // mkdir created the dir
    const entry = (
      parse(join(repo, '.cursor', 'mcp.json')).mcpServers as Record<string, { args: string[] }>
    )[NAME]!;
    expect(entry.args).toEqual(['serve', '${workspaceFolder}']);
  });

  it('global: writes ~/.cursor/mcp.json', () => {
    const r = first(installMcp(repo, { ide: 'cursor', scope: 'global', bin: BIN }));
    expect(r.configPath).toBe(join(home, '.cursor', 'mcp.json'));
    expect(existsSync(r.configPath)).toBe(true);
  });
});

describe('installMcp — vscode/copilot (project-scope, servers + type:stdio)', () => {
  it('writes .vscode/mcp.json under `servers` with type:stdio (NOT mcpServers)', () => {
    const r = first(installMcp(repo, { ide: 'vscode', scope: 'project', bin: BIN }));
    expect(r.written).toBe(true);
    const cfg = parse(join(repo, '.vscode', 'mcp.json'));
    expect(cfg.servers).toBeDefined();
    expect(cfg.mcpServers).toBeUndefined(); // wrong root key would silently load nothing
    const entry = (cfg.servers as Record<string, { type: string; args: string[] }>)[NAME]!;
    expect(entry.type).toBe('stdio');
    expect(entry.args).toEqual(['serve', '${workspaceFolder}']);
  });

  it('global scope is unsupported → notes + skips (no file written)', () => {
    const r = first(installMcp(repo, { ide: 'vscode', scope: 'global', bin: BIN }));
    expect(r.written).toBe(false);
    expect(r.note).toMatch(/does not support global/);
    expect(r.configPath).toBe('');
  });
});

describe('installMcp — codex (TOML, snake_case, absolute path, project + global)', () => {
  it('project: writes .codex/config.toml with [mcp_servers.knowledge-crib] + absolute path', () => {
    const r = first(installMcp(repo, { ide: 'codex', scope: 'project', bin: BIN }));
    expect(r.written).toBe(true);
    expect(r.args).toEqual(['serve', repo]); // codex has no interpolation → absolute path
    const toml = readFileSync(join(repo, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.knowledge-crib]');
    expect(toml).toContain(`command = "${BIN}"`);
    expect(toml).toContain(`args = ["serve", "${repo}"]`);
    expect(toml).toContain('startup_timeout_sec = 20');
  });

  it('preserves a sibling [mcp_servers.other] table and is idempotent', () => {
    mkdirSync(join(repo, '.codex'), { recursive: true });
    writeFileSync(
      join(repo, '.codex', 'config.toml'),
      '[mcp_servers.other]\ncommand = "x"\nargs = []\n',
    );
    installMcp(repo, { ide: 'codex', scope: 'project', bin: BIN });
    const toml = readFileSync(join(repo, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.other]'); // sibling preserved
    expect(toml).toContain('[mcp_servers.knowledge-crib]');
    // re-run is a no-op (managed block replaced in place, not duplicated)
    installMcp(repo, { ide: 'codex', scope: 'project', bin: BIN });
    const after = readFileSync(join(repo, '.codex', 'config.toml'), 'utf8');
    expect(after).toBe(toml);
    expect(after.split('[mcp_servers.knowledge-crib]').length - 1).toBe(1); // exactly one block
  });

  it('global: writes ~/.codex/config.toml', () => {
    const r = first(installMcp(repo, { ide: 'codex', scope: 'global', bin: BIN }));
    expect(r.configPath).toBe(join(home, '.codex', 'config.toml'));
    expect(existsSync(r.configPath)).toBe(true);
  });
});

describe('installMcp — --ide all', () => {
  it('writes all four project-scope configs in one call', () => {
    const results = installMcp(repo, { ide: 'all', scope: 'project', bin: BIN });
    const ides = results.map((r) => r!.ide).sort();
    expect(ides).toEqual(['claude', 'codex', 'cursor', 'vscode']);
    for (const r of results) expect(r!.written).toBe(true);
  });
});

describe('listMcp + removeMcp', () => {
  it('list reports present/absent and remove strips only the managed entry', () => {
    installMcp(repo, { ide: 'all', scope: 'project', bin: BIN });
    const list = listMcp(repo, { scope: 'project' });
    expect(
      list
        .filter((e) => e.present)
        .map((e) => e.ide)
        .sort(),
    ).toEqual(['claude', 'codex', 'cursor', 'vscode']);

    // Seed a sibling server into claude's file, then remove knowledge-crib only.
    const claudePath = join(repo, '.mcp.json');
    const cfg = parse(claudePath);
    (cfg.mcpServers as Record<string, unknown>).other = { command: 'x', args: [] };
    writeFileSync(claudePath, JSON.stringify(cfg));

    removeMcp(repo, { ide: 'claude', scope: 'project', bin: BIN });
    const after = parse(claudePath);
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined(); // sibling kept
    expect((after.mcpServers as Record<string, unknown>)[NAME]).toBeUndefined(); // ours gone
  });

  it('remove on codex strips the managed block but keeps siblings', () => {
    mkdirSync(join(repo, '.codex'), { recursive: true });
    writeFileSync(
      join(repo, '.codex', 'config.toml'),
      '[mcp_servers.other]\ncommand = "x"\nargs = []\n',
    );
    installMcp(repo, { ide: 'codex', scope: 'project', bin: BIN });
    removeMcp(repo, { ide: 'codex', scope: 'project', bin: BIN });
    const toml = readFileSync(join(repo, '.codex', 'config.toml'), 'utf8');
    expect(toml).not.toContain('knowledge-crib');
    expect(toml).toContain('[mcp_servers.other]'); // sibling kept
  });
});
