import { describe, expect, it } from 'vitest';
import { parseMel } from './mel.js';

/**
 * MEL (Mule Expression Language) scanner — a NON-evaluating tokenizer that extracts variable,
 * property, and registry references plus call names from a Mule 3 `#[…]` expression. It never
 * evaluates arithmetic, ternaries, reflection, Java calls, or collection projections; static literal
 * names are facts, dynamic arguments produce a `mule:dynamic-reference` diagnostic. Property VALUES
 * never enter — only key names.
 */
describe('parseMel', () => {
  it('extracts flowVars + registry + property references and the p() call', () => {
    const result = parseMel(
      `#[flowVars.customerId != null ? app.registry['region'] : p('fallback.region')]`,
    );
    expect(result.references).toEqual(
      expect.arrayContaining([
        { kind: 'variable', name: 'customerId', line: 1 },
        { kind: 'property', name: 'fallback.region', line: 1 },
        { kind: 'registry', name: 'region', line: 1 },
      ]),
    );
    expect(result.calls.map((c) => c.name)).toContain('p');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('extracts message.inboundProperties and sessionVars as variables', () => {
    const a = parseMel(`#[message.inboundProperties['correlationId']]`);
    expect(a.references).toContainEqual({ kind: 'variable', name: 'correlationId', line: 1 });
    const b = parseMel('#[sessionVars.tenant]');
    expect(b.references).toContainEqual({ kind: 'variable', name: 'tenant', line: 1 });
  });

  it('extracts muleContext.registry bracket and dot access as registry references', () => {
    const bracket = parseMel(`#[muleContext.registry['springBean']]`);
    expect(bracket.references).toContainEqual({ kind: 'registry', name: 'springBean', line: 1 });
    const dot = parseMel('#[app.registry.region]');
    expect(dot.references).toContainEqual({ kind: 'registry', name: 'region', line: 1 });
  });

  it('records a method call name (the identifier before the parenthesis)', () => {
    const result = parseMel(`#[StringUtils.reverse('abc')]`);
    expect(result.calls.map((c) => c.name)).toContain('reverse');
    // a non-p() string argument is NOT a property reference
    expect(result.references.find((r) => r.kind === 'property')).toBeUndefined();
  });

  it('unescapes escaped quotes inside string literals', () => {
    const result = parseMel(`#[p('it\\'s')]`);
    expect(result.references).toContainEqual({ kind: 'property', name: "it's", line: 1 });
    expect(result.calls.map((c) => c.name)).toContain('p');
  });

  it('flags a dynamic p() argument with a mule:dynamic-reference diagnostic and records no property', () => {
    const result = parseMel('#[p(flowVars.key)]');
    expect(result.calls.map((c) => c.name)).toContain('p');
    expect(result.references.find((r) => r.kind === 'property')).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'mule:dynamic-reference', severity: 'warning' }),
    );
  });

  it('accepts the inner expression without the #[…] wrapper', () => {
    const result = parseMel('flowVars.x', 7);
    expect(result.references).toContainEqual({ kind: 'variable', name: 'x', line: 7 });
  });

  it('deduplicates repeated references', () => {
    const result = parseMel('#[flowVars.x + flowVars.x]');
    const xs = result.references.filter((r) => r.kind === 'variable' && r.name === 'x');
    expect(xs).toHaveLength(1);
  });
});
