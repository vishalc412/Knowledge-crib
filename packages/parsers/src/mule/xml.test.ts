import { describe, expect, it } from 'vitest';
import { parseMuleXml } from './xml.js';

/**
 * Mule 4 — Task 1. The secure saxes-backed XML parser produces a bounded, namespace-aware AST
 * with line spans, coalesces CDATA + text into element text, and rejects DTD/entity payloads (XXE).
 */
describe('parseMuleXml — secure namespace-aware AST', () => {
  it('preserves namespaces, CDATA, and line spans', () => {
    const source = [
      '<mule xmlns:http="urn:http">',
      '<flow name="orders">',
      '<http:request path="/x"><![CDATA[#[payload.id]]]></http:request>',
      '</flow>',
      '</mule>',
    ].join('\n');

    const doc = parseMuleXml(source);

    expect(doc.root.local).toBe('mule');
    // flow spans lines 2..4 (open at line 2, close `</flow>` at line 4)
    expect(doc.root.children[0]).toMatchObject({ local: 'flow', startLine: 2, endLine: 4 });
    // http:request is namespace-resolved (uri from xmlns:http) and carries the CDATA as text
    expect(doc.root.children[0]?.children[0]).toMatchObject({
      uri: 'urn:http',
      local: 'request',
      text: '#[payload.id]',
    });
  });

  it('rejects DTD / external entity declarations (XXE guard)', () => {
    const source = '<!DOCTYPE mule [<!ENTITY x SYSTEM "file:///etc/passwd">]><mule>&x;</mule>';
    expect(() => parseMuleXml(source)).toThrow(/DTD|entity/i);
  });

  it('preserves attributes (unprefixed + namespace-resolved) as {uri, local, value}', () => {
    const source = '<mule xmlns:http="urn:http"><http:request http:method="GET" path="/x"/></mule>';
    const doc = parseMuleXml(source);
    const req = doc.root.children[0]!;
    expect(req.uri).toBe('urn:http');
    expect(req.local).toBe('request');
    const byLocal = new Map(req.attributes.map((a) => [a.local, a]));
    expect(byLocal.get('path')).toMatchObject({ uri: '', local: 'path', value: '/x' });
    expect(byLocal.get('method')).toMatchObject({ uri: 'urn:http', local: 'method', value: 'GET' });
  });

  it('coalesces adjacent text + CDATA runs into a single element text buffer', () => {
    const source = '<mule>hello <![CDATA[world]]>!</mule>';
    const doc = parseMuleXml(source);
    expect(doc.root.text).toBe('hello world!');
  });

  it('enforces a nesting-depth cap (256) and aborts with a positioned error', () => {
    const depth = 257; // one past the cap
    const open = '<a>'.repeat(depth);
    const close = '</a>'.repeat(depth);
    expect(() => parseMuleXml(open + close)).toThrow(/depth|nest/i);
  });

  it('accepts nesting up to the depth cap (256) without error', () => {
    const depth = 256;
    const open = '<a>'.repeat(depth);
    const close = '</a>'.repeat(depth);
    const doc = parseMuleXml(open + close);
    // walk to the innermost element
    let node = doc.root;
    for (let i = 0; i < depth - 1; i++) node = node.children[0]!;
    expect(node.local).toBe('a');
    expect(node.startLine).toBe(1);
  });

  it('enforces an element-count cap (100,000) to bound runaway documents', () => {
    // root + MAX_ELEMENTS children = MAX_ELEMENTS+1 elements → the last child exceeds the cap.
    const source = `<r>${'<a/>'.repeat(100_000)}</r>`;
    expect(() => parseMuleXml(source)).toThrow(/element|count|too many/i);
  });

  it('surfaces parser errors as positioned MuleXmlError carrying line + column', () => {
    // unclosed root: saxes reports a well-formedness error on close()
    const source = '<mule><flow></mule>';
    let thrown: unknown;
    try {
      parseMuleXml(source);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as { line?: number; column?: number; message: string };
    expect(typeof e.line).toBe('number');
    expect(typeof e.column).toBe('number');
    expect(e.line).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty diagnostics array on a clean parse', () => {
    const doc = parseMuleXml('<mule/>');
    expect(doc.diagnostics).toEqual([]);
    expect(doc.root.local).toBe('mule');
    expect(doc.root.children).toEqual([]);
  });
});
