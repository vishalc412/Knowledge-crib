/**
 * Spring framework-semantics (schema 1.3) — dedicated coverage of {@link extractSpringSemantics}
 * driven through the {@link JavaExtractor} end-to-end (Pass 4). The four artifacts that put a Java
 * graph "above SQL" — stereotypes, HTTP routes (+ exposes), the DI graph (injects), and JPA entity
 * relations (references) — each exercised for the happy path, the edge shapes, and the no-op gates
 * (non-bean classes carry no Spring semantics). Inline source keeps these fast + deterministic.
 */
import { readFileSync } from 'node:fs';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, Node, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { JavaExtractor } from './JavaExtractor.js';

const PATH = 'Spring.java';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — Java is hand-rolled');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(src: string): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'java', bytes: src.length, mtime: 0 };
  return new JavaExtractor().extract(meta, ctxFor(src));
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

/** all `injects` edges: consumer qualified name → dependency qualified name, sorted. */
const injects = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'injects')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** all `references` edges (JPA): field qualified name → related type, sorted. */
const references = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'references')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** all `produces` edges: @Bean method → produced type, sorted. */
const produces = (r: ExtractResult): string[] => {
  const lbl = label(r);
  return r.edges
    .filter((e) => e.rel === 'produces')
    .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
    .sort();
};

/** `meta.produces` for a method qualified name. */
const metaProduces = (r: ExtractResult, q: string): string[] => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return (n?.meta?.produces as string[] | undefined) ?? [];
};

/** `QualifiedName:stereotype` for every class symbol (stereotype 'none' if absent), sorted. */
const stereotypes = (r: ExtractResult): string[] =>
  r.nodes
    .filter((n) => n.kind === 'symbol' && n.type === 'class')
    .map((n) => `${n.qualifiedName}:${n.stereotype ?? 'none'}:${n.framework ?? 'none'}`)
    .sort();

const metaInjects = (r: ExtractResult, q: string): string[] => {
  const n = r.nodes.find((x) => x.qualifiedName === q);
  return (n?.meta?.injects as string[] | undefined) ?? [];
};

describe('Spring stereotypes', () => {
  it('tags every class-level role with framework:spring + stereotype', async () => {
    const src = [
      '@RestController class C {}',
      '@Service class S {}',
      '@Repository class R {}',
      '@Component class K {}',
      '@Configuration class G {}',
      '@ControllerAdvice class A {}',
      '@Entity class E {}',
      '@Embeddable class D {}',
      'class Plain {}',
    ].join('\n');
    const r = await run(src);
    expect(stereotypes(r)).toEqual([
      'A:controller:spring',
      'C:controller:spring',
      'D:entity:spring',
      'E:entity:spring',
      'G:config:spring',
      'K:component:spring',
      'Plain:none:none',
      'R:repository:spring',
      'S:service:spring',
    ]);
  });
});

describe('Spring routes — the API surface', () => {
  it('composes the class base path with each method sub-path', async () => {
    const r = await run(
      [
        '@RestController',
        '@RequestMapping("/api")',
        'class Loans {',
        '  @GetMapping("/loans") String list() { return ""; }',
        '  @PostMapping("/loans") String create() { return ""; }',
        '}',
      ].join('\n'),
    );
    expect(routes(r)).toEqual(['GET /api/loans', 'POST /api/loans']);
    expect(exposes(r)).toEqual(['Loans.create -> POST /api/loans', 'Loans.list -> GET /api/loans']);
  });

  it('derives all five verbs + @RequestMapping method pinning', async () => {
    const r = await run(
      [
        '@RestController',
        'class Api {',
        '  @GetMapping("/g") void g() {}',
        '  @PostMapping("/p") void p() {}',
        '  @PutMapping("/u") void u() {}',
        '  @DeleteMapping("/d") void d() {}',
        '  @PatchMapping("/pa") void pa() {}',
        '  @RequestMapping(value="/x", method=RequestMethod.POST) void x() {}',
        '  @RequestMapping(method=RequestMethod.GET) void any() {}',
        '}',
      ].join('\n'),
    );
    // a pathless mapping (`@RequestMapping(method=RequestMethod.GET) void any()`) maps to the base
    // path — Spring does NOT derive a sub-path from the method name (see the "/" case below); so the
    // pathless `any` handler resolves to `/`, not `/any`.
    expect(routes(r)).toEqual([
      'DELETE /d',
      'GET /',
      'GET /g',
      'PATCH /pa',
      'POST /p',
      'POST /x',
      'PUT /u',
    ]);
  });

  it('normalizes paths: leading slash added, trailing/blank segments collapsed', async () => {
    const r = await run(
      [
        '@RestController',
        '@RequestMapping("api//auth/")',
        'class Auth {',
        '  @GetMapping("login") void login() {}',
        '  @GetMapping void root() {}',
        '}',
      ].join('\n'),
    );
    expect(routes(r)).toEqual(['GET /api/auth', 'GET /api/auth/login']);
  });

  it('preserves path variables and yields "/" when no path is given at all', async () => {
    const r = await run(
      [
        '@RestController',
        'class Root {',
        '  @GetMapping("/{id}") void one() {}',
        '  @GetMapping void home() {}',
        '}',
      ].join('\n'),
    );
    expect(routes(r)).toEqual(['GET /', 'GET /{id}']);
  });

  it('ignores method-mapping annotations on a non-controller bean', async () => {
    const r = await run(
      ['@Service', 'class Svc {', '  @GetMapping("/nope") void g() {}', '}'].join('\n'),
    );
    expect(routes(r)).toEqual([]);
    expect(exposes(r)).toEqual([]);
  });
});

describe('Spring DI graph', () => {
  it('emits injects for constructor params (implicit autowire) — intra-file resolved', async () => {
    const r = await run(
      [
        '@Service',
        'class A {',
        '  private final B b;',
        '  A(B b) { this.b = b; }',
        '}',
        'class B {}',
      ].join('\n'),
    );
    expect(injects(r)).toEqual(['A -> B']);
    expect(metaInjects(r, 'A')).toEqual(['B']);
  });

  it('records (but does not edge) a constructor dep type that is not intra-file', async () => {
    const r = await run(
      ['@Service', 'class A {', '  A(NotHere b) {}', '}', 'class B {}'].join('\n'),
    );
    expect(injects(r)).toEqual([]);
    expect(metaInjects(r, 'A')).toEqual(['NotHere']);
  });

  it('emits injects for @Autowired / @Inject / @Resource fields', async () => {
    const r = await run(
      [
        '@Service class A { @Autowired B b; }',
        '@Service class C { @Inject D d; }',
        '@Service class E { @Resource F f; }',
        'class B {}',
        'class D {}',
        'class F {}',
      ].join('\n'),
    );
    expect(injects(r)).toEqual(['A -> B', 'C -> D', 'E -> F']);
  });

  it('skips self-injection (no A -> A edge) yet records the dependency', async () => {
    const r = await run(['@Service', 'class A { @Autowired A self; }'].join('\n'));
    expect(injects(r)).toEqual([]);
    expect(metaInjects(r, 'A')).toEqual(['A']);
  });

  it('gates DI on the bean stereotype: a plain POJO with a ctor / @Autowired field gets NO injects', async () => {
    const r = await run(
      [
        'class Pojo {',
        '  private final B b;',
        '  Pojo(B b) {}',
        '  @Autowired C c;',
        '}',
        'class B {}',
        'class C {}',
      ].join('\n'),
    );
    expect(injects(r)).toEqual([]);
    expect(metaInjects(r, 'Pojo')).toEqual([]);
  });

  it('records every constructor dependency for a multi-param ctor (cross-file resolver picks them up)', async () => {
    const r = await run(
      [
        '@Service',
        'class A {',
        '  A(B b, C c, D d) {}',
        '}',
        'class B {}',
        'class C {}',
        'class D {}',
      ].join('\n'),
    );
    // B/C/D are all intra-file here → three injects edges; meta.injects lists all three types.
    expect(injects(r).sort()).toEqual(['A -> B', 'A -> C', 'A -> D']);
    expect(metaInjects(r, 'A').sort()).toEqual(['B', 'C', 'D']);
  });
});

describe('JPA entity relations', () => {
  it('emits references for @ManyToOne/@OneToMany/@ManyToMany/@OneToOne on @Entity fields', async () => {
    const r = await run(
      [
        '@Entity',
        'class Loan {',
        '  @ManyToOne private Applicant applicant;',
        '  @OneToMany private java.util.List<Payment> payments;',
        '  @ManyToMany private java.util.Set<Tag> tags;',
        '  @OneToOne private Audit audit;',
        '}',
        'class Applicant {}',
        'class Payment {}',
        'class Tag {}',
        'class Audit {}',
      ].join('\n'),
    );
    expect(references(r)).toEqual([
      'Loan.applicant -> Applicant',
      'Loan.audit -> Audit',
      'Loan.payments -> Payment',
      'Loan.tags -> Tag',
    ]);
  });

  it('gates JPA on @Entity: a @ManyToOne on a non-entity field emits no references', async () => {
    const r = await run(
      ['@Service', 'class Svc {', '  @ManyToOne private Other other;', '}', 'class Other {}'].join(
        '\n',
      ),
    );
    expect(references(r)).toEqual([]);
  });
});

describe('Spring DI graph — record compact ctor, multi-ctor, setter, annotated params', () => {
  it('emits injects for a record compact ctor (Spring implicit autowire of a single-ctor bean)', async () => {
    // Pre-fix the parser used parseParamList (names only) for the record header, so paramTypes was
    // empty and a `@Service record Tx(Repo r)` got ZERO injects. Now the record header is parsed
    // typed, and the record (no body ctor member) feeds its paramTypes straight to the DI loop.
    const r = await run(['@Service', 'record Tx(Repo r) {}', 'class Repo {}'].join('\n'));
    expect(injects(r)).toEqual(['Tx -> Repo']);
    expect(metaInjects(r, 'Tx')).toEqual(['Repo']);
  });

  it('picks the @Autowired ctor when a bean has multiple constructors', async () => {
    // Spring requires a multi-ctor bean to mark the autowired ctor with @Autowired. Pre-fix the DI
    // loop took `def.body.find(ctor)` — the FIRST ctor — so `@Autowired B(B b)` after a no-arg `B()`
    // injected nothing. Now the @Autowired ctor wins; a no-arg default ctor injects nothing.
    const r = await run(
      ['@Service', 'class B {', '  B() {}', '  @Autowired B(C c) {}', '}', 'class C {}'].join('\n'),
    );
    expect(injects(r)).toEqual(['B -> C']);
    expect(metaInjects(r, 'B')).toEqual(['C']);
  });

  it('skips ctor DI when a multi-ctor bean annotates NONE (Spring uses the no-arg default)', async () => {
    const r = await run(
      ['@Service', 'class B {', '  B() {}', '  B(C c) {}', '}', 'class C {}'].join('\n'),
    );
    expect(injects(r)).toEqual([]);
    // Spring would field-inject if asked; with no annotation + no field marker, ctor DI is absent.
  });

  it('emits injects for @Autowired single-param setter methods (setter injection)', async () => {
    const r = await run(
      [
        '@Service',
        'class B {',
        '  @Autowired void setRepo(Repo repo) {}',
        '}',
        'class Repo {}',
      ].join('\n'),
    );
    expect(injects(r)).toEqual(['B -> Repo']);
    expect(metaInjects(r, 'B')).toEqual(['Repo']);
  });

  it('captures the real type behind a parameter annotation (@RequestBody Loan loan → Loan)', async () => {
    // Pre-fix parseParamListTyped did not skip the annotation, so `@RequestBody Loan loan` mis-captured
    // the type as 'RequestBody'. Now the annotation is skipped and the DI type is 'Loan'.
    const r = await run(
      ['@Service', 'class A {', '  A(@RequestBody Loan loan) {}', '}', 'class Loan {}'].join('\n'),
    );
    expect(injects(r)).toEqual(['A -> Loan']);
    expect(metaInjects(r, 'A')).toEqual(['Loan']);
  });
});

describe('Spring routes — multi-path + multi-verb mappings', () => {
  it('emits one route per path in a multi-path mapping {"/a","/b"}', async () => {
    const r = await run(
      ['@RestController', 'class Api {', '  @GetMapping({"/a","/b"}) void g() {}', '}'].join('\n'),
    );
    expect(routes(r).sort()).toEqual(['GET /a', 'GET /b']);
    expect(exposes(r).sort()).toEqual(['Api.g -> GET /a', 'Api.g -> GET /b']);
  });

  it('emits one route per verb in @RequestMapping(method={GET,POST})', async () => {
    const r = await run(
      [
        '@RestController',
        'class Api {',
        '  @RequestMapping(value="/x", method={RequestMethod.GET, RequestMethod.POST}) void x() {}',
        '}',
      ].join('\n'),
    );
    expect(routes(r).sort()).toEqual(['GET /x', 'POST /x']);
  });
});

describe('Spring @Bean producer graph', () => {
  it('emits produces for @Bean methods in a @Configuration class (intra-file resolved)', async () => {
    const r = await run(
      [
        '@Configuration',
        'class Cfg {',
        '  @Bean Payment payment() { return null; }',
        '  @Bean List<Payment> payments() { return null; }',
        '}',
        'class Payment {}',
      ].join('\n'),
    );
    // `@Bean Payment payment()` → produces Payment (the return type head). A collection-returning
    // bean (`List<Payment> payments()`) produces the ELEMENT type Payment, not the collection head.
    expect(produces(r)).toEqual(['Cfg.payment -> Payment', 'Cfg.payments -> Payment']);
    expect(metaProduces(r, 'Cfg.payment').sort()).toEqual(['Payment']);
  });

  it('records (but does not edge) a @Bean return type that is not intra-file', async () => {
    const r = await run(
      ['@Configuration', 'class Cfg {', '  @Bean Missing bean() { return null; }', '}'].join('\n'),
    );
    expect(produces(r)).toEqual([]);
    expect(metaProduces(r, 'Cfg.bean')).toEqual(['Missing']);
  });

  it('gates @Bean on @Configuration: a @Bean method in a non-config class emits no produces', async () => {
    // @Bean in a @Component (lite mode) is technically supported by Spring, but the canonical, no-
    // ambiguity producer is @Configuration; we model only that to keep the producer graph honest.
    const r = await run(
      [
        '@Component',
        'class C {',
        '  @Bean Payment payment() { return null; }',
        '}',
        'class Payment {}',
      ].join('\n'),
    );
    expect(produces(r)).toEqual([]);
  });
});

describe('Spring framework-semantics depth (schema 1.3)', () => {
  /** a class symbol's stereotype + framework. */
  const stereo = (r: ExtractResult, q: string): string | undefined =>
    r.nodes.find((n) => n.qualifiedName === q)?.stereotype;

  /** the first route node matching a `METHOD /path` string. */
  const route = (r: ExtractResult, name: string): Node | undefined =>
    r.nodes.find((n) => n.kind === 'route' && n.name === name);

  /** the field node for a qualified name. */
  const field = (r: ExtractResult, q: string): Node | undefined =>
    r.nodes.find((n) => n.kind === 'field' && n.qualifiedName === q);

  /** the method symbol node for a qualified name. */
  const method = (r: ExtractResult, q: string): Node | undefined =>
    r.nodes.find((n) => n.qualifiedName === q);

  it('tags a Spring Data repository interface (extends JpaRepository) as repository w/o @Repository', async () => {
    const r = await run(
      [
        'interface LoanRepo extends JpaRepository<Loan, Long> {',
        '  Loan findById(long id);',
        '}',
        'class Loan {}',
      ].join('\n'),
    );
    expect(stereo(r, 'LoanRepo')).toBe('repository');
    expect(method(r, 'LoanRepo')?.framework).toBe('spring');
  });

  it('captures the route-param contract (path/query/body) on the route node meta', async () => {
    const r = await run(
      [
        '@RestController',
        '@RequestMapping("/loans")',
        'class C {',
        '  @PostMapping void create(@RequestBody Loan loan, @PathVariable String id, @RequestParam String q) {}',
        '}',
        'class Loan {}',
      ].join('\n'),
    );
    const rt = route(r, 'POST /loans');
    expect(rt).toBeDefined();
    const params = rt?.meta?.params as Array<{ name: string; type?: string; in: string }>;
    expect(params?.map((p) => `${p.in}:${p.name}:${p.type ?? ''}`).sort()).toEqual([
      'body:loan:Loan',
      'path:id:String',
      'query:q:String',
    ]);
  });

  it('stamps security annotations (@PreAuthorize) on the route + method meta', async () => {
    const r = await run(
      [
        '@RestController',
        'class C {',
        '  @GetMapping("/a") @PreAuthorize("hasRole(\'ADMIN\')") void a() {}',
        '}',
      ].join('\n'),
    );
    const rt = route(r, 'GET /a');
    expect(rt?.meta?.security).toEqual({ PreAuthorize: "hasRole('ADMIN')" });
    expect(method(r, 'C.a')?.meta?.security).toEqual({ PreAuthorize: "hasRole('ADMIN')" });
  });

  it('stamps @Transactional / @Scheduled on the method meta', async () => {
    const r = await run(
      [
        '@Service',
        'class S {',
        '  @Transactional void tx() {}',
        '  @Scheduled(cron = "0 0 * * *") void tick() {}',
        '}',
      ].join('\n'),
    );
    expect(method(r, 'S.tx')?.meta?.transactional).toBe(true);
    expect(method(r, 'S.tick')?.meta?.scheduled).toBe('cron');
  });

  it('stamps Spring Data @Query methods (jpql + native flag) + @Modifying on the method meta', async () => {
    const r = await run(
      [
        'interface LoanRepo extends JpaRepository<Loan, Long> {',
        '  @Query("SELECT l FROM Loan l WHERE l.status = :s") List<Loan> byStatus(String s);',
        '  @Modifying @Query("UPDATE Loan l SET l.status = :s") int setAll(String s);',
        '}',
        'class Loan {}',
      ].join('\n'),
    );
    const q1 = method(r, 'LoanRepo.byStatus')?.meta?.query as { jpql: string; native: boolean };
    expect(q1.jpql).toBe('SELECT l FROM Loan l WHERE l.status = :s');
    expect(q1.native).toBe(false);
    expect(method(r, 'LoanRepo.setAll')?.meta?.modifying).toBe(true);
  });

  it('stamps entity column metadata (@Id/@Column/@GeneratedValue/@JoinColumn) on the field meta', async () => {
    const r = await run(
      [
        '@Entity',
        'class Loan {',
        '  @Id @GeneratedValue(strategy = GenerationType.IDENTITY) Long id;',
        '  @Column(name = "cust_name", nullable = false, length = 100) String name;',
        '  @ManyToOne @JoinColumn(name = "applicant_id") Applicant applicant;',
        '}',
        'class Applicant {}',
      ].join('\n'),
    );
    expect(field(r, 'Loan.id')?.meta?.column).toMatchObject({
      id: true,
      generated: 'GenerationType.IDENTITY',
    });
    expect(field(r, 'Loan.name')?.meta?.column).toMatchObject({
      name: 'cust_name',
      nullable: 'false',
      length: '100',
    });
    expect(field(r, 'Loan.applicant')?.meta?.column).toEqual({ joinColumn: 'applicant_id' });
  });

  it('carries JPA relation cardinality attributes (cascade/fetch/mappedBy) on the references edge meta', async () => {
    const r = await run(
      [
        '@Entity',
        'class Loan {',
        '  @ManyToOne(fetch = FetchType.LAZY, cascade = CascadeType.ALL) Applicant applicant;',
        '  @OneToMany(mappedBy = "loan", cascade = {CascadeType.PERSIST, CascadeType.MERGE}) List<Payment> payments;',
        '}',
        'class Applicant {}',
        'class Payment {}',
      ].join('\n'),
    );
    const refApplicant = r.edges.find(
      (e) => e.rel === 'references' && label(r)(e.src) === 'Loan.applicant',
    );
    // cardinality = the relation annotation name (the multiplicity), pinned so future drift is caught.
    expect(refApplicant?.meta).toMatchObject({
      cardinality: 'ManyToOne',
      fetch: 'FetchType.LAZY',
      cascade: 'CascadeType.ALL',
    });
    const refPayments = r.edges.find(
      (e) => e.rel === 'references' && label(r)(e.src) === 'Loan.payments',
    );
    // cascade value is captured verbatim from the annotation (whitespace preserved).
    expect(refPayments?.meta).toMatchObject({
      cardinality: 'OneToMany',
      mappedBy: 'loan',
      cascade: '{CascadeType.PERSIST, CascadeType.MERGE}',
    });
  });

  it('models @ExceptionHandler in a @ControllerAdvice as an exception-handler node + handles edge', async () => {
    const r = await run(
      [
        '@ControllerAdvice',
        'class Adv {',
        '  @ExceptionHandler({SQLException.class, IOException.class}) String handle(Exception e) { return ""; }',
        '}',
      ].join('\n'),
    );
    const exc = r.nodes.find((n) => n.kind === 'exception-handler');
    expect(exc).toBeDefined();
    expect(exc?.whenSelector).toBe('SQLException|IOException');
    expect(exc?.framework).toBe('spring');
    // handles: exception-handler → the handler method symbol.
    const handles = r.edges.filter((e) => e.rel === 'handles');
    expect(handles.length).toBe(1);
    expect(label(r)(handles[0]!.dst)).toBe('Adv.handle');
  });
});

describe('non-Spring code is a no-op for framework semantics', () => {
  it('a plain Java class yields zero stereotypes/routes/injects/references/exposes', async () => {
    const src = readFileSync(
      // a deliberately framework-free slice of the golden fixture, reasserted at the rel level.
      new URL('../../fixtures/java/Behavior.java', import.meta.url),
      'utf8',
    );
    const r = await run(src);
    const rels = new Set(r.edges.map((e) => e.rel));
    expect(rels.has('exposes')).toBe(false);
    expect(rels.has('injects')).toBe(false);
    expect(rels.has('references')).toBe(false);
    expect(r.nodes.filter((n) => n.kind === 'route')).toEqual([]);
    expect(r.nodes.every((n) => n.stereotype === undefined && n.framework === undefined)).toBe(
      true,
    );
  });
});
