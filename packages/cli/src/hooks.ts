/**
 * `crib install-hooks` + `crib merge-driver` plumbing (M6).
 *
 * `installHooks` wires `.crib` into git so a soul-bearing repo stays in sync automatically:
 *   - a **managed block** in `.git/hooks/post-commit` runs `crib update` after each commit (advances the
 *     soul + index to the new HEAD without a full re-index);
 *   - a `.gitattributes` entry routes `.crib/**` chunks through the `kcrib` custom merge driver;
 *   - `git config merge.kcrib.driver` points the driver at `crib merge-driver`.
 * All writes are idempotent: the managed block is replaced in place (never duplicated), the
 * `.gitattributes` entry is appended only once, and the git config is overwritten to the canonical value.
 *
 * `mergeDriverFiles` is the driver body: it 3-way-merges one JSONL chunk (`%O` base / `%A` ours / `%B`
 * theirs) and writes the merged result back to `%A`. Edge conflicts resolve deterministically via the
 * shared `resolveEdgeConflict` rule; node-level collisions defer to the source merge (warning + ours).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mergeThreeWay, parseChunk, serializeChunk } from '@knowledge-crib/core';

type ChunkMap = ReturnType<typeof parseChunk>;

const MANAGED_BEGIN = '# >>> kcrib managed >>>';
const MANAGED_END = '# <<< kcrib managed <<<';
const GITATTR_BEGIN = '# >>> kcrib merge >>>';
const GITATTR_END = '# <<< kcrib merge <<<';

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

  // 2. .gitattributes: route .crib chunks through the kcrib merge driver (idempotent).
  const attrBlock = [GITATTR_BEGIN, '.crib/** merge=kcrib', GITATTR_END].join('\n');
  const attrsExisting = existsSync(gitattributesPath)
    ? readFileSync(gitattributesPath, 'utf8')
    : '';
  writeFileSync(
    gitattributesPath,
    spliceManaged(attrsExisting, attrBlock, GITATTR_BEGIN, GITATTR_END, false),
  );

  // 3. git config merge.kcrib.driver — overwritten to the canonical value each run.
  const driverConfig = `"${bin}" merge-driver %O %A %B %P`;
  execFileSync('git', ['-C', root, 'config', 'merge.kcrib.driver', driverConfig], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return { gitDir: gdir, postCommitPath, gitattributesPath, driverConfig };
}

/** Replace (or append) the managed region between the given markers; prefix with a shebang when fresh. */
function spliceManaged(
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
  /** true only when a genuine node-level collision could not be auto-resolved (review needed). */
  conflicts: boolean;
}

/**
 * The merge-driver body: 3-way merge of one `.crib` JSONL chunk. Reads `%O` (base), `%A` (ours, also the
 * output), `%B` (theirs); writes the merged chunk back to `%A`. Returns warnings to print to stderr.
 */
export function mergeDriverFiles(
  basePath: string,
  oursPath: string,
  theirsPath: string,
): MergeDriverOutcome {
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
