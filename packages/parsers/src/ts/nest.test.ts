/**
 * NestJS + TypeORM framework-semantics (schema 1.3) — dedicated coverage of
 * {@link extractNestSemantics} driven through the {@link TypeScriptExtractor} end-to-end (Pass 4).
 * Mirrors {@link spring.test.ts}: the artifacts that put a Node graph "above SQL" — stereotypes,
 * HTTP routes (+ exposes), the DI graph (injects), module producers, TypeORM entity relations
 * (references) + columns, exception filters, param binding, and security — each exercised for the
 * happy path, the edge shapes, and the no-op gates. Inline source keeps these fast + deterministic.
 */
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';

const PATH = 'nest.ts';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — TypeScript uses the TS compiler API');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(src: string): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'typescript', bytes: src.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(src));
}

/** label a node id by qualified name (symbol/field), else kind — for readable edge assertions. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.qualifiedName ?? n?.name ?? n?.kind ?? id;
  };
}

/** all route surfaces as `METHOD /path`, sorted. */
const routes = (r: ExtractResult): string[] =>
  r.nodes
    .filter((n) => n.kind === 'route')
    .map((n) => `${n.httpMethod} ${n.routePath}`)
    .sort();

/** all `exposes` edges: handler qualified name → `METHOD /path`. */
const exposes = (r: ExtractResult): string[] => {
  const lbl = label(r);
  const routeById = new Map(r.nodes.filter((n) => n.kind === 'route').map((n) => [n.id, n]));
  return r.edges
    .filter((e) => e.rel === 'exposes')
    .map((e) => `${lbl(e.src)} -> ${routeById.get(e.dst)?.name ?? e.dst}`)
    .sort();
};

/** all `injects` edges: consumer → dependency, sorted. */
const injects = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'injects')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** all `references` edges (TypeORM): field → related type, sorted. */
const references = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'references')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** all `produces` edges: module → provider, sorted. */
const produces = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'produces')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** `meta.produces` for a class qualified name. */
const metaProduces = (r: ExtractResult, q: string): string[] => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return (n?.meta?.produces as string[] | undefined) ?? [];
};

/** `meta.injects` for a class qualified name. */
const metaInjects = (r: ExtractResult, q: string): string[] => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return (n?.meta?.injects as string[] | undefined) ?? [];
};

/** `QualifiedName:stereotype:framework` for every class symbol (none if absent), sorted. */
const stereotypes = (r: ExtractResult): string[] =>
  r.nodes
    .filter((n) => n.kind === 'symbol' && n.type === 'class')
    .map((n) => `${n.qualifiedName}:${n.stereotype ?? 'none'}:${n.framework ?? 'none'}`)
    .sort();

/** the `meta.column` of a field node by qualified name, or undefined. (The property `symbol` node
 *  shares the qualified name but carries no column meta — filter to kind:'field'.) */
const columnMeta = (r: ExtractResult, q: string): Record<string, unknown> | undefined =>
  r.nodes.find((n) => n.kind === 'field' && n.qualifiedName === q)?.meta?.column as
    | Record<string, unknown>
    | undefined;

/** the `meta.security` of a node by qualified name, or undefined. */
const security = (r: ExtractResult, q: string): Record<string, string> | undefined =>
  r.nodes.find((n) => n.qualifiedName === q)?.meta?.security as Record<string, string> | undefined;

/** the `meta.params` of a route node by `METHOD /path`, or undefined. */
const routeParams = (
  r: ExtractResult,
  name: string,
): Array<{ name: string; type?: string; in: string }> | undefined =>
  r.nodes.find((n) => n.kind === 'route' && n.name === name)?.meta?.params as
    | Array<{ name: string; type?: string; in: string }>
    | undefined;

describe('NestJS stereotypes', () => {
  it('tags every class-level role with framework + stereotype', async () => {
    const src = [
      '@Controller() class C {}',
      '@Injectable() class S {}',
      '@Module({}) class M {}',
      '@Entity() class E {}',
      'class Plain {}',
    ].join('\n');
    const r = await run(src);
    expect(stereotypes(r)).toEqual([
      'C:controller:nestjs',
      'E:entity:typeorm',
      'M:module:nestjs',
      'Plain:none:none',
      'S:service:nestjs',
    ]);
  });
});

describe('NestJS routes', () => {
  it('composes controller base path + method mapping and exposes handler→route', async () => {
    const src = [
      "@Controller('/api')",
      'class C {',
      "  @Get('/health')",
      '  health() {}',
      "  @Post('items')",
      '  create() {}',
      '  @Get()',
      '  root() {}',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual(['GET /api', 'GET /api/health', 'POST /api/items']);
    expect(exposes(r)).toEqual([
      'C.create -> POST /api/items',
      'C.health -> GET /api/health',
      'C.root -> GET /api',
    ]);
  });

  it('emits one route per path in a multi-path mapping', async () => {
    const src = ['@Controller()', 'class C {', "  @Get('/a', '/b')", '  both() {}', '}'].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual(['GET /a', 'GET /b']);
  });

  it('records route-param contract on the route node meta', async () => {
    const src = [
      "@Controller('/api')",
      'class C {',
      "  @Get(':id')",
      '  one(@Param() id: string, @Query() q: string, @Body() b: any) {}',
      '}',
    ].join('\n');
    const r = await run(src);
    const params = routeParams(r, 'GET /api/:id');
    expect(params?.map((p) => `${p.name}:${p.in}`)).toEqual(['id:path', 'q:query', 'b:body']);
  });
});

describe('NestJS DI', () => {
  it('derives injects from implicit constructor injection (intra-file resolved)', async () => {
    const src = [
      '@Injectable() class Db {}',
      '@Injectable() class Logger {}',
      '@Controller() class C {',
      '  constructor(private db: Db, private log: Logger) {}',
      '}',
    ].join('\n');
    const r = await run(src);
    expect(injects(r).sort()).toEqual(['C -> Db', 'C -> Logger']);
    expect(metaInjects(r, 'C').sort()).toEqual(['Db', 'Logger']);
  });

  it('resolves @Inject(token) override and records cross-file deps honestly on meta', async () => {
    const src = [
      '@Injectable() class Local {}',
      '@Controller() class C {',
      "  constructor(@Inject('REMOTE') r: any, local: Local) {}",
      '}',
    ].join('\n');
    const r = await run(src);
    // intra-file Local resolves; 'REMOTE' is a DI token (no symbol) → recorded only on meta.
    expect(injects(r)).toEqual(['C -> Local']);
    expect(metaInjects(r, 'C').sort()).toEqual(['Local', 'REMOTE']);
  });

  it('is a no-op for a non-NestJS class (no stereotype → no injects)', async () => {
    const src = ['class Plain {', '  constructor(d: Db) {}', '}', 'class Db {}'].join('\n');
    const r = await run(src);
    expect(injects(r)).toEqual([]);
  });
});

describe('NestJS @Module producers', () => {
  it('emits produces edges module → provider and records meta.produces', async () => {
    const src = [
      '@Injectable() class Foo {}',
      '@Injectable() class Bar {}',
      '@Module({ providers: [Foo, Bar] })',
      'class M {}',
    ].join('\n');
    const r = await run(src);
    expect(produces(r).sort()).toEqual(['M -> Bar', 'M -> Foo']);
    expect(metaProduces(r, 'M').sort()).toEqual(['Bar', 'Foo']);
  });

  it('captures { provide: Token } factory providers', async () => {
    const src = [
      "@Module({ providers: [{ provide: 'CONFIG', useFactory: () => 1 }] })",
      'class M {}',
    ].join('\n');
    const r = await run(src);
    expect(metaProduces(r, 'M')).toEqual(['CONFIG']);
  });
});

describe('TypeORM entity relations + columns', () => {
  it('emits field nodes + references edges for @ManyToOne/@OneToMany (element type unwrapped)', async () => {
    const src = [
      '@Entity() class Loan {}',
      '@Entity() class Payment {',
      '  @ManyToOne(() => Loan, l => l.payments) loan: Loan;',
      '  @OneToMany(() => Payment, p => p.loan) items: Payment[];',
      '}',
    ].join('\n');
    const r = await run(src);
    // Payment.loan → Loan (ManyToOne); Payment.items → Payment (self-ref, element unwrapped from []).
    expect(references(r).sort()).toEqual(['Payment.items -> Payment', 'Payment.loan -> Loan']);
  });

  it('stamps meta.column for @PrimaryGeneratedColumn / @Column / @JoinColumn', async () => {
    const src = [
      '@Entity() class Customer {',
      "  @PrimaryGeneratedColumn('uuid') id: string;",
      "  @Column({ name: 'full_name', type: 'varchar', nullable: true, length: 120 })",
      '  fullName: string;',
      "  @JoinColumn({ name: 'org_id' }) org: Org;",
      '}',
      '@Entity() class Org {}',
    ].join('\n');
    const r = await run(src);
    expect(columnMeta(r, 'Customer.id')).toMatchObject({ id: true, generated: 'uuid' });
    expect(columnMeta(r, 'Customer.fullName')).toMatchObject({
      name: 'full_name',
      type: 'varchar',
      nullable: 'true',
      length: '120',
    });
    expect(columnMeta(r, 'Customer.org')).toMatchObject({ joinColumn: 'org_id' });
  });
});

describe('NestJS exception filters + security', () => {
  it('models @Catch filter as an exception-handler node + handles edge', async () => {
    const src = [
      'class BadException {}',
      '@Catch(BadException)',
      '@Injectable()',
      'class AllExceptionsFilter {',
      '  catch(exception: any) {}',
      '}',
    ].join('\n');
    const r = await run(src);
    const exc = r.nodes.find((n) => n.kind === 'exception-handler');
    expect(exc).toBeDefined();
    expect(exc?.whenSelector).toBe('BadException');
    expect(exc?.framework).toBe('nestjs');
    const handles = r.edges.filter((e) => e.rel === 'handles');
    expect(handles.length).toBe(1);
    expect(handles[0]?.src).toBe(exc?.id);
  });

  it('stamps meta.security for @UseGuards / @Roles on a handler route', async () => {
    const src = [
      'class JwtAuthGuard {}',
      "@Controller('/api')",
      'class C {',
      '  @UseGuards(JwtAuthGuard)',
      "  @Roles('admin')",
      "  @Get('/x')",
      '  x() {}',
      '}',
    ].join('\n');
    const r = await run(src);
    const sec = security(r, 'C.x');
    expect(sec?.UseGuards).toBe('JwtAuthGuard');
    expect(sec?.Roles).toBe('admin');
  });
});
