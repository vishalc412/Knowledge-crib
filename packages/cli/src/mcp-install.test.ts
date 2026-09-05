import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type McpInstallResult,
  installMcp,
  listMcp,
  removeMcp,
  resolveBin,
  tomlString,
} from './mcp-install.js';

const BIN = '/usr/local/bin/crib';
// resolveBin applies path.resolve — a no-op on posix (`/usr/local/bin/crib` is already absolute)
// but on win32 a leading `/` means "root of the current drive" → `D:\usr\local\bin\crib`. The
// earlier assertions compared entry.command to the RAW BIN, which only round-trips on posix.
// Asserting RESOLVED_BIN matches the code's actual (correct, PATH-independent) behavior on both.
const RESOLVED_BIN = resolveBin(BIN);
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
    expect(entry.command).toBe(RESOLVED_BIN);
    expect(entry.args).toEqual(['serve', '.']); // portable: project-scope spawns with CWD=root
    expect(r.restartRequired).toBe(true);
    expect(r.restartInstruction).toMatch(/restart Claude Code/i);
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
    expect(second.restartRequired).toBe(false);
    // sibling still intact after re-run
    expect(
      (parse(join(repo, '.mcp.json')).mcpServers as Record<string, unknown>).other,
    ).toBeDefined();
    const listed = listMcp(repo, { ide: 'claude', scope: 'project' })[0]!;
    expect(listed.restartRequired).toBe(true);
    expect(listed.restartInstruction).toMatch(/restart Claude Code/i);
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
    // tomlString applies backslash- + quote-escaping + wraps in quotes. On win32 RESOLVED_BIN is
    // `D:\usr\local\bin\crib` → serialized `command = "D:\\usr\\local\\bin\\crib"` (valid TOML).
    // The earlier `command = "${BIN}"` asserted the raw posix path → mismatch on win32.
    expect(toml).toContain(`command = ${tomlString(RESOLVED_BIN)}`);
    // Args go through the same tomlString escaping now (win32 repo path backslashes escaped).
    expect(toml).toContain(`args = ["serve", ${tomlString(repo)}]`);
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

describe('installMcp — windsurf (global-only, json-mcpServers)', () => {
  it('global: writes ~/.codeium/windsurf/mcp_config.json under mcpServers', () => {
    const r = first(installMcp(repo, { ide: 'windsurf', scope: 'global', bin: BIN }));
    expect(r.written).toBe(true);
    expect(r.configPath).toBe(join(home, '.codeium', 'windsurf', 'mcp_config.json'));
    expect(r.args).toEqual(['serve', repo]); // windsurf has no interpolation → absolute path
    const cfg = parse(r.configPath);
    const entry = (cfg.mcpServers as Record<string, { command: string; args: string[] }>)[NAME]!;
    expect(entry.command).toBe(RESOLVED_BIN);
    expect(entry.args).toEqual(['serve', repo]);
  });

  it('project scope is unsupported → notes + skips (no file written)', () => {
    const r = first(installMcp(repo, { ide: 'windsurf', scope: 'project', bin: BIN }));
    expect(r.written).toBe(false);
    expect(r.note).toMatch(/does not support project-scope/);
    expect(r.configPath).toBe('');
  });

  it('preserves sibling servers under mcpServers and is idempotent', () => {
    installMcp(repo, { ide: 'windsurf', scope: 'global', bin: BIN });
    const cfg = parse(join(home, '.codeium', 'windsurf', 'mcp_config.json'));
    (cfg.mcpServers as Record<string, unknown>).other = { command: 'x', args: [] };
    writeFileSync(join(home, '.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify(cfg));
    const second = first(installMcp(repo, { ide: 'windsurf', scope: 'global', bin: BIN }));
    expect(second.written).toBe(false); // byte-identical re-run is a no-op
    const after = parse(join(home, '.codeium', 'windsurf', 'mcp_config.json'));
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
  });
});

describe('installMcp — gemini (project + global, json-mcpServers, portable ".")', () => {
  it('project: writes .gemini/settings.json with portable ["serve","."]', () => {
    const r = first(installMcp(repo, { ide: 'gemini', scope: 'project', bin: BIN }));
    expect(r.written).toBe(true);
    expect(r.configPath).toBe(join(repo, '.gemini', 'settings.json'));
    expect(r.args).toEqual(['serve', '.']); // project-scope runs with CWD=root → portable
    const cfg = parse(r.configPath);
    const entry = (cfg.mcpServers as Record<string, { command: string; args: string[] }>)[NAME]!;
    expect(entry.command).toBe(RESOLVED_BIN);
    expect(entry.args).toEqual(['serve', '.']);
  });

  it('global: writes ~/.gemini/settings.json (absolute path)', () => {
    const r = first(installMcp(repo, { ide: 'gemini', scope: 'global', bin: BIN }));
    expect(r.written).toBe(true);
    expect(r.configPath).toBe(join(home, '.gemini', 'settings.json'));
    expect(r.args).toEqual(['serve', repo]); // global needs an absolute path
    expect(existsSync(r.configPath)).toBe(true);
  });

  it('project preserves sibling mcpServers and is idempotent', () => {
    mkdirSync(join(repo, '.gemini'), { recursive: true });
    writeFileSync(
      join(repo, '.gemini', 'settings.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
    );
    installMcp(repo, { ide: 'gemini', scope: 'project', bin: BIN });
    const cfg = parse(join(repo, '.gemini', 'settings.json'));
    expect((cfg.mcpServers as Record<string, unknown>).other).toBeDefined();
    const second = first(installMcp(repo, { ide: 'gemini', scope: 'project', bin: BIN }));
    expect(second.written).toBe(false);
  });
});

describe('installMcp — --ide all', () => {
  it('writes all project-scope configs in one call (windsurf skipped — global-only upstream)', () => {
    const results = installMcp(repo, { ide: 'all', scope: 'project', bin: BIN });
    // all six ides return a result (windsurf as a non-fatal skip: project-scope unsupported upstream).
    const ides = results.map((r) => r!.ide).sort();
    expect(ides).toEqual(['claude', 'codex', 'cursor', 'gemini', 'vscode', 'windsurf']);
    // the five supported project-scope ides wrote a config; windsurf is a skip (written:false + note).
    for (const r of results) {
      if (r!.ide === 'windsurf') {
        expect(r!.written).toBe(false);
        expect(r!.note).toBeDefined();
        expect(r!.configPath).toBe('');
      } else {
        expect(r!.written).toBe(true);
      }
    }
  });
});

describe('listMcp + removeMcp', () => {
  it('list reports present/absent and remove strips only the managed entry', () => {
    installMcp(repo, { ide: 'all', scope: 'project', bin: BIN });
    const list = listMcp(repo, { scope: 'project' });
    // listMcp skips null targets (windsurf has no project-scope config) → 5 present ides.
    expect(
      list
        .filter((e) => e.present)
        .map((e) => e.ide)
        .sort(),
    ).toEqual(['claude', 'codex', 'cursor', 'gemini', 'vscode']);

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
