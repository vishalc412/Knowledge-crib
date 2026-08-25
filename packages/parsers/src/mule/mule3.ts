/**
 * Mule 3 semantic normalizer — lifts the raw {@link MuleXmlDocument} tree (xml.ts) into a
 * {@link Mule3Document}: typed flows/sub-flows, semantic processors, error handlers (exception
 * strategies), imports, and global configurations. It emits the SAME {@link MuleDocument} vocabulary
 * the Mule 4 normalizer (mule4.ts) produces, so the shared extractor (MuleExtractor.ts) and resolver
 * (mule-resolver.ts) consume one dialect-neutral shape.
 *
 * Mule 3 differences vs Mule 4 that this module owns:
 *  - `inbound-endpoint` is a message source; `outbound-endpoint` is an outbound call (Mule 4 uses
 *    `http:listener` / `http:request`).
 *  - exception strategies (`catch`/`rollback`/`choice`/`reference-exception-strategy`) are DIRECT
 *    children of a flow, not wrapped in `<error-handler>`. A `choice-exception-strategy` flattens to
 *    its nested alternative strategies (each becomes its own handler).
 *  - `processor-chain`/`chain` are inlined so their children retain order in the enclosing flow.
 *  - inline `#[…]` expressions are MEL (Mule Expression Language), tagged `language: 'mel'` (NOT
 *    'dw2' — that is the Mule 4 DataWeave 2 tag).
 *
 * SECURITY (locked constraint): attribute values are sanitized by {@link processAttributesMule3}
 * BEFORE any node/processor/diagnostic is built. Credential-like literal values become `<redacted>`;
 * `${key}` / `secure::key` placeholders stay as key references (the resolved value lives in a
 * properties file the indexer never stores); `#[…]` payloads move to `expressions`. A literal secret
 * can never reach the graph. This mirrors the Mule 4 sanitizer; it is duplicated (not imported) to
 * keep the Mule 3 normalizer decoupled from the Mule 4 module and to tag MEL honestly.
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

/** A Mule 3 document — the mule3 narrowing of the shared {@link MuleDocument}. */
export interface Mule3Document extends Omit<MuleDocument, 'dialect'> {
  dialect: 'mule3';
}

/** Router/control-flow constructs that get `semanticKind: 'router'`. Includes Mule 3 `async`. */
const ROUTER_LOCALS = new Set([
  'choice',
  'scatter-gather',
  'async',
  'foreach',
  'parallel-foreach',
  'until-successful',
  'round-robin',
  'first-successful',
  'collection-bulk-iterator',
]);

/** Message-source locals — the first element of a `<flow>` with one of these is a `source`. */
const SOURCE_LOCALS = new Set([
  'inbound-endpoint',
  'poll',
  'scheduler',
  'message-source',
  'quartz',
  'listener',
]);

/** Exception-strategy element local names → the strategy label stored on {@link MuleErrorHandler}. */
const EXCEPTION_STRATEGY_SUFFIX = '-exception-strategy';
const EXCEPTION_STRATEGIES = new Set([
  'catch-exception-strategy',
  'rollback-exception-strategy',
  'choice-exception-strategy',
  'reference-exception-strategy',
]);
const isExceptionStrategy = (local: string): boolean => EXCEPTION_STRATEGIES.has(local);
const strategyOf = (local: string): string => local.slice(0, -EXCEPTION_STRATEGY_SUFFIX.length);

/** Attribute local names whose literal values are credential-like → redacted (references kept). */
const CREDENTIAL_RE =
  /(password|passwd|pwd|secret|credential|token|api[-_]?key|private[-_]?key|keystore)/i;

/** A property-placeholder reference (`${key}`) or `secure::key` — KEY references, kept verbatim. */
function isReference(value: string): boolean {
  return value.includes('${') || value.startsWith('secure::');
}

/** A MEL expression payload (`#[…]`) — moved to `expressions`, not the generic attr map. */
function isMel(value: string): boolean {
  return value.startsWith('#[');
}

/** Classify a Mule 3 processor by prefix/local + whether it occupies the flow's source position. */
function classify(prefix: string, local: string, isSource: boolean): MuleSemanticKind {
  if (local === 'flow-ref') return 'flow-ref';
  if (local === 'raise-error') return 'raise-error';
  if (ROUTER_LOCALS.has(local)) return 'router';
  if (isSource && SOURCE_LOCALS.has(local)) return 'source';
  if (local === 'outbound-endpoint') return 'outbound-call';
  if (local === 'request' || local === 'send') return 'outbound-call';
  return 'operation';
}

interface ProcessedAttrs {
  attrs: Record<string, string>;
  expressions: MuleExpression[];
  name?: string;
  configRef?: string;
  target?: string;
}

/** Sanitize a raw Mule 3 attribute list. Same rules as the Mule 4 sanitizer, but `#[…]` payloads are
 *  tagged `language: 'mel'` (Mule 3 has no DataWeave 2). Credential literals → `<redacted>`;
 *  references + MEL expressions never carry a resolved secret value. */
function processAttributesMule3(rawAttrs: MuleXmlAttribute[], startLine: number): ProcessedAttrs {
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
    if (isMel(value)) {
      expressions.push({ raw: value, language: 'mel', span: { start: startLine, end: startLine } });
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

/** Known Mule 3 core + connector operation locals (used to suppress the unknown-processor
 *  diagnostic for recognized Mule 3 processors that still classify as 'operation'). */
const KNOWN_OPERATION_LOCALS = new Set([
  'set-payload',
  'set-variable',
  'remove-variable',
  'logger',
  'component',
  'expression-component',
  'custom-transformer',
  'message-properties-transformer',
  'byte-array-to-string-transformer',
  'object-to-json-transformer',
  'object-to-string-transformer',
  'append-string-transformer',
  'expression-transformer',
  'parse-template',
  'request-reply',
  'processor-chain',
  'chain',
  'sub-flow',
  'flow-ref',
]);

/** Build a semantic processor from an XML element. `isSource` marks the flow's source position. */
function buildProcessor(
  el: MuleXmlElement,
  isSource: boolean,
  diagnostics: ExtractDiagnostic[],
): MuleProcessor {
  const { attrs, expressions, name, configRef, target } = processAttributesMule3(
    el.attributes,
    el.startLine,
  );
  const children: MuleProcessor[] = [];
  for (const child of el.children) {
    if (isExceptionStrategy(child.local)) continue; // exception strategies are flow-level, not processors
    children.push(buildProcessor(child, false, diagnostics));
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

  // Unrecognized element (not a known Mule 3 operation, router, source, or endpoint) → degrade to
  // 'operation' honestly and emit an info diagnostic naming the namespace/local for migration triage.
  if (
    processor.semanticKind === 'operation' &&
    !KNOWN_OPERATION_LOCALS.has(el.local) &&
    el.local !== 'outbound-endpoint' &&
    el.local !== 'inbound-endpoint'
  ) {
    diagnostics.push({
      code: 'mule:unknown-processor',
      severity: 'info',
      message: `Unrecognized Mule 3 processor ${el.prefix || ''}${el.prefix ? ':' : ''}${el.local} degraded to operation`,
    });
  }
  return processor;
}

/** Collect exception-strategy element(s) into one or more error handlers. A
 *  `choice-exception-strategy` flattens to its nested alternative strategies (each a separate
 *  handler); catch/rollback/reference produce a single handler carrying their handling processors. */
function collectErrorHandlers(
  el: MuleXmlElement,
  diagnostics: ExtractDiagnostic[],
): MuleErrorHandler[] {
  if (el.local === 'choice-exception-strategy') {
    const nested: MuleErrorHandler[] = [];
    for (const child of el.children) {
      if (isExceptionStrategy(child.local))
        nested.push(...collectErrorHandlers(child, diagnostics));
    }
    return nested;
  }
  const errorType = el.attributes.find((a) => a.local === 'type')?.value;
  const when = el.attributes.find((a) => a.local === 'when')?.value;
  // A reference-exception-strategy delegates to a GLOBAL named strategy via `ref` — a cross-file
  // reference the resolver binds to that global strategy's config symbol.
  const ref = el.attributes.find((a) => a.local === 'ref')?.value;
  const processors = el.children
    .filter((c) => !isExceptionStrategy(c.local))
    .map((c) => buildProcessor(c, false, diagnostics));
  const handler: MuleErrorHandler = {
    strategy: strategyOf(el.local),
    processors,
    span: spanOf(el),
  };
  if (errorType !== undefined) handler.errorType = errorType;
  else if (when !== undefined) handler.errorType = when; // catch-exception-strategy `when` guard
  if (ref !== undefined) handler.ref = ref; // reference-exception-strategy → global strategy
  return [handler];
}

/** Parse a Mule 3 config XML source into a {@link Mule3Document}. Throws {@link MuleXmlError} on a
 *  malformed/hostile XML payload (see xml.ts); otherwise never throws — unclassifiable elements
 *  degrade to `operation` processors with info diagnostics. */
export function parseMule3(xml: string): Mule3Document {
  const doc: MuleXmlDocument = parseMuleXml(xml);
  return normalizeMule3(doc);
}

/** Pure lift from the raw XML tree to the shared {@link Mule3Document} shape. */
function normalizeMule3(doc: MuleXmlDocument): Mule3Document {
  const root = doc.root;
  const diagnostics: ExtractDiagnostic[] = [...doc.diagnostics];

  const imports: MuleImport[] = [];
  const configurations: MuleConfiguration[] = [];
  const flows: MuleFlow[] = [];

  for (const child of root.children) {
    const local = child.local;
    if (local === 'import') {
      const resource =
        child.attributes.find((a) => a.local === 'resource')?.value ??
        child.attributes.find((a) => a.local === 'file')?.value ??
        '';
      imports.push({ resource, span: spanOf(child) });
      continue;
    }
    if (local === 'flow' || local === 'sub-flow') {
      const name = child.attributes.find((a) => a.local === 'name')?.value ?? '';
      const processors: MuleProcessor[] = [];
      const errorHandlers: MuleErrorHandler[] = [];
      let isSource = local === 'flow'; // only `<flow>` has a message source (first processor)
      for (const pc of child.children) {
        if (isExceptionStrategy(pc.local)) {
          errorHandlers.push(...collectErrorHandlers(pc, diagnostics));
          continue;
        }
        // Inline a `<processor-chain>`/`<chain>` so its children retain order in the flow.
        if (pc.local === 'processor-chain' || pc.local === 'chain') {
          for (const gc of pc.children) {
            if (isExceptionStrategy(gc.local)) {
              errorHandlers.push(...collectErrorHandlers(gc, diagnostics));
              continue;
            }
            processors.push(buildProcessor(gc, isSource, diagnostics));
            isSource = false;
          }
          continue;
        }
        processors.push(buildProcessor(pc, isSource, diagnostics));
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
    // Global configuration element (connector, endpoint, spring bean, …) — has a `name` attr. Lift
    // its name + sanitized attributes; values are key references only, never resolved secrets.
    const name = child.attributes.find((a) => a.local === 'name')?.value;
    const { attrs } = processAttributesMule3(child.attributes, child.startLine);
    configurations.push({
      namespace: child.prefix,
      name: name ?? child.local,
      attributes: attrs,
      span: spanOf(child),
    });
  }

  return {
    dialect: 'mule3',
    imports,
    configurations,
    flows,
    diagnostics,
  };
}
