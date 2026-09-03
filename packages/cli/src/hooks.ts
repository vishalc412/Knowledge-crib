/**
 * `crib install-hooks` + `crib merge-driver` plumbing (M6 + W0 agent-memory split).
 *
 * `installHooks` wires `.crib` into git so a soul-bearing repo stays in sync automatically:
 *   - a **managed block** in `.git/hooks/post-commit` runs `crib update` after each commit (advances the
 *     soul + index to the new HEAD without a full re-index);
 *   - `.gitattributes` routes `.crib` JSONL chunks through ONE of two custom merge drivers:
 *       • `kcrib`        — deterministic soul chunks (the extracted graph JSONL under .crib, excluding memory);
 *       • `kcrib-memory` — strict append-only memory chunks (the JSONL under .crib/memory/team);
 *     JSON manifests + policy files (`.crib/crib.json`, `.crib/graph/manifest.json`,
 *     `.crib/memory/policy.json`) get NO `merge=` attribute → normal Git text merge.
 *   - `git config merge.kcrib.driver` and `merge.kcrib-memory.driver` both point at `crib merge-driver`,
 *     which dispatches by the `%P` pathname to the soul merger (`mergeThreeWay`) or the memory merger
 *     (`mergeMemoryChunk`). Two configs keep the seams independent so memory merge behavior can change
 *     without touching soul merge (PRD §1: `runLink`/`EnrichmentStore.save` are HIGH-risk seams).
 * All writes are idempotent: the managed block is replaced in place (never duplicated), the
 * `.gitattributes` block is replaced in place, and the git configs are overwritten to canonical values.
 *
 * `mergeDriverFiles` is the driver body: it 3-way-merges one JSONL chunk (`%O` base / `%A` ours / `%B`
 * theirs) and writes the merged result back to `%A`. Soul edge conflicts resolve deterministically via
 * the shared `resolveEdgeConflict` rule; soul node-level collisions defer to the source merge (warning +
 * ours). Memory chunks union immutably by content id; a same-id/different-content collision or a
 * malformed line is a HARD conflict (conflict markers written to `%A`, non-zero exit) — never a silent
 * skip (PRD §3 W0).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  mergeMemoryChunk,
  mergeThreeWay,
  parseChunk,
  parseMemoryChunk,
  renderMemoryConflict,
  serializeChunk,
  serializeMemoryChunk,
} from '@knowledge-crib/core';

type ChunkMap = ReturnType<typeof parseChunk>;

const MANAGED_BEGIN = '# >>> kcrib managed >>>';
const MANAGED_END = '# <<< kcrib managed <<<';
const GITATTR_BEGIN = '# >>> kcrib merge >>>';
const GITATTR_END = '# <<< kcrib merge <<<';

/** Git config section for the memory merge driver (distinct from the soul `kcrib` driver). */
export const MEMORY_DRIVER = 'kcrib-memory';

/**
 * Classify a `%P` merge-driver pathname as a memory chunk or a soul chunk. Memory lives under
 * `.crib/memory/team/` (records / decisions / receipts — all immutable, strict-union merged);
 * everything else under `.crib` is soul (deterministic 3-way merged). Path is normalized to `/`
 * so this works for both repo-relative and absolute paths on any platform.
 */
export function chunkKindForPath(p: string | undefined): 'memory' | 'soul' {
  if (!p) return 'soul';
  const norm = p.replace(/\\/g, '/');
  return norm.includes('/memory/team/') || norm.startsWith('memory/team/') ? 'memory' : 'soul';
}

export interface HookInstallOptions {
  /** Binary invoked by the post-commit hook + merge driver. Default `'crib'`. */
  driverBin?: string;
}

export interface HookInstallResult {
  gitDir: string;
  postCommitPath: string;
  gitattributesPath: string;
  driverConfig: string;
}

/** Locate `.git` for `root` (relative or absolute via `git rev-parse --git-dir`). */
export function gitDir(root: string): string {
  const rel = execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return resolve(root, rel);
}

/**
 * Read-only counterpart to {@link installHooks} for `crib doctor`: report which of the three managed
 * signals are already in place without writing anything. Each is the load-bearing artifact
 * `installHooks` writes — the managed block in `post-commit`, the `# >>> kcrib merge >>>` block in
 * `.gitattributes`, and the `merge.kcrib.driver` git config. A non-git directory (gitDir throws)
 * reports all-false rather than throwing so doctor can run on a not-yet-init repo.
 */
export interface HookStatus {
  postCommit: boolean;
  gitattributes: boolean;
  /** soul merge driver (`merge.kcrib.driver`) configured. */
  driverConfig: boolean;
  /** memory merge driver (`merge.kcrib-memory.driver`) configured (W0). */
  memoryDriverConfig: boolean;
}
function driverConfigured(root: string, section: string): boolean {
  try {
    const cfg = execFileSync('git', ['-C', root, 'config', section], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return cfg.length > 0;
  } catch {
    return false;
  }
}
export function hooksInstalled(root: string): HookStatus {
  let gdir: string;
  try {
    gdir = gitDir(root);
  } catch {
    return {
      postCommit: false,
      gitattributes: false,
      driverConfig: false,
      memoryDriverConfig: false,
    };
  }
  const postCommitPath = join(gdir, 'hooks', 'post-commit');
  const postCommit =
    existsSync(postCommitPath) && readFileSync(postCommitPath, 'utf8').includes(MANAGED_BEGIN);
  const gitattributesPath = join(root, '.gitattributes');
  const gitattributes =
    existsSync(gitattributesPath) &&
    readFileSync(gitattributesPath, 'utf8').includes(GITATTR_BEGIN);
  return {
    postCommit,
    gitattributes,
    driverConfig: driverConfigured(root, 'merge.kcrib.driver'),
    memoryDriverConfig: driverConfigured(root, `merge.${MEMORY_DRIVER}.driver`),
  };
}

// ─── G3.4: legacy BLOCKING post-commit hook detection (report only — never writes) ───────────

/**
 * Report for a pre-existing post-commit hook that runs `crib update` (or `kcrib update`)
 * SYNCHRONOUSLY inside the commit: the pre-G3.4 managed block (`installHooks` above) is exactly
 * that. Red line: zero blocking time added to git commit in EVERY freshness mode — so this hook
 * must be CONVERTED to the mode-appropriate non-blocking path (`postCommitFreshness` in
 * `freshness.ts`, which enqueues in `auto` and no-ops in `manual`/`watch`). Detection + report
 * data only; the interactive offer is surfaced by the integration layer (`crib install-hooks` /
 * `crib doctor`), which owns the conversion write.
 */
export interface LegacyBlockingHookReport {
  postCommitPath: string;
  /** The hook file exists at all. */
  exists: boolean;
  /** The kcrib managed block (the legacy blocking `crib update` install) is present. */
  managedBlock: boolean;
  /** Hook lines that invoke `crib update` / `kcrib update` in the foreground (i.e. blocking). */
  blockingCommands: string[];
  /** true when at least one blocking command exists and the conversion applies. */
  convertible: boolean;
  /** Machine-readable suggested action for the integration layer to surface. */
  recommendation: 'convert-to-freshness-mode' | 'none';
}

/** Matches a foreground `crib update` / `kcrib update` invocation (optionally quoted, via npx/pnpm exec). */
const BLOCKING_UPDATE_RE =
  /(?:^|[\s;&])(?:(?:npx|pnpm(?:\s+exec)?)\s+)?["']?k?crib["']?\s+update\b/;

/**
 * Read-only scan of `.git/hooks/post-commit` for the legacy blocking pattern. Never writes; a
 * non-git directory (or any read error) reports a not-applicable finding rather than throwing so
 * doctor can run anywhere.
 */
export function detectLegacyBlockingPostCommit(root: string): LegacyBlockingHookReport {
  let postCommitPath = '';
  try {
    postCommitPath = join(gitDir(root), 'hooks', 'post-commit');
  } catch {
    return {
      postCommitPath: '',
      exists: false,
      managedBlock: false,
      blockingCommands: [],
      convertible: false,
      recommendation: 'none',
    };
  }
  if (!existsSync(postCommitPath)) {
    return {
      postCommitPath,
      exists: false,
      managedBlock: false,
      blockingCommands: [],
      convertible: false,
      recommendation: 'none',
    };
  }
  const content = readFileSync(postCommitPath, 'utf8');
  const blockingCommands = content
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => BLOCKING_UPDATE_RE.test(line) && !line.endsWith('&'), // a trailing `&` backgrounds it —
      // non-blocking to the commit itself, so it does not violate the zero-commit-tax red line
    );
  return {
    postCommitPath,
    exists: true,
    managedBlock: content.includes(MANAGED_BEGIN),
    blockingCommands,
    convertible: blockingCommands.length > 0,
    recommendation: blockingCommands.length > 0 ? 'convert-to-freshness-mode' : 'none',
  };
}

/** Install/refresh the post-commit managed block, the `.gitattributes` merge entry, and the driver config. */
export function installHooks(root: string, opts: HookInstallOptions = {}): HookInstallResult {
  const bin = opts.driverBin ?? 'crib';
  const gdir = gitDir(root);
  const hooksDir = join(gdir, 'hooks');
  const postCommitPath = join(hooksDir, 'post-commit');
  const gitattributesPath = join(root, '.gitattributes');

  // 1. post-commit hook with a managed block (idempotent replace).
  const hookBlock = [MANAGED_BEGIN, `"${bin}" update`, MANAGED_END].join('\n');
  const existing = existsSync(postCommitPath) ? readFileSync(postCommitPath, 'utf8') : '';
  writeFileSync(
    postCommitPath,
    spliceManaged(existing, hookBlock, MANAGED_BEGIN, MANAGED_END, !existing.length),
    { mode: 0o755 },
  );

  // 2. .gitattributes: route .crib JSONL chunks through the right merge driver (idempotent).
  //    `.crib/**/*.jsonl` → kcrib (soul); `.crib/memory/team/**/*.jsonl` → kcrib-memory (strict
  //    append-only union). The memory line is LAST so git's last-match-wins resolves memory paths
  //    to kcrib-memory. JSON manifests + policy files get no merge= attribute → normal Git merge.
  const attrBlock = [
    GITATTR_BEGIN,
    '.crib/**/*.jsonl merge=kcrib',
    '.crib/memory/team/**/*.jsonl merge=kcrib-memory',
    GITATTR_END,
  ].join('\n');
  const attrsExisting = existsSync(gitattributesPath)
    ? readFileSync(gitattributesPath, 'utf8')
    : '';
  writeFileSync(
    gitattributesPath,
    spliceManaged(attrsExisting, attrBlock, GITATTR_BEGIN, GITATTR_END, false),
  );

  // 3. git config merge.kcrib.driver + merge.kcrib-memory.driver — overwritten each run. Both
  //    point at `crib merge-driver`, which dispatches by the %P pathname (soul vs memory merger).
  const driverConfig = `"${bin}" merge-driver %O %A %B %P`;
  execFileSync('git', ['-C', root, 'config', 'merge.kcrib.driver', driverConfig], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  execFileSync('git', ['-C', root, 'config', `merge.${MEMORY_DRIVER}.driver`, driverConfig], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return { gitDir: gdir, postCommitPath, gitattributesPath, driverConfig };
}

/** Replace (or append) the managed region between the given markers; prefix with a shebang when fresh. */
/**
 * Replace (or append) the managed region between the given markers; prefix with a shebang when fresh.
 * Exported so `crib mcp install` can reuse the same idempotent-block strategy for TOML config files
 * (which, like shell hooks, permit `#` comments). JSON configs use a parse/modify/reserialize strategy
 * instead (JSON forbids comments).
 */
export function spliceManaged(
  content: string,
  block: string,
  beginMarker: string,
  endMarker: string,
  fresh: boolean,
): string {
  const beginIdx = content.indexOf(beginMarker);
  if (beginIdx === -1) {
    const prefix = fresh && !content.startsWith('#!') ? '#!/bin/sh\n' : '';
    const tail = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    return `${prefix}${content}${tail}${block}\n`;
  }
  const endIdx = content.indexOf(endMarker, beginIdx);
  const before = content.slice(0, beginIdx);
  const after = endIdx === -1 ? '' : content.slice(endIdx + endMarker.length);
  const ensuredNl = (s: string) => (s.length > 0 && !s.endsWith('\n') ? `${s}\n` : s);
  return `${ensuredNl(before)}${block}\n${after.replace(/^\n/, '')}`;
}

export interface MergeDriverOutcome {
  warnings: string[];
  /** true only when a genuine collision/malformed line could not be auto-resolved (review needed). */
  conflicts: boolean;
}

/**
 * The merge-driver body: 3-way merge of one `.crib` JSONL chunk. Reads `%O` (base), `%A` (ours, also the
 * output), `%B` (theirs); writes the merged chunk back to `%A`. Returns warnings to print to stderr.
 *
 * `pathName` (git's `%P`) selects the merger: soul chunks → `mergeThreeWay` (deterministic 3-way);
 * memory chunks → `mergeMemoryChunk` (strict append-only union by content id). A memory hard
 * conflict (same id, different content) or malformed line writes conflict markers to `%A` and
 * returns `conflicts: true` so git marks the path conflicted — never a silent skip.
 */
export function mergeDriverFiles(
  basePath: string,
  oursPath: string,
  theirsPath: string,
  pathName?: string,
): MergeDriverOutcome {
  if (chunkKindForPath(pathName) === 'memory') {
    const base = readMemoryChunk(basePath, 'base');
    const ours = readMemoryChunk(oursPath, 'ours');
    const theirs = readMemoryChunk(theirsPath, 'theirs');
    const result = mergeMemoryChunk(base, ours, theirs);
    if (result.conflicts) {
      // hard conflict or malformed input — write conflict markers, exit non-zero (git marks U).
      writeFileSync(oursPath, renderMemoryConflict(base, ours, theirs, result));
      return {
        warnings: [
          ...result.errors.map((e) => `memory merge rejected malformed line: ${e}`),
          ...result.conflictIds.map((id) => `memory hard conflict: id ${id} differs in content`),
          ...result.warnings,
        ],
        conflicts: true,
      };
    }
    writeFileSync(oursPath, serializeMemoryChunk(result.merged));
    return { warnings: result.warnings, conflicts: false };
  }

  const base = readFileChunk(basePath);
  const ours = readFileChunk(oursPath);
  const theirs = readFileChunk(theirsPath);
  const { merged, warnings } = mergeThreeWay(base, ours, theirs);
  writeFileSync(oursPath, serializeChunk(merged));
  return { warnings, conflicts: warnings.length > 0 };
}

function readFileChunk(path: string): ChunkMap {
  return existsSync(path) ? parseChunk(readFileSync(path, 'utf8')) : parseChunk('');
}

function readMemoryChunk(path: string, source: string) {
  return parseMemoryChunk(existsSync(path) ? readFileSync(path, 'utf8') : '', source);
}

// ─── G3.4: the conversion write (the integration layer's explicit operator action) ──────────

export interface ConvertHookResult {
  converted: boolean;
  postCommitPath: string;
  /** Why no conversion happened (never thrown — the caller prints it verbatim). */
  reason?: string;
}

/**
 * Convert the legacy BLOCKING post-commit managed block to the G3.4 non-blocking path: the
 * foreground `crib update` line inside the managed block becomes `"crib" freshness hook`
 * (`postCommitFreshness` — enqueues in `auto` mode, no-ops in `manual`/`watch`), and the actual
 * refresh moves into the durable freshness worker's revalidate port (red line #5). OPT-IN by
 * design: the pre-G3.4 blocking refresh is the incumbent behaviour, so the operator asks for this
 * explicitly (`crib freshness convert-hook`); the explainer the CLI prints alongside says what
 * changes per mode (auto → background worker performs the refresh; manual → reads are as-of-last
 * explicit `crib update`; watch → the running server keeps the overlay fresh).
 *
 * Guarded: converts ONLY when {@link detectLegacyBlockingPostCommit} reports a convertible managed
 * block, and only replaces lines INSIDE the managed region — user-authored hook content outside
 * the block is never touched. Idempotent: a converted block no longer matches the blocking
 * pattern, so a second run reports `converted: false` with a reason.
 */
export function convertBlockingPostCommit(
  root: string,
  opts: HookInstallOptions = {},
): ConvertHookResult {
  const report = detectLegacyBlockingPostCommit(root);
  if (!report.exists) {
    return {
      converted: false,
      postCommitPath: report.postCommitPath,
      reason: 'no post-commit hook',
    };
  }
  if (!report.managedBlock) {
    return {
      converted: false,
      postCommitPath: report.postCommitPath,
      reason: 'no kcrib managed block — refusing to rewrite a hand-authored hook',
    };
  }
  if (!report.convertible) {
    return {
      converted: false,
      postCommitPath: report.postCommitPath,
      reason: 'already converted (no blocking `crib update` line in the managed block)',
    };
  }
  const bin = opts.driverBin ?? 'crib';
  const content = readFileSync(report.postCommitPath, 'utf8');
  const beginIdx = content.indexOf(MANAGED_BEGIN);
  const endIdx = content.indexOf(MANAGED_END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    return {
      converted: false,
      postCommitPath: report.postCommitPath,
      reason: 'malformed managed block — refusing to rewrite',
    };
  }
  const head = content.slice(0, beginIdx);
  const tail = content.slice(endIdx + MANAGED_END.length);
  const block = [MANAGED_BEGIN, `"${bin}" freshness hook`, MANAGED_END].join('\n');
  writeFileSync(report.postCommitPath, `${head}${block}${tail}`, { mode: 0o755 });
  return { converted: true, postCommitPath: report.postCommitPath };
}
