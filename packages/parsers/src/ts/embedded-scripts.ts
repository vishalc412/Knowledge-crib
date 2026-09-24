/**
 * Code embedded in markup: inline `<script>` blocks in `.html`/`.htm`/`.vue`/`.svelte`/`.astro`, and
 * an Astro file's `---` frontmatter.
 *
 * The result keeps the file's exact length and line structure: every character outside a script
 * block becomes a space, newlines are kept. Parsing the masked text therefore yields spans and line
 * numbers that point at the real file, and the source policy's rehydration reads the right lines.
 */

/** Script types that carry data or templates, never code. Anything else inline is parsed. */
const NON_CODE_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'importmap',
  'speculationrules',
  'text/template',
  'text/x-template',
  'text/html',
  'text/plain',
  'text/markdown',
]);

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR = (name: string): RegExp => new RegExp(`\\b${name}\\s*=\\s*(["']?)([^"'\\s>]+)\\1`, 'i');

export const EMBEDDED_SCRIPT_EXTS = ['.html', '.htm', '.vue', '.svelte', '.astro'];

export function isEmbeddedScriptPath(path: string): boolean {
  const lower = path.toLowerCase();
  return EMBEDDED_SCRIPT_EXTS.some((e) => lower.endsWith(e));
}

export interface MaskedScripts {
  /** The file text with everything but script code blanked; same length and line breaks. */
  text: string;
  /** True when any block declares TypeScript (`lang="ts"`/`"tsx"`, a TS type) or is Astro frontmatter. */
  typescript: boolean;
  /** Number of code blocks kept. Zero means the file carries no inline code. */
  blocks: number;
}

export function maskToEmbeddedScripts(path: string, source: string): MaskedScripts {
  const keep: Array<[number, number]> = [];
  let typescript = false;

  if (path.toLowerCase().endsWith('.astro')) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (fm && fm[1] !== undefined) {
      const start = fm.index + fm[0].indexOf(fm[1]);
      keep.push([start, start + fm[1].length]);
      typescript = true;
    }
  }

  for (const m of source.matchAll(SCRIPT_BLOCK)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (ATTR('src').test(attrs)) continue;
    const type = ATTR('type').exec(attrs)?.[2]?.toLowerCase();
    if (type && NON_CODE_TYPES.has(type)) continue;
    if (body.trim().length === 0) continue;
    const lang = ATTR('lang').exec(attrs)?.[2]?.toLowerCase();
    if (
      lang === 'ts' ||
      lang === 'tsx' ||
      type === 'text/typescript' ||
      type === 'application/typescript'
    ) {
      typescript = true;
    }
    const start = (m.index ?? 0) + m[0].indexOf('>') + 1;
    keep.push([start, start + body.length]);
  }

  if (keep.length === 0) return { text: '', typescript: false, blocks: 0 };
  const out: string[] = source.split('').map((ch) => (ch === '\n' || ch === '\r' ? ch : ' '));
  for (const [a, b] of keep) for (let i = a; i < b; i++) out[i] = source[i]!;
  return { text: out.join(''), typescript, blocks: keep.length };
}
