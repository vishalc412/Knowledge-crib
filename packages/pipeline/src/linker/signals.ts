/**
 * The deterministic linker signals (pipeline §Phase 4, signals 1–3). Each returns candidate hits
 * for one doc-section. Signal 4 (semantic/ANN) is INFERRED and lands at M7 — it lives elsewhere so
 * the deterministic core never depends on vectors.
 */
import { dirname, join, sep } from 'node:path';
import type { MdSection } from '@knowledge-crib/parsers';
import type { Method, Node } from '@knowledge-crib/soul-schema';
import type { InvertedIndex } from './inverted-index.js';

export interface SignalHit {
  symbol: Node;
  method: Method;
  conf: number;
}

const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
/** Identifiers shorter than this are too noisy to match in prose. */
const MIN_IDENTIFIER_LEN = 3;

/** Signal 1 — explicit code-ref: a code token equals a qualifiedName, path#symbol, or unique name. */
export function explicitSignal(section: MdSection, index: InvertedIndex): SignalHit[] {
  const hits: SignalHit[] = [];
  for (const raw of section.codeRefs) {
    const token = raw.replace(/\(\)$/, ''); // strip trailing () on method refs
    const byQn = index.qualified(token);
    if (byQn) {
      hits.push({ symbol: byQn, method: 'explicit', conf: 0.95 });
      continue;
    }
    if (token.includes('#')) {
      const [path, qn] = token.split('#');
      const sym = qn ? index.qualified(qn) : undefined;
      if (sym && path && sym.file?.endsWith(path)) {
        hits.push({ symbol: sym, method: 'explicit', conf: 0.95 });
        continue;
      }
    }
    // bare, unambiguous name in code → explicit
    if (index.nameIsUnique(token)) {
      const sym = index.symbolsNamed(token)[0];
      if (sym) hits.push({ symbol: sym, method: 'explicit', conf: 0.95 });
    }
  }
  return hits;
}

/** Signal 2 — identifier mention: a symbol name at a word boundary in prose; boosted by siblings. */
export function identifierSignal(section: MdSection, index: InvertedIndex): SignalHit[] {
  const words = new Set(section.prose.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  const candidates: Node[] = [];
  for (const w of words) {
    if (w.length < MIN_IDENTIFIER_LEN) continue;
    for (const sym of index.symbolsNamed(w)) candidates.push(sym);
  }
  // sibling boost: if 2+ candidate symbols share a file, that file's matches are stronger.
  const perFile = new Map<string, number>();
  for (const c of candidates) if (c.file) perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1);
  return candidates.map((sym) => {
    const siblings = sym.file ? (perFile.get(sym.file) ?? 1) : 1;
    const conf = siblings >= 2 ? 0.8 : 0.6;
    return { symbol: sym, method: 'identifier' as Method, conf };
  });
}

/** Signal 3 — path/link: a MD link to a source file → references to all symbols in that file. */
export function pathSignal(section: MdSection, docFile: string, index: InvertedIndex): SignalHit[] {
  const hits: SignalHit[] = [];
  for (const link of section.links) {
    for (const resolved of resolveCandidates(docFile, link)) {
      for (const sym of index.symbolsInFile(resolved)) {
        hits.push({ symbol: sym, method: 'path', conf: 0.5 });
      }
    }
  }
  return hits;
}

/** Candidate repo-relative file paths a doc link could mean (handles relative + .js→.ts). */
function resolveCandidates(docFile: string, link: string): string[] {
  const clean = link.split('#')[0] ?? link;
  if (!clean) return [];
  const baseDir = dirname(docFile);
  const target = clean.startsWith('.') ? norm(join(baseDir, clean)) : clean;
  const jsExt = JS_EXTS.find((e) => target.endsWith(e));
  const bare = jsExt ? target.slice(0, -jsExt.length) : target;
  const out = new Set<string>([target, bare]);
  if (!TS_EXTS.some((e) => bare.endsWith(e))) for (const e of TS_EXTS) out.add(bare + e);
  return [...out];
}

function norm(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
