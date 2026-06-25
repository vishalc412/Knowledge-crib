#!/usr/bin/env node
/**
 * `crib` — the Knowledge-crib CLI. Wraps the pipeline + MCP server.
 *
 * Commands: index | status | query | serve | update | reindex | merge-driver | install-hooks |
 *           export | viz | mcp.
 *
 * Root resolution (REQ-1): `crib serve`/`status`/`update`/`export`/`viz`/`query` resolve the project
 * root via a priority chain — explicit positional arg or `--cwd` → `KCRIB_ROOT` → `CLAUDE_PROJECT_DIR`
 * → upward walk for `.crib/crib.json` → cwd — so a single user-scoped IDE entry can serve every
 * project. `crib index`/`reindex` target the exact given dir (no upward walk) and register the
 * project in `~/.crib/registry.json` so later `crib mcp list` / resolution can find it.
 *
 * Exit codes (cli spec): 0 ok · 1 error · 2 bad args · 3 not indexed.
 */
import { join, resolve } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { IndexStore } from '@knowledge-crib/core';
import { Verbs, serveStdio } from '@knowledge-crib/mcp';
import type { VcsAdapter } from '@knowledge-crib/mcp';
import {
  changedFilesSince,
  currentHead,
  indexRepo,
  renderExport,
  updateRepo,
} from '@knowledge-crib/pipeline';
import { DEFAULT_IGNORES } from '@knowledge-crib/pipeline';
import { buildVizGraph, vizAssetsDir } from '@knowledge-crib/ui';
import { installHooks, mergeDriverFiles } from './hooks.js';
import { type McpIde, type McpScope, installMcp, listMcp, removeMcp } from './mcp-install.js';
import { registerProject } from './registry.js';
import {
  type ResolvedRoot,
  buildIndex,
  isIndexedRoot,
  openIndexOnly,
  openSoul,
  resolveProjectRoot,
} from './runtime.js';

const EXIT = { OK: 0, ERROR: 1, BAD_ARGS: 2, NOT_INDEXED: 3 } as const;

/** Per-invocation context threaded from `main` (currently just the `--cwd` global flag). */
interface CmdCtx {
  cwdOverride?: string;
}

/**
 * Parse `--exclude a,b,c` (repeatable) into a discovery ignore set merged with DEFAULT_IGNORES.
 * Lets users skip project-specific cache/source dirs that aren't in the default list.
 */
function parseExcludes(args: string[]): Set<string> {
  const ignores = new Set(DEFAULT_IGNORES);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude') {
      const val = args[++i];
      if (!val) continue;
      for (const d of val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean))
        ignores.add(d);
    }
  }
  return ignores;
}

/** First non-flag positional arg (the path for path-taking commands), or `undefined`. */
function pathArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

/**
 * Extract the `--cwd <path>` global flag from argv, returning the cleaned argv + the override.
 * `--cwd` is the highest-priority explicit root and may appear before or after the command.
 */
function extractCwdFlag(argv: string[]): { argv: string[]; cwdOverride?: string } {
  const out: string[] = [];
  let cwdOverride: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      cwdOverride = argv[++i];
      continue;
    }
    out.push(argv[i]!);
  }
  return { argv: out, cwdOverride };
}

/** Resolve a root for the path-taking commands (serve/status/update/export/viz): walks up + registry overlay. */
function resolveRoot(args: string[], ctx?: CmdCtx): ResolvedRoot {
  const pos = pathArg(args);
  const explicitRoot = ctx?.cwdOverride ?? (pos && pos !== '.' ? pos : undefined);
  return resolveProjectRoot({ explicitRoot });
}

async function main(argvRaw: string[]): Promise<number> {
  const { argv, cwdOverride } = extractCwdFlag(argvRaw);
  const ctx: CmdCtx = { cwdOverride };
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'index':
      return cmdIndex(rest, ctx);
    case 'status':
      return cmdStatus(rest, ctx);
    case 'query':
      return cmdQuery(rest, ctx);
    case 'serve':
      return cmdServe(rest, ctx);
    case 'update':
      return cmdUpdate(rest, ctx);
    case 'reindex':
      return cmdReindex(rest, ctx);
    case 'merge-driver':
      return cmdMergeDriver(rest);
    case 'install-hooks':
      return cmdInstallHooks(rest, ctx);
    case 'export':
      return cmdExport(rest, ctx);
    case 'viz':
      return cmdViz(rest, ctx);
    case 'mcp':
      return cmdMcp(rest, ctx);
    case undefined:
    case '-h':
    case '--help':
      printHelp();
      return EXIT.OK;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      printHelp();
      return EXIT.BAD_ARGS;
  }
}

/** Real VCS adapter backed by the pipeline's git helpers; injected into the MCP verbs for serve. */
class CliVcsAdapter implements VcsAdapter {
  currentHead(root: string): string {
    return currentHead(root);
  }
  changedFilesSince(root: string, since: string): string[] {
    return changedFilesSince(root, since);
  }
}

/** Register the just-indexed project in `~/.crib/registry.json` (REQ-1). Idempotent. */
function registerIndexed(repoRoot: string, cribDir: string, soul: SoulStore): void {
  const m = soul.getManifest();
  registerProject(repoRoot, {
    repoId: m.repo.id,
    cribDir,
    ...(m.repo.vcsHead !== undefined ? { vcsHead: m.repo.vcsHead } : {}),
  });
}

async function cmdIndex(args: string[], ctx?: CmdCtx): Promise<number> {
  // index targets the exact given dir (no upward walk) — you index THIS, not a parent.
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg(args) ?? '.');
  const withEmbeddings = args.includes('--with-embeddings');
  const ignores = parseExcludes(args);
  const cribDir = join(repoRoot, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  const started = Date.now();
  const report = await indexRepo(soul, repoRoot, {
    buildOpts: { withEmbeddings },
    ignores,
  });
  registerIndexed(repoRoot, cribDir, soul);
  const stats = soul.getManifest().stats;
  process.stdout.write(
    `indexed ${report.files} files → ${stats.nodes} nodes, ${stats.edges} edges ` +
      `(${report.link.describes} describes, ${report.link.references} references) in ${Date.now() - started}ms\n`,
  );
  return EXIT.OK;
}

async function cmdStatus(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const index = buildIndex(rt);
  const verbs = new Verbs({
    soul: rt.soul,
    index,
    repoRoot: resolved.repoRoot,
    vcs: new CliVcsAdapter(),
  });
  process.stdout.write(`${JSON.stringify(verbs.status(), null, 2)}\n`);
  index.close();
  return EXIT.OK;
}

async function cmdQuery(args: string[], ctx?: CmdCtx): Promise<number> {
  // query positionals are the search text, NOT a root — root comes from --cwd / env / cwd walk only.
  const positional = args.filter((a) => !a.startsWith('-'));
  const q = positional.join(' ');
  if (!q) {
    process.stderr.write('usage: crib query <text>\n');
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const index = buildIndex(rt);
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot: resolved.repoRoot });
  process.stdout.write(`${JSON.stringify(verbs.query({ q }), null, 2)}\n`);
  index.close();
  return EXIT.OK;
}

async function cmdServe(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const index = buildIndex(rt);
  const verbs = new Verbs({
    soul: rt.soul,
    index,
    repoRoot: resolved.repoRoot,
    vcs: new CliVcsAdapter(),
  });
  // stdout is the MCP transport; logs go to stderr only.
  process.stderr.write('knowledge-crib MCP server on stdio\n');
  await serveStdio(verbs);
  return EXIT.OK;
}

async function cmdUpdate(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const started = Date.now();
  const result = await updateRepo(rt.soul, resolved.repoRoot, since ? { since } : {});
  if (result === null) {
    // No anchor / non-git → degrade to a full index.
    process.stderr.write('no incremental anchor — falling back to full index\n');
    return cmdIndex(args, ctx);
  }
  if ('noop' in result) {
    process.stdout.write(
      `up to date (head ${result.head.slice(0, 12)}) in ${Date.now() - started}ms\n`,
    );
    return EXIT.OK;
  }
  // Apply the delta to the existing derived index; if none exists yet, build it fresh from the
  // (already-committed) updated soul — a delta applied to an empty index would be meaningless.
  let index: IndexStore;
  try {
    index = openIndexOnly(rt);
    index.applyDelta(result.delta);
  } catch {
    index = buildIndex(rt); // full buildFromSoul from the just-updated soul
  }
  index.close();
  registerIndexed(resolved.repoRoot, resolved.cribDir, rt.soul);
  const d = result.delta;
  process.stdout.write(
    `updated ${result.changedPaths.length} file(s) [scope ${result.scopeFiles.length}] → ` +
      `+${d.nodes.length} nodes +${d.edges.length} edges −${d.removed.length} in ${Date.now() - started}ms\n` +
      `changed: ${result.changedPaths.join(', ')}\n`,
  );
  return EXIT.OK;
}

async function cmdReindex(args: string[], ctx?: CmdCtx): Promise<number> {
  // reindex targets the exact given dir (no upward walk), like index.
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg(args) ?? '.');
  const withEmbeddings = args.includes('--with-embeddings');
  const ignores = parseExcludes(args);
  const cribDir = join(repoRoot, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  const started = Date.now();
  const report = await indexRepo(soul, repoRoot, {
    buildOpts: { withEmbeddings },
    ignores,
  });
  registerIndexed(repoRoot, cribDir, soul);
  const stats = soul.getManifest().stats;
  process.stdout.write(
    `reindexed ${report.files} files → ${stats.nodes} nodes, ${stats.edges} edges ` +
      `(${report.link.describes} describes, ${report.link.references} references) in ${Date.now() - started}ms\n`,
  );
  return EXIT.OK;
}

/** `crib merge-driver %O %A %B %P` — git custom merge driver for one `.crib` JSONL chunk. */
function cmdMergeDriver(args: string[]): number {
  // git passes: %O ancestor  %A current/ours (output)  %B other/theirs  %P pathname
  const [basePath, oursPath, theirsPath] = args;
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write('usage: crib merge-driver %O %A %B %P\n');
    return EXIT.BAD_ARGS;
  }
  const { warnings, conflicts } = mergeDriverFiles(basePath, oursPath, theirsPath);
  for (const w of warnings) process.stderr.write(`merge warning: ${w}\n`);
  // 0 = clean merge (incl. auto-resolved edges); 1 = unresolvable node collision needing human review.
  return conflicts ? EXIT.ERROR : EXIT.OK;
}

function cmdInstallHooks(args: string[], ctx?: CmdCtx): number {
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg(args) ?? '.');
  const res = installHooks(repoRoot);
  process.stdout.write(
    `installed kcrib hooks at ${res.gitDir}\n` +
      `  post-commit → ${res.postCommitPath}\n` +
      `  .gitattributes → ${res.gitattributesPath} (.crib/** merge=kcrib)\n` +
      `  merge.kcrib.driver = ${res.driverConfig}\n`,
  );
  return EXIT.OK;
}

/**
 * `crib mcp <install|list|remove> [--ide <name|all>] [--global] [--bin <path>] [path]` (REQ-2).
 * Auto-wires the MCP server into each IDE's config so the user never hand-edits JSON/TOML.
 */
function cmdMcp(args: string[], ctx?: CmdCtx): number {
  const [sub, ...rest] = args;
  let ide: McpIde | 'all' = 'all';
  let scope: McpScope = 'project';
  let bin: string | undefined;
  const positionals: string[] = [];
  // Parse flags + collect positionals in ONE pass so a flag value (e.g. `--ide vscode`) is not
  // mistaken for the project path. `pathArg` alone can't tell value-tokens from positionals.
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--ide') ide = (rest[++i] as McpIde | 'all') ?? 'all';
    else if (a === '--global') scope = 'global';
    else if (a === '--bin') bin = rest[++i];
    else if (!a.startsWith('-')) positionals.push(a);
  }
  const repoRoot = resolve(ctx?.cwdOverride ?? positionals[0] ?? '.');
  const validIdes: Array<McpIde | 'all'> = ['all', 'claude', 'cursor', 'vscode', 'codex'];
  if (!validIdes.includes(ide)) {
    process.stderr.write(`unknown --ide: ${ide}\nvalid: ${validIdes.join(', ')}\n`);
    return EXIT.BAD_ARGS;
  }

  switch (sub) {
    case 'install': {
      const results = installMcp(repoRoot, { ide, scope, bin });
      for (const r of results) {
        const tag = `${r.ide}/${r.scope}`;
        if (r.note) {
          process.stdout.write(`${tag}: ${r.note}\n`);
        } else if (r.written) {
          process.stdout.write(
            `${tag}: wrote ${r.configPath}\n  command: ${r.command} ${r.args.join(' ')}\n`,
          );
        } else {
          process.stdout.write(`${tag}: already up to date at ${r.configPath}\n`);
        }
      }
      return EXIT.OK;
    }
    case 'list': {
      const entries = listMcp(repoRoot, { ide, scope });
      if (entries.length === 0) {
        process.stdout.write('no matching IDE/scope combinations\n');
        return EXIT.OK;
      }
      for (const e of entries) {
        process.stdout.write(
          `${e.ide}/${e.scope}: ${e.present ? 'present' : 'absent'} → ${e.configPath}\n`,
        );
      }
      return EXIT.OK;
    }
    case 'remove': {
      const results = removeMcp(repoRoot, { ide, scope, bin });
      for (const r of results) {
        const tag = `${r.ide}/${r.scope}`;
        if (r.note) process.stdout.write(`${tag}: ${r.note}\n`);
        else
          process.stdout.write(
            `${tag}: ${r.written ? 'removed' : 'not present'} → ${r.configPath}\n`,
          );
      }
      return EXIT.OK;
    }
    case undefined:
    case '-h':
    case '--help':
      process.stderr.write(
        'usage: crib mcp <install|list|remove> [--ide <claude|cursor|vscode|codex|all>] [--global] [--bin <path>] [path]\n',
      );
      return EXIT.BAD_ARGS;
    default:
      process.stderr.write(`unknown mcp subcommand: ${sub}\n`);
      return EXIT.BAD_ARGS;
  }
}

/**
 * `crib export [--format rules|mermaid|graph.json|report] [--procedure <id|name>]` — render the
 * soul. `rules`/`mermaid` need `--procedure` (a node id or a procedure/function name); `graph.json`
 * and `report` dump the whole soul (report optionally scoped to one procedure via --procedure).
 */
async function cmdExport(args: string[], ctx?: CmdCtx): Promise<number> {
  // Parse flags + their values out so flag values aren't mistaken for a positional path.
  let format = 'report';
  let procedure: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--format') {
      format = args[++i] ?? '';
    } else if (a === '--procedure') {
      procedure = args[++i];
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  const resolved = resolveProjectRoot({
    explicitRoot:
      ctx?.cwdOverride ?? (positional[0] && positional[0] !== '.' ? positional[0] : undefined),
  });

  const formats = ['rules', 'mermaid', 'graph.json', 'report'] as const;
  type ExportFormat = (typeof formats)[number];
  if (!(formats as readonly string[]).includes(format)) {
    process.stderr.write(`unknown format: ${format || '(none)'}\nvalid: ${formats.join(', ')}\n`);
    return EXIT.BAD_ARGS;
  }
  const fmt: ExportFormat = format as ExportFormat;
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  if ((fmt === 'rules' || fmt === 'mermaid') && !procedure) {
    process.stderr.write(`--procedure <id|name> is required for --format ${fmt}\n`);
    return EXIT.BAD_ARGS;
  }

  const rt = openSoul(resolved);
  try {
    process.stdout.write(renderExport(rt.soul, fmt, procedure));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
  return EXIT.OK;
}

/** `crib viz` — serve the offline web UI (Claude Design DC runtime) over the soul graph and open a browser. */
async function cmdViz(args: string[], ctx?: CmdCtx): Promise<number> {
  const positional: string[] = [];
  let port = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--port') port = Number(args[++i] ?? 0);
    else if (!a.startsWith('-')) positional.push(a);
  }
  const resolved = resolveProjectRoot({
    explicitRoot:
      ctx?.cwdOverride ?? (positional[0] && positional[0] !== '.' ? positional[0] : undefined),
  });
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const graph = buildVizGraph(rt.soul);
  const assets = vizAssetsDir();
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/graph.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(graph));
        return;
      }
      const rel = (req.url ?? '/').split('?')[0]!.replace(/^\//, '');
      const path = join(assets, rel === '' ? 'index.html' : rel);
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`not found: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await new Promise<void>((q) => server.listen(port, '127.0.0.1', q));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://127.0.0.1:${actualPort}/`;
  process.stderr.write(
    `viz → ${url}  (${graph.stats.nodes} nodes · ${graph.stats.edges} edges · ${graph.stats.clusters} clusters)\nCtrl-C to stop.\n`,
  );
  // best-effort browser open (macOS/linux/windows); never fatal.
  const { spawn } = await import('node:child_process');
  let opener: string;
  let openerArgs: string[];
  if (process.platform === 'darwin') {
    opener = 'open';
    openerArgs = [url];
  } else if (process.platform === 'win32') {
    opener = 'cmd';
    openerArgs = ['/c', 'start', '', url];
  } else {
    opener = 'xdg-open';
    openerArgs = [url];
  }
  try {
    spawn(opener, openerArgs, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // ignore — the URL is printed above.
  }
  await new Promise<void>(() => {
    // run until interrupted
  });
  return EXIT.OK;
}

function printHelp(): void {
  process.stdout.write(
    [
      'crib — Knowledge-crib CLI',
      '',
      'Usage:',
      '  crib index [path] [--with-embeddings] [--exclude a,b,...]   full index → .crib soul + derived index',
      '  crib status [path]                       health + stats',
      '  crib query <text>                        BM25 search over code + docs',
      '  crib serve [path]                        run the MCP server on stdio (resolves root: arg/--cwd/KCRIB_ROOT/CLAUDE_PROJECT_DIR/walk/cwd)',
      '  crib update [path] [--since <sha>]      incremental re-extract since the VCS anchor',
      '  crib reindex [path]                     full re-index (alias for `crib index`)',
      '  crib merge-driver %O %A %B %P            git custom merge driver for .crib chunks',
      '  crib install-hooks [path]                wire post-commit + .gitattributes + merge driver',
      '  crib export [--format F] [--procedure P] render soul: rules|mermaid|graph.json|report',
      '  crib viz [path] [--port N]               serve the offline web UI (Claude Design DC graph) + open browser',
      '  crib mcp <install|list|remove> [--ide <claude|cursor|vscode|codex|all>] [--global] [--bin <path>] [path]',
      '                                          auto-wire the MCP server into each IDE config (REQ-2)',
      '',
      'Global: --cwd <path>   override the project root for any command',
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(EXIT.ERROR);
  });
