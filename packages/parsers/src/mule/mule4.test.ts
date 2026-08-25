import { describe, expect, it } from 'vitest';
import { parseMule4 } from './mule4.js';

/** A representative Mule 4 config: an HTTP-listener flow with routing, a sub-flow, and an error
 *  handler — exercises source detection, router/flow-ref/transform/outbound/raise-error kinds. */
const FLOW_FIXTURE = `<mule xmlns="http://www.mulesoft.org/schema/mule/core"
  xmlns:http="http://www.mulesoft.org/schema/mule/http"
  xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core">
  <http:listener-config name="httpConfig" basePath="/api"/>
  <flow name="api-main">
    <http:listener name="listener" config-ref="httpConfig" path="/api/*"/>
    <choice>
      <foreach>
        <logger level="INFO"/>
      </foreach>
      <parallel-foreach>
        <logger level="DEBUG"/>
      </parallel-foreach>
    </choice>
    <flow-ref name="lookup"/>
    <ee:transform>
      <ee:message>
        <ee:set-payload><![CDATA[#[payload]]]></ee:set-payload>
      </ee:message>
    </ee:transform>
    <http:request config-ref="httpConfig" path="/users" method="GET"/>
    <raise-error type="APP:UNEXPECTED" description="boom"/>
    <error-handler>
      <on-error-propagate type="APP:UNEXPECTED" logException="false">
        <logger level="ERROR"/>
      </on-error-propagate>
    </error-handler>
  </flow>
  <sub-flow name="lookup">
    <logger level="INFO"/>
  </sub-flow>
</mule>`;

describe('parseMule4 — semantic normalization', () => {
  it('classifies flows, sub-flows, and the top-level processor sequence', () => {
    const doc = parseMule4(FLOW_FIXTURE);
    expect(doc.dialect).toBe('mule4');
    expect(doc.flows.map((f) => [f.kind, f.name])).toEqual([
      ['flow', 'api-main'],
      ['subflow', 'lookup'],
    ]);
    expect(doc.flows[0]?.processors.map((p) => p.semanticKind)).toEqual([
      'source',
      'router',
      'flow-ref',
      'transform',
      'outbound-call',
      'raise-error',
    ]);
    expect(doc.flows[0]?.errorHandlers).toHaveLength(1);
  });

  it('lifts source processor name + config-ref and classifies children', () => {
    const doc = parseMule4(FLOW_FIXTURE);
    const listener = doc.flows[0]?.processors[0];
    expect(listener).toMatchObject({
      namespace: 'http',
      operation: 'listener',
      semanticKind: 'source',
      name: 'listener',
      configRef: 'httpConfig',
    });
    // choice (router) carries foreach + parallel-foreach as router children
    const choice = doc.flows[0]?.processors[1];
    expect(choice?.semanticKind).toBe('router');
    expect(choice?.children.map((c) => c.operation)).toEqual(['foreach', 'parallel-foreach']);
    expect(choice?.children.every((c) => c.semanticKind === 'router')).toBe(true);
  });

  it('lifts global configuration elements with key-only attributes', () => {
    const doc = parseMule4(FLOW_FIXTURE);
    expect(doc.configurations).toHaveLength(1);
    expect(doc.configurations[0]).toMatchObject({
      namespace: 'http',
      name: 'httpConfig',
    });
    expect(doc.configurations[0]?.attributes).toEqual({ basePath: '/api' });
  });

  it('parses the error handler strategy + error type', () => {
    const doc = parseMule4(FLOW_FIXTURE);
    const handler = doc.flows[0]?.errorHandlers[0];
    expect(handler).toMatchObject({
      strategy: 'on-error-propagate',
      errorType: 'APP:UNEXPECTED',
    });
    expect(handler?.processors.map((p) => p.operation)).toEqual(['logger']);
  });
});

describe('parseMule4 — attribute sanitization (keys + references only)', () => {
  it('redacts credential-like literal values', () => {
    const xml = `<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
      <flow name="secure-flow">
        <http:listener name="l" config-ref="httpConfig" path="/x"/>
        <http:request config-ref="httpConfig" path="/users" password="swordfish" api-key="AKIA123"/>
      </flow>
    </mule>`;
    const doc = parseMule4(xml);
    const req = doc.flows[0]?.processors[1];
    expect(req?.attributes.password).toBe('<redacted>');
    expect(req?.attributes['api-key']).toBe('<redacted>');
    // non-credential literal config value is preserved
    expect(req?.attributes.path).toBe('/users');
  });

  it('keeps property-placeholder references verbatim (never resolves the secret)', () => {
    const xml = `<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
      <flow name="ref-flow">
        <http:listener name="l" config-ref="httpConfig" path="/x"/>
        <http:request config-ref="httpConfig" path="/users" password="\${db.password}" host="\${secure::host}"/>
      </flow>
    </mule>`;
    const doc = parseMule4(xml);
    const req = doc.flows[0]?.processors[1];
    expect(req?.attributes.password).toBe('${db.password}');
    expect(req?.attributes.host).toBe('${secure::host}');
  });

  it('moves DataWeave expression payloads to expressions, not the attribute map', () => {
    const xml = `<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
      <flow name="dw-flow">
        <http:listener name="l" config-ref="httpConfig" path="/x"/>
        <set-payload value="#[payload.id]"/>
      </flow>
    </mule>`;
    const doc = parseMule4(xml);
    const setPayload = doc.flows[0]?.processors[1];
    expect(setPayload?.expressions.map((e) => e.raw)).toEqual(['#[payload.id]']);
    expect(setPayload?.expressions[0]?.language).toBe('dw2');
    expect(setPayload?.attributes.value).toBeUndefined();
  });

  it('reports no diagnostics on a clean parse', () => {
    const doc = parseMule4(FLOW_FIXTURE);
    expect(doc.diagnostics).toEqual([]);
  });
});
