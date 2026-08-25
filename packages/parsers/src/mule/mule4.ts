/**
 * Mule 4 semantic normalizer — lifts the raw {@link MuleXmlDocument} tree (xml.ts) into a
 * {@link Mule4Document}: typed flows, semantic processors, error handlers, imports, and global
 * configurations. This layer is what the extractor (MuleExtractor.ts) and resolver (mule-resolver.ts)
 * consume; it never touches the wire format again.
 *
 * SECURITY (locked constraint): attribute values are sanitized by {@link processAttributes} BEFORE
 * any node, processor, or diagnostic is constructed. Credential-like literal values become
 * `<redacted>`; `${key}` / `secure::key` placeholders stay as key references (the resolved value
 * lives in a properties file the indexer never stores); DataWeave `#[…]` payloads move to
 * `expressions`. A literal secret can never reach the graph.
 */
import type { Span } from '@knowledge-crib/soul-schema';
import type { ExtractDiagnostic } from '../types.js';
import type {
  MuleConfiguration,
  MuleDocument,
  MuleErrorHandler,
  MuleExpression,
  MuleFlow,
  MuleImport,
  MuleProcessor,
  MuleSemanticKind,
  MuleXmlAttribute,
  MuleXmlDocument,
  MuleXmlElement,
} from './ast.js';
import { parseMuleXml } from './xml.js';

/** A Mule 4 document — the mule4 narrowing of the shared {@link MuleDocument}. */
export interface Mule4Document extends Omit<MuleDocument, 'dialect'> {
  dialect: 'mule4';
}

/** Router constructs (control-flow) that get `semanticKind: 'router'`. */
const ROUTER_LOCALS = new Set([
  'choice',
  'scatter-gather',
  'foreach',
  'parallel-foreach',
  'until-successful',
  'round-robin',
  'dynamic-router',
  'first-successful',
]);

/** Message-source locals — the first element of a `<flow>` with one of these is a `source`. */
const SOURCE_LOCALS = new Set([
  'listener',
  'scheduler',
  'poll',
  'message-source',
  'inbound-endpoint',
]);

/** Attribute local names whose literal values are credential-like → redacted (references kept). */
const CREDENTIAL_RE =
  /(password|passwd|pwd|secret|credential|token|api[-_]?key|private[-_]?key|keystore)/i;

/** A property-placeholder reference (`${key}`) or a `secure::key` secure-property reference — both
 *  are KEY references, never resolved secret values, so they are kept verbatim. */
function isReference(value: string): boolean {
  return value.includes('${') || value.startsWith('secure::');
}

/** DataWeave expression payload (`#[…]`) — moved to `expressions`, not the generic attr map. */
function isDataWeave(value: string): boolean {
  return value.startsWith('#[');
}

/** Outbound connector call (HTTP request is the canonical outbound operation). */
function isOutboundCall(local: string): boolean {
  return local === 'request' || local === 'send';
}

/** Classify a processor by its prefix/local + whether it occupies the flow's source position. */
function classify(prefix: string, local: string, isSource: boolean): MuleSemanticKind {
  if (local === 'flow-ref') return 'flow-ref';
  if (local === 'raise-error') return 'raise-error';
  if (ROUTER_LOCALS.has(local)) return 'router';
  if (local === 'transform' && prefix === 'ee') return 'transform';
  if (isSource && SOURCE_LOCALS.has(local)) return 'source';
  if (isOutboundCall(local)) return 'outbound-call';
  return 'operation';
}

interface ProcessedAttrs {
  attrs: Record<string, string>;
  expressions: MuleExpression[];
  name?: string;
  configRef?: string;
  target?: string;
}

/** Sanitize a raw attribute list into the generic `attributes` map + lifted named fields + DW
 *  expressions. Credential literals → `<redacted>`; references + DW expressions never carry a
 *  resolved secret value. */
function processAttributes(rawAttrs: MuleXmlAttribute[], startLine: number): ProcessedAttrs {
  const attrs: Record<string, string> = {};
  const expressions: MuleExpression[] = [];
  let name: string | undefined;
  let configRef: string | undefined;
  let target: string | undefined;
  for (const a of rawAttrs) {
    const key = a.local;
    const value = a.value;
    if (key === 'name') {
      name = value;
      continue;
    }
    if (key === 'config-ref') {
      configRef = value;
      continue;
    }
    if (key === 'target') {
      target = value;
      continue;
    }
    if (isDataWeave(value)) {
      expressions.push({ raw: value, language: 'dw2', span: { start: startLine, end: startLine } });
      continue;
    }
    if (CREDENTIAL_RE.test(key) && !isReference(value)) {
      attrs[key] = '<redacted>';
      continue;
    }
    attrs[key] = value;
  }
  return { attrs, expressions, name, configRef, target };
}

const spanOf = (el: MuleXmlElement): Span => ({ start: el.startLine, end: el.endLine });

/** Build a semantic processor from an XML element. `isSource` marks the flow's source position. */
function buildProcessor(el: MuleXmlElement, isSource: boolean): MuleProcessor {
  const { attrs, expressions, name, configRef, target } = processAttributes(
    el.attributes,
    el.startLine,
  );
  const children: MuleProcessor[] = [];
  for (const child of el.children) {
    // Nested `<error-handler>` (e.g. inside `<try>`) is not a processor; the flow-level walker
    // owns error-handler parsing. Skipping here keeps the processor tree control-flow-only.
    if (child.local === 'error-handler') continue;
    children.push(buildProcessor(child, false));
  }
  const processor: MuleProcessor = {
    namespace: el.prefix,
    operation: el.local,
    semanticKind: classify(el.prefix, el.local, isSource),
    attributes: attrs,
    expressions,
    children,
    span: spanOf(el),
  };
  if (name !== undefined) processor.name = name;
  if (configRef !== undefined) processor.configRef = configRef;
  if (target !== undefined) processor.target = target;
  return processor;
}

/** Parse an `<error-handler>` block: each `<on-error-*>` child becomes one {@link MuleErrorHandler}
 *  carrying its strategy + error type + processor subtree. */
function buildErrorHandlers(el: MuleXmlElement): MuleErrorHandler[] {
  const handlers: MuleErrorHandler[] = [];
  for (const child of el.children) {
    if (!child.local.startsWith('on-error')) continue;
    const errorType = child.attributes.find((a) => a.local === 'type')?.value;
    const processors = child.children
      .filter((c) => c.local !== 'error-handler')
      .map((c) => buildProcessor(c, false));
    const handler: MuleErrorHandler = {
      strategy: child.local,
      processors,
      span: spanOf(child),
    };
    if (errorType !== undefined) handler.errorType = errorType;
    handlers.push(handler);
  }
  return handlers;
}

/** Parse a Mule 4 config XML source into a {@link Mule4Document}. Throws {@link MuleXmlError} on a
 *  malformed/hostile XML payload (see xml.ts); otherwise never throws — unclassifiable elements
 *  degrade to `operation` processors with diagnostics. */
export function parseMule4(xml: string): Mule4Document {
  const doc: MuleXmlDocument = parseMuleXml(xml);
  const root = doc.root;
  const diagnostics: ExtractDiagnostic[] = [...doc.diagnostics];

  const imports: MuleImport[] = [];
  const configurations: MuleConfiguration[] = [];
  const flows: MuleFlow[] = [];

  for (const child of root.children) {
    const local = child.local;
    if (local === 'import') {
      const resource = child.attributes.find((a) => a.local === 'resource')?.value ?? '';
      imports.push({ resource, span: spanOf(child) });
      continue;
    }
    if (local === 'flow' || local === 'sub-flow') {
      const name = child.attributes.find((a) => a.local === 'name')?.value ?? '';
      const processors: MuleProcessor[] = [];
      const errorHandlers: MuleErrorHandler[] = [];
      let isSource = local === 'flow'; // only `<flow>` has a message source (first processor)
      for (const pc of child.children) {
        if (pc.local === 'error-handler') {
          errorHandlers.push(...buildErrorHandlers(pc));
          continue;
        }
        processors.push(buildProcessor(pc, isSource));
        isSource = false; // only the first processor is the source
      }
      flows.push({
        name,
        kind: local === 'flow' ? 'flow' : 'subflow',
        processors,
        errorHandlers,
        span: spanOf(child),
      });
      continue;
    }
    // Global configuration element (http:listener-config, db:config, …) — has a `name` attr and a
    // connector namespace. Lift its name + sanitized attributes; values are key references only.
    const name = child.attributes.find((a) => a.local === 'name')?.value;
    const { attrs } = processAttributes(child.attributes, child.startLine);
    configurations.push({
      namespace: child.prefix,
      name: name ?? child.local,
      attributes: attrs,
      span: spanOf(child),
    });
  }

  return {
    dialect: 'mule4',
    imports,
    configurations,
    flows,
    diagnostics,
  };
}

export { processAttributes as sanitizeMuleAttributes };
