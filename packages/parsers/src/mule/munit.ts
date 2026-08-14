/**
 * MUnit semantic normalizer — lifts the raw {@link MuleXmlDocument} tree (xml.ts) into a
 * {@link MUnitSuite}: typed tests with their tested flows, mocks, assertions, and fixtures. MUnit
 * (Mule 3 + Mule 4) is the test layer for Mule applications; this normalizer turns an MUnit XML
 * config into the migration-evidence vocabulary the extractor (MuleExtractor.ts) and resolver
 * (mule-resolver.ts) consume. It never touches the wire format again — `parseMuleXml` does that.
 *
 * The two dialects share one output type (`MUnitSuite`/`MUnitTest`) with `dialect` metadata; the
 * only differences are the local-name sets for mock / verify constructs (see {@link MUNIT_NAMES}),
 * mirroring the mule3/mule4 normalizer split. Mule 4: `mock:when`, `mock:verify-call`. Mule 3: the
 * same plus legacy `mock-when` / `verify-times-called`.
 *
 * SECURITY (locked constraint): only STATIC names + expression KINDS are retained. A mock payload
 * or assertion expression is capped at {@link EXPR_MAX_CHARS}; when it references a credential-like
 * KEY (a token matching the secret classifier — e.g. `p('db.password')`), the whole expression is
 * reduced to a `<redacted>` marker so a mock payload can never leak a secret KEY name, let alone a
 * resolved value (which lives in a properties file the indexer never stores). Other expressions
 * (e.g. `#[payload]`) are capped and retained verbatim. This is deliberately stricter than the
 * application-config sanitizers (which keep property keys as references) because test payloads are
 * a higher leakage surface; it is duplicated (not imported) to keep the MUnit normalizer decoupled.
 */
import type { Span } from '@knowledge-crib/soul-schema';
import type { ExtractDiagnostic } from '../types.js';
import type { MuleXmlAttribute, MuleXmlDocument, MuleXmlElement } from './ast.js';
import { parseMuleXml } from './xml.js';

/** Maximum retained length of a payload / assertion expression before it is truncated. */
const EXPR_MAX_CHARS = 200;

/** Attribute local names whose literal values are credential-like → redacted (references kept). */
const CREDENTIAL_RE =
  /(password|passwd|pwd|secret|credential|token|api[-_]?key|private[-_]?key|keystore)/i;

/** A property-placeholder reference (`${key}`) or a `secure::key` / `p('key')` reference — KEY
 *  references, kept verbatim (the resolved value is never stored). */
function isReference(value: string): boolean {
  return (
    value.includes('${') ||
    value.startsWith('secure::') ||
    value.includes("p('") ||
    value.includes('p("')
  );
}

/** Cap an expression payload to a bounded length, appending an explicit truncation marker. */
function capExpr(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= EXPR_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, EXPR_MAX_CHARS)}…`;
}

/** Redact a payload / assertion expression. When the expression references a credential-like KEY
 *  (a token matching the secret classifier — e.g. `p('db.password')`), the KEY is itself redacted:
 *  the plan's MUnit instruction stores an expression KIND + redaction marker, not the key, so a
 *  mock payload can never leak a secret key name. Other expressions (e.g. `#[payload]`) are capped
 *  and retained verbatim — they are not credentials. A literal secret never reaches this path
 *  because the resolved value lives in a properties file the indexer never stores. */
function redactPayload(raw: string): string {
  const text = raw.trim();
  if (CREDENTIAL_RE.test(text)) return '<redacted>';
  return capExpr(text);
}

/** Sanitize a raw attribute list: credential-like literal values → `<redacted>`; references kept. */
function sanitizeAttributes(rawAttrs: MuleXmlAttribute[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of rawAttrs) {
    if (CREDENTIAL_RE.test(a.local) && !isReference(a.value)) {
      attrs[a.local] = '<redacted>';
      continue;
    }
    attrs[a.local] = a.value;
  }
  return attrs;
}

/** Dialect-specific MUnit local-name sets. The shared blocks (behavior/execution/validation,
 *  enable-flow-sources, set-event, load-static-resource, flow-ref) are identical across dialects;
 *  only the mock / verify families differ. */
const MUNIT_NAMES = {
  mule4: {
    test: new Set(['test']),
    mock: new Set(['when', 'spy']),
    thenReturn: new Set(['then-return']),
    verify: new Set(['verify-call']),
    assert: new Set([
      'assert-that',
      'assert-equals',
      'assert-true',
      'assert-false',
      'assert-null',
      'assert-not-null',
      'assert-not-equals',
    ]),
  },
  mule3: {
    test: new Set(['test']),
    mock: new Set(['when', 'spy', 'mock-when']),
    thenReturn: new Set(['then-return']),
    verify: new Set(['verify-call', 'verify-times-called']),
    assert: new Set([
      'assert-that',
      'assert-equals',
      'assert-true',
      'assert-false',
      'assert-null',
      'assert-not-null',
      'assert-not-equals',
    ]),
  },
} as const;

type Dialect = 'mule3' | 'mule4';

/** A mock (`mock:when` / `mock:spy`) recorded for a test: the processor it intercepts, its
 *  config-ref, its sanitized attributes, the `then-return` fixture media type (a key, never a
 *  resolved payload value), and the redacted/capped `then-return` payload expression. A payload
 *  referencing a credential key is reduced to `<redacted>`; a literal secret value never appears. */
export interface MUnitMock {
  processor: string;
  configRef?: string;
  attributes: Record<string, string>;
  fixture?: string;
  /** The `then-return` payload expression, redacted (credential-key → `<redacted>`) + capped. */
  payload?: string;
  span: Span;
}

/** An assertion / verification (`munit:assert-*` / `mock:verify-call`) recorded for a test. `kind`
 *  is the local name; `expression` is the asserted expression (capped); `expected` is the matcher
 *  or expected value (capped). */
export interface MUnitAssertion {
  kind: string;
  expression?: string;
  expected?: string;
  span: Span;
}

/** A single MUnit test: the flows it exercises, the mocks it installs, the assertions it checks,
 *  the static fixture files it loads, and any expected error type. */
export interface MUnitTest {
  name: string;
  description?: string;
  testedFlows: string[];
  expectedErrorType?: string;
  mocks: MUnitMock[];
  assertions: MUnitAssertion[];
  fixtures: string[];
  span: Span;
}

/** A parsed MUnit config: its dialect, the tests it declares, and any soft diagnostics. */
export interface MUnitSuite {
  dialect: Dialect;
  tests: MUnitTest[];
  diagnostics: ExtractDiagnostic[];
}

const spanOf = (el: MuleXmlElement): Span => ({ start: el.startLine, end: el.endLine });

/** Read a named attribute from an element (undefined when absent). */
function attr(el: MuleXmlElement, local: string): string | undefined {
  return el.attributes.find((a) => a.local === local)?.value;
}

/** Collect the flow names a test exercises: from `enable-flow-source` flowName/name/sourceName
 *  attributes AND from `flow-ref` name attributes inside execution. Deduped, order-preserving. */
function collectTestedFlows(testEl: MuleXmlElement): string[] {
  const flows: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    flows.push(name);
  };
  for (const child of testEl.children) {
    if (child.local === 'enable-flow-sources') {
      for (const src of child.children) {
        if (src.local === 'enable-flow-source') {
          add(attr(src, 'flowName') ?? attr(src, 'sourceName') ?? attr(src, 'name'));
        }
      }
    }
    if (child.local === 'execution') {
      for (const step of child.children) {
        if (step.local === 'flow-ref') add(attr(step, 'name'));
      }
    }
  }
  return flows;
}

/** Build a mock from a `mock:when` / `mock:spy` element. The `then-return` payload media type is
 *  the fixture (a key); the payload expression is redacted/capped and stored so a credential-key
 *  reference is reduced to `<redacted>` (a literal secret value never reaches the suite). */
function buildMock(el: MuleXmlElement): MUnitMock {
  const processor = attr(el, 'processor') ?? el.local;
  const configRef = attr(el, 'config-ref');
  const attributes = sanitizeAttributes(el.attributes);
  // The fixture media type + the redacted payload expression live on the then-return payload child.
  let fixture: string | undefined;
  let payloadExpr: string | undefined;
  for (const child of el.children) {
    if (child.local === 'then-return') {
      for (const payload of child.children) {
        if (payload.local === 'payload') {
          fixture = attr(payload, 'mediaType');
          payloadExpr = redactPayload(payload.text);
          break;
        }
      }
      break;
    }
  }
  const mock: MUnitMock = {
    processor,
    attributes,
    span: spanOf(el),
  };
  if (configRef !== undefined) mock.configRef = configRef;
  if (fixture !== undefined) mock.fixture = fixture;
  if (payloadExpr !== undefined && payloadExpr !== '') mock.payload = payloadExpr;
  return mock;
}

/** Build an assertion from a `munit:assert-*` or `mock:verify-call` element. Expressions + expected
 *  values are capped; a credential-like literal is redacted. */
function buildAssertion(el: MuleXmlElement): MUnitAssertion {
  const kind = el.local;
  const assertion: MUnitAssertion = { kind, span: spanOf(el) };
  if (kind === 'assert-that') {
    const expression = attr(el, 'expression');
    const is = attr(el, 'is');
    if (expression !== undefined) assertion.expression = redactPayload(expression);
    if (is !== undefined) assertion.expected = capExpr(is);
  } else if (kind === 'assert-equals') {
    const actual = attr(el, 'actual');
    const expected = attr(el, 'expected');
    if (actual !== undefined) assertion.expression = redactPayload(actual);
    if (expected !== undefined) assertion.expected = redactPayload(expected);
  } else {
    // verify-call / assert-true / assert-null / … : record any expression/expected verbatim (capped).
    const expression = attr(el, 'expression') ?? attr(el, 'actual');
    const expected = attr(el, 'expected') ?? attr(el, 'is');
    if (expression !== undefined) assertion.expression = redactPayload(expression);
    if (expected !== undefined) assertion.expected = capExpr(expected);
  }
  return assertion;
}

/** Build a single MUnit test from its `munit:test` element. */
function buildTest(testEl: MuleXmlElement, names: (typeof MUNIT_NAMES)[Dialect]): MUnitTest {
  const name = attr(testEl, 'name') ?? '';
  const description = attr(testEl, 'description');
  const expectedErrorType = attr(testEl, 'expectedErrorType') ?? attr(testEl, 'expectErrorType');
  const testedFlows = collectTestedFlows(testEl);
  const mocks: MUnitMock[] = [];
  const assertions: MUnitAssertion[] = [];
  const fixtures: string[] = [];

  for (const block of testEl.children) {
    // behavior: mocks (when/spy) + set-event + load-static-resource
    if (block.local === 'behavior') {
      for (const step of block.children) {
        if (names.mock.has(step.local)) mocks.push(buildMock(step));
        else if (step.local === 'load-static-resource') {
          const file = attr(step, 'file');
          if (file) fixtures.push(file);
        }
        // set-event is a setup construct; its payload is not retained (no secret value reaches here).
      }
      continue;
    }
    // execution: flow-refs already collected into testedFlows; spies may also appear here.
    if (block.local === 'execution') {
      for (const step of block.children) {
        if (names.mock.has(step.local)) mocks.push(buildMock(step));
      }
      continue;
    }
    // validation: assertions (assert-* + verify-call)
    if (block.local === 'validation') {
      for (const step of block.children) {
        if (names.assert.has(step.local) || names.verify.has(step.local)) {
          assertions.push(buildAssertion(step));
        }
      }
      continue;
    }
    // Mule 3 nests mocks/assertions directly under the test (no behavior/validation wrapper).
    if (names.mock.has(block.local)) mocks.push(buildMock(block));
    else if (names.assert.has(block.local) || names.verify.has(block.local)) {
      assertions.push(buildAssertion(block));
    } else if (block.local === 'load-static-resource') {
      const file = attr(block, 'file');
      if (file) fixtures.push(file);
    }
  }

  const test: MUnitTest = {
    name,
    testedFlows,
    mocks,
    assertions,
    fixtures,
    span: spanOf(testEl),
  };
  if (description !== undefined) test.description = description;
  if (expectedErrorType !== undefined) test.expectedErrorType = expectedErrorType;
  return test;
}

/** Parse an MUnit config XML source into a {@link MUnitSuite}. Throws {@link MuleXmlError} on a
 *  malformed/hostile XML payload (see xml.ts); otherwise never throws. */
export function parseMUnit(xml: string, dialect: Dialect): MUnitSuite {
  const doc: MuleXmlDocument = parseMuleXml(xml);
  const names = MUNIT_NAMES[dialect];
  const tests: MUnitTest[] = [];
  for (const child of doc.root.children) {
    if (names.test.has(child.local)) tests.push(buildTest(child, names));
  }
  return { dialect, tests, diagnostics: [...doc.diagnostics] };
}
