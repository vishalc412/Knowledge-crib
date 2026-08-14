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

describe('MuleExtractor — mule3 + munit + error fallback', () => {
  it('reports a not-implemented diagnostic for Mule 3 and emits no semantic nodes', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/main/app/mule3.xml', 'config', 'mule3', CONFIG_XML),
      mkCtx(CONFIG_XML),
    );
    expect(result.nodes).toEqual([]);
    expect(result.diagnostics?.some((d) => d.code === 'mule:mule3-not-implemented')).toBe(true);
  });

  it('emits no semantic nodes for an MUnit file (structure-phase file node represents it)', async () => {
    const extractor = new MuleExtractor();
    const result = await extractor.extract(
      muleFile('src/test/munit/tests.xml', 'munit', 'mule4', '<mule></mule>'),
      mkCtx('<mule></mule>'),
    );
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
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
