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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spliceManaged } from './hooks.js';

export type McpIde = 'claude' | 'cursor' | 'vscode' | 'codex' | 'windsurf' | 'gemini';
export type McpScope = 'project' | 'global';
const ALL_IDES: McpIde[] = ['claude', 'cursor', 'vscode', 'codex', 'windsurf', 'gemini'];
/** The managed server entry name — exported so detection can recognize crib's own footprint in a
 *  config file without duplicating the literal. */
export const SERVER_NAME = 'knowledge-crib';

/** Marker pair delimiting the managed TOML block (Codex config). Exported for the same reason. */
export const TOML_BEGIN = '# >>> knowledge-crib managed >>>';
export const TOML_END = '# <<< knowledge-crib managed <<<';

export interface McpInstallOptions {
  /** IDE target, or `'all'`. */
  ide: McpIde | 'all';
  /** `'project'` (default) writes the committable per-repo file; `'global'` writes the user-scope file. */
  scope?: McpScope;
  /** Binary to embed as `command`. Defaults to the absolute `which crib` (PATH-independent). */
  bin?: string;
  /** Home directory for user-scope paths. Defaults to `process.env.HOME`. Overridable so callers
   *  (tests, the four-state install report) can inspect an environment instead of the real one. */
  home?: string;
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
  /** True only when this operation changed a host configuration that must be reloaded. */
  restartRequired: boolean;
  /** Host-specific reload instruction; never implies that a hot reload already happened. */
  restartInstruction: string;
  /** Note for unsupported scope/IDE combos (surfaced to the user, non-fatal). */
  note?: string;
  /** True when the install was REFUSED to protect an existing file. `written` is false and the
   *  file on disk is byte-for-byte unchanged; {@link problem} names what to fix. */
  refused?: boolean;
  /** Structured refusal detail — present exactly when `refused` is true. */
  problem?: McpConfigProblem;
}

/** A config file crib will not write because it cannot understand it. Carries the location so the
 *  user can open the file at the offending point rather than being told only "it is broken". */
export interface McpConfigProblem {
  kind: 'config-malformed';
  configPath: string;
  message: string;
  /** 1-based; 1/1 when the parser reports no position (e.g. a valid JSON value of the wrong type). */
  line: number;
  column: number;
  fix: string;
}

const MCP_HOST_LABELS: Record<McpIde, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
  codex: 'Codex',
  windsurf: 'Windsurf',
  gemini: 'Gemini CLI',
};

function restartFields(
  ide: McpIde,
  restartRequired: boolean,
): Pick<McpInstallResult, 'restartRequired' | 'restartInstruction'> {
  return {
    restartRequired,
    restartInstruction: `Restart ${MCP_HOST_LABELS[ide]} so it reloads the knowledge-crib MCP configuration.`,
  };
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

/**
 * Read a JSON config as one of three DISTINCT states. The earlier reader returned `{}` for both
 * "absent" and "unparseable", so a file crib could not understand was merged into an empty object
 * and written back as a crib-only config — silent loss of the user's servers (A04). Absent means
 * create; malformed means refuse and keep the bytes.
 */
type JsonConfigRead =
  | { state: 'missing' }
  | { state: 'ok'; obj: Record<string, unknown>; text: string; hasComments: boolean }
  | { state: 'malformed'; message: string; line: number; column: number };

function readJsonConfig(path: string, allowComments: boolean): JsonConfigRead {
  if (!existsSync(path)) return { state: 'missing' };
  const text = readFileSync(path, 'utf8');
  if (text.trim().length === 0) return { state: 'missing' }; // an empty file is nothing to lose
  const masked = allowComments ? maskJsonComments(text) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(masked);
  } catch (err) {
    return { state: 'malformed', ...parseErrorLocation(text, err as Error) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return {
      state: 'malformed',
      message: 'the top level of this config is not a JSON object',
      line: 1,
      column: 1,
    };
  return {
    state: 'ok',
    obj: parsed as Record<string, unknown>,
    text,
    hasComments: masked !== text,
  };
}

/** Turn a `JSON.parse` failure into a message plus a 1-based line/column in the ORIGINAL text.
 *  V8 reports `(line X column Y)` on newer runtimes and only `position N` on older ones. */
function parseErrorLocation(
  text: string,
  err: Error,
): { message: string; line: number; column: number } {
  const message = err.message.replace(/\s+in JSON at position.*$/s, '');
  const lineCol = err.message.match(/line (\d+) column (\d+)/);
  if (lineCol) return { message, line: Number(lineCol[1]), column: Number(lineCol[2]) };
  const pos = err.message.match(/position (\d+)/);
  if (!pos) return { message, line: 1, column: 1 };
  const offset = Math.min(Number(pos[1]), text.length);
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { message, line, column: offset - before.lastIndexOf('\n') };
}

/** Blank out `//` and `/* *\/` comments while preserving every byte OFFSET and line break, so a
 *  parse error position and a structural scan both still point into the original text. */
function maskJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i] as string;
    if (inString) {
      if (c === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index just past the string literal starting at `i` (which must be the opening quote). */
function endOfString(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2;
      continue;
    }
    if (s[j] === '"') return j + 1;
    j++;
  }
  return s.length;
}

/** Index just past the JSON value starting at `i` (object, array, string or primitive). */
function endOfValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return endOfString(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    let j = i;
    while (j < s.length) {
      const d = s[j] as string;
      if (d === '"') {
        j = endOfString(s, j);
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return s.length;
  }
  let j = i;
  while (j < s.length && !',}] \t\n\r'.includes(s[j] as string)) j++;
  return j;
}

interface MemberSpan {
  /** Start of the `"key"` token. */
  memberStart: number;
  /** End of the member's value (exclusive), before any trailing comma. */
  memberEnd: number;
  valueStart: number;
}

/** Locate `"key": value` directly inside the object body spanning [bodyStart, bodyEnd). Nested
 *  objects are skipped wholesale, so only top-level members of THIS object match. */
function findMember(s: string, bodyStart: number, bodyEnd: number, key: string): MemberSpan | null {
  let i = bodyStart;
  while (i < bodyEnd) {
    const c = s[i] as string;
    if (c === '"') {
      const keyEnd = endOfString(s, i);
      const name = s.slice(i + 1, keyEnd - 1);
      let j = keyEnd;
      while (j < bodyEnd && /\s/.test(s[j] as string)) j++;
      if (s[j] !== ':') {
        i = keyEnd;
        continue;
      }
      j++;
      while (j < bodyEnd && /\s/.test(s[j] as string)) j++;
      const valueEnd = endOfValue(s, j);
      if (name === key) return { memberStart: i, memberEnd: valueEnd, valueStart: j };
      i = valueEnd;
      continue;
    }
    i++;
  }
  return null;
}

/** Body span of the object whose opening brace is at `open` (exclusive of both braces). */
function objectBody(s: string, open: number): { start: number; end: number } {
  return { start: open + 1, end: endOfValue(s, open) - 1 };
}

/** Leading whitespace of the line containing `idx` — reused so an inserted member lines up with
 *  the file's existing indentation instead of imposing crib's. */
function indentAt(text: string, idx: number): string {
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  return (text.slice(lineStart, idx).match(/^[ \t]*/) as RegExpMatchArray)[0];
}

/**
 * Set `<rootKey>.<name>` in a JSONC document by EDITING the text, so comments, key order and
 * formatting outside the managed member survive verbatim. Returns null when the shape is not one
 * we can edit safely (caller refuses rather than guessing).
 */
function upsertJsoncMember(
  text: string,
  rootKey: string,
  name: string,
  entry: Record<string, unknown>,
): string | null {
  const masked = maskJsonComments(text);
  const rootOpen = masked.indexOf('{');
  if (rootOpen === -1) return null;
  const root = objectBody(masked, rootOpen);
  const serialize = (indent: string): string =>
    JSON.stringify(sortEntry(entry), null, 2)
      .split('\n')
      .map((line, n) => (n === 0 ? line : indent + line))
      .join('\n');

  const serversMember = findMember(masked, root.start, root.end, rootKey);
  if (!serversMember) {
    // No `servers`/`mcpServers` key at all: add one as the first member of the root object.
    const indent = `${indentAt(text, rootOpen)}  `;
    const rest = text.slice(root.start);
    const sep = rest.trim().length > 0 ? ',' : '';
    const block = `\n${indent}${JSON.stringify(rootKey)}: {\n${indent}  ${JSON.stringify(name)}: ${serialize(`${indent}  `)}\n${indent}}${sep}`;
    return text.slice(0, root.start) + block + text.slice(root.start);
  }
  if (masked[serversMember.valueStart] !== '{') return null; // not an object → not ours to rewrite

  const body = objectBody(masked, serversMember.valueStart);
  const existing = findMember(masked, body.start, body.end, name);
  if (existing) {
    const indent = indentAt(text, existing.memberStart);
    const replacement = `${JSON.stringify(name)}: ${serialize(indent)}`;
    return text.slice(0, existing.memberStart) + replacement + text.slice(existing.memberEnd);
  }
  const hasMembers = masked.slice(body.start, body.end).trim().length > 0;
  const indent = `${indentAt(text, serversMember.memberStart)}  `;
  const inserted = `\n${indent}${JSON.stringify(name)}: ${serialize(indent)}${hasMembers ? ',' : ''}`;
  return text.slice(0, body.start) + inserted + text.slice(body.start);
}

/**
 * Which config formats their CLIENT accepts with comments. Only VS Code documents reading its MCP
 * config as JSONC; Claude Code, Cursor, Windsurf and Gemini read strict JSON, so a comment there is
 * a broken file we refuse rather than a dialect we support. Enabling JSONC where the client rejects
 * it would let crib preserve bytes the client then chokes on.
 */
function allowsComments(format: McpTarget['format']): boolean {
  return format === 'json-servers';
}

/** Delete `<rootKey>.<name>` from a JSONC document textually, keeping comments and siblings.
 *  Returns the original text when the member is absent, or null when the shape is not editable. */
function removeJsoncMember(text: string, rootKey: string, name: string): string | null {
  const masked = maskJsonComments(text);
  const rootOpen = masked.indexOf('{');
  if (rootOpen === -1) return null;
  const root = objectBody(masked, rootOpen);
  const serversMember = findMember(masked, root.start, root.end, rootKey);
  if (!serversMember) return text;
  if (masked[serversMember.valueStart] !== '{') return null;
  const body = objectBody(masked, serversMember.valueStart);
  const member = findMember(masked, body.start, body.end, name);
  if (!member) return text;
  let start = member.memberStart;
  let end = member.memberEnd;
  // Absorb ONE separating comma (the trailing one if there is a following member, otherwise the
  // leading one) so the object stays well-formed either way.
  let after = end;
  while (after < body.end && /\s/.test(masked[after] as string)) after++;
  if (masked[after] === ',') end = after + 1;
  else {
    let before = start - 1;
    while (before > body.start && /\s/.test(masked[before] as string)) before--;
    if (masked[before] === ',') start = before;
  }
  while (start > body.start && /[ \t]/.test(masked[start - 1] as string)) start--;
  if (masked[start - 1] === '\n' && start > body.start) start--;
  return text.slice(0, start) + text.slice(end);
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

function targetFor(
  ide: McpIde,
  scope: McpScope,
  repoRoot: string,
  homeOverride?: string,
): McpTarget | null {
  const home = homeOverride ?? process.env.HOME ?? '';
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
  // A bare `'crib'` means `which crib` FAILED on this machine (a fresh checkout, a CI runner, any
  // machine without a global install) — an entry that spawns a bare word no shell here resolves is
  // broken the moment it is written, and doctor correctly reports it as such. Pin THIS process's
  // own entry point instead: absolute node + the absolute cli.js sitting next to this module.
  // node loads the file itself, so the entry works with no PATH dependency and no exec bit.
  const selfSpawn = !opts.bin && bin === 'crib';
  const command = selfSpawn ? process.execPath : bin;
  const selfArgs = selfSpawn ? [resolve(dirname(fileURLToPath(import.meta.url)), 'cli.js')] : [];
  const scope: McpScope = opts.scope ?? 'project';
  const ides: McpIde[] = opts.ide === 'all' ? ALL_IDES : [opts.ide];
  const absRoot = resolve(repoRoot);
  const out: McpInstallResult[] = [];

  for (const ide of ides) {
    const target = targetFor(ide, scope, absRoot, opts.home);
    if (!target) {
      out.push({
        ide,
        scope,
        configPath: '',
        written: false,
        command: bin,
        args: [],
        ...restartFields(ide, false),
        note: `${ide} does not support ${scope}-scope MCP config (upstream); skipping.`,
      });
      continue;
    }

    // Claude global: shell out to `claude mcp add -s user` with no path arg → REQ-1 runtime resolution.
    if (target.format === 'claude-cli') {
      const args = [...selfArgs, 'serve']; // no path: resolveProjectRoot via CLAUDE_PROJECT_DIR + registry at runtime
      try {
        execFileSync('claude', ['mcp', 'add', SERVER_NAME, '-s', 'user', '--', command, ...args], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: true,
          command,
          args,
          ...restartFields(ide, true),
        });
      } catch {
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: false,
          command,
          args,
          ...restartFields(ide, false),
          note: 'claude CLI not found on PATH; install Claude Code, or use project-scope `crib mcp install --ide claude`.',
        });
      }
      continue;
    }

    const args = [...selfArgs, ...buildArgs(ide, scope, absRoot)];
    if (target.format === 'toml') {
      const block = [
        TOML_BEGIN,
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${tomlString(command)}`,
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
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written,
        command,
        args,
        ...restartFields(ide, written),
      });
      continue;
    }

    // JSON config (project-scope claude/cursor/vscode, or global cursor).
    const rootKey = target.format === 'json-servers' ? 'servers' : 'mcpServers';
    const entry: Record<string, unknown> = { command, args };
    if (target.format === 'json-servers') entry.type = 'stdio';
    const read = readJsonConfig(target.configPath, allowsComments(target.format));

    if (read.state === 'malformed') {
      // REFUSE. Not writing is the whole point: whatever is in that file is the user's, and a
      // config crib cannot parse is exactly the case where merging would destroy it (A04).
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: false,
        command,
        args,
        ...restartFields(ide, false),
        refused: true,
        problem: {
          kind: 'config-malformed',
          configPath: target.configPath,
          message: `${target.configPath}:${read.line}:${read.column}: ${read.message}`,
          line: read.line,
          column: read.column,
          fix: `repair ${target.configPath} by hand (crib refused to write so the existing content is preserved), then re-run \`crib mcp install --ide ${ide}\``,
        },
        note: `refused: ${target.configPath} is not valid ${allowsComments(target.format) ? 'JSONC' : 'JSON'} — left unchanged`,
      });
      continue;
    }

    const obj = read.state === 'ok' ? read.obj : {};
    const { written, obj: next } = mergeJsonManaged(obj, rootKey, SERVER_NAME, entry);
    if (written) {
      // A commented config is edited in place so the comments (and every other byte outside the
      // managed member) survive; a plain-JSON one keeps the canonical reserialize path.
      const edited =
        read.state === 'ok' && read.hasComments
          ? upsertJsoncMember(read.text, rootKey, SERVER_NAME, entry)
          : null;
      if (read.state === 'ok' && read.hasComments && edited === null) {
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: false,
          command,
          args,
          ...restartFields(ide, false),
          refused: true,
          problem: {
            kind: 'config-malformed',
            configPath: target.configPath,
            message: `${target.configPath}: \`${rootKey}\` is present but is not an object — crib will not rewrite it`,
            line: 1,
            column: 1,
            fix: `make \`${rootKey}\` an object in ${target.configPath}, then re-run \`crib mcp install --ide ${ide}\``,
          },
          note: `refused: ${target.configPath} has an unexpected \`${rootKey}\` shape — left unchanged`,
        });
        continue;
      }
      if (edited !== null) writeFileSync(target.configPath, edited, 'utf8');
      else writeJson(target.configPath, next);
    }
    out.push({
      ide,
      scope,
      configPath: target.configPath,
      written,
      command,
      args,
      ...restartFields(ide, written),
    });
  }
  return out;
}

/** Report the current managed-entry status for each IDE (present/absent), without writing. */
export interface McpListEntry {
  ide: McpIde;
  scope: McpScope;
  configPath: string;
  present: boolean;
  restartRequired: boolean;
  restartInstruction: string;
}
export function listMcp(
  repoRoot: string,
  opts: { ide?: McpIde | 'all'; scope?: McpScope; home?: string } = {},
): McpListEntry[] {
  const ides: McpIde[] = opts.ide ? (opts.ide === 'all' ? ALL_IDES : [opts.ide]) : ALL_IDES;
  const scopes: McpScope[] = opts.scope ? [opts.scope] : ['project', 'global'];
  const absRoot = resolve(repoRoot);
  const out: McpListEntry[] = [];
  for (const ide of ides) {
    for (const scope of scopes) {
      const target = targetFor(ide, scope, absRoot, opts.home);
      if (!target) continue;
      if (target.format === 'claude-cli') {
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          present: false,
          ...restartFields(ide, false),
        });
        continue;
      }
      const present =
        existsSync(target.configPath) && readOrEmpty(target.configPath).includes(SERVER_NAME);
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        present,
        ...restartFields(ide, present),
      });
    }
  }
  return out;
}

/**
 * WP2.6 — doctor's independent config/binary audit. Wiring PRESENT (listMcp) is not config
 * USABLE: an entry embeds the absolute `crib` path resolved at install time, which a reinstall,
 * a moved checkout, or another machine can invalidate, and a hand-edited file can corrupt
 * after install. The audit re-reads every config crib wrote (or that exists at its targets) and
 * answers the two questions the wiring check cannot: does the file still parse, and does the
 * binary the entry spawns still exist on THIS machine.
 *
 * Pure read — a diagnostic must never repair what it inspects; each problem names its
 * location and its remediation so `crib doctor` can report it independently.
 */
export type McpAuditProblemKind = 'config-unparseable' | 'binary-missing' | 'entrypoint-missing';

export interface McpAuditProblem {
  ide: McpIde;
  scope: McpScope;
  configPath: string;
  kind: McpAuditProblemKind;
  /** Human sentence naming the concrete location — the doctor row prints this verbatim. */
  message: string;
  fix: string;
}

/** Unescape a TOML basic string body (the inverse of {@link tomlString}). */
function fromTomlString(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

/** Does a spawned binary exist: absolute paths on disk, bare names on PATH. Resolution only —
 *  `which`/`where` LOOK UP a name, they never run it, and doctor must never run config commands. */
function binaryAvailable(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) return existsSync(command);
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The JavaScript entry point of a launcher CRIB generated, or undefined for anything else.
 *
 * `installMcp` falls back to `<node> <abs>/cli.js serve …` on a machine without `crib` on PATH, so
 * the interpreter existing says nothing about the script it is told to run: a moved or deleted
 * checkout leaves a perfectly good `node` pointed at nothing (A09). Only that generated shape is
 * validated — a client-owned `command`/`args` pair is the user's to define, is never inspected for
 * file existence, and is never executed to find out.
 */
function generatedEntryPoint(command: string, args: unknown): string | undefined {
  if (!Array.isArray(args) || typeof args[0] !== 'string') return undefined;
  const base = basename(command).toLowerCase();
  const isNode = command === process.execPath || base === 'node' || base === 'node.exe';
  if (!isNode) return undefined;
  const first = args[0];
  return isAbsolute(first) && basename(first) === 'cli.js' ? first : undefined;
}

/**
 * Audit every MCP config target that exists. Returns one problem per (file, defect) — never
 * throws, never writes; unreadable/undecidable states surface as problems, not crashes.
 */
export function auditMcp(repoRoot: string, opts: { home?: string } = {}): McpAuditProblem[] {
  const absRoot = resolve(repoRoot);
  const problems: McpAuditProblem[] = [];
  const push = (
    ide: McpIde,
    scope: McpScope,
    configPath: string,
    kind: McpAuditProblemKind,
    message: string,
    fix: string,
  ): void => {
    problems.push({ ide, scope, configPath, kind, message, fix });
  };

  for (const ide of ALL_IDES) {
    for (const scope of ['project', 'global'] as const) {
      const target = targetFor(ide, scope, absRoot, opts.home);
      if (!target || target.format === 'claude-cli') continue; // CLI-managed config is not a file to audit
      if (!existsSync(target.configPath)) continue;
      const text = readOrEmpty(target.configPath);

      let command: string | undefined;
      let entryArgs: unknown;
      if (target.format === 'toml') {
        const begin = text.indexOf(TOML_BEGIN);
        const end = begin === -1 ? -1 : text.indexOf(TOML_END, begin);
        if (begin === -1 || end === -1) {
          // A file at a crib target WITHOUT a parseable managed block: either the user replaced
          // crib's config wholesale (nothing to audit) or the block was truncated mid-edit
          // (unusable). Only the truncated case — one marker without its pair — is a defect.
          if (begin !== -1 || text.includes(TOML_END))
            push(
              ide,
              scope,
              target.configPath,
              'config-unparseable',
              `${target.configPath}: managed block truncated (one marker without its pair)`,
              'restore the managed block between the `knowledge-crib managed` markers, or remove both markers and re-run `crib mcp install`',
            );
          continue;
        }
        const block = text.slice(begin, end);
        const m = block.match(/command\s*=\s*"((?:[^"\\]|\\.)*)"/);
        command = m ? fromTomlString(m[1] ?? '') : undefined;
        const argsLine = block.match(/args\s*=\s*\[([^\]]*)\]/);
        entryArgs = argsLine
          ? [...(argsLine[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((a) =>
              fromTomlString(a[1] ?? ''),
            )
          : undefined;
        if (command === undefined) {
          push(
            ide,
            scope,
            target.configPath,
            'config-unparseable',
            `${target.configPath}: managed block has no \`command = "…"\` line`,
            're-run `crib mcp install --ide codex` to rewrite the managed block',
          );
          continue;
        }
      } else {
        // Same reader the installer uses, so doctor's verdict and the installer's refusal agree
        // about what "unparseable" means (including JSONC where the client accepts comments).
        const read = readJsonConfig(target.configPath, allowsComments(target.format));
        if (read.state === 'malformed') {
          push(
            ide,
            scope,
            target.configPath,
            'config-unparseable',
            `${target.configPath}:${read.line}:${read.column}: not valid ${allowsComments(target.format) ? 'JSONC' : 'JSON'} — crib cannot read or safely rewrite it (${read.message})`,
            'fix the file by hand (crib will not overwrite a config it cannot parse)',
          );
          continue;
        }
        if (read.state === 'missing') continue;
        const rootKey = target.format === 'json-servers' ? 'servers' : 'mcpServers';
        const entry = (read.obj[rootKey] as Record<string, unknown> | undefined)?.[SERVER_NAME];
        if (entry === undefined) continue; // user's own file at a target path — not crib's to audit
        command = (entry as { command?: unknown }).command as string | undefined;
        entryArgs = (entry as { args?: unknown }).args;
        if (typeof command !== 'string' || command.length === 0) {
          push(
            ide,
            scope,
            target.configPath,
            'config-unparseable',
            `${target.configPath}: \`mcpServers.${SERVER_NAME}\` has no command`,
            're-run `crib mcp install` (the entry is crib-managed and safely rewritable)',
          );
          continue;
        }
      }

      // Both halves of a generated launcher are reported, and they are reported SEPARATELY: a
      // present interpreter with a vanished script is a different repair from a missing binary.
      const entryPoint = generatedEntryPoint(command, entryArgs);
      if (entryPoint !== undefined && !existsSync(entryPoint))
        push(
          ide,
          scope,
          target.configPath,
          'entrypoint-missing',
          `${ide} (${scope}) runs \`${entryPoint}\` — that script is not on this machine (the checkout it pinned was moved or removed)`,
          're-run `crib mcp install` from the current checkout so the entry points at a script that exists',
        );

      if (!binaryAvailable(command))
        push(
          ide,
          scope,
          target.configPath,
          'binary-missing',
          `${ide} (${scope}) spawns \`${command}\` — that binary is not on this machine`,
          're-run `crib mcp install` from the machine where crib is installed (the entry pins an absolute path)',
        );
    }
  }
  return problems;
}

/** Remove the managed entry for one IDE without touching sibling content. */
export function removeMcp(repoRoot: string, opts: McpInstallOptions): McpInstallResult[] {
  const scope: McpScope = opts.scope ?? 'project';
  const ides: McpIde[] = opts.ide === 'all' ? ALL_IDES : [opts.ide];
  const absRoot = resolve(repoRoot);
  const out: McpInstallResult[] = [];
  for (const ide of ides) {
    const target = targetFor(ide, scope, absRoot, opts.home);
    if (!target) {
      out.push({
        ide,
        scope,
        configPath: '',
        written: false,
        command: '',
        args: [],
        ...restartFields(ide, false),
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
          ...restartFields(ide, true),
        });
      } catch {
        out.push({
          ide,
          scope,
          configPath: target.configPath,
          written: false,
          command: '',
          args: [],
          ...restartFields(ide, false),
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
        ...restartFields(ide, false),
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
        ...restartFields(ide, updated !== existing),
      });
      continue;
    }
    const rootKey = target.format === 'json-servers' ? 'servers' : 'mcpServers';
    const read = readJsonConfig(target.configPath, allowsComments(target.format));
    if (read.state === 'malformed') {
      // Same rule as install: a file crib cannot parse is not a file crib may rewrite.
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: false,
        command: '',
        args: [],
        ...restartFields(ide, false),
        refused: true,
        problem: {
          kind: 'config-malformed',
          configPath: target.configPath,
          message: `${target.configPath}:${read.line}:${read.column}: ${read.message}`,
          line: read.line,
          column: read.column,
          fix: `remove the \`${SERVER_NAME}\` entry by hand (crib refused to rewrite an unparseable config)`,
        },
        note: `refused: ${target.configPath} is not valid JSON — left unchanged`,
      });
      continue;
    }
    const obj = read.state === 'ok' ? read.obj : {};
    const servers = obj[rootKey] as Record<string, unknown> | undefined;
    if (servers && SERVER_NAME in servers) {
      const edited =
        read.state === 'ok' && read.hasComments
          ? removeJsoncMember(read.text, rootKey, SERVER_NAME)
          : null;
      if (edited !== null) writeFileSync(target.configPath, edited, 'utf8');
      else {
        delete servers[SERVER_NAME];
        if (Object.keys(servers).length === 0) delete obj[rootKey];
        writeJson(target.configPath, obj);
      }
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: true,
        command: '',
        args: [],
        ...restartFields(ide, true),
      });
    } else {
      out.push({
        ide,
        scope,
        configPath: target.configPath,
        written: false,
        command: '',
        args: [],
        ...restartFields(ide, false),
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
