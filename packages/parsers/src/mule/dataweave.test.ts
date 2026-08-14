import { describe, expect, it } from 'vitest';
import { parseDataWeave } from './dataweave.js';

const SAMPLE = `%dw 2.0
import upper from dw::core::Strings
var region = p('billing.region')
fun total(xs) = xs reduce ((n, acc = 0) -> acc + n)
---
{ id: payload.id, label: upper(payload.name), total: total(payload.lines) }`;

describe('parseDataWeave — declarations, imports, calls, properties', () => {
  it('extracts version, imports, declarations, property keys, and calls', () => {
    const result = parseDataWeave(SAMPLE);
    expect(result.version).toBe('2.0');
    expect(result.imports).toEqual([{ name: 'upper', module: 'dw::core::Strings', line: 2 }]);
    expect(result.declarations.map((d) => d.name)).toEqual(['region', 'total']);
    expect(result.declarations.map((d) => d.kind)).toEqual(['var', 'fun']);
    expect(result.propertyKeys).toEqual(['billing.region']);
    expect(result.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(['upper', 'total', 'p']),
    );
  });

  it('classifies declaration kinds (var/fun/type/ns)', () => {
    const src = `%dw 2.0
ns soap http://soap.example
type Foo = String
var x = 1
fun id(v) = v
---
1`;
    const result = parseDataWeave(src);
    expect(result.declarations.map((d) => [d.kind, d.name])).toEqual(
      expect.arrayContaining([
        ['ns', 'soap'],
        ['type', 'Foo'],
        ['var', 'x'],
        ['fun', 'id'],
      ]),
    );
  });

  it('extracts resources via readUrl and Mule::p property references', () => {
    const src = `%dw 2.0
var lib = readUrl('classpath://dwl/libs/common.dwl')
var secret = Mule::p('db.password')
---
1`;
    const result = parseDataWeave(src);
    expect(result.resources).toEqual(['classpath://dwl/libs/common.dwl']);
    expect(result.propertyKeys).toEqual(['db.password']);
    expect(result.references.map((r) => [r.kind, r.name])).toEqual(
      expect.arrayContaining([
        ['resource', 'classpath://dwl/libs/common.dwl'],
        ['property', 'db.password'],
      ]),
    );
  });

  it('does not count the function-declaration name as a call', () => {
    const src = `%dw 2.0
fun total(xs) = xs
---
total(payload.lines)`;
    const result = parseDataWeave(src);
    // exactly one `total` call site — the body invocation, not the declaration head
    const totalCalls = result.calls.filter((c) => c.name === 'total');
    expect(totalCalls).toHaveLength(1);
  });
});

describe('parseDataWeave — robustness + diagnostics', () => {
  it('never throws on malformed input and reports diagnostics', () => {
    const src = `%dw 2.0
var broken = 'unterminated
var dyn = p(someKey)
var res = readUrl(nonLiteral)
---
{ x: 1 }`;
    const result = parseDataWeave(src);
    expect(result.version).toBe('2.0');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining(['mule:dynamic-property', 'mule:dynamic-resource']),
    );
    // dynamic references are surfaced but never resolved into keys
    expect(result.propertyKeys).toEqual([]);
  });

  it('caps token count for a runaway document without throwing', () => {
    const huge = `%dw 2.0\n---\n${'a'.repeat(500_000)}`;
    const result = parseDataWeave(huge);
    expect(result.version).toBe('2.0');
  });

  it('handles a script with no separator (header-only)', () => {
    const result = parseDataWeave(`%dw 2.0\nvar x = p('a.b')`);
    expect(result.version).toBe('2.0');
    expect(result.propertyKeys).toEqual(['a.b']);
  });
});

describe('parseDataWeave — DW1 (Mule 3)', () => {
  const DW1 = `%dw 1.0
%var greeting = "Hello"
%output application/java
%function fullName(first, last) = first ++ " " ++ last
---
fullName(greeting, flowVars.name, inboundProperties.correlationId)`;

  it('extracts the 1.0 version', () => {
    const result = parseDataWeave(DW1);
    expect(result.version).toBe('1.0');
  });

  it('maps %var → var and %function → fun declarations (version-gated)', () => {
    const result = parseDataWeave(DW1);
    expect(result.declarations.map((d) => [d.kind, d.name])).toEqual(
      expect.arrayContaining([
        ['var', 'greeting'],
        ['fun', 'fullName'],
      ]),
    );
  });

  it('records the body fullName call but not the declaration head', () => {
    const result = parseDataWeave(DW1);
    const fullNameCalls = result.calls.filter((c) => c.name === 'fullName');
    expect(fullNameCalls).toHaveLength(1);
  });

  it('extracts flowVars and inboundProperties as variable references', () => {
    const result = parseDataWeave(DW1);
    expect(result.references.map((r) => [r.kind, r.name])).toEqual(
      expect.arrayContaining([
        ['variable', 'name'],
        ['variable', 'correlationId'],
      ]),
    );
  });

  it('does not regress DW2 fixtures (the SAMPLE expectations still hold)', () => {
    const result = parseDataWeave(SAMPLE);
    expect(result.version).toBe('2.0');
    expect(result.declarations.map((d) => d.kind)).toEqual(['var', 'fun']);
    expect(result.propertyKeys).toEqual(['billing.region']);
  });
});
