/**
 * Reconstruct (Workstream WS-6) — the package-scoped migration-reconstruction artifact.
 *
 * Where {@link buildDossier} folds deep context for ONE symbol, `buildReconstruction` folds a
 * PACKAGE-level view an agent hands a migrator: the package's CONSTANT values (so `30`/`80`
 * thresholds survive into the migration plan), every member callable with its implementation
 * status, the union of tables the package reads/writes, the docs linked to the package or any of
 * its members, and the body file a spec SHOULD live next to. It is PURE over the soul + repoRoot
 * (no IndexStore, no network, no enricher) — the same purity contract as {@link buildDossier} — so
 * the verb layer is thin wiring and the pipeline could persist it post-resolve from the same path.
 *
 * The constants come from the package node's `meta.variables` (captured by the PL/SQL parser:
 * `cname CONSTANT NUMBER := 30;` → `{name, dataType:'NUMBER', init:'30', constant:true}`). They are
 * surfaced on the node via {@link publicNode} (`meta.variables` → `out.variables`); this module
 * reads them from the raw node meta and splits them into `constants` (CONSTANT) + `variables` (all,
 * incl. plain defaults) so the markdown renderer can present the migration-critical thresholds
 * separately from ordinary package state.
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { CALLABLE_SYMBOL_TYPES } from '../rules/index.js';
import type { SoulStore } from '../soul-store.js';
import { rehydrate } from '../source.js';
import { publicNode } from './builder.js';

/** The set of edge relations that point a doc-section at a symbol. */
const DOC_RELS = new Set(['describes', 'references']);

/**
 * Infer the body file a package spec SHOULD live next to, from the spec file path. Covers the
 * common Oracle conventions the migration feedback keys on: `.pks`→`.pkb`, `*_spec.sql`→
 * `*_body.sql`, and a generic `spec`→`body` token swap. Returns `undefined` when the path gives no
 * signal (honesty: we do not fabricate a name we are not confident about). Pure + language-agnostic.
 */
export function expectedBodyFile(specFile: string): string | undefined {
  if (/\.pks$/i.test(specFile)) return specFile.replace(/\.pks$/i, '.pkb');
  if (/_spec\.sql$/i.test(specFile)) return specFile.replace(/_spec\.sql$/i, '_body.sql');
  if (/spec\.sql$/i.test(specFile)) return specFile.replace(/spec\.sql$/i, 'body.sql');
  if (/\.sql$/i.test(specFile) && /spec/i.test(specFile)) {
    return specFile.replace(/spec/i, 'body');
  }
  return undefined;
}

/** One package-state entry: a CONSTANT or a plain defaulted variable, from `meta.variables`. */
export interface ReconstructionVariable {
  name: string;
  dataType?: string;
  /** the literal initializer text (e.g. "30", "'PASSED'", "1000"), whitespace-collapsed + clamped. */
  init?: string;
  /** true iff declared with the CONSTANT keyword. */
  constant?: boolean;
  /** true iff `init` was clipped at the fidelity cap — rehydrate source for verbatim text. */
  exprTruncated?: boolean;
}

/** One member callable of the package, with its implementation status + a "how much logic" count. */
export interface ReconstructionMember {
  id: string;
  name?: string;
  qualifiedName?: string;
  signature?: string;
  type?: string;
  file?: string;
  line?: number;
  /** implementation completeness — zero executes ⇒ body unavailable (spec-only / missing body file). */
  implementation: {
    status: 'implemented' | 'unimplemented';
    executesCount: number;
    /** distinct files holding call sites that resolve to this member. */
    referencedByFiles: string[];
  };
  /** count of guard-annotated action edges (executes + calls) the member owns — a cheap rules proxy. */
  rulesCount: number;
}

/** A table the package reads and/or writes, with the members that touch it. */
export interface ReconstructionTable {
  id: string;
  name: string;
  schema?: string;
  file?: string;
  /** member qualifiedNames that READ this table (deduped, sorted). */
  readBy: string[];
  /** member qualifiedNames that WRITE this table (deduped, sorted). */
  writtenBy: string[];
}

/** A doc-section linked to the package or one of its members. */
export interface ReconstructionDoc {
  sectionId: string;
  /** the qualifiedName of the target the doc points at (the package or a member), for attribution. */
  target: string;
  heading?: string;
  anchor?: string;
  snippet: string;
  edgeType: 'describes' | 'references';
  method: string;
  provenance: string;
  confidence: number;
}

/** Options for {@link buildReconstruction}. */
export interface ReconstructionOpts {
  /** when true, drop non-EXTRACTED edges (trust filter). */
  extractedOnly?: boolean;
  /** when true (default), compute the referenced-tables section (extra edge walking). */
  includeTables?: boolean;
  /** cap on the number of member entries returned (default 1000; honesty: `truncated` flags a cap). */
  maxSymbols?: number;
}

/** Bump on any Reconstruction interface change; independent of soul schemaVersion. */
export const RECONSTRUCTION_SHAPE_VERSION = 1;

/** The package-scoped reconstruction artifact. */
export interface Reconstruction {
  id: string;
  schemaVersion: string;
  /** blake3 hash of the package node at build time — staleness key. */
  nodeHash: string;
  builtAt: string;
  shapeVersion: number;
  /** the deep public node shape for the package. */
  node: Record<string, unknown>;
  /** the body file the spec should live next to (Oracle convention inference), when inferrable. */
  expectedBodyFile?: string;
  /** CONSTANT declarations only — the migration-critical thresholds (e.g. 30 / 80). */
  constants: ReconstructionVariable[];
  /** ALL package-state variables (constants + plain defaults), in source order. */
  variables: ReconstructionVariable[];
  members: ReconstructionMember[];
  referencedTables: ReconstructionTable[];
  docs: ReconstructionDoc[];
  /** total member count (may exceed `members.length` when capped by maxSymbols). */
  memberCount: number;
  /** true iff `members` was capped at maxSymbols. */
  truncated: boolean;
}

/**
 * Build a package-scoped reconstruction, pure over the soul + repoRoot. Returns `undefined` when the
 * node is absent OR is not a package (reconstruct is package-scoped; use `dossier`/`context` for a
 * single callable). The caller chooses `now` (an ISO timestamp) so the artifact is deterministic under
 * a fixed build time (the pipeline passes the manifest's `now`; tests inject a constant).
 */
export function buildReconstruction(
  soul: SoulStore,
  repoRoot: string,
  pkgId: string,
  now: string,
  opts: ReconstructionOpts = {},
): Reconstruction | undefined {
  const node = soul.getNode(pkgId);
  if (!node || node.type !== 'package') return undefined;
  const keep = (e: Edge): boolean => !opts.extractedOnly || e.provenance === 'EXTRACTED';
  const includeTables = opts.includeTables !== false;
  const maxSymbols = opts.maxSymbols ?? 1000;

  // One edge scan → outgoing (src→edges) + incoming (dst→edges) adjacency, reused for every member
  // (no per-member full-graph scan — the same pattern as buildDossier).
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const e of soul.iterateEdges()) {
    const o = outgoing.get(e.src);
    if (o) o.push(e);
    else outgoing.set(e.src, [e]);
    const i = incoming.get(e.dst);
    if (i) i.push(e);
    else incoming.set(e.dst, [e]);
  }

  // members: incoming `member-of` edges point child→parent, so members are the sources of the
  // package's incoming member-of edges, filtered to callables.
  const memberEdges = (incoming.get(pkgId) ?? []).filter((e) => e.rel === 'member-of' && keep(e));
  const memberNodes: Node[] = [];
  for (const e of memberEdges) {
    const m = soul.getNode(e.src);
    if (m?.type && CALLABLE_SYMBOL_TYPES.has(m.type)) memberNodes.push(m);
  }
  memberNodes.sort(byLine);
  const memberCount = memberNodes.length;
  const capped = memberNodes.slice(0, maxSymbols);
  const truncated = capped.length < memberCount;

  // referenced tables: walk member → executes → stmt → reads/writes → table node.
  const tables = new Map<string, ReconstructionTable>();
  const touch = (tableNode: Node | undefined, member: Node, rel: 'reads' | 'writes'): void => {
    if (!tableNode) return;
    if (!tableNode.name && !tableNode.qualifiedName) return;
    let entry = tables.get(tableNode.id);
    if (!entry) {
      const bare = String(tableNode.qualifiedName ?? tableNode.name ?? tableNode.id);
      entry = {
        id: tableNode.id,
        // schema-qualify when the table carries a schema (the form SQL references it as, e.g.
        // "app.loans"); fall back to the bare name / qualifiedName / id.
        name: tableNode.schema ? `${tableNode.schema}.${bare}` : bare,
        ...(tableNode.schema ? { schema: tableNode.schema } : {}),
        ...(tableNode.file ? { file: tableNode.file } : {}),
        readBy: [],
        writtenBy: [],
      };
      tables.set(tableNode.id, entry);
    }
    const memberLabel = String(member.qualifiedName ?? member.name ?? member.id);
    if (rel === 'reads') {
      if (!entry.readBy.includes(memberLabel)) entry.readBy.push(memberLabel);
    } else if (!entry.writtenBy.includes(memberLabel)) {
      entry.writtenBy.push(memberLabel);
    }
  };

  const members: ReconstructionMember[] = [];
  for (const m of capped) {
    const out = outgoing.get(m.id) ?? [];
    const execs = out.filter((e) => e.rel === 'executes' && keep(e));
    // referenced-by files: callers' files (incoming calls).
    const refFiles = new Set<string>();
    for (const e of incoming.get(m.id) ?? []) {
      if (e.rel !== 'calls' || !keep(e)) continue;
      const caller = soul.getNode(e.src);
      if (caller?.file) refFiles.add(caller.file);
    }
    // rules proxy: count of guard-annotated action edges (executes + calls) the member owns.
    const rulesCount = out.filter(
      (e) => (e.rel === 'executes' || e.rel === 'calls') && keep(e),
    ).length;

    if (includeTables) {
      for (const ex of execs) {
        for (const re of outgoing.get(ex.dst) ?? []) {
          if (!keep(re)) continue;
          if (re.rel === 'reads') touch(soul.getNode(re.dst), m, 'reads');
          else if (re.rel === 'writes') touch(soul.getNode(re.dst), m, 'writes');
        }
      }
      // WS-7: a cursor's SELECT reads its row-source tables. The cursor is declared by the member
      // (declares: member → cursor) and its reads fan out cursor → table. Follow that chain so a
      // procedure whose only read of a table is via a cursor still surfaces the table as readBy
      // (closes the Plan A vs Plan B gap: Plan B sees the cursor SELECT in the body).
      for (const dc of out) {
        if (dc.rel !== 'declares' || !keep(dc)) continue;
        for (const re of outgoing.get(dc.dst) ?? []) {
          if (!keep(re) || re.rel !== 'reads') continue;
          touch(soul.getNode(re.dst), m, 'reads');
        }
      }
    }

    members.push({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.qualifiedName ? { qualifiedName: m.qualifiedName } : {}),
      ...(m.signature ? { signature: m.signature } : {}),
      ...(m.type ? { type: m.type } : {}),
      ...(m.file ? { file: m.file } : {}),
      ...(m.span ? { line: m.span.start } : {}),
      implementation: {
        status: execs.length > 0 ? 'implemented' : 'unimplemented',
        executesCount: execs.length,
        referencedByFiles: [...refFiles].sort(),
      },
      rulesCount,
    });
  }

  // docs: describes/references pointing at the package OR any member. Sorted by confidence desc.
  const docTargets = new Set<string>([pkgId, ...capped.map((m) => m.id)]);
  const docs: ReconstructionDoc[] = [];
  for (const id of docTargets) {
    for (const e of incoming.get(id) ?? []) {
      if (!DOC_RELS.has(e.rel) || !keep(e) || e.confidence < 0) continue;
      const section = soul.getNode(e.src);
      const targetNode = soul.getNode(id);
      docs.push({
        sectionId: e.src,
        target: String(targetNode?.qualifiedName ?? targetNode?.name ?? id),
        ...(section?.heading ? { heading: section.heading } : {}),
        ...(section?.anchor ? { anchor: section.anchor } : {}),
        snippet: rehydrate(repoRoot, section),
        edgeType: e.rel as 'describes' | 'references',
        method: e.method,
        provenance: e.provenance,
        confidence: e.confidence,
      });
    }
  }
  docs.sort((a, b) => b.confidence - a.confidence);

  // package-state variables: split constants (CONSTANT) from the full set (constants + defaults).
  const allVars = readVariables(node);
  const constants = allVars.filter((v) => v.constant === true);
  const variables = allVars;

  const referencedTables = [...tables.values()]
    .map((t) => ({
      ...t,
      readBy: [...t.readBy].sort(),
      writtenBy: [...t.writtenBy].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: pkgId,
    schemaVersion: soul.getManifest().schemaVersion,
    nodeHash: node.hash,
    builtAt: now,
    shapeVersion: RECONSTRUCTION_SHAPE_VERSION,
    node: publicNode(node),
    ...(node.file ? { expectedBodyFile: expectedBodyFile(node.file) } : {}),
    constants,
    variables,
    members,
    referencedTables,
    docs,
    memberCount,
    truncated,
  };
}

/** Read `meta.variables` off a package node, coerced to the reconstruction shape (best-effort). */
function readVariables(node: Node): ReconstructionVariable[] {
  const raw = (node.meta as Record<string, unknown> | undefined)?.variables;
  if (!Array.isArray(raw)) return [];
  const out: ReconstructionVariable[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const v = entry as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name : '';
    if (!name) continue;
    out.push({
      name,
      ...(typeof v.dataType === 'string' ? { dataType: v.dataType } : {}),
      ...(typeof v.init === 'string' ? { init: v.init } : {}),
      ...(v.constant === true ? { constant: true } : {}),
      ...(v.exprTruncated === true ? { exprTruncated: true } : {}),
    });
  }
  return out;
}

/** Sort members by source line (stable, file-then-line), so the reconstruction reads top-to-bottom. */
function byLine(a: Node, b: Node): number {
  const la = a.span?.start ?? Number.POSITIVE_INFINITY;
  const lb = b.span?.start ?? Number.POSITIVE_INFINITY;
  if (la !== lb) return la - lb;
  return (a.qualifiedName ?? a.name ?? a.id) < (b.qualifiedName ?? b.name ?? b.id) ? -1 : 1;
}

// ── Markdown serializer ──────────────────────────────────────────────────────────────────────

/**
 * Render a reconstruction as Markdown. Deterministic: fixed field order so diffing two
 * reconstructions (PL/SQL vs the migrated .NET) is a clean textual diff. Sections emit ONLY when
 * non-empty (the same honesty contract as {@link dossierToMarkdown}).
 */
export function reconstructionToMarkdown(r: Reconstruction): string {
  const lines: string[] = [];
  const h = (s: string): void => void lines.push(s);
  const n = r.node;
  const title = String(n.qualifiedName ?? n.name ?? r.id);
  h(`# Reconstruct: ${title}`);
  h('');
  h(`- kind: ${String(n.kind)}`);
  if (n.type) h(`- type: ${String(n.type)}`);
  if (n.lang) h(`- lang: ${String(n.lang)}`);
  if (n.file)
    h(
      `- spec: ${String(n.file)}${n.span ? `:${String((n.span as { start: number }).start)}` : ''}`,
    );
  if (r.expectedBodyFile) h(`- expectedBodyFile: \`${r.expectedBodyFile}\``);
  h(`- members: ${r.memberCount}${r.truncated ? ` (capped at ${r.members.length})` : ''}`);
  h('');

  // Constants — the migration-critical thresholds. Emitted first so 30/80 are impossible to miss.
  if (r.constants.length > 0) {
    h('## Constants');
    h('| name | type | value |');
    h('|------|------|-------|');
    for (const c of r.constants) {
      h(`| ${c.name} | ${c.dataType ?? '—'} | ${fmtInit(c.init, c.exprTruncated)} |`);
    }
    h('');
  }

  // Defaults — plain package-state variables with initializers (non-constant).
  const defaults = r.variables.filter((v) => v.constant !== true && v.init !== undefined);
  if (defaults.length > 0) {
    h('## Defaults');
    h('| name | type | value |');
    h('|------|------|-------|');
    for (const d of defaults) {
      h(`| ${d.name} | ${d.dataType ?? '—'} | ${fmtInit(d.init, d.exprTruncated)} |`);
    }
    h('');
  }

  if (r.members.length > 0) {
    h('## Members');
    h('| name | type | file | status | rules | refs |');
    h('|------|------|------|--------|-------|------|');
    for (const m of r.members) {
      const loc = m.file ? `${m.file}:${m.line ?? '?'}` : '—';
      const status =
        m.implementation.status === 'implemented'
          ? `✓ ${m.implementation.executesCount}`
          : '⚠ unimplemented';
      h(
        `| ${m.qualifiedName ?? m.name ?? m.id} | ${m.type ?? '—'} | ${loc} | ${status} | ${m.rulesCount} | ${m.implementation.referencedByFiles.length} |`,
      );
    }
    h('');
  }

  if (r.referencedTables.length > 0) {
    h('## Referenced tables');
    h('| name | read by | written by |');
    h('|------|---------|------------|');
    for (const t of r.referencedTables) {
      h(`| ${t.name} | ${t.readBy.join(', ') || '—'} | ${t.writtenBy.join(', ') || '—'} |`);
    }
    h('');
  }

  if (r.docs.length > 0) {
    h('## Docs');
    for (const doc of r.docs) {
      h(`- ${doc.edgeType} → ${doc.target} (${doc.provenance}, ${doc.confidence}): ${doc.snippet}`);
    }
    h('');
  }

  return lines.join('\n');
}

/** Format an initializer for the markdown table, flagging fidelity-clipped values. */
function fmtInit(init: string | undefined, truncated?: boolean): string {
  if (init === undefined) return '—';
  return truncated ? `\`${init}\` ⚠ clipped` : `\`${init}\``;
}
