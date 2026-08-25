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

/**
 * Signal 3 — link: an internal Markdown link resolves to ONE target node (file / doc-section /
 * symbol), preserving the `#fragment`. Replaces the W0 path fan-out (one link → every symbol in the
 * file) which let a generic doc link masquerade as N describes/references. PRD W1 markdown fidelity:
 * a source-file link points at the FILE node; `path#anchor` points at the doc-section; `path#name`
 * points at the one symbol named `name` (ambiguous → diagnostic). Unresolved links are diagnostics,
 * never guessed edges. External (http/mailto) targets are ignored, not diagnosed.
 */
export interface LinkDiagnostic {
  /** repo-relative doc file containing the link. */
  docFile: string;
  /** anchor of the doc-section the link lives in. */
  anchor: string;
  /** raw MD link target as written. */
  target: string;
  kind: 'unresolved' | 'ambiguous';
  reason: string;
}

export interface LinkSignalResult {
  hits: SignalHit[];
  diagnostics: LinkDiagnostic[];
}

const SOURCE_EXTS = [...JS_EXTS, ...TS_EXTS];

export function linkSignal(
  section: MdSection,
  docFile: string,
  index: InvertedIndex,
): LinkSignalResult {
  const hits: SignalHit[] = [];
  const diagnostics: LinkDiagnostic[] = [];
  for (const raw of section.links) {
    if (raw.startsWith('http') || raw.startsWith('mailto:')) continue;

    // split `path#anchor` (or in-page `#anchor`); preserve the fragment.
    let pathPart: string;
    let anchor: string | undefined;
    if (raw.startsWith('#')) {
      pathPart = docFile;
      anchor = raw.slice(1);
    } else {
      const hashIdx = raw.indexOf('#');
      if (hashIdx >= 0) {
        pathPart = raw.slice(0, hashIdx);
        anchor = raw.slice(hashIdx + 1);
      } else {
        pathPart = raw;
        anchor = undefined;
      }
    }

    if (anchor !== undefined && anchor.length > 0) {
      // `path#anchor` → doc-section first (a heading slug); else a symbol named `anchor` in a
      // source file (`path#symbolName`); else unresolved/ambiguous diagnostic.
      let resolved = false;
      for (const cand of resolveCandidates(docFile, pathPart)) {
        const ds = index.docSection(cand, anchor);
        if (ds) {
          hits.push({ symbol: ds, method: 'path', conf: 0.8 });
          resolved = true;
          break;
        }
      }
      if (!resolved && SOURCE_EXTS.some((e) => pathPart.endsWith(e))) {
        let matched: Node[] = [];
        for (const cand of resolveCandidates(docFile, pathPart)) {
          const syms = index.symbolsInFile(cand).filter((s) => s.name === anchor);
          if (syms.length > 0) {
            matched = syms;
            break;
          }
        }
        if (matched.length === 1) {
          hits.push({ symbol: matched[0]!, method: 'path', conf: 0.8 });
          resolved = true;
        } else if (matched.length > 1) {
          diagnostics.push({
            docFile,
            anchor: section.anchor,
            target: raw,
            kind: 'ambiguous',
            reason: `${matched.length} symbols named '${anchor}' in ${pathPart}`,
          });
          resolved = true;
        }
      }
      if (!resolved) {
        diagnostics.push({
          docFile,
          anchor: section.anchor,
          target: raw,
          kind: 'unresolved',
          reason: `no doc-section or symbol '${anchor}' at ${pathPart}`,
        });
      }
    } else {
      // bare path → the FILE node (ONE references edge, no fan-out). PRD #2.
      let resolved = false;
      for (const cand of resolveCandidates(docFile, pathPart)) {
        const fn = index.fileNode(cand);
        if (fn) {
          hits.push({ symbol: fn, method: 'path', conf: 0.7 });
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        diagnostics.push({
          docFile,
          anchor: section.anchor,
          target: raw,
          kind: 'unresolved',
          reason: `no indexed file at ${pathPart}`,
        });
      }
    }
  }
  return { hits, diagnostics };
}

/** Candidate repo-relative file paths a doc link's path part could mean (relative + .js→.ts). */
function resolveCandidates(docFile: string, pathPart: string): string[] {
  if (!pathPart) return [];
  const baseDir = dirname(docFile);
  const target = pathPart.startsWith('.') ? norm(join(baseDir, pathPart)) : pathPart;
  const jsExt = JS_EXTS.find((e) => target.endsWith(e));
  const bare = jsExt ? target.slice(0, -jsExt.length) : target;
  const out = new Set<string>([target, bare]);
  if (!TS_EXTS.some((e) => bare.endsWith(e))) for (const e of TS_EXTS) out.add(bare + e);
  return [...out];
}

function norm(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
