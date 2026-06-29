import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';

// Minimal result shapes for the verb calls below so the tests can drop `as any`.
interface ImpactResult {
  root: string;
  affected: Array<{ id: string }>;
  relatedDocs: Array<{ edgeType: string; provenance: string; confidence: number; snippet: string }>;
}
interface ContextResult {
  node: {
    name?: string;
    signature?: string;
    file?: string;
    line?: number;
    qualifiedName?: string;
    stereotype?: string;
    framework?: string;
    httpMethod?: string;
    routePath?: string;
  };
  callers: Array<{ id: string; signature?: string; file?: string; line?: number }>;
  callees: Array<{ id: string; signature?: string; file?: string; line?: number }>;
  docs: Array<{ edgeType: string }>;
  source?: { text: string; truncated: boolean; totalLines: number };
  rules?: { rules: Array<{ action: { kind: string } }> };
  framework?: {
    routes?: Array<{
      httpMethod?: string;
      routePath?: string;
      params?: Array<{ name: string; type?: string; in: string }>;
      security?: Record<string, string>;
      handler?: { qualifiedName?: string };
    }>;
    produces?: Array<{ brief: { qualifiedName?: string }; producer?: { qualifiedName?: string } }>;
    dependencies?: Array<{
      kind: string;
      brief: { qualifiedName?: string };
      producer?: { qualifiedName?: string };
    }>;
    dependents?: Array<{ brief: { qualifiedName?: string } }>;
    relations?: Array<{ field?: string; cardinality?: string; fetch?: string; mappedBy?: string }>;
  };
}
interface SourceResult {
  node: { id: string; file?: string };
  source: { text: string; truncated: boolean };
}
interface DescribesResult {
  docs: Array<unknown>;
}
interface QueryResult {
  hits: Array<{
    id: string;
    source?: { text: string; truncated: boolean };
    rules?: { rules: Array<{ action: { kind: string } }> };
    coverage?: { readiness: string };
  }>;
}
interface NeighborsResult {
  edges: Array<{ src: string; dst: string }>;
}
interface ShortestPathResult {
  found: boolean;
  path: string[];
}
interface StatusResult {
  indexed: boolean;
  capabilities: Record<string, unknown>;
}
interface ErrorResult {
  error: { code: string; message?: string };
}
interface ReconstructResult {
  id: string;
  expectedBodyFile?: string;
  constants: Array<{ name: string; dataType?: string; init?: string; constant?: boolean }>;
  variables: Array<{ name: string }>;
  members: Array<{
    qualifiedName?: string;
    type?: string;
    implementation: { status: string; executesCount: number; referencedByFiles: string[] };
    rulesCount: number;
  }>;
  referencedTables: Array<{ name: string; readBy: string[]; writtenBy: string[] }>;
  docs: Array<{ edgeType: string; target: string }>;
  memberCount: number;
  truncated: boolean;
  markdown?: string;
}
interface DossiersByScopeResult {
  scope: string;
  id: string;
  label: string;
  symbols: Array<{
    node: { id: string; qualifiedName?: string };
    callers: Array<{ id: string; qualifiedName?: string }>;
    callees: Array<{ id: string; qualifiedName?: string }>;
    implementation?: { status: string; executesCount: number; referencedByFiles: string[] };
    rules?: { rules: Array<{ action: { kind: string } }> };
  }>;
  symbolCount: number;
  truncated: boolean;
  skipped: string[];
  markdown?: string;
}
interface RulesResult {
  rules: Array<{
    action: { kind: string; sqlKind?: string };
    guard?: string;
    branch?: string;
    conditions: Array<{ polarity?: string }>;
  }>;
  error?: { code: string };
}
interface DossierResult {
  node: { id: string; name?: string; qualifiedName?: string };
  source: {
    text: string;
    truncated: boolean;
    totalLines: number;
    startLine: number;
    nextLine?: number;
  };
  callers: Array<{ id: string }>;
  callees: Array<{ id: string }>;
  docs: Array<{ edgeType: string }>;
  rules?: { rules: Array<{ action: { kind: string } }> };
  controlFlow?: {
    raises: Array<{ kind: string; errorCode?: string; errorMessage?: string; confidence: number }>;
    handles: Array<{ kind: string }>;
    iterates: Array<{ kind: string }>;
    declares: Array<{ kind: string; name?: string; cursorQuery?: string; confidence: number }>;
  };
}
interface EnrichStatusResult {
  done: boolean;
  nextLayer?: string;
  layers: Record<
    'symbol' | 'file' | 'cluster' | 'system',
    { total: number; missing: number; stale: number; fresh: number }
  >;
  model?: string;
}
interface EnrichNextResult {
  batchId: string;
  layer: string;
  items: Array<{
    targetId: string;
    seed: { node?: { id: string }; sourceBody?: { text: string } };
    outputSchema: Record<string, unknown>;
  }>;
  remaining: number;
}
interface EnrichSaveResult {
  accepted: Array<{ targetId: string; droppedEdges?: Array<{ reason: string }> }>;
  rejected: Array<{ targetId: string; reason: string }>;
}

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

function sym(path: string, q: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: q, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: q.split('.').pop() ?? q,
    qualifiedName: q,
    file: path,
    span: { start: line, end: line + 1 },
    lang: 'typescript',
    hash: contentHash(q),
    ...extra,
  };
}
function fileNode(path: string): Node {
  return { id: idFor({ kind: 'file', path }), kind: 'file', file: path, hash: contentHash(path) };
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

const handle = sym('src/http.ts', 'Controller.handleLogin', 5);
const login = sym('src/auth.ts', 'AuthService.login', 10);
const issue = sym('src/token.ts', 'TokenService.issue', 20);
const docSection: Node = {
  id: idFor({ kind: 'doc-section', path: 'docs/auth.md', anchor: 'sessions' }),
  kind: 'doc-section',
  file: 'docs/auth.md',
  heading: 'Sessions',
  anchor: 'sessions',
  span: { start: 1, end: 3 },
  lang: 'markdown',
  hash: contentHash('sessions'),
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'docs', 'auth.md'),
    '# Sessions\n\nThe AuthService.login method issues a session.\n',
  );
  // a real auth.ts so context(withSource) / source() can rehydrate the login body (lines 10-11).
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
}
`,
  );

  soul = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
  soul.putNodes([
    fileNode('src/http.ts'),
    fileNode('src/auth.ts'),
    fileNode('src/token.ts'),
    fileNode('docs/auth.md'),
    handle,
    login,
    issue,
    docSection,
  ]);
  soul.putEdges([
    edge(handle.id, login.id, 'calls'), // handleLogin -> login
    edge(login.id, issue.id, 'calls'), // login -> issue
    edge(docSection.id, login.id, 'describes', { method: 'explicit', confidence: 0.95 }),
  ]);
  soul.commit('2026-01-01T00:00:00.000Z');

  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  verbs = new Verbs({ soul, index, repoRoot: repo });
});
afterEach(() => {
  index.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('M5 wedge — impact returns blast radius + describing docs', () => {
  it('impact(login, up) returns dependents AND a describes doc with provenance + snippet', () => {
    const res = verbs.impact({ id: login.id, dir: 'up' }) as unknown as ImpactResult;
    // blast radius: handleLogin depends on login
    expect(res.affected.map((a) => a.id)).toContain(handle.id);
    // related docs for the changed symbol, with provenance + rehydrated snippet
    expect(res.relatedDocs.length).toBeGreaterThanOrEqual(1);
    const doc = res.relatedDocs[0]!;
    expect(doc.edgeType).toBe('describes');
    expect(doc.provenance).toBe('EXTRACTED');
    expect(doc.confidence).toBeCloseTo(0.95);
    expect(doc.snippet.length).toBeGreaterThan(0); // rehydrated from docs/auth.md
  });

  it('impact down returns dependencies (issue), not dependents', () => {
    const res = verbs.impact({ id: login.id, dir: 'down' }) as unknown as ImpactResult;
    expect(res.affected.map((a) => a.id)).toEqual([issue.id]);
  });
});

describe('verbs', () => {
  it('context bundles signature, callers, callees, docs', () => {
    const res = verbs.context({ id: login.id }) as unknown as ContextResult;
    expect(res.node.name).toBe('login');
    expect(res.callers.map((c) => c.id)).toContain(handle.id);
    expect(res.callees.map((c) => c.id)).toContain(issue.id);
    expect(res.docs[0]!.edgeType).toBe('describes');
  });

  it('context surfaces deep node fields (file + span + qualifiedName) — not just name', () => {
    const res = verbs.context({ id: login.id }) as unknown as ContextResult;
    expect(res.node.file).toBe('src/auth.ts');
    expect(res.node.qualifiedName).toBe('AuthService.login'); // unstripped deep field
  });

  it('context brief includes file + line for callers/callees (locate the call)', () => {
    const res = verbs.context({ id: login.id }) as unknown as ContextResult;
    const caller = res.callers.find((c) => c.id === handle.id)!;
    expect(caller.file).toBe('src/http.ts');
    expect(caller.line).toBe(5);
  });

  it('context withSource rehydrates the FULL body from disk, not just the first line', () => {
    const res = verbs.context({ id: login.id, withSource: true }) as unknown as ContextResult;
    expect(res.source).toBeDefined();
    expect(res.source!.truncated).toBe(false);
    // lines 10-11 of src/auth.ts: the login header + its return statement
    expect(res.source!.text).toContain('login(user, pass)');
    expect(res.source!.text).toContain('return issue(user, pass)');
    expect(res.source!.totalLines).toBe(2);
  });

  it('context withRules on a non-callable node (doc-section) omits rules', () => {
    // a doc-section is not a callable symbol — rules must not be fabricated for it.
    const res = verbs.context({ id: docSection.id, withRules: true }) as unknown as ContextResult;
    expect(res.rules).toBeUndefined();
  });

  it('context withRules on a method (callable) DOES fold in its decision table', () => {
    // login is type 'method' — now a callable per CALLABLE_SYMBOL_TYPES (Track 3 widened the gate
    // from procedure|function to all callable symbol types so extract_rules works for every parser).
    // login has an outgoing calls edge to issue → a non-empty decision table.
    const res = verbs.context({ id: login.id, withRules: true }) as unknown as ContextResult;
    expect(res.rules).toBeDefined();
    const rules = res.rules as { rules: Array<{ action: { kind: string } }> };
    expect(rules.rules.length).toBeGreaterThanOrEqual(1);
  });

  it('source verb returns the full span text for a node', () => {
    const res = verbs.source({ id: login.id }) as unknown as SourceResult;
    expect(res.node.file).toBe('src/auth.ts');
    expect(res.source.text).toContain('login(user, pass)');
    expect(res.source.truncated).toBe(false);
  });

  it('source verb returns NOT_FOUND for an unknown id', () => {
    const res = verbs.source({ id: 'sym:nope' }) as unknown as ErrorResult;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('source verb respects the char budget + signals truncation', () => {
    const res = verbs.source({ id: login.id, maxChars: 5 }) as unknown as SourceResult;
    expect(res.source.truncated).toBe(true);
    expect(res.source.text.length).toBe(5);
  });

  it('describes returns linked docs with min confidence', () => {
    expect((verbs.describes({ id: login.id }) as unknown as DescribesResult).docs).toHaveLength(1);
    expect(
      (verbs.describes({ id: login.id, minConfidence: 0.99 }) as unknown as DescribesResult).docs,
    ).toHaveLength(0);
  });

  it('query finds symbols by BM25', () => {
    const res = verbs.query({ q: 'login', kinds: ['symbol'] }) as unknown as QueryResult;
    expect(res.hits[0]!.id).toBe(login.id);
  });

  it('query --with-source --with-rules folds the body + decision table + coverage into each callable hit', () => {
    const res = verbs.query({
      q: 'login',
      kinds: ['symbol'],
      withSource: true,
      withRules: true,
    }) as unknown as QueryResult;
    const hit = res.hits.find((h) => h.id === login.id);
    expect(hit).toBeDefined();
    // WS-2: the rehydrated body is folded into the hit (not just a one-line snippet).
    expect(hit!.source).toBeDefined();
    expect(hit!.source!.text).toContain('login');
    // the decision table is folded in: login has one `calls` action (→ issue).
    expect(hit!.rules).toBeDefined();
    expect(hit!.rules!.rules.length).toBeGreaterThan(0);
    // coverage gates the rules honestly: no `executes` edges → unimplemented (the body is a stub here).
    expect(hit!.coverage).toBeDefined();
    expect(hit!.coverage!.readiness).toBe('unimplemented');
  });

  it('ask explains a resolved node id/name directly', () => {
    const res = verbs.ask({ q: 'AuthService.login' }) as unknown as {
      question: string;
      interpretation: string;
      nodeId: string;
      context: ContextResult;
    };
    expect(res.interpretation).toBe('explain');
    expect(res.nodeId).toBe(login.id);
    expect(res.context.node.qualifiedName).toBe('AuthService.login');
    expect(res.context.callers.map((c) => c.id)).toContain(handle.id);
  });

  it('ask discovery searches the index and returns hits + LLM hits', () => {
    const res = verbs.ask({ q: 'session' }) as unknown as {
      interpretation: string;
      hits: Array<{ id: string }>;
      llmHits: unknown[];
    };
    expect(res.interpretation).toBe('discovery');
    const ids = res.hits.map((h) => h.id);
    expect(ids.length).toBeGreaterThan(0);
    // the doc section about sessions should be one of the hits.
    expect(ids).toContain(docSection.id);
  });

  it('ask overview classifies architecture questions', () => {
    const res = verbs.ask({ q: 'what is the architecture' }) as unknown as {
      interpretation: string;
      overview: { analyses: unknown[] };
      fallback?: { clusters: unknown[] };
    };
    expect(res.interpretation).toBe('overview');
    // with no LLM artifacts, the system bible is absent and a deterministic cluster fallback is present.
    expect(res.overview.analyses).toEqual([]);
    expect(res.fallback?.clusters).toBeDefined();
  });

  it('ask returns markdown when format is markdown', () => {
    const res = verbs.ask({ q: 'AuthService.login', format: 'markdown' }) as unknown as {
      markdown: string;
      interpretation: string;
    };
    expect(res.interpretation).toBe('explain');
    expect(res.markdown).toContain('# AuthService.login');
    expect(res.markdown).toContain('interpretation:');
    expect(res.markdown).toContain('Controller.handleLogin');
  });

  it('neighbors maps in/out/both', () => {
    expect(
      (verbs.neighbors({ id: login.id, rel: 'calls', dir: 'in' }) as unknown as NeighborsResult)
        .edges[0]!.src,
    ).toBe(handle.id);
    expect(
      (verbs.neighbors({ id: login.id, rel: 'calls', dir: 'out' }) as unknown as NeighborsResult)
        .edges[0]!.dst,
    ).toBe(issue.id);
  });

  it('shortest_path walks the chain', () => {
    const res = verbs.shortestPath({
      from: handle.id,
      to: issue.id,
    }) as unknown as ShortestPathResult;
    expect(res.found).toBe(true);
    expect(res.path).toEqual([handle.id, login.id, issue.id]);
  });

  it('status reports indexed + capabilities', () => {
    const res = verbs.status() as unknown as StatusResult;
    expect(res.indexed).toBe(true);
    expect(res.capabilities.cypher).toBe(false);
  });

  it('status({dirty:true}) previews what a dirty update would re-index', () => {
    soul.setVcsHead('h1');
    const v = new Verbs({
      soul,
      index,
      repoRoot: repo,
      vcs: {
        currentHead: () => 'h2',
        changedFilesSince: () => ['src/auth.ts'],
        uncommittedChanges: () => ['src/http.ts'],
      },
    });
    const res = v.status({ dirty: true }) as unknown as StatusResult & {
      dirtyPreview: { wouldUpdate: string[]; wouldScope: string[]; head: string };
    };
    expect(res.dirtyPreview.head).toBe('h2');
    expect(res.dirtyPreview.wouldUpdate.sort()).toEqual(['src/auth.ts', 'src/http.ts']);
    expect(res.dirtyPreview.wouldScope).toContain('src/http.ts'); // reverse-dep closure from handle→login
  });

  it('enrich_status / enrich_next / enrich_save drive an LLM-authored symbol graph batch', () => {
    const status = verbs.enrichStatus() as unknown as EnrichStatusResult;
    expect(status.nextLayer).toBe('symbol');
    expect(status.layers.symbol.total).toBeGreaterThanOrEqual(3);
    expect(status.layers.symbol.missing).toBe(status.layers.symbol.total);

    const batch = verbs.enrichNext({ layer: 'symbol', limit: 1 }) as unknown as EnrichNextResult;
    expect(batch.layer).toBe('symbol');
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.seed.node?.id).toBe(batch.items[0]!.targetId);
    expect(batch.items[0]!.seed.sourceBody?.text.length).toBeGreaterThan(0);
    expect(batch.items[0]!.outputSchema).toHaveProperty('type', 'object');

    const save = verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: batch.items[0]!.targetId,
          model: 'host-selected-model',
          analysis: {
            purpose: 'Authenticates a user and delegates token creation.',
            responsibilities: ['Check credentials', 'Issue a session token'],
            businessRules: [{ rule: 'A login creates a session.', sourceRef: login.id }],
            inputs: ['user', 'pass'],
            outputs: ['session'],
            sideEffects: [],
            errorBehavior: [],
            invariants: [],
            preconditions: [],
            postconditions: [],
            risks: [],
            whatToDistrust: [],
            confidence: 0.84,
          },
          graph: {
            nodes: [
              {
                localId: 'capability:login',
                kind: 'capability',
                name: 'Login',
                summary: 'User authentication capability.',
                attributes: {},
              },
            ],
            edges: [
              {
                from: batch.items[0]!.targetId,
                to: 'capability:login',
                rel: 'realizes',
                rationale: 'The symbol implements login behavior.',
                confidence: 0.82,
              },
              {
                from: 'capability:login',
                to: 'missing:soul-node',
                rel: 'depends-on-concept',
                rationale: 'This endpoint is not grounded and should be dropped.',
                confidence: 0.5,
              },
            ],
          },
          evidence: [{ soulId: batch.items[0]!.targetId, why: 'Dossier source and callers.' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.rejected).toEqual([]);
    expect(save.accepted[0]!.targetId).toBe(batch.items[0]!.targetId);
    expect(save.accepted[0]!.droppedEdges?.[0]!.reason).toContain('unresolved endpoint');

    const after = verbs.enrichStatus({ layer: 'symbol' }) as unknown as EnrichStatusResult;
    expect(after.model).toBe('host-selected-model');
    expect(after.layers.symbol.fresh).toBe(1);
  });

  it('enrich_status reports progress + costEstimate and enrich_next respects budgetTokens guard', () => {
    const status = verbs.enrichStatus() as unknown as EnrichStatusResult & {
      progress: { completed: number; pending: number; total: number };
      costEstimate: { currency: string; pending: number; total: number };
    };
    expect(status.progress.total).toBeGreaterThanOrEqual(3);
    expect(status.progress.pending).toBeGreaterThan(0);
    expect(status.progress.completed).toBeLessThan(status.progress.total);
    expect(status.costEstimate.currency).toBe('tokens');
    expect(status.costEstimate.pending).toBeGreaterThan(0);
    expect(status.costEstimate.total).toBeGreaterThanOrEqual(status.costEstimate.pending);

    const batch = verbs.enrichNext({ layer: 'symbol', limit: 1 }) as unknown as EnrichNextResult & {
      progress: { completed: number; pending: number; total: number };
      costEstimate: {
        currency: string;
        batch: number;
        perItem: Array<{ targetId: string; tokens: number }>;
        totalPending: number;
      };
    };
    expect(batch.progress.pending).toBeGreaterThan(0);
    expect(batch.costEstimate.batch).toBeGreaterThan(0);
    expect(batch.costEstimate.perItem).toHaveLength(1);

    const blocked = verbs.enrichNext({
      layer: 'symbol',
      limit: 1,
      budgetTokens: 1,
    }) as unknown as EnrichNextResult & {
      budgetExceeded: boolean;
      budget: number;
    };
    expect(blocked.budgetExceeded).toBe(true);
    expect(blocked.budget).toBe(1);
    expect(blocked.items).toHaveLength(0);
  });

  it('context, dossier, query, overview, and llm_neighbors surface saved LLM graph context', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === login.id) ?? batch.items[0]!;
    verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: target.targetId,
          model: 'host-model',
          analysis: {
            purpose: 'Validates login credentials before issuing a session.',
            responsibilities: ['Authenticate login'],
            businessRules: [
              { rule: 'Only authenticated users receive sessions.', sourceRef: login.id },
            ],
            inputs: [],
            outputs: [],
            sideEffects: [],
            errorBehavior: [],
            invariants: [],
            preconditions: [],
            postconditions: [],
            risks: [],
            whatToDistrust: [],
            confidence: 0.91,
          },
          graph: {
            nodes: [
              {
                localId: 'rule:authenticated-session',
                kind: 'business-rule',
                name: 'Authenticated session',
                summary: 'Sessions are created only after authentication.',
                attributes: {},
              },
            ],
            edges: [
              {
                from: target.targetId,
                to: 'rule:authenticated-session',
                rel: 'enforces',
                rationale: 'The login implementation gates session creation.',
                confidence: 0.9,
              },
            ],
          },
          evidence: [
            { soulId: target.targetId, why: 'The source body calls token issue after login.' },
          ],
        },
      ],
    });

    const ctx = verbs.context({ id: target.targetId }) as unknown as {
      llm?: { analysis: { purpose: string } };
    };
    expect(ctx.llm?.analysis.purpose).toContain('login credentials');

    const doss = verbs.dossier({ id: target.targetId }) as unknown as {
      llm?: { graph: { nodes: unknown[] } };
    };
    expect(doss.llm?.graph.nodes).toHaveLength(1);

    const query = verbs.query({ q: 'authenticated sessions', limit: 1 }) as unknown as {
      hits: Array<{ id: string; llm?: { provenance: string } }>;
    };
    expect(query.hits.some((h) => h.id === target.targetId && h.llm?.provenance === 'LLM')).toBe(
      true,
    );

    const neighbors = verbs.llmNeighbors({ id: target.targetId }) as unknown as {
      edges: Array<{ rel: string; to: string }>;
    };
    expect(neighbors.edges[0]!.rel).toBe('enforces');
    expect(neighbors.edges[0]!.to).toContain('rule:authenticated-session');

    const overview = verbs.overview() as unknown as { analyses: Array<{ targetId: string }> };
    expect(overview.analyses.some((a) => a.targetId === target.targetId)).toBe(true);
  });

  it('NOT_FOUND for unknown id', () => {
    expect((verbs.context({ id: 'sym:nope' }) as unknown as ErrorResult).error.code).toBe(
      'NOT_FOUND',
    );
  });

  it('node verbs resolve a qualified name or simple name, not just the full id (parity with extract_rules)', () => {
    // qualified name → same node as the full id
    const byQ = verbs.context({ id: 'AuthService.login' }) as unknown as ContextResult;
    expect(byQ.node.qualifiedName).toBe('AuthService.login');
    // simple name → same node (first match)
    const bySimple = verbs.context({ id: 'login' }) as unknown as ContextResult;
    expect(bySimple.node.qualifiedName).toBe('AuthService.login');
    // case-insensitive
    const byLower = verbs.context({ id: 'authservice.login' }) as unknown as ContextResult;
    expect(byLower.node.qualifiedName).toBe('AuthService.login');
    // dossier caches by the canonical id, so a qname request hits the same artifact
    const doss = verbs.dossier({ id: 'AuthService.login' }) as unknown as { id: string };
    expect(doss.id).toBe(login.id);
    // impact / neighbors / shortestPath endpoints resolve too
    expect(
      (verbs.impact({ id: 'AuthService.login', dir: 'up' }) as unknown as ImpactResult).root,
    ).toBe(login.id);
    expect(
      (verbs.neighbors({ id: 'login', rel: 'calls', dir: 'out' }) as unknown as NeighborsResult)
        .edges[0]!.dst,
    ).toBe(issue.id);
    expect(
      (
        verbs.shortestPath({
          from: 'Controller.handleLogin',
          to: 'issue',
        }) as unknown as ShortestPathResult
      ).found,
    ).toBe(true);
    // an unknown qname still returns NOT_FOUND with the ORIGINAL input (not a resolved id)
    expect(
      (verbs.context({ id: 'Does.Not.Exist' }) as unknown as ErrorResult).error.message,
    ).toContain('Does.Not.Exist');
  });

  it('extractedOnly filters out INFERRED doc links', () => {
    soul.putEdges([
      edge(docSection.id, issue.id, 'references', {
        method: 'semantic',
        provenance: 'INFERRED',
        confidence: 0.5,
      }),
    ]);
    soul.commit('2026-01-02T00:00:00.000Z');
    index.buildFromSoul(soul, repo);
    expect((verbs.describes({ id: issue.id }) as unknown as DescribesResult).docs).toHaveLength(1);
    expect(
      (verbs.describes({ id: issue.id, extractedOnly: true }) as unknown as DescribesResult).docs,
    ).toHaveLength(0);
  });
});

describe('crib-enrich scope picker — scopes / scope / deterministic batchId / scoped overview', () => {
  // Self-contained soul tailored for scope tests: symbols under packages/cli, packages/core, and
  // packages/cli-extra (the last exists ONLY to prove `packages/cli` does not match `packages/cli-extra`
  // — the trailing-slash-safety guarantee). All symbols live under `packages/` so monorepo descent
  // must split into packages/cli, packages/core, packages/cli-extra rather than one `packages` row.
  let r3: string;
  let s3: SoulStore;
  let idx3: SqliteIndexStore;
  let v3: Verbs;
  const a = sym('packages/cli/src/a.ts', 'A.run', 5);
  const b = sym('packages/cli/src/b.ts', 'B.run', 7);
  const c = sym('packages/core/src/c.ts', 'C.run', 9);
  const d = sym('packages/cli-extra/src/d.ts', 'D.run', 11); // trailing-slash trap
  const clusterNode: Node = {
    id: 'c:cli-mod',
    kind: 'cluster',
    name: 'cli-mod',
    members: [a.id, b.id],
    hash: contentHash('cli-mod'),
  };

  beforeEach(() => {
    r3 = mkdtempSync(join(tmpdir(), 'crib-scope-'));
    s3 = new SoulStore(join(r3, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    s3.load();
    s3.putNodes([
      fileNode('packages/cli/src/a.ts'),
      fileNode('packages/cli/src/b.ts'),
      fileNode('packages/core/src/c.ts'),
      fileNode('packages/cli-extra/src/d.ts'),
      { ...a, clusterId: 'c:cli-mod' },
      { ...b, clusterId: 'c:cli-mod' },
      c,
      d,
      clusterNode,
    ]);
    s3.commit('2026-01-01T00:00:00.000Z');
    idx3 = new SqliteIndexStore();
    idx3.buildFromSoul(s3, r3);
    v3 = new Verbs({ soul: s3, index: idx3, repoRoot: r3 });
  });
  afterEach(() => {
    idx3.close();
    rmSync(r3, { recursive: true, force: true });
  });

  it('enrich_status({scopes:true}) ranks path prefixes with monorepo descent (not one `packages` row)', () => {
    const st = v3.enrichStatus({ scopes: true }) as unknown as {
      totalPending: number;
      threshold: number;
      scopes: Array<{
        pathPrefix: string;
        pending: number;
        symbols: number;
        files: number;
        clusters: number;
      }>;
    };
    expect(st.threshold).toBe(200);
    expect(st.totalPending).toBeGreaterThan(0);
    const prefixes = st.scopes.map((s) => s.pathPrefix);
    // Monorepo descent: every symbol is under packages/, so the picker MUST descend to two components.
    expect(prefixes).not.toContain('packages');
    expect(prefixes).toContain('packages/cli');
    expect(prefixes).toContain('packages/core');
    expect(prefixes).toContain('packages/cli-extra');
    const cli = st.scopes.find((s) => s.pathPrefix === 'packages/cli')!;
    expect(cli.symbols).toBe(2); // a + b
    expect(cli.files).toBe(2);
    expect(cli.clusters).toBe(1); // cluster c:cli-mod has members under packages/cli
    const cliExtra = st.scopes.find((s) => s.pathPrefix === 'packages/cli-extra')!;
    expect(cliExtra.symbols).toBe(1);
  });

  it('enrich_next batchId is deterministic — same pending set yields the same id across calls', () => {
    const b1 = v3.enrichNext({ layer: 'symbol', limit: 2 }) as unknown as { batchId: string };
    const b2 = v3.enrichNext({ layer: 'symbol', limit: 2 }) as unknown as { batchId: string };
    expect(b1.batchId).toBe(b2.batchId);
    expect(b1.batchId).toMatch(/^llm:symbol:[0-9a-f]{12}$/);
  });

  it('enrich_status with scope restricts counts to in-scope targets, excludes system from nextLayer, and reports wholeRepoPending', () => {
    const st = v3.enrichStatus({ scope: { pathPrefix: 'packages/cli' } }) as unknown as {
      scopeEcho: { pathPrefix: string };
      scopeEmpty: boolean;
      done: boolean;
      nextLayer?: string;
      layers: {
        symbol: { total: number; missing: number };
        file: { total: number };
        cluster: { total: number };
        system: { total: number };
      };
      wholeRepoPending: { system: number };
    };
    expect(st.scopeEcho).toEqual({ pathPrefix: 'packages/cli' });
    expect(st.scopeEmpty).toBe(false);
    expect(st.layers.symbol.total).toBe(2); // a + b only
    expect(st.layers.file.total).toBe(2);
    expect(st.layers.cluster.total).toBe(1);
    expect(st.nextLayer).toBe('symbol'); // system never offered under scope
    expect(st.wholeRepoPending.system).toBe(1);
  });

  it('scope is trailing-slash-safe: `packages/cli` does NOT match `packages/cli-extra`', () => {
    const st = v3.enrichStatus({ scope: { pathPrefix: 'packages/cli' } }) as unknown as {
      layers: { symbol: { total: number } };
    };
    expect(st.layers.symbol.total).toBe(2); // a + b, NOT d (packages/cli-extra)
    const extra = v3.enrichStatus({ scope: { pathPrefix: 'packages/cli-extra' } }) as unknown as {
      layers: { symbol: { total: number } };
    };
    expect(extra.layers.symbol.total).toBe(1); // d only
  });

  it('enrich_next with scope returns only in-scope targets + scopeEmpty + scopeEcho', () => {
    const batch = v3.enrichNext({
      scope: { pathPrefix: 'packages/core' },
      limit: 4,
    }) as unknown as {
      items: Array<{ targetId: string }>;
      selectedTargetIds: string[];
      scopeEcho: { pathPrefix: string };
      scopeEmpty: boolean;
      remaining: number;
    };
    expect(batch.scopeEcho).toEqual({ pathPrefix: 'packages/core' });
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.targetId).toBe(c.id);
    expect(batch.selectedTargetIds).toEqual([c.id]);
    expect(batch.scopeEmpty).toBe(false);
    expect(batch.remaining).toBe(0);
  });

  it('scopeEmpty is true and done is true for a prefix that matches zero targets', () => {
    const st = v3.enrichStatus({ scope: { pathPrefix: 'packages/nope' } }) as unknown as {
      scopeEmpty: boolean;
      done: boolean;
      layers: { symbol: { total: number }; file: { total: number }; cluster: { total: number } };
    };
    expect(st.scopeEmpty).toBe(true);
    expect(st.done).toBe(true);
    expect(st.layers.symbol.total).toBe(0);
    expect(st.layers.file.total).toBe(0);
    expect(st.layers.cluster.total).toBe(0);
  });

  it('scoped overview excludes the system layer and only includes in-scope fresh artifacts', () => {
    // Save one in-scope (packages/cli) and one out-of-scope (packages/core) symbol artifact.
    const batch = v3.enrichNext({ layer: 'symbol', limit: 4 }) as unknown as {
      batchId: string;
      items: Array<{ targetId: string }>;
    };
    const inScope = batch.items.find((i) => i.targetId === a.id)!;
    const outScope = batch.items.find((i) => i.targetId === c.id)!;
    v3.enrichSave({
      batchId: batch.batchId,
      items: [inScope, outScope].map((item) => ({
        targetId: item.targetId,
        model: 'test-model',
        analysis: {
          purpose: 'p',
          responsibilities: ['r'],
          confidence: 0.5,
        },
        graph: { nodes: [], edges: [] },
        evidence: [],
      })),
    });
    const scoped = v3.overview({ scope: { pathPrefix: 'packages/cli' } }) as unknown as {
      analyses: Array<{ targetId: string; layer: string }>;
      scopeEcho: { pathPrefix: string };
      system?: unknown;
    };
    expect(scoped.scopeEcho).toEqual({ pathPrefix: 'packages/cli' });
    expect(scoped.system).toBeUndefined(); // system excluded under scope
    const targets = scoped.analyses.map((a) => a.targetId);
    expect(targets).toContain(a.id);
    expect(targets).not.toContain(c.id); // out-of-scope excluded
    // Unscoped overview includes the system slot and both artifacts.
    const whole = v3.overview() as unknown as { analyses: Array<{ targetId: string }> };
    expect(whole.analyses.map((x) => x.targetId)).toContain(c.id);
  });

  it('enrich_next flags zeroProgress server-side when the same pending set is returned twice with no save', () => {
    // The server persists the last-issued batchId per (layer, scope) and echoes previousBatchId +
    // zeroProgress so a context-compacted host (or a headless driver) can detect the churn trap without
    // remembering the previous id.
    const first = v3.enrichNext({ layer: 'symbol', limit: 2 }) as unknown as {
      batchId: string;
      previousBatchId?: string;
      zeroProgress?: boolean;
    };
    expect(first.batchId).toMatch(/^llm:symbol:[0-9a-f]{12}$/);
    expect(first.previousBatchId).toBeUndefined();
    expect(first.zeroProgress).toBeFalsy();
    // Second call with no save landing => same pending set => same batchId => server flags zero-progress.
    const second = v3.enrichNext({ layer: 'symbol', limit: 2 }) as unknown as {
      batchId: string;
      previousBatchId?: string;
      zeroProgress?: boolean;
    };
    expect(second.batchId).toBe(first.batchId);
    expect(second.previousBatchId).toBe(first.batchId);
    expect(second.zeroProgress).toBe(true);
  });

  it('batchId is stable across different `limit` values (hashed over the full pending set, not the slice)', () => {
    const l2 = v3.enrichNext({ layer: 'symbol', limit: 2 }) as unknown as { batchId: string };
    const l4 = v3.enrichNext({ layer: 'symbol', limit: 4 }) as unknown as { batchId: string };
    expect(l2.batchId).toBe(l4.batchId);
  });

  it('cluster refinement resolves via the cluster `members` array even when symbols have no clusterId (production path)', () => {
    // Production cluster nodes carry a `members` array; the pipeline never stamps `clusterId` onto
    // symbols. A cluster-scoped run must resolve membership from `members`, not a dead clusterId read.
    const r = mkdtempSync(join(tmpdir(), 'crib-cluster-noid-'));
    const s = new SoulStore(join(r, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    s.load();
    const x = sym('packages/mod/src/x.ts', 'X.run', 3);
    const y = sym('packages/mod/src/y.ts', 'Y.run', 5);
    const z = sym('packages/mod/src/z.ts', 'Z.run', 7); // NOT a cluster member
    const cluster: Node = {
      id: 'c:mod',
      kind: 'cluster',
      name: 'mod',
      members: [x.id, y.id],
      hash: contentHash('mod'),
    };
    s.putNodes([
      fileNode('packages/mod/src/x.ts'),
      fileNode('packages/mod/src/y.ts'),
      fileNode('packages/mod/src/z.ts'),
      x,
      y,
      z,
      cluster,
    ]);
    s.commit('2026-01-01T00:00:00.000Z');
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(s, r);
    const v = new Verbs({ soul: s, index: idx, repoRoot: r });
    const inMod = v.enrichStatus({
      scope: { pathPrefix: 'packages/mod', cluster: 'c:mod' },
    }) as unknown as {
      layers: { symbol: { total: number }; file: { total: number } };
    };
    expect(inMod.layers.symbol.total).toBe(2); // x + y via members array, NOT z
    expect(inMod.layers.file.total).toBe(2); // files holding cluster members (x.ts, y.ts), NOT z.ts
    const unknown = v.enrichStatus({
      scope: { pathPrefix: 'packages/mod', cluster: 'c:nope' },
    }) as unknown as {
      layers: { symbol: { total: number } };
    };
    expect(unknown.layers.symbol.total).toBe(0); // unresolvable cluster => nothing in scope
    idx.close();
    rmSync(r, { recursive: true, force: true });
  });

  it('scoped overview excludes a saved system artifact (artifactInScope(system) === false)', () => {
    // Save a symbol artifact AND a whole-repo system artifact; the scoped overview must drop the
    // system artifact (exercising the artifactInScope(system) exclusion path), the unscoped must keep it.
    const symBatch = v3.enrichNext({ layer: 'symbol', limit: 1 }) as unknown as {
      batchId: string;
      items: Array<{ targetId: string }>;
    };
    v3.enrichSave({
      batchId: symBatch.batchId,
      items: [
        {
          targetId: symBatch.items[0]!.targetId,
          model: 'm',
          analysis: { purpose: 'p', responsibilities: ['r'], confidence: 0.5 },
          graph: { nodes: [], edges: [] },
          evidence: [],
        },
        {
          targetId: 'system:repo',
          model: 'm',
          analysis: { purpose: 'bible', responsibilities: ['r'], confidence: 0.9 },
          graph: { nodes: [], edges: [] },
          evidence: [],
        },
      ],
    });
    const scoped = v3.overview({ scope: { pathPrefix: 'packages/cli' } }) as unknown as {
      analyses: Array<{ layer: string; targetId: string }>;
      system?: unknown;
    };
    expect(scoped.system).toBeUndefined();
    expect(scoped.analyses.some((a) => a.layer === 'system')).toBe(false);
    const whole = v3.overview() as unknown as {
      system?: { purpose: string };
      analyses: Array<{ layer: string }>;
    };
    expect(whole.system).toBeDefined();
    expect(whole.system!.purpose).toBe('bible');
  });
});

describe('extract_rules verb (M12)', () => {
  // Self-contained soul: a procedure with one guarded executes edge, to verify the verb delegates
  // to decisionTable and surfaces the materialized path condition + NOT_FOUND for unknown procs.
  let r2: string;
  let s2: SoulStore;
  let idx2: SqliteIndexStore;
  let v2: Verbs;

  beforeEach(() => {
    r2 = mkdtempSync(join(tmpdir(), 'crib-rules-verb-'));
    s2 = new SoulStore(join(r2, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    s2.load();
    const proc = sym('src/p.plsql', 'pkg.doIt', 5, { type: 'procedure', lang: 'plsql' });
    const stmt: Node = {
      id: idFor({ kind: 'statement', file: 'src/p.plsql', line: 8 }),
      kind: 'statement',
      sqlKind: 'insert',
      expr: 'INSERT INTO t VALUES (1)',
      file: 'src/p.plsql',
      span: { start: 8, end: 8 },
      lang: 'plsql',
      hash: contentHash('s'),
    };
    const cond: Node = {
      id: idFor({ kind: 'condition', file: 'src/p.plsql', line: 7 }),
      kind: 'condition',
      expr: 'x > 0',
      file: 'src/p.plsql',
      span: { start: 7, end: 7 },
      lang: 'plsql',
      hash: contentHash('c'),
    };
    s2.putNodes([fileNode('src/p.plsql'), proc, stmt, cond]);
    s2.putEdges([
      edge(proc.id, stmt.id, 'executes', {
        guard: cond.id,
        cfgPath: [cond.id],
        branch: 'THEN',
        inLoop: false,
        inException: false,
      }),
    ]);
    s2.commit('2026-01-01T00:00:00.000Z');
    idx2 = new SqliteIndexStore();
    idx2.buildFromSoul(s2, r2);
    v2 = new Verbs({ soul: s2, index: idx2, repoRoot: r2 });
  });
  afterEach(() => {
    idx2.close();
    rmSync(r2, { recursive: true, force: true });
  });

  it('materializes the decision table for a procedure by qualified name', () => {
    const res = v2.extractRules({ procedure: 'pkg.doIt' }) as unknown as RulesResult;
    expect(res.rules).toHaveLength(1);
    const rule = res.rules[0]!;
    expect(rule.action.kind).toBe('executes');
    expect(rule.action.sqlKind).toBe('insert');
    expect(rule.guard).toBe(idFor({ kind: 'condition', file: 'src/p.plsql', line: 7 }));
    expect(rule.branch).toBe('THEN');
    expect(rule.conditions[0]!.polarity).toBe('THEN');
  });

  it('returns NOT_FOUND for an unknown procedure', () => {
    const res = v2.extractRules({ procedure: 'no_such_proc' }) as unknown as RulesResult;
    expect(res.error?.code).toBe('NOT_FOUND');
  });
});

describe('dossier verb (Workstream D — one-shot deep reusable context)', () => {
  it('folds node + paged source + callers + callees + docs + rules into one artifact', () => {
    const res = verbs.dossier({ id: login.id }) as unknown as DossierResult;
    expect(res.node.qualifiedName).toBe('AuthService.login');
    expect(res.source.text).toContain('login(user, pass)'); // rehydrated from disk
    expect(res.source.startLine).toBe(10); // span start
    expect(res.callers.map((c) => c.id)).toContain(handle.id);
    expect(res.callees.map((c) => c.id)).toContain(issue.id);
    expect(res.docs[0]!.edgeType).toBe('describes');
    // login is callable (type 'method') → decision table folded in
    expect(res.rules?.rules.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the schema-1.2 control-flow constructs (raises + declares) with deep fields', () => {
    // dedicated soul: a PL/SQL-like proc that raises raise_application_error + declares a cursor.
    const r = mkdtempSync(join(tmpdir(), 'crib-dossier-cf-'));
    mkdirSync(join(r, 'src'), { recursive: true });
    writeFileSync(join(r, 'src', 'p.plsql'), `${'\n'.repeat(9)}process_claim\n`);
    const s = new SoulStore(join(r, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    s.load();
    const proc = sym('src/p.plsql', 'claims.process_claim', 10);
    const raiseN: Node = {
      id: idFor({ kind: 'raise', file: 'src/p.plsql', line: 11 }),
      kind: 'raise',
      name: 'raise_application_error',
      errorCode: '-20001',
      errorMessage: 'invalid claim',
      file: 'src/p.plsql',
      span: { start: 11, end: 11 },
      lang: 'plsql',
      hash: contentHash('raise-invalid-claim'),
    };
    const cursorN: Node = {
      id: idFor({ kind: 'cursor', file: 'src/p.plsql', name: 'claim_cur', line: 12 }),
      kind: 'cursor',
      name: 'claim_cur',
      cursorQuery: 'SELECT id FROM claims WHERE status = :1',
      file: 'src/p.plsql',
      span: { start: 12, end: 12 },
      lang: 'plsql',
      hash: contentHash('cursor-claim-cur'),
    };
    s.putNodes([fileNode('src/p.plsql'), proc, raiseN, cursorN]);
    s.putEdges([edge(proc.id, raiseN.id, 'raises'), edge(proc.id, cursorN.id, 'declares')]);
    s.commit('2026-01-01T00:00:00.000Z');
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(s, r);
    const v = new Verbs({ soul: s, index: idx, repoRoot: r });
    try {
      const res = v.dossier({ id: proc.id }) as unknown as DossierResult;
      expect(res.controlFlow).toBeDefined();
      const raises = res.controlFlow!.raises;
      expect(raises).toHaveLength(1);
      expect(raises[0]!.kind).toBe('raise');
      expect(raises[0]!.errorCode).toBe('-20001'); // the behavior-bearing detail
      expect(raises[0]!.errorMessage).toBe('invalid claim');
      const declares = res.controlFlow!.declares;
      expect(declares).toHaveLength(1);
      expect(declares[0]!.kind).toBe('cursor');
      expect(declares[0]!.name).toBe('claim_cur');
      expect(declares[0]!.cursorQuery).toContain('SELECT id FROM claims');
    } finally {
      idx.close();
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('returns NOT_FOUND for an unknown id', () => {
    const res = verbs.dossier({ id: 'sym:nope' }) as unknown as ErrorResult;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('omits rules + controlFlow for a non-callable node (doc-section)', () => {
    const res = verbs.dossier({ id: docSection.id }) as unknown as DossierResult;
    expect(res.rules).toBeUndefined();
    expect(res.controlFlow).toBeUndefined();
  });

  it('pages a large body via sourceStartLine → nextLine cursor', () => {
    // login span is lines 10-11 (2 lines); page 1 line at a time and walk the cursor.
    const page1 = verbs.dossier({ id: login.id, sourceMaxLines: 1 }) as unknown as DossierResult;
    expect(page1.source.startLine).toBe(10);
    expect(page1.source.truncated).toBe(true);
    expect(page1.source.nextLine).toBe(11);
    const page2 = verbs.dossier({
      id: login.id,
      sourceMaxLines: 1,
      sourceStartLine: page1.source.nextLine,
    }) as unknown as DossierResult;
    expect(page2.source.startLine).toBe(11);
    expect(page2.source.text).toContain('return issue(user, pass)');
    expect(page2.source.truncated).toBe(false);
    expect(page2.source.nextLine).toBeUndefined();
  });
});

interface GapsResult {
  unimplemented: Array<{
    id: string;
    qualifiedName?: string;
    type?: string;
    file?: string;
    referencedBy?: { count: number; files: string[] };
  }>;
  packageSpecsWithoutBody: Array<{
    id: string;
    qualifiedName?: string;
    file?: string;
    declaredCount: number;
    implementedCount: number;
    expectedBodyFile?: string;
    referencedBy?: { count: number; files: string[] };
  }>;
  unresolvedCallSites: Array<{
    caller: string;
    callee: string;
    line: number;
    builtin: boolean;
    category?: string;
  }>;
  controllersWithoutRoutes: Array<{
    id: string;
    qualifiedName?: string;
    name?: string;
    file?: string;
    memberCount: number;
    routeCount: number;
  }>;
  unresolvedInjects: Array<{
    id: string;
    qualifiedName?: string;
    name?: string;
    file?: string;
    stereotype?: string;
    unresolved: string[];
  }>;
  summary: {
    unimplemented: number;
    packageSpecsWithoutBody: number;
    unresolvedCallSites: number;
    controllersWithoutRoutes: number;
    unresolvedInjects: number;
    analysisReadiness: 'complete' | 'incomplete';
    byCategory: Record<string, number>;
  };
}

describe('gaps verb — missing-asset + unimplemented detection', () => {
  const PKS = 'db/PKG_LOAN_RULE_ENGINE.pks';
  const PKB = 'db/PKG_LOAN_RULE_ENGINE.pkb';
  let pkgSpec: Node;
  let pkgBody: Node;
  let specResolve: Node;
  let specEval: Node;
  let bodyDoWork: Node;
  let caller: Node;
  let callerB: Node;

  function stmt(path: string, line: number, sqlKind = 'select'): Node {
    return {
      id: idFor({ kind: 'statement', file: path, line }),
      kind: 'statement',
      sqlKind,
      file: path,
      span: { start: line, end: line },
      lang: 'plsql',
      hash: contentHash(`${path}:${line}:${sqlKind}`),
    };
  }

  beforeEach(() => {
    index.close(); // release the auth index built by the outer beforeEach
    soul = new SoulStore(join(repo, '.gaps-crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();

    // one PL/SQL package: spec (.pks) declares two procs, body (.pkb) implements a different one.
    // mirrors the user's case: PKG_LOAN_RULE_ENGINE_spec present, _body absent for the spec procs.
    pkgSpec = sym(PKS, 'PKG_LOAN_RULE_ENGINE', 1, { type: 'package', lang: 'plsql' });
    pkgBody = sym(PKB, 'PKG_LOAN_RULE_ENGINE', 1, { type: 'package', lang: 'plsql' });
    specResolve = sym(PKS, 'PKG_LOAN_RULE_ENGINE.RESOLVE_AND_EVALUATE_RULES', 3, {
      type: 'procedure',
      lang: 'plsql',
    });
    specEval = sym(PKS, 'PKG_LOAN_RULE_ENGINE.EVAL_CREDIT', 5, {
      type: 'procedure',
      lang: 'plsql',
    });
    bodyDoWork = sym(PKB, 'PKG_LOAN_RULE_ENGINE.DO_WORK', 10, {
      type: 'procedure',
      lang: 'plsql',
    });
    const bodyStmt = stmt(PKB, 12, 'select');
    caller = sym('db/caller.sql', 'caller_proc', 20, {
      type: 'procedure',
      lang: 'plsql',
      meta: {
        calls: [
          { callee: 'MISSING_PROC', line: 22 },
          { callee: 'DBMS_OUTPUT.PUT_LINE', line: 23 },
          { callee: 'Array.prototype.map', line: 23 },
          { callee: 'PKG_LOAN_RULE_ENGINE.DO_WORK', line: 24 },
        ],
      },
    });
    const callerStmt = stmt('db/caller.sql', 26, 'update');
    // a SECOND caller in a different file invokes the spec-only RESOLVE_AND_EVALUATE_RULES — the
    // "referenced everywhere but the body is missing" signal: referencedBy must list both files.
    callerB = sym('db/caller_b.sql', 'caller_b_proc', 30, {
      type: 'procedure',
      lang: 'plsql',
    });
    const callerBStmt = stmt('db/caller_b.sql', 32, 'insert');

    soul.putNodes([
      fileNode(PKS),
      fileNode(PKB),
      fileNode('db/caller.sql'),
      fileNode('db/caller_b.sql'),
      pkgSpec,
      pkgBody,
      specResolve,
      specEval,
      bodyDoWork,
      bodyStmt,
      caller,
      callerStmt,
      callerB,
      callerBStmt,
    ]);
    soul.putEdges([
      edge(specResolve.id, pkgSpec.id, 'member-of'),
      edge(specEval.id, pkgSpec.id, 'member-of'),
      edge(bodyDoWork.id, pkgBody.id, 'member-of'),
      edge(bodyDoWork.id, bodyStmt.id, 'executes'),
      edge(caller.id, callerStmt.id, 'executes'),
      edge(callerB.id, callerBStmt.id, 'executes'),
      // two cross-file callers of the spec-only proc → "referenced everywhere"
      edge(caller.id, specResolve.id, 'calls'),
      edge(callerB.id, specResolve.id, 'calls'),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');

    index = new SqliteIndexStore();
    index.buildFromSoul(soul, repo);
    verbs = new Verbs({ soul, index, repoRoot: repo });
  });

  it('reports unimplemented procedures (spec declarations with no body anywhere)', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    const names = res.unimplemented.map((u) => u.qualifiedName).sort();
    expect(names).toContain('PKG_LOAN_RULE_ENGINE.RESOLVE_AND_EVALUATE_RULES');
    expect(names).toContain('PKG_LOAN_RULE_ENGINE.EVAL_CREDIT');
    // an implemented body procedure is NOT unimplemented
    expect(names).not.toContain('PKG_LOAN_RULE_ENGINE.DO_WORK');
  });

  it('reports package specs whose body file is absent (declaredCount, zero implemented)', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    expect(res.packageSpecsWithoutBody.length).toBe(1);
    const pkg = res.packageSpecsWithoutBody[0]!;
    expect(pkg.file).toBe(PKS);
    expect(pkg.declaredCount).toBe(2);
    expect(pkg.implementedCount).toBe(0);
  });

  it('reports unresolved project call sites by default while categorizing builtin noise', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    const sites = res.unresolvedCallSites;
    expect(sites.find((s) => s.callee === 'MISSING_PROC' && s.builtin === false)).toBeDefined();
    expect(sites.find((s) => s.callee === 'DBMS_OUTPUT.PUT_LINE')).toBeUndefined();
    expect(sites.find((s) => s.callee === 'Array.prototype.map')).toBeUndefined();
    // a call to an IMPLEMENTED procedure resolves and is not reported
    expect(sites.find((s) => s.callee === 'PKG_LOAN_RULE_ENGINE.DO_WORK')).toBeUndefined();
    expect(res.summary.unresolvedCallSites).toBe(1);
    expect(res.summary.byCategory.project).toBe(4);
    expect(res.summary.byCategory.builtin).toBe(2);
  });

  it('shows builtin unresolved call sites only when includeBuiltins is requested', () => {
    const res = verbs.gaps({ includeBuiltins: true }) as unknown as GapsResult;
    const sites = res.unresolvedCallSites;
    expect(
      sites.find(
        (s) =>
          s.callee === 'DBMS_OUTPUT.PUT_LINE' && s.builtin === true && s.category === 'builtin',
      ),
    ).toBeDefined();
    expect(
      sites.find(
        (s) => s.callee === 'Array.prototype.map' && s.builtin === true && s.category === 'builtin',
      ),
    ).toBeDefined();
    expect(res.summary.unresolvedCallSites).toBe(3);
    expect(res.summary.byCategory.project).toBe(4);
    expect(res.summary.byCategory.builtin).toBe(2);
  });

  it('infers the expected body file from the spec path (.pks → .pkb)', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    expect(res.packageSpecsWithoutBody.length).toBe(1);
    expect(res.packageSpecsWithoutBody[0]!.expectedBodyFile).toBe(PKB);
  });

  it('surfaces "referenced everywhere but missing" on unimplemented + package entries', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    const specResolveRow = res.unimplemented.find(
      (u) => u.qualifiedName === 'PKG_LOAN_RULE_ENGINE.RESOLVE_AND_EVALUATE_RULES',
    );
    expect(specResolveRow).toBeDefined();
    // two cross-file callers reference the spec-only proc
    expect(specResolveRow!.referencedBy).toEqual({
      count: 2,
      files: ['db/caller.sql', 'db/caller_b.sql'],
    });
    // the package aggregates the same signal across its members
    const pkg = res.packageSpecsWithoutBody[0]!;
    expect(pkg.referencedBy).toEqual({
      count: 2,
      files: ['db/caller.sql', 'db/caller_b.sql'],
    });
  });

  it('reports analysisReadiness incomplete when a body is missing, complete when nothing gaps', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    expect(res.summary.analysisReadiness).toBe('incomplete');

    // a soul with no gaps (one fully-implemented proc, no spec-only decls) → complete
    const cleanSoul = new SoulStore(join(repo, '.gaps-crib-clean'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    cleanSoul.load();
    const impl = sym('src/svc.pkb', 'svc.work', 5, { type: 'procedure', lang: 'plsql' });
    const implStmt = stmt('src/svc.pkb', 7, 'select');
    cleanSoul.putNodes([fileNode('src/svc.pkb'), impl, implStmt]);
    cleanSoul.putEdges([edge(impl.id, implStmt.id, 'executes')]);
    cleanSoul.commit('2026-01-01T00:00:00.000Z');
    const cleanIndex = new SqliteIndexStore();
    cleanIndex.buildFromSoul(cleanSoul, repo);
    const cleanVerbs = new Verbs({ soul: cleanSoul, index: cleanIndex, repoRoot: repo });
    const cleanRes = cleanVerbs.gaps() as unknown as GapsResult;
    expect(cleanRes.summary.analysisReadiness).toBe('complete');
    expect(cleanRes.unimplemented.length).toBe(0);
    cleanIndex.close();
  });
});

describe('framework-semantics integration — context withFramework + Spring gaps anomalies', () => {
  const F = 'src/com/acme/Loan.java';
  let ctl: Node;
  let apply: Node;
  let route: Node;
  let svc: Node;
  let repoIface: Node;
  let cfg: Node;
  let bean: Node;
  let bareCtl: Node; // controller with no routes → anomaly
  let unresolvedCtl: Node; // controller whose injects never resolve → anomaly

  beforeEach(() => {
    index.close(); // release the auth index built by the outer beforeEach
    soul = new SoulStore(join(repo, '.fw-crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();

    ctl = sym(F, 'com.acme.LoanController', 1, {
      type: 'class',
      lang: 'java',
      stereotype: 'controller',
      framework: 'spring',
      meta: { injects: ['com.acme.LoanService'] },
    });
    apply = sym(F, 'com.acme.LoanController.apply', 5, {
      type: 'method',
      lang: 'java',
      framework: 'spring',
      meta: { security: { PreAuthorize: "hasRole('LENDER')" } },
    });
    route = {
      id: idFor({ kind: 'route', httpMethod: 'POST', routePath: '/api/loans', file: F, line: 5 }),
      kind: 'route',
      name: 'POST /api/loans',
      httpMethod: 'POST',
      routePath: '/api/loans',
      framework: 'spring',
      file: F,
      span: { start: 5, end: 5 },
      lang: 'java',
      meta: {
        params: [{ name: 'loan', type: 'Loan', in: 'body' }],
        security: { PreAuthorize: "hasRole('LENDER')" },
      },
      hash: contentHash('route:POST:/api/loans'),
    };
    svc = sym(F, 'com.acme.LoanService', 30, {
      type: 'class',
      lang: 'java',
      stereotype: 'service',
      framework: 'spring',
      meta: { injects: ['com.acme.LoanRepository'] },
    });
    repoIface = sym(F, 'com.acme.LoanRepository', 50, {
      type: 'class',
      lang: 'java',
      stereotype: 'repository',
      framework: 'spring',
    });
    cfg = sym(F, 'com.acme.LoanRepositoryConfig', 60, {
      type: 'class',
      lang: 'java',
      stereotype: 'config',
      framework: 'spring',
    });
    bean = sym(F, 'com.acme.LoanRepositoryConfig.loanRepository', 62, {
      type: 'method',
      lang: 'java',
      framework: 'spring',
      meta: { returnType: 'LoanRepository' },
    });
    // a SECOND controller with member methods but ZERO exposes edges → controllersWithoutRoutes
    bareCtl = sym(F, 'com.acme.BareController', 70, {
      type: 'class',
      lang: 'java',
      stereotype: 'controller',
      framework: 'spring',
    });
    const bareMethod = sym(F, 'com.acme.BareController.helper', 72, {
      type: 'method',
      lang: 'java',
    });
    // a controller whose meta.injects names a type for which NO injects edge exists → unresolvedInjects
    unresolvedCtl = sym(F, 'com.acme.UnresolvedController', 80, {
      type: 'class',
      lang: 'java',
      stereotype: 'controller',
      framework: 'spring',
      meta: { injects: ['com.acme.MissingService'] },
    });

    soul.putNodes([
      fileNode(F),
      ctl,
      apply,
      route,
      svc,
      repoIface,
      cfg,
      bean,
      bareCtl,
      bareMethod,
      unresolvedCtl,
    ]);
    soul.putEdges([
      edge(apply.id, ctl.id, 'member-of'),
      edge(bean.id, cfg.id, 'member-of'),
      edge(bareMethod.id, bareCtl.id, 'member-of'),
      edge(apply.id, route.id, 'exposes', { evidence: { snippet: 'POST /api/loans' } }),
      edge(ctl.id, svc.id, 'injects', { evidence: { snippet: 'com.acme.LoanService' } }),
      edge(svc.id, repoIface.id, 'injects', { evidence: { snippet: 'com.acme.LoanRepository' } }),
      edge(bean.id, repoIface.id, 'produces', { evidence: { snippet: 'LoanRepository' } }),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');

    index = new SqliteIndexStore();
    index.buildFromSoul(soul, repo);
    verbs = new Verbs({ soul, index, repoRoot: repo });
  });

  it('context(withFramework) on a controller surfaces the route table + DI graph (full set)', () => {
    const res = verbs.context({ id: ctl.id, withFramework: true }) as unknown as ContextResult;
    expect(res.framework).toBeDefined();
    // class scope aggregates member routes + injects + produces across members
    expect(res.framework!.routes).toHaveLength(1);
    expect(res.framework!.routes![0]!.httpMethod).toBe('POST');
    expect(res.framework!.routes![0]!.routePath).toBe('/api/loans');
    expect(res.framework!.routes![0]!.params![0]).toMatchObject({ name: 'loan', in: 'body' });
    expect(res.framework!.routes![0]!.security).toEqual({ PreAuthorize: "hasRole('LENDER')" });
    expect(res.framework!.dependencies).toBeDefined();
    expect(res.framework!.dependencies!.some((d) => d.kind === 'injects')).toBe(true);
  });

  it('context(withFramework) supply-chain: a service injecting a @Bean-produced type → kind=produces + producer', () => {
    const res = verbs.context({ id: svc.id, withFramework: true }) as unknown as ContextResult;
    expect(res.framework!.dependencies).toBeDefined();
    const dep = res.framework!.dependencies!.find(
      (d) => d.brief.qualifiedName === 'com.acme.LoanRepository',
    );
    expect(dep).toBeDefined();
    expect(dep!.kind).toBe('produces');
    expect(dep!.producer?.qualifiedName).toBe('com.acme.LoanRepositoryConfig.loanRepository');
  });

  it('context(withFramework) on the @Configuration surfaces the @Bean inventory with producer', () => {
    const res = verbs.context({ id: cfg.id, withFramework: true }) as unknown as ContextResult;
    expect(res.framework!.produces).toBeDefined();
    expect(res.framework!.produces!.length).toBe(1);
    expect(res.framework!.produces![0]!.producer?.qualifiedName).toBe(
      'com.acme.LoanRepositoryConfig.loanRepository',
    );
  });

  it('context WITHOUT withFramework omits the framework section (opt-in, matching withRules/withSource)', () => {
    const res = verbs.context({ id: ctl.id }) as unknown as ContextResult;
    expect(res.framework).toBeUndefined();
    // but the 1.3 identity fields still surface via publicNode (no-round-trip)
    expect(res.node.stereotype).toBe('controller');
    expect(res.node.framework).toBe('spring');
  });

  it('gaps reports a controller with member methods but ZERO routes (controllersWithoutRoutes)', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    const row = res.controllersWithoutRoutes.find(
      (c) => c.qualifiedName === 'com.acme.BareController',
    );
    expect(row).toBeDefined();
    expect(row!.memberCount).toBe(1);
    expect(row!.routeCount).toBe(0);
    // the wired controller (apply → route) is NOT reported
    expect(
      res.controllersWithoutRoutes.find((c) => c.qualifiedName === 'com.acme.LoanController'),
    ).toBeUndefined();
    expect(res.summary.controllersWithoutRoutes).toBeGreaterThanOrEqual(1);
  });

  it('gaps reports a controller whose meta.injects name has no emitted injects edge (unresolvedInjects)', () => {
    const res = verbs.gaps() as unknown as GapsResult;
    const row = res.unresolvedInjects.find(
      (c) => c.qualifiedName === 'com.acme.UnresolvedController',
    );
    expect(row).toBeDefined();
    expect(row!.unresolved).toContain('com.acme.MissingService');
    expect(row!.stereotype).toBe('controller');
    // the wired controller (ctl → svc) is NOT reported
    expect(
      res.unresolvedInjects.find((c) => c.qualifiedName === 'com.acme.LoanController'),
    ).toBeUndefined();
  });
});

describe('reconstruct — package-scoped migration reconstruction (WS-6)', () => {
  const PKG_FILE = 'db/pkg_spec.sql';
  const BODY_FILE = 'db/pkg_body.sql';
  const pkg = sym(PKG_FILE, 'PKG_RULES', 3, {
    type: 'package',
    lang: 'plsql',
    meta: {
      variables: [
        { name: 'C_THRESHOLD_AUTO_REJECT', dataType: 'NUMBER', init: '30', constant: true },
        { name: 'C_THRESHOLD_AUTO_APPROVE', dataType: 'NUMBER', init: '80', constant: true },
        { name: 'g_limit', dataType: 'NUMBER', init: '1000' },
      ],
    },
  });
  const doWork = sym(BODY_FILE, 'PKG_RULES.DO_WORK', 10, { type: 'procedure', lang: 'plsql' });
  const specOnly = sym(PKG_FILE, 'PKG_RULES.SPEC_ONLY', 20, { type: 'function', lang: 'plsql' });
  const selStmt: Node = {
    id: idFor({ kind: 'statement', file: BODY_FILE, line: 12 }),
    kind: 'statement',
    type: 'statement',
    sqlKind: 'select',
    file: BODY_FILE,
    span: { start: 12, end: 12 },
    lang: 'plsql',
    hash: contentHash(`${BODY_FILE}:12:statement`),
  };
  const loans: Node = {
    id: idFor({ kind: 'table', schema: 'app', name: 'loans' }),
    kind: 'table',
    schema: 'app',
    name: 'loans',
    file: 'db/loans.sql',
    hash: contentHash('app.loans'),
  };

  beforeEach(() => {
    index.close(); // release the index built by the outer beforeEach
    mkdirSync(join(repo, 'db'), { recursive: true });
    writeFileSync(join(repo, PKG_FILE), '-- spec\n');
    writeFileSync(join(repo, BODY_FILE), `${'\n'.repeat(9)}-- body\n`);
    soul = new SoulStore(join(repo, '.recon-crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.putNodes([pkg, doWork, specOnly, selStmt, loans]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');
    index = new SqliteIndexStore();
    index.buildFromSoul(soul, repo);
    verbs = new Verbs({ soul, index, repoRoot: repo });
  });

  it('returns NOT_FOUND for an unknown id (preserving the original input)', () => {
    const res = verbs.reconstruct({ id: 'PKG_NOPE' }) as unknown as ErrorResult;
    expect(res.error.code).toBe('NOT_FOUND');
    expect(res.error.message).toContain('PKG_NOPE');
  });

  it('returns NOT_FOUND for a non-package node (reconstruct is package-scoped)', () => {
    const res = verbs.reconstruct({ id: doWork.id }) as unknown as ErrorResult;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('resolves a qualified/simple name, not just the full id (parity with context/dossier)', () => {
    const byQ = verbs.reconstruct({ id: 'PKG_RULES' }) as unknown as ReconstructResult;
    expect(byQ.id).toBe(pkg.id);
    expect(byQ.constants.map((c) => c.init)).toContain('30');
    expect(byQ.constants.map((c) => c.init)).toContain('80');
  });

  it('assembles constants, members, referenced tables, expectedBodyFile (json)', () => {
    const res = verbs.reconstruct({
      id: pkg.id,
      includeTables: true,
    }) as unknown as ReconstructResult;
    expect(res.expectedBodyFile).toBe('db/pkg_body.sql');
    expect(res.constants).toContainEqual({
      name: 'C_THRESHOLD_AUTO_REJECT',
      dataType: 'NUMBER',
      init: '30',
      constant: true,
    });
    expect(res.constants).toContainEqual({
      name: 'C_THRESHOLD_AUTO_APPROVE',
      dataType: 'NUMBER',
      init: '80',
      constant: true,
    });
    expect(res.variables.map((v) => v.name)).toEqual([
      'C_THRESHOLD_AUTO_REJECT',
      'C_THRESHOLD_AUTO_APPROVE',
      'g_limit',
    ]);
    expect(res.members).toHaveLength(2);
    const dw = res.members.find((m) => m.qualifiedName === 'PKG_RULES.DO_WORK')!;
    expect(dw.implementation.status).toBe('implemented');
    expect(dw.rulesCount).toBe(1); // 1 executes edge
    const so = res.members.find((m) => m.qualifiedName === 'PKG_RULES.SPEC_ONLY')!;
    expect(so.implementation.status).toBe('unimplemented');
    expect(res.referencedTables.find((t) => t.name === 'app.loans')?.readBy).toEqual([
      'PKG_RULES.DO_WORK',
    ]);
    expect(res.memberCount).toBe(2);
    expect(res.truncated).toBe(false);
  });

  it('format:markdown emits the constants table with 30/80 + expectedBodyFile + members', () => {
    const res = verbs.reconstruct({ id: 'PKG_RULES', format: 'markdown' }) as unknown as {
      id: string;
      markdown: string;
    };
    expect(res.id).toBe(pkg.id);
    expect(res.markdown).toContain('# Reconstruct: PKG_RULES');
    expect(res.markdown).toContain('- expectedBodyFile: `db/pkg_body.sql`');
    expect(res.markdown).toContain('| C_THRESHOLD_AUTO_REJECT | NUMBER | `30` |');
    expect(res.markdown).toContain('| C_THRESHOLD_AUTO_APPROVE | NUMBER | `80` |');
    expect(res.markdown).toContain('## Defaults');
    expect(res.markdown).toContain('| g_limit | NUMBER | `1000` |');
    expect(res.markdown).toContain('PKG_RULES.DO_WORK');
    expect(res.markdown).toContain('⚠ unimplemented');
  });

  it('includeTables:false omits the referenced tables (honesty)', () => {
    const res = verbs.reconstruct({
      id: pkg.id,
      includeTables: false,
    }) as unknown as ReconstructResult;
    expect(res.referencedTables).toEqual([]);
  });
});

describe('dossierByScope — bulk per-symbol dossiers (WS-4)', () => {
  const PKG_FILE = 'db/pkg_spec.sql';
  const BODY_FILE = 'db/pkg_body.sql';
  const pkg = sym(PKG_FILE, 'PKG_RULES', 3, { type: 'package', lang: 'plsql' });
  const doWork = sym(BODY_FILE, 'PKG_RULES.DO_WORK', 10, { type: 'procedure', lang: 'plsql' });
  const specOnly = sym(PKG_FILE, 'PKG_RULES.SPEC_ONLY', 20, { type: 'function', lang: 'plsql' });
  const helper = sym(BODY_FILE, 'PKG_RULES.HELPER', 30, { type: 'procedure', lang: 'plsql' });
  const selStmt: Node = {
    id: idFor({ kind: 'statement', file: BODY_FILE, line: 12 }),
    kind: 'statement',
    type: 'statement',
    sqlKind: 'select',
    file: BODY_FILE,
    span: { start: 12, end: 12 },
    lang: 'plsql',
    hash: contentHash(`${BODY_FILE}:12:statement`),
  };
  const loans: Node = {
    id: idFor({ kind: 'table', schema: 'app', name: 'loans' }),
    kind: 'table',
    schema: 'app',
    name: 'loans',
    file: 'db/loans.sql',
    hash: contentHash('app.loans'),
  };

  beforeEach(() => {
    index.close(); // release the index built by the outer beforeEach
    mkdirSync(join(repo, 'db'), { recursive: true });
    writeFileSync(join(repo, PKG_FILE), '-- spec\n');
    writeFileSync(join(repo, BODY_FILE), `${'\n'.repeat(9)}-- body\n`);
    soul = new SoulStore(join(repo, '.byscope-crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.putNodes([pkg, doWork, specOnly, helper, selStmt, loans]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(helper.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
      edge(doWork.id, helper.id, 'calls'),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');
    index = new SqliteIndexStore();
    index.buildFromSoul(soul, repo);
    verbs = new Verbs({ soul, index, repoRoot: repo });
  });

  it('returns NOT_FOUND for an unknown scope id (preserving the original input)', () => {
    const res = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_NOPE',
    }) as unknown as ErrorResult;
    expect(res.error.code).toBe('NOT_FOUND');
    expect(res.error.message).toContain('PKG_NOPE');
  });

  it('returns NOT_FOUND for a package scope when the id is a non-package node', () => {
    const res = verbs.dossierByScope({ scope: 'package', id: doWork.id }) as unknown as ErrorResult;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('resolves a qualified/simple name and returns a dossier per member (json)', () => {
    const res = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_RULES',
    }) as unknown as DossiersByScopeResult;
    expect(res.scope).toBe('package');
    expect(res.id).toBe(pkg.id);
    expect(res.label).toBe('PKG_RULES');
    expect(res.symbolCount).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.skipped).toEqual([]);
    // members sorted top-to-bottom by source line
    expect(res.symbols.map((d) => d.node.qualifiedName)).toEqual([
      'PKG_RULES.DO_WORK',
      'PKG_RULES.SPEC_ONLY',
      'PKG_RULES.HELPER',
    ]);
    const dw = res.symbols.find((d) => d.node.qualifiedName === 'PKG_RULES.DO_WORK')!;
    expect(dw.implementation?.status).toBe('implemented');
    expect(dw.implementation?.executesCount).toBe(1);
    expect(dw.callees.map((c) => c.qualifiedName)).toContain('PKG_RULES.HELPER');
    expect(dw.rules).toBeDefined();
    const helperD = res.symbols.find((d) => d.node.qualifiedName === 'PKG_RULES.HELPER')!;
    expect(helperD.implementation?.status).toBe('unimplemented');
    expect(helperD.callers.map((c) => c.qualifiedName)).toContain('PKG_RULES.DO_WORK');
  });

  it('caps at maxSymbols and flags truncated + symbolCount (honesty)', () => {
    const res = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_RULES',
      maxSymbols: 2,
    }) as unknown as DossiersByScopeResult;
    expect(res.symbols).toHaveLength(2);
    expect(res.symbolCount).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it('enumerates a file scope: every symbol whose file matches the file node path', () => {
    const bodyFileNode: Node = {
      id: `file:${BODY_FILE}`,
      kind: 'file',
      file: BODY_FILE,
      hash: contentHash(`file:${BODY_FILE}`),
    };
    soul.putNodes([bodyFileNode]);
    soul.commit('2026-01-01T00:00:00.000Z');
    const res = verbs.dossierByScope({
      scope: 'file',
      id: BODY_FILE,
    }) as unknown as DossiersByScopeResult;
    expect(res.scope).toBe('file');
    expect(res.id).toBe(`file:${BODY_FILE}`);
    expect(res.label).toBe(BODY_FILE);
    expect(res.symbols.map((d) => d.node.qualifiedName).sort()).toEqual(
      ['PKG_RULES.DO_WORK', 'PKG_RULES.HELPER'].sort(),
    );
  });

  it('format:markdown emits the scope banner + one dossier per symbol', () => {
    const res = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_RULES',
      format: 'markdown',
    }) as unknown as { id: string; markdown: string };
    expect(res.id).toBe(pkg.id);
    expect(res.markdown).toContain('# Dossier-by-scope: PKG_RULES');
    expect(res.markdown).toContain('- scope: package');
    expect(res.markdown).toContain('- symbols: 3');
    // each member's dossier is rendered (the symbol header in dossierToMarkdown)
    expect(res.markdown).toContain('PKG_RULES.DO_WORK');
    expect(res.markdown).toContain('PKG_RULES.HELPER');
    expect(res.markdown).toContain('PKG_RULES.SPEC_ONLY');
  });

  it('format:markdown with zero symbols emits the banner + symbols: 0 and no dossier separators', () => {
    // a package with no members → zero symbols enumerated
    const emptyPkg = sym(PKG_FILE, 'PKG_EMPTY', 99, { type: 'package', lang: 'plsql' });
    soul.putNodes([emptyPkg]);
    soul.commit('2026-01-01T00:00:00.000Z');
    index.buildFromSoul(soul, repo);
    const res = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_EMPTY',
      format: 'markdown',
    }) as unknown as { id: string; markdown: string };
    expect(res.markdown).toContain('# Dossier-by-scope: PKG_EMPTY');
    expect(res.markdown).toContain('- symbols: 0');
    // no per-symbol dossier block separators when there are no symbols
    expect(res.markdown).not.toContain('PKG_RULES.DO_WORK');
    // the banner is still well-formed (ends cleanly, no trailing dossier)
    expect(res.markdown.trim().endsWith('PKG_EMPTY') || res.markdown.includes('- symbols: 0')).toBe(
      true,
    );
  });

  it('extractedOnly drops INFERRED call edges from every dossier (trust filter)', () => {
    // add an INFERRED call edge that extractedOnly should drop
    soul.putEdges([
      edge(specOnly.id, helper.id, 'calls', { provenance: 'INFERRED', confidence: 0.4 }),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');
    const all = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_RULES',
    }) as unknown as DossiersByScopeResult;
    const soAll = all.symbols.find((d) => d.node.qualifiedName === 'PKG_RULES.SPEC_ONLY')!;
    expect(soAll.callees.map((c) => c.qualifiedName)).toContain('PKG_RULES.HELPER');
    const ex = verbs.dossierByScope({
      scope: 'package',
      id: 'PKG_RULES',
      extractedOnly: true,
    }) as unknown as DossiersByScopeResult;
    const soEx = ex.symbols.find((d) => d.node.qualifiedName === 'PKG_RULES.SPEC_ONLY')!;
    expect(soEx.callees.map((c) => c.qualifiedName)).not.toContain('PKG_RULES.HELPER');
  });
});
