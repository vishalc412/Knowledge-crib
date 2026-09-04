/**
 * `rename` (G5.1) — the GitNexus-parity safe rename engine.
 *
 * WHY a plan/apply split: a rename that silently rewrites files is the one graph operation that can
 * destroy work, so it gets the same guard set as GitNexus — default DRY-RUN, a deterministic
 * content-hashed plan id, per-file content hashes taken at plan time, stale-plan rejection, and an
 * all-or-nothing application. The plan is NEVER persisted: `apply` re-derives it from the CURRENT
 * graph + files and refuses unless the re-derived id matches the reviewed one — a changed file
 * changes the plan, which changes the id, which fails the check. No wall-clock input anywhere, so
 * the id is reproducible byte-for-byte across runs.
 *
 * Site classification (requirement — exact vs inferred):
 *   exact    — the definition span plus every reference grounded by an EXTRACTED edge (the caller
 *              node's file + span). Occurrences inside those files inherit the grounding.
 *   inferred — word-boundary text hits in files with NO resolved reference edge (comments, docs,
 *              dynamic dispatch). Allowed into the plan but always flagged in `counts` + `notes`.
 *
 * The affected-symbol set reuses `impact`'s upstream BFS (same adjacency semantics as the `impact`
 * verb: EXTRACTED layer, distance-capped). A dependent reached only by an INFERRED edge — or an
 * empty caller set — is NEVER read as safe: such symbols land in the `unresolved` bucket with the
 * risk note, mirroring the `risk: UNKNOWN` contract.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Node, Rel } from '@knowledge-crib/soul-schema';
import { blake3Hex, edgeId } from '@knowledge-crib/soul-schema';
import { GraphStore } from './graph-store.js';
import { pathFromId } from './shard.js';
import type { SoulStore } from './soul-store.js';

/** How deep the affected-symbol walk goes by default — mirrors the `impact` verb's default. */
export const RENAME_DEFAULT_DEPTH = 2;
const MAX_DEPTH = 6;
/** Sites reported per file before the list is truncated (the per-file `edits` count is always exact). */
const MAX_SITES_PER_FILE = 40;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SCAN_FILES = 20_000;
/** Text-hit lines reported per inferred file — enough to review, small enough to keep plans lean. */
const MAX_TEXT_SITE_LINES = 20;

/** Directories a rename scan never enters: VCS internals, build output, and the crib's own state. */
const SKIP_DIRS = new Set([
  '.git',
  '.crib',
  '.gitnexus',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.claude',
  '.codex',
  '.gstack',
]);

/** Rels that ground a reference site in CODE (doc/ownership rels are excluded — those hits stay inferred). */
const RENAME_RELS: ReadonlySet<Rel> = new Set<Rel>([
  'calls',
  'imports',
  'inherits',
  'implements',
  'references',
  'executes',
  'reads',
  'writes',
  'injects',
  'renders',
  'produces',
]);

export interface RenameSite {
  /** repo-relative file path */
  file: string;
  /** 1-based line of the occurrence */
  line: number;
  kind: 'definition' | 'reference' | 'text';
  confidence: 'exact' | 'inferred';
  /** why this site is in the plan: the resolved edge id / node id, or 'text-hit' */
  evidence: string;
}

export interface RenameFilePlan {
  path: string;
  /** blake3:<hex> of the file's utf8 contents at plan time — the stale-plan check re-reads this */
  contentHash: string;
  /** word-boundary occurrences of the identifier this plan rewrites */
  edits: number;
  sites: RenameSite[];
}

export interface RenameAffected {
  id: string;
  name?: string;
  distance: number;
  rel: string;
  /** resolved = an EXTRACTED edge grounds the dependency; unresolved = inferred-only grounding */
  resolution: 'resolved' | 'unresolved';
  risk: 'high' | 'medium' | 'low' | 'unresolved';
  /** present only when risk is 'unresolved' — why the caller set could not be trusted as complete */
  riskNote?: string;
}

export interface RenameTarget {
  id: string;
  name?: string;
  qualifiedName?: string;
  file?: string;
  line?: number;
}

export interface RenamePlan {
  from: string;
  to: string;
  target: RenameTarget;
  /** `rename:<64 hex>` — blake3 over the canonical plan body (files + sites + affected). No clock. */
  planId: string;
  files: RenameFilePlan[];
  affected: RenameAffected[];
  /** dependents whose only grounding is an inferred edge — never treated as safe to have renamed */
  unresolved: RenameAffected[];
  counts: { exact: number; inferred: number; files: number; edits: number };
  notes: string[];
}

export type RenamePlanOutcome =
  | { ok: true; plan: RenamePlan }
  | { ok: false; code: 'NOT_FOUND' | 'INVALID'; message: string };

export type RenameApplyOutcome =
  | { ok: true; planId: string; filesChanged: number; edits: number }
  | {
      ok: false;
      code: 'PLAN_MISMATCH' | 'STALE_PLAN' | 'IO';
      message: string;
      /** files restored after a mid-commit failure — the net effect is still "nothing applied" */
      rolledBack?: string[];
    };

export interface BuildRenamePlanArgs {
  soul: SoulStore;
  repoRoot: string;
  from: string;
  to: string;
  /** affected-symbol traversal depth (default 2, mirroring the `impact` verb) */
  depth?: number;
  /** explicit repo-relative candidate list; omitted ⇒ walk `repoRoot` skipping SKIP_DIRS */
  scanFiles?: string[];
}

const IDENTIFIER = /^[$A-Za-z_][$A-Za-z0-9_$]*$/;

/** Escaped, word-boundary-anchored matcher so `get` never hits `getUser`. */
function wordBoundaryRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
}

/**
 * Resolve an id-or-name to a renamable symbol, mirroring `resolveNodeId`'s order (exact id, then
 * qualified name ci, then simple name ci) but requiring a source file — a node with no file has no
 * text to rewrite and cannot anchor a rename.
 */
function resolveSymbol(soul: SoulStore, idOrName: string): Node | undefined {
  const direct = soul.getNode(idOrName);
  if (direct && (direct.file ?? pathFromId(direct.id)) !== undefined) return direct;
  const needle = idOrName.toLowerCase();
  for (const n of soul.iterate()) {
    if (n.qualifiedName?.toLowerCase() === needle) return n;
  }
  for (const n of soul.iterate()) {
    if (n.name?.toLowerCase() === needle) return n;
  }
  return undefined;
}

function walkTextFiles(root: string): { files: string[]; skippedBinary: number } {
  const out: string[] = [];
  let skippedBinary = 0;
  const walk = (dir: string, rel: string): void => {
    if (out.length >= MAX_SCAN_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), childRel);
      } else if (e.isFile()) {
        const abs = join(dir, e.name);
        let size = 0;
        try {
          size = statSync(abs).size;
        } catch {
          continue;
        }
        if (size === 0 || size > MAX_FILE_BYTES) continue;
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        // NUL byte in the first chunk is the cheapest honest binary sniff — a text rename must not
        // corrupt buffers, and a corrupting "rename" would be worse than skipping the file.
        if (text.slice(0, 8192).includes('\0')) {
          skippedBinary++;
          continue;
        }
        out.push(childRel);
      }
    }
  };
  walk(root, '');
  return { files: out, skippedBinary };
}

function occurrences(text: string, token: string): number[] {
  const lines: number[] = [];
  const regex = wordBoundaryRegex(token);
  // Single left-to-right pass: track the line number incrementally instead of recounting newlines
  // from byte 0 for every match (O(matches x bytes) → O(bytes)).
  let line = 1;
  let cursor = 0;
  for (;;) {
    const m = regex.exec(text);
    if (!m) break;
    for (let i = cursor; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    cursor = m.index;
    lines.push(line);
  }
  return lines;
}

/**
 * Build the reviewed rename plan. Pure over the soul + the files on disk; the plan id is a content
 * hash of the plan body, so the same graph + same files always yield the same id — and ANY change to
 * a target file (or to the graph) changes the id, which is exactly what makes stale plans refusable.
 */
export function buildRenamePlan(args: BuildRenamePlanArgs): RenamePlanOutcome {
  const { soul, repoRoot, from, to, scanFiles } = args;
  const depth = Math.min(Math.max(args.depth ?? RENAME_DEFAULT_DEPTH, 1), MAX_DEPTH);
  if (!from.trim() || !to.trim()) {
    return { ok: false, code: 'INVALID', message: '--from and --to are both required' };
  }
  if (from === to) {
    return { ok: false, code: 'INVALID', message: '--from and --to must differ' };
  }
  const target = resolveSymbol(soul, from);
  if (!target) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `no symbol matches '${from}' — run \`crib query "${from}"\` to find the exact id`,
    };
  }
  const defFile = target.file ?? pathFromId(target.id);
  if (!defFile) {
    return {
      ok: false,
      code: 'INVALID',
      message: `'${from}' resolved to ${target.id} which has no source file — nothing to rewrite`,
    };
  }
  // The token rewritten in text is the symbol's SIMPLE name: a qualified --from anchors the node but
  // identifiers in code are unqualified. Say so explicitly when the two differ.
  const token = target.name ?? from;
  const notes: string[] = [];
  if (token !== from)
    notes.push(`--from '${from}' resolved to ${target.id}; rewriting the simple name '${token}'`);
  if (!IDENTIFIER.test(to))
    notes.push(
      `--to '${to}' is not a bare identifier — non-code occurrences (docs, strings) will be rewritten too`,
    );

  // ── resolved reference sites: EXTRACTED inbound edges only ────────────────────────────────────
  const graph = new GraphStore(soul);
  const extracted = graph.extracted();
  const inbound = extracted.edges.filter(
    (e) => e.dst === target.id && RENAME_RELS.has(e.rel as Rel),
  );
  const exactFiles = new Set<string>([defFile]);
  const affected = new Map<string, RenameAffected>();
  for (const e of inbound) {
    const src = soul.getNode(e.src);
    if (e.provenance === 'EXTRACTED') {
      affected.set(e.src, {
        id: e.src,
        ...(src?.name ? { name: src.name } : {}),
        distance: 1,
        rel: e.rel,
        resolution: 'resolved',
        risk: 'high',
      });
    } else {
      // A semantic/inferred edge is a lead, not a resolved reference — it must never be read as
      // evidence that every usage of this symbol is known (the risk:UNKNOWN contract).
      affected.set(e.src, {
        id: e.src,
        ...(src?.name ? { name: src.name } : {}),
        distance: 1,
        rel: e.rel,
        resolution: 'unresolved',
        risk: 'unresolved',
        riskNote:
          'risk unresolved — reached only by an inferred edge, so the caller set is not known to be complete; confirm with a text search before treating this symbol as safe',
      });
    }
  }

  // ── affected-symbol set: the same BFS the `impact` verb runs (dir up, EXTRACTED layer) ────────
  const visited = new Set<string>([target.id]);
  let frontier = [target.id];
  for (let d = 2; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of extracted.edges) {
        if (e.dst !== cur) continue;
        const nb = e.src;
        if (visited.has(nb)) continue;
        visited.add(nb);
        next.push(nb);
        if (affected.has(nb)) continue;
        const src = soul.getNode(nb);
        affected.set(nb, {
          id: nb,
          ...(src?.name ? { name: src.name } : {}),
          distance: d,
          rel: e.rel,
          resolution: e.provenance === 'EXTRACTED' ? 'resolved' : 'unresolved',
          risk: e.provenance === 'EXTRACTED' ? (d <= 2 ? 'medium' : 'low') : 'unresolved',
          ...(e.provenance === 'EXTRACTED'
            ? {}
            : {
                riskNote:
                  'risk unresolved — reached only by an inferred edge, so the caller set is not known to be complete; confirm with a text search before treating this symbol as safe',
              }),
        });
      }
    }
    frontier = next;
  }
  // Exact-site files: the definition file plus every resolved caller's file.
  const resolvedFiles = new Set<string>([defFile]);
  for (const e of inbound) {
    if (e.provenance !== 'EXTRACTED' || !RENAME_RELS.has(e.rel as Rel)) continue;
    const src = soul.getNode(e.src);
    const file = src ? (src.file ?? pathFromId(src.id)) : pathFromId(e.src);
    if (file) resolvedFiles.add(file);
  }

  // ── text scan ──────────────────────────────────────────────────────────────────────────────────
  // One walk, used for both the candidate list and the binary-skip count (an explicit scanFiles
  // list replaces the walk entirely, so nothing is skipped by definition).
  const scanned = scanFiles ? { files: scanFiles, skippedBinary: 0 } : walkTextFiles(repoRoot);
  const candidates = scanned.files;
  const skippedBinary = scanned.skippedBinary;
  const regex = wordBoundaryRegex(token);
  const filePlans: RenameFilePlan[] = [];
  const counts = { exact: 0, inferred: 0, edits: 0 };
  for (const relPath of [...resolvedFiles, ...candidates.filter((f) => !resolvedFiles.has(f))]) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, relPath), 'utf8');
    } catch {
      notes.push(`skipped unreadable file '${relPath}'`);
      continue;
    }
    const hitLines = occurrences(text, token);
    if (hitLines.length === 0 && !resolvedFiles.has(relPath)) continue;
    if (hitLines.length === 0 && relPath === defFile && !text.includes(token)) continue;
    const exactFile = resolvedFiles.has(relPath);
    const sites: RenameSite[] = [];
    if (relPath === defFile) {
      sites.push({
        file: relPath,
        line: target.span?.start ?? hitLines[0] ?? 1,
        kind: 'definition',
        confidence: 'exact',
        evidence: target.id,
      });
    }
    if (exactFile) {
      for (const e of inbound) {
        if (e.provenance !== 'EXTRACTED' || !RENAME_RELS.has(e.rel as Rel)) continue;
        const src = soul.getNode(e.src);
        const file = src ? (src.file ?? pathFromId(src.id)) : pathFromId(e.src);
        if (file !== relPath) continue;
        sites.push({
          file: relPath,
          line: src?.span?.start ?? 1,
          kind: 'reference',
          confidence: 'exact',
          evidence: e.id,
        });
      }
    }
    const isExactFile = exactFile;
    for (const line of hitLines.slice(0, isExactFile ? MAX_SITES_PER_FILE : MAX_TEXT_SITE_LINES)) {
      // Every occurrence in a resolved (definition or caller) file inherits that file's EXTRACTED
      // grounding; occurrences anywhere else are text-only and stay flagged inferred.
      sites.push({
        file: relPath,
        line,
        kind: relPath === defFile ? 'definition' : isExactFile ? 'reference' : 'text',
        confidence: isExactFile ? 'exact' : 'inferred',
        evidence: isExactFile ? 'resolved-file' : 'text-hit',
      });
    }
    const unique = new Map(sites.map((s) => [`${s.line}:${s.kind}:${s.evidence}`, s]));
    const deduped = [...unique.values()].sort((a, b) => a.line - b.line);
    const truncated = isExactFile && hitLines.length > MAX_SITES_PER_FILE;
    if (truncated || (!isExactFile && hitLines.length > MAX_TEXT_SITE_LINES)) {
      notes.push(`${relPath}: ${hitLines.length} occurrence(s), first ${deduped.length} listed`);
    }
    filePlans.push({
      path: relPath,
      contentHash: `blake3:${blake3Hex(text)}`,
      edits: hitLines.length,
      sites: deduped,
    });
    for (const line of hitLines) {
      if (isExactFile) counts.exact++;
      else counts.inferred++;
    }
    counts.edits += hitLines.length;
  }
  if (skippedBinary > 0) notes.push(`${skippedBinary} binary file(s) skipped by the scan`);
  // Keyed on the resolved EDGES, not on counts.exact: a definition-only rename has exact sites (the
  // definition) and still zero reference edges — the empty-caller-set warning must fire either way.
  const resolvedCallerCount = inbound.filter((e) => e.provenance === 'EXTRACTED').length;
  if (resolvedCallerCount === 0) {
    notes.push(
      'no resolved reference edges ground this rename — occurrences beyond the definition are text hits; an empty caller set is NOT evidence the symbol is unused',
    );
  }
  const unresolved = [...affected.values()]
    .filter((a) => a.resolution === 'unresolved')
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const resolvedAffected = [...affected.values()]
    .filter((a) => a.resolution === 'resolved')
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} affected symbol(s) are unresolved (inferred-only grounding) — see the unresolved bucket; treat them as leads, not as proof of safety`,
    );
  }

  filePlans.sort((a, b) => a.path.localeCompare(b.path));
  const plan: Omit<RenamePlan, 'planId'> = {
    from,
    to,
    target: {
      id: target.id,
      ...(target.name ? { name: target.name } : {}),
      ...(target.qualifiedName ? { qualifiedName: target.qualifiedName } : {}),
      ...(defFile ? { file: defFile } : {}),
      ...(target.span ? { line: target.span.start } : {}),
    },
    files: filePlans,
    affected: resolvedAffected,
    unresolved,
    counts: {
      exact: counts.exact,
      inferred: counts.inferred,
      files: filePlans.length,
      edits: counts.edits,
    },
    notes: notes.filter((n) => n.length > 0),
  };
  // Canonical, clock-free plan body → the deterministic plan id. Sorted keys, sorted arrays, no
  // timestamps: re-deriving the plan later reproduces this byte-for-byte iff nothing changed.
  const body = JSON.stringify({
    from: plan.from,
    to: plan.to,
    target: plan.target,
    files: plan.files.map((f) => ({ path: f.path, contentHash: f.contentHash, edits: f.edits })),
    affected: plan.affected.map((a) => ({ id: a.id, distance: a.distance, rel: a.rel })),
    unresolved: plan.unresolved.map((a) => ({ id: a.id })),
    counts: plan.counts,
  });
  return { ok: true, plan: { ...plan, planId: `rename:${blake3Hex(body)}` } };
}

/**
 * Apply a reviewed plan atomically: verify the plan id AND every file's current hash FIRST, stage
 * all rewritten contents in memory, and only then write. If any write fails, every already-written
 * file is restored from its staged original — the net effect of a failure is "nothing changed".
 */
export function applyRenamePlan(
  plan: RenamePlan,
  repoRoot: string,
  expectedPlanId: string,
): RenameApplyOutcome {
  if (plan.planId !== expectedPlanId) {
    return {
      ok: false,
      code: 'PLAN_MISMATCH',
      message:
        'plan id does not match the plan derived from the current graph and files — re-run the dry run (`crib rename --from ... --to ...`) and use the plan id it prints',
    };
  }
  // Phase 1 — verify + transform in memory. NOTHING is written until every file has been read,
  // hash-checked, and rewritten; a hash mismatch anywhere aborts before the first write. The token
  // rewritten is the plan's SIMPLE name (what the text scan matched), not the raw --from: a
  // qualified --from anchors the node, but the identifiers on disk are unqualified.
  const token = plan.target.name ?? plan.from;
  const staged: Array<{ path: string; original: string; next: string; edits: number }> = [];
  for (const f of plan.files) {
    let current: string;
    try {
      current = readFileSync(join(repoRoot, f.path), 'utf8');
    } catch {
      return {
        ok: false,
        code: 'STALE_PLAN',
        message: `${f.path} is no longer readable — re-run the dry run`,
      };
    }
    if (`blake3:${blake3Hex(current)}` !== f.contentHash) {
      return {
        ok: false,
        code: 'STALE_PLAN',
        message: `${f.path} changed since the plan was made — re-run the dry run to get a fresh plan id`,
      };
    }
    // The replacement callback form matters: a literal replacement string would interpret `$` in
    // --to as a capture-group reference and silently corrupt identifiers like `$scope`.
    const next = current.replace(wordBoundaryRegex(token), () => plan.to);
    const applied = countReplacements(current, token);
    if (applied !== f.edits) {
      return {
        ok: false,
        code: 'STALE_PLAN',
        message: `${f.path} no longer yields ${f.edits} edit(s) — re-run the dry run`,
      };
    }
    staged.push({ path: f.path, original: current, next, edits: applied });
  }
  // Phase 2 — commit. Anything thrown mid-loop triggers a best-effort rollback of the files
  // already written, so the write set stays all-or-nothing at the net level.
  const written: Array<{ path: string; original: string }> = [];
  try {
    for (const s of staged) {
      writeFileSync(join(repoRoot, s.path), s.next, 'utf8');
      written.push({ path: s.path, original: s.original });
    }
  } catch (err) {
    const restored: string[] = [];
    for (const w of written) {
      try {
        writeFileSync(join(repoRoot, w.path), w.original, 'utf8');
        restored.push(w.path);
      } catch {
        // A rollback failure is the one outcome worse than no-op — name it, never swallow it.
      }
    }
    return {
      ok: false,
      code: 'IO',
      message: `write failed after ${written.length} file(s) (${(err as Error).message}); restored: ${restored.join(', ') || 'none'}`,
      ...(restored.length > 0 ? { rolledBack: restored } : {}),
    };
  }
  return {
    ok: true,
    planId: plan.planId,
    filesChanged: staged.length,
    edits: staged.reduce((total, s) => total + s.edits, 0),
  };
}

/** Count of word-boundary occurrences that a rename would rewrite in `text`. */
function countReplacements(text: string, token: string): number {
  return occurrences(text, token).length;
}

/** Re-exported for callers that want to cite an edge id in their own evidence records. */
export { edgeId as renameEdgeId };
