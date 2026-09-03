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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface as createReadline } from 'node:readline';
import {
  CALLABLE_SYMBOL_TYPES,
  type EmbedManifest,
  LockBusyError,
  MANIFEST_FILE,
  REMOTE_EMBED_POLICY_TEXT,
  REMOTE_EMBED_POLICY_VERSION,
  type RemoteEmbedPolicy,
  SoulStore,
  WorkingOverlay,
  embedHomeDir,
  embedManifestPath,
  embedTierReport,
  graphPaths,
  hasLegacyGraph,
  installEmbedModel,
  materializeComposite,
  migrateLegacyGraph,
  newManifest,
  pathFromId,
  remotePolicyPath,
  validateClusterIntegrity,
  withCribLockAsync,
} from '@knowledge-crib/core';
import type { IndexStore } from '@knowledge-crib/core';
import {
  EnrichmentStore,
  Verbs,
  capInt,
  capMaxTokens,
  estimateTokens,
  fitTokenBudget,
  serveHttp,
  serveStdio,
} from '@knowledge-crib/mcp';
import type {
  EnrichLayer,
  EnrichNextBatch,
  EnrichSaveItem,
  EnrichScope,
  EnrichWorkItem,
  VcsAdapter,
} from '@knowledge-crib/mcp';
import {
  type AttemptOutcome,
  type AttemptPhase,
  BENCH_SCALE_DEFAULT,
  BENCH_SCALE_FAST,
  type CaptureOutboxEntry,
  type ConflictGroup,
  type DistillVerifyContext,
  type GateReceipt,
  MemoryApi,
  type MemoryCandidate,
  type MemoryDecision,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryFeedback,
  MemoryFtsIndex,
  type MemoryPolicy,
  type MemoryRecord,
  type MemoryRecordKind,
  type MemoryRecordV2,
  type MemorySource,
  MemoryStore,
  type RecallProjection,
  type RecallProvenance,
  type RecallScore,
  type RecordBelief,
  type ScoredRecord,
  type SearchHit,
  type SearchResponse,
  SoulStoreAnchorPort,
  SoulStoreSoulPort,
  type StructuredSummary,
  type SupersedePayload,
  type TrustedTeamPresence,
  UNVERSIONED,
  type VerifiedDistillDecision,
  VersionedLexicalScorer,
  activateLocal,
  appendAttemptEvent,
  applyContradictedFeedback,
  applyVerifiedDecision,
  assertValidMemoryEntry,
  attemptEventId,
  attemptGroupId,
  bindEvaluationPass,
  bridgedDecisions,
  buildAliasIndex,
  buildAttemptEvent,
  buildDistillWorkItem,
  compactAttempt,
  conservativeVerdicts,
  contradictedForReview,
  decisionId,
  distillBatchId,
  effectiveVerdicts,
  entrySetFingerprint,
  evaluateCandidate,
  failDistillItem,
  fingerprintGenerations,
  formatBenchReport,
  gatherRecall,
  gcUnpromotedAttempts,
  isFeedbackSignal,
  isMemoryRecordV2,
  isTeamTrustedRecord,
  loadPolicy,
  loadPolicyJson,
  localRecordsToTombstone,
  localStoreRoot,
  memoryCandidateId,
  openMemoryFts,
  parseMemoryShard,
  pendingCaptures,
  policyHash,
  proposeExisting,
  quarantinedRecordIds,
  readRepoId,
  recallProjection,
  resolveProfile,
  runGate,
  runMemoryBench,
  runMemoryCheck,
  sameSubjectRecords,
  tombstoneLocalForTeamPromotion,
  trustedRefOf,
  verifyDistillDecision,
  verifySnapshot,
} from '@knowledge-crib/memory';
import { writeJsonAtomic } from '@knowledge-crib/memory';
import {
  changedFilesSince,
  currentHead,
  detectWorkspace,
  indexRepo,
  isGitRepo,
  lsTreeFiles,
  mergeBase,
  prepareSourceInput,
  refExists,
  renderExport,
  resolvePackageArg,
  runCluster,
  showFileAtRef,
  uncommittedChanges,
  updateRepo,
} from '@knowledge-crib/pipeline';
import { DEFAULT_IGNORES } from '@knowledge-crib/pipeline';
import type {
  IndexReport,
  MuleReport,
  PreparedSourceInput,
  WorkspaceLayout,
} from '@knowledge-crib/pipeline';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { buildVizGraph, buildVizOverview, vizAssetsDir } from '@knowledge-crib/ui';
import {
  ALL_CLIENTS,
  type ClientId,
  LIFECYCLE_EVENTS,
  type LifecycleEvent,
  captureLaneSummary,
  clientAdapter,
  installCaptureHooks,
  installInstructions,
  listCaptureHooks,
  listInstructions,
  removeCaptureHooks,
  removeInstructions,
} from './adapters.js';
import {
  type ProviderDef,
  ProviderItemError,
  resolveProvider,
  runProviderBatch,
} from './enrich-provider.js';
import {
  FRESHNESS_MODES,
  type FreshnessMode,
  type FreshnessTask,
  WorkerAlreadyRunningError,
  freshnessStatus,
  parseFreshnessMode,
  postCommitFreshness,
  runFreshnessWorker,
  setFreshnessMode,
} from './freshness.js';
import {
  convertBlockingPostCommit,
  detectLegacyBlockingPostCommit,
  hooksInstalled,
  installHooks,
  mergeDriverFiles,
} from './hooks.js';
import { type McpIde, type McpScope, installMcp, listMcp, removeMcp } from './mcp-install.js';
import { registerProject } from './registry.js';
import {
  type ResolvedRoot,
  buildIndex,
  isIndexedRoot,
  openIndexForServe,
  openIndexOnly,
  openSoul,
  resolveProjectRoot,
} from './runtime.js';
import { installSkill, listBundledSkills } from './skill-install.js';
import { VizHttpError, isAllowedHost, readVizNodeSource, resolveVizAsset } from './viz-server.js';
import { WatchMode } from './watch.js';

const EXIT = { OK: 0, ERROR: 1, BAD_ARGS: 2, NOT_INDEXED: 3, LOCKED: 4 } as const;

class CliUsageError extends Error {}

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
  '--crib-dir',
  '--sources',
  '--target',
  '--max-tokens',
  // Gate 1.3 memory subcommands (`crib memory get|supersede|delete|history`): their positionals are
  // an id / a key, so every value-taking flag they add must be stripped alongside its value.
  '--actor',
  '--successor',
  '--claim',
  '--subject',
  '--kind',
  '--visibility',
  '--proposition-key',
  '--reason',
  '--tool',
  '--as-of',
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
  return positionalsOf(args)[0];
}

/** Resolve a path through existing symlink ancestors, including a new leaf. */
function canonicalizePotentialPath(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}

/** Resolve an optional external crib directory while keeping it separate from the source work tree. */
function resolveCribDir(args: string[], resolvedRoot: ResolvedRoot | string): string {
  const repoRoot = typeof resolvedRoot === 'string' ? resolvedRoot : resolvedRoot.repoRoot;
  const idx = args.indexOf('--crib-dir');
  // `resolveProjectRoot` applies the per-user registry overlay. Do not erase a
  // registered external directory merely because this command omits the flag.
  if (idx < 0)
    return typeof resolvedRoot === 'string' ? join(repoRoot, '.crib') : resolvedRoot.cribDir;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) {
    throw new CliUsageError('--crib-dir requires an absolute path');
  }
  if (!isAbsolute(value)) {
    throw new CliUsageError('--crib-dir must be an absolute path');
  }
  const cribDir = canonicalizePotentialPath(value);
  const gitDir = canonicalizePotentialPath(join(repoRoot, '.git'));
  const fromGitDir = relative(gitDir, cribDir);
  if (
    fromGitDir === '' ||
    (!fromGitDir.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      fromGitDir !== '..' &&
      !isAbsolute(fromGitDir))
  ) {
    throw new CliUsageError('--crib-dir must not be inside the source root .git directory');
  }
  return cribDir;
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
  const resolved = resolveProjectRoot({ explicitRoot });
  return { ...resolved, cribDir: resolveCribDir(args, resolved) };
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
    case 'embed':
      return cmdEmbed(rest, ctx);
    case 'freshness':
      return cmdFreshness(rest, ctx);
    case 'audit-llm':
      return cmdAuditLlm(rest, ctx);
    case 'mcp':
      return cmdMcp(rest, ctx);
    case 'skill':
      return cmdSkill(rest);
    case 'adapters':
      return cmdAdapters(rest, ctx);
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

/**
 * Register the just-indexed project in `~/.crib/registry.json` (REQ-1). Idempotent. `projectKey` is
 * the registry key — the directory path for a folder input, or the `.zip`/`.jar` path for an archive.
 * `source` carries the archive identity (extracted `sourceRoot` + original path + fingerprint) when
 * the index ran from a prepared archive; directories omit it so the entry is a plain directory record.
 */
function registerIndexed(
  projectKey: string,
  cribDir: string,
  soul: SoulStore,
  source?: { sourceRoot?: string; sourceArchive?: string; sourceFingerprint?: string },
): void {
  const m = soul.getManifest();
  registerProject(projectKey, {
    repoId: m.repo.id,
    cribDir,
    ...(m.repo.vcsHead !== undefined ? { vcsHead: m.repo.vcsHead } : {}),
    ...(source?.sourceRoot !== undefined ? { sourceRoot: source.sourceRoot } : {}),
    ...(source?.sourceArchive !== undefined
      ? { sourceArchive: source.sourceArchive, sourceFingerprint: source.sourceFingerprint }
      : {}),
  });
}

/** True if `path` exists and is a regular file (an archive input), false for dirs / missing. */
function isFileInput(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Prepare the source tree an index/reindex will `discover()` against. Directories are a passthrough
 * (`sourceRoot` = the directory, `cribDir` = the resolved overlay); archives are extracted once into
 * the `~/.crib/imports` cache (or hit the cache by fingerprint) and return the cache `sourceRoot` +
 * per-archive `cribDir`. The `--crib-dir` flag is honored for both; for archives without it the cache
 * default is used so a `.crib` is never created next to the archive. Returns the prepared input plus
 * the registry source fields to stamp on success (omitted for directory passthroughs).
 */
async function prepareSourceForIndex(
  resolved: ResolvedRoot,
  args: string[],
): Promise<{
  prepared: PreparedSourceInput;
  source: { sourceRoot?: string; sourceArchive?: string; sourceFingerprint?: string };
}> {
  const archive = resolved.sourceArchive !== undefined || isFileInput(resolved.projectKey);
  const hasCribDirFlag = args.includes('--crib-dir');
  const opts = archive
    ? hasCribDirFlag
      ? { cribDir: resolved.cribDir }
      : {}
    : { cribDir: resolved.cribDir };
  const prepared = await prepareSourceInput(resolved.projectKey, opts);
  const source =
    prepared.archivePath !== undefined
      ? {
          sourceRoot: prepared.sourceRoot,
          sourceArchive: prepared.archivePath,
          sourceFingerprint: prepared.fingerprint,
        }
      : {};
  return { prepared, source };
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

/** MuleSoft summary emitted by `crib index` (human line + the `mulesoft` key of `--json`). The
 *  project/dialect/diagnostics fields come from the pipeline's structure pre-pass
 *  ({@link MuleReport}); the topology counts are derived in-process from the committed soul with
 *  the same predicates the local acceptance gate (`scripts/check-mule-sample.mjs`) uses, so the
 *  summary and the gate agree. */
interface MuleIndexSummary {
  projects: number;
  dialectFiles: { mule3: number; mule4: number };
  flows: number;
  subflows: number;
  /** Message sources + RAML API operations (all `route`-kind nodes). */
  routes: number;
  flowRefs: number;
  transforms: number;
  munitTests: number;
  /** Distinct unresolved flow-ref targets (`external-flow` placeholder nodes). */
  externalTargets: number;
  /** `resolved` = flowRefs − externalTargets (each unresolved target counts as one unresolved
   *  flow-ref; an approximation when several flow-refs share one missing target). */
  references: { resolved: number; unresolved: number };
  /** Mule diagnostics by severity (classification-time + parse-time `mule:*` codes). */
  diagnostics: { warnings: number; errors: number };
}

/** Derive the {@link MuleIndexSummary} from the pipeline report + the committed soul. One pass
 *  over `soul.iterate()`; pure (no mutation). Only called when `report.mule` is present. */
function summarizeMule(report: IndexReport, soul: SoulStore): MuleIndexSummary {
  const mule = report.mule as MuleReport;
  let flows = 0;
  let subflows = 0;
  let routes = 0;
  let flowRefs = 0;
  let transforms = 0;
  let munitTests = 0;
  let externalTargets = 0;
  for (const n of soul.iterate()) {
    // `type` lives on flow/subflow/test/module nodes; `kind` on statement/route/http-call/...
    const t = n.type;
    const k = n.kind;
    if (t === 'flow') flows++;
    else if (t === 'subflow') subflows++;
    else if (t === 'test') munitTests++;
    else if (t === 'external-flow') externalTargets++;
    else if (k === 'route') routes++;
    else if (k === 'statement') {
      const sk = n.meta?.semanticKind;
      if (sk === 'flow-ref') flowRefs++;
      else if (sk === 'transform') transforms++;
    }
  }
  // Diagnostics: classification-time (report.mule.diagnostics) + parse-time mule:* codes.
  let warnings = 0;
  let errors = 0;
  for (const d of mule.diagnostics) {
    if (d.severity === 'warning') warnings++;
    else if (d.severity === 'error') errors++;
  }
  for (const d of report.parse.diagnostics) {
    if (!d.code.startsWith('mule:')) continue;
    if (d.severity === 'warning') warnings++;
    else if (d.severity === 'error') errors++;
  }
  return {
    projects: mule.projects,
    dialectFiles: mule.dialectFiles,
    flows,
    subflows,
    routes,
    flowRefs,
    transforms,
    munitTests,
    externalTargets,
    references: { resolved: Math.max(0, flowRefs - externalTargets), unresolved: externalTargets },
    diagnostics: { warnings, errors },
  };
}

/** One-line Mule summary for the human index line (appended after the nodes/edges count). */
function renderMuleLine(s: MuleIndexSummary): string {
  const dialect = [
    s.dialectFiles.mule3 ? `mule3: ${s.dialectFiles.mule3}` : '',
    s.dialectFiles.mule4 ? `mule4: ${s.dialectFiles.mule4}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const parts = [
    `${s.projects} ${s.projects === 1 ? 'project' : 'projects'}`,
    dialect ? `(${dialect})` : '',
    `${s.flows} flows`,
    `${s.subflows} subflows`,
    `${s.routes} routes`,
    `${s.flowRefs} flow-refs`,
    `${s.transforms} transforms`,
    `${s.munitTests} munit tests`,
    `${s.references.unresolved} unresolved`,
  ].filter(Boolean);
  return `mule: ${parts.join(', ')}`;
}

async function cmdIndex(args: string[], ctx?: CmdCtx): Promise<number> {
  // An explicit source path remains the source authority. `resolveRoot` also
  // preserves a registered external cribDir when this is an update fallback.
  const resolved = resolveRoot(args, ctx);
  // Normalize the input: directories pass through; archives (zip/jar) extract once into the
  // ~/.crib/imports cache and index the extracted tree. `prepared.sourceRoot` is the tree
  // discovery runs against; `prepared.cribDir` is where the soul lives (cache dir for archives).
  const { prepared, source } = await prepareSourceForIndex(resolved, args);
  const repoRoot = prepared.sourceRoot;
  const cribDir = prepared.cribDir;
  const projectKey = resolved.projectKey;
  const semantic = args.includes('--semantic');
  const json = args.includes('--json');
  const ignores = parseExcludes(args);
  const scope = resolvePackageScope(repoRoot, args);
  if (scope.status !== EXIT.OK) return scope.status;
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
    registerIndexed(projectKey, cribDir, soul, source);
    const stats = soul.getManifest().stats;
    const scopeSuffix = scope.packageRoots ? ` [scoped: ${scope.indexedPackages.join(', ')}]` : '';
    // Mule summary (only when a Mule project was classified). `--json` emits the full report with a
    // `mulesoft` key and no other top-level changes; the default human line appends a one-line Mule
    // segment after the node/edge counts. Index success never depends on the Mule warning count.
    const muleSummary = report.mule ? summarizeMule(report, soul) : undefined;
    if (json) {
      const out: Record<string, unknown> = { ...report, mulesoft: muleSummary ?? null };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      const muleSeg = muleSummary ? ` · ${renderMuleLine(muleSummary)}` : '';
      process.stdout.write(
        `indexed ${report.files} files → ${stats.nodes} nodes, ${stats.edges} edges ` +
          `(${report.link.describes} describes, ${report.link.references} references)${scopeSuffix}${muleSeg} in ${Date.now() - started}ms\n`,
      );
      printTokenSavingsHero(new Verbs({ soul, index, repoRoot }), soul, repoRoot);
      printLlmPending(soul, repoRoot);
    }
    index.close();
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
  const statusJson = verbs.status({ dirty }) as Record<string, unknown>;
  // G3.4 — additive freshness block (mode, worker lease, in-flight, queue depth, behind-HEAD).
  // Best-effort: a status call on a half-initialized project must never crash; the status verb's
  // own shape is untouched so existing consumers see only a new key.
  try {
    statusJson.freshness = freshnessStatus(resolved.repoRoot);
  } catch (err) {
    statusJson.freshness = { error: (err as Error).message };
  }
  process.stdout.write(`${JSON.stringify(statusJson, null, 2)}\n`);
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
 * Open the derived index for `crib serve`, self-healing so the MCP stdio transport never drops on a
 * stale/missing derived index (the `MCP error -32000: Connection closed` failure mode).
 *
 *   - fresh OR stale-but-present → open and serve (stale → logged warning via openIndexForServe).
 *   - missing → rebuild from the committed soul under the writer lock (self-heal); re-check inside
 *     the lock so two concurrent serves don't both rebuild. If the lock is busy (another writer —
 *     likely a concurrent rebuild or `crib update`), wait briefly and retry once before giving up.
 *
 * Returns the opened index, or null only if the index truly cannot be opened or built.
 */
async function openServeIndex(
  resolved: ResolvedRoot,
  rt: ReturnType<typeof openSoul>,
): Promise<IndexStore | null> {
  try {
    return openIndexForServe(rt);
  } catch {
    // missing or unreadable → self-heal below
  }
  let index: IndexStore | null = null;
  const r = await runLocked(resolved.cribDir, async () => {
    try {
      // Another concurrent serve may have just rebuilt it under the lock — don't rebuild twice.
      index = openIndexForServe(rt);
      return EXIT.OK;
    } catch {
      process.stderr.write('derived index missing — rebuilding from soul before serving\n');
      index = buildIndex(rt);
      // Preserve the archive source identity (sourceRoot/sourceArchive/fingerprint) on a serve
      // self-heal: a plain registerIndexed with no `source` would drop those fields and the next
      // `crib update <archive>` would mis-resolve as a directory. `resolved` carries them from the
      // registry overlay, so forward them; directories have no sourceArchive and are unaffected.
      registerIndexed(
        resolved.projectKey,
        resolved.cribDir,
        rt.soul,
        resolved.sourceArchive !== undefined
          ? {
              sourceRoot: resolved.repoRoot,
              sourceArchive: resolved.sourceArchive,
              ...(resolved.sourceFingerprint !== undefined
                ? { sourceFingerprint: resolved.sourceFingerprint }
                : {}),
            }
          : undefined,
      );
      return EXIT.OK;
    }
  });
  if (r === EXIT.LOCKED) {
    // A concurrent writer holds the lock (likely another serve rebuilding, or a `crib update`).
    // Wait for it to finish, then retry the open — the freshly-built index should now be on disk.
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    try {
      index = openIndexForServe(rt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`index unavailable after rebuild wait: ${msg}\n`);
      index = null;
    }
  }
  return index;
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
  // Ownership is git-blame backed; an archive input has no work tree to blame.
  const resolved = resolveRoot(args, ctx);
  if (resolved.sourceArchive !== undefined) {
    process.stderr.write('ownership requires a git work tree; not supported for archive inputs\n');
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
  // `--watch` observes a live work tree for edits; an archive input has nothing to watch.
  if (resolved.sourceArchive !== undefined && args.includes('--watch')) {
    process.stderr.write('watch is not supported for archive inputs (no work tree to observe)\n');
    return EXIT.BAD_ARGS;
  }
  const rt = openSoul(resolved);
  // The MCP server must NEVER drop the stdio pipe on a stale/missing derived index — that is the
  // `MCP error -32000: Connection closed` failure: the serve process exits and the IDE transport
  // dies. Stale-but-present → serve it with a warning (openIndexForServe). Missing → self-heal by
  // rebuilding from the committed soul under the writer lock (so two concurrent serves don't race
  // the rebuild); re-check inside the lock in case another serve just rebuilt it.
  const index = await openServeIndex(resolved, rt);
  if (!index) return EXIT.NOT_INDEXED;
  const memory = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  // W6 — `crib serve --watch` installs an always-fresh working overlay: an ephemeral in-memory soul
  // that mirrors the committed graph + swaps in re-parsed records for dirty/untracked files. Edits
  // become queryable through the composite read model without dirtying `.crib/graph`. The overlay is
  // never committed (SoulStore.commit() is a no-op when ephemeral), so the committed soul is safe.
  let watch: WatchMode | undefined;
  let overlay: WorkingOverlay | undefined;
  if (args.includes('--watch')) {
    overlay = new WorkingOverlay(rt.soul);
    watch = new WatchMode(rt.soul, overlay, resolved.repoRoot, {
      onRefresh: (result, reason) => {
        if (result.dirty.length === 0) return;
        process.stderr.write(
          `watch [${reason}] refreshed ${result.dirty.length} file(s) [scope ${result.scope.length}] → ` +
            `+${result.parse.nodes} nodes +${result.parse.edges} edges, +${result.resolve.calls} calls\n`,
        );
      },
      onDrift: () => {
        process.stderr.write(
          'watch: canonical soul advanced (external crib update) — overlay resynced\n',
        );
      },
      onWarn: (msg) => process.stderr.write(`watch: ${msg}\n`),
    });
    await watch.start();
    process.stderr.write(
      `watch mode active — ${overlay.dirty.length} dirty file(s) overlaid; committed .crib/graph untouched\n`,
    );
  }
  const verbs = new Verbs({
    soul: rt.soul,
    index,
    repoRoot: resolved.repoRoot,
    vcs: new CliVcsAdapter(),
    ...(memory ? { memory } : {}),
    ...(overlay ? { workingOverlay: overlay.store } : {}),
  });
  // stdout is the MCP transport; logs go to stderr only.
  const stats = rt.soul.getManifest().stats;

  // Shared-daemon mode: one process holds the graph and many agents connect over HTTP. Each stdio
  // server costs 213 MB and ~450ms of startup, so a swarm running one per agent would need ~83 GB
  // just to hold 400 identical copies of the same graph. `--http` makes that one copy.
  const httpFlag = args.includes('--http');
  if (httpFlag) {
    const portArg = args[args.indexOf('--port') + 1];
    const port = args.includes('--port') ? Number.parseInt(portArg ?? '', 10) : 0;
    if (args.includes('--port') && !Number.isInteger(port)) {
      process.stderr.write('--port needs an integer\n');
      return EXIT.BAD_ARGS;
    }
    const daemon = await serveHttp(verbs, { ...(port ? { port } : {}) });
    process.stderr.write(
      `knowledge-crib MCP daemon on http://127.0.0.1:${daemon.port} — ${stats.nodes} nodes, ${stats.edges} edges ready (shared by every connected agent)\n`,
    );
    try {
      await new Promise<void>((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
      });
    } finally {
      await daemon.close();
      watch?.stop();
    }
    return EXIT.OK;
  }

  process.stderr.write(
    `knowledge-crib MCP server on stdio — ${stats.nodes} nodes, ${stats.edges} edges ready (default responses are tiered lean; pass withLlm:true for the full analysis blob)\n`,
  );
  try {
    await serveStdio(verbs);
  } finally {
    watch?.stop();
  }
  return EXIT.OK;
}

async function cmdUpdate(args: string[], ctx?: CmdCtx): Promise<number> {
  const resolved = resolveRoot(args, ctx);
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
  const dirty = args.includes('--dirty');
  // Archive inputs have no VCS work tree, so the git-delta knobs (`--since`/`--dirty`) are
  // meaningless. Detecting change on an archive is by fingerprint, handled below as a no-op or a
  // full re-index — never a `--since`/`--dirty` delta. Reject up front rather than silently ignoring.
  if (resolved.sourceArchive !== undefined && (since !== undefined || dirty)) {
    process.stderr.write(
      'archive inputs do not support --since/--dirty (no git work tree) — re-run `crib index <archive>` to refresh\n',
    );
    return EXIT.BAD_ARGS;
  }
  if (!isIndexedRoot(resolved)) {
    process.stderr.write('not indexed — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  // Archive path: compare the current archive fingerprint to the registered one. Unchanged → no-op;
  // changed → a fresh archive has no incremental anchor, so degrade to a full index (which re-extracts
  // and re-registers the new fingerprint). Directories fall through to the normal VCS delta below.
  if (resolved.sourceArchive !== undefined) {
    const prepared = await prepareSourceInput(resolved.projectKey, { cribDir: resolved.cribDir });
    if (prepared.fingerprint === resolved.sourceFingerprint) {
      process.stdout.write('up to date (archive unchanged)\n');
      return EXIT.OK;
    }
    process.stderr.write('archive changed — re-indexing\n');
    return cmdIndex(args, ctx);
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
    registerIndexed(resolved.projectKey, resolved.cribDir, rt.soul);
    const d = result.delta;
    process.stdout.write(
      `updated ${result.changedPaths.length} file(s) [scope ${result.scopeFiles.length}] → ` +
        `+${d.nodes.length} nodes +${d.edges.length} edges −${d.removed.length} in ${Date.now() - started}ms${excludedSuffix}\n` +
        `changed: ${result.changedPaths.join(', ')}\n`,
    );
    if (result.semanticPruned > 0) {
      process.stdout.write(
        `pruned ${result.semanticPruned} orphaned semantic artifact(s) — semantic cache invalidated (generation.semantic bumped)\n`,
      );
    }
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
  const resolved = resolveRoot(args, ctx);
  const { prepared, source } = await prepareSourceForIndex(resolved, args);
  const repoRoot = prepared.sourceRoot;
  const cribDir = prepared.cribDir;
  const projectKey = resolved.projectKey;
  const semantic = args.includes('--semantic');
  const ignores = parseExcludes(args);
  const scope = resolvePackageScope(repoRoot, args);
  if (scope.status !== EXIT.OK) return scope.status;
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
    registerIndexed(projectKey, cribDir, soul, source);
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
 * `crib init [path] [--ide <name|all>]` — the 5-minute onboarding (M4.2). Orchestrates the four
 * setup steps a new user would otherwise run by hand — index, install-hooks, mcp install, adapters — then
 * prints the hero "next steps" so the value is visible immediately and the path to the first MCP
 * query is one copy-paste. Idempotent: re-running refreshes the index, re-wires hooks (managed
 * blocks replace in place), and re-wires MCP (already-present configs report "up to date"). Does
 * NOT take `--semantic` (deterministic-first onboarding; opt into INFERRED links with a later
 * `crib index --semantic`).
 */
/**
 * G3.4 — the init-time freshness-mode choice. NON-BLOCKING by construction: a TTY prompt answers
 * on Enter (default) or after a short timeout; a non-interactive run (CI, scripted `claude -p`
 * onboarding) takes the default WITHOUT waiting on stdin at all. Default: `manual` — the mode
 * that changes nothing about existing behavior until the operator opts into a worker.
 */
async function chooseFreshnessMode(repoRoot: string): Promise<FreshnessMode> {
  const DEFAULT: FreshnessMode = 'manual';
  if (!process.stdin.isTTY) {
    return DEFAULT;
  }
  const rl = createReadline({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    const timer = setTimeout(() => {
      res('');
      rl.close();
    }, 10_000);
    rl.question(`  freshness mode (${FRESHNESS_MODES.join('/')}) [${DEFAULT}]: `, (a: string) => {
      clearTimeout(timer);
      res(a.trim());
      rl.close();
    });
  });
  const mode = parseFreshnessMode(answer === '' ? undefined : answer);
  void repoRoot;
  return mode ?? DEFAULT;
}

async function cmdInit(args: string[], ctx?: CmdCtx): Promise<number> {
  const repoRoot = resolve(ctx?.cwdOverride ?? positionalsOf(args)[0] ?? '.');
  const ideIdx = args.indexOf('--ide');
  const ide: McpIde | 'all' = ideIdx >= 0 ? ((args[ideIdx + 1] as McpIde | 'all') ?? 'all') : 'all';
  const validIdes: Array<McpIde | 'all'> = [
    'all',
    'claude',
    'cursor',
    'vscode',
    'codex',
    'windsurf',
    'gemini',
  ];
  if (!validIdes.includes(ide)) {
    process.stderr.write(`unknown --ide: ${ide}\nvalid: ${validIdes.join(', ')}\n`);
    return EXIT.BAD_ARGS;
  }

  process.stdout.write('crib init — 5-minute onboarding\n');
  process.stdout.write('  step 1/4: indexing the repo (deterministic, LLM-free)…\n');
  const indexCode = await cmdIndex([repoRoot], ctx);
  if (indexCode !== EXIT.OK) {
    process.stderr.write(`  index failed (exit ${indexCode}) — aborting init\n`);
    return indexCode;
  }

  process.stdout.write(
    '  step 2/4: wiring git hooks (non-blocking post-commit freshness hook + .crib merge driver)…\n',
  );
  const hooksCode = cmdInstallHooks([repoRoot], ctx, { convertAfter: true });
  if (hooksCode !== EXIT.OK) {
    process.stderr.write(`  install-hooks failed (exit ${hooksCode}) — aborting init\n`);
    return hooksCode;
  }

  // G3.4 — offer the freshness-mode choice. NON-BLOCKING: a TTY prompt answers on Enter (default)
  // or times out; non-interactive runs take the default silently. The installed hook was converted
  // to the non-blocking freshness path during step 2, and the mode itself never makes a commit
  // wait (zero-commit-tax red line).
  try {
    const mode = await chooseFreshnessMode(repoRoot);
    setFreshnessMode(repoRoot, mode);
    process.stdout.write(`  freshness mode: ${mode}\n`);
  } catch (err) {
    process.stderr.write(`  warning: freshness mode not persisted — ${(err as Error).message}\n`);
  }

  process.stdout.write(`  step 3/4: wiring the MCP server into IDE config (--ide ${ide})…\n`);
  const mcpCode = cmdMcp(['install', '--ide', ide, repoRoot], ctx);
  if (mcpCode !== EXIT.OK) {
    process.stderr.write(`  mcp install failed (exit ${mcpCode}) — aborting init\n`);
    return mcpCode;
  }

  process.stdout.write(
    '  step 4/4: writing the vendor-neutral agent-memory protocol into instruction files…\n',
  );
  // Non-fatal: adapter install must never abort init (a user may not want any instruction files yet, and
  // index/hooks/mcp already succeeded). installInstructions can still throw on an fs error (EACCES/EROFS/
  // ENOSPC writing CLAUDE.md/AGENTS.md), so swallow it into a warning rather than aborting with a trace.
  try {
    cmdAdapters(['install', '--client', 'all', repoRoot], ctx);
  } catch (e) {
    process.stderr.write(
      `  warning: instruction-adapter install failed — ${(e as Error).message}\n`,
    );
  }

  process.stdout.write('\n✓ crib init complete. Next steps:\n');
  process.stdout.write('  1. Restart your IDE so it picks up the MCP server config.\n');
  process.stdout.write(
    '  2. Ask your agent "query the crib for <symbol>", or run `crib query <text>`.\n',
  );
  process.stdout.write(
    '  3. (optional) `crib memory init` — enable team + local agent memory for this repo.\n',
  );
  process.stdout.write(
    '  4. (optional) `crib index --semantic` — add INFERRED embedding-cosine links.\n',
  );
  process.stdout.write('  5. (optional) `crib enrich --next` — drive the LLM-graph layer.\n');
  process.stdout.write('  Run `crib doctor` any time to re-check setup health.\n');
  return EXIT.OK;
}

/** Duplicated from runtime.ts STALE_BUILD_MS (unexported there — runtime.ts is owned by another
 *  workstream, so doctor re-implements the predicate). If runtime.ts ever exports it, switch over;
 *  until then keep the two in sync: a younger cutoff here would report a live build as stale. */
const DOCTOR_STALE_BUILD_MS = 60 * 60 * 1000;

/**
 * Count `.crib-build-*` temp databases abandoned by interrupted builds, plus their `-wal`/`-shm`
 * sidecar bytes. Read-only cousin of runtime.ts's sweepStaleBuilds: same selection predicate
 * (name, suffix, age gate), but doctor REPORTS — deleting belongs exclusively to the build-time
 * sweep; a diagnostic command must never mutate the repo it inspects. Fully best-effort like the
 * sweep: an absent/unreadable index dir is "zero", not an error.
 */
function countStaleBuilds(indexDir: string, now = Date.now()): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  let entries: string[];
  try {
    entries = readdirSync(indexDir);
  } catch {
    return { count, bytes }; // index dir absent — nothing has been built here
  }
  for (const name of entries) {
    if (!name.startsWith('.crib-build-') || !name.endsWith('.sqlite')) continue;
    const full = join(indexDir, name);
    try {
      if (now - statSync(full).mtimeMs < DOCTOR_STALE_BUILD_MS) continue;
      count++;
      for (const path of [full, `${full}-wal`, `${full}-shm`]) {
        try {
          bytes += statSync(path).size;
        } catch {
          // sidecar absent — the main file alone still counts
        }
      }
    } catch {
      // racing removal or a permissions problem — skip this entry, mirroring the sweep
    }
  }
  return { count, bytes };
}

/** Human byte size for the doctor report (small values dominate — KiB before MiB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/**
 * `crib doctor [path]` — setup health check (M4.2). Runs the eight onboarding-critical checks and
 * prints ✓/✗ + a fix hint for each. A failing check never skips the rest — the point is a full
 * diagnostic in one pass. Exits 0 when every check passes, 1 when any fails, so scripts/CI can
 * detect a broken setup. The Node-version check mirrors bin.ts's launcher guard (the canonical
 * gate, REQUIRED_NODE = 22.5.0 — the node:sqlite requirement); doctor re-runs it so a user on a
 * too-old Node learns it here, not from an opaque `node:sqlite` crash. The 7th check (agent-memory
 * loop) is non-fatal while memory is not initialized — it reports ✓ with an opt-in hint. The 8th
 * check (stale build artifacts) is WARN-class: always ✓, never reported as a failure — it surfaces
 * a backlog the next build would reclaim anyway.
 */
async function cmdDoctor(args: string[], ctx?: CmdCtx): Promise<number> {
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

  // 7. Agent-memory loop (PRD W8): once a user opts in with `crib memory init`, the loop is
  //    policy.json + team store + at least one instruction adapter present. NOT initialized is a
  //    valid, non-failing state (memory is opt-in) → reported as ✓ with a hint, not ✗.
  const memoryDir = join(repoRoot, '.crib', 'memory');
  const policyFile = join(memoryDir, 'policy.json');
  const teamDir = join(memoryDir, 'team');
  if (!existsSync(policyFile)) {
    checks.push({
      name: 'agent-memory loop',
      ok: true,
      detail: 'not initialized (optional)',
      fix: 'run `crib memory init` to enable team + local memory',
    });
  } else {
    const teamOk = existsSync(teamDir);
    let adapterCount = 0;
    try {
      adapterCount = listInstructions(repoRoot, { client: 'all', scope: 'project' }).filter(
        (e) => e.present,
      ).length;
    } catch {
      /* best-effort */
    }
    const memOk = teamOk && adapterCount > 0;
    // G2.1 — the capture-lane report rides check 7's detail line as pure DATA: which client is on
    // which lane, and whether the lane-2 hook entry is installed. An instruction-based client is
    // never a red mark — 'instruction-based recall only' is the honest capability, not a failure
    // (the same non-fatal pattern as this check's not-initialized state above).
    const hookLaneClients = ALL_CLIENTS.filter((id) => clientAdapter(id).lifecycle.lifecycleHooks);
    const recallLaneClients = ALL_CLIENTS.filter(
      (id) => !clientAdapter(id).lifecycle.lifecycleHooks,
    );
    let hookEvents: string[] = [];
    try {
      hookEvents = listCaptureHooks(repoRoot, { client: 'all', scope: 'project' }).flatMap(
        (e) => e.events,
      );
    } catch {
      /* best-effort — never let a diagnostic crash */
    }
    const laneDetail = [
      `${hookLaneClients.join('/')}: portable + lifecycle hooks (entry ${
        hookEvents.length > 0
          ? `installed: ${hookEvents.join(', ')}`
          : 'not installed — run `crib adapters hooks install`'
      })`,
      `${recallLaneClients.join('/')}: portable, instruction-based recall only (no hook surface)`,
    ].join('; ');
    checks.push({
      name: 'agent-memory loop',
      ok: memOk,
      detail: `policy ✓, team store ${teamOk ? '✓' : '✗'}, ${adapterCount} instruction adapter${adapterCount === 1 ? '' : 's'}; capture lanes: ${laneDetail}`,
      fix: memOk
        ? undefined
        : `${!teamOk ? 'run `crib memory init` (team store missing); ' : ''}${adapterCount === 0 ? 'run `crib adapters install` (no instruction file present)' : ''}`.trim(),
    });
  }

  // 8. Stale build artifacts (WARN-class: reported, never fatal, never deleted here). Interrupted
  //    `crib index` runs abandon `.crib-build-*` temp databases that the next build's startup sweep
  //    (runtime.ts sweepStaleBuilds) reclaims — doctor surfaces the backlog so a user can see it
  //    (it once quietly accumulated 510 MB in this repo) without waiting for a build, and without
  //    turning house-cleaning into a red ✗ that would fail CI. Runs even when unindexed: a failed
  //    first index is exactly when these pile up. The index dir is `<cribDir>/index` by convention
  //    on both standard and custom-cribDir layouts (resolveIndexPath strips the `.crib/` prefix).
  const stale = countStaleBuilds(join(resolved.cribDir, 'index'));
  checks.push({
    name: 'stale build artifacts',
    ok: true,
    detail:
      stale.count === 0
        ? 'none'
        : `${stale.count} stale .crib-build-* build${stale.count === 1 ? '' : 's'} (${formatBytes(stale.bytes)} incl. -wal/-shm) — auto-reclaimed on next \`crib index\``,
  });

  // 9. Embedder tier (G3.2): the fallback tier is a VALID state (✓ with the degraded-fallback
  //    wording + install hint), never fabricated as semantic. A broken install or integrity
  //    failure is ✗ with the problems echoed. Async — the honest check LOADS the model.
  try {
    const tier = await embedTierReport({ env: process.env });
    checks.push({
      name: 'embedder tier',
      ok: tier.problems.length === 0,
      detail: `${tier.tier} (${tier.embedderId}); remote ${tier.remoteEnabled ? 'acknowledged' : 'disabled'}${tier.externalOverride ? '; KCRIB_EMBEDDER override active' : ''} — ${tier.reason}${tier.problems.length > 0 ? `; problems: ${tier.problems.join('; ')}` : ''}`,
      fix:
        tier.tier === 'fallback'
          ? 'run `crib embed install <model-dir>` for the on-device tier'
          : undefined,
    });
  } catch (err) {
    checks.push({
      name: 'embedder tier',
      ok: false,
      detail: `report failed: ${(err as Error).message}`,
      fix: 'run `crib embed status`',
    });
  }

  // 10. Freshness (G3.4): not running a worker is a VALID state in every mode (manual is the
  //     default and `watch` is served by `crib serve --watch`); dead-lettered tasks or a published
  //     generation that is behind HEAD are the actionable ✗ states. Zero commit blocking holds in
  //     every mode — this check never asks the user to make commits wait on anything.
  try {
    const fresh = freshnessStatus(repoRoot);
    const deadOk = fresh.dead === 0;
    checks.push({
      name: 'freshness',
      ok: deadOk,
      detail: `mode ${fresh.mode}${fresh.modeExplicit ? '' : ' (default)'}; worker ${fresh.workerRunning ? `running (pid ${fresh.workerPid ?? '?'})` : 'not running'}; pending ${fresh.pending}; in-flight ${fresh.inFlight ? fresh.inFlight.id : 'none'}; behind HEAD ${fresh.behindHead ? 'YES' : 'no'}`,
      fix: !deadOk
        ? 'inspect `crib freshness status` and re-run `crib update` (dead-lettered tasks are retried by the worker)'
        : fresh.behindHead
          ? 'run `crib freshness worker` (or `crib update`)'
          : undefined,
    });
  } catch (err) {
    checks.push({
      name: 'freshness',
      ok: true,
      detail: `status unavailable: ${(err as Error).message}`,
    });
  }

  // 11. Legacy blocking post-commit hook (G3.4 detection surface): the W-era install ran
  //     `crib update` in the foreground of EVERY commit — a violation of the zero-commit-tax
  //     red line that predates the freshness modes. Surfaced as ✗ with the conversion command;
  //     the write itself stays in `crib freshness convert-hook`.
  const legacy = detectLegacyBlockingPostCommit(repoRoot);
  if (legacy.exists) {
    checks.push({
      name: 'post-commit hook non-blocking',
      ok: !legacy.convertible,
      detail: legacy.convertible
        ? `blocking \`crib update\` found (${legacy.blockingCommands.length} line(s)) — commits wait on a full reindex`
        : 'no blocking commands (freshness hook or absent managed block)',
      fix: legacy.convertible ? 'run `crib freshness convert-hook`' : undefined,
    });
  }

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

function cmdInstallHooks(
  args: string[],
  ctx?: CmdCtx,
  opts: { convertAfter?: boolean } = {},
): number {
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg(args) ?? '.');
  const res = installHooks(repoRoot);
  process.stdout.write(
    `installed kcrib hooks at ${res.gitDir}\n  post-commit → ${res.postCommitPath}\n  .gitattributes → ${res.gitattributesPath} (.crib/**/*.jsonl merge=kcrib, .crib/memory/team/**/*.jsonl merge=kcrib-memory)\n  merge.kcrib.driver = ${res.driverConfig}\n  merge.kcrib-memory.driver = ${res.driverConfig}\n`,
  );
  if (opts.convertAfter) {
    // `crib init` path: a FRESH onboarding must not ship the red-line-violating blocking hook —
    // convert immediately so `crib doctor` on a just-init'd repo is fully clean (onboarding:check
    // pins this). Standalone `crib install-hooks` stays conservative (below): pre-existing
    // automations that relied on the blocking refresh get to see WHY and convert on their terms.
    const conv = convertBlockingPostCommit(repoRoot);
    process.stdout.write(
      conv.converted
        ? '  converted post-commit to the non-blocking freshness hook (git commits are never\n  blocked, in every freshness mode)\n'
        : `  post-commit hook left as-is (${conv.reason ?? 'unknown'})\n`,
    );
    return EXIT.OK;
  }
  // G3.4 — the installed managed block is the legacy blocking `crib update` (kept for back-compat;
  // hooks.test.ts pins the block text). Detection + explain here, conversion via the dedicated
  // subcommand so the operator sees WHY before the hook is rewritten.
  const legacy = detectLegacyBlockingPostCommit(repoRoot);
  if (legacy.convertible) {
    process.stdout.write(
      '\nnote: the installed post-commit hook runs `crib update` in the foreground, which blocks\n  every git commit (violates the freshness red line: zero commit blocking in EVERY mode).\n  Convert it to the mode-appropriate non-blocking path with:\n    crib freshness convert-hook\n',
    );
  }
  return EXIT.OK;
}

/**
 * `crib embed <install <model-dir>|status>` — the on-device embedder tier (G3.2). The install is
 * the OPERATOR step: point it at a locally acquired model dir; the module pins + hash-verifies it
 * and fails closed (no manifest on failure, so the degraded fallback stays active rather than a
 * broken install silently degrading recall). Remote embedders are NEVER enabled here without the
 * explicit `--accept-remote-policy` acknowledgment (red line #3).
 */
async function cmdEmbed(args: string[], ctx?: CmdCtx): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'install') {
    const positionals: string[] = [];
    let modelId: string | undefined;
    let modelVersion: string | undefined;
    let entry: string | undefined;
    let acceptRemote = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === '--model-id') modelId = rest[++i];
      else if (a === '--model-version') modelVersion = rest[++i];
      else if (a === '--entry') entry = rest[++i];
      else if (a === '--accept-remote-policy') acceptRemote = true;
      else if (!a.startsWith('-')) positionals.push(a);
    }
    const modelDir = positionals[0];
    if (!modelDir || !modelId || !modelVersion) {
      process.stderr.write(
        'usage: crib embed install <model-dir> --model-id <id> --model-version <ver> [--entry <file>] [--accept-remote-policy]\n',
      );
      return EXIT.BAD_ARGS;
    }
    // The remote tier is opt-in ONLY: without the flag we print the policy text and install the
    // on-device model with the remote gate untouched (acknowledged policy stays absent → off).
    if (!acceptRemote) {
      process.stdout.write(`\n${REMOTE_EMBED_POLICY_TEXT}\n`);
      process.stdout.write(
        '\nremote embedders remain DISABLED. To acknowledge the policy above and opt in, re-run with --accept-remote-policy.\n\n',
      );
    }
    let manifest: EmbedManifest;
    try {
      manifest = await installEmbedModel({
        modelDir: resolve(modelDir),
        modelId,
        modelVersion,
        ...(entry ? { entry } : {}),
        // Display-only stamp (the manifest contract never reads the clock) — wall-clock is allowed
        // here because installedAt feeds no id/hash/ifHash projection.
        installedAt: new Date().toISOString(),
      });
    } catch (err) {
      process.stderr.write(`embed install failed: ${(err as Error).message}\n`);
      return EXIT.ERROR;
    }
    process.stdout.write(
      `installed embed model ${manifest.modelId}@${manifest.modelVersion} (embedder ${manifest.embedderId}, dim ${manifest.dim})\n  manifest: ${embedManifestPath()}\n  files pinned: ${manifest.files.length}\n`,
    );
    if (acceptRemote) {
      const home = embedHomeDir();
      mkdirSync(home, { recursive: true });
      const policy: RemoteEmbedPolicy = {
        acknowledged: true,
        policyVersion: REMOTE_EMBED_POLICY_VERSION,
        ...(process.env.KCRIB_REMOTE_PROVIDER
          ? { provider: process.env.KCRIB_REMOTE_PROVIDER }
          : {}),
      };
      writeFileSync(remotePolicyPath(home), `${JSON.stringify(policy, null, 2)}\n`);
      process.stdout.write(`  remote tier: policy acknowledged → ${remotePolicyPath(home)}\n`);
    }
    return EXIT.OK;
  }
  // default / `status` — the same structured report doctor renders (one truth source, two views).
  const report = await embedTierReport({ env: process.env });
  process.stdout.write(
    `embed tier: ${report.tier} (${report.embedderId})\n  remote: ${report.remoteEnabled ? 'acknowledged' : 'disabled'}\n  external override: ${report.externalOverride ? 'yes (KCRIB_EMBEDDER)' : 'no'}\n  manifest: ${report.manifestPresent ? report.manifestPath : 'absent'}\n  ${report.reason}\n`,
  );
  for (const p of report.problems) process.stdout.write(`  problem: ${p}\n`);
  return EXIT.OK;
}

/** The worker's revalidation port: refresh the project at the task's head and fingerprint the
 *  dependencies the memory evaluator's generation cache keys on (red lines #1 + #5). The SAME
 *  slots {@link bindEvaluationPass} sets at query time, so a published generation is directly
 *  comparable to the generation a later recall binds against. */
async function freshnessRevalidate(task: FreshnessTask): Promise<{ generation: string }> {
  // The same locked, incremental update path a user runs — background freshness can never
  // diverge from foreground truth. A failure here throws; the worker preserves the prior
  // published generation (never publishes a broken index) and dead-letters after maxAttempts.
  const code = await cmdUpdate([task.projectRoot], { cwdOverride: task.projectRoot });
  if (code !== EXIT.OK) {
    throw new Error(`crib update exited ${code} (head ${task.head.slice(0, 12)})`);
  }
  const resolved = resolveRoot([task.projectRoot]);
  const rt = openSoul(resolved);
  const soulGen = new SoulStoreSoulPort(rt.soul, resolved.repoRoot).generation?.() ?? UNVERSIONED;
  const policy = loadPolicy(resolved.cribDir);
  // decisions/feedback live in the memory stores (opt-in); without a repoId there is nothing to
  // fingerprint — the slots stay UNVERSIONED exactly as bindEvaluationPass computes them.
  let decisions = UNVERSIONED;
  let feedback = UNVERSIONED;
  const repoId = readRepoId(resolved.cribDir);
  if (repoId) {
    const env = process.env;
    const stores = {
      team: MemoryStore.team(resolved.cribDir, { repoRoot: resolved.repoRoot, env }),
      local: MemoryStore.local(repoId, { repoRoot: resolved.repoRoot, env }),
      global: MemoryStore.global({ env }),
    };
    const gathered = gatherRecall(stores);
    decisions = entrySetFingerprint([...gathered.decisions, ...gathered.localDecisions]);
    feedback = entrySetFingerprint(gathered.feedback);
  }
  return {
    generation: fingerprintGenerations({
      code: soulGen,
      policy: policy !== undefined ? policyHash(policy) : UNVERSIONED,
      receipts: UNVERSIONED,
      decisions,
      feedback,
      embedder: UNVERSIONED,
      index: UNVERSIONED,
    }),
  };
}

/**
 * `crib freshness [<mode>|worker|hook|convert-hook]` — the freshness-mode surface (G3.4):
 *   (no args / status)  mode + worker lease + in-flight + queue depth + behind-HEAD
 *   <mode>              persist manual|watch|auto in the project registry
 *   worker              foreground durable background worker (red line #5: persistent queue,
 *                       lease/heartbeat, coalescing, crash recovery, last-known-good)
 *   hook                the post-commit hook body: enqueue in `auto`, no-op otherwise — ALWAYS
 *                       exit 0 (fail-open; a hook must never block a commit in ANY mode)
 *   convert-hook        rewrite the legacy blocking `crib update` post-commit hook to this
 *                       non-blocking path (the write half of the detection in hooks.ts)
 */
async function cmdFreshness(args: string[], ctx?: CmdCtx): Promise<number> {
  // The first positional here is the SUBCOMMAND (status|worker|hook|convert-hook|<mode>), not a
  // path — so root resolution must skip known subcommand tokens and use any remaining positional.
  // (pathArg(args) would resolve `crib freshness convert-hook` to ./convert-hook and then fail
  // to find a git repo there — caught by the Gate 3 E2E product test.)
  const FRESHNESS_SUBS = new Set<string>([
    ...FRESHNESS_MODES,
    'status',
    'worker',
    'hook',
    'convert-hook',
  ]);
  const positionals = positionalsOf(args);
  const isSub = (tok: string) => FRESHNESS_SUBS.has(tok) || tok === '-h' || tok === '--help';
  const sub = args.find(isSub);
  const rootPos = positionals.find((tok) => !isSub(tok));
  const repoRoot = resolve(ctx?.cwdOverride ?? rootPos ?? '.');
  if (sub === undefined || sub === 'status') {
    const status = freshnessStatus(repoRoot);
    process.stdout.write(
      `freshness mode: ${status.mode}${status.modeExplicit ? '' : ' (default — set with `crib freshness <mode>`; modes: '}${FRESHNESS_MODES.join('|')}${status.modeExplicit ? '' : ')'}\n  worker: ${status.workerRunning ? `running (pid ${status.workerPid ?? '?'})` : 'not running'}\n  pending: ${status.pending}${status.dead > 0 ? `, dead-lettered: ${status.dead}` : ''}\n  in-flight: ${status.inFlight ? status.inFlight.id : 'none'}\n  last-known-good: ${status.lastKnownGood ? `${status.lastKnownGood.generation.slice(0, 16)}… @ ${status.lastKnownGood.head.slice(0, 12)}` : 'never published'}\n  behind HEAD: ${status.behindHead ? 'yes — run `crib freshness worker` (or `crib update`)' : 'no'}\n`,
    );
    return EXIT.OK;
  }
  if (FRESHNESS_MODES.includes(sub as FreshnessMode)) {
    try {
      setFreshnessMode(repoRoot, sub as FreshnessMode);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return EXIT.ERROR;
    }
    process.stdout.write(
      `freshness mode set to ${sub}\n${sub === 'auto' ? '  start the durable worker with `crib freshness worker` (or a service manager) — the mode only changes what the worker does, it never blocks a commit.\n' : ''}${sub === 'watch' ? '  watch mode is served by `crib serve --watch` (300ms debounce, serialized, atomic publication).\n' : ''}`,
    );
    return EXIT.OK;
  }
  switch (sub) {
    case 'worker': {
      try {
        const worker = await runFreshnessWorker({
          revalidate: freshnessRevalidate,
          onEvent: (ev) => {
            if (ev.kind === 'task-done') {
              process.stdout.write(
                `freshness: revalidated ${ev.task.projectRoot} @ ${ev.task.head.slice(0, 12)} → generation ${ev.generation.slice(0, 16)}…\n`,
              );
            } else if (ev.kind === 'task-dead') {
              process.stdout.write(
                `freshness: task dead-lettered after retries: ${ev.task.id} — ${ev.error}\n`,
              );
            } else if (ev.kind === 'refused') {
              process.stderr.write(`freshness worker refused: ${ev.reason}\n`);
            } else if (ev.kind === 'started') {
              process.stdout.write(
                `freshness worker started (pid ${ev.pid}, recovered ${ev.recovered} in-flight task(s))\n`,
              );
            }
          },
        });
        process.stdout.write(
          'freshness worker running — Ctrl+C to stop (in-flight task is awaited, never torn mid-flight)\n',
        );
        const done = new Promise<void>((res) => {
          process.on('SIGINT', () => {
            void worker.stop().then(res);
          });
          process.on('SIGTERM', () => {
            void worker.stop().then(res);
          });
        });
        await done;
        return EXIT.OK;
      } catch (err) {
        if (err instanceof WorkerAlreadyRunningError) {
          process.stderr.write(`${err.message} — use that worker (or kill it first)\n`);
          return EXIT.LOCKED;
        }
        process.stderr.write(`freshness worker failed: ${(err as Error).message}\n`);
        return EXIT.ERROR;
      }
    }
    case 'hook': {
      // The post-commit hook body. Fail-open ALWAYS: any throw still exits 0 (red line #2 —
      // zero commit blocking in every mode; the hook script's failure must never block a commit).
      let out = '';
      try {
        const head = currentHead(repoRoot) || '';
        const r = await postCommitFreshness(repoRoot, head);
        out = `freshness: mode ${r.mode}, ${r.enqueued ? `enqueued ${r.id ?? ''}` : 'no-op (nothing to refresh)'}`;
      } catch (err) {
        out = `freshness hook failed open: ${(err as Error).message}`;
      }
      process.stdout.write(`${out}\n`);
      return EXIT.OK;
    }
    case 'convert-hook': {
      const res = convertBlockingPostCommit(repoRoot);
      if (!res.converted) {
        process.stderr.write(
          `nothing to convert at ${res.postCommitPath}${res.reason ? ` — ${res.reason}` : ''}\n`,
        );
        return EXIT.OK;
      }
      process.stdout.write(
        `converted ${res.postCommitPath} to the non-blocking freshness hook\n  the managed block now runs \`crib freshness hook\` (enqueue in auto, no-op otherwise) —\n  git commits are never blocked, in every freshness mode (zero-commit-tax red line).\n`,
      );
      return EXIT.OK;
    }
    case '-h':
    case '--help':
      process.stdout.write(
        `usage: crib freshness [<mode>|status|worker|hook|convert-hook]\n  modes: ${FRESHNESS_MODES.join(' | ')}\n`,
      );
      return EXIT.OK;
    default:
      process.stderr.write(`unknown freshness subcommand: ${String(sub)}\n`);
      return EXIT.BAD_ARGS;
  }
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
  const validIdes: Array<McpIde | 'all'> = [
    'all',
    'claude',
    'cursor',
    'vscode',
    'codex',
    'windsurf',
    'gemini',
  ];
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
        'usage: crib mcp <install|list|remove> [--ide <claude|cursor|vscode|codex|windsurf|gemini|all>] [--global] [--bin <path>] [path]\n',
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
 *   crib enrich run --provider <name> [path] [--max-tokens N] [--max-batches N] [--concurrency N]
 *                                  [--layer L] [--scope PFX] [--budget-tokens N] [--providers-file F]
 *                                  bounded autonomous loop that hands each work item to an external
 *                                  provider from ~/.crib/providers.json (shell:false, strict JSON).
 *                                  Stops at a layer boundary, rejection, budget, or zero progress.
 *   crib enrich --auto [path] [--provider <name>] [--max-tokens N] [--max-batches N] ...
 *                                  DEPRECATED alias for `run --provider <name>`. Bare `--auto` (no
 *                                  --provider) no longer writes confidence-0.1 stubs (W7: stubs that
 *                                  masquerade as fresh are gone — only grounded `verified` artifacts
 *                                  satisfy coverage). It prints pending + guidance and exits.
 *   crib enrich --save <file> [path] [--scope PFX]   persist a {batchId, items[]} JSON batch
 *   crib enrich --overview [path] [--scope PFX]     print the bible (scoped to PFX if given)
 *   crib enrich --scopes [path] [--budget-tokens N] ranked path-prefix scopes for the picker
 *
 * `--budget-tokens N` is a per-batch PACKER (not a guard): `--next` fills a batch whose estimated
 * cost fits N, capped at `--limit` (default 25). If the first item alone exceeds N it is returned
 * alone with `oversized:true` (the queue never stalls). `run --provider --max-tokens N` bounds the
 * whole turn (sum of batch costs); `--max-batches N` caps the batch count (default 5); the loop also
 * stops at a layer boundary and breaks on zero-progress or rejects (exit non-zero). `--concurrency N`
 * sets parallel provider calls (default 1, max 4).
 *
 * W7 semantic quality: only grounded `verified` artifacts satisfy coverage. `run --provider` and the
 * MCP host-agent path both author real artifacts; a provider/authoring failure leaves the target
 * pending and resumable — it is re-offered next run.
 *
 * `--scope <prefix>` restricts status/next to in-scope targets (system layer is whole-repo only).
 * `--scope-cluster <cluster>` optionally refines inside the prefix. `--scopes` is a discovery view.
 */
/**
 * W7 — the bounded autonomous provider loop shared by `crib enrich run --provider <name>` and the
 * `--auto --provider <name>` alias (PRD line 383). Drives the SAME deterministic queue as the MCP
 * host-agent path (`enrich_next` → author → `enrich_save`), but hands each work item to an external
 * provider program from `~/.crib/providers.json`.
 *
 * Lock discipline (PRD line: never hold a filesystem lock while an enrichment provider is running):
 * the crib lock is held ONLY around `enrich.next()` and `enrich.save()` — the short, deterministic
 * queue/persistence critical sections — and RELEASED for the provider exec in between, which can take
 * minutes. A provider call therefore never blocks `crib update` / `crib serve` / another `crib enrich`.
 *
 * Stop conditions (PRD line 389): layer boundary, rejection (save rejects a grounding/secret failure),
 * budget (`spent + batchCost > maxTokens`), zero progress (same batchId re-issued with no save
 * landing), or `maxBatches`. A per-item PROVIDER failure (non-zero exit, timeout, bad JSON) is NOT a
 * stop — the failed item is simply not saved, so it stays pending and is re-offered next run (PRD exit
 * gate line 392: "provider failure leaves work pending and resumable"). If every item in a batch fails
 * at the provider, nothing is saved → the next `next()` re-issues the same batchId → zero-progress stop.
 */
async function runProviderEnrichLoop(opts: {
  cribDir: string;
  enrich: EnrichmentStore;
  def: ProviderDef;
  nextArgs: { layer?: EnrichLayer; scope?: EnrichScope; budgetTokens?: number };
  maxTokens: number;
  maxBatches: number;
  concurrency: number;
  timeoutMs?: number;
}): Promise<number> {
  const { cribDir, enrich, def, nextArgs, maxTokens, maxBatches, concurrency, timeoutMs } = opts;
  let spent = 0;
  let batches = 0;
  let startLayer: EnrichLayer | undefined;
  let lastBatchId: string | undefined;
  let totalAccepted = 0;
  let totalFailed = 0;
  /** Run a short critical section under the crib lock, returning its value (not constrained to a
   *  number like {@link runLocked}). Surfaces a lock-busy as EXIT.LOCKED. */
  const locked = async <T>(fn: () => T | Promise<T>): Promise<T | number> => {
    try {
      return await withCribLockAsync({ cribDir }, fn);
    } catch (e) {
      if (e instanceof LockBusyError) {
        process.stderr.write(`${e.message}\n`);
        return EXIT.LOCKED;
      }
      throw e;
    }
  };
  while (true) {
    // 1. Critical section: pull the next batch under the crib lock, then release for provider exec.
    const nextResult = await locked(() => enrich.next(nextArgs));
    if (typeof nextResult === 'number') return nextResult;
    const batch = nextResult as EnrichNextBatch;
    if (batch.items.length === 0) {
      process.stdout.write(`run: nothing pending for layer ${batch.layer} — done.\n`);
      break;
    }
    if (batch.zeroProgress || batch.batchId === lastBatchId) {
      process.stderr.write(
        `zero-progress: batchId ${batch.batchId} re-issued for layer ${batch.layer} with no save landing — stopping.\n`,
      );
      return EXIT.ERROR;
    }
    if (startLayer === undefined) startLayer = batch.layer;
    else if (batch.layer !== startLayer) {
      process.stdout.write(
        `run: layer boundary ${startLayer} → ${batch.layer} — stopping for review.\n`,
      );
      break;
    }
    const batchCost = batch.costEstimate?.batch ?? 0;
    if (batches > 0 && spent + batchCost > maxTokens) {
      process.stdout.write(
        `run: token ceiling reached (~${spent} spent + ~${batchCost} next > ${maxTokens}) — stopping.\n`,
      );
      break;
    }
    lastBatchId = batch.batchId;

    // 2. Provider exec — NO crib lock held (PRD: never hold the lock during a provider run).
    const outcomes = await runProviderBatch(def, batch.items as EnrichWorkItem[], {
      ...(timeoutMs ? { timeoutMs } : {}),
      concurrencyOverride: concurrency,
    });
    const saveItems: EnrichSaveItem[] = [];
    for (const o of outcomes) {
      if (o.ok) saveItems.push(o.item);
      else {
        totalFailed++;
        process.stderr.write(`run: provider failed for ${o.targetId}: ${o.reason}\n`);
      }
    }

    // 3. Critical section: persist accepted items under the lock. Rejection here is a real stop
    //    (grounding/secret failure — the provider returned content that failed the moat).
    let rejectedCount = 0;
    if (saveItems.length > 0) {
      const saveResult = await locked(
        () =>
          enrich.save({ batchId: batch.batchId, items: saveItems }) as {
            accepted: unknown[];
            rejected: Array<{ targetId: string; reason: string }>;
          },
      );
      if (typeof saveResult === 'number') return saveResult;
      const result = saveResult as {
        accepted: unknown[];
        rejected: Array<{ targetId: string; reason: string }>;
      };
      rejectedCount = result.rejected.length;
      if (rejectedCount > 0) {
        process.stderr.write(
          `run: ${rejectedCount} item(s) rejected by grounding/secret check — stopping for review:\n${result.rejected.map((r) => `  ${r.targetId}: ${r.reason}`).join('\n')}\n`,
        );
        return EXIT.ERROR;
      }
      totalAccepted += result.accepted.length;
    }
    spent += batchCost;
    batches += 1;
    process.stdout.write(
      `run batch ${batches}: layer=${batch.layer} accepted=${saveItems.length - rejectedCount}` +
        ` provider-failed=${outcomes.filter((o) => !o.ok).length}` +
        ` remaining=${batch.remaining} cost=${batchCost} spent=${spent}/${maxTokens}\n`,
    );
    if (batches >= maxBatches) {
      process.stdout.write(`run: max-batches reached (${maxBatches}) — stopping for review.\n`);
      break;
    }
  }
  process.stdout.write(
    `run: ${batches} batch(es), ${totalAccepted} accepted, ${totalFailed} provider failure(s)` +
      ` (~${spent} tokens spent)${startLayer ? `, layer ${startLayer}` : ''}.\n`,
  );
  return EXIT.OK;
}

async function cmdEnrich(args: string[], ctx?: CmdCtx): Promise<number> {
  // Strip --save <file> so the file path is not misinterpreted as the project root.
  const rootArgs = args.slice();
  const saveIdx = rootArgs.indexOf('--save');
  if (saveIdx >= 0) {
    rootArgs.splice(saveIdx, 2);
  }
  // Strip the `run` subcommand positional so it is not misread as a project-root path.
  if (rootArgs[0] === 'run') rootArgs.splice(0, 1);
  // Strip the `delta` subcommand positional likewise.
  if (rootArgs[0] === 'delta') rootArgs.splice(0, 1);
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

  // `crib enrich delta` — the semantic-layer delta report (+ optional prune + optional re-issue),
  // the explicit human-facing companion to `crib update`'s silent orphan auto-prune. Scopes:
  //   --since <ref>     temporal (VCS diff since ref → changed symbols/files + all clusters + system)
  //   --targets <a,b>   explicit target ids (the re-issue surface)
  //   --scope <prefix>  spatial (resolve prefix → in-scope symbol/file ids + clusters + system)
  //   (none)            whole-repo scan (every persisted artifact)
  // --prune deletes orphans; --prune-stale ALSO deletes stale-but-present (destructive). Drift
  // re-verify is ON by default (the CLI is the human surface); --no-verify-drift skips the cost.
  // --reissue calls enrich_next with the report's reissueTargets and prints the batch.
  if (args[0] === 'delta') {
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const since = flag('--since');
    const targetsCsv = flag('--targets');
    const explicitTargets = targetsCsv
      ? targetsCsv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    // Spatial scope: resolve the prefix to in-scope target ids (symbols/files under the prefix, all
    // clusters — membership is global, and the whole-repo system target). Combined with --since by
    // intersection: a temporal delta restricted to a spatial area.
    let scopeTargets: string[] | undefined;
    if (scope?.pathPrefix) {
      const prefix = scope.pathPrefix;
      const inPrefix = (p: string | undefined): boolean =>
        p !== undefined && (p === prefix || p.startsWith(`${prefix}/`));
      const ids: string[] = [];
      for (const node of rt.soul.iterate()) {
        if (inPrefix(node.file)) ids.push(node.id);
      }
      for (const node of rt.soul.iterate('cluster')) ids.push(node.id);
      ids.push('system:repo');
      scopeTargets = ids;
    }
    // Build the final targets: explicit > scope > since (resolved inline to changed symbol/file ids +
    // all clusters + system, mirroring Verbs.affectedTargetIds — the EnrichmentStore is VCS-free, so
    // the CLI resolves the temporal diff itself using the pipeline vcs helpers already imported).
    let targets = explicitTargets ?? scopeTargets;
    let vcsCtx: { since: string; head: string; changedPaths: string[] } | undefined;
    if (!targets && since !== undefined) {
      try {
        const head = currentHead(resolved.repoRoot);
        const changedPaths = changedFilesSince(resolved.repoRoot, since);
        const changed = new Set(changedPaths);
        const ids: string[] = [];
        for (const node of rt.soul.iterate()) {
          const p = node.file ?? pathFromId(node.id);
          if (p !== undefined && changed.has(p)) ids.push(node.id);
        }
        for (const node of rt.soul.iterate('cluster')) ids.push(node.id);
        ids.push('system:repo');
        targets = ids;
        vcsCtx = { since, head, changedPaths };
      } catch {
        // non-git / no anchor: fall through to an unscoped whole-repo scan (targets stays undefined).
        vcsCtx = undefined;
      }
    }
    const verifyDrift = !args.includes('--no-verify-drift');
    const doReissue = args.includes('--reissue');
    return runLocked(resolved.cribDir, () => {
      const result = enrich.semanticDelta({
        ...(targets ? { targets } : {}),
        ...(args.includes('--prune') ? { prune: true } : {}),
        ...(args.includes('--prune-stale') ? { pruneStale: true } : {}),
        ...(verifyDrift ? { verifyDrift: true } : {}),
      });
      const out: Record<string, unknown> = { ...result };
      if (vcsCtx) Object.assign(out, vcsCtx);
      else if (since !== undefined) out.note = 'no vcs anchor — scanned whole repo';
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      if (doReissue && result.reissueTargets.length > 0) {
        const batch = enrich.next({ targets: result.reissueTargets });
        process.stdout.write(`\n--- re-issue batch ---\n${JSON.stringify(batch, null, 2)}\n`);
      } else if (doReissue) {
        process.stderr.write('no stale/drifted targets to re-issue\n');
      }
      return EXIT.OK;
    });
  }

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

  // W7 — `crib enrich run --provider <name>` and the `--auto --provider <name>` alias share the
  // bounded provider loop. Bare `--auto` (no --provider) no longer writes confidence-0.1 stubs: W7
  // made only grounded `verified` artifacts satisfy coverage, so a stub (legacy) would not advance
  // the queue anyway — it would just spin to zero-progress. Print pending + guidance instead.
  const isRunSubcmd = args[0] === 'run';
  const providerIdx = args.indexOf('--provider');
  const providerName = providerIdx >= 0 ? args[providerIdx + 1] : undefined;
  if (isRunSubcmd || (args.includes('--auto') && providerName !== undefined)) {
    if (providerName === undefined || providerName.startsWith('--')) {
      process.stderr.write(
        'error: `crib enrich run` requires --provider <name> (defined in ~/.crib/providers.json).\n' +
          '  example: crib enrich run --provider my-agent\n',
      );
      return EXIT.BAD_ARGS;
    }
    const providersFileIdx = args.indexOf('--providers-file');
    const providersFile = providersFileIdx >= 0 ? args[providersFileIdx + 1] : undefined;
    let def: ProviderDef;
    try {
      def = resolveProvider(providerName, providersFile).def;
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      return EXIT.BAD_ARGS;
    }
    const layerIdx = args.indexOf('--layer');
    const layer = layerIdx >= 0 ? (args[layerIdx + 1] as EnrichLayer | undefined) : undefined;
    const maxTokensIdx = args.indexOf('--max-tokens');
    const maxTokensRaw =
      maxTokensIdx >= 0 ? Number.parseInt(args[maxTokensIdx + 1] ?? '', 10) : undefined;
    const maxBatchesIdx = args.indexOf('--max-batches');
    const maxBatchesRaw =
      maxBatchesIdx >= 0 ? Number.parseInt(args[maxBatchesIdx + 1] ?? '', 10) : undefined;
    const concurrencyIdx = args.indexOf('--concurrency');
    const concurrencyRaw =
      concurrencyIdx >= 0 ? Number.parseInt(args[concurrencyIdx + 1] ?? '', 10) : undefined;
    const timeoutIdx = args.indexOf('--timeout-ms');
    const timeoutRaw =
      timeoutIdx >= 0 ? Number.parseInt(args[timeoutIdx + 1] ?? '', 10) : undefined;
    // Defaults per PRD line 388: ≤5 batches, 100k tokens. Concurrency default 1, max 4 (line 387).
    const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw! > 0 ? maxTokensRaw! : 100_000;
    const maxBatches = Number.isFinite(maxBatchesRaw) && maxBatchesRaw! > 0 ? maxBatchesRaw! : 5;
    const concurrency =
      Number.isFinite(concurrencyRaw) && concurrencyRaw! > 0 ? concurrencyRaw! : 1;
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw! > 0 ? timeoutRaw! : undefined;
    const nextArgs = {
      ...(layer ? { layer } : {}),
      ...(scope ? { scope } : {}),
      ...(budget ? { budgetTokens: budget } : {}),
    };
    return runProviderEnrichLoop({
      cribDir: resolved.cribDir,
      enrich,
      def,
      nextArgs,
      maxTokens,
      maxBatches,
      concurrency,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  if (args.includes('--auto')) {
    // W7: bare `--auto` (no --provider) can no longer write confidence-0.1 stubs that appear fresh
    // (PRD line 382). Only grounded `verified` artifacts satisfy coverage now, so stubs would not
    // advance the queue. Report real pending + point at the provider loop / MCP skill instead.
    const st = enrich.status({
      ...(scope ? { scope } : {}),
    });
    const pending = st.progress?.pending ?? 0;
    process.stdout.write(
      `--auto without --provider no longer writes stubs (W7: only grounded verified artifacts satisfy coverage).\npending targets: ${pending}. To author them:\n  • provider loop: crib enrich run --provider <name>   (defined in ~/.crib/providers.json)\n  • MCP host-agent: use the /crib-enrich skill (enrich_next → author → enrich_save)\n  • one batch:     crib enrich --next  then  crib enrich --save <file>\n`,
    );
    return EXIT.OK;
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
  let client: ClientId | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--dest') {
      const value = rest[++i];
      if (looksLikeFlag(value)) {
        process.stderr.write('usage: crib skill install [name] [--dest <dir>] [--client <id>]\n');
        return EXIT.BAD_ARGS;
      }
      destRoot = value;
      continue;
    }
    if (arg === '--client') {
      const value = rest[++i];
      if (looksLikeFlag(value) || !value) {
        process.stderr.write('usage: crib skill install [name] [--client <id>]\n');
        return EXIT.BAD_ARGS;
      }
      // Skill install targets ONE client (no 'all' sentinel — unlike `crib adapters --client all`).
      // Validate membership so an unknown id (or 'all') yields a clean usage error, not a stack trace
      // from clientAdapter's `no adapter for client '...'` throw.
      if (value === 'all' || !ALL_CLIENTS.includes(value as ClientId)) {
        process.stderr.write(`unknown --client: ${value}\nvalid: ${ALL_CLIENTS.join(', ')}\n`);
        return EXIT.BAD_ARGS;
      }
      client = value as ClientId;
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
        ...(client ? { client } : {}),
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
      process.stderr.write(
        'usage: crib skill <install|list> [name] [--dest <dir>] [--client <id>]\n',
      );
      return EXIT.BAD_ARGS;
    default:
      process.stderr.write(`unknown skill subcommand: ${sub}\n`);
      return EXIT.BAD_ARGS;
  }
}

/**
 * `crib adapters <install|list|remove> [--client <id|all>] [--scope project|global]` (W8, PRD line 394).
 * Writes the vendor-neutral agent-memory protocol as a managed block into each client's native
 * instruction file (CLAUDE.md, .cursor/rules/crib.mdc, .github/copilot-instructions.md, AGENTS.md,
 * .windsurfrules, GEMINI.md) — preserving sibling content byte-for-byte. Removing an adapter removes
 * only its block; memory lives in `.crib/memory/` + `~/.crib/memory/`, never in these files (PRD exit
 * gate line 408: "removing an adapter does not remove memory"). Mirrors `crib mcp`'s shape.
 *
 * `list` also prints each client's capture-lane row (G2.1) — regenerated from the lifecycle matrix,
 * never hand-written. `crib adapters hooks <install|list|remove>` manages the lane-2 capture hooks
 * (Claude Code settings.json; see adapters.ts).
 */
function cmdAdapters(args: string[], ctx?: CmdCtx): number {
  const [sub, ...rest] = args;
  if (sub === 'hooks') return cmdAdaptersHooks(rest, ctx);
  let client: ClientId | 'all' = 'all';
  let scope: 'project' | 'global' = 'project';
  let pathArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--client') {
      const value = rest[++i];
      if (looksLikeFlag(value) || !value) {
        process.stderr.write(
          'usage: crib adapters <install|list|remove> [--client <id|all>] [--scope project|global]\n',
        );
        return EXIT.BAD_ARGS;
      }
      client = value as ClientId | 'all';
      continue;
    }
    if (arg === '--scope') {
      const value = rest[++i];
      if (value !== 'project' && value !== 'global') {
        process.stderr.write(`unknown --scope: ${value ?? '(missing)'} (project|global)\n`);
        return EXIT.BAD_ARGS;
      }
      scope = value;
      continue;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`unknown adapters option: ${arg}\n`);
      return EXIT.BAD_ARGS;
    }
    // The first non-flag positional is the subcommand (consumed via `sub`); a second one is the path.
    if (!pathArg) pathArg = arg;
  }
  if (client !== 'all' && !ALL_CLIENTS.includes(client)) {
    process.stderr.write(
      `unknown --client: ${client}\nvalid: ${['all', ...ALL_CLIENTS].join(', ')}\n`,
    );
    return EXIT.BAD_ARGS;
  }
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg ?? '.');

  switch (sub) {
    case 'install': {
      const results = installInstructions(repoRoot, { client, scope });
      for (const r of results) {
        if (r.note) process.stdout.write(`${r.client}: ${r.note}\n`);
        else if (r.path)
          process.stdout.write(
            `${r.client}: ${r.written ? 'installed' : 'up to date'} → ${r.path}\n`,
          );
      }
      return EXIT.OK;
    }
    case 'list': {
      // The capture-lane matrix as data (G2.1) — printed for the requested clients even when they
      // have no instruction file (vscode), since the lanes are a property of the client, not of
      // any file.
      for (const id of client === 'all' ? ALL_CLIENTS : [client])
        process.stdout.write(`${captureLaneSummary(id)}\n`);
      const entries = listInstructions(repoRoot, { client, scope });
      if (entries.length === 0) {
        process.stdout.write(`no ${scope}-scope instruction files for ${client}\n`);
        return EXIT.OK;
      }
      for (const e of entries)
        process.stdout.write(`${e.client}: ${e.present ? 'present' : 'absent'} → ${e.path}\n`);
      return EXIT.OK;
    }
    case 'remove': {
      const results = removeInstructions(repoRoot, { client, scope });
      for (const r of results) {
        if (r.note) process.stdout.write(`${r.client}: ${r.note}\n`);
        else if (r.path)
          process.stdout.write(
            `${r.client}: ${r.written ? 'removed' : 'not present'} → ${r.path}\n`,
          );
      }
      return EXIT.OK;
    }
    case undefined:
    case '-h':
    case '--help':
      process.stderr.write(
        'usage: crib adapters <install|list|remove> [--client <id|all>] [--scope project|global]\n',
      );
      return EXIT.BAD_ARGS;
    default:
      process.stderr.write(`unknown adapters subcommand: ${sub}\n`);
      return EXIT.BAD_ARGS;
  }
}

/**
 * `crib adapters hooks <install|list|remove> [--client <id|all>]` (G2.1, lane 2). Manages the
 * client capture-hook entries (Claude Code `.claude/settings.json` today) that invoke the crib CLI
 * capture path on session/turn events. Project scope only. Clients whose matrix row has no hook
 * surface report "instruction-based recall only" — as data, never as a failure.
 */
function cmdAdaptersHooks(args: string[], ctx?: CmdCtx): number {
  const [sub, ...rest] = args;
  let client: ClientId | 'all' = 'all';
  let pathArg: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--client') {
      const value = rest[++i];
      if (looksLikeFlag(value) || !value) {
        process.stderr.write(
          'usage: crib adapters hooks <install|list|remove> [--client <id|all>]\n',
        );
        return EXIT.BAD_ARGS;
      }
      client = value as ClientId | 'all';
      continue;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`unknown adapters hooks option: ${arg}\n`);
      return EXIT.BAD_ARGS;
    }
    if (!pathArg) pathArg = arg;
  }
  if (client !== 'all' && !ALL_CLIENTS.includes(client)) {
    process.stderr.write(
      `unknown --client: ${client}\nvalid: ${['all', ...ALL_CLIENTS].join(', ')}\n`,
    );
    return EXIT.BAD_ARGS;
  }
  const repoRoot = resolve(ctx?.cwdOverride ?? pathArg ?? '.');

  switch (sub) {
    case 'install': {
      const results = installCaptureHooks(repoRoot, { client, scope: 'project' });
      for (const r of results) {
        if (r.note) process.stdout.write(`${r.client}: ${r.note}\n`);
        else
          process.stdout.write(
            `${r.client}: hooks ${r.written ? 'installed' : 'up to date'} (${r.events.join(', ')}) → ${r.path}\n`,
          );
      }
      return EXIT.OK;
    }
    case 'list': {
      for (const e of listCaptureHooks(repoRoot, { client, scope: 'project' })) {
        if (e.note) process.stdout.write(`${e.client}: ${e.note}\n`);
        else
          process.stdout.write(
            `${e.client}: hooks ${e.events.length > 0 ? `installed (${e.events.join(', ')})` : 'not installed'} → ${e.path}\n`,
          );
      }
      return EXIT.OK;
    }
    case 'remove': {
      const results = removeCaptureHooks(repoRoot, { client, scope: 'project' });
      for (const r of results) {
        if (r.note) process.stdout.write(`${r.client}: ${r.note}\n`);
        else if (r.written)
          process.stdout.write(`${r.client}: hooks removed (${r.events.join(', ')}) → ${r.path}\n`);
        else process.stdout.write(`${r.client}: hooks not present → ${r.path}\n`);
      }
      return EXIT.OK;
    }
    case undefined:
    case '-h':
    case '--help':
      process.stderr.write(
        'usage: crib adapters hooks <install|list|remove> [--client <id|all>]\n',
      );
      return EXIT.BAD_ARGS;
    default:
      process.stderr.write(`unknown adapters hooks subcommand: ${sub}\n`);
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

/**
 * Gate 1.3 — build the portable {@link MemoryApi} over the CLI's three stores. The SAME adapter
 * the MCP verbs use (verbs.ts `memoryApi()`): soul anchored through `SoulStoreAnchorPort`, fresh
 * revalidation via the evaluator the memory deps always wire, and the repo's current git HEAD as
 * the search provenance codeHead. One contract, two surfaces — the CLI subcommands never
 * re-implement an op the package already owns.
 */
function createMemoryApi(
  soul: SoulStore,
  repoRoot: string,
  cribDir: string,
  deps: NonNullable<ReturnType<typeof createMemoryDeps>>,
): MemoryApi {
  let head: string | undefined;
  try {
    head = currentHead(repoRoot) || undefined;
  } catch {
    head = undefined; // not a git repo — search provenance reports no codeHead, never a crash
  }
  return new MemoryApi({
    stores: { team: deps.team, local: deps.local, global: deps.global },
    soul: new SoulStoreAnchorPort(soul, repoRoot),
    cribDir,
    evaluator: deps.evaluator,
    evalCtx: deps.evalCtx,
    ...(head !== undefined ? { codeHead: head } : {}),
  });
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
 *   - recall "<query>"     the CLI fallback for the `brief` MCP tool's memory half (P0.1 — the
 *                          neutral protocol text names this command, so it must exist)
 *   - search "<query>"     Gate 1.3 — the portable MemoryApi's rich search (the `memory{op:'search'}`
 *                          MCP op); `--json` mirrors the MCP response shape
 *   - get <id>             Gate 1.3 — version-aware single-record read (alias-following; the
 *                          `memory{op:'get'}` MCP op)
 *   - supersede <id>       Gate 1.3 — retire a record in favour of a successor (append-only)
 *   - delete <id>          Gate 1.3 — a tombstone (retract decision), never a removal
 *   - history <key>        Gate 1.3 — the bi-temporal belief timeline (optionally `--as-of`)
 *   - evaluate <id> -p X   run the gate → evaluate → activate (the happy path); crash-safe
 *   - activate <id>        crash-recovery: re-evaluate + activate against an existing receipt
 *   - propose <mem-id>     write a team record + accept decision (idempotent; CI derives trust)
 *   - attest <id>          TTY-only human attestation: stamp a human-attestation evidence item
 * The MCP server NEVER calls these — only the CLI / CI runner produce evaluation receipts (PRD 68).
 * `recall` is the one read-only exception: it mirrors the MCP `memory_recall` verb's projection.
 */
async function cmdMemory(args: string[], ctx?: CmdCtx): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'init':
      return cmdMemoryInit(rest, ctx);
    case 'recall':
      return cmdMemoryRecall(rest, ctx);
    case 'search':
      return cmdMemorySearch(rest, ctx);
    case 'get':
      return cmdMemoryGet(rest, ctx);
    case 'supersede':
      return cmdMemorySupersede(rest, ctx);
    case 'delete':
      return cmdMemoryDelete(rest, ctx);
    case 'history':
      return cmdMemoryHistory(rest, ctx);
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
    case 'feedback':
      return cmdMemoryFeedback(rest, ctx);
    case 'gc':
      return cmdMemoryGc(rest, ctx);
    case 'migrate':
      return cmdMemoryMigrate(rest, ctx);
    case 'bench':
      return cmdMemoryBench(rest, ctx);
    // G2.3 — the capture-outbox drain loop (provider proposes, crib disposes).
    case 'distill':
      return cmdMemoryDistill(rest, ctx);
    // G2.1 lane 2 — the durable capture command the lifecycle hooks invoke (adapters.ts
    // `captureHookCommand`). Fail-open by contract: see cmdMemoryCaptureHook.
    case 'capture-hook':
      return cmdMemoryCaptureHook(rest, ctx);
    case undefined:
    case '-h':
    case '--help':
      process.stderr.write(
        'crib memory init | recall "<query>" [--limit N] [--sources team,local,global] [--target <id>] [--with-evidence] [--include-pending] [--max-tokens N] [--json] | search "<query>" [--limit N] [--sources team,local,global] [--target <id>] [--max-tokens N] [--json] | get <id> [--with-evidence] [--json] | supersede <id> --actor <id> (--successor <id> | --claim <text>) [--reason <text>] [--json] | delete <id> --actor <id> [--reason <text>] [--json] | history <key> [--as-of <iso-ts>] [--with-evidence] [--json] | evaluate <candidate> --profile <name> | activate <candidate> | propose <memory-id> | attest <candidate> | check | audit [--repair-local] | feedback <mem-id> --signal <useful|unhelpful|contradicted> [--actor <id>] [--context <text>] [--counter-evidence <json-file>] | gc [--max-age-days N] [--dry-run] | migrate | bench [--fast] [--json] [--out <path>] | distill --provider <name> [--providers-file F] [--max-batches N] [--concurrency N] [--timeout-ms N] | capture-hook --event <session-start|turn-end|tool-use> (hooks invoke this; always exits 0 — best-effort capture, never blocks a session)\n',
      );
      return EXIT.OK;
    default:
      process.stderr.write(`unknown memory subcommand: ${sub}\n`);
      return EXIT.BAD_ARGS;
  }
}

// ─── G2.3 — `crib memory distill` (the capture-outbox drain loop) ────────────────

/** How many pending captures one distill batch offers to the provider (bounded like enrich's 25). */
const DISTILL_BATCH_SIZE = 25;

/** The persisted zero-progress marker for the distill queue: `{ lastBatchId }` at
 *  `<localStoreRoot>/distill-state.json`. A separate file (NOT the enrich manifest's `#t:` keys), so
 *  the distill marker can never collide with the enrich queue's lastIssued keys; the `distill:`
 *  batchId prefix makes even a future shared file collision structurally impossible. */
interface DistillState {
  lastBatchId?: string;
  lastBatchAt?: string;
}

function distillStatePath(repoId: string, env: NodeJS.ProcessEnv): string {
  return join(localStoreRoot(repoId, env), 'distill-state.json');
}

function readDistillState(path: string): DistillState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DistillState;
    }
  } catch {
    // absent / unreadable / corrupt → an empty state (the loop simply has no prior batch to match)
  }
  return {};
}

/**
 * `crib memory distill --provider <name>` — the G2.3 drain loop for the durable capture outbox.
 * Each pending `cap:` entry becomes a provider work item (the capture + the existing same-subject
 * records with their propositionKeys); the provider returns a structured decision; crib VERIFIES
 * the decision deterministically (`verifyDistillDecision`) and only then applies it
 * (`applyVerifiedDecision` — durable result first, outbox done last). The provider proposes; crib
 * disposes.
 *
 * Loop model (mirrors runProviderEnrichLoop): the lock is held only around the apply critical
 * section — the queue read itself is lock-free by design (pendingCaptures) — and RELEASED for the
 * provider exec. Stop conditions: empty queue (done), zero progress (the same batchId — blake3 over
 * the sorted pending ids — re-seen with nothing landing, persisted in distill-state.json so it
 * holds across runs), or --max-batches. A per-item failure is NOT a loop stop: it appends a retry
 * attempt to the entry (B's outbox lifecycle) and dead-letters at the limit, so the queue stays
 * resumable and a poison capture cannot wedge the drain.
 */
async function cmdMemoryDistill(args: string[], ctx?: CmdCtx): Promise<number> {
  const providerIdx = args.indexOf('--provider');
  if (providerIdx < 0) {
    process.stderr.write(
      'usage: crib memory distill --provider <name> [--providers-file <path>] [--max-batches N] [--concurrency N] [--timeout-ms N]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const providerName = args[providerIdx + 1];
  if (!providerName || providerName.startsWith('-')) {
    process.stderr.write('error: --provider requires a provider name\n');
    return EXIT.BAD_ARGS;
  }
  const providersFile = stringFlag(args, '--providers-file');
  const maxBatches = intFlag(args, '--max-batches') ?? 5;
  const concurrency = intFlag(args, '--concurrency') ?? 1;
  const timeoutMs = intFlag(args, '--timeout-ms');

  let def: ProviderDef;
  try {
    def = resolveProvider(providerName, providersFile).def;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return EXIT.BAD_ARGS;
  }

  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const repoId = readRepoId(resolved.cribDir);
  if (!repoId) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const env = process.env;
  // The distiller touches ONLY the local store (the no-poison rule + the no-cross-store-nesting
  // lock guard): no team or global store is constructed here at all.
  const local = MemoryStore.local(repoId, { repoRoot: resolved.repoRoot, env });
  const policy = loadPolicy(resolved.cribDir)?.capture;
  const statePath = distillStatePath(repoId, env);
  const now = (): string => new Date().toISOString();

  let batches = 0;
  let totalApplied = 0;
  let totalFailed = 0;
  let totalDeadLettered = 0;
  while (batches < maxBatches) {
    // 1. Queue read (lock-free by design): the pending view, dead wins over outbox.
    const pending = pendingCaptures(local);
    if (pending.length === 0) {
      process.stdout.write('distill: capture outbox empty — done.\n');
      break;
    }
    // Zero-progress: the batchId is the deterministic identity of this exact queue state; a
    // persisted marker makes the stop survive across runs (no retry churn — the stop happens
    // BEFORE any provider exec or attempt append).
    const batchId = distillBatchId(pending.map((e) => e.id));
    const state = readDistillState(statePath);
    if (state.lastBatchId === batchId) {
      process.stderr.write(
        `zero-progress: distill batch ${batchId} was already offered with nothing landing — stopping (inspect the provider or the outbox; the marker persists by design).\n`,
      );
      return EXIT.ERROR;
    }

    // 2. Provider exec — NO lock held. The verify callback runs per item as the response lands,
    //    throwing ProviderItemError on any unverifiable decision (a per-item failure, never applied).
    const batch = pending.slice(0, DISTILL_BATCH_SIZE);
    const items = batch.map((entry) =>
      buildDistillWorkItem(entry, sameSubjectRecords(local, entry.subject)),
    );
    const ctxByTarget = new Map<string, DistillVerifyContext>(
      batch.map((entry) => [entry.id, { local, entry, ...(policy ? { policy } : {}) }]),
    );
    const outcomes = await runProviderBatch<VerifiedDistillDecision>(
      def,
      items as unknown as EnrichWorkItem[],
      {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        concurrencyOverride: concurrency,
        validate: (parsed: unknown, expectedTargetId: string): VerifiedDistillDecision => {
          const vctx = ctxByTarget.get(expectedTargetId);
          if (!vctx) throw new ProviderItemError(expectedTargetId, 'no distill context for target');
          const result = verifyDistillDecision(parsed, expectedTargetId, vctx);
          if (!result.ok) throw new ProviderItemError(expectedTargetId, result.reason);
          return result.verified;
        },
      },
    );

    // 3. Critical section: apply verified decisions + record failures under one crib lock hold.
    //    All writes are same-store (local) re-entrant takes of the store's own lock.
    let applied = 0;
    let failed = 0;
    let deadLettered = 0;
    try {
      // All-sync body — the async wrapper is only the crib-lock handle (the same pattern the
      // enrich loop's `locked()` helper uses; the store's own writes re-take their own lock
      // re-entrantly, never across an await).
      await withCribLockAsync({ cribDir: resolved.cribDir }, () => {
        for (const o of outcomes) {
          const entry = ctxByTarget.get(o.targetId)?.entry as CaptureOutboxEntry | undefined;
          if (!entry) continue;
          if (!o.ok) {
            failed++;
            const res = failDistillItem(local, entry, o.reason, now);
            if (res.deadLettered) {
              deadLettered++;
              process.stderr.write(
                `distill: ${o.targetId} dead-lettered after ${res.attempt} attempt(s): ${o.reason}\n`,
              );
            }
            continue;
          }
          const result = applyVerifiedDecision(
            ctxByTarget.get(o.targetId) as DistillVerifyContext,
            o.item,
            { env, now },
          );
          if (result.ok) {
            applied++;
            const label =
              result.decision === 'NOOP' && !result.reclassifiedToNoop
                ? 'noop'
                : result.decision.toLowerCase();
            process.stdout.write(
              `distill: ${o.targetId} → ${label}${result.candidateId ? ` (${result.candidateId})` : ''}${result.successorId ? ` (successor ${result.successorId})` : ''}\n`,
            );
          } else {
            failed++;
            const res = failDistillItem(local, entry, result.error, now);
            if (res.deadLettered) deadLettered++;
            process.stderr.write(`distill: ${o.targetId} apply failed: ${result.error}\n`);
          }
        }
      });
    } catch (e) {
      if (e instanceof LockBusyError) {
        process.stderr.write(`${e.message}\n`);
        return EXIT.LOCKED;
      }
      throw e;
    }
    totalApplied += applied;
    totalFailed += failed;
    totalDeadLettered += deadLettered;
    batches++;
    // Persist the zero-progress marker ONLY when nothing landed this cycle: a marker the next cycle
    // (in this run or a later one) matches against the same queue state stops the loop BEFORE the
    // provider is re-executed and before any retry is recorded. A cycle where something landed (or
    // an entry terminally dead-lettered) shrank or changed the queue, so the marker is cleared —
    // that is the within-run partial-failure resumability the enrich loop models.
    const marker: DistillState =
      applied > 0 || deadLettered > 0
        ? { lastBatchAt: now() }
        : { lastBatchId: batchId, lastBatchAt: now() };
    writeJsonAtomic(statePath, `${JSON.stringify(marker, null, 2)}\n`);
    process.stdout.write(
      `distill batch ${batches}: applied=${applied} failed=${failed} dead-lettered=${deadLettered} remaining=${pending.length - batch.length}\n`,
    );
    if (pending.length <= batch.length) {
      process.stdout.write('distill: outbox drained this cycle.\n');
      break;
    }
  }
  process.stdout.write(
    `distill: ${batches} batch(es), ${totalApplied} applied, ${totalFailed} failure(s), ${totalDeadLettered} dead-lettered.\n`,
  );
  return EXIT.OK;
}

// ─── G2.1 lane 2 — `crib memory capture-hook` (the durable capture lane hooks invoke) ──

/** stdin is hard-capped before parse: a hook payload is bounded provenance, never a transcript. */
const CAPTURE_HOOK_STDIN_MAX_CHARS = 65536;
/** session ids are hashed into the `cap:` id seed — bounded and character-restricted, never trusted verbatim. */
const CAPTURE_HOOK_SESSION_ID_MAX_CHARS = 128;
const CAPTURE_HOOK_TOOL_NAME_MAX_CHARS = 64;

/** A lifecycle hook fires inside a live coding session: this command MUST never block one.
 *  Claude Code treats a nonzero hook exit (2 in particular) as a blocking error, so every runtime
 *  failure — bad payload, unindexed repo, policy refusal, store error — degrades to stderr + EXIT.OK.
 *  Only a wiring bug (no --event) reaches the operator the same way: stderr, still exit 0. */
function cmdMemoryCaptureHook(args: string[], ctx?: CmdCtx): number {
  const failOpen = (message: string): number => {
    process.stderr.write(`capture-hook: ${message}\n`);
    return EXIT.OK;
  };
  const event = stringFlag(args, '--event') as LifecycleEvent | undefined;
  if (!event) return failOpen(`missing --event (expected one of: ${LIFECYCLE_EVENTS.join(', ')})`);
  if (!LIFECYCLE_EVENTS.includes(event)) return failOpen(`unknown lifecycle event: ${event}`);

  // Read + bound the hook payload. Only TWO fields ever cross into storage — session_id and
  // (for tool-use) tool_name; everything else (transcript paths, tool input/output, cwd) is
  // discarded here, before any capture, per the raw-transcripts-off law.
  let payload: Record<string, unknown> = {};
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw.slice(0, CAPTURE_HOOK_STDIN_MAX_CHARS));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    }
  } catch {
    return failOpen(
      'unparseable stdin payload — capturing the lifecycle event without session provenance',
    );
  }

  const rawSessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const sessionId =
    rawSessionId.length > 0
      ? rawSessionId.replace(/\s+/g, '').slice(0, CAPTURE_HOOK_SESSION_ID_MAX_CHARS)
      : undefined;
  const rawToolName =
    event === 'tool-use' && typeof payload.tool_name === 'string' ? payload.tool_name.trim() : '';
  const toolName =
    rawToolName.length > 0
      ? rawToolName.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, CAPTURE_HOOK_TOOL_NAME_MAX_CHARS)
      : undefined;
  if (event === 'tool-use' && rawToolName.length > 0 && !toolName) {
    return failOpen(
      'tool_name reduced to nothing under the bounded charset — capturing without it',
    );
  }

  const observation =
    event === 'session-start'
      ? 'coding session started (lifecycle hook)'
      : event === 'turn-end'
        ? 'session turn ended (lifecycle hook)'
        : toolName
          ? `tool-use observed (lifecycle hook): ${toolName}`
          : 'tool-use observed (lifecycle hook)';
  // Wall-clock-free dedupe key: identical (event, session, tool) fires collapse to one durable
  // outbox entry — at-least-once delivery with dedupe, not per-fire volume. Turn-level granularity
  // would need stream offsets the hook payload does not carry, so the collapse is honest.
  const idempotencyKey = `hook:${event}:${sessionId ?? 'nosession'}${toolName ? `:${toolName}` : ''}`;

  try {
    const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
    const rt = openSoul(resolved);
    const repoId = readRepoId(resolved.cribDir);
    if (!repoId)
      return failOpen(
        'repoId unresolvable — run `crib index` first (capture skipped, not blocking)',
      );
    const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
    if (!deps) return failOpen('memory stores unresolvable — capture skipped, not blocking');
    const api = createMemoryApi(rt.soul, resolved.repoRoot, resolved.cribDir, deps);
    const result = api.capture({
      subject: 'topic:session-lifecycle',
      observation,
      kind: 'fact',
      actor: 'claude-code-hook',
      tool: 'capture-hook',
      ...(sessionId !== undefined ? { sessionId } : {}),
      idempotencyKey,
    });
    if (!result.ok) return failOpen(`capture refused: ${result.error}`);
    process.stdout.write(
      `${JSON.stringify({ ok: true, event, captureId: result.id, status: result.status })}\n`,
    );
    return EXIT.OK;
  } catch (e) {
    return failOpen(`capture failed: ${(e as Error).message}`);
  }
}

// ─── P0.1 — `crib memory recall` (the protocol's documented CLI fallback) ─────────

/**
 * `crib memory recall "<query>"` — the CLI fallback the neutral agent-memory protocol names in
 * every IDE instruction file (adapters.ts `neutralProtocolBody` tells agents to call
 * `crib memory recall "<query>"`; before P0.1 that subcommand did not exist, so the documented
 * fallback was dead). Produces the SAME result the MCP `memory_recall` verb returns: the same
 * trust-tier eligibility (candidate-trust / quarantined / superseded records never surface in
 * normal recall), the same 6-criterion rank, the same team + local + global default sources, the
 * same projection shape (memories + conflicts + provenance + truncated), and the same arg semantics
 * (limit defaults to 5, capped at 20; max-tokens defaults to 1200; include-pending is opt-in and
 * returns untrusted candidates in a SEPARATE group).
 *
 * The MCP's `recallProjectionOf` is a private method of its verbs class, so the projection is
 * composed here from @knowledge-crib/memory public exports — the identical gather → disposable
 * in-memory FTS index → pure projection pipeline (verbs.ts never mixes memory BM25 with the soul's
 * code BM25, and neither does this).
 */
function cmdMemoryRecall(args: string[], ctx?: CmdCtx): number {
  // Query positionals are the search text, NOT a root (same discipline as `crib query`); root comes
  // from --cwd / env / cwd walk-up only.
  const q = positionalsOf(args).join(' ');
  if (!q) {
    process.stderr.write(
      'usage: crib memory recall "<query>" [--limit N] [--sources team,local,global] [--target <id>] [--with-evidence] [--include-pending] [--max-tokens N] [--json]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const json = args.includes('--json');
  const withEvidence = args.includes('--with-evidence');
  const includePending = args.includes('--include-pending');
  const limitRaw = intFlag(args, '--limit');
  const maxTokensRaw = intFlag(args, '--max-tokens');
  const sourcesRaw = stringFlag(args, '--sources');
  const targets = repeatedFlag(args, '--target');
  let sources: MemorySource[] | undefined;
  if (sourcesRaw !== undefined) {
    const wanted = sourcesRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const bad = wanted.filter((s) => s !== 'team' && s !== 'local' && s !== 'global');
    if (bad.length > 0) {
      process.stderr.write(
        `error: unknown source(s) ${bad.join(', ')} — --sources accepts team, local, global\n`,
      );
      return EXIT.BAD_ARGS;
    }
    if (wanted.length > 0) sources = wanted as MemorySource[];
  }
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const projection = memoryRecallProjection(deps, {
    query: q,
    ...(targets.length > 0 ? { targetIds: targets } : {}),
    ...(sources ? { sources } : {}),
  });
  // limit is the hard count cap (default 5, max 20 — same caps as memory_recall); the token budget
  // trims within the limited set.
  const limit = capInt(limitRaw, 5, 20);
  const limited = projection.memories.slice(0, limit).map((m) => memoryRecallView(m, withEvidence));
  const conflicts = projection.conflicts.map(memoryConflictView);
  const maxTokens = maxTokensRaw === undefined ? 1200 : capMaxTokens(maxTokensRaw);
  const fitted = fitTokenBudget(limited, maxTokens, (prefix) =>
    JSON.stringify({
      memories: prefix,
      conflicts,
      provenance: projection.provenance,
      budgetExhausted: true,
    }),
  );
  const result: Record<string, unknown> = {
    memories: fitted.items,
    conflicts,
    provenance: projection.provenance,
    truncated: fitted.budgetExhausted || projection.memories.length > limit,
  };
  // Opt-in, kept in its own group: `memories` stays trusted-only whatever this flag returns.
  if (includePending) result.pending = pendingMemoryCandidates(deps.local, q, limit);
  if (fitted.budgetExhausted) result.budgetExhausted = true;
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderMemoryRecall(q, result));
  return EXIT.OK;
}

/** Read an integer-valued flag (`--limit 5`), or undefined when absent / not a number. */
function intFlag(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const parsed = Number.parseInt(args[idx + 1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Read a string-valued flag (`--sources team,local`), or undefined when absent. */
function stringFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] ?? undefined) : undefined;
}

/** Collect every occurrence of a repeatable flag's value (`--target a --target b` → [a, b]). */
function repeatedFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value && !value.startsWith('-')) out.push(value);
    }
  }
  return out;
}

/**
 * Build the recall projection from the three stores — the CLI-side twin of the MCP's private
 * `recallProjectionOf`: gather → FTS5 lexical index (never mixed with the soul's code BM25) → pure
 * 6-criterion rank + conflict projection, with fresh revalidation against the live soul (the
 * evaluator + SoulStoreSoulPort are always wired by {@link createMemoryDeps}). G3.1 — the
 * persistent FTS snapshot serves the all-sources path (kept current by the store write hooks,
 * self-healing); a `--sources` filter keeps the ephemeral `:memory:` rebuild (a subset corpus
 * would rank differently — the byte-comparability invariant persistent-fts.ts pins). G3.2 — the
 * versioned scorer names its configuration on the provenance (red line #6). G3.3 — the shared
 * generation-keyed cache means recall never revalidates every record per query (red line #1).
 * The FTS handle is closed in a finally — a `:memory:` DB holds no filesystem lock, and the
 * snapshot releases its SQLite handle + write listeners.
 */
function memoryRecallProjection(
  deps: NonNullable<ReturnType<typeof createMemoryDeps>>,
  opts: { query: string; targetIds?: string[]; sources?: MemorySource[] },
): RecallProjection {
  const stores = { team: deps.team, local: deps.local, global: deps.global };
  const gathered = gatherRecall(stores, opts.sources ? { sources: opts.sources } : {});
  const fts = opts.sources ? new MemoryFtsIndex(':memory:') : openMemoryFts(stores);
  try {
    const scorer = new VersionedLexicalScorer({
      fts,
      records: gathered.records.map((r) => r.record),
      strategy: 'lexical-only',
    });
    const bound = bindEvaluationPass(deps.evalCtx, gathered);
    const projection = recallProjection(gathered, {
      query: opts.query,
      ...(opts.targetIds ? { targetIds: opts.targetIds } : {}),
      lexicalScorer: scorer,
      evaluator: deps.evaluator,
      evalCtx: bound.evalCtx ?? deps.evalCtx,
    });
    // Red line #1 — the provenance names the generation the fresh verdicts were proven current
    // against (null when no versioned dependency could be fingerprinted).
    return {
      ...projection,
      provenance: { ...projection.provenance, generation: bound.generation },
    };
  } finally {
    fts.close();
  }
}

/** A lightweight evidence pointer (kind + verdict + soul anchor) — the default recall view. */
function evidenceSummaryOf(ev: MemoryEvidence): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: ev.kind, verdict: ev.verdict };
  if (ev.soulId) out.soulId = ev.soulId;
  return out;
}

/**
 * The public recall view of one scored record: verdicts + score + evidence (summary by default,
 * full with `--with-evidence`). Same shape as the MCP `memory_recall` projection so both surfaces
 * can be consumed identically. Version-aware (Gate 1.3): a memory-1 record keeps the W3 field set;
 * a migrated memory-2 twin — which ranks when its alias snapshot restores eligibility — answers
 * with its v2 fields (visibility / propositionKey / validTime / transactionTime / lineage) instead
 * of the v1 fields the envelope no longer carries (scope / appliesTo / createdAt are undefined
 * there and were emitted as such before this fix).
 */
function memoryRecallView(m: ScoredRecord, withEvidence?: boolean): Record<string, unknown> {
  const r = m.record as MemoryRecord | MemoryRecordV2;
  const base: Record<string, unknown> = {
    id: r.id,
    subject: r.subject,
    claim: r.claim,
    source: m.source,
    trust: m.verdicts.trust,
    evidence: m.verdicts.evidence,
    applicability: m.verdicts.applicability,
    lifecycle: m.verdicts.lifecycle,
    score: m.score,
    evidenceItems: withEvidence === true ? r.evidence : r.evidence.map((e) => evidenceSummaryOf(e)),
  };
  if (isMemoryRecordV2(r)) {
    return {
      ...base,
      schemaVersion: '2',
      visibility: r.visibility,
      propositionKey: r.propositionKey,
      validTime: r.validTime,
      transactionTime: r.transactionTime,
      lineage: r.lineage,
    };
  }
  return {
    ...base,
    scope: r.scope,
    appliesTo: r.appliesTo,
    createdAt: r.createdAt,
  };
}

/** A conflict-group view: the shared key + subject + scope + the member record ids. */
function memoryConflictView(g: ConflictGroup): Record<string, unknown> {
  return {
    key: g.key,
    subject: g.subject,
    scope: g.scope,
    recordIds: g.records.map((r) => r.id),
  };
}

/**
 * Untrusted, in-flight observations from the LOCAL candidate pool (`--include-pending`) — the
 * shared working set for a swarm of agents on one repository. The trust model deliberately hides
 * these from normal recall (a claim becomes trusted by passing a gate, never by an agent writing it
 * down), so they are returned in a SEPARATE group, never merged into `memories`, every entry
 * stamped `trust: 'untrusted'` + `status: 'pending'` — a lead, not an established fact.
 */
function pendingMemoryCandidates(
  local: MemoryStore,
  query: string,
  limit: number,
): Array<Record<string, unknown>> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
  const out: Array<{ score: number; view: Record<string, unknown> }> = [];
  for (const entry of local.readCollection('candidates').entries) {
    const rec = entry as unknown as Record<string, unknown>;
    const claim = String(rec.claim ?? '');
    const subject = String(rec.subject ?? '');
    const haystack = `${subject} ${claim}`.toLowerCase();
    const score = terms.length === 0 ? 1 : terms.filter((t) => haystack.includes(t)).length;
    if (score === 0) continue;
    out.push({
      score,
      view: {
        id: rec.id,
        kind: rec.kind,
        subject,
        claim,
        // MemoryCandidate ships the actor at `authorship.actor` (memory-1 schema); the id is
        // content-addressed over the same field, so this is the only place attribution lives.
        actor: (rec.authorship as { actor?: string } | undefined)?.actor,
        // Stated on every entry, not just in the group name, because a single view can be copied
        // out of its group and lose that context.
        trust: 'untrusted',
        status: 'pending',
      },
    });
  }
  return out
    .sort((a, b) => b.score - a.score || String(a.view.id).localeCompare(String(b.view.id)))
    .slice(0, limit)
    .map((x) => x.view);
}

/** Render the recall result as human-readable lines (the `--json` flag switches to the raw shape). */
function renderMemoryRecall(query: string, result: Record<string, unknown>): string {
  const prov = result.provenance as RecallProvenance;
  const memories = result.memories as Array<Record<string, unknown>>;
  const conflicts = result.conflicts as Array<Record<string, unknown>>;
  const pending = (result.pending as Array<Record<string, unknown>> | undefined) ?? [];
  const lines: string[] = [
    `memory recall "${query}" — ${memories.length} memories (considered ${prov.counts.considered}, eligible ${prov.counts.eligible}, conflicts ${prov.counts.conflicts}, team=${prov.counts.team} local=${prov.counts.local} global=${prov.counts.global}, fresh=${prov.fresh})`,
  ];
  if (memories.length === 0) lines.push('  no eligible memories matched');
  memories.forEach((m, i) => {
    const sc = m.score as RecallScore;
    lines.push(
      `  ${i + 1}. ${String(m.id)} [${String(m.source)}] trust=${String(m.trust)} evidence=${String(m.evidence)} applicability=${String(m.applicability)} lifecycle=${String(m.lifecycle)}`,
    );
    lines.push(`     ${String(m.claim)}`);
    lines.push(
      `     subject=${String(m.subject)} score lex=${sc.lexical} source=${sc.sourceTier} evidence=${sc.evidenceQuality} feedback=${sc.feedbackAdjust}`,
    );
  });
  if (conflicts.length > 0) {
    lines.push(`conflicts (${conflicts.length}):`);
    for (const g of conflicts) {
      lines.push(
        `  - subject ${String(g.subject)} / scope ${JSON.stringify(g.scope)}: ${(g.recordIds as string[]).join(', ')}`,
      );
    }
  }
  if (pending.length > 0) {
    lines.push(`pending — untrusted candidate leads, never established facts (${pending.length}):`);
    for (const p of pending) {
      lines.push(`  - ${String(p.id)} [${String(p.actor ?? 'unknown')}] ${String(p.claim)}`);
    }
  }
  if (result.truncated === true) {
    lines.push(
      `truncated: ${prov.counts.eligible - memories.length} more eligible (raise --limit)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── Gate 1.3 — `crib memory search|get|supersede|delete|history` (the portable API surface) ──

/**
 * Parse the shared `--sources team,local,global` flag (recall + search). Returns an error string
 * for an unknown name so both commands print the same message; undefined sources = all three.
 */
function memorySourcesFlag(args: string[]): { sources?: MemorySource[]; error?: string } {
  const raw = stringFlag(args, '--sources');
  if (raw === undefined) return {};
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const bad = wanted.filter((s) => s !== 'team' && s !== 'local' && s !== 'global');
  if (bad.length > 0) {
    return { error: `unknown source(s) ${bad.join(', ')} — --sources accepts team, local, global` };
  }
  return wanted.length > 0 ? { sources: wanted as MemorySource[] } : {};
}

/** The G1.3 search-hit view — the SAME projection the MCP `memory{op:'search'}` verb returns. */
function memorySearchHitView(h: SearchHit, withEvidence?: boolean): Record<string, unknown> {
  const view = memoryRecallView(
    {
      // ScoredRecord.record is typed MemoryRecord but a migrated twin is v2 at runtime — the same
      // widening recallProjection itself relies on; memoryRecallView narrows via isMemoryRecordV2.
      record: h.record as MemoryRecord,
      source: h.placement[0] ?? 'team',
      verdicts: h.verdicts,
      score: h.score,
    },
    withEvidence,
  );
  return {
    ...view,
    schemaVersion: h.schemaVersion,
    verdicts: h.verdicts,
    visibility: h.visibility,
    ...(h.propositionKey !== undefined ? { propositionKey: h.propositionKey } : {}),
    ...(h.scope !== undefined ? { scope: h.scope } : {}),
    placement: h.placement,
    lineage: h.lineage,
    freshness: h.freshness,
    validity: h.validity,
    rankingVersion: h.rankingVersion,
    conflicts: h.conflicts,
    supersededBy: h.supersededBy,
  };
}

/**
 * `crib memory search "<query>"` — the portable API's rich search. `--json` mirrors the MCP
 * `memory{op:'search'}` response byte-for-byte in shape (query + hits + conflicts + provenance +
 * truncated); the default render is human-readable. The projection is DELEGATED to
 * {@link MemoryApi.search} with the same disposable in-memory FTS lexical scorer `recall` builds,
 * so the two read commands can never rank differently.
 */
function cmdMemorySearch(args: string[], ctx?: CmdCtx): number {
  const q = positionalsOf(args).join(' ');
  const json = args.includes('--json');
  const withEvidence = args.includes('--with-evidence');
  const limitRaw = intFlag(args, '--limit');
  const maxTokensRaw = intFlag(args, '--max-tokens');
  const targets = repeatedFlag(args, '--target');
  const { sources, error } = memorySourcesFlag(args);
  if (error !== undefined) {
    process.stderr.write(`error: ${error}\n`);
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const api = createMemoryApi(rt.soul, resolved.repoRoot, resolved.cribDir, deps);
  // G3.1 — the persistent FTS snapshot gives search the same lexical signal `recall` ranks with
  // without the O(N) per-query rebuild (kept current by the store write hooks, self-healing); a
  // `--sources` filter keeps the ephemeral rebuild (a subset corpus would rank differently — the
  // byte-comparability invariant). G3.2 — the versioned scorer names its configuration on the
  // provenance (red line #6). api.search gathers internally, so this double-gather is the accepted
  // cost of not widening the package's search signature for the adapter (same trade the MCP verb
  // makes).
  const gathered = gatherRecall(
    { team: deps.team, local: deps.local, global: deps.global },
    sources ? { sources } : {},
  );
  const fts = sources
    ? new MemoryFtsIndex(':memory:')
    : openMemoryFts({ team: deps.team, local: deps.local, global: deps.global });
  let response: SearchResponse;
  try {
    const scorer = new VersionedLexicalScorer({
      fts,
      records: gathered.records.map((r) => r.record),
      strategy: 'lexical-only',
    });
    response = api.search(q, {
      ...(targets.length > 0 ? { targetIds: targets } : {}),
      ...(sources ? { sources } : {}),
      lexicalScorer: scorer,
    });
  } finally {
    fts.close();
  }
  const limit = capInt(limitRaw, 5, 20);
  const hits = response.hits.slice(0, limit).map((h) => memorySearchHitView(h, withEvidence));
  const maxTokens = maxTokensRaw === undefined ? 2000 : capMaxTokens(maxTokensRaw);
  const fitted = fitTokenBudget(hits, maxTokens, (prefix) =>
    JSON.stringify({ hits: prefix, truncated: true, budgetExhausted: true }),
  );
  const result: Record<string, unknown> = {
    query: q,
    hits: fitted.items,
    conflicts: response.conflicts,
    provenance: response.provenance,
    truncated: fitted.budgetExhausted || response.hits.length > limit,
  };
  if (fitted.budgetExhausted) result.budgetExhausted = true;
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderMemorySearch(q, result));
  return EXIT.OK;
}

/** Render the search result as human-readable lines (the `--json` flag switches to the raw shape). */
function renderMemorySearch(query: string, result: Record<string, unknown>): string {
  const prov = result.provenance as SearchResponse['provenance'];
  const hits = result.hits as Array<Record<string, unknown>>;
  const conflicts = result.conflicts as unknown[];
  const lines: string[] = [
    `memory search "${query}" — ${hits.length} hits (considered ${prov.counts.considered}, eligible ${prov.counts.eligible}, conflicts ${prov.counts.conflicts}, team=${prov.counts.team} local=${prov.counts.local} global=${prov.counts.global})`,
  ];
  if (hits.length === 0) lines.push('  no eligible memories matched');
  hits.forEach((h, i) => {
    const sc = h.score as RecallScore;
    const v = h.verdicts as { trust: string; evidence: string; applicability: string };
    const placement = (h.placement as string[]).join(',');
    lines.push(
      `  ${i + 1}. ${String(h.id)} [${placement}] schemaVersion=${String(h.schemaVersion)} trust=${v.trust} evidence=${v.evidence} applicability=${v.applicability}`,
    );
    lines.push(`     ${String(h.claim)}`);
    lines.push(
      `     subject=${String(h.subject)} score lex=${sc.lexical} source=${sc.sourceTier} evidence=${sc.evidenceQuality} feedback=${sc.feedbackAdjust} valid-from=${(h.validity as { from: string }).from}`,
    );
  });
  if (conflicts.length > 0) lines.push(`conflicts (${conflicts.length})`);
  if (result.truncated === true) lines.push('truncated: more eligible hits (raise --limit)');
  return `${lines.join('\n')}\n`;
}

/**
 * `crib memory get <id>` — the portable API's single-record read. Version-aware: a memory-1 record
 * answers with the W3 field set; a memory-2 record with its v2 fields, and a legacy id resolves
 * through the alias map to the migrated twin. `--json` mirrors the MCP `memory{op:'get'}` response
 * shape exactly.
 */
function cmdMemoryGet(args: string[], ctx?: CmdCtx): number {
  const id = positionalsOf(args)[0];
  if (!id) {
    process.stderr.write('usage: crib memory get <id> [--with-evidence] [--json]\n');
    return EXIT.BAD_ARGS;
  }
  const json = args.includes('--json');
  const withEvidence = args.includes('--with-evidence');
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const api = createMemoryApi(rt.soul, resolved.repoRoot, resolved.cribDir, deps);
  const got = api.get(id);
  if (!got.found || !got.record || !got.source) {
    if (json) process.stdout.write(`${JSON.stringify({ found: false, id }, null, 2)}\n`);
    else process.stdout.write(`memory get ${id} — not found in any store\n`);
    return EXIT.ERROR;
  }
  const record = got.record;
  const evidence =
    withEvidence === true ? record.evidence : record.evidence.map((e) => evidenceSummaryOf(e));
  let result: Record<string, unknown>;
  if (!isMemoryRecordV2(record)) {
    // Memory-1: the W3 response contract, byte-identical in shape to the MCP verb (the supersededBy
    // link rides on decisions and is surfaced only when one exists).
    result = {
      id: record.id,
      subject: record.subject,
      claim: record.claim,
      scope: record.scope,
      appliesTo: record.appliesTo,
      authorship: record.authorship,
      verdicts: record.verdicts,
      source: got.source,
      createdAt: record.createdAt,
      evidence,
      ...(got.supersededBy && got.supersededBy.length > 0
        ? { supersededBy: got.supersededBy }
        : {}),
    };
  } else {
    // Memory-2: effective (alias-restored) verdicts, visibility, the bi-temporal validity interval,
    // lineage and placement — never the v1 fields the envelope no longer carries.
    result = {
      id: record.id,
      requestedId: got.requestedId,
      ...(got.resolvedViaAlias ? { resolvedViaAlias: got.resolvedViaAlias.legacyId } : {}),
      schemaVersion: '2',
      kind: record.kind,
      subject: record.subject,
      claim: record.claim,
      visibility: got.visibility,
      propositionKey: record.propositionKey,
      sensitivity: record.sensitivity,
      retentionPolicyId: record.retentionPolicyId,
      provenance: record.provenance,
      validity: got.validity,
      lineage: got.lineage,
      verdicts: got.verdicts,
      source: got.source,
      placement: got.placement,
      legacyIds: got.legacyIds,
      supersededBy: got.supersededBy,
      evidence,
    };
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderMemoryGet(id, result));
  return EXIT.OK;
}

/** Render one fetched record as human-readable lines. */
function renderMemoryGet(requested: string, result: Record<string, unknown>): string {
  const lines: string[] = [`memory get ${requested}`];
  if (result.resolvedViaAlias !== undefined) {
    lines.push(`  resolved via alias: legacy id ${String(result.resolvedViaAlias)}`);
  }
  lines.push(`  id=${String(result.id)} source=${String(result.source)}`);
  lines.push(`  ${String(result.claim)}`);
  lines.push(`  subject=${String(result.subject)}`);
  const v = result.verdicts as Record<string, unknown> | undefined;
  if (v) {
    lines.push(
      `  trust=${String(v.trust)} evidence=${String(v.evidence)} applicability=${String(v.applicability)} lifecycle=${String(v.lifecycle)}`,
    );
  }
  if (result.schemaVersion === '2') {
    lines.push(
      `  schemaVersion=2 visibility=${String(result.visibility)} propositionKey=${String(result.propositionKey)}`,
    );
    lines.push(`  placement=${(result.placement as string[]).join(',')}`);
  } else {
    lines.push(`  createdAt=${String(result.createdAt)}`);
  }
  const supersededBy = result.supersededBy as unknown[] | undefined;
  if (supersededBy !== undefined && supersededBy.length > 0) {
    lines.push(`  superseded by ${supersededBy.length} successor(s)`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `crib memory supersede <id> --actor <id> (--successor <id> | --claim <text>)` — retire a record
 * in favour of a successor. `--successor` names an EXISTING record; `--claim` (with optional
 * --subject/--kind/--visibility/--proposition-key) writes a NEW memory-2 successor. The superseded
 * line is never rewritten — the lifecycle change is an appended decision. Delegates to
 * {@link MemoryApi.supersede}; `--json` mirrors the MCP response shape.
 */
function cmdMemorySupersede(args: string[], ctx?: CmdCtx): number {
  const id = positionalsOf(args)[0];
  const actor = stringFlag(args, '--actor');
  const successor = stringFlag(args, '--successor');
  const claim = stringFlag(args, '--claim');
  const subject = stringFlag(args, '--subject');
  const kind = stringFlag(args, '--kind');
  const visibility = stringFlag(args, '--visibility');
  const propositionKey = stringFlag(args, '--proposition-key');
  const reason = stringFlag(args, '--reason');
  const tool = stringFlag(args, '--tool');
  const json = args.includes('--json');
  if (!id || !actor || (successor === undefined && claim === undefined)) {
    process.stderr.write(
      'usage: crib memory supersede <id> --actor <id> (--successor <id> | --claim <text> [--subject <id>] [--kind <kind>] [--visibility private|workspace] [--proposition-key <key>]) [--reason <text>] [--tool <name>] [--json]\n',
    );
    return EXIT.BAD_ARGS;
  }
  if (visibility !== undefined && visibility !== 'private' && visibility !== 'workspace') {
    process.stderr.write('error: --visibility must be private or workspace\n');
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const api = createMemoryApi(rt.soul, resolved.repoRoot, resolved.cribDir, deps);
  const by: string | SupersedePayload =
    successor !== undefined
      ? successor
      : {
          claim: claim ?? '',
          ...(subject !== undefined ? { subject } : {}),
          ...(kind !== undefined ? { kind: kind as MemoryRecordKind } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
          ...(propositionKey !== undefined ? { propositionKey } : {}),
        };
  const result = api.supersede(id, by, {
    actor,
    ...(reason !== undefined ? { reason } : {}),
    ...(tool !== undefined ? { tool } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`error: ${result.error}\n`);
    return EXIT.ERROR;
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `superseded ${result.supersededId} -> successor ${result.successorId} (decision ${result.decisionId}, store ${result.decisionSource}${result.successorCreated ? '' : ', successor already existed'})\n`,
    );
  }
  return EXIT.OK;
}

/**
 * `crib memory delete <id> --actor <id>` — a tombstone, never a removal (memory is append-only).
 * Resolves legacy ids through the alias map. Delegates to {@link MemoryApi.delete}.
 */
function cmdMemoryDelete(args: string[], ctx?: CmdCtx): number {
  const id = positionalsOf(args)[0];
  const actor = stringFlag(args, '--actor');
  const reason = stringFlag(args, '--reason');
  const json = args.includes('--json');
  if (!id || !actor) {
    process.stderr.write(
      'usage: crib memory delete <id> --actor <id> [--reason <text>] [--json]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const api = createMemoryApi(rt.soul, resolved.repoRoot, resolved.cribDir, deps);
  const result = api.delete(id, {
    actor,
    ...(reason !== undefined ? { reason } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`error: ${result.error}\n`);
    return EXIT.ERROR;
  }
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `tombstoned ${result.id} (decision ${result.decisionId}, store ${result.decisionSource}) — the record line stays; recall excludes it, history/audit still see it\n`,
    );
  }
  return EXIT.OK;
}

/** The G1.3 history view of one believed record — the MCP `memory{op:'history'}` per-record shape. */
function memoryRecordBeliefView(b: RecordBelief, withEvidence?: boolean): Record<string, unknown> {
  return {
    id: b.id,
    schemaVersion: b.schemaVersion,
    subject: b.subject,
    claim: b.claim,
    recordedAt: b.recordedAt,
    validTime: b.validTime,
    lifecycle: b.lifecycle,
    quarantined: b.quarantined,
    ...(b.validTimeHolds !== undefined ? { validTimeHolds: b.validTimeHolds } : {}),
    ...(b.validTimeWindow !== undefined ? { validTimeWindow: b.validTimeWindow } : {}),
    placement: b.placement,
    legacy: b.legacy,
    evidence:
      withEvidence === true
        ? b.record.evidence
        : b.record.evidence.map((e) => evidenceSummaryOf(e)),
  };
}

/**
 * `crib memory history <key>` — the bi-temporal belief timeline for one key (a record id, a legacy
 * id, a subject, or a proposition key). `--as-of <iso>` projects a point-in-time read: only records
 * recorded ≤ asOf and decision events with ts ≤ asOf — what was BELIEVED then, never a rewrite.
 * Delegates to {@link MemoryApi.history}; `--json` mirrors the MCP response shape.
 */
function cmdMemoryHistory(args: string[], ctx?: CmdCtx): number {
  const key = positionalsOf(args)[0];
  if (!key) {
    process.stderr.write(
      'usage: crib memory history <key> [--as-of <iso-ts>] [--with-evidence] [--json]\n',
    );
    return EXIT.BAD_ARGS;
  }
  const json = args.includes('--json');
  const withEvidence = args.includes('--with-evidence');
  const asOf = stringFlag(args, '--as-of');
  const resolved = resolveProjectRoot({ explicitRoot: ctx?.cwdOverride });
  const rt = openSoul(resolved);
  const deps = createMemoryDeps(rt.soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  const api = createMemoryApi(rt.soul, resolved.repoRoot, resolved.cribDir, deps);
  let result: ReturnType<MemoryApi['history']>;
  try {
    result = api.history(key, asOf !== undefined ? { asOf } : {});
  } catch (err) {
    // An unparseable --as-of is a REJECTED argument — reported honestly, never a silently
    // mis-filtered timeline (the API normalizes asOf once and throws on garbage).
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }
  const payload = {
    key: result.key,
    ...(result.asOf !== undefined ? { asOf: result.asOf } : {}),
    records: result.records.map((b) => memoryRecordBeliefView(b, withEvidence)),
    events: result.events,
  };
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(renderMemoryHistory(payload));
  return EXIT.OK;
}

/** Render the belief timeline as human-readable lines. */
function renderMemoryHistory(result: Record<string, unknown>): string {
  const records = result.records as Array<Record<string, unknown>>;
  const events = result.events as Array<Record<string, unknown>>;
  const lines: string[] = [
    `memory history ${String(result.key)}${result.asOf !== undefined ? ` (as of ${String(result.asOf)})` : ''} — ${records.length} record(s), ${events.length} event(s)`,
  ];
  for (const r of records) {
    lines.push(
      `  - ${String(r.id)} schemaVersion=${String(r.schemaVersion)} lifecycle=${String(r.lifecycle)} quarantined=${String(r.quarantined)}${r.validTimeHolds !== undefined ? ` validTimeHolds=${String(r.validTimeHolds)}` : ''}`,
    );
    lines.push(`      ${String(r.claim)}`);
  }
  for (const e of events) {
    lines.push(
      `  * ${String(e.at)} ${String(e.type)} record=${String(e.recordId)} source=${String(e.source)}${'actor' in e ? ` actor=${String(e.actor)}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
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

/**
 * `crib memory bench [--fast] [--json] [--out <path>]` — the P0 memory benchmark (the ruler every
 * phase measures against): recall relevance (exact vs word-disjoint paraphrase), refactor survival,
 * cross-writer dedupe + conflict surfacing, trust-gradient discipline, and the per-phase latency
 * curve over real stores. `--fast` shrinks the corpus for a quick smoke; the default publishes the
 * 10k-record scale. Each scenario runs against a throwaway store directory — never the repo's.
 */
function cmdMemoryBench(args: string[], ctx?: CmdCtx): number {
  const json = args.includes('--json');
  const fast = args.includes('--fast');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : undefined;
  const report = runMemoryBench(fast ? BENCH_SCALE_FAST : BENCH_SCALE_DEFAULT, {
    now: () => new Date().toISOString(),
  });
  if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      `${formatBenchReport(report)}\n${outPath ? `report saved → ${outPath}\n` : ''}`,
    );
  }
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
  // W5 Slice 2: if the candidate's content is ALREADY team-trusted (its would-be `mem:` id is in the
  // trusted ref with an accept decision), do NOT re-run the gate or create a local active duplicate —
  // the team record is the live memory. Tombstone any stale local active copy for the same id and stop.
  // No git / no trusted ref ⇒ team trust is not derivable ⇒ proceed with a normal local evaluation.
  const wouldBeRecordId = candidate.id.replace(/^cand:/, 'mem:');
  const tp = resolveTrustedPresence(resolved.repoRoot, resolved.cribDir);
  if (tp && isTeamTrustedRecord(wouldBeRecordId, tp.presence)) {
    tombstoneLocalForTeamPromotion(deps.local, wouldBeRecordId, 'evaluate', () =>
      new Date().toISOString(),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          recordId: wouldBeRecordId,
          trust: 'team',
          alreadyTeamTrusted: true,
          trustedRef: tp.ref,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
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
  // W5 Slice 2: if the record is ALREADY team-trusted (its id is in the trusted ref with an accept
  // decision), re-proposing is a no-op — report idempotence and stop (PRD line 347). No git / no
  // trusted ref ⇒ proceed with a normal team proposal (it will be `newly-proposed` until merge).
  const tp = resolveTrustedPresence(resolved.repoRoot, resolved.cribDir);
  if (tp && isTeamTrustedRecord(record.id, tp.presence)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          recordId: record.id,
          receiptId,
          decisionId: decisionId({
            kind: 'accept',
            subject: record.id,
            actor: 'cli',
            reason: 'team proposal accepted (idempotent by content id)',
          }),
          trust: 'team',
          alreadyTeamTrusted: true,
          trustedRef: tp.ref,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
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

/**
 * Resolve the trusted-ref presence for the working repo (W5 Slice 2). Returns `undefined` when there is
 * no git work tree, no trusted ref configured, or the ref does not resolve — in all those cases team
 * trust is not derivable and tombstoning is a no-op. The trusted ref comes from the working-tree
 * policy's `trustedRef` field, overridden by `KCRIB_TRUSTED_REF`.
 */
function resolveTrustedPresence(
  repoRoot: string,
  cribDir: string,
): { ref: string; presence: TrustedTeamPresence | undefined } | undefined {
  if (!isGitRepo(repoRoot)) return undefined;
  const policy = loadPolicy(cribDir);
  const ref = trustedRefOf(policy) ?? process.env.KCRIB_TRUSTED_REF;
  if (!ref) return undefined;
  const presence = buildTrustedPresence(repoRoot, ref);
  return { ref, presence };
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

/**
 * `crib memory feedback <mem-id> --signal <useful|unhelpful|contradicted> [--actor <id>]
 *   [--context <text>] [--counter-evidence <json-file>]` (W5 Slice 3, PRD line 241 + W5 line 361).
 *
 * Records a LOCAL feedback event on a memory record by id (content-addressed → idempotent). For a
 * `contradicted` signal, the record is quarantined LOCALLY only when supported by admissible
 * counter-evidence (a counter-evidence item whose kind is admissible for the record's claim kind AND
 * whose verdict is `valid`); otherwise it takes a bounded penalty and is surfaced for review
 * (`crib memory audit` lists it under `contradictedForReview`). The quarantine decision is LOCAL-ONLY
 * (one negative event cannot retract team memory). The CLI never runs an evaluation gate here —
 * `--counter-evidence` supplies pre-checked evidence items (kind + verdict); the suppression verdict is
 * a pure decision over those items.
 */
function cmdMemoryFeedback(args: string[], ctx?: CmdCtx): number {
  const signalIdx = args.indexOf('--signal');
  const signal = signalIdx >= 0 ? args[signalIdx + 1] : undefined;
  const actorIdx = args.indexOf('--actor');
  const actor = actorIdx >= 0 ? args[actorIdx + 1] : undefined;
  const contextIdx = args.indexOf('--context');
  const context = contextIdx >= 0 ? args[contextIdx + 1] : undefined;
  const ceIdx = args.indexOf('--counter-evidence');
  const ceFile = ceIdx >= 0 ? args[ceIdx + 1] : undefined;
  // strip value-taking flags + their values so the positional <mem-id> resolves cleanly
  const stripped = args.filter(
    (_, i) =>
      i !== signalIdx &&
      i !== signalIdx + 1 &&
      i !== actorIdx &&
      i !== actorIdx + 1 &&
      i !== contextIdx &&
      i !== contextIdx + 1 &&
      i !== ceIdx &&
      i !== ceIdx + 1,
  );
  const subject = stripped.find((a) => !a.startsWith('-'));
  if (!subject) {
    process.stderr.write(
      'usage: crib memory feedback <mem-id> --signal <useful|unhelpful|contradicted> [--actor <id>] [--context <text>] [--counter-evidence <json-file>]\n',
    );
    return EXIT.BAD_ARGS;
  }
  if (!signal || !isFeedbackSignal(signal)) {
    process.stderr.write(
      `error: --signal must be one of useful, unhelpful, contradicted (got '${signal ?? ''}')\n`,
    );
    return EXIT.BAD_ARGS;
  }
  if (!actor) {
    process.stderr.write('error: --actor is required\n');
    return EXIT.BAD_ARGS;
  }
  const resolved = resolveRoot(stripped, ctx);
  const deps = createMemoryDeps(openSoul(resolved).soul, resolved.repoRoot, resolved.cribDir);
  if (!deps) {
    process.stderr.write('could not resolve repoId for memory — run `crib index` first\n');
    return EXIT.NOT_INDEXED;
  }
  // resolve the record (team records → local active → global records) to learn its claim kind for
  // counter-evidence admissibility. A missing record is still recorded as feedback (the signal stands
  // for when the record appears), but admissibility cannot be checked → no suppression.
  const claimKind = findRecordKind(deps, subject);
  let counterEvidence: MemoryEvidence[] = [];
  if (ceFile) {
    try {
      const parsed = JSON.parse(readFileSync(ceFile, 'utf8')) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      counterEvidence = arr as MemoryEvidence[];
    } catch (err) {
      process.stderr.write(
        `error: could not read --counter-evidence file: ${(err as Error).message}\n`,
      );
      return EXIT.BAD_ARGS;
    }
  }
  const result = applyContradictedFeedback(deps.local, {
    record: { id: subject, kind: claimKind ?? 'fact' },
    feedback: {
      id: '',
      schemaVersion: '1',
      signal,
      subject,
      actor,
      ...(context ? { context } : {}),
      ts: new Date().toISOString(),
    },
    counterEvidence: claimKind ? counterEvidence : [],
    now: () => new Date().toISOString(),
  });
  const summary: Record<string, unknown> = {
    feedbackId: result.feedbackId,
    subject,
    signal,
    suppressed: result.suppression.suppress,
    ...(result.suppression.suppress
      ? { quarantineDecisionId: result.suppression.decision.id }
      : { surfacedForReview: result.suppression.surfacedForReview }),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return EXIT.OK;
}

/** Find a memory record's claim kind across the team / local / global stores (for feedback admissibility). */
function findRecordKind(
  deps: NonNullable<ReturnType<typeof createMemoryDeps>>,
  id: string,
): MemoryRecordKind | undefined {
  for (const r of deps.team.readCollection('records').entries as MemoryRecord[]) {
    if (r.id === id) return r.kind;
  }
  for (const r of deps.local.readCollection('active').entries as MemoryRecord[]) {
    if (r.id === id) return r.kind;
  }
  for (const r of deps.global.readCollection('records').entries as MemoryRecord[]) {
    if (r.id === id) return r.kind;
  }
  return undefined;
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
  const teamRecords = deps.team.readCollection('records').entries as Array<
    MemoryRecord | MemoryRecordV2
  >;
  const subjects = new Map<string, number>();
  for (const r of teamRecords) subjects.set(r.subject, (subjects.get(r.subject) ?? 0) + 1);
  const conflicts = [...subjects.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  // Trust distribution via EFFECTIVE verdicts (Gate 1.3): a memory-2 record carries no `verdicts`
  // of its own — the raw `r.verdicts.trust` read crashed the audit on any migrated ledger. Its
  // axes are restored from the alias map exactly like recallProjection does (the conservative
  // snapshot + decisions bridged from every bound legacy id, team/global decisions authoritative
  // per the no-poison rule), so the audit tally agrees with recall instead of demoting a
  // migrated record to trust 'candidate'. Memory-1 records keep their stamped verdicts.
  const gathered = gatherRecall({ team: deps.team, local: deps.local, global: deps.global });
  const aliasIndex = buildAliasIndex(gathered.aliases ?? []);
  const trust: Record<string, number> = {};
  for (const r of teamRecords) {
    let axis: string;
    if (isMemoryRecordV2(r)) {
      const bound = aliasIndex.aliasesFor(r.id);
      const decs =
        bound.length > 0 ? bridgedDecisions(bound, r.id, gathered.decisions) : gathered.decisions;
      axis = effectiveVerdicts(r, decs, undefined, conservativeVerdicts(bound)).trust;
    } else {
      axis = r.verdicts.trust;
    }
    trust[axis] = (trust[axis] ?? 0) + 1;
  }
  let repaired = false;
  const tombstoned: string[] = [];
  const tombstoneDecisions: string[] = [];
  let trustedRef: string | undefined;
  if (repair) {
    // recompute the local manifest counts from shards (the conservative repair — no data is deleted)
    deps.local.persistManifest();
    repaired = true;
    // W5 Slice 2: tombstone local active records whose content is now team-trusted (PRD W5). A local
    // copy whose exact id is in the trusted ref (record + accept decision) is redundant — recall would
    // surface both the team and the local record for the same id. Retire the local copy: remove it from
    // `active` + append a local `supersede` decision (audit-only; recall never gathers local decisions,
    // so it cannot poison the same-id team record). No git / no trusted ref → nothing to tombstone.
    const tp = resolveTrustedPresence(resolved.repoRoot, resolved.cribDir);
    trustedRef = tp?.ref;
    if (tp) {
      const localActive = deps.local.readCollection('active').entries as MemoryRecord[];
      for (const r of localRecordsToTombstone(localActive, tp.presence)) {
        const res = tombstoneLocalForTeamPromotion(deps.local, r.id, 'audit', () =>
          new Date().toISOString(),
        );
        tombstoned.push(r.id);
        tombstoneDecisions.push(res.decisionId);
      }
      // counts changed (active −, decisions +) — recompute the manifest after tombstoning
      deps.local.persistManifest();
    }
  }
  // W5 Slice 3 — surface contradicted-for-review records (PRD W5 line 361: "surface it for review").
  // A `contradicted` feedback whose subject is NOT quarantined took only the bounded penalty and awaits
  // admissible counter-evidence; a quarantined subject is already suppressed. The quarantine is LOCAL-ONLY.
  const localFeedback = deps.local.readCollection('feedback').entries as MemoryFeedback[];
  const localQuarantineSubjects = quarantinedRecordIds(
    deps.local.readCollection('decisions').entries as MemoryDecision[],
  );
  const localActiveIds = new Set(
    (deps.local.readCollection('active').entries as MemoryRecord[]).map((r) => r.id),
  );
  let quarantined = 0;
  for (const id of localQuarantineSubjects) if (localActiveIds.has(id)) quarantined += 1;
  const contradictedForReviewList = contradictedForReview(
    localFeedback,
    localQuarantineSubjects,
  ).map((fb) => ({
    subject: fb.subject,
    actor: fb.actor,
    ts: fb.ts,
    ...(fb.context ? { context: fb.context } : {}),
  }));
  process.stdout.write(
    `${JSON.stringify(
      {
        totalEntries,
        invalid,
        conflicts,
        trust,
        perStore,
        feedback: { quarantined, contradictedForReview: contradictedForReviewList },
        ...(repair
          ? { repaired, tombstoned, tombstoneDecisions, ...(trustedRef ? { trustedRef } : {}) }
          : {}),
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
      '  crib index [path] [--crib-dir <absolute-path>] [--semantic] [--exclude a,b,...] [--package <name|all>...]     full index → .crib soul + derived index (+ INFERRED embedding-cosine semantic links); --package scopes to one monorepo package (list detected with no --package)',
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
      '  crib serve [path] [--crib-dir <absolute-path>] [--watch]              run the MCP server on stdio (resolves root: arg/--cwd/KCRIB_ROOT/CLAUDE_PROJECT_DIR/walk/cwd); --watch overlays dirty/untracked files in memory so edits are queryable without dirtying .crib/graph',
      '  crib update [path] [--crib-dir <absolute-path>] [--since <sha>] [--dirty] [--package <name>]  incremental re-extract since the VCS anchor; --dirty includes working-tree changes without advancing vcsHead; --package scopes to one package of a monorepo without advancing the shared anchor if other packages changed too',
      '  crib reindex [path] [--crib-dir <absolute-path>] [--package <name|all>...]     full re-index (alias for `crib index`; --package scopes to one monorepo package)',
      '  crib migrate-graph [path] [--dry-run]     move legacy nodes/edges/llm into canonical .crib/graph',
      '  crib materialize [path]                   build derived composite graph.json + sqlite',
      '  crib merge-driver %O %A %B %P            git custom merge driver for .crib chunks',
      '  crib install-hooks [path]                wire post-commit + .gitattributes + merge driver',
      '  crib export [--format F] [--procedure P] [--extracted-only] [--redact|--no-redact] render graph: rules|mermaid|graph.json|report|llm',
      '  crib viz [path] [--port N]               serve the offline web UI (Claude Design DC graph) + open browser',
      '  crib enrich [path] [--budget-tokens N]    semantic work queue; --next (token-packed batch) | run --provider <name> [--max-tokens N --max-batches N --concurrency N] | --auto [--provider <name>] | --save <file> | --overview | --scopes | --prune-stale [--apply]',
      '  crib memory <init|evaluate|activate|propose|attest>   trusted agent-memory promotion: init policy | evaluate <cand> --profile <name> | activate <cand> | propose <mem-id> | attest <cand> (TTY)',
      '  crib audit-llm [path]                    re-verify every LLM artifact against the soul (grounding moat); exits non-zero on ungrounded/drift',
      '  crib mcp <install|list|remove> [--ide <claude|cursor|vscode|codex|windsurf|gemini|all>] [--global] [--bin <path>] [path]',
      '                                          auto-wire the MCP server into each IDE config (REQ-2)',
      '  crib adapters <install|list|remove> [--client <id|all>] [--scope project|global]',
      '  crib adapters hooks <install|list|remove> [--client <id|all>]   lane-2 capture hooks (Claude Code settings.json, project scope)',
      '                                          write the vendor-neutral agent-memory protocol into each client instruction file (W8)',
      '  crib skill <install|list> [name] [--dest <dir>] [--client <claude>]   install bundled skills (default ~/.claude/skills)',
      '  crib init [path] [--ide <name|all>]      5-minute onboarding: index + install-hooks + mcp install + adapters + next-steps hero',
      '  crib doctor [path]                       setup health check: node/corepack/index-freshness/hooks/IDE-wiring/memory-loop/stale-builds/embed-tier/freshness/post-commit-hook (✓/✗ + fix hints)',
      '  crib embed <install <model-dir>|status>   on-device embedder tier: install --model-id <id> --model-version <ver> [--entry <file>] | status (tier report; --accept-remote-policy opts into the remote tier)',
      '  crib freshness [<mode>|worker|hook|convert-hook]   index freshness: modes manual|watch|auto | durable background worker | post-commit hook body (always exit 0) | convert the legacy blocking post-commit hook',
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
    if (err instanceof CliUsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = EXIT.BAD_ARGS;
      return;
    }
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = EXIT.ERROR;
  });
