/**
 * Mule XML parser — a secure, namespace-aware SAX front over `saxes` that materializes a bounded
 * {@link MuleXmlDocument}. This is the sole entry to Mule config XML for the extractor family; it
 * never resolves external entities, never fetches network resources, and never expands custom
 * entities — DTDs are rejected outright to close the XXE surface (no `<!ENTITY … SYSTEM …>`, no
 * external DTD subset). The tree is plain data so it survives a worker postMessage unchanged.
 *
 * Bounds: nesting depth is capped at {@link MAX_DEPTH} and total element count at
 * {@link MAX_ELEMENTS}; exceeding either aborts with a positioned {@link MuleXmlError}. These guard
 * against quadratic / pathologically deep inputs (Mule configs are shallow — a few hundred elements
 * at most) without truncating real projects.
 */
import { SaxesParser } from 'saxes';
import type { SaxesTagNS } from 'saxes';
import type { MuleXmlAttribute, MuleXmlDocument, MuleXmlElement } from './ast.js';

/** Maximum nesting depth (root = depth 1). Real Mule configs rarely exceed ~20. */
export const MAX_DEPTH = 256;
/** Maximum total element count. Bounds the AST cost of a runaway / hostile document. */
export const MAX_ELEMENTS = 100_000;

/** Error thrown by `parseMuleXml` on a malformed, hostile, or out-of-bounds document. Carries the
 *  1-based saxes line/column so callers can stamp a diagnostic span. */
export class MuleXmlError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`${line}:${column}: ${message}`);
    this.name = 'MuleXmlError';
    this.line = line;
    this.column = column;
  }
}

/** Parse a Mule config XML source into a bounded, namespace-aware {@link MuleXmlDocument}. Throws
 *  {@link MuleXmlError} on DTD/entity payloads, malformed XML, or bound violations. */
export function parseMuleXml(source: string): MuleXmlDocument {
  const parser = new SaxesParser({ xmlns: true, position: true });

  const stack: MuleXmlElement[] = [];
  let root: MuleXmlElement | null = null;
  let pendingStartLine = 1;
  let elementCount = 0;

  const top = (): MuleXmlElement => {
    const el = stack[stack.length - 1];
    if (!el)
      throw new MuleXmlError('unexpected text outside root element', parser.line, parser.column);
    return el;
  };

  const fail = (message: string): never => {
    throw new MuleXmlError(message, parser.line, parser.column);
  };

  parser.on('doctype', () => {
    // Reject ALL DTDs — internal subset entity declarations are the XXE vector. saxes does not
    // expand external entities by default, but a DTD still lets a document declare custom entities
    // and (with `SYSTEM`) name external resources; refusing the whole construct is the safe default
    // for a code-intelligence indexer that never needs DTD validation.
    throw new MuleXmlError('DTD declarations are not permitted', parser.line, parser.column);
  });

  parser.on('error', (err: Error) => {
    throw new MuleXmlError(err.message, parser.line, parser.column);
  });

  parser.on('opentagstart', () => {
    // saxes fires this once the tag name is read (before attributes / `>`). The parser line at this
    // point is the line of the `<tag` — the span start we want. There cannot be a nested opentag
    // before the matching opentag, so a single pending slot is safe.
    pendingStartLine = parser.line;
  });

  parser.on('opentag', (tag: SaxesTagNS) => {
    elementCount++;
    if (elementCount > MAX_ELEMENTS) {
      fail(`element count exceeds limit (${MAX_ELEMENTS})`);
    }
    const depth = stack.length + 1;
    if (depth > MAX_DEPTH) {
      fail(`nesting depth exceeds limit (${MAX_DEPTH})`);
    }
    const attributes: MuleXmlAttribute[] = [];
    for (const key of Object.keys(tag.attributes)) {
      const a = tag.attributes[key];
      if (!a) continue;
      attributes.push({ uri: a.uri, local: a.local, value: a.value });
    }
    const el: MuleXmlElement = {
      uri: tag.uri,
      local: tag.local,
      prefix: tag.prefix,
      attributes,
      children: [],
      text: '',
      startLine: pendingStartLine,
      endLine: pendingStartLine,
    };
    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(el);
    } else {
      root = el;
    }
    stack.push(el);
  });

  parser.on('closetag', () => {
    // saxes fires this after reading the closing `>`; the parser line is still the line of that
    // `>` (the trailing newline has not been consumed yet), so this is the span end we want.
    const el = stack.pop();
    if (el) el.endLine = parser.line;
  });

  parser.on('text', (text: string) => {
    if (text.length === 0) return;
    // Whitespace between the `<?xml …?>` declaration and the root element (and trailing whitespace
    // after the root closes) is legal XML prolog/epilog — every real Mule config and pom.xml starts
    // with `<?xml?>\n<mule>`. Ignore whitespace-only text outside the root; only non-whitespace text
    // outside the root is genuinely malformed.
    if (stack.length === 0 && text.trim() === '') return;
    top().text += text;
  });

  parser.on('cdata', (cdata: string) => {
    if (cdata.length === 0) return;
    top().text += cdata;
  });

  try {
    parser.write(source);
    parser.close();
  } catch (err) {
    if (err instanceof MuleXmlError) throw err;
    // A non-MuleXmlError thrown out of saxes internals — wrap with the live position.
    const message = err instanceof Error ? err.message : String(err);
    throw new MuleXmlError(message, parser.line, parser.column);
  }

  if (!root) {
    throw new MuleXmlError('no root element', parser.line, parser.column);
  }

  return { root, diagnostics: [] };
}
