import { describe, expect, it } from 'vitest';
import { parseMule3 } from './mule3.js';

/**
 * Mule 3 semantic normalization — the legacy normalizer lifts Mule 3 transports, endpoints, routers,
 * chains, and exception strategies into the SAME {@link MuleDocument} vocabulary the Mule 4
 * normalizer emits, so the shared extractor + resolver consume one shape. Mule 3 expressions are MEL
 * (`#[…]`), tagged `language: 'mel'` (NOT 'dw2'). Property VALUES never enter (key refs only).
 */
const LEGACY_FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:vm="http://www.mulesoft.org/schema/mule/vm">
  <vm:connector name="vmConnector"/>
  <flow name="legacyFlow">
    <inbound-endpoint ref="vmConnector" path="in"/>
    <set-payload value="#[payload]"/>
    <choice>
      <when expression="#[payload == 1]">
        <logger message="one"/>
      </when>
      <otherwise>
        <logger message="default"/>
      </otherwise>
    </choice>
    <outbound-endpoint ref="vmConnector" path="out"/>
    <catch-exception-strategy>
      <logger message="caught"/>
    </catch-exception-strategy>
    <rollback-exception-strategy>
      <logger message="rolled back"/>
    </rollback-exception-strategy>
  </flow>
  <sub-flow name="helper">
    <set-variable variableName="v" value="#[payload]"/>
  </sub-flow>
</mule>
`;

describe('parseMule3', () => {
  it('classifies inbound/outbound endpoints, operations, and routers into the shared semantic kinds', () => {
    const doc = parseMule3(LEGACY_FLOW);
    expect(doc.dialect).toBe('mule3');
    const flow = doc.flows.find((f) => f.name === 'legacyFlow');
    expect(flow?.kind).toBe('flow');
    expect(flow?.processors.map((p) => p.semanticKind)).toEqual([
      'source',
      'operation',
      'router',
      'outbound-call',
    ]);
  });

  it('maps catch/rollback exception strategies to error handlers in declaration order', () => {
    const doc = parseMule3(LEGACY_FLOW);
    const flow = doc.flows.find((f) => f.name === 'legacyFlow');
    expect(flow?.errorHandlers.map((h) => h.strategy)).toEqual(['catch', 'rollback']);
    // the handler carries its handling processor subtree
    expect(flow?.errorHandlers[0]?.processors.map((p) => p.operation)).toEqual(['logger']);
  });

  it('lifts sub-flows and global connector configurations', () => {
    const doc = parseMule3(LEGACY_FLOW);
    const sub = doc.flows.find((f) => f.name === 'helper');
    expect(sub?.kind).toBe('subflow');
    expect(sub?.processors.map((p) => p.operation)).toEqual(['set-variable']);
    expect(doc.configurations.some((c) => c.name === 'vmConnector')).toBe(true);
  });

  it('tags inline #[…] expressions as MEL (language: mel), not dw2', () => {
    const doc = parseMule3(LEGACY_FLOW);
    const flow = doc.flows.find((f) => f.name === 'legacyFlow');
    const setPayload = flow?.processors.find((p) => p.operation === 'set-payload');
    expect(setPayload?.expressions.map((e) => e.language)).toEqual(['mel']);
    expect(setPayload?.expressions.map((e) => e.raw)).toContain('#[payload]');
  });

  it('flattens a choice-exception-strategy into its nested catch strategies', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core">
  <flow name="f">
    <inbound-endpoint path="in"/>
    <choice-exception-strategy>
      <catch-exception-strategy when="#[payload == 1]">
        <logger message="a"/>
      </catch-exception-strategy>
      <catch-exception-strategy when="#[payload == 2]">
        <logger message="b"/>
      </catch-exception-strategy>
    </choice-exception-strategy>
  </flow>
</mule>`;
    const doc = parseMule3(xml);
    const flow = doc.flows.find((fn) => fn.name === 'f');
    expect(flow?.errorHandlers.map((h) => h.strategy)).toEqual(['catch', 'catch']);
    expect(flow?.errorHandlers.map((h) => h.processors.map((p) => p.operation))).toEqual([
      ['logger'],
      ['logger'],
    ]);
  });

  it('inlines a processor-chain so its children retain order in the flow', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core">
  <flow name="f">
    <inbound-endpoint path="in"/>
    <processor-chain>
      <set-payload value="#[1]"/>
      <logger message="x"/>
    </processor-chain>
  </flow>
</mule>`;
    const doc = parseMule3(xml);
    const flow = doc.flows.find((fn) => fn.name === 'f');
    expect(flow?.processors.map((p) => p.operation)).toEqual([
      'inbound-endpoint',
      'set-payload',
      'logger',
    ]);
  });

  it('emits an info diagnostic for unrecognized elements and degrades them to operations', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core" xmlns:foo="http://example/foo">
  <flow name="f">
    <inbound-endpoint path="in"/>
    <foo:mystery magic="yes"/>
  </flow>
</mule>`;
    const doc = parseMule3(xml);
    const flow = doc.flows.find((fn) => fn.name === 'f');
    expect(flow?.processors.map((p) => p.semanticKind)).toContain('operation');
    expect(doc.diagnostics.some((d) => d.code === 'mule:unknown-processor')).toBe(true);
  });
});
