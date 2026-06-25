#!/usr/bin/env node
/**
 * `crib` — the Knowledge-crib CLI. Wraps the pipeline + MCP server.
 *
 * Commands: index | status | query | serve | update | reindex | merge-driver | install-hooks | export | viz.
 * Exit codes (cli spec): 0 ok · 1 error · 2 bad args · 3 not indexed.
 */
import { resolve } from 'node:path';
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
import { buildVizGraph, vizAssetsDir } from '@knowledge-crib/ui';
import { installHooks, mergeDriverFiles } from './hooks.js';
import { buildIndex, isIndexed, openIndexOnly, openSoul } from './runtime.js';

const EXIT = { OK: 0, ERROR: 1, BAD_ARGS: 2, NOT_INDEXED: 3 } as const;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'index':
      return cmdIndex(rest);
    case 'status':
      return cmdStatus(rest);
    case 'query':
      return cmdQuery(rest);
    case 'serve':
      return cmdServe(rest);
    case 'update':
      return cmdUpdate(rest);
    case 'reindex':
      return cmdReindex(rest);
    case 'merge-driver':
      return cmdMergeDriver(rest);
    case 'install-hooks':
      return cmdInstallHooks(rest);
    case 'export':
      return cmdExport(rest);
    case 'viz':
      return cmdViz(rest);
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

async function cmdIndex(args: string[]): Promise<number> {
  const repoRoot = resolve(args[0] && !args[0].startsWith('-') ? args[0] : '.');
  const withEmbeddings = args.includes('--with-embeddings');
  const cribDir = resolve(repoRoot, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  const started = Date.now();
  const report = await indexRepo(soul, repoRoot, { buildOpts: { withEmbeddings } });
  const stats = soul.getManifest().stats;
  process.stdout.write(
    `indexed ${report.files} files → ${stats.nodes} nodes, ${stats.edges} edges ` +
      `(${report.link.describes} describes, ${report.link.references} references) in ${Date.now() - started}ms\n`,
  );
  return EXIT.OK;
}

async function cmdStatus(args: string[]): Promise<number> {
  const repoRoot = resolve(args[0] ?? '.');
  if (!isIndexed(repoRoot)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(repoRoot);
  const index = buildIndex(rt);
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot, vcs: new CliVcsAdapter() });
  process.stdout.write(`${JSON.stringify(verbs.status(), null, 2)}\n`);
  index.close();
  return EXIT.OK;
}

async function cmdQuery(args: string[]): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('-'));
  const repoRoot = resolve(process.env.KCRIB_ROOT ?? '.');
  const q = positional.join(' ');
  if (!q) {
    process.stderr.write('usage: crib query <text>\n');
    return EXIT.BAD_ARGS;
  }
  if (!isIndexed(repoRoot)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(repoRoot);
  const index = buildIndex(rt);
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot });
  process.stdout.write(`${JSON.stringify(verbs.query({ q }), null, 2)}\n`);
  index.close();
  return EXIT.OK;
}

async function cmdServe(args: string[]): Promise<number> {
  const repoRoot = resolve(args[0] && !args[0].startsWith('-') ? args[0] : '.');
  if (!isIndexed(repoRoot)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(repoRoot);
  const index = buildIndex(rt);
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot, vcs: new CliVcsAdapter() });
  // stdout is the MCP transport; logs go to stderr only.
  process.stderr.write('knowledge-crib MCP server on stdio\n');
  await serveStdio(verbs);
  return EXIT.OK;
}

async function cmdUpdate(args: string[]): Promise<number> {
  const repoRoot = resolve(args[0] && !args[0].startsWith('-') ? args[0] : '.');
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  if (!isIndexed(repoRoot)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(repoRoot);
  const started = Date.now();
  const result = await updateRepo(rt.soul, repoRoot, since ? { since } : {});
  if (result === null) {
    // No anchor / non-git → degrade to a full index.
    process.stderr.write('no incremental anchor — falling back to full index\n');
    return cmdReindex(args);
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
  const d = result.delta;
  process.stdout.write(
    `updated ${result.changedPaths.length} file(s) [scope ${result.scopeFiles.length}] → ` +
      `+${d.nodes.length} nodes +${d.edges.length} edges −${d.removed.length} in ${Date.now() - started}ms\n` +
      `changed: ${result.changedPaths.join(', ')}\n`,
  );
  return EXIT.OK;
}

async function cmdReindex(args: string[]): Promise<number> {
  const repoRoot = resolve(args[0] && !args[0].startsWith('-') ? args[0] : '.');
  const withEmbeddings = args.includes('--with-embeddings');
  const cribDir = resolve(repoRoot, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  const started = Date.now();
  const report = await indexRepo(soul, repoRoot, { buildOpts: { withEmbeddings } });
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

function cmdInstallHooks(args: string[]): number {
  const repoRoot = resolve(args[0] && !args[0].startsWith('-') ? args[0] : '.');
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
 * `crib export [--format rules|mermaid|graph.json|report] [--procedure <id|name>]` — render the
 * soul. `rules`/`mermaid` need `--procedure` (a node id or a procedure/function name); `graph.json`
 * and `report` dump the whole soul (report optionally scoped to one procedure via --procedure).
 */
async function cmdExport(args: string[]): Promise<number> {
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
  const repoRoot = resolve(positional[0] ?? '.');

  const formats = ['rules', 'mermaid', 'graph.json', 'report'] as const;
  type ExportFormat = (typeof formats)[number];
  if (!(formats as readonly string[]).includes(format)) {
    process.stderr.write(`unknown format: ${format || '(none)'}\nvalid: ${formats.join(', ')}\n`);
    return EXIT.BAD_ARGS;
  }
  const fmt: ExportFormat = format as ExportFormat;
  if (!isIndexed(repoRoot)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  if ((fmt === 'rules' || fmt === 'mermaid') && !procedure) {
    process.stderr.write(`--procedure <id|name> is required for --format ${fmt}\n`);
    return EXIT.BAD_ARGS;
  }

  const rt = openSoul(repoRoot);
  try {
    process.stdout.write(renderExport(rt.soul, fmt, procedure));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
  return EXIT.OK;
}

/** `crib viz` — serve the offline web UI (vendored Cytoscape.js) over the soul graph and open a browser. */
async function cmdViz(args: string[]): Promise<number> {
  const positional: string[] = [];
  let port = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--port') port = Number(args[++i] ?? 0);
    else if (!a.startsWith('-')) positional.push(a);
  }
  const repoRoot = resolve(positional[0] ?? '.');
  if (!isIndexed(repoRoot)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(repoRoot);
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
      '  crib index [path] [--with-embeddings]   full index → .crib soul + derived index',
      '  crib status [path]                       health + stats',
      '  crib query <text>                        BM25 search over code + docs',
      '  crib serve [path]                        run the MCP server on stdio',
      '  crib update [path] [--since <sha>]      incremental re-extract since the VCS anchor',
      '  crib reindex [path]                     full re-index (alias for `crib index`)',
      '  crib merge-driver %O %A %B %P            git custom merge driver for .crib chunks',
      '  crib install-hooks [path]                wire post-commit + .gitattributes + merge driver',
      '  crib export [--format F] [--procedure P] render soul: rules|mermaid|graph.json|report',
      '  crib viz [path] [--port N]               serve the offline web UI (Cytoscape graph) + open browser',
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
