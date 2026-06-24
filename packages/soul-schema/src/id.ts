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
  | { kind: 'condition'; file: string; line: number };

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
