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

/**
 * Semantic Mule shapes — the dialect-neutral structures the normalizers (mule4/mule3) lift out of
 * the raw XML tree. Both dialects share these so a Mule 3 normalizer can import them from here
 * without coupling to the Mule 4 module. `MuleDocument` is the common base; `Mule4Document` /
 * `Mule3Document` narrow its `dialect`.
 */

/** The high-level role a processor plays in a flow. Drives graph node stereotyping. */
export type MuleSemanticKind =
  | 'source' // a message source (the first element of a `<flow>`: http:listener, scheduler, …)
  | 'operation' // a generic connector operation (db:select, …)
  | 'router' // a routing construct (choice, scatter-gather, foreach, until-successful, …)
  | 'flow-ref' // a `<flow-ref>` call into another flow
  | 'transform' // an `<ee:transform>` DataWeave transform
  | 'outbound-call' // an outbound connector call (http:request, …)
  | 'raise-error'; // a `<raise-error>` explicit error

/** A DataWeave / expression payload attached to a processor attribute. `raw` is the literal source
 *  (`#[…]]`); `language` is 'dw2' when it parses as DataWeave 2, else 'unknown'. The raw text may
 *  reference property keys (`p('key')`) but never carries resolved secret values. */
export interface MuleExpression {
  raw: string;
  language: 'dw2' | 'unknown';
  span: Span;
}

/** A semantic Mule message processor. `namespace`/`operation` are the element's prefix + local name
 *  (e.g. `http` + `request`); `semanticKind` classifies it for the graph. Attribute values are
 *  sanitized: credential-like literals become `<redacted>`, `${key}`/`secure::key` stay as key
 *  references, and DataWeave `#[…]` payloads move to `expressions` (never into `attributes`). */
export interface MuleProcessor {
  namespace: string;
  operation: string;
  semanticKind: MuleSemanticKind;
  name?: string;
  configRef?: string;
  target?: string;
  attributes: Record<string, string>;
  expressions: MuleExpression[];
  children: MuleProcessor[];
  span: Span;
}

/** An error-handling strategy (`<on-error-propagate>` / `<on-error-continue>` / `<on-error>`)
 *  inside an `<error-handler>` block, with the processor subtree it dispatches to. */
export interface MuleErrorHandler {
  strategy: string;
  errorType?: string;
  processors: MuleProcessor[];
  span: Span;
}

/** A Mule flow (`<flow>`, with a message source) or sub-flow (`<sub-flow>`, invoked via flow-ref). */
export interface MuleFlow {
  name: string;
  kind: 'flow' | 'subflow';
  processors: MuleProcessor[];
  errorHandlers: MuleErrorHandler[];
  span: Span;
}

/** The dialect-neutral Mule document both normalizers produce. `dialect` is narrowed by
 *  `Mule4Document` / `Mule3Document`. */
export interface MuleDocument {
  dialect: 'mule3' | 'mule4';
  imports: MuleImport[];
  configurations: MuleConfiguration[];
  flows: MuleFlow[];
  diagnostics: ExtractDiagnostic[];
}
