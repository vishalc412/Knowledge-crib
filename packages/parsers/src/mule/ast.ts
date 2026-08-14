/**
 * Mule XML AST — the bounded, namespace-aware in-memory representation produced by `parseMuleXml`
 * (xml.ts). This module is the single home for the structural interfaces the Mule extractor family
 * shares: the raw XML tree (parser output) and the semantic Mule shapes (imports, configuration,
 * error handlers, processors) the dialect normalizers (mule4/mule3) lift out of that tree.
 *
 * The AST is deliberately a plain-data tree (no live saxes references, no closures) so it survives a
 * structuredClone / worker-postMessage round trip unchanged — the worker-pool parse path relies on
 * that. Line numbers are 1-based (matching saxes + the diagnostic `Span` contract).
 */
import type { Span } from '@knowledge-crib/soul-schema';
import type { ExtractDiagnostic } from '../types.js';

/** A single namespace-aware XML attribute. `uri` is `''` for unqualified (no-prefix) attributes. */
export interface MuleXmlAttribute {
  uri: string;
  local: string;
  value: string;
}

/** A namespace-aware XML element with line spans, attributes, children, and coalesced text. */
export interface MuleXmlElement {
  uri: string;
  local: string;
  prefix: string;
  attributes: MuleXmlAttribute[];
  children: MuleXmlElement[];
  /** Coalesced text + CDATA content (whitespace preserved; inter-element whitespace included). */
  text: string;
  /** 1-based line of the opening `<tag`. */
  startLine: number;
  /** 1-based line of the closing `</tag>` (same as startLine for self-closing / single-line). */
  endLine: number;
}

/** A parsed Mule XML document: its root element plus any soft diagnostics. */
export interface MuleXmlDocument {
  root: MuleXmlElement;
  diagnostics: ExtractDiagnostic[];
}

/** A `<import>` / resource reference declared by a Mule config (resource path is a key, never a
 *  resolved secret — see source-policy). */
export interface MuleImport {
  resource: string;
  span: Span;
}

/** A `<configuration>` / global-element namespace + name with its raw (key-only) attributes. */
export interface MuleConfiguration {
  namespace: string;
  name: string;
  attributes: Record<string, string>;
  span: Span;
}

/** A Mule message processor. Same shape as {@link MuleXmlElement} — the alias documents that the
 *  element is being treated as a processor tree inside a flow / sub-flow / error handler. */
export interface MuleProcessor {
  uri: string;
  local: string;
  prefix: string;
  attributes: MuleXmlAttribute[];
  children: MuleProcessor[];
  text: string;
  startLine: number;
  endLine: number;
}

/** A Mule error-handler block (`<error-handler>`) with its strategy, optional error type, and the
 *  processor subtrees it dispatches to (`on-error-propagate`, `on-error-continue`, etc.). */
export interface MuleErrorHandler {
  strategy: string;
  errorType?: string;
  processors: MuleProcessor[];
  span: Span;
}
