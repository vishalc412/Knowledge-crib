#!/usr/bin/env node
/**
 * Self-hosted acceptance: use Knowledge-crib to index and serve Knowledge-crib itself.
 *
 * This replaces external Graphify-style graph proof: portable .crib graph, one MCP server,
 * every registered MCP tool exercised against real repository. enrich_save stays validation-only;
 * acceptance never writes model-authored analysis into project's .crib/llm directory.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? resolve(here, '..'),
);
const cli = resolve(repoRoot, 'packages/cli/dist/bin.js');
const skipIndex = process.argv.includes('--skip-index');
const TIMEOUT_MS = 30_000;

const REQUIRED_TOOLS = [
  'status',
  'context',
  'source',
  'dossier',
  'reconstruct',
  'dossier_by_scope',
  'impact',
  'federatedImpact',
  'query',
  'enrich_status',
  'enrich_next',
  'enrich_save',
  'audit_llm',
  'overview',
  'llm_neighbors',
  'describes',
  'neighbors',
  'ownership',
  'shortest_path',
  'detect_changes',
  'extract_rules',
  'gaps',
  'stats',
];

function fail(message) {
  throw new Error(`self-hosted check: ${message}`);
}

function runCli(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveResult({ stdout, stderr });
      else reject(new Error(`crib ${args.join(' ')} failed (${code})\n${stderr}\n${stdout}`));
    });
  });
}

class McpStdioClient {
  constructor() {
    this.id = 0;
    this.pending = new Map();
    this.stderr = '';
  }

  async start() {
    this.child = spawn(process.execPath, [cli, 'serve', repoRoot], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.exit = new Promise((resolveExit) => this.child.once('exit', resolveExit));
    this.child.once('error', (error) => this.rejectPending(error));
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'knowledge-crib-self-hosted-check', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return initialized;
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(new Error(`${message.error.message ?? 'MCP error'} (${message.error.code})`));
    else pending.resolve(message.result);
  }

  request(method, params) {
    const id = ++this.id;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    this.child.stdin.end();
    await Promise.race([this.exit, new Promise((resolveExit) => setTimeout(resolveExit, 2_000))]);
    if (!this.child.killed) this.child.kill('SIGTERM');
  }
}

function decode(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function assertToolResult(name, result) {
  if (result?.isError) fail(`${name} returned MCP tool error: ${JSON.stringify(result.content)}`);
  return decode(result);
}

async function main() {
  if (!existsSync(cli)) fail(`build missing: ${cli}`);
  if (!skipIndex) {
    process.stdout.write('indexing current monorepo\n');
    await runCli(['index', repoRoot, '--package', 'all']);
  }

  const statusCli = JSON.parse((await runCli(['status', repoRoot])).stdout);
  if (statusCli.indexed !== true || statusCli.stats.nodes < 1 || statusCli.stats.edges < 1) {
    fail('CLI status did not report a populated index');
  }
  const graphExport = JSON.parse(
    (await runCli(['export', repoRoot, '--format', 'graph.json'])).stdout,
  );
  if (!Array.isArray(graphExport.nodes) || !Array.isArray(graphExport.edges)) {
    fail('graph.json export missing nodes or edges');
  }

  const client = new McpStdioClient();
  const called = [];
  const call = async (name, args = {}) => {
    const result = await client.request('tools/call', { name, arguments: args });
    called.push(name);
    return assertToolResult(name, result);
  };

  try {
    await client.start();
    const list = await client.request('tools/list', {});
    const available = new Set((list.tools ?? []).map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((tool) => !available.has(tool));
    if (missing.length) fail(`MCP tools missing: ${missing.join(', ')}`);

    await call('status');
    const query = await call('query', {
      q: 'buildServer',
      limit: 3,
      withSource: true,
      withRules: true,
      withFramework: true,
    });
    const target = query.hits?.find((hit) => typeof hit?.id === 'string');
    if (!target?.id) fail('query returned no addressable self-hosted symbol');
    const id = target.id;
    const file = typeof target.file === 'string' ? target.file : 'packages/mcp/src/server.ts';

    await call('context', { id, withSource: true, withRules: true, withFramework: true });
    await call('source', { id, maxChars: 8_000, maxLines: 160 });
    await call('dossier', { id, includeTables: true, sourceMaxChars: 8_000, sourceMaxLines: 160 });
    await call('reconstruct', { id, includeTables: true }); // valid negative path for a non-package symbol
    await call('dossier_by_scope', { scope: 'file', id: file, maxSymbols: 3, sourceMaxLines: 80 });
    await call('impact', { id, dir: 'up', depth: 2, limit: 20 });
    await call('federatedImpact', { id, dir: 'up', depth: 2, limit: 20 });
    await call('enrich_status', { scopes: true });
    await call('enrich_next', { limit: 1 });

    // Safe no-op branch. No model artifact is authored during product acceptance.
    const saveProbe = await client.request('tools/call', {
      name: 'enrich_save',
      arguments: { batchId: 'self-hosted-invalid-probe', items: [] },
    });
    called.push('enrich_save');
    assertToolResult('enrich_save', saveProbe);

    await call('audit_llm');
    await call('overview');
    await call('llm_neighbors', { id });
    await call('describes', { id });
    await call('neighbors', { id, dir: 'both', limit: 20 });
    await call('ownership', { id });
    await call('shortest_path', { from: id, to: id, maxHops: 1 });
    await call('detect_changes', { since: 'HEAD' });
    await call('extract_rules', { procedure: id, includeTables: true });
    await call('gaps', { includeBuiltins: false });
    const stats = await call('stats');
    const uncalled = REQUIRED_TOOLS.filter((tool) => !called.includes(tool));
    if (uncalled.length) fail(`tools not called: ${uncalled.join(', ')}`);

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        repoRoot,
        graph: { nodes: graphExport.nodes.length, edges: graphExport.edges.length },
        mcp: { toolsListed: available.size, toolsCalled: called.length, stats },
      })}\n`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
