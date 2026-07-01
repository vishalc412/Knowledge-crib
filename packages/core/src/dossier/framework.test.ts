/**
 * Framework-semantics surfacing (schema 1.3) — unit tests for {@link frameworkSemantics} + its
 * wiring into {@link buildDossier} (the lean method subset + shapeVersion) + the serializer's
 * Framework sections + the {@link readDossier} shape-staleness gate. The Spring model built here is
 * the ground truth the Node/React/Angular tracks will reuse (same kinds/rels, same shape).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from '../manifest.js';
import { SoulStore } from '../soul-store.js';
import { DOSSIER_SHAPE_VERSION, frameworkSemantics } from './framework.js';
import { buildDossier, dossierToMarkdown, readDossier, writeDossier } from './index.js';
import { dossierPath } from './persist.js';

// --- node builders ---------------------------------------------------------
const FILE = 'src/com/acme/Loan.java';
function cls(q: string, line: number, stereotype: string, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path: FILE, qualifiedName: q, startLine: line }),
    kind: 'symbol',
    type: 'class',
    name: q.split('.').pop() ?? q,
    qualifiedName: q,
    file: FILE,
    span: { start: line, end: line + 20 },
    lang: 'java',
    stereotype,
    framework: 'spring',
    hash: contentHash(q),
    ...extra,
  };
}
function method(q: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path: FILE, qualifiedName: q, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: q.split('.').pop() ?? q,
    qualifiedName: q,
    file: FILE,
    span: { start: line, end: line + 5 },
    lang: 'java',
    framework: 'spring',
    hash: contentHash(q),
    ...extra,
  };
}
function fieldNode(q: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'field', path: FILE, qualifiedName: q, startLine: line }),
    kind: 'field',
    name: q.split('.').pop() ?? q,
    qualifiedName: q,
    file: FILE,
    span: { start: line, end: line },
    lang: 'java',
    hash: contentHash(q),
    ...extra,
  };
}
function routeNode(
  verb: string,
  path: string,
  line: number,
  meta: Record<string, unknown> = {},
): Node {
  return {
    id: idFor({ kind: 'route', httpMethod: verb, routePath: path, file: FILE, line }),
    kind: 'route',
    name: `${verb} ${path}`,
    httpMethod: verb,
    routePath: path,
    framework: 'spring',
    file: FILE,
    span: { start: line, end: line },
    lang: 'java',
    ...(Object.keys(meta).length ? { meta } : {}),
    hash: contentHash(`route:${verb}:${path}`),
  };
}
function edge(src: string, dst: string, rel: Rel, over: Partial<Edge> = {}): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    ...over,
  };
}

const NOW = '2026-01-01T00:00:00.000Z';
let repo: string;
let crib: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'fw-repo-'));
  crib = mkdtempSync(join(tmpdir(), 'fw-crib-'));
  mkdirSync(join(repo, 'src', 'com', 'acme'), { recursive: true });
  writeFileSync(join(repo, FILE), `${'\n'.repeat(4)}class Loan {}\n`);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

function freshSoul(): SoulStore {
  const s = new SoulStore(crib, { manifest: newManifest({ now: NOW, root: repo }) });
  s.load();
  return s;
}

/** The canonical Spring model: controller + service + @Configuration + @Entity with relations. */
interface SpringModel {
  soul: SoulStore;
  ids: {
    controller: Node;
    apply: Node;
    route: Node;
    service: Node;
    evaluate: Node;
    repoIface: Node;
    config: Node;
    bean: Node;
    entity: Node;
    applicantField: Node;
    paymentsField: Node;
  };
}
function springModel(): SpringModel {
  const soul = freshSoul();
  const controller = cls('com.acme.LoanController', 1, 'controller', {
    meta: { injects: ['com.acme.LoanService'] },
  });
  const apply = method('com.acme.LoanController.apply', 5, {
    meta: { security: { PreAuthorize: "hasRole('LENDER')" } },
  });
  const route = routeNode('POST', '/api/loans', 5, {
    params: [{ name: 'loan', type: 'Loan', in: 'body' }],
    security: { PreAuthorize: "hasRole('LENDER')" },
  });

  const service = cls('com.acme.LoanService', 30, 'service', {
    meta: { injects: ['com.acme.LoanRepository'] },
  });
  const evaluate = method('com.acme.LoanService.evaluate', 33);

  const repoIface = cls('com.acme.LoanRepository', 50, 'repository');
  const config = cls('com.acme.LoanRepositoryConfig', 60, 'config');
  const bean = method('com.acme.LoanRepositoryConfig.loanRepository', 62, {
    meta: { returnType: 'LoanRepository' },
  });

  const entity = cls('com.acme.Loan', 80, 'entity');
  const applicantField = fieldNode('com.acme.Loan.applicant', 82, {
    meta: { column: { joinColumn: 'applicant_id' } },
  });
  const paymentsField = fieldNode('com.acme.Loan.payments', 83);

  soul.putNodes([
    controller,
    apply,
    route,
    service,
    evaluate,
    repoIface,
    config,
    bean,
    entity,
    applicantField,
    paymentsField,
  ]);
  soul.putEdges([
    edge(apply.id, controller.id, 'member-of'),
    edge(evaluate.id, service.id, 'member-of'),
    edge(bean.id, config.id, 'member-of'),
    edge(applicantField.id, entity.id, 'member-of'),
    edge(paymentsField.id, entity.id, 'member-of'),
    // controller exposes route via its handler method
    edge(apply.id, route.id, 'exposes', { evidence: { snippet: 'POST /api/loans' } }),
    // DI: controller → service → repository
    edge(controller.id, service.id, 'injects', { evidence: { snippet: 'com.acme.LoanService' } }),
    edge(service.id, repoIface.id, 'injects', { evidence: { snippet: 'com.acme.LoanRepository' } }),
    // @Bean produces: the bean method → repository type
    edge(bean.id, repoIface.id, 'produces', { evidence: { snippet: 'LoanRepository' } }),
    // JPA relations: entity fields → related types (with cardinality + attrs)
    edge(applicantField.id, cls('com.acme.Applicant', 90, 'entity').id, 'references', {
      evidence: { snippet: 'Applicant' },
      meta: { cardinality: 'ManyToOne', fetch: 'FetchType.LAZY' },
    }),
    edge(paymentsField.id, cls('com.acme.Payment', 95, 'entity').id, 'references', {
      evidence: { snippet: 'Payment' },
      meta: { cardinality: 'OneToMany', mappedBy: 'loan', cascade: '{CascadeType.PERSIST}' },
    }),
  ]);
  // the related entity classes need to exist in the soul for their ids to resolve
  soul.putNodes([cls('com.acme.Applicant', 90, 'entity'), cls('com.acme.Payment', 95, 'entity')]);
  soul.commit(NOW);
  return {
    soul,
    ids: {
      controller,
      apply,
      route,
      service,
      evaluate,
      repoIface,
      config,
      bean,
      entity,
      applicantField,
      paymentsField,
    },
  };
}

describe('frameworkSemantics — class scope (member-of aggregation)', () => {
  it('aggregates the controller route table with the owning handler', () => {
    const { soul, ids } = springModel();
    const fw = frameworkSemantics(soul, ids.controller.id)!;
    expect(fw).toBeDefined();
    expect(fw.routes).toHaveLength(1);
    const r = fw.routes![0]!;
    expect(r.httpMethod).toBe('POST');
    expect(r.routePath).toBe('/api/loans');
    expect(r.params?.[0]).toMatchObject({ name: 'loan', type: 'Loan', in: 'body' });
    expect(r.security).toEqual({ PreAuthorize: "hasRole('LENDER')" });
    // class aggregation tags the owning handler; method scope omits it.
    expect(r.handler).toBeDefined();
    expect(r.handler?.qualifiedName).toBe('com.acme.LoanController.apply');
  });

  it('surfaces the DI graph as dependencies + reverse-injects as dependents', () => {
    const { soul, ids } = springModel();
    const fw = frameworkSemantics(soul, ids.controller.id)!;
    // controller injects LoanService
    expect(fw.dependencies).toHaveLength(1);
    expect(fw.dependencies![0]!.brief.qualifiedName).toBe('com.acme.LoanService');
    expect(fw.dependencies![0]!.kind).toBe('injects');
    // nobody injects the controller → dependents empty
    expect(fw.dependents ?? []).toHaveLength(0);

    // for the service: it injects the repository (a @Bean-produced type → kind='produces' + producer)
    const sfw = frameworkSemantics(soul, ids.service.id)!;
    expect(sfw.dependencies).toHaveLength(1);
    const dep = sfw.dependencies![0]!;
    expect(dep.brief.qualifiedName).toBe('com.acme.LoanRepository');
    expect(dep.kind).toBe('produces'); // supply chain in one read
    expect(dep.producer).toBeDefined();
    expect(dep.producer?.qualifiedName).toBe('com.acme.LoanRepositoryConfig.loanRepository');
    // the controller injects the service → service has a dependent
    expect(sfw.dependents).toHaveLength(1);
    expect(sfw.dependents![0]!.brief.qualifiedName).toBe('com.acme.LoanController');
  });

  it('aggregates the @Entity relation model with cardinality + cascade/fetch/mappedBy verbatim', () => {
    const { soul, ids } = springModel();
    const fw = frameworkSemantics(soul, ids.entity.id)!;
    expect(fw.relations).toHaveLength(2);
    const applicant = fw.relations!.find((r) => r.field === 'applicant')!;
    expect(applicant.cardinality).toBe('ManyToOne');
    expect(applicant.fetch).toBe('FetchType.LAZY');
    expect(applicant.brief.qualifiedName).toBe('com.acme.Applicant');
    const payments = fw.relations!.find((r) => r.field === 'payments')!;
    expect(payments.cardinality).toBe('OneToMany');
    expect(payments.mappedBy).toBe('loan');
    expect(payments.cascade).toBe('{CascadeType.PERSIST}'); // verbatim, whitespace preserved
  });

  it('aggregates the @Configuration bean inventory with the producing method', () => {
    const { soul, ids } = springModel();
    const fw = frameworkSemantics(soul, ids.config.id)!;
    expect(fw.produces).toHaveLength(1);
    const p = fw.produces![0]!;
    expect(p.brief.qualifiedName).toBe('com.acme.LoanRepository');
    expect(p.producer?.qualifiedName).toBe('com.acme.LoanRepositoryConfig.loanRepository');
    expect(p.returnType).toBe('LoanRepository'); // returnType from the @Bean method's meta
  });
});

describe('frameworkSemantics — method scope (direct; lean vs full)', () => {
  it('lean: true → only the routes/produces the callable OWNS (the persisted-dossier subset)', () => {
    const { soul, ids } = springModel();
    const fw = frameworkSemantics(soul, ids.apply.id, { lean: true })!;
    expect(fw.routes).toHaveLength(1);
    expect(fw.routes![0]!.handler).toBeUndefined(); // method scope: handler OMITTED (node IS handler)
    expect(fw.produces ?? []).toHaveLength(0);
    expect(fw.dependencies).toBeUndefined(); // lean → no deps
    expect(fw.dependents).toBeUndefined();
  });

  it('lean: false → dependencies lifted from the owning class + dependents on produced types', () => {
    const { soul, ids } = springModel();
    const fw = frameworkSemantics(soul, ids.apply.id, { lean: false })!;
    expect(fw.routes).toHaveLength(1);
    // the handler's parent class injects LoanService → method context surfaces it
    expect(fw.dependencies).toHaveLength(1);
    expect(fw.dependencies![0]!.brief.qualifiedName).toBe('com.acme.LoanService');
    // the @Bean method: produces the repository + its consumers surface as dependents
    const bfw = frameworkSemantics(soul, ids.bean.id, { lean: false })!;
    expect(bfw.produces).toHaveLength(1);
    expect(bfw.produces![0]!.producer).toBeUndefined(); // method scope: producer OMITTED
    expect(bfw.produces![0]!.returnType).toBe('LoanRepository');
    // the service injects the repository this bean produces → dependent
    expect(bfw.dependents?.some((d) => d.brief.qualifiedName === 'com.acme.LoanService')).toBe(
      true,
    );
  });
});

describe('frameworkSemantics — unresolved honesty', () => {
  it('surfaces a meta.injects type name with no emitted edge as an unresolved dependency', () => {
    const soul = freshSoul();
    const service = cls('com.acme.Svc', 1, 'service', {
      meta: { injects: ['com.acme.MissingBean'] },
    });
    soul.putNodes([service]);
    soul.commit(NOW);
    const fw = frameworkSemantics(soul, service.id)!;
    expect(fw.dependencies).toHaveLength(1);
    const dep = fw.dependencies![0]!;
    expect(dep.unresolved).toBe(true);
    expect(dep.id).toBe('?');
    expect(dep.brief.qualifiedName).toBe('com.acme.MissingBean');
    expect(dep.kind).toBe('injects');
  });

  it('returns undefined when the node has no framework edges (a non-Spring method)', () => {
    const soul = freshSoul();
    const plain = method('com.acme.Plain.work', 1);
    soul.putNodes([plain]);
    soul.commit(NOW);
    expect(frameworkSemantics(soul, plain.id)).toBeUndefined();
  });
});

describe('buildDossier wiring — lean framework + shapeVersion', () => {
  it('attaches the lean method framework (routes+produces) + shapeVersion to a handler dossier', () => {
    const { soul, ids } = springModel();
    const d = buildDossier(soul, repo, ids.apply.id, NOW)!;
    expect(d.shapeVersion).toBe(DOSSIER_SHAPE_VERSION);
    expect(d.framework).toBeDefined();
    expect(d.framework!.routes).toHaveLength(1);
    expect(d.framework!.routes![0]!.handler).toBeUndefined(); // lean method dossier
    expect(d.framework!.dependencies).toBeUndefined(); // lean → no deps in the persisted artifact
    // publicNode surfaces the handler's own 1.3 identity + meta (no-round-trip)
    expect(d.node.stereotype).toBeUndefined(); // apply is a method, no stereotype
    expect(d.node.httpMethod).toBeUndefined(); // httpMethod lives on the ROUTE node, not the method
  });

  it('dossierToMarkdown emits ## Routes + ## Produces sections with the route table', () => {
    const { soul, ids } = springModel();
    const d = buildDossier(soul, repo, ids.apply.id, NOW)!;
    const md = dossierToMarkdown(d);
    expect(md).toContain('## Routes');
    expect(md).toContain('| 1 | POST | /api/loans |');
    expect(md).toContain('loan:Loan@body'); // params column
    expect(md).toContain("PreAuthorize=hasRole('LENDER')"); // security column
    // header identity lines
    expect(md).toContain('- framework: spring');
  });
});

describe('readDossier — shapeVersion staleness gate', () => {
  it('treats a pre-2.0 dossier (shapeVersion undefined) as stale even when hash+schema match', () => {
    const { soul, ids } = springModel();
    const d = buildDossier(soul, repo, ids.apply.id, NOW)!;
    writeDossier(crib, d);
    // corrupt the on-disk artifact to simulate a pre-2.0 dossier: drop shapeVersion + framework.
    // (assigning undefined rather than `delete` — JSON.stringify omits undefined keys, so the
    // on-disk artifact ends up with neither field, exactly like a pre-2.0 dossier.)
    const path = dossierPath(crib, ids.apply.id);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    onDisk.shapeVersion = undefined;
    onDisk.framework = undefined;
    writeFile(path, `${JSON.stringify(onDisk, null, 2)}\n`);
    const read = readDossier(crib, ids.apply.id, {
      nodeHash: ids.apply.hash,
      schemaVersion: soul.getManifest().schemaVersion,
    });
    expect(read.missing).toBe(false);
    // hash + schema match, but shapeVersion is undefined (≠ DOSSIER_SHAPE_VERSION) → stale → rebuilt.
    expect(read.stale).toBe(true);
  });

  it('reports fresh when shapeVersion matches DOSSIER_SHAPE_VERSION', () => {
    const { soul, ids } = springModel();
    const d = buildDossier(soul, repo, ids.apply.id, NOW)!;
    writeDossier(crib, d);
    const read = readDossier(crib, ids.apply.id, {
      nodeHash: ids.apply.hash,
      schemaVersion: soul.getManifest().schemaVersion,
    });
    expect(read.stale).toBe(false);
  });
});
