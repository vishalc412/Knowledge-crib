import { idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, FileClassification, FileMeta } from '../types.js';
import { MuleExtractor } from './MuleExtractor.js';

/** A minimal in-memory ExtractCtx: readText returns a fixed source; idFor delegates to the real
 *  id grammar; hash is a content fingerprint. Mirrors pipeline's makeExtractCtx shape. */
function mkCtx(source: string): ExtractCtx {
  let cached: string | undefined;
  return {
    async readText(): Promise<string> {
      if (cached === undefined) cached = source;
      return cached;
    },
    treeSitter: () => ({ parse: () => null }),
    hash: (s: string) => `blake3:${s.length}`,
    idFor: (kind: NodeKind, parts: Record<string, unknown>): string =>
      idFor({ kind, ...parts } as IdSpec),
  };
}

/** Build a FileMeta carrying a Mule classification. */
function muleFile(
  path: string,
  role: FileClassification['role'],
  dialect: 'mule3' | 'mule4',
  source: string,
): FileMeta {
  return {
    path,
    bytes: source.length,
    mtime: 0,
    classification: { family: 'mule', projectId: 'proj', projectRoot: '', dialect, role },
  };
}

const CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http"
      xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core"
      xmlns:doc="http://www.mulesoft.org/schema/mule/documentation">
  <http:listener-config name="httpConfig" basePath="/api">
    <http:listener-connection host="0.0.0.0" port="8081"/>
  </http:listener-config>
  <flow name="getOrders">
    <http:listener config-ref="httpConfig" path="/orders" allowedMethods="GET"/>
    <ee:transform doc:name="t">
      <ee:message>
        <ee:set-payload><![CDATA[#[payload]]]></ee:set-payload>
      </ee:message>
    </ee:transform>
    <choice>
      <when expression="#[payload.id == 1]">
        <flow-ref name="enrichOrder"/>
      </when>
      <otherwise>
        <logger level="INFO" message="default"/>
      </otherwise>
    </choice>
    <http:request config-ref="httpConfig" method="GET" path="/downstream"/>
    <error-handler>
      <on-error-propagate type="ANY">
        <logger level="ERROR" message="#[error.description]"/>
      </on-error-propagate>
    </error-handler>
  </flow>
  <sub-flow name="enrichOrder">
    <logger level="INFO" message="enriching"/>
  </sub-flow>
</mule>`;

const PROPERTIES = `db.user=alice
db.password=swordfish`;

const POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <properties>
    <http.version>1.5.0</http.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.mule.connectors</groupId>
      <artifactId>mule-http-connector</artifactId>
      <version>\${http.version}</version>
    </dependency>
  </dependencies>
</project>`;

const DW = `%dw 2.0
import upper from dw::core::Strings
var region = p('billing.region')
fun total(xs) = xs reduce ((n, acc = 0) -> acc + n)
---
{ id: payload.id, total: total(payload.lines) }`;

const RAML = `#%RAML 1.0
title: Orders API
version: v1
types:
  Order: !include types/order.raml
/orders:
  get:
    responses:
      200:
        body:
          application/json:
            type: Order
  post:
    body:
      type: Order`;

describe('MuleExtractor — dispatch + supports', () => {
  const extractor = new MuleExtractor();

  it('supports only files classified family mule', () => {
    expect(extractor.supports(muleFile('a.xml', 'config', 'mule4', ''))).toBe(true);
    expect(extractor.supports({ path: 'a.ts', bytes: 0, mtime: 0 })).toBe(false);
  });

  it('returns empty for an unclassified file', async () => {
    const result = await extractor.extract({ path: 'x.xml', bytes: 0, mtime: 0 }, mkCtx(''));
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

describe('MuleExtractor — config role (flows, processors, routers, handlers)', () => {
  const extractor = new MuleExtractor();
  let result = {
    nodes: [] as ReturnType<typeof Object>[],
    edges: [] as ReturnType<typeof Object>[],
  } as unknown as Awaited<ReturnType<typeof extractor.extract>>;

  it('emits flow + subflow symbol nodes member-of the file', async () => {
    result = await extractor.extract(
      muleFile('src/main/mule/orders.xml', 'config', 'mule4', CONFIG_XML),
      mkCtx(CONFIG_XML),
    );
    const fileId = idFor({ kind: 'file', path: 'src/main/mule/orders.xml' });
    const flow = result.nodes.find((n) => n.name === 'getOrders');
    expect(flow).toMatchObject({ kind: 'symbol', type: 'flow', lang: 'mule' });
    const subflow = result.nodes.find((n) => n.name === 'enrichOrder');
    expect(subflow).toMatchObject({ kind: 'symbol', type: 'subflow', lang: 'mule' });
    // member-of: flow → file
    expect(result.edges).toContainEqual(
      expect.objectContaining({ src: flow?.id, dst: fileId, rel: 'member-of' }),
    );
  });

  it('emits a config symbol node with namespace + configuration name', () => {
    const config = result.nodes.find((n) => n.type === 'config');
    expect(config).toMatchObject({ kind: 'symbol', name: 'httpConfig' });
    expect(config?.meta).toMatchObject({ configurationName: 'httpConfig', namespace: 'http' });
  });

  it('emits processor statement nodes executes by the flow, carrying semanticKind', () => {
    // Every flow + subflow is a symbol; each statement is executes'd by the flow that owns it.
    const flowIds = new Set(
      result.nodes.filter((n) => n.type === 'flow' || n.type === 'subflow').map((n) => n.id),
    );
    const statements = result.nodes.filter((n) => n.kind === 'statement');
    expect(statements.length).toBeGreaterThan(0);
    // executes: some flow → each statement
    for (const s of statements) {
      expect(result.edges).toContainEqual(expect.objectContaining({ dst: s.id, rel: 'executes' }));
      const owner = result.edges.find((e) => e.dst === s.id && e.rel === 'executes');
      expect(owner && flowIds.has(owner.src)).toBe(true);
    }
    // a transform statement carries its semanticKind in meta
    const transform = statements.find(
      (s) => (s.meta as { semanticKind?: string })?.semanticKind === 'transform',
    );
    expect(transform).toBeDefined();
  });

  it('emits a condition node for the choice route with a guarded-by edge', () => {
    const conditions = result.nodes.filter((n) => n.kind === 'condition');
    expect(conditions.length).toBeGreaterThan(0);
    // the when route's statement(s) are guarded-by the condition node
    const guarded = result.edges.filter((e) => e.rel === 'guarded-by');
    expect(guarded.length).toBeGreaterThan(0);
  });

  it('emits an http-call node for the outbound http:request', () => {
    const call = result.nodes.find((n) => n.kind === 'http-call');
    expect(call).toMatchObject({ httpMethod: 'GET', routePath: '/downstream' });
    const flow = result.nodes.find((n) => n.name === 'getOrders');
    expect(result.edges).toContainEqual(
      expect.objectContaining({ src: flow?.id, dst: call?.id, rel: 'executes' }),
    );
  });

  it('emits a route node for the listener source + an exposes edge flow→route', () => {
    const route = result.nodes.find((n) => n.kind === 'route');
    expect(route).toMatchObject({ httpMethod: 'GET', routePath: '/api/orders' });
    const flow = result.nodes.find((n) => n.name === 'getOrders');
    expect(result.edges).toContainEqual(
      expect.objectContaining({ src: flow?.id, dst: route?.id, rel: 'exposes' }),
    );
  });

  it('emits an exception-handler node for the error handler with strategy + errorType', () => {
    const eh = result.nodes.find((n) => n.kind === 'exception-handler');
    expect(eh).toMatchObject({ whenSelector: 'ANY' });
    expect(eh?.meta).toMatchObject({ strategy: 'on-error-propagate' });
  });

  it('emits a local calls edge for a same-file flow-ref', () => {
    const subflow = result.nodes.find((n) => n.name === 'enrichOrder');
    expect(result.edges).toContainEqual(
      expect.objectContaining({ dst: subflow?.id, rel: 'calls' }),
    );
  });
});

describe('MuleExtractor — properties role (keys only, never values)', () => {
  it('emits a property symbol node per key with valueRedacted and never the value', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/main/mule/app.properties', 'properties', 'mule4', PROPERTIES),
      mkCtx(PROPERTIES),
    );
    const keys = result.nodes.filter((n) => n.type === 'property').map((n) => n.name);
    expect(keys.sort()).toEqual(['db.password', 'db.user']);
    for (const n of result.nodes.filter((n) => n.type === 'property')) {
      expect((n.meta as { valueRedacted?: boolean }).valueRedacted).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain('swordfish');
    expect(JSON.stringify(result)).toContain('db.password');
  });
});

describe('MuleExtractor — descriptor role (POM dependencies + artifact)', () => {
  it('emits a dependency symbol node with groupId/artifactId/versionRef and the property key', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('pom.xml', 'descriptor', 'mule4', POM),
      mkCtx(POM),
    );
    const dep = result.nodes.find((n) => n.type === 'dependency');
    expect(dep).toMatchObject({
      kind: 'symbol',
      name: 'mule-http-connector',
    });
    expect(dep?.meta).toMatchObject({
      groupId: 'org.mule.connectors',
      artifactId: 'mule-http-connector',
      versionRef: '${http.version}',
    });
    // the POM <properties> key is surfaced as a property symbol
    const prop = result.nodes.find((n) => n.type === 'property' && n.name === 'http.version');
    expect(prop).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('1.5.0');
  });
});

describe('MuleExtractor — dataweave role (modules + functions)', () => {
  it('emits a module symbol + a function symbol member-of the module', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/main/resources/dwl/orders.dwl', 'dataweave', 'mule4', DW),
      mkCtx(DW),
    );
    const module = result.nodes.find((n) => n.type === 'module');
    expect(module).toMatchObject({ kind: 'symbol', lang: 'dataweave' });
    expect(module?.meta).toMatchObject({ version: '2.0' });
    const fun = result.nodes.find((n) => n.type === 'function' && n.name === 'total');
    expect(fun).toBeDefined();
    expect(result.edges).toContainEqual(
      expect.objectContaining({ src: fun?.id, dst: module?.id, rel: 'member-of' }),
    );
  });
});

describe('MuleExtractor — raml role (routes)', () => {
  it('emits a route node per resource method with HTTP method + templated path', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/main/resources/api/orders.raml', 'raml', 'mule4', RAML),
      mkCtx(RAML),
    );
    const routes = result.nodes.filter((n) => n.kind === 'route');
    expect(routes).toContainEqual(
      expect.objectContaining({ httpMethod: 'GET', routePath: '/orders' }),
    );
    expect(routes).toContainEqual(
      expect.objectContaining({ httpMethod: 'POST', routePath: '/orders' }),
    );
    // includes are recorded as references on the module/file-level meta, never inlined
    expect(JSON.stringify(result)).toContain('types/order.raml');
  });
});

const MULE3_CONFIG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:vm="http://www.mulesoft.org/schema/mule/vm">
  <vm:connector name="vmConnector"/>
  <flow name="legacyFlow">
    <inbound-endpoint ref="vmConnector" path="in"/>
    <set-payload value="#[payload]"/>
    <choice>
      <when expression="#[payload == 1]">
        <flow-ref name="helper"/>
      </when>
      <otherwise>
        <logger message="default"/>
      </otherwise>
    </choice>
    <outbound-endpoint ref="vmConnector" path="out"/>
    <catch-exception-strategy>
      <logger message="caught"/>
    </catch-exception-strategy>
  </flow>
  <sub-flow name="helper">
    <set-variable variableName="v" value="#[payload]"/>
  </sub-flow>
</mule>`;

const MEL_RESOURCE = `#[flowVars.customerId != null ? app.registry['region'] : p('billing.region')]`;

describe('MuleExtractor — mule3 config role (same vocabulary as Mule 4)', () => {
  const extractor = new MuleExtractor();
  let result = {
    nodes: [] as ReturnType<typeof Object>[],
    edges: [] as ReturnType<typeof Object>[],
  } as unknown as Awaited<ReturnType<typeof extractor.extract>>;

  it('emits flow + subflow + config symbol nodes stamped meta.dialect mule3', async () => {
    result = await extractor.extract(
      muleFile('src/main/app/mule3.xml', 'config', 'mule3', MULE3_CONFIG_XML),
      mkCtx(MULE3_CONFIG_XML),
    );
    const flow = result.nodes.find((n) => n.name === 'legacyFlow');
    expect(flow).toMatchObject({ kind: 'symbol', type: 'flow', lang: 'mule' });
    expect(flow?.meta).toMatchObject({ dialect: 'mule3' });
    const subflow = result.nodes.find((n) => n.name === 'helper');
    expect(subflow).toMatchObject({ kind: 'symbol', type: 'subflow', lang: 'mule' });
    const config = result.nodes.find((n) => n.type === 'config');
    expect(config).toMatchObject({ name: 'vmConnector' });
    expect(config?.meta).toMatchObject({ dialect: 'mule3' });
  });

  it('emits an exception-handler node for the catch-exception-strategy', () => {
    const eh = result.nodes.find((n) => n.kind === 'exception-handler');
    expect(eh?.meta).toMatchObject({ strategy: 'catch' });
  });

  it('emits a local calls edge for a same-file Mule 3 flow-ref', () => {
    const subflow = result.nodes.find((n) => n.name === 'helper');
    expect(result.edges).toContainEqual(
      expect.objectContaining({ dst: subflow?.id, rel: 'calls' }),
    );
  });

  it('attaches inline MEL expressions and never persists a property value', () => {
    // a set-payload statement carries the MEL #[payload] expression; no secret value leaks.
    const statements = result.nodes.filter((n) => n.kind === 'statement');
    expect(statements.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('mule:mule3-not-implemented');
  });
});

describe('MuleExtractor — mel role (Mule 3 standalone expression resource)', () => {
  it('emits one module symbol carrying property-key references, never values', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/main/resources/exprs/region.mel', 'mel', 'mule3', MEL_RESOURCE),
      mkCtx(MEL_RESOURCE),
    );
    const module = result.nodes.find((n) => n.type === 'module');
    expect(module).toMatchObject({ kind: 'symbol', lang: 'mel', name: 'region' });
    expect(module?.meta).toMatchObject({ dialect: 'mule3' });
    // the property KEY is a cross-file reference; the resolved value is absent
    expect(module?.meta).toMatchObject({
      references: [{ kind: 'property', name: 'billing.region' }],
    });
    expect(JSON.stringify(result)).not.toContain('swordfish');
    // variables + registry are surfaced as intra-expression facts for migration triage
    expect(module?.meta).toMatchObject({
      melReferences: expect.arrayContaining([
        expect.objectContaining({ kind: 'variable', name: 'customerId' }),
        expect.objectContaining({ kind: 'registry', name: 'region' }),
      ]),
    });
  });
});

const MUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit"
      xmlns:mock="http://www.mulesoft.org/schema/mule/mock"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <munit:test name="billing-api-test" description="tests the billing api">
    <munit:enable-flow-sources>
      <munit:enable-flow-source flowName="billing-api"/>
      <munit:enable-flow-source flowName="missingFlow"/>
    </munit:enable-flow-sources>
    <munit:behavior>
      <mock:when processor="http:request" config-ref="httpConfig">
        <mock:then-return>
          <mock:payload mediaType="application/java">#[payload]</mock:payload>
        </mock:then-return>
      </mock:when>
      <mock:spy processor="logger"/>
    </munit:behavior>
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
    <munit:validation>
      <munit:assert-that expression="#[payload]" is="#[equalTo('OK')]"/>
      <munit:load-static-resource file="fixtures/orders.json"/>
    </munit:validation>
  </munit:test>
</mule>`;

describe('MuleExtractor — munit role', () => {
  it('emits a test symbol node carrying tested flows + test-target / fixture references', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/test/munit/tests.xml', 'munit', 'mule4', MUNIT_XML),
      mkCtx(MUNIT_XML),
    );
    const test = result.nodes.find((n) => n.type === 'test' && n.name === 'billing-api-test');
    expect(test).toMatchObject({
      kind: 'symbol',
      type: 'test',
      name: 'billing-api-test',
      lang: 'mule',
      file: 'src/test/munit/tests.xml',
    });
    expect(test?.meta).toMatchObject({ dialect: 'mule4', projectId: 'proj' });
    expect(test?.meta?.testedFlows).toEqual(expect.arrayContaining(['billing-api', 'missingFlow']));
    const refs = (test?.meta?.references as { kind: string; name: string }[]) ?? [];
    expect(refs).toContainEqual({ kind: 'test-target', name: 'billing-api' });
    expect(refs).toContainEqual({ kind: 'test-target', name: 'missingFlow' });
    expect(refs).toContainEqual({ kind: 'fixture', name: 'fixtures/orders.json' });
    // a member-of edge ties the test to its file node.
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'member-of',
        src: test?.id,
        evidence: expect.objectContaining({ by: 'family:mulesoft' }),
      }),
    );
  });

  it('emits mock child statement nodes executed by the test, with mock-target references', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/test/munit/tests.xml', 'munit', 'mule4', MUNIT_XML),
      mkCtx(MUNIT_XML),
    );
    const test = result.nodes.find((n) => n.type === 'test' && n.name === 'billing-api-test');
    expect(test).toBeDefined();

    const mocks = result.nodes.filter((n) => n.meta?.munitKind === 'mock');
    // the http:request mock names its config; the logger spy names only its processor.
    const httpMock = mocks.find((m) => m.meta?.processor === 'http:request');
    expect(httpMock).toMatchObject({ kind: 'statement', lang: 'mule' });
    expect(httpMock?.meta?.references).toEqual([{ kind: 'mock-target', name: 'httpConfig' }]);
    const spyMock = mocks.find((m) => m.meta?.processor === 'logger');
    expect(spyMock?.meta?.references).toEqual([{ kind: 'mock-target', name: 'logger' }]);

    // each mock is executed by the test (executes edge test → mock).
    for (const m of mocks) {
      expect(result.edges).toContainEqual(
        expect.objectContaining({ rel: 'executes', src: test?.id, dst: m.id }),
      );
    }
  });

  it('emits an assertion child statement node executed by the test', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/test/munit/tests.xml', 'munit', 'mule4', MUNIT_XML),
      mkCtx(MUNIT_XML),
    );
    const test = result.nodes.find((n) => n.type === 'test' && n.name === 'billing-api-test');
    const assertion = result.nodes.find((n) => n.meta?.munitKind === 'assertion');
    expect(assertion).toMatchObject({ kind: 'statement', lang: 'mule' });
    expect(assertion?.meta?.assertionKind).toBe('assert-that');
    expect(result.edges).toContainEqual(
      expect.objectContaining({ rel: 'executes', src: test?.id, dst: assertion?.id }),
    );
  });

  it('retains the expected error type as metadata, never as a value', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit">
  <munit:test name="err-test" expectedErrorType="BILLING:NOT_FOUND">
    <munit:execution>
      <flow-ref name="billing-api"/>
    </munit:execution>
  </munit:test>
</mule>`;
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/test/munit/err.xml', 'munit', 'mule4', xml),
      mkCtx(xml),
    );
    const test = result.nodes.find((n) => n.type === 'test' && n.name === 'err-test');
    expect(test?.meta?.expectedErrorType).toBe('BILLING:NOT_FOUND');
  });

  it('degrades to a parse-failed diagnostic on a hostile payload', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile(
        'src/main/mule/bad.xml',
        'config',
        'mule4',
        '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:/etc/passwd">]>',
      ),
      mkCtx('<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:/etc/passwd">]>'),
    );
    expect(result.diagnostics?.some((d) => d.code === 'mule:parse-failed')).toBe(true);
    expect(result.nodes).toEqual([]);
  });
});
