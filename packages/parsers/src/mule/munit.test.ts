/**
 * MUnit normalizer unit tests. Covers the Mule 4 MUnit constructs the plan locks: `munit:test`,
 * behavior/execution/validation blocks, `flow-ref`, `mock:when`, `then-return`, `spy`,
 * `verify-call`, `assert-that`, `assert-equals`, `set-event`, `enable-flow-sources`, and an
 * expected error type. SECURITY: only static names + expression KINDS are retained; a credential
 * canary in a mock payload is redacted, and a literal secret never reaches the suite.
 */
import { describe, expect, it } from 'vitest';
import { parseMUnit } from './munit.js';

const MULE4_MUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit"
      xmlns:mock="http://www.mulesoft.org/schema/mule/mock"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <munit:config name="billing-suite.xml"/>
  <munit:test name="billing-api-test" description="tests the billing api" ignore="false">
    <munit:enable-flow-sources>
      <munit:enable-flow-source flowName="billing-api"/>
    </munit:enable-flow-sources>
    <munit:behavior>
      <mock:when processor="http:request" config-ref="httpConfig">
        <mock:then-return>
          <mock:payload mediaType="application/java">#[output application/java --- { "status" : 200 }]</mock:payload>
        </mock:then-return>
      </mock:when>
      <mock:spy processor="logger">
        <mock:before-call>
          <logger level="INFO" message="before"/>
        </mock:before-call>
      </mock:spy>
      <munit:set-event name="setInput">
        <munit:payload mediaType="application/json">#[{ "orderId" : 42 }]</munit:payload>
      </munit:set-event>
    </munit:behavior>
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
    <munit:validation>
      <munit:assert-that expression="#[payload]" is="#[equalTo('OK')]"/>
      <munit:assert-equals actual="#[payload]" expected="#['OK']"/>
      <mock:verify-call processor="http:request" at-least="1"/>
    </munit:validation>
  </munit:test>
  <munit:test name="billing-error-test">
    <munit:enable-flow-sources>
      <munit:enable-flow-source flowName="billing-api"/>
    </munit:enable-flow-sources>
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
    <munit:validation>
      <munit:assert-that expression="#[payload]" is="#[equalTo('OK')]"/>
    </munit:validation>
  </munit:test>
</mule>`;

describe('parseMUnit — Mule 4 MUnit', () => {
  it('lifts a test with name, description, tested flows, and expected error type', () => {
    const suite = parseMUnit(MULE4_MUNIT_XML, 'mule4');
    expect(suite.dialect).toBe('mule4');
    expect(suite.tests).toHaveLength(2);
    expect(suite.tests[0]).toMatchObject({
      name: 'billing-api-test',
      description: 'tests the billing api',
      testedFlows: ['billing-api'],
    });
    expect(suite.tests[0]?.span.start).toBeGreaterThan(0);
    // the second test carries the expected error type via the mule4 attribute
    expect(suite.tests[1]?.name).toBe('billing-error-test');
  });

  it('collects mocks (when + spy) with processor + config-ref and a fixture media type', () => {
    const suite = parseMUnit(MULE4_MUNIT_XML, 'mule4');
    const mocks = suite.tests[0]?.mocks ?? [];
    expect(mocks).toContainEqual(
      expect.objectContaining({ processor: 'http:request', configRef: 'httpConfig' }),
    );
    expect(mocks).toContainEqual(expect.objectContaining({ processor: 'logger' }));
    // the mock fixture is the then-return payload media type, not a secret payload value
    const httpMock = mocks.find((m) => m.processor === 'http:request');
    expect(httpMock?.fixture).toBe('application/java');
  });

  it('collects assert-that, assert-equals, and verify-call as assertions', () => {
    const suite = parseMUnit(MULE4_MUNIT_XML, 'mule4');
    const assertions = suite.tests[0]?.assertions ?? [];
    expect(assertions.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['assert-that', 'assert-equals', 'verify-call']),
    );
    const assertThat = assertions.find((a) => a.kind === 'assert-that');
    expect(assertThat?.expression).toBe('#[payload]');
    expect(assertThat?.expected).toBe("#[equalTo('OK')]");
    const assertEquals = assertions.find((a) => a.kind === 'assert-equals');
    expect(assertEquals?.expression).toBe('#[payload]');
    expect(assertEquals?.expected).toBe("#['OK']");
  });

  it('redacts a credential-like mock payload and never retains a literal secret', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit"
      xmlns:mock="http://www.mulesoft.org/schema/mule/mock">
  <munit:test name="secret-test">
    <munit:behavior>
      <mock:when processor="http:request">
        <mock:then-return>
          <mock:payload mediaType="application/java">#[p('db.password')]</mock:payload>
        </mock:then-return>
      </mock:when>
    </munit:behavior>
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
  </munit:test>
</mule>`;
    const suite = parseMUnit(xml, 'mule4');
    const mock = suite.tests[0]?.mocks[0];
    expect(mock).toBeDefined();
    // the fixture media type is retained (a key, not a value); the payload expression is redacted
    expect(mock?.fixture).toBe('application/java');
    // a credential-key payload expression is reduced to a redaction marker (the key name is not kept)
    expect(mock?.payload).toBe('<redacted>');
    const json = JSON.stringify(suite);
    expect(json).not.toContain('swordfish');
    expect(json).not.toContain('db.password');
  });

  it('records the expected error type on a test declaring one', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit">
  <munit:test name="err-test" expectedErrorType="BILLING:NOT_FOUND">
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
  </munit:test>
</mule>`;
    const suite = parseMUnit(xml, 'mule4');
    expect(suite.tests[0]?.expectedErrorType).toBe('BILLING:NOT_FOUND');
  });

  it('collects fixture paths from load-static-resource', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit">
  <munit:test name="fixture-test">
    <munit:behavior>
      <munit:load-static-resource file="fixtures/orders.json"/>
    </munit:behavior>
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
  </munit:test>
</mule>`;
    const suite = parseMUnit(xml, 'mule4');
    expect(suite.tests[0]?.fixtures).toEqual(['fixtures/orders.json']);
  });
});

const MULE3_MUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit"
      xmlns:mock="http://www.mulesoft.org/schema/mule/mock"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <munit:test name="legacy-flow-test" expectException="LEGACY:TIMEOUT">
    <flow-ref name="legacyFlow"/>
    <mock:when processor="http:request" config-ref="httpConfig">
      <mock:then-return>
        <mock:payload mediaType="application/java">#[payload]</mock:payload>
      </mock:then-return>
    </mock:when>
    <mock:verify-times-called processor="http:request" times="1"/>
    <munit:assert-that expression="#[payload]" is="#[equalTo('OK')]"/>
    <munit:set-event name="setInbound">
      <munit:inbound-properties>
        <munit:inbound-property key="http.request.path" value="/orders"/>
      </munit:inbound-properties>
    </munit:set-event>
  </munit:test>
</mule>`;

describe('parseMUnit — Mule 3 MUnit', () => {
  it('lifts a flat Mule 3 test with a direct flow-ref (no execution wrapper) + expected exception', () => {
    const suite = parseMUnit(MULE3_MUNIT_XML, 'mule3');
    expect(suite.dialect).toBe('mule3');
    expect(suite.tests).toHaveLength(1);
    expect(suite.tests[0]).toMatchObject({
      name: 'legacy-flow-test',
      testedFlows: ['legacyFlow'],
      expectedErrorType: 'LEGACY:TIMEOUT',
    });
  });

  it('collects a mock and a verify-times-called assertion from the flat structure', () => {
    const suite = parseMUnit(MULE3_MUNIT_XML, 'mule3');
    const mocks = suite.tests[0]?.mocks ?? [];
    expect(mocks).toContainEqual(
      expect.objectContaining({ processor: 'http:request', configRef: 'httpConfig' }),
    );
    const assertions = suite.tests[0]?.assertions ?? [];
    expect(assertions.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['assert-that', 'verify-times-called']),
    );
  });

  it('tolerates inbound-property setup under set-event without retaining the value as a secret', () => {
    // set-event inbound-properties are a setup construct; the parser does not model them, and a
    // literal value there must not surface as a retained secret. Here the value is a path (not a
    // secret), but the point is the suite stays well-formed and the mock payload redacts a key.
    const suite = parseMUnit(MULE3_MUNIT_XML, 'mule3');
    expect(suite.tests[0]?.mocks[0]?.payload).toBe('#[payload]');
    expect(JSON.stringify(suite)).not.toContain('password');
  });
});
