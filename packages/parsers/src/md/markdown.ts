/**
 * A small, dependency-free Markdown section parser shared by the MarkdownExtractor (to build
 * `doc-section` nodes) and the cross-modal linker (to find linking signals). One source of truth for
 * how a doc splits into sections, so node ids and linker lookups always agree.
 *
 * A section spans from its ATX heading to the line before the next heading (any level). Nesting
 * (`member-of`) follows heading levels: a level-N heading is a member of the nearest preceding
 * heading of level < N.
 */
import { slugify } from '@knowledge-crib/soul-schema';

export interface MdSection {
  heading: string;
  level: number;
  /** unique within the doc (duplicate headings get -2, -3 … suffixes). */
  anchor: string;
  /** 1-based inclusive line range of the section's content (heading line .. before next heading). */
  startLine: number;
  endLine: number;
  /** parent section index within the same parse, or -1 for top-level. */
  parent: number;
  /** inline + fenced code tokens, for the explicit signal. */
  codeRefs: string[];
  /** link/target paths from `[text](path)`, for the path signal. */
  links: string[];
  /** prose with code spans stripped, for the identifier signal. */
  prose: string;
}

const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`([^`]+)`/g;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)/g;

/** Parse Markdown text into sections with linking fuel. */
export function parseMarkdownSections(text: string): MdSection[] {
  const lines = text.split('\n');
  // First pass: find heading positions.
  const heads: { level: number; heading: string; line: number }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX.exec(line);
    if (m) heads.push({ level: m[1]?.length ?? 1, heading: (m[2] ?? '').trim(), line: i + 1 });
  }
  if (heads.length === 0) return [];

  const sections: MdSection[] = [];
  const usedAnchors = new Map<string, number>();
  const stack: number[] = []; // indices into sections, by ascending level

  for (let h = 0; h < heads.length; h++) {
    const head = heads[h];
    if (!head) continue;
    const startLine = head.line;
    const endLine = (heads[h + 1]?.line ?? lines.length + 1) - 1;
    const body = lines.slice(startLine, endLine).join('\n'); // content after the heading line

    // unique anchor
    let anchor = slugify(head.heading) || `section-${h + 1}`;
    const seen = usedAnchors.get(anchor) ?? 0;
    usedAnchors.set(anchor, seen + 1);
    if (seen > 0) anchor = `${anchor}-${seen + 1}`;

    // nesting: pop deeper-or-equal levels, parent is whatever remains
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && (sections[top]?.level ?? 0) >= head.level) stack.pop();
      else break;
    }
    const parent = stack.length > 0 ? (stack[stack.length - 1] ?? -1) : -1;

    sections.push({
      heading: head.heading,
      level: head.level,
      anchor,
      startLine,
      endLine,
      parent,
      codeRefs: extractCodeRefs(body),
      links: extractLinks(body),
      prose: stripCode(body),
    });
    stack.push(sections.length - 1);
  }
  return sections;
}

function extractCodeRefs(body: string): string[] {
  const refs = new Set<string>();
  // inline code
  for (const m of body.matchAll(INLINE_CODE)) {
    const tok = (m[1] ?? '').trim();
    if (tok) refs.add(tok);
  }
  // fenced code: collect identifier-ish tokens line by line
  const lines = body.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    for (const tok of line.split(/[^A-Za-z0-9_.#/]+/)) {
      if (tok.length > 1) refs.add(tok);
    }
  }
  return [...refs];
}

function extractLinks(body: string): string[] {
  const links = new Set<string>();
  for (const m of body.matchAll(MD_LINK)) {
    const target = (m[1] ?? '').trim();
    // Keep internal links WITH their `#fragment` (in-page `#anchor` and cross-file `path#anchor`)
    // so the link signal can resolve to a doc-section / file / symbol target. External targets
    // (http/https/mailto) are not graph edges and are dropped.
    if (target && !target.startsWith('http') && !target.startsWith('mailto:')) links.add(target);
  }
  return [...links];
}

/** Remove inline + fenced code so identifier matching only sees prose. */
function stripCode(body: string): string {
  const noInline = body.replace(INLINE_CODE, ' ');
  const lines = noInline.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}
