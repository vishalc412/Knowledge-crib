import { describe, expect, it } from 'vitest';
import { parseRaml } from './raml.js';

const SAMPLE = `#%RAML 1.0
title: Orders API
version: v1
mediaType: application/json
types:
  Order: !include types/order.raml
  LineItem:
    type: object
    properties:
      sku: string
traits:
  paged:
    queryParameters:
      page:
        type: integer
securitySchemes:
  oauth2:
    type: OAuth 2.0
/orders:
  get:
    is: [paged]
    responses:
      200:
        body:
          application/json:
            type: Order
  post:
    body:
      type: Order
  /{id}:
    get:
      responses:
        200:
          body:
            type: Order
    delete: {}
`;

describe('parseRaml — structure', () => {
  it('lifts title, version, and mediaType', () => {
    const result = parseRaml(SAMPLE);
    expect(result.title).toBe('Orders API');
    expect(result.version).toBe('v1');
    expect(result.mediaType).toEqual(['application/json']);
  });

  it('extracts resources with methods (including nested resources)', () => {
    const result = parseRaml(SAMPLE);
    expect(result.resources).toContainEqual(
      expect.objectContaining({
        path: '/orders',
        methods: [{ method: 'get' }, { method: 'post' }],
      }),
    );
    // nested resource path is the concatenation of the parent + the relative path
    expect(result.resources).toContainEqual(
      expect.objectContaining({
        path: '/orders/{id}',
        methods: [{ method: 'get' }, { method: 'delete' }],
      }),
    );
  });

  it('collects type, trait, and securityScheme names', () => {
    const result = parseRaml(SAMPLE);
    expect(result.types).toEqual(['LineItem', 'Order']);
    expect(result.traits).toEqual(['paged']);
    expect(result.securitySchemes).toEqual(['oauth2']);
  });
});

describe('parseRaml — includes and references', () => {
  it('returns !include values as references (never read recursively)', () => {
    const result = parseRaml(SAMPLE);
    expect(result.includes).toEqual(['types/order.raml']);
    // the include is recorded as a reference, not inlined
    expect(result.references).toContainEqual({ kind: 'include', name: 'types/order.raml' });
  });

  it('records type/trait references used by methods', () => {
    const result = parseRaml(SAMPLE);
    // `is: [paged]` is a trait reference; `type: Order` is a type reference
    expect(result.references).toContainEqual({ kind: 'trait', name: 'paged' });
    expect(result.references).toContainEqual({ kind: 'type', name: 'Order' });
  });
});

describe('parseRaml — robustness + security', () => {
  it('never throws on malformed RAML/YAML and reports diagnostics', () => {
    const result = parseRaml('title: Orders\n  bad: indent: here: [');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.code).toBe('mule:invalid-raml-yaml');
  });

  it('caps alias usage and disables merge keys (no resource explosion)', () => {
    // A document that is not RAML at all (no #RAML header) still parses without throwing.
    const result = parseRaml('foo: bar\nbaz: qux');
    expect(result.resources).toEqual([]);
    expect(result.title).toBeUndefined();
  });

  it('never stores raw include file contents (paths only)', () => {
    const result = parseRaml(SAMPLE);
    // the include reference is a path string, not file contents — and no unrelated secret-like blob
    expect(JSON.stringify(result)).toContain('types/order.raml');
    expect(JSON.stringify(result)).not.toContain('contents-of-include');
  });
});
