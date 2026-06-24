#!/usr/bin/env node
/**
 * `crib` — the Knowledge-crib CLI. Wraps the pipeline + MCP server.
 *
 * Commands: index | status | query | serve. Exit codes (cli spec): 0 ok · 1 error · 2 bad args ·
 * 3 not indexed.
 */
import { resolve } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { Verbs, serveStdio } from '@knowledge-crib/mcp';
import { indexRepo } from '@knowledge-crib/pipeline';
import { buildIndex, isIndexed, openSoul } from './runtime.js';

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
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot });
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
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot });
  // stdout is the MCP transport; logs go to stderr only.
  process.stderr.write('knowledge-crib MCP server on stdio\n');
  await serveStdio(verbs);
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
