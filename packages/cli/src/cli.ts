#!/usr/bin/env node
/**
 * `crib` — the Knowledge-crib CLI. Wraps the pipeline + MCP server.
 *
 * Commands: index | status | query | gaps | rules | context | ask | dossier | impact | path | neighbors |
 *           serve | update | reindex | merge-driver | install-hooks | export | viz | mcp | init | doctor.
 *
 * Root resolution (REQ-1): `crib serve`/`status`/`update`/`export`/`viz`/`query` resolve the project
 * root via a priority chain — explicit positional arg or `--cwd` → `KCRIB_ROOT` → `CLAUDE_PROJECT_DIR`
 * → upward walk for `.crib/crib.json` → cwd — so a single user-scoped IDE entry can serve every
 * project. `crib index`/`reindex` target the exact given dir (no upward walk) and register the
 * project in `~/.crib/registry.json` so later `crib mcp list` / resolution can find it.
 *
 * Exit codes (cli spec): 0 ok · 1 error · 2 bad args · 3 not indexed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CALLABLE_SYMBOL_TYPES,
  LockBusyError,
  MANIFEST_FILE,
  SoulStore,
  graphPaths,
  hasLegacyGraph,
  materializeComposite,
  migrateLegacyGraph,
  newManifest,
  validateClusterIntegrity,
  withCribLockAsync,
} from '@knowledge-crib/core';
import type { IndexStore } from '@knowledge-crib/core';
import { EnrichmentStore, Verbs, estimateTokens, serveStdio } from '@knowledge-crib/mcp';
import type { EnrichLayer, EnrichSaveItem, EnrichScope, VcsAdapter } from '@knowledge-crib/mcp';
import {
  type AttemptOutcome,
  type AttemptPhase,
  type GateReceipt,
  type MemoryCandidate,
  MemoryEvaluator,
  type MemoryPolicy,
  type MemoryRecord,
  MemoryStore,
  SoulStoreSoulPort,
  type StructuredSummary,
  type TrustedTeamPresence,
  activateLocal,
  appendAttemptEvent,
  assertValidMemoryEntry,
  attemptEventId,
  attemptGroupId,
  buildAttemptEvent,
  compactAttempt,
  evaluateCandidate,
  gcUnpromotedAttempts,
  loadPolicy,
  loadPolicyJson,
  memoryCandidateId,
  parseMemoryShard,
  policyHash,
  proposeExisting,
  readRepoId,
  resolveProfile,
  runGate,
  runMemoryCheck,
  trustedRefOf,
  verifySnapshot,
} from '@knowledge-crib/memory';
import {
  changedFilesSince,
  currentHead,
  detectWorkspace,
  indexRepo,
  isGitRepo,
  lsTreeFiles,
  mergeBase,
  refExists,
  renderExport,
  resolvePackageArg,
  runCluster,
  showFileAtRef,
  uncommittedChanges,
  updateRepo,
} from '@knowledge-crib/pipeline';
import { DEFAULT_IGNORES } from '@knowledge-crib/pipeline';
import type { WorkspaceLayout } from '@knowledge-crib/pipeline';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { buildVizGraph, buildVizOverview, vizAssetsDir } from '@knowledge-crib/ui';
import { hooksInstalled, installHooks, mergeDriverFiles } from './hooks.js';
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
import { installSkill, listBundledSkills } from './skill-install.js';
import { VizHttpError, isAllowedHost, readVizNodeSource, resolveVizAsset } from './viz-server.js';

const EXIT = { OK: 0, ERROR: 1, BAD_ARGS: 2, NOT_INDEXED: 3, LOCKED: 4 } as const;

/** Per-invocation context threaded from `main` (currently just the `--cwd` global flag). */
interface CmdCtx {
  cwdOverride?: string;
}

/**
 * Flags that take a value as their next argv token (`--limit 5`, `--format markdown`, …). When
 * collecting positional search text / ids we must drop BOTH the flag and the value — otherwise the
 * value (e.g. `5`, `markdown`) leaks into the query string (`crib query "sqlite" --limit 5` would
 * otherwise search for "sqlite 5"; `crib ask "… issue" --format markdown` would ask about "… issue
 * markdown"). Boolean flags (no value) are dropped separately by the `-` prefix check.
 */
const VALUE_FLAGS = new Set([
  '--limit',
  '--format',
  '--cwd',
  '--since',
  '--exclude',
  '--depth',
  '--doc-limit',
  '--max-symbols',
  '--source-max-chars',
  '--source-max-lines',
  '--max-chars',
  '--max-lines',
  '--start-line',
  '--source-start-line',
  '--min-confidence',
  '--max-hops',
  '--package',
  '--repo',
  '--dir',
]);

/** Collect positional argv tokens, skipping boolean flags AND value-taking flags + their values. */
function positionalsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      i++; // drop the value token too
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

/** Collect every value following a repeatable `--flag` (e.g. `--repo a --repo b` → ['a','b']). */
function collectRepeated(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const v = args[i + 1];
      if (v && !v.startsWith('-')) out.push(v);
    }
  }
  return out;
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

/**
 * Parse `--package <name>` (repeatable, comma-separated) into a list of package tokens. `all` is a
 * reserved token meaning "index every package (full repo walk)". Names/rel-paths are matched
 * against the detected layout by {@link resolvePackageScope}.
 */
function parsePackages(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--package') {
      const val = args[++i];
      if (!val) continue;
      for (const p of val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean))
        out.push(p);
    }
  }
  return out;
}

/**
 * Resolve `--package` args against the detected monorepo layout. When the repo is a monorepo and no
 * `--package` is given, the detected packages are listed to stderr with a scoping hint, then the
 * index proceeds over the full repo (non-interactive default). `--package all` is an explicit full
 * walk. An unknown package name is a BAD_ARGS abort (with the valid names listed). Returns the
 * `packageRoots` to thread into {@link indexRepo} (undefined = full repo) + the names to record in
 * the soul manifest's `meta.indexedPackages`.
 */
function resolvePackageScope(
  repoRoot: string,
  args: string[],
): {
  status: number;
  packageRoots?: string[];
  layout: WorkspaceLayout | null;
  indexedPackages: string[];
} {
  const layout = detectWorkspace(repoRoot);
  const tokens = parsePackages(args);
  const allPackages = layout ? layout.packages.map((p) => p.rel) : [];
  if (tokens.length === 0) {
    if (layout) {
      process.stderr.write(
        `monorepo detected (${layout.tool}): ${layout.packages.length} package(s)\n`,
      );
      for (const p of layout.packages) process.stderr.write(`  - ${p.name}  (${p.rel})\n`);
      process.stderr.write(
        'scope one with: crib index . --package <name>  |  all: --package all\n',
      );
    }
    return { status: EXIT.OK, packageRoots: undefined, layout, indexedPackages: allPackages };
  }
  const roots: string[] = [];
  const indexed: string[] = [];
  for (const token of tokens) {
    const r = resolvePackageArg(repoRoot, token, layout);
    if (r.unknown) {
      const valid = layout
        ? layout.packages.map((p) => p.name).join(', ')
        : '(none — not a monorepo)';
      process.stderr.write(`unknown package: ${r.unknown}\navailable: ${valid}\n`);
      return { status: EXIT.BAD_ARGS, layout, indexedPackages: [] };
    }
    if (r.all) {
      return { status: EXIT.OK, packageRoots: undefined, layout, indexedPackages: allPackages };
    }
    if (r.packageRoots) {
      for (const pr of r.packageRoots) {
        if (!roots.includes(pr)) roots.push(pr);
        if (!indexed.includes(pr)) indexed.push(pr);
      }
    }
  }
  return { status: EXIT.OK, packageRoots: roots, layout, indexedPackages: indexed };
}

/** Stamp the detected workspace + the package roots actually indexed onto the soul manifest's `meta`. */
function stampPackageMeta(
  soul: SoulStore,
  scope: { layout: WorkspaceLayout | null; indexedPackages: string[] },
): void {
  const meta: Record<string, unknown> = { ...(soul.getManifest().meta ?? {}) };
  if (scope.layout) {
    meta.workspace = {
      tool: scope.layout.tool,
      packages: scope.layout.packages.map((p) => ({ name: p.name, rel: p.rel })),
    };
  }
  meta.indexedPackages = scope.indexedPackages;
  soul.getManifest().meta = meta;
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
    case 'gaps':
      return cmdGaps(rest, ctx);
    case 'rules':
      return cmdRules(rest, ctx);
    case 'context':
      return cmdContext(rest, ctx);
    case 'ask':
      return cmdAsk(rest, ctx);
    case 'dossier':
      return cmdDossier(rest, ctx);
    case 'reconstruct':
      return cmdReconstruct(rest, ctx);
    case 'impact':
      return cmdImpact(rest, ctx);
    case 'federated-impact':
    case 'federated':
      return cmdFederatedImpact(rest, ctx);
    case 'path':
      return cmdPath(rest, ctx);
    case 'neighbors':
      return cmdNeighbors(rest, ctx);
    case 'ownership':
      return cmdOwnership(rest, ctx);
    case 'serve':
      return cmdServe(rest, ctx);
    case 'update':
      return cmdUpdate(rest, ctx);
    case 'reindex':
      return cmdReindex(rest, ctx);
    case 'migrate-graph':
      return cmdMigrateGraph(rest, ctx);
    case 'materialize':
      return cmdMaterialize(rest, ctx);
    case 'merge-driver':
      return cmdMergeDriver(rest);
    case 'install-hooks':
      return cmdInstallHooks(rest, ctx);
    case 'export':
      return cmdExport(rest, ctx);
    case 'viz':
      return cmdViz(rest, ctx);
    case 'enrich':
      return cmdEnrich(rest, ctx);
    case 'memory':
      return cmdMemory(rest, ctx);
    case 'audit-llm':
      return cmdAuditLlm(rest, ctx);
    case 'mcp':
      return cmdMcp(rest, ctx);
    case 'skill':
      return cmdSkill(rest);
    case 'init':
      return cmdInit(rest, ctx);
    case 'doctor':
      return cmdDoctor(rest, ctx);
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

async function cmdMigrateGraph(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  if (!existsSync(join(resolved.cribDir, MANIFEST_FILE))) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const dryRun = args.includes('--dry-run');
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(migrateLegacyGraph(resolved.cribDir, true), null, 2)}\n`,
    );
    return EXIT.OK;
  }
  return runLocked(resolved.cribDir, () => {
    const report = migrateLegacyGraph(resolved.cribDir, false);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT.OK;
  });
}

async function cmdMaterialize(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  return runLocked(resolved.cribDir, () => {
    const rt = openSoul(resolved);
    const result = materializeComposite(rt.soul);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT.OK;
  });
}

/** Real VCS adapter backed by the pipeline's git helpers; injected into the MCP verbs for serve. */
class CliVcsAdapter implements VcsAdapter {
  currentHead(root: string): string {
    return currentHead(root);
  }
  changedFilesSince(root: string, since: string): string[] {
    return changedFilesSince(root, since);
  }
  uncommittedChanges(root: string): string[] {
    return uncommittedChanges(root);
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

/**
 * Run `fn` while holding the `.crib` writer lock; on a busy crib, print a friendly message and
 * return the LOCKED exit code instead of throwing. Mutating commands (index/update/reindex) must
 * serialize so two writers never stomp the derived sqlite index. Stale locks (dead holder pid, or
 * older than 10 min) self-heal inside {@link withCribLockAsync} — no manual cleanup needed.
 */
async function runLocked(cribDir: string, fn: () => number | Promise<number>): Promise<number> {
  try {
    return await withCribLockAsync({ cribDir }, fn);
  } catch (error) {
    if (error instanceof LockBusyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.LOCKED;
    }
    throw error;
  }
}

/**
 * After a (re)index, print one real, measured token-savings number so the value of indexing is
 * visible immediately (P1: instant value) instead of staying an abstract claim. Picks the most
 * *called* callable symbol (highest in-degree — the actual architectural center of the codebase,
 * not just whichever name happens to repeat most, e.g. trivial getters) as a representative
 * discovery query, runs it once against the just-built index, and compares the default-tier
 * response cost to the cost of reading the matched files whole — the same comparison `crib-bench`
 * makes, just inline and best-effort at index time. Never throws: a failed measurement must not
 * mask a successful index.
 */
function printTokenSavingsHero(verbs: Verbs, soul: SoulStore, repoRoot: string): void {
  try {
    const inDegree = new Map<string, number>();
    for (const edge of soul.iterateEdges()) {
      inDegree.set(edge.dst, (inDegree.get(edge.dst) ?? 0) + 1);
    }
    let term: string | undefined;
    let best = 0;
    for (const node of soul.iterate('symbol')) {
      if (!node.name || !node.type || !CALLABLE_SYMBOL_TYPES.has(node.type)) continue;
      const degree = inDegree.get(node.id) ?? 0;
      if (degree > best) {
        best = degree;
        term = node.name;
      }
    }
    if (!term) return;

    const result = verbs.query({ q: term, limit: 10 }) as { hits?: Array<{ id: string }> };
    const hits = result.hits ?? [];
    if (hits.length === 0) return;

    const files = new Set<string>();
    for (const hit of hits) {
      const m = /^(?:sym|file|cluster):([^#]+?)(?:#.*)?$/.exec(hit.id);
      if (m) files.add(m[1]!);
    }
    let rawTokens = 0;
    for (const file of files) {
      try {
        rawTokens += estimateTokens(readFileSync(join(repoRoot, file), 'utf8'));
      } catch {
        // file moved/unreadable between index and read — skip it, don't fail the hero line
      }
    }
    const defaultTokens = estimateTokens(JSON.stringify(result));
    if (rawTokens === 0 || defaultTokens === 0) return;
    const ratio = rawTokens / defaultTokens;
    // On very small repos the fixed JSON envelope (hits/llmHits/truncated + per-hit keys) can cost
    // more than the few raw bytes it replaces — only claim a win when there actually is one. This
    // line is a "wow" moment, not a property that holds at every scale; never overclaim it.
    if (ratio < 1.5) return;
    process.stdout.write(
      `≈${ratio.toFixed(1)}x fewer tokens per discovery query than reading files directly ` +
        `(sample query "${term}": ${rawTokens} tokens raw → ${defaultTokens} tokens via crib query)\n`,
    );
  } catch {
    // Best-effort instant-value hint; never let it mask a successful index.
  }
}

/**
 * After a (re)index, surface how many LLM-graph targets are pending and point the user at the driver.
 * The deterministic index is LLM-free, so "auto" here is a nudge: print the count + the follow-up command.
 * The actual generation is driven by the `/crib-enrich` skill (the host IDE LLM) or `crib enrich --next`.
 */
function printLlmPending(soul: SoulStore, repoRoot: string): void {
  try {
    const st = new EnrichmentStore(soul, repoRoot).status();
    if (st.done) return;
    const pending = Object.values(st.layers).reduce((n, l) => n + l.missing + l.stale, 0);
    if (pending <= 0) return;
    const next = st.nextLayer ?? 'symbol';
    process.stdout.write(
      `${pending} target(s) pending LLM graph generation (next: ${next}) — run \`/crib-enrich\` or \`crib enrich --next\` to drive the loop.\n`,
    );
  } catch {
    // Enrichment status is best-effort; never let it mask a successful index.
  }
}

async function cmdIndex(args: string[], ctx?: CmdCtx): Promise<number> {
  // index targets the exact given dir (no upward walk) — you index THIS, not a parent.
  const repoRoot = resolve(ctx?.cwdOverride ?? positionalsOf(args)[0] ?? '.');
  const semantic = args.includes('--semantic');
  const ignores = parseExcludes(args);
  const scope = resolvePackageScope(repoRoot, args);
  if (scope.status !== EXIT.OK) return scope.status;
  const cribDir = join(repoRoot, '.crib');
  return runLocked(cribDir, async () => {
    // Full rebuild: fresh manifest stamped with the current SCHEMA_VERSION (never inherit a stale
    // one), repo.id preserved across rebuilds (stable committed soul + ~/.crib/registry mapping),
    // resetForRebuild() so every on-disk shard is pruned-on-commit instead of layering new nodes over
    // a stale older-schema soul. Do NOT load() — that hydrates stale nodes and overwrites the manifest.
    const soul = freshSoulForRebuild(cribDir);
    stampPackageMeta(soul, scope);
    const started = Date.now();
    const report = await indexRepo(soul, repoRoot, {
      semantic,
      ignores,
      packageRoots: scope.packageRoots,
    });
    const index = buildIndex({ repoRoot, cribDir, soul });
    registerIndexed(repoRoot, cribDir, soul);
    const stats = soul.getManifest().stats;
    const scopeSuffix = scope.packageRoots ? ` [scoped: ${scope.indexedPackages.join(', ')}]` : '';
    process.stdout.write(
      `indexed ${report.files} files → ${stats.nodes} nodes, ${stats.edges} edges ` +
        `(${report.link.describes} describes, ${report.link.references} references)${scopeSuffix} in ${Date.now() - started}ms\n`,
    );
    printTokenSavingsHero(new Verbs({ soul, index, repoRoot }), soul, repoRoot);
    index.close();
    printLlmPending(soul, repoRoot);
    return EXIT.OK;
  });
}

/**
 * Build a fresh SoulStore for a full `crib index`/`reindex` over a (possibly existing) `.crib`:
 * stamp the current SCHEMA_VERSION (never inherit a stale one from an older soul), preserve repo.id
 * across rebuilds (so the committed soul + the ~/.crib/registry mapping stay stable), and
 * resetForRebuild() so every on-disk shard is pruned-on-commit instead of layering new nodes over a
 * stale older-schema soul. Deliberately does NOT call load() — that would hydrate stale nodes and
 * overwrite the fresh manifest (the root cause of the additive-corrupt re-index bug).
 */
function freshSoulForRebuild(cribDir: string): SoulStore {
  if (hasLegacyGraph(cribDir)) migrateLegacyGraph(cribDir);
  const canonicalManifest = graphPaths(cribDir).manifest;
  const manifestPath = existsSync(canonicalManifest)
    ? canonicalManifest
    : join(cribDir, MANIFEST_FILE);
  let repoId: string | undefined;
  if (existsSync(manifestPath)) {
    try {
      repoId = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { repo?: { id?: string } }).repo
        ?.id;
    } catch {
      // corrupt or unreadable manifest — generate a fresh repo.id via newManifest below
    }
  }
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.', repoId }) });
  soul.resetForRebuild();
  return soul;
}

async function cmdStatus(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const index = openIndexForRead(rt);
  if (!index) return EXIT.NOT_INDEXED;
  const verbs = new Verbs({
    soul: rt.soul,
    index,
    repoRoot: resolved.repoRoot,
    vcs: new CliVcsAdapter(),
  });
  const dirty = args.includes('--dirty');
  process.stdout.write(`${JSON.stringify(verbs.status({ dirty }), null, 2)}\n`);
  index.close();
  return EXIT.OK;
}

async function cmdQuery(args: string[], ctx?: CmdCtx): Promise<number> {
  // query positionals are the search text, NOT a root — root comes from --cwd / env / cwd walk only.
  // Use positionalsOf so `--limit 5` does not leak `5` into the query string.
  const q = positionalsOf(args).join(' ');
  if (!q) {
    process.stderr.write(
      'usage: crib query <text> [--with-source] [--with-rules] [--with-framework] [--extracted-only] [--with-llm] [--limit N]\n',
    );
    return EXIT.BAD_ARGS;
  }
  // WS-2: fold the deep per-symbol context into each hit so one CLI call returns what a full file
  // read surfaces (bodies + decision tables), not just signatures. Flags mirror the MCP `query` tool.
  const withSource = args.includes('--with-source');
  const withRules = args.includes('--with-rules');
  const withFramework = args.includes('--with-framework');
  const extractedOnly = args.includes('--extracted-only');
  // --with-llm opts INTO the full LLM analysis+graph+evidence blob on each hit. Default (off) keeps
  // the discovery view lightweight: a one-line snippet + a 5-field LLM pointer (provenance/confidence/
  // purpose) — the token-cost discipline. Set this only when you want the full LLM brief per hit.
  const withLlm = args.includes('--with-llm');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const index = openIndexForRead(rt);
  if (!index) return EXIT.NOT_INDEXED;
  const verbs = new Verbs({ soul: rt.soul, index, repoRoot: resolved.repoRoot });
  process.stdout.write(
    `${JSON.stringify(
      verbs.query({
        q,
        ...(withSource ? { withSource: true } : {}),
        ...(withRules ? { withRules: true } : {}),
        ...(withFramework ? { withFramework: true } : {}),
        ...(extractedOnly ? { extractedOnly: true } : {}),
        ...(withLlm ? { withLlm: true } : {}),
        ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/**
 * Open the derived index for read commands. Missing/stale derived indexes are repaired only by an
 * explicit `crib index`/`crib reindex`, which keeps concurrent read commands out of SQLite rebuilds.
 */
function openIndexForRead(rt: ReturnType<typeof openSoul>): IndexStore | null {
  try {
    return openIndexOnly(rt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${msg}\n`);
    return null;
  }
}

/**
 * Shared setup for the read-only analyst commands (WS-5): resolve root, confirm it is indexed, open
 * the soul, open the existing derived index, and hand back a wired {@link Verbs}. Prints the
 * "not indexed" message and returns `null` when the root has no `.crib`, so each command stays a
 * thin wrapper over one verb.
 */
function openVerbs(args: string[], ctx?: CmdCtx): { verbs: Verbs; index: IndexStore } | null {
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return null;
  }
  const rt = openSoul(resolved);
  const index = openIndexForRead(rt);
  if (!index) return null;
  const verbs = new Verbs({
    soul: rt.soul,
    index,
    repoRoot: resolved.repoRoot,
    vcs: new CliVcsAdapter(),
  });
  return { verbs, index };
}

/** `crib gaps` — analysis readiness, missing bodies (spec-only callables), unresolved call sites. */
async function cmdGaps(args: string[], ctx?: CmdCtx): Promise<number> {
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  process.stdout.write(
    `${JSON.stringify(
      verbs.gaps({
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
        ...(args.includes('--include-builtins') ? { includeBuiltins: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib rules <proc>` — decision table + coverage readiness for one callable. */
async function cmdRules(args: string[], ctx?: CmdCtx): Promise<number> {
  const proc = args.find((a) => !a.startsWith('-'));
  if (!proc) {
    process.stderr.write('usage: crib rules <procedure> [--include-tables]\n');
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  process.stdout.write(
    `${JSON.stringify(
      verbs.extractRules({
        procedure: proc,
        ...(args.includes('--include-tables') ? { includeTables: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib context <id>` — deep per-symbol context; fold body + rules + framework via flags. */
async function cmdContext(args: string[], ctx?: CmdCtx): Promise<number> {
  // Bulk path: `crib context --package <pkg>` (or --file <path> / --cluster <slug>) returns per-symbol
  // dossiers for EVERY symbol in the scope in ONE call (WS-4). The scope flag may carry its value as
  // the next arg (`--package PKG`) or rely on a positional (`PKG --package`).
  const scope = scopeOf(args);
  if (scope) {
    return cmdContextByScope(args, scope, ctx);
  }
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    process.stderr.write(
      'usage: crib context <id> [--with-source] [--with-rules] [--with-framework] [--extracted-only]\n' +
        '       crib context --package <pkg> [--file <path> | --cluster <slug>]\n' +
        '                      [--format markdown] [--include-tables] [--max-symbols N] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  process.stdout.write(
    `${JSON.stringify(
      verbs.context({
        id,
        ...(args.includes('--with-source') ? { withSource: true } : {}),
        ...(args.includes('--with-rules') ? { withRules: true } : {}),
        ...(args.includes('--with-framework') ? { withFramework: true } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib ask "<question>"` — natural-language question answered deterministically from the crib. */
async function cmdAsk(args: string[], ctx?: CmdCtx): Promise<number> {
  // positionalsOf drops `--format markdown` / `--limit N` values so they never pollute the question.
  const q = positionalsOf(args).join(' ').trim();
  if (!q) {
    process.stderr.write(
      'usage: crib ask "<question>" [--format markdown] [--limit N] [--with-source] [--with-rules] [--with-framework] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;

  const fmtIdx = args.indexOf('--format');
  const format = fmtIdx >= 0 && args[fmtIdx + 1] === 'markdown' ? 'markdown' : undefined;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : undefined;

  const result = verbs.ask({
    q,
    ...(format ? { format } : {}),
    ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
    ...(args.includes('--with-source') ? { withSource: true } : {}),
    ...(args.includes('--with-rules') ? { withRules: true } : {}),
    ...(args.includes('--with-framework') ? { withFramework: true } : {}),
    ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
  });

  if (format === 'markdown') {
    process.stdout.write(`${String(result.markdown ?? '')}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  index.close();
  return EXIT.OK;
}

/** Resolve the bulk-scope flag (`--package` / `--file` / `--cluster`) on a `context` argv, if any. */
function scopeOf(args: string[]): 'package' | 'file' | 'cluster' | undefined {
  if (args.includes('--package')) return 'package';
  if (args.includes('--file')) return 'file';
  if (args.includes('--cluster')) return 'cluster';
  return undefined;
}

/** The bulk `crib context --<scope> <id>` path → `verbs.dossierByScope` (per-symbol dossiers). */
async function cmdContextByScope(
  args: string[],
  scope: 'package' | 'file' | 'cluster',
  ctx?: CmdCtx,
): Promise<number> {
  const flag = scope === 'package' ? '--package' : scope === 'file' ? '--file' : '--cluster';
  const flagIdx = args.indexOf(flag);
  // value may ride the flag (`--package PKG`) or be the positional non-flag arg (`PKG --package`)
  const afterFlag = args[flagIdx + 1];
  const id =
    afterFlag && !afterFlag.startsWith('-')
      ? afterFlag
      : args.find((a, i) => !a.startsWith('-') && i !== flagIdx + 1);
  if (!id) {
    process.stderr.write(
      `usage: crib context ${flag} <id> [--format markdown] [--include-tables] [--max-symbols N] [--extracted-only]\n`,
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const fmtIdx = args.indexOf('--format');
  const format = fmtIdx >= 0 ? (args[fmtIdx + 1] === 'markdown' ? 'markdown' : 'json') : undefined;
  const maxSymIdx = args.indexOf('--max-symbols');
  const maxSymbols = maxSymIdx >= 0 ? Number.parseInt(args[maxSymIdx + 1] ?? '', 10) : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.dossierByScope({
        scope,
        id,
        ...(args.includes('--include-tables') ? { includeTables: true } : {}),
        ...(Number.isFinite(maxSymbols) && maxSymbols! > 0 ? { maxSymbols } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
        ...(format ? { format } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib dossier <id>` — persisted deep artifact (body + callers/callees + rules + CFG constructs). */
async function cmdDossier(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    process.stderr.write(
      'usage: crib dossier <id> [--format markdown] [--include-tables] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const fmtIdx = args.indexOf('--format');
  const format = fmtIdx >= 0 ? (args[fmtIdx + 1] === 'markdown' ? 'markdown' : 'json') : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.dossier({
        id,
        ...(args.includes('--include-tables') ? { includeTables: true } : {}),
        ...(format ? { format } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib reconstruct <pkg>` — package-scoped migration reconstruction (constants + members + tables + docs). */
async function cmdReconstruct(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    process.stderr.write(
      'usage: crib reconstruct <package> [--format markdown] [--no-tables] [--max-symbols N] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const fmtIdx = args.indexOf('--format');
  const format = fmtIdx >= 0 ? (args[fmtIdx + 1] === 'markdown' ? 'markdown' : 'json') : undefined;
  const maxSymIdx = args.indexOf('--max-symbols');
  const maxSymbols = maxSymIdx >= 0 ? Number.parseInt(args[maxSymIdx + 1] ?? '', 10) : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.reconstruct({
        id,
        ...(args.includes('--no-tables') ? { includeTables: false } : {}),
        // guard: a non-positive or non-finite maxSymbols would pass through as 0/negative and silently
        // corrupt downstream `slice(0, N)` (e.g. --max-symbols -5 → slice(0,-5)). Only forward a real cap.
        ...(Number.isFinite(maxSymbols) && maxSymbols! > 0 ? { maxSymbols } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
        ...(format ? { format } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib impact <id> --dir up|down [--depth N]` — blast radius. */
async function cmdImpact(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = positionalsOf(args)[0];
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? (args[dirIdx + 1] as 'up' | 'down' | undefined) : undefined;
  if (!id || (dir !== 'up' && dir !== 'down')) {
    process.stderr.write(
      'usage: crib impact <id> --dir up|down [--depth N] [--limit N] [--include-llm] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const depthIdx = args.indexOf('--depth');
  const depth = depthIdx >= 0 ? Number.parseInt(args[depthIdx + 1] ?? '', 10) : undefined;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.impact({
        id,
        dir,
        ...(Number.isFinite(depth) && depth! > 0 ? { depth } : {}),
        ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
        ...(args.includes('--include-llm') ? { includeLlm: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/**
 * `crib federated-impact <id> --dir up|down [--repo <root>]... [--depth N] [--limit N]
 * [--extracted-only]` — M3.2 cross-repo blast radius. The primary repo (cwd / resolved root) is
 * always federated; each extra `--repo <root>` adds a repo to traverse into. The route-layer bridge
 * crosses a repo-A outbound HTTP call to the repo-B route it serves.
 */
async function cmdFederatedImpact(args: string[], ctx?: CmdCtx): Promise<number> {
  // `args.find(!startsWith('-'))` is wrong here: with `--dir down fetchLoan --repo /B` the first
  // non-dash token is `down` (the --dir VALUE), so id would resolve to 'down' and the real id is
  // captured as a flag value. positionalsOf strips every VALUE_FLAGS value (--dir/--repo/--depth/
  // --limit are all in VALUE_FLAGS), leaving only the genuine positional — the id.
  const id = positionalsOf(args)[0];
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? (args[dirIdx + 1] as 'up' | 'down' | undefined) : undefined;
  if (!id || (dir !== 'up' && dir !== 'down')) {
    process.stderr.write(
      'usage: crib federated-impact <id> --dir up|down [--repo <root>]... [--depth N] [--limit N] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const roots = collectRepeated(args, '--repo');
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const depthIdx = args.indexOf('--depth');
  const depth = depthIdx >= 0 ? Number.parseInt(args[depthIdx + 1] ?? '', 10) : undefined;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.federatedImpact({
        id,
        dir,
        ...(roots.length ? { roots } : {}),
        ...(Number.isFinite(depth) && depth! > 0 ? { depth } : {}),
        ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}
async function cmdPath(args: string[], ctx?: CmdCtx): Promise<number> {
  const positional = positionalsOf(args);
  const [from, to] = positional;
  if (!from || !to) {
    process.stderr.write(
      'usage: crib path <from> <to> [--max-hops N] [--include-llm] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const hopsIdx = args.indexOf('--max-hops');
  const maxHops = hopsIdx >= 0 ? Number.parseInt(args[hopsIdx + 1] ?? '', 10) : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.shortestPath({
        from,
        to,
        ...(Number.isFinite(maxHops) && maxHops! > 0 ? { maxHops } : {}),
        ...(args.includes('--include-llm') ? { includeLlm: true } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

/** `crib neighbors <id> [--rel reads] [--dir in|out|both]` — direct edges of one node. */
async function cmdNeighbors(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = positionalsOf(args)[0];
  if (!id) {
    process.stderr.write(
      'usage: crib neighbors <id> [--rel reads] [--dir in|out|both] [--limit N] [--include-llm] [--extracted-only]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  const relIdx = args.indexOf('--rel');
  const rel = relIdx >= 0 ? args[relIdx + 1] : undefined;
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? (args[dirIdx + 1] as 'in' | 'out' | 'both' | undefined) : undefined;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
  process.stdout.write(
    `${JSON.stringify(
      verbs.neighbors({
        id,
        ...(rel ? { rel } : {}),
        ...(dir ? { dir } : {}),
        ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
        ...(args.includes('--extracted-only') ? { extractedOnly: true } : {}),
        ...(args.includes('--include-llm') ? { includeLlm: true } : {}),
      }),
      null,
      2,
    )}\n`,
  );
  index.close();
  return EXIT.OK;
}

async function cmdOwnership(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    process.stderr.write('usage: crib ownership <id>\n');
    return EXIT.BAD_ARGS;
  }
  const opened = openVerbs(args, ctx);
  if (!opened) return EXIT.NOT_INDEXED;
  const { verbs, index } = opened;
  process.stdout.write(`${JSON.stringify(verbs.ownership({ id }), null, 2)}\n`);
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
  const index = openIndexForRead(rt);
  if (!index) return EXIT.NOT_INDEXED;
  const memory = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  const verbs = new Verbs({
    soul: rt.soul,
    index,
    repoRoot: resolved.repoRoot,
    vcs: new CliVcsAdapter(),
    ...(memory ? { memory } : {}),
  });
  // stdout is the MCP transport; logs go to stderr only.
  const stats = rt.soul.getManifest().stats;
  process.stderr.write(
    `knowledge-crib MCP server on stdio — ${stats.nodes} nodes, ${stats.edges} edges ready (default responses are tiered lean; pass withLlm:true for the full analysis blob)\n`,
  );
  await serveStdio(verbs);
  return EXIT.OK;
}

async function cmdUpdate(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const dirty = args.includes('--dirty');
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  // Multi-package federation: --package restricts this incremental update to one package's slice
  // of an already-indexed monorepo soul, leaving the rest untouched (see UpdateOpts.packageRoots).
  const scope = resolvePackageScope(resolved.repoRoot, args);
  if (scope.status !== EXIT.OK) return scope.status;
  const rt = openSoul(resolved);
  const updateOpts: Parameters<typeof updateRepo>[2] = {
    ...(since ? { since } : {}),
    ...(dirty ? { dirty: true } : {}),
    ...(scope.packageRoots ? { packageRoots: scope.packageRoots } : {}),
  };
  // Sentinel returned from inside the lock when there is no incremental anchor: we must NOT call
  // `cmdIndex` while still holding the lock (it acquires its own → nested LockBusyError), so the
  // fallback is deferred until after runLocked releases.
  const UPDATE_FALLBACK = -2;
  const r = await runLocked(resolved.cribDir, async () => {
    const started = Date.now();
    const result = await updateRepo(rt.soul, resolved.repoRoot, updateOpts);
    if (result === null) return UPDATE_FALLBACK;
    const excludedSuffix =
      result.excludedPaths.length > 0
        ? ` [${result.excludedPaths.length} file(s) outside scope left pending — anchor not advanced]`
        : '';
    if ('noop' in result) {
      process.stdout.write(
        `up to date (head ${result.head.slice(0, 12)}) in ${Date.now() - started}ms${excludedSuffix}\n`,
      );
      return EXIT.OK;
    }
    // Apply the delta to the existing derived index; if none exists yet, build it fresh from the
    // (already-committed) updated soul — a delta applied to an empty index would be meaningless.
    let index: IndexStore;
    try {
      index = openIndexOnly(rt);
      index.applyDelta(result.delta, resolved.repoRoot);
    } catch {
      index = buildIndex(rt); // full buildFromSoul from the just-updated soul
    }
    index.close();
    registerIndexed(resolved.repoRoot, resolved.cribDir, rt.soul);
    const d = result.delta;
    process.stdout.write(
      `updated ${result.changedPaths.length} file(s) [scope ${result.scopeFiles.length}] → ` +
        `+${d.nodes.length} nodes +${d.edges.length} edges −${d.removed.length} in ${Date.now() - started}ms${excludedSuffix}\n` +
        `changed: ${result.changedPaths.join(', ')}\n`,
    );
    return EXIT.OK;
  });
  if (r === UPDATE_FALLBACK) {
    // No anchor / non-git → degrade to a full index (lock now released; cmdIndex acquires its own).
    process.stderr.write('no incremental anchor — falling back to full index\n');
    return cmdIndex(args, ctx);
  }
  return r;
}

async function cmdReindex(args: string[], ctx?: CmdCtx): Promise<number> {
  // reindex targets the exact given dir (no upward walk), like index.
  const repoRoot = resolve(ctx?.cwdOverride ?? positionalsOf(args)[0] ?? '.');
  const semantic = args.includes('--semantic');
  const ignores = parseExcludes(args);
  const scope = resolvePackageScope(repoRoot, args);
  if (scope.status !== EXIT.OK) return scope.status;
  const cribDir = join(repoRoot, '.crib');
  return runLocked(cribDir, async () => {
    const soul = freshSoulForRebuild(cribDir);
    stampPackageMeta(soul, scope);
    const started = Date.now();
    const report = await indexRepo(soul, repoRoot, {
      semantic,
      ignores,
      packageRoots: scope.packageRoots,
    });
    const index = buildIndex({ repoRoot, cribDir, soul });
    index.close();
    registerIndexed(repoRoot, cribDir, soul);
    const stats = soul.getManifest().stats;
    const scopeSuffix = scope.packageRoots ? ` [scoped: ${scope.indexedPackages.join(', ')}]` : '';
    process.stdout.write(
      `reindexed ${report.files} files → ${stats.nodes} nodes, ${stats.edges} edges ` +
        `(${report.link.describes} describes, ${report.link.references} references)${scopeSuffix} in ${Date.now() - started}ms\n`,
    );
    printLlmPending(soul, repoRoot);
    return EXIT.OK;
  });
}

/**
 * `crib init [path] [--ide <name|all>]` — the 5-minute onboarding (M4.2). Orchestrates the three
 * setup steps a new user would otherwise run by hand — index, install-hooks, mcp install — then
 * prints the hero "next steps" so the value is visible immediately and the path to the first MCP
 * query is one copy-paste. Idempotent: re-running refreshes the index, re-wires hooks (managed
 * blocks replace in place), and re-wires MCP (already-present configs report "up to date"). Does
 * NOT take `--semantic` (deterministic-first onboarding; opt into INFERRED links with a later
 * `crib index --semantic`).
 */
async function cmdInit(args: string[], ctx?: CmdCtx): Promise<number> {
  const repoRoot = resolve(ctx?.cwdOverride ?? positionalsOf(args)[0] ?? '.');
  const ideIdx = args.indexOf('--ide');
  const ide: McpIde | 'all' = ideIdx >= 0 ? ((args[ideIdx + 1] as McpIde | 'all') ?? 'all') : 'all';
  const validIdes: Array<McpIde | 'all'> = ['all', 'claude', 'cursor', 'vscode', 'codex'];
  if (!validIdes.includes(ide)) {
    process.stderr.write(`unknown --ide: ${ide}\nvalid: ${validIdes.join(', ')}\n`);
    return EXIT.BAD_ARGS;
  }

  process.stdout.write('crib init — 5-minute onboarding\n');
  process.stdout.write('  step 1/3: indexing the repo (deterministic, LLM-free)…\n');
  const indexCode = await cmdIndex([repoRoot], ctx);
  if (indexCode !== EXIT.OK) {
    process.stderr.write(`  index failed (exit ${indexCode}) — aborting init\n`);
    return indexCode;
  }

  process.stdout.write(
    '  step 2/3: wiring git hooks (post-commit `crib update` + .crib merge driver)…\n',
  );
  const hooksCode = cmdInstallHooks([repoRoot], ctx);
  if (hooksCode !== EXIT.OK) {
    process.stderr.write(`  install-hooks failed (exit ${hooksCode}) — aborting init\n`);
    return hooksCode;
  }

  process.stdout.write(`  step 3/3: wiring the MCP server into IDE config (--ide ${ide})…\n`);
  const mcpCode = cmdMcp(['install', '--ide', ide, repoRoot], ctx);
  if (mcpCode !== EXIT.OK) {
    process.stderr.write(`  mcp install failed (exit ${mcpCode}) — aborting init\n`);
    return mcpCode;
  }

  process.stdout.write('\n✓ crib init complete. Next steps:\n');
  process.stdout.write('  1. Restart your IDE so it picks up the MCP server config.\n');
  process.stdout.write(
    '  2. Ask your agent "query the crib for <symbol>", or run `crib query <text>`.\n',
  );
  process.stdout.write(
    '  3. (optional) `crib index --semantic` — add INFERRED embedding-cosine links.\n',
  );
  process.stdout.write('  4. (optional) `crib enrich --next` — drive the LLM-graph layer.\n');
  process.stdout.write('  Run `crib doctor` any time to re-check setup health.\n');
  return EXIT.OK;
}

/**
 * `crib doctor [path]` — setup health check (M4.2). Runs the six onboarding-critical checks and
 * prints ✓/✗ + a fix hint for each. A failing check never skips the rest — the point is a full
 * diagnostic in one pass. Exits 0 when every check passes, 1 when any fails, so scripts/CI can
 * detect a broken setup. The Node-version check mirrors bin.ts's launcher guard (the canonical
 * gate, REQUIRED_NODE = 22.5.0 — the node:sqlite requirement); doctor re-runs it so a user on a
 * too-old Node learns it here, not from an opaque `node:sqlite` crash.
 */
function cmdDoctor(args: string[], ctx?: CmdCtx): number {
  const repoRoot = resolve(ctx?.cwdOverride ?? positionalsOf(args)[0] ?? '.');
  const checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> = [];

  // 1. Node ≥ 22.5.0 — mirrors bin.ts REQUIRED_NODE (the node:sqlite requirement).
  const REQUIRED_NODE = '22.5.0';
  const parts = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
  const reqParts = REQUIRED_NODE.split('.').map((n) => Number.parseInt(n, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const reqMajor = reqParts[0] ?? 0;
  const reqMinor = reqParts[1] ?? 0;
  const nodeOk = major > reqMajor || (major === reqMajor && minor >= reqMinor);
  checks.push({
    name: 'Node ≥ 22.5.0',
    ok: nodeOk,
    detail: `found ${process.versions.node}`,
    fix: 'upgrade Node, then re-run `crib`',
  });

  // 2. corepack available (the documented pnpm path — `corepack pnpm@9.15.0`).
  let corepackOk = false;
  let corepackDetail = 'not found';
  try {
    const v = execFileSync('corepack', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Windows ships corepack as a .cmd shim; execFileSync(shell:false) cannot launch .cmd files
      // (spawnSync ENOENT) → doctor would report "corepack available ✗ not found" on windows even
      // when corepack IS installed. shell:true on win32 routes through cmd.exe so the .cmd resolves.
      // No-op on posix (shell:false is the default → byte-identical). Same fix as release-verify /
      // build-installers / pack-check / budget-check corepack spawns.
      shell: process.platform === 'win32',
    }).trim();
    corepackOk = true;
    corepackDetail = `corepack ${v}`;
  } catch {
    /* corepack absent — best-effort check, not a hard failure of crib itself */
  }
  checks.push({
    name: 'corepack available',
    ok: corepackOk,
    detail: corepackDetail,
    fix: '`corepack enable` (or install Node ≥ 16.17, which bundles corepack)',
  });

  // 3. .crib indexed (committed soul present).
  const resolved = resolveProjectRoot({ explicitRoot: repoRoot });
  const indexed = isIndexedRoot(resolved);
  checks.push({
    name: 'repo indexed (.crib soul present)',
    ok: indexed,
    detail: indexed ? 'yes' : 'no .crib/crib.json at repo root',
    fix: 'run `crib init` (or `crib index .`)',
  });

  // 4. index freshness — soul vcsHead == current HEAD (only meaningful when indexed).
  if (indexed) {
    const rt = openSoul(resolved);
    const index = openIndexForRead(rt);
    if (index) {
      const verbs = new Verbs({
        soul: rt.soul,
        index,
        repoRoot: resolved.repoRoot,
        vcs: new CliVcsAdapter(),
      });
      const st = verbs.status() as {
        vcsHead?: string;
        currentHead?: string;
        dirty?: { aheadOfVcsHead?: boolean };
      };
      index.close();
      const stale = st.dirty?.aheadOfVcsHead === true;
      checks.push({
        name: 'index fresh (soul vcsHead == HEAD)',
        ok: !stale,
        detail: stale
          ? `soul at ${st.vcsHead ?? '(none)'}, HEAD at ${st.currentHead ?? '(none)'}`
          : 'up to date',
        fix: 'run `crib update .`',
      });
    } else {
      checks.push({
        name: 'index fresh (soul vcsHead == HEAD)',
        ok: false,
        detail: 'derived index missing',
        fix: 'run `crib index .`',
      });
    }
  } else {
    checks.push({
      name: 'index fresh (soul vcsHead == HEAD)',
      ok: false,
      detail: 'skipped — repo not indexed',
      fix: 'run `crib init` first',
    });
  }

  // 5. git hooks installed (post-commit `crib update` + soul/memory merge drivers).
  const hooks = hooksInstalled(repoRoot);
  const hooksOk =
    hooks.postCommit && hooks.gitattributes && hooks.driverConfig && hooks.memoryDriverConfig;
  checks.push({
    name: 'git hooks installed',
    ok: hooksOk,
    detail: `post-commit ${hooks.postCommit ? '✓' : '✗'}, .gitattributes ${hooks.gitattributes ? '✓' : '✗'}, soul merge driver ${hooks.driverConfig ? '✓' : '✗'}, memory merge driver ${hooks.memoryDriverConfig ? '✓' : '✗'}`,
    fix: 'run `crib install-hooks`',
  });

  // 6. IDE MCP wiring present (any IDE in project scope).
  let wired = false;
  let wiredDetail = 'no IDE config found';
  try {
    const entries = listMcp(repoRoot, { ide: 'all', scope: 'project' });
    const present = entries.filter((e) => e.present);
    wired = present.length > 0;
    wiredDetail = present.length > 0 ? present.map((e) => e.ide).join(', ') : 'none present';
  } catch {
    /* best-effort — listMcp should not throw, but never let a diagnostic crash */
  }
  checks.push({
    name: 'IDE MCP wiring present',
    ok: wired,
    detail: wiredDetail,
    fix: 'run `crib mcp install` (or `crib init`)',
  });

  let failures = 0;
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗';
    process.stdout.write(`  ${mark} ${c.name} — ${c.detail}\n`);
    if (!c.ok) {
      failures++;
      if (c.fix) process.stdout.write(`      fix: ${c.fix}\n`);
    }
  }
  process.stdout.write(
    `\ncrib doctor: ${checks.length - failures}/${checks.length} checks passed\n`,
  );
  return failures > 0 ? EXIT.ERROR : EXIT.OK;
}

/** `crib merge-driver %O %A %B %P` — git custom merge driver for one `.crib` JSONL chunk. */
function cmdMergeDriver(args: string[]): number {
  // git passes: %O ancestor  %A current/ours (output)  %B other/theirs  %P pathname
  const [basePath, oursPath, theirsPath, pathName] = args;
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write('usage: crib merge-driver %O %A %B %P\n');
    return EXIT.BAD_ARGS;
  }
  const { warnings, conflicts } = mergeDriverFiles(basePath, oursPath, theirsPath, pathName);
  for (const w of warnings) process.stderr.write(`merge warning: ${w}\n`);
  // 0 = clean merge (incl. auto-resolved edges / memory union); 1 = unresolvable collision or
  // malformed memory line needing human review.
  return conflicts ? EXIT.ERROR : EXIT.OK;
}

function cmdInstallHooks(args: string[], ctx?: CmdCtx): number {
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg(args) ?? '.');
  const res = installHooks(repoRoot);
  process.stdout.write(
    `installed kcrib hooks at ${res.gitDir}\n  post-commit → ${res.postCommitPath}\n  .gitattributes → ${res.gitattributesPath} (.crib/**/*.jsonl merge=kcrib, .crib/memory/team/**/*.jsonl merge=kcrib-memory)\n  merge.kcrib.driver = ${res.driverConfig}\n  merge.kcrib-memory.driver = ${res.driverConfig}\n`,
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
 * `crib export [--format rules|mermaid|graph.json|report|llm] [--procedure <id|name>]` — render the
 * soul. `rules`/`mermaid` need `--procedure` (a node id or a procedure/function name); `graph.json`
 * and `report` dump the whole soul (report optionally scoped to one procedure via --procedure);
 * `llm` dumps the committed LLM layer (redacted by default — M1.4).
 */
async function cmdExport(args: string[], ctx?: CmdCtx): Promise<number> {
  // Parse flags + their values out so flag values aren't mistaken for a positional path.
  let format = 'report';
  let procedure: string | undefined;
  let redact = true; // M1.4: the LLM export redacts by default; --no-redact opts out (local debugging only)
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--no-redact') {
      redact = false;
    } else if (a === '--redact') {
      redact = true;
    } else if (a === '--format') {
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

  const formats = ['rules', 'mermaid', 'graph.json', 'report', 'llm'] as const;
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
    if (fmt === 'llm') {
      // M1.4: `llm` dumps committed semantic layer (`.crib/graph/semantic/`). `--redact` (default)
      // strips every evidence `quote` to a span ref `{soulId, file, startLine, endLine}` and masks
      // any secret-pattern substring in analysis/graph strings, so the exported bundle never
      // carries verbatim source snippets or secrets even if the on-disk artifacts do.
      const enrich = new EnrichmentStore(rt.soul, resolved.repoRoot);
      process.stdout.write(enrich.exportLlm(redact));
      if (!redact) {
        process.stderr.write(
          'warning: --no-redact emits verbatim evidence quotes — do not share the output externally.\n',
        );
      }
    } else {
      process.stdout.write(
        renderExport(rt.soul, fmt, procedure, {
          extractedOnly: args.includes('--extracted-only'),
        }),
      );
    }
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
  const persistedIntegrity = validateClusterIntegrity(rt.soul);
  let repairedClusters = false;
  if (!persistedIntegrity.valid) {
    runCluster(rt.soul);
    repairedClusters = true;
  }
  const graph = buildVizGraph(rt.soul);
  const overview = buildVizOverview(rt.soul);
  const assets = vizAssetsDir();
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { extname } = await import('node:path');

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: reject any non-loopback Host before touching a file.
      if (!isAllowedHost(req.headers.host)) {
        throw new VizHttpError(403, 'host not allowed');
      }
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/graph.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(graph));
        return;
      }
      if (requestUrl.pathname === '/overview.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(overview));
        return;
      }
      if (requestUrl.pathname === '/source') {
        const nodeId = requestUrl.searchParams.get('nodeId');
        if (!nodeId) throw new VizHttpError(400, 'missing nodeId');
        const source = await readVizNodeSource(rt.soul, rt.repoRoot, nodeId);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(source));
        return;
      }
      const path = await resolveVizAsset(assets, requestUrl.pathname);
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      const status = err instanceof VizHttpError ? err.status : 500;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
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
  if (repairedClusters) {
    process.stderr.write(
      'warning: stale cluster topology repaired in memory for this session; run `crib reindex` to persist it.\n',
    );
  }
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

/**
 * `crib enrich` — LLM-graph work queue + driver surface (Phase D). The CLI process itself has no
 * model, so this is the *queue + seed* view, not the author: it prints coverage (`enrich_status`),
 * the next batch of grounded work items (`enrich_next`), or persists an externally-authored batch
 * (`enrich_save --file <path>`). The authoring is done by the host IDE LLM via the `/crib-enrich`
 * skill (which calls the same verbs over MCP) or by any agent that reads `--next` and writes `--save`.
 *
 * Usage:
 *   crib enrich [path] [--budget-tokens N]            coverage + pending count + follow-up hint
 *   crib enrich --next [path] [--layer L] [--limit N] [--scope PFX] [--budget-tokens N]  print the next grounded batch
 *   crib enrich --auto [path] [--max-tokens N] [--max-batches N] [--layer L] [--scope PFX] [--budget-tokens N]
 *                                                       bounded autonomous loop (stub-authors + saves per batch)
 *   crib enrich --save <file> [path] [--scope PFX]   persist a {batchId, items[]} JSON batch
 *   crib enrich --overview [path] [--scope PFX]     print the bible (scoped to PFX if given)
 *   crib enrich --scopes [path] [--budget-tokens N] ranked path-prefix scopes for the picker
 *
 * `--budget-tokens N` is a per-batch PACKER (not a guard): `--next` fills a batch whose estimated
 * cost fits N, capped at `--limit` (default 25). If the first item alone exceeds N it is returned
 * alone with `oversized:true` (the queue never stalls). `--auto --max-tokens N` bounds the whole
 * turn (sum of batch costs); `--auto --max-batches N` caps the batch count; the loop also stops at
 * a layer boundary and breaks on zero-progress or rejects (exit non-zero).
 *
 * `--scope <prefix>` restricts status/next to in-scope targets (system layer is whole-repo only).
 * `--scope-cluster <cluster>` optionally refines inside the prefix. `--scopes` is a discovery view.
 */
async function cmdEnrich(args: string[], ctx?: CmdCtx): Promise<number> {
  // Strip --save <file> so the file path is not misinterpreted as the project root.
  const rootArgs = args.slice();
  const saveIdx = rootArgs.indexOf('--save');
  if (saveIdx >= 0) {
    rootArgs.splice(saveIdx, 2);
  }
  const resolved = resolveRoot(rootArgs, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const enrich = new EnrichmentStore(rt.soul, resolved.repoRoot);

  let scope: EnrichScope | undefined;
  try {
    scope = parseScopeFlag(args);
  } catch (e) {
    // `--scope` present but malformed (missing/flag-like value) MUST NOT silently default to full-repo
    // — that silent default is the exact failure mode the scope picker exists to prevent.
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return EXIT.BAD_ARGS;
  }
  const budgetIdx = args.indexOf('--budget-tokens');
  const budgetTokens = budgetIdx >= 0 ? Number.parseInt(args[budgetIdx + 1] ?? '', 10) : undefined;
  const budget = Number.isFinite(budgetTokens) && budgetTokens! > 0 ? budgetTokens : undefined;

  if (args.includes('--prune-stale')) {
    return runLocked(resolved.cribDir, () => {
      const result = enrich.pruneStale(args.includes('--apply'));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return EXIT.OK;
    });
  }

  // --scopes: discovery view — ranked path-prefix scopes for a headless/CI agent to pick from.
  if (args.includes('--scopes')) {
    const st = enrich.status({ scopes: true, ...(budget ? { budgetTokens: budget } : {}) });
    process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
    if (st.budgetExceeded) {
      process.stderr.write(
        `budget guard: pending cost ~${st.costEstimate?.pending} tokens exceeds --budget-tokens ${budget}\n`,
      );
      return EXIT.ERROR;
    }
    return EXIT.OK;
  }

  if (args.includes('--overview')) {
    const withLlm = args.includes('--full');
    process.stdout.write(
      `${JSON.stringify(
        enrich.overview({ ...(scope ? { scope } : {}), ...(withLlm ? { withLlm: true } : {}) }),
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  if (args.includes('--save')) {
    const fileIdx = args.indexOf('--save');
    const file = args[fileIdx + 1];
    if (file === undefined || file.startsWith('--')) {
      process.stderr.write('usage: crib enrich --save <file> [path] [--scope PFX]\n');
      return EXIT.BAD_ARGS;
    }
    const batch = JSON.parse(readFileSync(file, 'utf8')) as {
      batchId: string;
      items: Array<Record<string, unknown>>;
    };
    const result = enrich.save(batch as never) as { accepted: unknown[]; rejected: unknown[] };
    // Advisory: scope is a queue filter, not a write constraint — but warn if a saved target is
    // out-of-scope so a headless driver notices a scope/file mismatch.
    if (scope) {
      for (const item of batch.items) {
        const tid = String(item.targetId ?? '');
        const node = rt.soul.getNode(tid);
        if (node?.file && !pathInPrefix(node.file, scope)) {
          process.stderr.write(
            `warning: saved target ${tid} is outside scope ${scope.pathPrefix}\n`,
          );
        }
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT.OK;
  }

  if (args.includes('--auto')) {
    const layerIdx = args.indexOf('--layer');
    const layer = layerIdx >= 0 ? (args[layerIdx + 1] as EnrichLayer | undefined) : undefined;
    const maxTokensIdx = args.indexOf('--max-tokens');
    const maxTokensRaw =
      maxTokensIdx >= 0 ? Number.parseInt(args[maxTokensIdx + 1] ?? '', 10) : undefined;
    const maxBatchesIdx = args.indexOf('--max-batches');
    const maxBatchesRaw =
      maxBatchesIdx >= 0 ? Number.parseInt(args[maxBatchesIdx + 1] ?? '', 10) : undefined;
    // Turn-level bounds (distinct from --budget-tokens, the per-batch packer ceiling). Defaults match
    // the /crib-enrich skill's Phase 1-auto loop so a bare `crib enrich --auto` behaves identically to
    // the interactive autonomous mode: ~100k tokens, ≤5 batches, stop at a layer boundary for review.
    const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw! > 0 ? maxTokensRaw! : 100_000;
    const maxBatches = Number.isFinite(maxBatchesRaw) && maxBatchesRaw! > 0 ? maxBatchesRaw! : 5;
    return runLocked(resolved.cribDir, () => {
      let spent = 0;
      let batches = 0;
      let startLayer: EnrichLayer | undefined;
      let lastBatchId: string | undefined;
      const nextArgs = {
        ...(layer ? { layer } : {}),
        ...(scope ? { scope } : {}),
        ...(budget ? { budgetTokens: budget } : {}),
      };
      while (true) {
        const batch = enrich.next(nextArgs);
        // Nothing left for this layer/scope (pending drained) — done, not an error.
        if (batch.items.length === 0) {
          process.stdout.write(`auto: nothing pending for layer ${batch.layer} — done.\n`);
          break;
        }
        // Zero-progress: the same batchId was already issued with no save landing. A headless driver
        // hitting this is the churn trap — break non-zero so CI/loops notice instead of spinning.
        if (batch.zeroProgress || batch.batchId === lastBatchId) {
          process.stderr.write(
            `zero-progress: batchId ${batch.batchId} re-issued for layer ${batch.layer} with no save landing — stopping (run \`crib enrich --next\` + \`--save\` to advance).\n`,
          );
          return EXIT.ERROR;
        }
        // Layer boundary: the queue advanced to a new layer since the first batch. Stop for human
        // review rather than silently grinding through every layer in one turn.
        if (startLayer === undefined) startLayer = batch.layer;
        else if (batch.layer !== startLayer) {
          process.stdout.write(
            `auto: layer boundary ${startLayer} → ${batch.layer} — stopping for review.\n`,
          );
          break;
        }
        const batchCost = batch.costEstimate?.batch ?? 0;
        // Token ceiling bounds the TURN, not the batch: the first batch always runs (batches===0 guard)
        // so a single fat batch still makes progress; subsequent batches stop before overshooting.
        if (batches > 0 && spent + batchCost > maxTokens) {
          process.stdout.write(
            `auto: token ceiling reached (~${spent} spent + ~${batchCost} next > ${maxTokens}) — stopping.\n`,
          );
          break;
        }
        lastBatchId = batch.batchId;
        // Stub-author each item: the CLI has no model, so --auto cannot produce real analyses. A stub
        // (model 'crib-auto-stub', confidence 0.1, empty graph/evidence) passes validation and marks
        // its target fresh for queue purposes (read() checks nodeHash+schemaVersion, NOT grounded) — so
        // the queue advances and a later /crib-enrich pass refines the stubs. Grounding/audit-llm will
        // flag stubs as ungrounded in diagnostics, which is the correct signal: they are placeholders.
        const items: EnrichSaveItem[] = batch.items.map((item) => ({
          targetId: item.targetId,
          model: 'crib-auto-stub',
          analysis: {
            purpose: 'Auto-stub placeholder — refine via /crib-enrich.',
            responsibilities: [],
            confidence: 0.1,
          },
          graph: { nodes: [], edges: [] },
          evidence: [],
        }));
        const result = enrich.save({ batchId: batch.batchId, items }) as {
          accepted: unknown[];
          rejected: Array<{ targetId: string; reason: string }>;
        };
        if (result.rejected.length > 0) {
          process.stderr.write(
            `auto: ${result.rejected.length} item(s) rejected — stopping for review:\n${result.rejected.map((r) => `  ${r.targetId}: ${r.reason}`).join('\n')}\n`,
          );
          return EXIT.ERROR;
        }
        spent += batchCost;
        batches += 1;
        process.stdout.write(
          `auto batch ${batches}: layer=${batch.layer} accepted=${result.accepted.length}` +
            ` remaining=${batch.remaining} cost=${batchCost} spent=${spent}/${maxTokens}\n`,
        );
        if (batches >= maxBatches) {
          process.stdout.write(
            `auto: max-batches reached (${maxBatches}) — stopping for review.\n`,
          );
          break;
        }
      }
      process.stdout.write(
        `auto: ${batches} batch(es), ~${spent} tokens spent${
          startLayer ? `, layer ${startLayer}` : ''
        }. Refine stubs via /crib-enrich.\n`,
      );
      return EXIT.OK;
    });
  }

  if (args.includes('--next')) {
    const layerIdx = args.indexOf('--layer');
    const layer = layerIdx >= 0 ? (args[layerIdx + 1] as EnrichLayer | undefined) : undefined;
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '', 10) : undefined;
    const skeleton = args.includes('--skeleton');
    const batch = enrich.next({
      ...(layer ? { layer } : {}),
      ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
      ...(scope ? { scope } : {}),
      ...(budget ? { budgetTokens: budget } : {}),
      ...(skeleton ? { skeleton: true } : {}),
    });
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
    // Under token-packed selection, budgetExceeded only fires when a single item alone exceeds the
    // budget — and that item is STILL returned (oversized:true) so the queue never stalls. It is
    // workable, not an error: warn and let the host author it (or raise --budget-tokens / route to a
    // bigger tier). The old "reduce --limit" advice was for the pre-WP1 count-sliced semantics.
    if (batch.budgetExceeded) {
      process.stderr.write(
        `warning: batch cost ~${batch.costEstimate?.batch} tokens exceeds --budget-tokens ${budget} — the single oversized item is returned alone (oversized). Author it, raise --budget-tokens, or route to a bigger model tier.\n`,
      );
    }
    if (batch.zeroProgress) {
      process.stderr.write(
        `zero-progress: batchId ${batch.batchId} was already issued for layer ${batch.layer}` +
          ` (previousBatchId ${batch.previousBatchId ?? 'n/a'}) with no save landing — stop and check that enrich_save is persisting.\n`,
      );
    }
    return EXIT.OK;
  }

  // default: coverage + pending + follow-up hint (scoped if --scope given).
  const st = enrich.status({
    ...(scope ? { scope } : {}),
    ...(budget ? { budgetTokens: budget } : {}),
  });
  process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
  if (st.budgetExceeded) {
    process.stderr.write(
      `budget guard: pending cost ~${st.costEstimate?.pending} tokens exceeds --budget-tokens ${budget}\n`,
    );
    return EXIT.ERROR;
  }
  const layers = st.layers as Record<string, { missing: number; stale: number }>;
  if (!st.done) {
    // Under a scope the system key in `layers` is the WHOLE-REPO system count (reported separately in
    // wholeRepoPending.system) — exclude it from the scoped pending sum so the hint reflects scoped work.
    const scopedKeys = scope
      ? ['symbol', 'file', 'cluster']
      : ['symbol', 'file', 'cluster', 'system'];
    const pending = scopedKeys.reduce(
      (n, k) => n + (layers[k]?.missing ?? 0) + (layers[k]?.stale ?? 0),
      0,
    );
    process.stdout.write(
      `${pending} target(s) pending (next: ${st.nextLayer ?? 'symbol'}) — run \`/crib-enrich\` to author the LLM graph.\n`,
    );
    if (scope && st.wholeRepoPending?.system) {
      process.stdout.write(
        `(${st.wholeRepoPending.system} whole-repo system target(s) still pending — needs an unscoped pass)\n`,
      );
    }
  } else if (scope) {
    process.stdout.write(
      `scope \`${scope.pathPrefix}\` complete — run \`crib enrich --overview --scope ${scope.pathPrefix}\` for the module bible (whole-repo system layer still needs an unscoped pass).\n`,
    );
  } else {
    process.stdout.write('LLM graph complete — `crib enrich --overview` for the bible.\n');
  }
  return EXIT.OK;
}

/**
 * Parse `--scope <prefix>` + optional `--scope-cluster <cluster>` into an EnrichScope (or undefined
 * when `--scope` is absent). Throws when `--scope` (or `--scope-cluster`) is present but its value is
 * missing or flag-like — a malformed scope MUST surface as BAD_ARGS, never silently default to full-repo.
 */
function parseScopeFlag(args: string[]): EnrichScope | undefined {
  const idx = args.indexOf('--scope');
  if (idx < 0) return undefined;
  const pathPrefix = args[idx + 1];
  if (looksLikeFlag(pathPrefix)) {
    throw new Error(
      `--scope requires a path prefix (e.g. packages/cli); got ${pathPrefix === undefined ? 'nothing' : `'${pathPrefix}'`}`,
    );
  }
  const clusterIdx = args.indexOf('--scope-cluster');
  if (clusterIdx >= 0) {
    const cluster = args[clusterIdx + 1];
    if (looksLikeFlag(cluster)) {
      throw new Error(
        `--scope-cluster requires a cluster id; got ${cluster === undefined ? 'nothing' : `'${cluster}'`}`,
      );
    }
    return { pathPrefix, cluster };
  }
  return { pathPrefix };
}

/** True when a flag's value slot is missing or itself looks like another flag (e.g. `--scope --next`). */
function looksLikeFlag(v: string | undefined): boolean {
  return v === undefined || v.startsWith('--');
}

/** Trailing-slash-safe prefix test: `packages/core` matches itself and `packages/core/x` only. */
function pathInPrefix(path: string, scope: EnrichScope): boolean {
  const prefix = scope.pathPrefix;
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * `crib audit-llm` (M1.3 — the moat): re-verify every persisted LLM artifact on disk against the
 * current soul. Re-runs the save-time grounding check (rehydrate each evidence quote's anchor span,
 * require overlap), so a post-refactor re-verify is identical to the original verdict. PURE — the
 * CLI never calls a model and never mutates the on-disk artifacts. Prints a per-target table + the
 * aggregate verdict; exits non-zero when any artifact is ungrounded or drifted so CI can gate on it.
 *
 *   crib audit-llm [path]
 */
async function cmdAuditLlm(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const enrich = new EnrichmentStore(rt.soul, resolved.repoRoot);
  const result = enrich.auditLlm();
  if (result.checked === 0) {
    process.stdout.write(
      'no LLM artifacts on disk — run `crib enrich --next` then `--save` first.\n',
    );
    return EXIT.OK;
  }
  const rows = result.targets.map((t) => {
    const stamp = t.stampedGrounded === undefined ? '-' : t.stampedGrounded ? 'g' : 'u';
    const verdict = t.grounded ? 'g' : 'u';
    const drift =
      t.stampedGrounded !== undefined && t.stampedGrounded !== t.grounded ? ' DRIFT' : '';
    const stale = t.stale ? ' stale' : '';
    return `${verdict}/${stamp}  g=${t.groundedCount} u=${t.ungroundedCount} unsup=${t.unsupportedCount}  ${t.layer}  ${t.targetId}${drift}${stale}`;
  });
  process.stdout.write(
    `audited ${result.checked} artifact(s): ${result.grounded} grounded, ${result.ungrounded} ungrounded, ${result.drifted} drifted, ${result.stale} stale\n`,
  );
  for (const row of rows) process.stdout.write(`  ${row}\n`);
  if (result.ungrounded > 0 || result.drifted > 0) return EXIT.ERROR;
  return EXIT.OK;
}

/**
 * `crib skill <install|list> [name] [--dest <dir>]` — install the bundled `/crib-enrich` skill into
 * `~/.claude/skills/` by default, or another client's skill root via `--dest`.
 * Mirrors `crib mcp install` (idempotent, non-clobbering). `list` prints the bundled skills.
 */
function cmdSkill(args: string[]): number {
  const [sub, ...rest] = args;
  let destRoot: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--dest') {
      const value = rest[++i];
      if (looksLikeFlag(value)) {
        process.stderr.write('usage: crib skill install [name] [--dest <dir>]\n');
        return EXIT.BAD_ARGS;
      }
      destRoot = value;
      continue;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`unknown skill option: ${arg}\n`);
      return EXIT.BAD_ARGS;
    }
    if (!name) name = arg;
  }

  switch (sub) {
    case 'install': {
      const results = installSkill({
        ...(name ? { name } : {}),
        ...(destRoot ? { destRoot } : {}),
      });
      for (const r of results) {
        if (r.note) process.stdout.write(`${r.name}: ${r.note}\n`);
        else
          process.stdout.write(
            `${r.name}: ${r.written ? 'installed' : 'up to date'} → ${r.destDir}\n`,
          );
      }
      return EXIT.OK;
    }
    case 'list': {
      const skills = listBundledSkills();
      if (skills.length === 0) {
        process.stdout.write('no bundled skills\n');
        return EXIT.OK;
      }
      for (const s of skills) {
        process.stdout.write(`${s.name}${s.description ? ` — ${s.description}` : ''}\n`);
      }
      return EXIT.OK;
    }
    case undefined:
    case '-h':
    case '--help':
      process.stderr.write('usage: crib skill <install|list> [name] [--dest <dir>]\n');
      return EXIT.BAD_ARGS;
    default:
      process.stderr.write(`unknown skill subcommand: ${sub}\n`);
      return EXIT.BAD_ARGS;
  }
}

// ─── W4 — trusted agent-memory CLI (PRD lines 252–280) ────────────────────────

/**
 * Build the optional {@link MemoryDeps} for a serving/CLI context: the three stores (team / local /
 * global) + the independent {@link MemoryEvaluator} wired to a {@link SoulStoreSoulPort}. Returns
 * `undefined` when the repoId cannot be resolved (an unregistered repo — the memory verbs then
 * degrade to `{ memory: 'not configured' }` rather than writing content-ids with a blank repoId).
 * The stores are constructed lazily; dirs are created on first write, not here.
 */
function createMemoryDeps(soul: SoulStore, repoRoot: string, cribDir: string) {
  const repoId = readRepoId(cribDir);
  if (!repoId) return undefined;
  const env = process.env;
  const evaluator = new MemoryEvaluator();
  const evalCtx = { soul: new SoulStoreSoulPort(soul, repoRoot) };
  return {
    team: MemoryStore.team(cribDir, { repoRoot, env }),
    local: MemoryStore.local(repoId, { repoRoot, env }),
    global: MemoryStore.global({ env }),
    evaluator,
    evalCtx,
  };
}

/** blake3 digest of the working-tree state the gate observed (uncommitted file list — PRD line 277). */
function worktreeDigest(root: string): string {
  return `blake3:${blake3Hex(uncommittedChanges(root).join('\n'))}`;
}

/** Find a candidate by id in the local `candidates` collection, or undefined. */
function findCandidate(local: MemoryStore, id: string): MemoryCandidate | undefined {
  for (const e of local.readCollection('candidates').entries) {
    if ((e as MemoryCandidate).id === id) return e as MemoryCandidate;
  }
  return undefined;
}

/** Find an activated record by id in the local `active` collection, or undefined. */
function findActiveRecord(local: MemoryStore, id: string): MemoryRecord | undefined {
  for (const e of local.readCollection('active').entries) {
    if ((e as MemoryRecord).id === id) return e as MemoryRecord;
  }
  return undefined;
}

/** Find a gate receipt by id in the local `receipts` collection, or undefined. */
function findReceipt(local: MemoryStore, id: string): GateReceipt | undefined {
  for (const e of local.readCollection('receipts').entries) {
    if ((e as GateReceipt).id === id) return e as GateReceipt;
  }
  return undefined;
}

/**
 * `crib memory` — the evaluation / promotion surface (PRD lines 252–258). Subcommands:
 *   - init                 bootstrap `.crib/memory/policy.json` + report the resolved store layout
 *   - evaluate <id> -p X   run the gate → evaluate → activate (the happy path); crash-safe
 *   - activate <id>        crash-recovery: re-evaluate + activate against an existing receipt
 *   - propose <mem-id>     write a team record + accept decision (idempotent; CI derives trust)
 *   - attest <id>          TTY-only human attestation: stamp a human-attestation evidence item
 * The MCP server NEVER calls these — only the CLI / CI runner produce evaluation receipts (PRD 68).
 */
async function cmdMemory(args: string[], ctx?: CmdCtx): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'init':
      return cmdMemoryInit(rest, ctx);
    case 'evaluate':
      return cmdMemoryEvaluate(rest, ctx);
    case 'activate':
      return cmdMemoryActivate(rest, ctx);
    case 'propose':
      return cmdMemoryPropose(rest, ctx);
    case 'attest':
      return cmdMemoryAttest(rest, ctx);
    case 'check':
      return cmdMemoryCheck(rest, ctx);
    case 'audit':
      return cmdMemoryAudit(rest, ctx);
    case 'gc':
      return cmdMemoryGc(rest, ctx);
    case 'migrate':
      return cmdMemoryMigrate(rest, ctx);
    case undefined:
    case '-h':
    case '--help':
      process.stderr.write(
        'crib memory init | evaluate <candidate> --profile <name> | activate <candidate> | propose <memory-id> | attest <candidate> | check | audit [--repair-local] | gc [--max-age-days N] [--dry-run] | migrate\n',
      );
      return EXIT.OK;
    default:
      process.stderr.write(`unknown memory subcommand: ${sub}\n`);
      return EXIT.BAD_ARGS;
  }
}

/** `crib memory init` — write a default trusted-base policy.json if absent + report the layout. */
function cmdMemoryInit(args: string[], ctx?: CmdCtx): number {
  const resolved = resolveRoot(args, ctx);
  const memoryDir = join(resolved.cribDir, 'memory');
  const policyFile = join(memoryDir, 'policy.json');
  const repoId = readRepoId(resolved.cribDir);
  if (!repoId) {
    process.stderr.write(
      'could not resolve a stable repoId — run `crib index` to register this repo first\n',
    );
    return EXIT.NOT_INDEXED;
  }
  if (!existsSync(policyFile)) {
    const defaultPolicy: MemoryPolicy = {
      version: 1,
      profiles: {
        'self-test': {
          name: 'self-test',
          executable: 'node',
          args: ['--version'],
          timeoutMs: 5000,
          permittedEnv: ['PATH'],
          successExitCodes: [0],
          assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
        },
      },
    };
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(policyFile, `${JSON.stringify(defaultPolicy, null, 2)}\n`);
    process.stdout.write(
      `wrote default policy → ${policyFile}\nedit it to add the gate profiles your memories require\n`,
    );
  } else {
    process.stdout.write(`policy already present → ${policyFile}\n`);
  }
  process.stdout.write(
    `repoId: ${repoId}\nteam store:  ${join(resolved.cribDir, 'memory', 'team')}\nlocal store: ~/.crib/memory/repos/${repoId}\n`,
  );
  return EXIT.OK;
}

/** `crib memory evaluate <candidate> --profile <name>` — gate → evaluate → activate (PRD line 255). */
async function cmdMemoryEvaluate(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = pathArg(args);
  if (!id) {
    process.stderr.write('usage: crib memory evaluate <candidate-id> --profile <name>\n');
    return EXIT.BAD_ARGS;
  }
  const profileIdx = args.indexOf('--profile');
  const profileName = profileIdx >= 0 ? args[profileIdx + 1] : undefined;
  if (!profileName) {
    process.stderr.write('error: --profile <name> is required (the trusted-base gate profile)\n');
    return EXIT.BAD_ARGS;
  }
  const rootArgs = args.slice();
  if (profileIdx >= 0) rootArgs.splice(profileIdx, 2);
  const resolved = resolveRoot(rootArgs, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const policy = loadPolicy(resolved.cribDir);
  if (!policy) {
    process.stderr.write(
      `no trusted-base policy at ${join(resolved.cribDir, 'memory', 'policy.json')} — run \`crib memory init\` first\n`,
    );
    return EXIT.ERROR;
  }
  const profile = resolveProfile(policy, profileName);
  if (!profile) {
    process.stderr.write(
      `error: profile '${profileName}' not in trusted-base policy (have: ${Object.keys(policy.profiles).join(', ')})\n`,
    );
    return EXIT.BAD_ARGS;
  }
  const local = deps.local;
  const candidate = findCandidate(local, id);
  if (!candidate) {
    process.stderr.write(
      `error: no local candidate '${id}' — observe one first (memory_observe)\n`,
    );
    return EXIT.ERROR;
  }
  // W5 (PRD line 354): record the attempt lifecycle as structured events (the crash trail, PRD line
  // 348). Reuse the candidate's attemptId when memory_observe started one (origin === 'attempt');
  // otherwise mint a fresh group. On success the trail is compacted to one summary (PRD line 359);
  // on failure the trail stays (a failed attempt is non-retrievable, GC'd after 30d — PRD line 359).
  const attemptId =
    candidate.attemptId ??
    attemptGroupId({
      subject: candidate.subject,
      actor: candidate.authorship.actor,
      startedAt: new Date().toISOString(),
      origin: 'attempt',
    });
  // `att` records one lifecycle event; only structured summaries / refs / fingerprints / receipt ids
  // (PRD line 355 + W5 exit gate: never raw prompts/transcripts/CoT/command output).
  const att = (
    phase: AttemptPhase,
    extra: {
      subject?: string;
      observation?: StructuredSummary;
      action?: StructuredSummary;
      outcome?: AttemptOutcome;
      candidateId?: string;
      evaluationId?: string;
    } = {},
  ): void => {
    const id = attemptEventId({ attemptId, phase, ...extra });
    appendAttemptEvent(
      local,
      buildAttemptEvent({ id, attemptId, phase, ts: new Date().toISOString(), ...extra }),
    );
  };
  att('start', { subject: candidate.subject });
  // PRD line 277: snapshot → execute → reacquire → verify. The snapshot is taken WITHOUT a lock;
  // the gate runs outside any lock; verification happens after.
  const before = {
    policyHash: policyHash(policy),
    head: currentHead(resolved.repoRoot),
    worktreeDigest: worktreeDigest(resolved.repoRoot),
    candidateId: candidate.id,
  };
  att('observation', {
    observation: { summary: 'gate snapshot', fileRefs: [resolved.repoRoot] },
  });
  const gate = await runGate({
    profile,
    policy,
    head: before.head,
    worktreeDigest: before.worktreeDigest,
    runner: 'cli',
    repoRoot: resolved.repoRoot,
    env: process.env,
    now: () => new Date().toISOString(),
  });
  if (!gate.ok) {
    att('outcome', { outcome: { status: 'failure' } });
    process.stderr.write(`gate failed: ${gate.error}\n`);
    return EXIT.ERROR;
  }
  att('action', {
    action: { summary: `gate profile ${profileName}`, receiptIds: [gate.receipt.id] },
  });
  // Reacquire + verify the snapshot (PRD line 277): a drift means the gate ran against state that
  // has since changed → the receipt MUST NOT be trusted.
  const after = {
    policyHash: policyHash(loadPolicy(resolved.cribDir) ?? policy),
    head: currentHead(resolved.repoRoot),
    worktreeDigest: worktreeDigest(resolved.repoRoot),
    candidateId: findCandidate(local, id)?.id ?? '',
  };
  if (
    !verifySnapshot(before, {
      policyHash: after.policyHash,
      head: after.head,
      worktreeDigest: after.worktreeDigest,
      candidateId: after.candidateId,
    })
  ) {
    att('outcome', { outcome: { status: 'failure' } });
    process.stderr.write(
      'error: snapshot drift after gate run (policy/HEAD/worktree/candidate changed) — aborting promotion\n',
    );
    return EXIT.ERROR;
  }
  att('outcome', { outcome: { status: 'success', receiptId: gate.receipt.id } });
  att('candidate', { candidateId: candidate.id });
  const evaluation = evaluateCandidate(candidate, {
    evaluator: deps.evaluator,
    soul: deps.evalCtx.soul,
    receipt: gate.receipt,
    now: () => new Date().toISOString(),
  });
  att('evaluation', {
    candidateId: candidate.id,
    evaluationId: gate.receipt.id,
    observation: {
      summary: `evidence=${evaluation.evaluation.evidence} applicability=${evaluation.evaluation.applicability}`,
    },
  });
  const result = activateLocal(local, candidate, evaluation, gate.receipt, {
    receiptId: gate.receipt.id,
  });
  att('promotion', { candidateId: candidate.id, subject: candidate.subject });
  // PRD line 359: compact successful attempts immediately — collapse the trail to one summary.
  const compaction = buildAttemptEvent({
    id: attemptEventId({
      attemptId,
      phase: 'compaction',
      subject: candidate.subject,
      observation: {
        summary: `promoted ${result.recordId} to local via gate ${profileName}`,
        fileRefs: candidate.appliesTo,
        receiptIds: [gate.receipt.id, result.receiptId],
      },
    }),
    attemptId,
    phase: 'compaction',
    ts: new Date().toISOString(),
    subject: candidate.subject,
    observation: {
      summary: `promoted ${result.recordId} to local via gate ${profileName}`,
      fileRefs: candidate.appliesTo,
      receiptIds: [gate.receipt.id, result.receiptId],
    },
  });
  compactAttempt(local, attemptId, compaction);
  process.stdout.write(
    `${JSON.stringify(
      {
        recordId: result.recordId,
        receiptId: result.receiptId,
        evidence: evaluation.evaluation.evidence,
        applicability: evaluation.evaluation.applicability,
        trust: 'local',
        cleanedUp: result.cleanedUp,
      },
      null,
      2,
    )}\n`,
  );
  return EXIT.OK;
}

/** `crib memory activate <candidate>` — crash-recovery against an existing receipt (no gate re-run). */
async function cmdMemoryActivate(args: string[], ctx?: CmdCtx): Promise<number> {
  const id = pathArg(args);
  if (!id) {
    process.stderr.write('usage: crib memory activate <candidate-id>\n');
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const local = deps.local;
  const candidate = findCandidate(local, id);
  if (!candidate) {
    process.stderr.write(`error: no local candidate '${id}' to activate\n`);
    return EXIT.ERROR;
  }
  // Find a receipt matching the current worktree state (the gate that already ran but whose
  // activation crashed before cleanup). PRD line 348: the next run dedupes + completes cleanup.
  const head = currentHead(resolved.repoRoot);
  const digest = worktreeDigest(resolved.repoRoot);
  let receipt: GateReceipt | undefined;
  for (const e of local.readCollection('receipts').entries) {
    const r = e as GateReceipt;
    if (r.head === head && r.worktreeDigest === digest) {
      receipt = r;
      break;
    }
  }
  if (!receipt) {
    process.stderr.write(
      `error: no local receipt matching HEAD ${head.slice(0, 12)} + worktree digest — run \`crib memory evaluate\` first\n`,
    );
    return EXIT.ERROR;
  }
  const evaluation = evaluateCandidate(candidate, {
    evaluator: deps.evaluator,
    soul: deps.evalCtx.soul,
    receipt,
    now: () => new Date().toISOString(),
  });
  const result = activateLocal(local, candidate, evaluation, receipt, { receiptId: receipt.id });
  process.stdout.write(
    `${JSON.stringify(
      {
        recordId: result.recordId,
        receiptId: result.receiptId,
        evidence: evaluation.evaluation.evidence,
        applicability: evaluation.evaluation.applicability,
        trust: 'local',
        cleanedUp: result.cleanedUp,
      },
      null,
      2,
    )}\n`,
  );
  return EXIT.OK;
}

/** `crib memory propose <memory-id>` — write a team record + accept decision (PRD line 257). */
function cmdMemoryPropose(args: string[], ctx?: CmdCtx): number {
  const id = pathArg(args);
  if (!id) {
    process.stderr.write('usage: crib memory propose <memory-id>\n');
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveRoot(args, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const record = findActiveRecord(deps.local, id);
  if (!record) {
    process.stderr.write(`error: no activated local record '${id}' — evaluate/activate first\n`);
    return EXIT.ERROR;
  }
  const receiptId = record.meta?.receiptId;
  if (typeof receiptId !== 'string') {
    process.stderr.write(
      `error: record '${id}' has no gating receipt on its meta — re-run \`crib memory evaluate\`\n`,
    );
    return EXIT.ERROR;
  }
  const receipt = findReceipt(deps.local, receiptId);
  if (!receipt) {
    process.stderr.write(`error: gating receipt '${receiptId}' not in local receipts\n`);
    return EXIT.ERROR;
  }
  try {
    const result = proposeExisting(deps.team, record, receipt, 'cli', () =>
      new Date().toISOString(),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          recordId: result.recordId,
          receiptId: result.receiptId,
          decisionId: result.decisionId,
          trust: 'team',
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  } catch (e) {
    process.stderr.write(`proposal refused: ${(e as Error).message}\n`);
    return EXIT.ERROR;
  }
}

/** `crib memory attest <candidate>` — TTY-only human attestation (PRD line 258). */
function cmdMemoryAttest(args: string[], ctx?: CmdCtx): number {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'error: crib memory attest is TTY-only — run it in an interactive terminal\n',
    );
    return EXIT.ERROR;
  }
  const id = pathArg(args);
  if (!id) {
    process.stderr.write('usage: crib memory attest <candidate-id>\n');
    return EXIT.BAD_ARGS;
  }
  const statementIdx = args.indexOf('--statement');
  const statement = statementIdx >= 0 ? args[statementIdx + 1] : undefined;
  if (typeof statement !== 'string' || statement.length === 0) {
    process.stderr.write('error: --statement <text> is required for a human attestation\n');
    return EXIT.BAD_ARGS;
  }
  const rootArgs = args.slice();
  if (statementIdx >= 0) rootArgs.splice(statementIdx, 2);
  const resolved = resolveRoot(rootArgs, ctx);
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const deps = createMemoryDeps(openSoul(resolved).soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const candidate = findCandidate(deps.local, id);
  if (!candidate) {
    process.stderr.write(`error: no local candidate '${id}' to attest\n`);
    return EXIT.ERROR;
  }
  // Append a human-attestation evidence item + re-stage the candidate. A human attestation alone is
  // NOT admissible for every claim kind (the evaluator decides), but it records the human sign-off.
  const attested: MemoryCandidate = {
    ...candidate,
    evidence: [
      ...candidate.evidence,
      {
        kind: 'human-attestation',
        verdict: 'valid',
        checkedAt: new Date().toISOString(),
        actor: process.env.USER ?? 'human',
        tty: true,
        statement,
      },
    ],
  };
  attested.id = memoryCandidateId(attested);
  deps.local.upsertEntry('candidates', attested);
  process.stdout.write(
    `${JSON.stringify({ id: attested.id, status: 'pending', attestedBy: attested.evidence[attested.evidence.length - 1]?.actor }, null, 2)}\n`,
  );
  return EXIT.OK;
}

// ─── W4 Slice 3 — trusted-ref derivation + CI check gate + audit/gc/migrate ──

/**
 * Build the {@link TrustedTeamPresence} for a trusted Git ref: which `mem:` record ids + which
 * accepted record ids (an `accept` decision whose subject is the record) are present in the ref's
 * `.crib/memory/team/**` shards (PRD line 279). Returns `undefined` when the ref does not resolve →
 * no trusted ref configured → committed memories remain pending. PURE over git plumbing: reads via
 * `ls-tree` + `git show <ref>:<path>` + the strict {@link parseMemoryShard} loader (no model, no shell).
 */
function buildTrustedPresence(repoRoot: string, ref: string): TrustedTeamPresence | undefined {
  if (!refExists(repoRoot, ref)) return undefined;
  const teamPrefix = '.crib/memory/team';
  const paths = lsTreeFiles(repoRoot, ref, teamPrefix);
  const recordIds = new Set<string>();
  const acceptedRecordIds = new Set<string>();
  for (const p of paths) {
    if (!p.endsWith('.jsonl')) continue;
    const blob = showFileAtRef(repoRoot, ref, p);
    if (blob === undefined) continue;
    const { entries } = parseMemoryShard(blob, `${ref}:${p}`);
    for (const e of entries) {
      const id = (e as { id?: string }).id;
      if (typeof id !== 'string') continue;
      if (id.startsWith('mem:')) recordIds.add(id);
      else if (id.startsWith('dec:')) {
        const kind = (e as { kind?: string }).kind;
        const subject = (e as { subject?: string }).subject;
        if (kind === 'accept' && typeof subject === 'string' && subject.startsWith('mem:')) {
          acceptedRecordIds.add(subject);
        }
      }
    }
  }
  return { recordIds, acceptedRecordIds };
}

/** Load the trusted-base policy at a git ref (merge-base or trusted ref), or undefined if absent. */
function loadPolicyAtRef(repoRoot: string, ref: string): MemoryPolicy | undefined {
  const blob = showFileAtRef(repoRoot, ref, '.crib/memory/policy.json');
  if (blob === undefined) return undefined;
  try {
    return loadPolicyJson(blob);
  } catch {
    return undefined; // corrupt policy at ref — treat as absent (the gate reports no merge-base policy)
  }
}

/** Gather every receipt the check might need (team + local), keyed by id. */
function gatherReceipts(
  deps: NonNullable<ReturnType<typeof createMemoryDeps>>,
): Map<string, GateReceipt> {
  const map = new Map<string, GateReceipt>();
  for (const e of deps.team.readCollection('receipts').entries) {
    const r = e as GateReceipt;
    if (typeof r.id === 'string') map.set(r.id, r);
  }
  for (const e of deps.local.readCollection('receipts').entries) {
    const r = e as GateReceipt;
    if (typeof r.id === 'string') map.set(r.id, r);
  }
  return map;
}

/**
 * `crib memory check` — the CI gate (PRD lines 275–280, 350). Loads policy from the MERGE BASE (never
 * the untrusted PR version), derives team trust from the trusted ref, and runs the pure {@link
 * runMemoryCheck}. Exit 0 if the gate passes, 1 on any violation (self-authoring, missing receipt,
 * refused invalid-evidence record). `--trusted-ref <ref>` / `KCRIB_TRUSTED_REF` override the default.
 */
function cmdMemoryCheck(args: string[], ctx?: CmdCtx): number {
  // `--trusted-ref <ref>` carries a value that must NOT be mistaken for a positional path by
  // resolveRoot/pathArg — strip it (and its value) before root resolution, then re-parse the override.
  const refIdx = args.indexOf('--trusted-ref');
  const override = refIdx >= 0 ? args[refIdx + 1] : undefined;
  const stripped = refIdx >= 0 ? args.filter((_, i) => i !== refIdx && i !== refIdx + 1) : args;
  const resolved = resolveRoot(stripped, ctx);
  if (!isGitRepo(resolved.repoRoot)) {
    process.stderr.write('error: crib memory check requires a git work tree\n');
    return EXIT.BAD_ARGS;
  }
  const prPolicy = loadPolicy(resolved.cribDir);
  const trustedRef =
    (typeof override === 'string' && override.length > 0 ? override : undefined) ??
    process.env.KCRIB_TRUSTED_REF ??
    trustedRefOf(prPolicy);
  const mbSha = mergeBase(resolved.repoRoot, 'HEAD', trustedRef);
  const mergeBasePolicy = mbSha ? loadPolicyAtRef(resolved.repoRoot, mbSha) : undefined;
  const presence = buildTrustedPresence(resolved.repoRoot, trustedRef);
  const deps = createMemoryDeps(openSoul(resolved).soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const records = deps.team.readCollection('records').entries as MemoryRecord[];
  const receipts = gatherReceipts(deps);
  const report = runMemoryCheck({
    mergeBasePolicy,
    prPolicy,
    presence,
    records,
    receipts,
  });
  const summary = {
    trustedRef,
    mergeBase: mbSha ?? null,
    mergeBasePolicyHash: report.mergeBasePolicyHash,
    prPolicyHash: report.prPolicyHash,
    policyChanged: report.policyChanged,
    withoutTrustedRef: report.withoutTrustedRef,
    checked: report.checked,
    alreadyTrusted: report.alreadyTrusted,
    newlyProposed: report.newlyProposed,
    refused: report.refused,
    selfAuthoringViolations: report.selfAuthoringViolations,
    missingReceipts: report.missingReceipts,
    ok: report.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (report.violations.length > 0) {
    process.stderr.write(`violations:\n${report.violations.map((v) => `  - ${v}`).join('\n')}\n`);
  }
  return report.ok ? EXIT.OK : EXIT.ERROR;
}

/** `crib memory audit [--repair-local]` — report validation drift, conflicts, and trust distribution. */
function cmdMemoryAudit(args: string[], ctx?: CmdCtx): number {
  const repair = args.includes('--repair-local');
  const resolved = resolveRoot(args, ctx);
  const deps = createMemoryDeps(openSoul(resolved).soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const stores: Array<{ name: string; store: MemoryStore }> = [
    { name: 'team', store: deps.team },
    { name: 'local', store: deps.local },
    { name: 'global', store: deps.global },
  ];
  let totalEntries = 0;
  let invalid = 0;
  const perStore: Array<{ store: string; entries: number; invalid: number; errors: string[] }> = [];
  for (const { name, store } of stores) {
    let sEntries = 0;
    let sInvalid = 0;
    const errors: string[] = [];
    for (const c of store.collections) {
      const { entries, errors: shardErrors } = store.readCollection(c);
      sEntries += entries.length;
      errors.push(...shardErrors);
      for (const e of entries) {
        try {
          assertValidMemoryEntry(e as unknown as { id: string } & Record<string, unknown>);
        } catch (err) {
          sInvalid++;
          errors.push(`${(e as { id?: string }).id ?? '<no-id>'}: ${(err as Error).message}`);
        }
      }
    }
    totalEntries += sEntries;
    invalid += sInvalid;
    perStore.push({ store: name, entries: sEntries, invalid: sInvalid, errors });
  }
  // conflicts over team records (same subject, different claims)
  const teamRecords = deps.team.readCollection('records').entries as MemoryRecord[];
  const subjects = new Map<string, number>();
  for (const r of teamRecords) subjects.set(r.subject, (subjects.get(r.subject) ?? 0) + 1);
  const conflicts = [...subjects.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  // trust distribution
  const trust: Record<string, number> = {};
  for (const r of teamRecords) trust[r.verdicts.trust] = (trust[r.verdicts.trust] ?? 0) + 1;
  let repaired = false;
  if (repair) {
    // recompute the local manifest counts from shards (the conservative repair — no data is deleted)
    deps.local.persistManifest();
    repaired = true;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        totalEntries,
        invalid,
        conflicts,
        trust,
        perStore,
        ...(repair ? { repaired } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return invalid === 0 ? EXIT.OK : EXIT.ERROR;
}

/** `crib memory gc [--max-age-days N] [--dry-run]` — drop unpromoted local candidates older than N days. */
function cmdMemoryGc(args: string[], ctx?: CmdCtx): number {
  const dryRun = args.includes('--dry-run');
  const daysIdx = args.indexOf('--max-age-days');
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write('error: --max-age-days must be a positive number\n');
    return EXIT.BAD_ARGS;
  }
  // strip the value-taking flag so pathArg/resolveRoot don't mistake `N` for a positional path
  const stripped = daysIdx >= 0 ? args.filter((_, i) => i !== daysIdx && i !== daysIdx + 1) : args;
  const resolved = resolveRoot(stripped, ctx);
  const deps = createMemoryDeps(openSoul(resolved).soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const activeIds = new Set(
    (deps.local.readCollection('active').entries as MemoryRecord[]).map((r) => r.id),
  );
  const now = Date.now();
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const candidates = deps.local.readCollection('candidates').entries as MemoryCandidate[];
  const toRemove: string[] = [];
  for (const c of candidates) {
    // never GC a candidate whose record was promoted to local active
    if (activeIds.has(c.id.replace(/^cand:/, 'mem:'))) continue;
    const proposed = Date.parse(c.proposedAt);
    if (Number.isNaN(proposed)) continue;
    if (now - proposed > maxAgeMs) toRemove.push(c.id);
  }
  // W5 (PRD line 359): also reap unpromoted attempt trails older than the same cutoff. A failed
  // attempt that never promoted is non-reusable; its crash trail + candidate are GC'd after 30d by
  // default. Promoted attempts are kept (their compaction summary is a reusable success). The now
  // passed to gcUnpromotedAttempts is an ISO string (the store compares lexicographic ISO ts).
  const attemptNow = new Date().toISOString();
  const attemptGc = dryRun
    ? { reapedAttempts: [] as string[], removedCandidateIds: [] as string[] }
    : gcUnpromotedAttempts(deps.local, maxAgeMs, attemptNow);
  if (!dryRun) {
    for (const id of toRemove) deps.local.removeEntry('candidates', id);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        maxAgeDays: days,
        dryRun,
        candidatesScanned: candidates.length,
        removed: toRemove.length,
        ids: toRemove,
        attemptsReaped: attemptGc.reapedAttempts.length,
        attemptIds: attemptGc.reapedAttempts,
        attemptCandidateIdsRemoved: attemptGc.removedCandidateIds,
      },
      null,
      2,
    )}\n`,
  );
  // team records/decisions are NEVER garbage-collected (PRD line 358) — this command only touches local.
  return EXIT.OK;
}

/** `crib memory migrate` — re-validate every stored entry through the migration chain + recompute manifests. */
function cmdMemoryMigrate(args: string[], ctx?: CmdCtx): number {
  const resolved = resolveRoot(args, ctx);
  const deps = createMemoryDeps(openSoul(resolved).soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const stores: Array<{ name: string; store: MemoryStore }> = [
    { name: 'team', store: deps.team },
    { name: 'local', store: deps.local },
    { name: 'global', store: deps.global },
  ];
  const perStore: Array<{ store: string; entries: number; invalid: number }> = [];
  let totalInvalid = 0;
  for (const { name, store } of stores) {
    let entries = 0;
    let invalid = 0;
    for (const c of store.collections) {
      const res = store.readCollection(c);
      entries += res.entries.length;
      for (const e of res.entries) {
        try {
          assertValidMemoryEntry(e as unknown as { id: string } & Record<string, unknown>); // migrate-up-then-validate
        } catch {
          invalid++;
        }
      }
    }
    // recompute the manifest counts from the (migrated) shards
    store.persistManifest();
    totalInvalid += invalid;
    perStore.push({ store: name, entries, invalid });
  }
  process.stdout.write(
    `${JSON.stringify({ perStore, totalInvalid, schemaVersion: '1' }, null, 2)}\n`,
  );
  return totalInvalid === 0 ? EXIT.OK : EXIT.ERROR;
}

function printHelp(): void {
  process.stdout.write(
    [
      'crib — Knowledge-crib CLI',
      '',
      'Usage:',
      '  crib index [path] [--semantic] [--exclude a,b,...] [--package <name|all>...]     full index → .crib soul + derived index (+ INFERRED embedding-cosine semantic links); --package scopes to one monorepo package (list detected with no --package)',
      '  crib status [path] [--dirty]             health + stats; --dirty previews files that would be re-indexed',
      '  crib query <text>                        BM25 search over code + docs (incl. bodies); --with-source --with-rules fold body + decision table into each hit',
      '  crib gaps [path] [--extracted-only] [--include-builtins]   analysis readiness + missing bodies + unresolved call sites',
      '  crib rules <proc> [--include-tables]      decision table + coverage readiness for a callable',
      '  crib context <id> [--with-source] [--with-rules] [--with-framework]   deep per-symbol context',
      '  crib context --package <pkg> [--format markdown] [--max-symbols N]   bulk dossiers for every symbol in a scope (also --file / --cluster)',
      '  crib ask "<question>" [--format markdown] [--limit N] [--with-source] [--with-rules] [--with-framework]   natural-language answer from the crib (deterministic)',
      '  crib dossier <id> [--format markdown]    persisted deep artifact (body + callers/callees + rules + CFG constructs)',
      '  crib reconstruct <pkg> [--format markdown]   package reconstruction: CONSTANT values + members + referenced tables + docs + expectedBodyFile',
      '  crib impact <id> --dir up|down [--depth N] [--include-llm]   blast radius',
      '  crib path <from> <to> [--max-hops N] [--include-llm]   shortest path',
      '  crib neighbors <id> [--rel reads] [--dir in|out|both] [--include-llm]   adjacency',
      '  crib serve [path]                        run the MCP server on stdio (resolves root: arg/--cwd/KCRIB_ROOT/CLAUDE_PROJECT_DIR/walk/cwd)',
      '  crib update [path] [--since <sha>] [--dirty] [--package <name>]  incremental re-extract since the VCS anchor; --dirty includes working-tree changes without advancing vcsHead; --package scopes to one package of a monorepo without advancing the shared anchor if other packages changed too',
      '  crib reindex [path] [--package <name|all>...]     full re-index (alias for `crib index`; --package scopes to one monorepo package)',
      '  crib migrate-graph [path] [--dry-run]     move legacy nodes/edges/llm into canonical .crib/graph',
      '  crib materialize [path]                   build derived composite graph.json + sqlite',
      '  crib merge-driver %O %A %B %P            git custom merge driver for .crib chunks',
      '  crib install-hooks [path]                wire post-commit + .gitattributes + merge driver',
      '  crib export [--format F] [--procedure P] [--extracted-only] [--redact|--no-redact] render graph: rules|mermaid|graph.json|report|llm',
      '  crib viz [path] [--port N]               serve the offline web UI (Claude Design DC graph) + open browser',
      '  crib enrich [path] [--budget-tokens N]    semantic work queue; --next (token-packed batch) | --auto [--max-tokens N --max-batches N] | --save <file> | --overview | --scopes | --prune-stale [--apply]',
      '  crib memory <init|evaluate|activate|propose|attest>   trusted agent-memory promotion: init policy | evaluate <cand> --profile <name> | activate <cand> | propose <mem-id> | attest <cand> (TTY)',
      '  crib audit-llm [path]                    re-verify every LLM artifact against the soul (grounding moat); exits non-zero on ungrounded/drift',
      '  crib mcp <install|list|remove> [--ide <claude|cursor|vscode|codex|all>] [--global] [--bin <path>] [path]',
      '                                          auto-wire the MCP server into each IDE config (REQ-2)',
      '  crib skill <install|list> [name] [--dest <dir>]   install bundled skills (default ~/.claude/skills; Codex: --dest ~/.codex/skills)',
      '  crib init [path] [--ide <name|all>]      5-minute onboarding: index + install-hooks + mcp install + next-steps hero',
      '  crib doctor [path]                       setup health check: node/corepack/index-freshness/hooks/IDE-wiring (✓/✗ + fix hints)',
      '',
      'Global: --cwd <path>   override the project root for any command',
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2))
  // Do not force process.exit here. Large graph/report exports write through a pipe; forcing exit
  // discards buffered stdout (commonly at 64 KiB) before Node drains it. exitCode preserves the
  // command result while letting stdio flush naturally.
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = EXIT.ERROR;
  });
