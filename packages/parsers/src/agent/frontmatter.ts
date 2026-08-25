/**
 * Bounded YAML frontmatter parser for AI-artifact + markdown files (PRD W1 line 208: "Parse bounded
 * frontmatter for document type, ownership, audience, and applicability").
 *
 * Deliberately tiny + safe. Parses ONLY a leading `---\n…\n---` block of:
 *   - scalar `key: value` pairs (optionally quoted with `"` or `'`),
 *   - block lists `key:` followed by `  - item` lines,
 *   - flow lists `key: [a, b, c]`.
 * No nested maps, no anchors/aliases, no multi-line block scalars, no tags, no merge keys. Anything
 * the parser cannot parse cleanly is left out — frontmatter is best-effort metadata, never load-
 * bearing, and the file still indexes. Never throws. Values are kept as strings (booleans/numbers
 * stay strings): the consumers (docType/audience/appliesTo/requires/invokes) want strings + string
 * lists, not typed YAML, so a `true` in frontmatter is the string "true" — fine for metadata.
 */
export interface ParsedFrontmatter {
  fields: Record<string, string | string[]>;
  /** the body after the closing fence (or the whole text when there is no frontmatter). */
  body: string;
  /** 1-based line where the post-frontmatter body begins (1 when there is no frontmatter). */
  bodyStartLine: number;
}

const FENCE_RE = /^---\s*$/;
const SCALAR_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s+(.*)$/;

/**
 * Parse a leading frontmatter block. When the text does not start with a `---` fence, or the fence is
 * never closed, returns the whole text as `body` with empty `fields` (graceful — not a frontmatter
 * file). Nested-map lines (an indented `key:` under a scalar) are skipped, not mis-parsed.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split('\n');
  if (lines.length === 0 || !FENCE_RE.test(lines[0] ?? '')) {
    return { fields: {}, body: text, bodyStartLine: 1 };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i] ?? '')) {
      close = i;
      break;
    }
  }
  if (close === -1) return { fields: {}, body: text, bodyStartLine: 1 }; // unterminated → not frontmatter

  const fmLines = lines.slice(1, close);
  const fields: Record<string, string | string[]> = {};
  let i = 0;
  while (i < fmLines.length) {
    const raw = fmLines[i] ?? '';
    i++;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = SCALAR_RE.exec(raw);
    if (!m) continue;
    const key = m[1] as string;
    const val = (m[2] ?? '').trim();

    // flow list: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1);
      fields[key] = inner
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
      continue;
    }
    if (val === '') {
      // block list: collect following `  - item` lines
      const items: string[] = [];
      while (i < fmLines.length) {
        const nxt = fmLines[i] ?? '';
        const im = LIST_ITEM_RE.exec(nxt);
        if (!im) break;
        items.push(unquote((im[1] ?? '').trim()));
        i++;
      }
      if (items.length > 0) {
        fields[key] = items;
        continue;
      }
      fields[key] = ''; // empty value scalar
      continue;
    }
    fields[key] = unquote(val);
  }

  const body = lines.slice(close + 1).join('\n');
  return { fields, body, bodyStartLine: close + 2 };
}

/** Strip a single layer of matching surrounding quotes (`"` or `'`); leave everything else verbatim. */
function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1);
  }
  return s;
}
