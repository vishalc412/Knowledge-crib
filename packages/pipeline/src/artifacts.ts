/**
 * Phase 4a — the deterministic AI-artifact graph (PRD W1 §"Deterministic AI-artifact graph").
 *
 * Discovers tracked AI artifacts (skills, agents, commands, rules, instructions, MCP-server configs)
 * that the normal discovery walk MISSES — they live under gitignored tool dirs (`.claude/`,
 * `.cursor/`), or are JSON configs, so {@link discoverFiles} never reaches them — and extracts one
 * `agent-artifact` node per artifact, then resolves `governs` / `requires` / `invokes` edges against
 * the already-indexed symbol/file/doc-section graph + sibling artifacts. Slots AFTER `runLink` so the
 * InvertedIndex spans the whole soul when artifact→symbol edges resolve.
 *
 * Two discovery paths (PRD lines 194-195):
 *   - Committed scanner: `git ls-files` (tracked files — includes a tracked artifact even when it
 *     sits under a `.gitignore`d tool dir, because `.gitignore` only hides UNtracked files) filtered
 *     by a safe allowlist. Non-git repos fall back to the normal discovered file set filtered by the
 *     allowlist. The allowlist is path-glob + frontmatter-`artifactType` bounded — it never reads
 *     arbitrary ignored settings or env files.
 *   - Local overlay (opt-in, `localRoots`): configured Claude/Codex/Cursor/global skill roots. Nodes
 *     are stamped `meta.origin: 'local-overlay'` and a tilde-relative `file` path. Default OFF so the
 *     committed soul stays byte-identical across machines; the W7 working-overlay phase owns their
 *     projection into the composite view.
 *
 * MCP config extraction (PRD line 197) records server names + commands + arg counts + transport, but
 * NEVER env values or credentials: the `env` block is not read, arg VALUES are not stored (only their
 * count), and any command string matching a secret pattern is redacted to `<redacted>` before it can
 * reach a node. Other artifacts reference an MCP server via `mcp:<name>` (resolved by name).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import { extractArtifact } from '@knowledge-crib/parsers';
import type { ArtifactRef, ArtifactRel } from '@knowledge-crib/parsers';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { ArtifactType, Edge, Node } from '@knowledge-crib/soul-schema';
import { InvertedIndex } from './linker/inverted-index.js';
import { discoverFiles } from './structure.js';
import { trackedFiles } from './vcs.js';

export interface ArtifactRule {
  /** repo-relative glob (`**` across separators, `*` one segment). */
  glob: string;
  type: ArtifactType;
}

/**
 * The safe allowlist — a tracked file is an artifact ONLY if it matches one of these globs (or carries
 * a valid `artifactType:` frontmatter override). Conservative on purpose: it scopes the committed
 * scanner to known AI-tool artifact locations so the phase never opens an arbitrary ignored file.
 */
export const DEFAULT_ARTIFACT_ALLOWLIST: readonly ArtifactRule[] = [
  { glob: '.claude/skills/**/SKILL.md', type: 'skill' },
  { glob: '.claude/agents/**/*.md', type: 'agent' },
  { glob: '.claude/commands/**/*.md', type: 'command' },
  { glob: '.claude/rules/**/*.md', type: 'rule' },
  { glob: '.gstack/skills/**/SKILL.md', type: 'skill' },
  { glob: '.gstack/agents/**/*.md', type: 'agent' },
  { glob: '.cursor/rules/**/*.md', type: 'rule' },
  { glob: '.cursor/rules/**/*.mdc', type: 'rule' },
  { glob: 'docs/skills/**/SKILL.md', type: 'skill' },
  { glob: 'docs/agents/**/*.md', type: 'agent' },
  { glob: 'docs/commands/**/*.md', type: 'command' },
  { glob: 'docs/rules/**/*.md', type: 'rule' },
  { glob: '**/AGENTS.md', type: 'instruction' },
  { glob: '**/.agentic.md', type: 'instruction' },
  { glob: '**/INSTRUCTIONS.md', type: 'instruction' },
];

/** MCP-server config paths the committed scanner looks for (tracked JSON configs). */
const MCP_CONFIG_GLOBS: readonly string[] = [
  '.mcp.json',
  '**/.mcp.json',
  '.claude/settings.json',
  '**/.claude/settings.json',
  '.claude/mcp.json',
  '**/.claude/mcp.json',
];

const SECRET_RE = /(secret|key|token|password|passwd|credential|api[-_]?key)/i;

export interface ArtifactGraphOpts {
  /** allowlist rules; defaults to {@link DEFAULT_ARTIFACT_ALLOWLIST}. */
  allowlist?: readonly ArtifactRule[];
  /** opt-in local overlay roots (absolute, or `~`-prefixed home-relative). NEVER committed. */
  localRoots?: string[];
  /** parse MCP-server configs; default true. */
  mcp?: boolean;
}

export interface ArtifactDiagnostic {
  artifactFile: string;
  ref: string;
  rel: ArtifactRel;
  kind: 'unresolved' | 'ambiguous';
  reason: string;
}

export interface ArtifactStats {
  artifacts: number;
  governs: number;
  requires: number;
  invokes: number;
  mcpServers: number;
  /** local-overlay artifact nodes emitted (origin 'local-overlay'); 0 by default. */
  localOverlay: number;
  diagnostics: ArtifactDiagnostic[];
}

const EMPTY_STATS: ArtifactStats = {
  artifacts: 0,
  governs: 0,
  requires: 0,
  invokes: 0,
  mcpServers: 0,
  localOverlay: 0,
  diagnostics: [],
};

interface DiscoveredArtifact {
  /** display path used for the node `file` field (repo-relative for committed, ~/ -relative for local). */
  rel: string;
  /** absolute filesystem path to read. */
  abs: string;
  origin: 'committed' | 'local-overlay';
  isMcpConfig: boolean;
}

/**
 * Discover + extract the AI-artifact graph. Idempotent: `putNodes`/`putEdges` overwrite by id, so a
 * full re-run on an unchanged repo re-emits byte-identical records. Returns counts + unresolved-ref
 * diagnostics for `crib audit` / the CLI.
 */
export function runArtifactGraph(
  soul: SoulStore,
  root: string,
  opts: ArtifactGraphOpts = {},
): ArtifactStats {
  const allowlist = opts.allowlist ?? DEFAULT_ARTIFACT_ALLOWLIST;
  const stats: ArtifactStats = { ...EMPTY_STATS, diagnostics: [] };

  const discovered: DiscoveredArtifact[] = discoverCommittedArtifacts(
    root,
    allowlist,
    opts.mcp !== false,
  );
  if (opts.localRoots && opts.localRoots.length > 0) {
    for (const a of discoverLocalArtifacts(opts.localRoots, allowlist)) discovered.push(a);
  }

  if (discovered.length === 0) return stats;

  const index = new InvertedIndex(soul, { targets: true });
  const byName = new Map<string, Node[]>();
  const edges: Edge[] = [];
  const extracts: { node: Node; refs: ArtifactRef[]; origin: DiscoveredArtifact['origin'] }[] = [];

  // Pass 1 — extract nodes (markdown artifacts + MCP-server config nodes).
  for (const d of discovered) {
    const text = safeRead(d.abs);
    if (text === undefined) continue;
    const hash = contentHash(text);
    if (d.isMcpConfig) {
      for (const node of parseMcpConfig(d.rel, text, hash)) {
        soul.putNodes([node]);
        stats.mcpServers++;
        pushByName(byName, node.name ?? '', node);
        // MCP nodes carry no outgoing refs; other artifacts reference them via `mcp:<name>`.
      }
      continue;
    }
    const { node, refs } = extractArtifact(d.rel, text, hash, (parts) =>
      idFor({ kind: 'agent-artifact', path: parts.path, name: parts.name }),
    );
    if (d.origin === 'local-overlay') {
      node.meta = { ...(node.meta ?? {}), origin: 'local-overlay' };
      stats.localOverlay++;
    }
    soul.putNodes([node]);
    stats.artifacts++;
    pushByName(byName, node.name ?? '', node);
    extracts.push({ node, refs, origin: d.origin });
  }

  // Pass 2 — resolve refs into governs/requires/invokes edges (artifact→symbol/artifact/file/doc).
  for (const { node, refs } of extracts) {
    for (const ref of refs) {
      const res = resolveRef(ref.raw, index, byName);
      if (res.target) {
        edges.push({
          id: edgeId(node.id, res.target.id, ref.rel),
          src: node.id,
          dst: res.target.id,
          rel: ref.rel,
          // 'frontmatter'→'static' (author-declared), 'explicit'→'explicit', 'link'→'path' (Method has no 'link')
          method:
            ref.method === 'frontmatter' ? 'static' : ref.method === 'link' ? 'path' : ref.method,
          provenance: 'EXTRACTED',
          confidence: ref.confidence,
          evidence: {
            by: 'artifact-graph',
            snippet: ref.raw,
            targetHash: res.target.hash,
          },
        });
        if (ref.rel === 'governs') stats.governs++;
        else if (ref.rel === 'requires') stats.requires++;
        else stats.invokes++;
      } else {
        stats.diagnostics.push({
          artifactFile: node.file ?? '',
          ref: ref.raw,
          rel: ref.rel,
          kind: res.ambiguous ? 'ambiguous' : 'unresolved',
          reason: res.ambiguous
            ? '2+ candidates match this ref'
            : 'no indexed symbol/artifact/file matches this ref',
        });
      }
    }
  }

  if (edges.length > 0) soul.putEdges(edges);
  return stats;
}

// ─── discovery ──────────────────────────────────────────────────────────────

function discoverCommittedArtifacts(
  root: string,
  allowlist: readonly ArtifactRule[],
  mcp: boolean,
): DiscoveredArtifact[] {
  // `git ls-files` lists tracked files (incl. tracked files under .gitignore'd dirs). Non-git →
  // fall back to the normal discovered file set (which respects .gitignore, so a non-git repo still
  // picks up artifacts under non-ignored paths like docs/skills/, AGENTS.md, .mcp.json).
  const tracked = trackedFiles(root);
  const candidates = tracked.length > 0 ? tracked : discoverFiles(root).map((f) => f.path);
  const out: DiscoveredArtifact[] = [];
  for (const path of candidates) {
    if (mcp && isMcpConfig(path)) {
      out.push({ rel: path, abs: join(root, path), origin: 'committed', isMcpConfig: true });
      continue;
    }
    if (matchesAllowlist(path, allowlist)) {
      out.push({ rel: path, abs: join(root, path), origin: 'committed', isMcpConfig: false });
    }
  }
  return out;
}

function discoverLocalArtifacts(
  roots: string[],
  allowlist: readonly ArtifactRule[],
): DiscoveredArtifact[] {
  const home = homedir();
  const out: DiscoveredArtifact[] = [];
  for (const r of roots) {
    const abs = expandHome(r, home);
    // walk the local root with a permissive ignore set (local tool dirs ARE the source here), then
    // keep only allowlist matches + MCP configs. Reads ONLY allowlist-matched files — never arbitrary
    // settings/env. `~/.claude.json` (the global MCP config) is matched explicitly when present.
    const files = discoverFiles(abs, { ignores: new Set(['node_modules', '.git', 'dist']) });
    for (const f of files) {
      const rel = displayPath(abs, f.path, home);
      if (isMcpConfig(f.path) || matchesAllowlist(f.path, allowlist)) {
        out.push({
          rel,
          abs: join(abs, f.path),
          origin: 'local-overlay',
          isMcpConfig: isMcpConfig(f.path),
        });
      }
    }
    // the global `~/.claude.json` is a single file at the home root, not under a walked tool dir
    const globalCfg = join(home, '.claude.json');
    if (fileExists(globalCfg)) {
      out.push({
        rel: '~/.claude.json',
        abs: globalCfg,
        origin: 'local-overlay',
        isMcpConfig: true,
      });
    }
  }
  return out;
}

function matchesAllowlist(path: string, allowlist: readonly ArtifactRule[]): boolean {
  for (const rule of allowlist) {
    if (matchGlob(rule.glob, path)) return true;
  }
  return false;
}

function isMcpConfig(path: string): boolean {
  return MCP_CONFIG_GLOBS.some((g) => matchGlob(g, path));
}

// ─── MCP config parsing (secret-safe) ───────────────────────────────────────

/** Parse a `.mcp.json` / `~/.claude.json` / `.claude/settings.json` config into `mcp-server` nodes.
 *  Records server name + (redacted) command + arg count + transport. NEVER reads `env` or arg values. */
function parseMcpConfig(file: string, text: string, hash: string): Node[] {
  let cfg: unknown;
  try {
    cfg = JSON.parse(text);
  } catch {
    return []; // malformed JSON → no nodes (graceful; the file node still exists from Phase 1)
  }
  const root = cfg as Record<string, unknown>;
  const servers = (root.mcpServers ?? root.servers) as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!servers || typeof servers !== 'object') return [];

  const nodes: Node[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    const command = typeof server.command === 'string' ? (server.command as string) : undefined;
    const args = Array.isArray(server.args) ? server.args : undefined;
    const transport = typeof server.type === 'string' ? (server.type as string) : 'stdio';
    // NEVER read server['env'] — credentials live there. Arg VALUES are not stored (only the count):
    // args routinely carry paths/tokens, so recording just the length keeps the node secret-free.
    const safeCommand = command ? (SECRET_RE.test(command) ? '<redacted>' : command) : undefined;
    const node: Node = {
      id: idFor({ kind: 'agent-artifact', path: file, name: `mcp:${name}` }),
      kind: 'agent-artifact',
      file,
      name: `mcp:${name}`,
      qualifiedName: `mcp:${name}`,
      artifactType: 'mcp-server',
      hash,
      span: { start: 1, end: text.split('\n').length },
      meta: {
        server: name,
        transport,
        ...(safeCommand ? { command: safeCommand } : {}),
        argsCount: args ? args.length : 0,
        // explicit marker: env was intentionally not read (audit surface)
        envRedacted: true,
      },
    };
    nodes.push(node);
  }
  return nodes;
}

// ─── ref resolution ──────────────────────────────────────────────────────────

interface RefResolution {
  target?: Node;
  ambiguous?: boolean;
}

function resolveRef(raw: string, index: InvertedIndex, byName: Map<string, Node[]>): RefResolution {
  // 1. an artifact/MCP-server by unique name (skills, `mcp:<server>`)
  const arts = byName.get(raw);
  if (arts && arts.length === 1) return { target: arts[0] };
  if (arts && arts.length > 1) return { ambiguous: true };

  // 2. a `mcp:<name>` even if the bare name collided above
  if (raw.startsWith('mcp:')) {
    const mcp = byName.get(raw);
    if (mcp && mcp.length === 1) return { target: mcp[0] };
  }

  // 3. qualified symbol name (AuthService.login)
  const qn = index.qualified(raw);
  if (qn) return { target: qn };

  // 4. path#anchor → doc-section, else path → file node
  const hashIdx = raw.indexOf('#');
  if (hashIdx > 0) {
    const pathPart = raw.slice(0, hashIdx);
    const anchor = raw.slice(hashIdx + 1);
    for (const p of candidatePaths(pathPart)) {
      const ds = index.docSection(p, anchor);
      if (ds) return { target: ds };
    }
    // anchor not found as a doc-section → fall through to the file node (no fan-out)
    for (const p of candidatePaths(pathPart)) {
      const fn = index.fileNode(p);
      if (fn) return { target: fn };
    }
  } else {
    for (const p of candidatePaths(raw)) {
      const fn = index.fileNode(p);
      if (fn) return { target: fn };
    }
    // 5. bare unique symbol name (a unique `login`) — safe, no fan-out
    const named = index.symbolsNamed(raw);
    if (named.length === 1) return { target: named[0] };
    if (named.length > 1) return { ambiguous: true };
  }

  return {};
}

/** Candidate repo-relative paths for a ref: strip a leading `./`, and try `.js`→`.ts` (an artifact
 *  authoring a ref to compiled TS source often writes the `.js`). No `../` relativization — artifact
 *  refs are repo-relative or qualified, not doc-relative. */
function candidatePaths(ref: string): string[] {
  const stripped = ref.replace(/^\.\//, '');
  const out = [stripped];
  if (stripped.endsWith('.js')) out.push(`${stripped.slice(0, -3)}.ts`);
  if (stripped.endsWith('.ts')) out.push(`${stripped.slice(0, -3)}.js`);
  return out;
}

// ─── glob matcher (zero-dependency) ──────────────────────────────────────────

/** Minimal glob → regex: `**` across separators, `*` one segment, `?` one char, and a `**` then `/`
 *  prefix matching zero-or-more leading segments. Anchored full-match. Conservative: unknown syntax
 *  is escaped literally. */
export function matchGlob(pattern: string, path: string): boolean {
  let p = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      i += 2;
      if (pattern[i] === '/') {
        p += '(?:.*/)?';
        i++;
      } else {
        p += '.*';
      }
    } else if (c === '*') {
      p += '[^/]*';
      i++;
    } else if (c === '?') {
      p += '[^/]';
      i++;
    } else if (GLOB_ESCAPE.has(c)) {
      p += `\\${c}`;
      i++;
    } else {
      p += c;
      i++;
    }
  }
  return new RegExp(`^${p}$`).test(path);
}

/** Regex metacharacters that must be backslash-escaped when compiling a glob into a regex. Kept as a
 *  Set (not a regex char class) so the `${` sequence can't be mis-tokenized by the parser. */
const GLOB_ESCAPE = new Set<string>(['.', '+', '^', '$', '{', '}', '|', '(', ')', '\\']);

// ─── helpers ─────────────────────────────────────────────────────────────────

function pushByName(map: Map<string, Node[]>, name: string, node: Node): void {
  if (!name) return;
  const list = map.get(name) ?? [];
  list.push(node);
  map.set(name, list);
}

function safeRead(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function fileExists(abs: string): boolean {
  try {
    return readFileSync(abs, 'utf8') !== undefined;
  } catch {
    return false;
  }
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** Display path for a local-overlay file: `~/`-relative when under home, else the absolute path. */
function displayPath(rootAbs: string, rel: string, home: string): string {
  const abs = join(rootAbs, rel);
  if (abs === home) return '~';
  if (abs.startsWith(`${home}/`)) return `~/${abs.slice(home.length + 1)}`;
  return abs;
}
