import type { Rel } from './enums.js';
/**
 * The ID grammar — stable, deterministic, human-readable ids for every node kind plus edges.
 *
 * IDs MUST be reproducible across runs given unchanged source, so they drive:
 *  - stable git diffs (a renamed symbol changes its id; an unchanged one does not),
 *  - durable cross-tool references (SeeroFlow Tier-1 reads ids without an engine),
 *  - the `(src,dst,rel)` collapse for edges.
 *
 * Grammar (data-model §4 + deep-extraction §2, the merged 11 grammars):
 *   file        file:<path>
 *   symbol      sym:<path>#<qualifiedName>@L<startLine>
 *   doc-section doc:<path>#<anchor>
 *   media-seg   media:<path>#<tStartMs>
 *   explanation expl:<path>@L<startLine>
 *   cluster     c:<slug>
 *   table       table:<schema.NAME>
 *   column      col:<schema.TABLE.COL>           (col: prefix, `column` kind — intentional mismatch)
 *   statement   stmt:<file>@L<line>
 *   condition   cond:<file>@L<line>
 *   edge        e:<blake3(src|dst|rel)>
 *
 * 1.2 (deep-extraction fidelity):
 *   exception-handler  exc:<file>@L<line>      (one per WHEN handler, keyed by the WHEN line)
 *   raise              raise:<file>@L<line>
 *   cursor             cursor:<file>#<name>@L<line>
 *   assignment         assign:<file>@L<line>
 *   case-branch        case:<file>@L<line>      (one per CASE WHEN, keyed by the WHEN line)
 *
 * 1.6 (AI-artifact graph):
 *   agent-artifact     art:<path>#<name>        (a tracked instruction/skill/agent/command/rule/mcp-server)
 */
import { blake3Hex } from './hash.js';

/** Discriminated spec for {@link idFor}. One variant per node kind. */
export type IdSpec =
  | { kind: 'file'; path: string }
  | { kind: 'symbol'; path: string; qualifiedName: string; startLine: number }
  | { kind: 'doc-section'; path: string; anchor: string }
  | { kind: 'media-seg'; path: string; tStartMs: number }
  | { kind: 'explanation'; path: string; startLine: number }
  | { kind: 'cluster'; slug: string }
  | { kind: 'table'; schema: string; name: string }
  | { kind: 'column'; schema: string; table: string; column: string }
  | { kind: 'statement'; file: string; line: number }
  | { kind: 'condition'; file: string; line: number }
  | { kind: 'exception-handler'; file: string; line: number }
  | { kind: 'raise'; file: string; line: number }
  | { kind: 'cursor'; file: string; name: string; line: number }
  | { kind: 'assignment'; file: string; line: number }
  | { kind: 'case-branch'; file: string; line: number }
  // 1.3 framework-semantics
  | { kind: 'field'; path: string; qualifiedName: string; startLine: number }
  | { kind: 'route'; httpMethod: string; routePath: string; file: string; line: number }
  | { kind: 'component'; path: string; qualifiedName: string; startLine: number }
  // 1.4 ownership: a git author. Canonical identity is the email (stable across name changes); a
  // name-only fallback is used when blame exposed no email (encoded separately so it never collides
  // with an email-derived id).
  | { kind: 'owner'; email: string }
  | { kind: 'owner-name'; name: string }
  // 1.5 cross-repo federation: an outbound HTTP client call site. Mirrors the `route` id grammar
  // (`route:<method> <path>@<file>#L<line>`) so a runtime federation layer matches repo-A calls to
  // repo-B routes by method+path without a committed cross-repo edge.
  | { kind: 'http-call'; httpMethod: string; routePath: string; file: string; line: number }
  // 1.6 AI-artifact graph: a tracked AI artifact (instruction/skill/agent/command/rule/mcp-server).
  // Keyed by path + the artifact's stable name (the skill/agent/command name, or a slug of the
  // file stem for nameless artifacts) so a renamed body keeps its id while a renamed file does not.
  | { kind: 'agent-artifact'; path: string; name: string };

/** ID prefix per node kind. `column` deliberately uses `col:` (data-model reconciliation #6). */
export const ID_PREFIX = {
  file: 'file',
  symbol: 'sym',
  'doc-section': 'doc',
  'media-seg': 'media',
  explanation: 'expl',
  cluster: 'c',
  table: 'table',
  column: 'col',
  statement: 'stmt',
  condition: 'cond',
  'exception-handler': 'exc',
  raise: 'raise',
  cursor: 'cursor',
  assignment: 'assign',
  'case-branch': 'case',
  field: 'field',
  route: 'route',
  component: 'comp',
  owner: 'owner',
  'http-call': 'http-call',
  'agent-artifact': 'art',
} as const;

/** Build the deterministic id for a node from its identifying parts. */
export function idFor(spec: IdSpec): string {
  switch (spec.kind) {
    case 'file':
      return `file:${spec.path}`;
    case 'symbol':
      return `sym:${spec.path}#${spec.qualifiedName}@L${spec.startLine}`;
    case 'doc-section':
      return `doc:${spec.path}#${spec.anchor}`;
    case 'media-seg':
      return `media:${spec.path}#${spec.tStartMs}`;
    case 'explanation':
      return `expl:${spec.path}@L${spec.startLine}`;
    case 'cluster':
      return `c:${spec.slug}`;
    case 'table':
      return `table:${spec.schema}.${spec.name}`;
    case 'column':
      return `col:${spec.schema}.${spec.table}.${spec.column}`;
    case 'statement':
      return `stmt:${spec.file}@L${spec.line}`;
    case 'condition':
      return `cond:${spec.file}@L${spec.line}`;
    case 'exception-handler':
      return `exc:${spec.file}@L${spec.line}`;
    case 'raise':
      return `raise:${spec.file}@L${spec.line}`;
    case 'cursor':
      return `cursor:${spec.file}#${spec.name}@L${spec.line}`;
    case 'assignment':
      return `assign:${spec.file}@L${spec.line}`;
    case 'case-branch':
      return `case:${spec.file}@L${spec.line}`;
    case 'field':
      return `field:${spec.path}#${spec.qualifiedName}@L${spec.startLine}`;
    case 'route':
      return `route:${spec.httpMethod} ${spec.routePath}@${spec.file}#L${spec.line}`;
    case 'component':
      return `comp:${spec.path}#${spec.qualifiedName}@L${spec.startLine}`;
    case 'owner':
      return `owner:${spec.email}`;
    case 'owner-name':
      // name-only fallback (blame exposed no email): `owner:name:<slug>` keeps the `owner:` prefix
      // so it still resolves to an `owner` node, never colliding with an email-derived id.
      return `owner:name:${slugify(spec.name)}`;
    case 'http-call':
      return `http-call:${spec.httpMethod} ${spec.routePath}@${spec.file}#L${spec.line}`;
    case 'agent-artifact':
      return `art:${spec.path}#${spec.name}`;
  }
}

/**
 * Deterministic edge id: `e:` + blake3(`src|dst|rel`).
 * Collapses to one id per `(src,dst,rel)` triple — the unit the conflict rule resolves.
 */
export function edgeId(src: string, dst: string, rel: Rel): string {
  return `e:${blake3Hex(`${src}|${dst}|${rel}`)}`;
}

/** The id-prefix portion (before the first `:`) of any id, or undefined if malformed. */
export function idPrefix(id: string): string | undefined {
  const i = id.indexOf(':');
  return i === -1 ? undefined : id.slice(0, i);
}

/** Slugify an arbitrary label into a cluster slug: lowercase, alnum + dashes, collapsed. */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}
