/**
 * `crib mcp install/list/remove` (REQ-2) — auto-wire the Knowledge-crib MCP server into each IDE's
 * config file so a user never hand-edits JSON/TOML.
 *
 * Follows the `install-hooks` precedent (`hooks.ts`): idempotent managed blocks, non-clobbering
 * writes that preserve sibling content byte-for-byte, a structured result the CLI formats, and an
 * overridable binary path (defaulting to the absolute `which crib` so GUI-launched IDEs that don't
 * inherit the shell PATH still find the server).
 *
 * Two idempotency strategies, by format:
 *  - **TOML** (Codex `config.toml`): reuses {@link spliceManaged} with `#` hash-comment markers (TOML
 *    permits them, exactly like the post-commit hook). Sibling `[mcp_servers.other]` tables survive.
 *  - **JSON** (`.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json`): JSON forbids comments, so the
 *    block-marker strategy cannot apply. Instead we parse → set the `knowledge-crib` entry by name
 *    (overwriting in place, preserving sibling servers) → reserialize. Re-running is a no-op.
 *
 * Scope: project-scoped (committable) configs for all four IDEs; global/user-scoped where the path is
 * well-defined (Cursor `~/.cursor/mcp.json`, Codex `~/.codex/config.toml`). Claude Code user-scope is
 * installed by shelling out to `claude mcp add -s user` (its user config is CLI-managed, not a file we
 * own). VS Code/Copilot user-scoped MCP is not documented by upstream, so only project-scope is offered
 * (flagged in the docs).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spliceManaged } from './hooks.js';

export type McpIde = 'claude' | 'cursor' | 'vscode' | 'codex' | 'windsurf' | 'gemini';
export type McpScope = 'project' | 'global';
const ALL_IDES: McpIde[] = ['claude', 'cursor', 'vscode', 'codex', 'windsurf', 'gemini'];
const SERVER_NAME = 'knowledge-crib';

/** Marker pair delimiting the managed TOML block (Codex config). */
const TOML_BEGIN = '# >>> knowledge-crib managed >>>';
const TOML_END = '# <<< knowledge-crib managed <<<';

export interface McpInstallOptions {
  /** IDE target, or `'all'`. */
  ide: McpIde | 'all';
  /** `'project'` (default) writes the committable per-repo file; `'global'` writes the user-scope file. */
  scope?: McpScope;
  /** Binary to embed as `command`. Defaults to the absolute `which crib` (PATH-independent). */
  bin?: string;
}

export interface McpInstallResult {
  ide: McpIde;
  scope: McpScope;
  /** Absolute config file path written. */
  configPath: string;
  /** Whether the managed entry was added vs already up to date. */
  written: boolean;
  /** The `command`/`args` embedded in the entry. */
  command: string;
  args: string[];
  /** Note for unsupported scope/IDE combos (surfaced to the user, non-fatal). */
  note?: string;
}

/** Resolve the absolute binary path: explicit override, else `which crib`, else fall back to `'crib'`. */
export function resolveBin(bin?: string): string {
  if (bin) return resolve(bin);
  try {
    return execFileSync('which', ['crib'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'crib';
  }
}

/** Quote a string for embedding in a TOML basic string value (`"…"`, backslash- + quote-escaped).
 *  Exported so tests can assert the exact serialized form without duplicating the escape rules. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Read a file as text, or `''` if absent. */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Parse a JSON file preserving existing content, or `{}` if absent/unparseable. */
function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Serialize JSON with a trailing newline (matches the rest of the codebase's on-disk style). */
function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * Set `servers[name]` (or `mcpServers[name]`) on a parsed JSON config, preserving all sibling keys.
 * Returns `{ written, obj }` where `written` is false if the entry was already byte-identical.
 */
function mergeJsonManaged(
  obj: Record<string, unknown>,
  rootKey: 'mcpServers' | 'servers',
  name: string,
  entry: Record<string, unknown>,
): { written: boolean; obj: Record<string, unknown> } {
  const servers = (obj[rootKey] as Record<string, unknown> | undefined) ?? {};
  const prev = servers[name];
  const same = prev !== undefined && JSON.stringify(prev) === JSON.stringify(sortEntry(entry));
  if (same) return { written: false, obj };
  const next = { ...obj, [rootKey]: { ...servers, [name]: sortEntry(entry) } };
  return { written: true, obj: next };
}

/** Canonical key order for an MCP server entry so byte-equality checks are stable. */
function sortEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const order = ['type', 'command', 'args', 'env'];
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in entry) out[k] = entry[k];
  for (const k of Object.keys(entry)) if (!(k in out)) out[k] = entry[k];
  return out;
}

/** Build the `args` array for an IDE entry given scope + whether the IDE interpolates a workspace var. */
function buildArgs(ide: McpIde, scope: McpScope, repoRoot: string): string[] {
  // Cursor and VS Code/Copilot interpolate ${workspaceFolder} in a per-workspace file.
  if (ide === 'cursor' || ide === 'vscode') return ['serve', '${workspaceFolder}'];
  // Claude Code project-scope spawns with CWD=project root, so '.' is portable + works.
  if (ide === 'claude' && scope === 'project') return ['serve', '.'];
  // Gemini CLI project-scope runs with CWD=project root (the .gemini/settings.json lives in the
  // repo), so '.' is portable + correct — avoids baking an absolute path into a committed file.
  if (ide === 'gemini' && scope === 'project') return ['serve', '.'];
  // Codex has no interpolation; Claude/Gemini global + Codex + Windsurf all need an absolute path.
  // The global Claude entry below uses no-arg resolution instead — see installClaudeGlobal.
  return ['serve', repoRoot];
}

/** Config target (path + writer) for one IDE/scope. `null` means unsupported (caller notes + skips). */
interface McpTarget {
  configPath: string;
  /** `'json-mcpServers' | 'json-servers' | 'toml' | 'claude-cli'` */
  format: 'json-mcpServers' | 'json-servers' | 'toml' | 'claude-cli';
}

function targetFor(ide: McpIde, scope: McpScope, repoRoot: string): McpTarget | null {
  const home = process.env.HOME ?? '';
  switch (ide) {
    case 'claude':
      // Project: committable .mcp.json (root key `mcpServers`). Global: `claude mcp add -s user`.
      return scope === 'project'
        ? { configPath: join(repoRoot, '.mcp.json'), format: 'json-mcpServers' }
        : { configPath: '<claude mcp add -s user>', format: 'claude-cli' };
    case 'cursor':
      return scope === 'project'
        ? { configPath: join(repoRoot, '.cursor', 'mcp.json'), format: 'json-mcpServers' }
        : { configPath: join(home, '.cursor', 'mcp.json'), format: 'json-mcpServers' };
    case 'vscode':
      // VS Code/Copilot: root key is `servers` (NOT `mcpServers`) + `type:"stdio"` is required.
      // User-scoped MCP config is not documented upstream → project-scope only.
      return scope === 'project'
        ? { configPath: join(repoRoot, '.vscode', 'mcp.json'), format: 'json-servers' }
        : null;
    case 'codex':
      // snake_case `[mcp_servers.<name>]`; no ${workspaceFolder} → absolute path required.
      return scope === 'project'
        ? { configPath: join(repoRoot, '.codex', 'config.toml'), format: 'toml' }
        : { configPath: join(home, '.codex', 'config.toml'), format: 'toml' };
    case 'windsurf':
      // Windsurf supports GLOBAL MCP config only (`~/.codeium/windsurf/mcp_config.json`, root key
      // `mcpServers`, stdio = command+args). No project-scoped MCP file (upstream) → project = null.
      // Verified against https://docs.windsurf.com/plugins/cascade/mcp.
      return scope === 'global'
        ? {
            configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
            format: 'json-mcpServers',
          }
        : null;
    case 'gemini':
      // Gemini CLI: `mcpServers` root key (stdio = command+args), stdio `command`+`args`. Project =
      // `.gemini/settings.json` (committed, portable with '.' args); global = `~/.gemini/settings.json`.
      // Avoid underscores in the server name — the Gemini policy parser splits `mcp_<name>_<tool>`
      // on the first underscore; `knowledge-crib` (hyphenated) is safe. Verified against
      // https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html.
      return scope === 'project'
        ? { configPath: join(repoRoot, '.gemini', 'settings.json'), format: 'json-mcpServers' }
        : { configPath: join(home, '.gemini', 'settings.json'), format: 'json-mcpServers' };
  }
}

/** Install/refresh the managed entry for one IDE. Returns the result; never throws (notes on failure). */
export function installMcp(repoRoot: string, opts: McpInstallOptions): McpInstallResult[] {
  const bin = resolveBin(opts.bin);
  const scope: McpScope = opts.scope ?? 'project';
  const ides: McpIde[] = opts.ide === 'all' ? ALL_IDES : [opts.ide];
  const absRoot = resolve(repoRoot);
  const out: McpInstallResult[] = [];

  for (const ide of ides) {
    const target = targetFor(ide, scope, absRoot);
    if (!target) {
      out.push({
        ide,
        scope,
        configPath: '',
        written: false,
        command: bin,
        args: [],
        note: `${ide} does not support ${scope}-scope MCP config (upstream); skipping.`,
      });
      continue;
    }

    // Claude global: shell out to `claude mcp add -s user` with no path arg → REQ-1 runtime resolution.
    if (target.format === 'claude-cli') {
      const args = ['serve']; // no path: resolveProjectRoot via CLAUDE_PROJECT_DIR + registry at runtime
      try {
        execFileSync('claude', ['mcp', 'add', SERVER_NAME, '-s', 'user', '--', bin, ...args], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        out.push({ ide, scope, configPath: target.configPath, written: true, command: bin, args });
      } catch {
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: false,
          command: bin,
          args,
          note: 'claude CLI not found on PATH; install Claude Code, or use project-scope `crib mcp install --ide claude`.',
        });
      }
      continue;
    }

    const args = buildArgs(ide, scope, absRoot);
    if (target.format === 'toml') {
      const block = [
        TOML_BEGIN,
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${tomlString(bin)}`,
        // Each arg is a TOML basic string → backslash- AND quote-escaped via tomlString. The earlier
        // form only quote-escaped (`a.replace(/"/g, '\\"')`), so a win32 absolute repo path like
        // `C:\Users\runneradmin\repo` serialized as `args = ["serve", "C:\Users\…\repo"]` with RAW
        // backslashes — invalid TOML (`\U`/`\C` are undefined escapes a parser rejects). Routing
        // args through tomlString matches the command-line escaping and yields valid TOML on win32.
        `args = [${args.map((a) => tomlString(a)).join(', ')}]`,
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 60',
        TOML_END,
      ].join('\n');
      const existing = readOrEmpty(target.configPath);
      const updated = spliceManaged(existing, block, TOML_BEGIN, TOML_END, !existing.length);
      const written = updated !== existing;
      if (written) {
        mkdirSync(dirname(target.configPath), { recursive: true });
        writeFileSync(target.configPath, updated, 'utf8');
      }
      out.push({ ide, scope, configPath: target.configPath, written, command: bin, args });
      continue;
    }

    // JSON config (project-scope claude/cursor/vscode, or global cursor).
    const rootKey = target.format === 'json-servers' ? 'servers' : 'mcpServers';
    const entry: Record<string, unknown> = { command: bin, args };
    if (target.format === 'json-servers') entry.type = 'stdio';
    const obj = readJson(target.configPath);
    const { written, obj: next } = mergeJsonManaged(obj, rootKey, SERVER_NAME, entry);
    if (written) writeJson(target.configPath, next);
    out.push({ ide, scope, configPath: target.configPath, written, command: bin, args });
  }
  return out;
}

/** Report the current managed-entry status for each IDE (present/absent), without writing. */
export interface McpListEntry {
  ide: McpIde;
  scope: McpScope;
  configPath: string;
  present: boolean;
}
export function listMcp(
  repoRoot: string,
  opts: { ide?: McpIde | 'all'; scope?: McpScope } = {},
): McpListEntry[] {
  const ides: McpIde[] = opts.ide ? (opts.ide === 'all' ? ALL_IDES : [opts.ide]) : ALL_IDES;
  const scopes: McpScope[] = opts.scope ? [opts.scope] : ['project', 'global'];
  const absRoot = resolve(repoRoot);
  const out: McpListEntry[] = [];
  for (const ide of ides) {
    for (const scope of scopes) {
      const target = targetFor(ide, scope, absRoot);
      if (!target) continue;
      if (target.format === 'claude-cli') {
        out.push({ ide, scope, configPath: target.configPath, present: false });
        continue;
      }
      const present =
        existsSync(target.configPath) && readOrEmpty(target.configPath).includes(SERVER_NAME);
      out.push({ ide, scope, configPath: target.configPath, present });
    }
  }
  return out;
}

/** Remove the managed entry for one IDE without touching sibling content. */
export function removeMcp(repoRoot: string, opts: McpInstallOptions): McpInstallResult[] {
  const scope: McpScope = opts.scope ?? 'project';
  const ides: McpIde[] = opts.ide === 'all' ? ALL_IDES : [opts.ide];
  const absRoot = resolve(repoRoot);
  const out: McpInstallResult[] = [];
  for (const ide of ides) {
    const target = targetFor(ide, scope, absRoot);
    if (!target) {
      out.push({
        ide,
        scope,
        configPath: '',
        written: false,
        command: '',
        args: [],
        note: `unsupported for ${ide}/${scope}`,
      });
      continue;
    }
    if (target.format === 'claude-cli') {
      try {
        execFileSync('claude', ['mcp', 'remove', SERVER_NAME, '-s', 'user'], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: true,
          command: '',
          args: [],
        });
      } catch {
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: false,
          command: '',
          args: [],
          note: 'claude CLI not found',
        });
      }
      continue;
    }
    if (!existsSync(target.configPath)) {
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: false,
        command: '',
        args: [],
      });
      continue;
    }
    if (target.format === 'toml') {
      const existing = readOrEmpty(target.configPath);
      const updated = removeManagedBlock(existing, TOML_BEGIN, TOML_END);
      if (updated !== existing) writeFileSync(target.configPath, updated, 'utf8');
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: updated !== existing,
        command: '',
        args: [],
      });
      continue;
    }
    const rootKey = target.format === 'json-servers' ? 'servers' : 'mcpServers';
    const obj = readJson(target.configPath);
    const servers = obj[rootKey] as Record<string, unknown> | undefined;
    if (servers && SERVER_NAME in servers) {
      delete servers[SERVER_NAME];
      if (Object.keys(servers).length === 0) delete obj[rootKey];
      writeJson(target.configPath, obj);
      out.push({ ide, scope, configPath: target.configPath, written: true, command: '', args: [] });
    } else {
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: false,
        command: '',
        args: [],
      });
    }
  }
  return out;
}

/** Strip the managed region between two markers (TOML). Mirrors `spliceManaged`'s removal path. */
function removeManagedBlock(content: string, beginMarker: string, endMarker: string): string {
  const beginIdx = content.indexOf(beginMarker);
  if (beginIdx === -1) return content;
  const endIdx = content.indexOf(endMarker, beginIdx);
  const before = content.slice(0, beginIdx);
  const after = endIdx === -1 ? '' : content.slice(endIdx + endMarker.length);
  const ensuredNl = (s: string) => (s.length > 0 && !s.endsWith('\n') ? `${s}\n` : s);
  return `${ensuredNl(before)}${after.replace(/^\n/, '')}`;
}
