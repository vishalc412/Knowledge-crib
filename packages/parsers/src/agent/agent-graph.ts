/**
 * Per-file AI-artifact extraction (PRD W1 §"Deterministic AI-artifact graph"). Turns ONE artifact
 * file (a tracked skill / agent / command / rule / instruction) into a single `agent-artifact` node
 * plus a set of admissibility-checked refs that the pipeline phase (`runArtifactGraph`) later
 * resolves into `governs` / `requires` / `invokes` edges (artifact→symbol, artifact→artifact,
 * artifact→file/doc-section). Pure + deterministic: no LLM, no filesystem, no cross-file state —
 * the caller owns discovery + resolution, so this stays unit-testable in isolation.
 *
 * Edge semantics (PRD line 189):
 *   - `governs`  — artifact → symbol/doc/file it defines policy or instructions for.
 *   - `requires` — artifact → symbol/artifact it depends on (a skill that needs another skill/command).
 *   - `invokes`  — artifact → command/route/handler it triggers.
 *
 * Refs come from two deterministic sources only (no prose heuristics — the whole point of W1 is
 * removing noisy prose matching):
 *   1. Frontmatter lists — `appliesTo`→governs, `requires`/`depends`/`dependsOn`→requires,
 *      `invokes`/`commands`/`triggers`→invokes. Author-declared, high confidence.
 *   2. Body explicit code spans / links — a backticked qualified name or path ref, and a markdown
 *      link target, both → `governs` (the artifact documents those symbols as its policy scope).
 *      Bare words are NOT turned into refs (the W1 exit gate: "no generic word such as 'edges'
 *      links to an unrelated symbol") — only refs containing `.` (qualified), `/` (path), or `#`
 *      (path#anchor) qualify from the body.
 */
import type { ArtifactType, Node } from '@knowledge-crib/soul-schema';
import { extractCodeRefs, extractLinks } from '../md/markdown.js';
import { parseFrontmatter } from './frontmatter.js';

export type ArtifactRel = 'governs' | 'requires' | 'invokes';

export interface ArtifactRef {
  /** the raw ref as written — a qualified name, path, path#anchor, or artifact name. */
  raw: string;
  rel: ArtifactRel;
  /** frontmatter list | explicit code span | markdown link */
  method: 'frontmatter' | 'explicit' | 'link';
  confidence: number;
}

export interface ArtifactExtract {
  node: Node;
  refs: ArtifactRef[];
}

const PATH_TYPE_RULES: { test: RegExp; type: ArtifactType }[] = [
  { test: /(^|\/)skills\//, type: 'skill' },
  { test: /(^|\/)agents\//, type: 'agent' },
  { test: /(^|\/)commands\//, type: 'command' },
  { test: /(^|\/)rules\//, type: 'rule' },
  { test: /(^|\/)\.cursor\/rules\//, type: 'rule' },
];

const VALID_TYPES = new Set<ArtifactType>([
  'instruction',
  'skill',
  'agent',
  'command',
  'rule',
  'mcp-server',
]);

/** Infer the artifact class from frontmatter `artifactType` (author override) else the file path. */
export function classifyArtifact(
  path: string,
  fields: Record<string, string | string[]>,
): ArtifactType {
  const declared = asScalar(fields.artifactType ?? fields.type);
  if (declared && VALID_TYPES.has(declared as ArtifactType)) return declared as ArtifactType;
  for (const rule of PATH_TYPE_RULES) {
    if (rule.test.test(path)) return rule.type;
  }
  // AGENTS.md / INSTRUCTIONS.md / .agentic.md and any other tracked markdown artifact
  return 'instruction';
}

/** The artifact's display name: frontmatter `name`/`title` else the parent dir (for SKILL.md-style
 *  files) else the filename stem. Stable so the `art:<path>#<name>` id is deterministic. */
export function artifactName(path: string, fields: Record<string, string | string[]>): string {
  const declared = asScalar(fields.name ?? fields.title);
  if (declared) return declared;
  const base = path.split('/').pop() ?? path;
  const stem = base.replace(/\.(md|mdc)$/i, '');
  // SKILL.md / AGENTS.md / INSTRUCTIONS.md → use the enclosing dir name (the real artifact identity)
  if (/^(SKILL|AGENTS|INSTRUCTIONS|AGENT)$/i.test(stem)) {
    const segs = path.split('/').filter(Boolean);
    const dir = segs.length > 1 ? segs[segs.length - 2] : stem;
    if (dir && !/^(\.claude|\.gstack|\.cursor|docs|skills|agents|commands|rules)$/i.test(dir))
      return dir;
    return stem;
  }
  return stem;
}

/**
 * Extract one `agent-artifact` node + its refs from a file's text. `hash` is the caller-computed
 * blake3 content hash; `idFn` is the schema id-grammar helper (passed in to keep this module free of
 * the soul-schema import graph beyond the type).
 */
export function extractArtifact(
  path: string,
  text: string,
  hash: string,
  idFn: (parts: { path: string; name: string }) => string,
): ArtifactExtract {
  const { fields, body } = parseFrontmatter(text);
  const name = artifactName(path, fields);
  const artifactType = classifyArtifact(path, fields);
  const lineCount = text.split('\n').length;

  const node: Node = {
    id: idFn({ path, name }),
    kind: 'agent-artifact',
    file: path,
    name,
    qualifiedName: name,
    artifactType,
    hash,
    span: { start: 1, end: lineCount },
    meta: { hasFrontmatter: Object.keys(fields).length > 0 },
  };
  const docType = asScalar(fields.docType ?? fields.doc_type);
  if (docType) node.docType = docType;
  const audience = asScalar(fields.audience);
  if (audience) node.audience = audience;
  const appliesTo = asList(fields.appliesTo ?? fields.applies_to);
  if (appliesTo.length > 0) node.appliesTo = appliesTo;

  const refs: ArtifactRef[] = [];
  // 1. frontmatter-declared refs (authoritative)
  for (const a of appliesTo)
    refs.push({ raw: a, rel: 'governs', method: 'frontmatter', confidence: 0.9 });
  for (const r of asList(
    fields.requires ?? fields.depends ?? fields.dependsOn ?? fields.dependencies,
  )) {
    refs.push({ raw: r, rel: 'requires', method: 'frontmatter', confidence: 0.9 });
  }
  for (const inv of asList(fields.invokes ?? fields.commands ?? fields.triggers)) {
    refs.push({ raw: inv, rel: 'invokes', method: 'frontmatter', confidence: 0.9 });
  }

  // 2. body explicit code spans → governs (only symbol-ish refs; bare words skipped — the W1 "edges"
  //    guard). A qualified name (`.`), path (`/`), or path#anchor (`#`) qualifies.
  for (const cr of extractCodeRefs(body)) {
    if (/[./#]/.test(cr))
      refs.push({ raw: cr, rel: 'governs', method: 'explicit', confidence: 0.8 });
  }
  // 3. body markdown links → governs (the artifact points at that path/symbol as its scope)
  for (const link of extractLinks(body)) {
    refs.push({ raw: link, rel: 'governs', method: 'link', confidence: 0.7 });
  }

  return { node, refs: dedupRefs(refs) };
}

function asScalar(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.length > 0 ? (v[0] ?? '') : undefined;
  return v || undefined;
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter((s) => s.length > 0);
  return v.trim().length > 0 ? [v.trim()] : [];
}

function dedupRefs(refs: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const out: ArtifactRef[] = [];
  for (const r of refs) {
    const key = `${r.rel}|${r.method}|${r.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
