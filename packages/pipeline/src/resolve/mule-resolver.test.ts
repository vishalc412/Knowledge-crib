/**
 * MuleResolver — cross-file resolution unit tests. The resolver consumes `meta.references` the
 * MuleExtractor records on processor / module / route nodes and turns them into EXTRACTED edges
 * against the project's symbol index, WITHOUT re-parsing XML. Covers the four reference families
 * the plan locks: cross-file flow-ref (`calls`), connector config-ref (`references`), static-missing
 * flow targets (external-flow placeholder nodes), and dynamic flow-ref names (dropped, never
 * guessed). SECURITY: property VALUES never appear — only keys/refs are resolved.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { MuleExtractor } from '@knowledge-crib/parsers';
import type { ExtractCtx, FileClassification, FileMeta } from '@knowledge-crib/parsers';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, Node, NodeKind } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuleResolver, resolveMule } from './mule-resolver.js';
import { SymbolTable } from './symbol-table.js';

const NOW = '2026-01-01T00:00:00.000Z';

/** A minimal in-memory ExtractCtx mirroring pipeline's makeExtractCtx (real idFor + content hash). */
function mkCtx(source: string): ExtractCtx {
  let cached: string | undefined;
  return {
    async readText(): Promise<string> {
      if (cached === undefined) cached = source;
      return cached;
    },
    treeSitter: () => ({ parse: () => null }),
    hash: (s: string) => contentHash(s),
    idFor: (kind: NodeKind, parts: Record<string, unknown>): string =>
      idFor({ kind, ...parts } as IdSpec),
  };
}

/** Build a FileMeta carrying a Mule classification with a project id. */
function muleFile(
  path: string,
  role: FileClassification['role'],
  dialect: 'mule3' | 'mule4',
  source: string,
  projectId = 'orders-proj',
): FileMeta {
  return {
    path,
    bytes: source.length,
    mtime: 0,
    classification: { family: 'mule', projectId, projectRoot: '', dialect, role },
  };
}

const ORDERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <http:listener-config name="httpConfig" basePath="/api">
    <http:listener-connection host="0.0.0.0" port="8081"/>
  </http:listener-config>
  <flow name="getOrders">
    <flow-ref name="enrichOrder"/>
    <flow-ref name="missingFlow"/>
    <flow-ref name="#[payload.target]"/>
    <http:request config-ref="httpConfig" method="GET" path="/downstream"/>
  </flow>
</mule>`;

const ENRICH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core">
  <sub-flow name="enrichOrder">
    <logger level="INFO" message="enriching"/>
  </sub-flow>
</mule>`;

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-mule-resolver-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

/** Extract both files into a fresh soul (extractor intra-file edges included), then resolve. */
async function setup() {
  const soul = soulFor();
  const extractor = new MuleExtractor();
  const ordersFile = muleFile('src/main/mule/orders.xml', 'config', 'mule4', ORDERS_XML);
  const enrichFile = muleFile('src/main/mule/enrich.xml', 'config', 'mule4', ENRICH_XML);
  const files = [ordersFile, enrichFile];

  for (const f of files) {
    const r = await extractor.extract(
      f,
      mkCtx(f.path.endsWith('orders.xml') ? ORDERS_XML : ENRICH_XML),
    );
    if (r.nodes.length) soul.putNodes(r.nodes as never);
    if (r.edges.length) soul.putEdges(r.edges as never);
  }

  const table = new SymbolTable(soul);
  const result = resolveMule(soul, table, '/repo', files);
  return { soul, table, result, ordersFile, enrichFile };
}

/** Find a node by a predicate over its meta.references (kind+name). */
function refNode(soul: SoulStore, kind: string, name: string): Node | undefined {
  for (const n of soul.iterate()) {
    const refs = (n.meta?.references as { kind: string; name: string }[] | undefined) ?? [];
    if (refs.some((r) => r.kind === kind && r.name === name)) return n;
  }
  return undefined;
}

describe('MuleResolver — cross-file flow-ref', () => {
  it('resolves a cross-file flow-ref to a calls edge from the enclosing flow, callSite = processor', async () => {
    const { result, soul } = await setup();
    const stmt = refNode(soul, 'flow-ref', 'enrichOrder');
    expect(stmt).toBeDefined();
    const target = [...soul.iterate('symbol')].find((n) => n.name === 'enrichOrder');
    expect(target).toBeDefined();
    const enclosing = [...soul.iterate('symbol')].find((n) => n.name === 'getOrders');
    expect(enclosing).toBeDefined();

    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'calls',
        src: enclosing?.id,
        dst: target?.id,
        provenance: 'EXTRACTED',
        evidence: expect.objectContaining({ callSite: stmt?.id }),
      }),
    );
  });

  it('emits an external-flow placeholder node + calls edge for a static missing flow target', async () => {
    const { result, soul } = await setup();
    const stmt = refNode(soul, 'flow-ref', 'missingFlow');
    const enclosing = [...soul.iterate('symbol')].find((n) => n.name === 'getOrders');

    const placeholder = result.nodes.find(
      (n) => n.type === 'external-flow' && n.name === 'missingFlow',
    );
    expect(placeholder).toMatchObject({
      kind: 'symbol',
      type: 'external-flow',
      name: 'missingFlow',
    });
    expect(placeholder?.meta).toMatchObject({ family: 'mule' });

    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'calls',
        src: enclosing?.id,
        dst: placeholder?.id,
        evidence: expect.objectContaining({ callSite: stmt?.id }),
      }),
    );
    expect(placeholder?.id).toBeDefined();
  });
});

describe('MuleResolver — config-ref + dynamic', () => {
  it('resolves a connector config-ref to a references edge with referenceKind config', async () => {
    const { result, soul } = await setup();
    const call = [...soul.iterate('http-call')].find((n) => n.routePath === '/downstream');
    const config = [...soul.iterate('symbol')].find(
      (n) => n.type === 'config' && n.name === 'httpConfig',
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'references',
        src: call?.id,
        dst: config?.id,
        evidence: expect.objectContaining({ referenceKind: 'config' }),
      }),
    );
  });

  it('drops a dynamic flow-ref name without emitting an edge or placeholder', async () => {
    const { result } = await setup();
    expect(result.nodes.find((n) => n.name === '#[payload.target]')).toBeUndefined();
    expect(result.stats.dynamic).toBeGreaterThanOrEqual(1);
  });
});

const LEGACY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:vm="http://www.mulesoft.org/schema/mule/vm">
  <vm:connector name="vmConnector"/>
  <catch-exception-strategy name="globalErr">
    <logger message="global catch"/>
  </catch-exception-strategy>
  <flow name="legacyFlow">
    <inbound-endpoint ref="vmConnector" path="in"/>
    <set-payload value="#[payload]"/>
    <outbound-endpoint ref="vmConnector" path="out"/>
    <reference-exception-strategy ref="globalErr"/>
  </flow>
</mule>`;

/** Extract the Mule 3 legacy fixture into a fresh soul, then resolve. */
async function setupMule3() {
  const soul = soulFor();
  const extractor = new MuleExtractor();
  const file = muleFile('src/main/app/legacy.xml', 'config', 'mule3', LEGACY_XML);
  const files = [file];
  const r = await extractor.extract(file, mkCtx(LEGACY_XML));
  if (r.nodes.length) soul.putNodes(r.nodes as never);
  if (r.edges.length) soul.putEdges(r.edges as never);
  const table = new SymbolTable(soul);
  const result = resolveMule(soul, table, '/repo', files);
  return { soul, table, result, file };
}

describe('MuleResolver — Mule 3 legacy endpoint + exception-strategy refs', () => {
  it('resolves an inbound/outbound-endpoint ref to the connector config (referenceKind endpoint)', async () => {
    const { result, soul } = await setupMule3();
    const connector = [...soul.iterate('symbol')].find(
      (n) => n.type === 'config' && n.name === 'vmConnector',
    );
    expect(connector).toBeDefined();
    // the inbound source route + the outbound http-call both surface an endpoint ref
    const endpointEdges = result.edges.filter(
      (e) =>
        e.rel === 'references' &&
        e.dst === connector?.id &&
        (e.evidence as { referenceKind?: string }).referenceKind === 'endpoint',
    );
    expect(endpointEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves a reference-exception-strategy ref to the global strategy config', async () => {
    const { result, soul } = await setupMule3();
    const globalErr = [...soul.iterate('symbol')].find(
      (n) => n.type === 'config' && n.name === 'globalErr',
    );
    expect(globalErr).toBeDefined();
    const handler = [...soul.iterate('exception-handler')].find((n) =>
      (n.meta?.references as { kind: string; name: string }[] | undefined)?.some(
        (r) => r.kind === 'exceptionStrategy' && r.name === 'globalErr',
      ),
    );
    expect(handler).toBeDefined();
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'references',
        src: handler?.id,
        dst: globalErr?.id,
        evidence: expect.objectContaining({ referenceKind: 'exceptionStrategy' }),
      }),
    );
  });

  it('does not regress: Mule 4 config-ref still resolves with referenceKind config', async () => {
    const { result, soul } = await setup();
    const config = [...soul.iterate('symbol')].find(
      (n) => n.type === 'config' && n.name === 'httpConfig',
    );
    expect(
      result.edges.some(
        (e) =>
          e.rel === 'references' &&
          e.dst === config?.id &&
          (e.evidence as { referenceKind?: string }).referenceKind === 'config',
      ),
    ).toBe(true);
  });
});

const BILLING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <http:listener-config name="httpConfig" basePath="/api"/>
  <flow name="billing-api">
    <logger level="INFO" message="x"/>
  </flow>
</mule>`;

const MUNIT_TEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:munit="http://www.mulesoft.org/schema/mule/munit"
      xmlns:mock="http://www.mulesoft.org/schema/mule/mock"
      xmlns:http="http://www.mulesoft.org/schema/mule/http">
  <munit:test name="billing-api-test">
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
    <munit:validation>
      <munit:load-static-resource file="fixtures/orders.json"/>
      <munit:load-static-resource file="fixtures/missing.json"/>
    </munit:validation>
  </munit:test>
</mule>`;

/** Extract a Mule 4 app + its MUnit suite into a fresh soul, add a fixture file node so one
 *  fixture resolves to a real file, then resolve. */
async function setupMunit() {
  const soul = soulFor();
  const extractor = new MuleExtractor();
  const appFile = muleFile('src/main/mule/billing.xml', 'config', 'mule4', BILLING_XML);
  const testFile = muleFile('src/test/munit/tests.xml', 'munit', 'mule4', MUNIT_TEST_XML);
  const files = [appFile, testFile];
  for (const f of files) {
    const src = f.path.endsWith('tests.xml') ? MUNIT_TEST_XML : BILLING_XML;
    const r = await extractor.extract(f, mkCtx(src));
    if (r.nodes.length) soul.putNodes(r.nodes as never);
    if (r.edges.length) soul.putEdges(r.edges as never);
  }
  // A structure-phase file node for the existing fixture so one fixture resolves to a real file.
  const fixtureFileId = idFor({
    kind: 'file',
    path: 'src/test/resources/fixtures/orders.json',
  } as IdSpec);
  soul.putNodes([
    {
      id: fixtureFileId,
      kind: 'file',
      file: 'src/test/resources/fixtures/orders.json',
      hash: contentHash('file:orders.json'),
      meta: {},
    } as never,
  ]);
  const table = new SymbolTable(soul);
  const result = resolveMule(soul, table, '/repo', files);
  return { soul, table, result, appFile, testFile };
}

describe('MuleResolver — MUnit migration evidence', () => {
  it('resolves a test-target to a calls edge from the test to the named flow', async () => {
    const { result, soul } = await setupMunit();
    const test = refNode(soul, 'test-target', 'billing-api');
    expect(test).toBeDefined();
    const flow = [...soul.iterate('symbol')].find((n) => n.name === 'billing-api');
    expect(flow).toBeDefined();
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'calls',
        src: test?.id,
        dst: flow?.id,
        evidence: expect.objectContaining({ referenceKind: 'test-target' }),
      }),
    );
  });

  it('emits an external-flow placeholder + calls edge for a missing tested flow', async () => {
    const { result, soul } = await setupMunit();
    const test = refNode(soul, 'test-target', 'missingFlow');
    const placeholder = result.nodes.find(
      (n) => n.type === 'external-flow' && n.name === 'missingFlow',
    );
    expect(placeholder).toMatchObject({ kind: 'symbol', type: 'external-flow' });
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'calls',
        src: test?.id,
        dst: placeholder?.id,
        evidence: expect.objectContaining({ referenceKind: 'test-target' }),
      }),
    );
  });

  it('resolves a mock config-ref to a references edge with referenceKind mock-target', async () => {
    const { result, soul } = await setupMunit();
    const mock = refNode(soul, 'mock-target', 'httpConfig');
    expect(mock).toBeDefined();
    const config = [...soul.iterate('symbol')].find(
      (n) => n.type === 'config' && n.name === 'httpConfig',
    );
    expect(config).toBeDefined();
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'references',
        src: mock?.id,
        dst: config?.id,
        evidence: expect.objectContaining({ referenceKind: 'mock-target' }),
      }),
    );
  });

  it('drops a mock with no resolvable config (spy) without emitting an edge', async () => {
    const { result, soul } = await setupMunit();
    const spy = refNode(soul, 'mock-target', 'logger');
    expect(spy).toBeDefined();
    const spyEdges = result.edges.filter((e) => e.src === spy?.id && e.rel === 'references');
    expect(spyEdges).toEqual([]);
  });

  it('resolves an existing fixture to a references edge to the file node', async () => {
    const { result, soul } = await setupMunit();
    const test = refNode(soul, 'fixture', 'fixtures/orders.json');
    expect(test).toBeDefined();
    const fixtureFile = [...soul.iterate('file')].find((n) =>
      n.file?.endsWith('fixtures/orders.json'),
    );
    expect(fixtureFile).toBeDefined();
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'references',
        src: test?.id,
        dst: fixtureFile?.id,
        evidence: expect.objectContaining({ referenceKind: 'fixture' }),
      }),
    );
  });

  it('emits an external-fixture placeholder + references edge for a missing fixture', async () => {
    const { result, soul } = await setupMunit();
    const test = refNode(soul, 'fixture', 'fixtures/missing.json');
    const placeholder = result.nodes.find(
      (n) => n.type === 'external-fixture' && n.name === 'fixtures/missing.json',
    );
    expect(placeholder).toMatchObject({ kind: 'symbol', type: 'external-fixture' });
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        rel: 'references',
        src: test?.id,
        dst: placeholder?.id,
        evidence: expect.objectContaining({ referenceKind: 'fixture' }),
      }),
    );
  });
});

describe('MuleResolver — Resolver adapter', () => {
  it('supports only mule-family files', () => {
    const r = new MuleResolver();
    expect(r.supports(muleFile('a.xml', 'config', 'mule4', ''))).toBe(true);
    expect(r.supports({ path: 'a.ts', bytes: 0, mtime: 0 })).toBe(false);
  });

  it('resolve() returns edges + nodes + stats', async () => {
    const soul = soulFor();
    const extractor = new MuleExtractor();
    const ordersFile = muleFile('src/main/mule/orders.xml', 'config', 'mule4', ORDERS_XML);
    const enrichFile = muleFile('src/main/mule/enrich.xml', 'config', 'mule4', ENRICH_XML);
    const files = [ordersFile, enrichFile];
    for (const f of files) {
      const r = await extractor.extract(
        f,
        mkCtx(f.path.endsWith('orders.xml') ? ORDERS_XML : ENRICH_XML),
      );
      if (r.nodes.length) soul.putNodes(r.nodes as never);
      if (r.edges.length) soul.putEdges(r.edges as never);
    }
    const table = new SymbolTable(soul);
    const resolver = new MuleResolver();
    const out = resolver.resolve({ soul, table, root: '/repo', files });
    expect(out.edges.length).toBeGreaterThan(0);
    expect((out as { nodes?: Node[] }).nodes?.length).toBeGreaterThan(0);
  });
});
