/**
 * WP-G5/G8 — the connected-retrieval evaluation over the FROZEN graph acceptance corpus
 * (docs/bench/graph-gates.md §3–§4). It measures the shipped serving path, not a model of it:
 *
 *  1. The fixture universe is written into real stores — records and decisions per placement,
 *     entities and backfilled assertions per scope, and every capture-scope edge admitted ONLY
 *     through a leased extraction job (`submitExtractedGraphProposal`), never a raw write.
 *  2. Each question is asked through `Verbs.memoryConnectedGraph({ op: 'context' })` as its own
 *     principal, from its own repository placement, at its own `knownAt` — the principal comes
 *     from the server environment exactly as it does in production.
 *  3. Scoring is against the pre-registered expectations only:
 *       - evidence-path recall = expected hops present among the assertions the pack returned
 *         (item paths, conflict members, labelled history), per question, averaged over the
 *         multi-hop (≥2 hop) questions;
 *       - an unauthorized path is ANY returned assertion id not in the asking principal's own
 *         graph journal entries — computed from the stores, not from the response;
 *       - a forbidden id surfacing as a CURRENT item, or any content in an emptiness probe, is a
 *         violation.
 *
 * Nothing here tunes retrieval. The thresholds are stated by the gate file and applied by the
 * launch decision, never by this module.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Embedder, SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  GRAPH_CORPUS_VERSION,
  GRAPH_SEED_SCORER_VERSION,
  type GraphAssertion,
  type GraphCorpus,
  type GraphEntity,
  type GraphQuestion,
  type MemoryAlias,
  type MemoryDecision,
  type MemoryProvenance,
  MemoryStore,
  buildGraphCorpus,
  claimGraphExtractionJob,
  createGraphAssertion,
  createGraphEntity,
  decisionId,
  deriveAssertionsFromRecords,
  enqueueGraphExtractionJob,
  memoryAliasId,
  submitExtractedGraphProposal,
} from '@knowledge-crib/memory';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { Verbs } from './verbs.js';

/** v3 — the recall channel is LIVE: fixtures carry a trust stamp (bound legacy alias verdicts), so
 *  `memorySearch` admits them and `recallSeeds` fuses real recall hits. v2 and earlier measured the
 *  lexical + semantic channels only, while the gates doc described three. */
export const GRAPH_EVAL_HARNESS_VERSION = 3;

export interface GraphEvalQuestionResult {
  id: string;
  family: GraphQuestion['family'];
  variant: GraphQuestion['variant'];
  expectedHops: number;
  foundHops: number;
  recall: number;
  missingHops: string[];
  unauthorizedAssertionIds: string[];
  forbiddenSurfaced: string[];
  emptinessViolated: boolean;
  unavailable: boolean;
}

export interface GraphEvalReport {
  harnessVersion: number;
  corpusVersion: number;
  /** The seed scorer the served answers used — the frozen retrieval configuration measured. */
  seedScorer: string;
  /** The installed embedder the semantic seed channel ran on; null means the channel was absent. */
  embedderId: string | null;
  questions: number;
  multiHopQuestions: number;
  /** Mean per-question expected-hop recall over the multi-hop questions (the ≥90% gate input). */
  evidencePathRecall: number;
  fullyRecalledMultiHop: number;
  unauthorizedPaths: number;
  forbiddenViolations: number;
  emptinessViolations: number;
  unavailableAnswers: number;
  byFamily: Record<string, { questions: number; meanRecall: number }>;
  results: GraphEvalQuestionResult[];
}

const EVAL_PROVENANCE: Omit<MemoryProvenance, 'principalId'> = {
  deviceId: 'device:graph-eval',
  actorId: 'agent:graph-eval',
  clientId: 'graph-eval',
};

interface EvalServer {
  repoId: string;
  soul: SoulStore;
  index: SqliteIndexStore;
  local: MemoryStore;
}

function hopKey(predicate: string, from: string, to: string): string {
  return `${predicate} ${from} -> ${to}`;
}

function isCaptureScope(corpus: GraphCorpus, edge: { predicate: string; from: string }): boolean {
  const intakeIds = new Set(Object.values(corpus.intakeIds));
  return (
    edge.predicate === 'affects' ||
    edge.predicate === 'applies-to' ||
    (edge.predicate === 'about' && intakeIds.has(edge.from))
  );
}

function corpusEntities(corpus: GraphCorpus): GraphEntity[] {
  const members = new Map<string, string[]>();
  for (const edge of corpus.expectedRelationships) {
    if (edge.predicate !== 'part-of') continue;
    members.set(edge.to, [...(members.get(edge.to) ?? []), edge.from]);
  }
  return corpus.entities.map((fixture) =>
    createGraphEntity({
      kind: fixture.type,
      name: fixture.name,
      namespace: { principalId: corpus.principals.alpha, projectId: fixture.repoId },
      scope: { boundary: 'repo', repoId: fixture.repoId },
      provenance: { ...EVAL_PROVENANCE, principalId: corpus.principals.alpha },
      members: members.get(fixture.id) ?? [],
    }),
  );
}

function openServer(
  workDir: string,
  repoId: string,
  env: NodeJS.ProcessEnv,
  now: string,
): EvalServer {
  const repoRoot = join(workDir, 'repos', repoId);
  const cribDir = join(repoRoot, '.crib');
  mkdirSync(cribDir, { recursive: true });
  const soul = new SoulStore(cribDir, { manifest: newManifest({ now }) });
  soul.load();
  soul.commit(now);
  writeFileSync(join(cribDir, 'crib.json'), `${JSON.stringify({ repo: { id: repoId } })}\n`);
  const index = new SqliteIndexStore();
  index.buildFromSoul(soul, repoRoot);
  const local = MemoryStore.local(repoId, { env, now: () => now, repoRoot });
  return { repoId, soul, index, local };
}

interface CaptureSource {
  id: string;
  principalId: string;
  repoId: string | undefined;
  validAt: string;
  knownAt: string;
}

/** Records and intakes are both capture sources: each names its principal, placement, and time. */
function captureSources(corpus: GraphCorpus): Map<string, CaptureSource> {
  const sources = new Map<string, CaptureSource>();
  for (const r of [...corpus.records, ...corpus.globalDecoys]) {
    sources.set(r.id, {
      id: r.id,
      principalId: r.namespace.principalId,
      repoId: r.namespace.projectId,
      validAt: r.validTime.from,
      knownAt: r.transactionTime.recordedAt,
    });
  }
  for (const intake of corpus.intakes) {
    sources.set(intake.id, {
      id: intake.id,
      principalId: intake.namespace.principalId,
      repoId: intake.namespace.projectId,
      validAt: intake.createdAt,
      knownAt: intake.createdAt,
    });
  }
  return sources;
}

/** Admit capture-scope edges the way WP-G4 requires: one leased job per supporting source. */
function admitCaptureEdges(
  corpus: GraphCorpus,
  stores: Map<string, MemoryStore>,
  now: string,
): number {
  const sources = captureSources(corpus);
  let admitted = 0;
  for (const edge of corpus.expectedRelationships.filter((e) => isCaptureScope(corpus, e))) {
    const source = sources.get(edge.supportedBy[0] ?? '');
    const store = source?.repoId === undefined ? undefined : stores.get(source.repoId);
    if (source === undefined || source.repoId === undefined || store === undefined) continue;
    const knownAt = edge.supportedBy
      .map((id) => sources.get(id)?.knownAt ?? source.knownAt)
      .sort()
      .at(-1) as string;
    const { job } = enqueueGraphExtractionJob(
      store,
      {
        sourceId: source.id,
        sourceHash: `blake3:${source.id.slice(source.id.indexOf(':') + 1)}`,
        ontologyVersion: 'graph-ontology-v1',
        principalId: source.principalId,
        producer: { id: 'agent:graph-eval', version: String(GRAPH_EVAL_HARNESS_VERSION) },
        idempotencyKey: hopKey(edge.predicate, edge.from, edge.to),
      },
      now,
    );
    const owner = 'worker:graph-eval';
    claimGraphExtractionJob(store, job.id, { owner, now, expiresAt: '2999-01-01T00:00:00.000Z' });
    const assertion = createGraphAssertion({
      predicate: edge.predicate,
      subject: edge.from,
      object: edge.to,
      namespace: { principalId: source.principalId, projectId: source.repoId },
      scope: { boundary: 'repo', repoId: source.repoId },
      validAt: source.validAt,
      knownAt,
      supportedBy: [...edge.supportedBy],
      provenance: { ...EVAL_PROVENANCE, principalId: source.principalId },
    });
    const result = submitExtractedGraphProposal(store, {
      jobId: job.id,
      owner,
      sourceHash: job.sourceHash,
      entries: [assertion],
    });
    if (result !== undefined) admitted += 1;
  }
  return admitted;
}

function seedUniverse(
  corpus: GraphCorpus,
  servers: EvalServer[],
  global: MemoryStore,
  now: string,
): { ownAssertions: Map<string, Set<string>> } {
  const locals = new Map(servers.map((s) => [s.repoId, s.local]));
  for (const record of [...corpus.records, ...corpus.globalDecoys]) {
    const repoId = record.namespace.projectId;
    if (repoId === undefined) global.upsertEntry('records', record);
    else locals.get(repoId)?.upsertEntry('active', record);
  }
  const recordRepo = new Map(
    [...corpus.records, ...corpus.globalDecoys].map((r) => [r.id, r.namespace.projectId]),
  );
  // A memory-3 record carries no trust stamp, and an `activate` lifecycle decision admits it to
  // the LIFECYCLE axis only — it can never confer trust (evaluator.ts:919-921, :923). Recall
  // eligibility additionally requires `trust ∈ {local, team}` (evaluator.ts:954-962), and a v2
  // record inherits its trust EXCLUSIVELY from the verdict snapshot of a bound legacy alias
  // (`conservativeVerdicts`, aliases.ts:122). Without the aliases below, `memorySearch` returns
  // `eligible: 0` on every question and the corpus's RECALL channel is inert: the harness would
  // silently measure two of the three channels the serving path fuses (`recallSeeds`, lexical,
  // semantic) while the gates doc describes all three. Every fixture is therefore also admitted
  // as a TRUSTED (local-trust, valid, current, active) migrated record — decoys included, since a
  // decoy that could not be recalled would test nothing.
  const fixtureAliases: MemoryAlias[] = [...corpus.records, ...corpus.globalDecoys].map(
    (record) => {
      const legacyId = `mem:${blake3Hex(`graph-eval:legacy:${record.id}`)}`;
      return {
        id: memoryAliasId({ legacyId, resolvedId: record.id }),
        schemaVersion: '1' as const,
        legacyId,
        resolvedId: record.id,
        verdicts: {
          trust: 'local' as const,
          evidence: 'valid' as const,
          applicability: 'current' as const,
          lifecycle: 'active' as const,
        },
      };
    },
  );
  for (const alias of fixtureAliases) {
    const repoId = recordRepo.get(alias.resolvedId);
    if (repoId === undefined) global.upsertAliases([alias]);
    else locals.get(repoId)?.upsertAliases([alias]);
  }
  // The `activate` decisions still run: they are what an admitted record's history looks like, and
  // the lifecycle axis they carry is independent of the trust axis the aliases supply.
  const admissions: MemoryDecision[] = [...corpus.records, ...corpus.globalDecoys].map((record) => {
    const decision = {
      kind: 'activate' as const,
      subject: record.id,
      actor: 'operator:graph-eval',
      reason: 'graph acceptance corpus fixture admission',
    };
    return {
      id: decisionId(decision),
      schemaVersion: '1',
      ...decision,
      ts: record.transactionTime.recordedAt,
    };
  });
  for (const decision of [...admissions, ...corpus.decisions]) {
    const repoId = 'subject' in decision ? recordRepo.get(decision.subject) : undefined;
    if (repoId === undefined) global.upsertEntry('decisions', decision);
    else locals.get(repoId)?.upsertEntry('decisions', decision);
  }

  // Work references: intake requirements and their checkpoints live where the owner's local
  // store keeps them, so the graph reads their authorization and completion state from the store.
  const intakeRepo = new Map(corpus.intakes.map((i) => [i.id, i.namespace.projectId]));
  for (const intake of corpus.intakes) {
    locals.get(intake.namespace.projectId ?? '')?.upsertEntry('intakes', intake);
  }
  for (const checkpoint of corpus.checkpoints) {
    locals.get(intakeRepo.get(checkpoint.intakeId) ?? '')?.upsertEntry('intakes', checkpoint);
  }

  const entities = corpusEntities(corpus);
  const backfill = deriveAssertionsFromRecords(
    [...corpus.records, ...corpus.globalDecoys],
    entities,
    { ...EVAL_PROVENANCE, principalId: corpus.principals.alpha },
  );
  for (const entity of entities) {
    locals.get((entity.scope as { repoId: string }).repoId)?.submitGraphEntries([entity]);
  }
  for (const assertion of backfill.assertions) {
    if (assertion.scope.boundary === 'global') global.submitGraphEntries([assertion]);
    else locals.get(assertion.scope.repoId as string)?.submitGraphEntries([assertion]);
  }
  admitCaptureEdges(corpus, locals, now);

  const ownAssertions = new Map<string, Set<string>>();
  for (const store of [...locals.values(), global]) {
    for (const entry of store.readCollection('graph').entries as GraphAssertion[]) {
      if (typeof entry.predicate !== 'string') continue;
      const owner = entry.namespace.principalId;
      ownAssertions.set(owner, (ownAssertions.get(owner) ?? new Set()).add(entry.id));
    }
  }
  return { ownAssertions };
}

interface ContextView {
  unavailable: boolean;
  assertions: Map<string, { predicate: string; subject: string; object: string }>;
  currentItemRefs: Set<string>;
  itemCount: number;
}

function askContext(verbs: Verbs, question: GraphQuestion, scope: 'repo' | 'global'): ContextView {
  const res = verbs.memoryConnectedGraph({
    op: 'context',
    q: question.question,
    scope,
    ...(question.knownAt !== undefined ? { knownBy: question.knownAt } : {}),
  });
  const view: ContextView = {
    unavailable: res.unavailable === true || res.context === undefined,
    assertions: new Map(),
    currentItemRefs: new Set(),
    itemCount: 0,
  };
  const context = res.context as
    | {
        items: { ref: string; state: string }[];
        assertions: { id: string; predicate: string; subject: string; object: string }[];
      }
    | undefined;
  if (context === undefined) return view;
  view.itemCount = context.items.length;
  for (const item of context.items) {
    if (item.state !== 'historical') view.currentItemRefs.add(item.ref);
  }
  for (const a of context.assertions) view.assertions.set(a.id, a);
  return view;
}

function mergeViews(views: ContextView[]): ContextView {
  const merged: ContextView = {
    unavailable: views.some((v) => v.unavailable),
    assertions: new Map(),
    currentItemRefs: new Set(),
    itemCount: 0,
  };
  for (const v of views) {
    for (const [id, a] of v.assertions) merged.assertions.set(id, a);
    for (const ref of v.currentItemRefs) merged.currentItemRefs.add(ref);
    merged.itemCount += v.itemCount;
  }
  return merged;
}

function scoreQuestion(
  question: GraphQuestion,
  view: ContextView,
  conflictMembers: Map<string, { predicate: string; subject: string; object: string }>,
  ownAssertions: Set<string>,
): GraphEvalQuestionResult {
  const returned = new Set<string>();
  for (const [id, a] of view.assertions) {
    const full = a.predicate === '' ? conflictMembers.get(id) : a;
    if (full !== undefined) returned.add(hopKey(full.predicate, full.subject, full.object));
  }
  const expected = question.expected.hops.map((h) => hopKey(h.predicate, h.from, h.to));
  const missingHops = expected.filter((k) => !returned.has(k));
  const foundHops = expected.length - missingHops.length;
  const forbidden = question.expected.forbiddenIds ?? [];
  const isEmptinessProbe =
    question.expected.hops.length === 0 && question.expected.claimIds.length === 0;
  return {
    id: question.id,
    family: question.family,
    variant: question.variant,
    expectedHops: expected.length,
    foundHops,
    recall: expected.length === 0 ? 1 : foundHops / expected.length,
    missingHops,
    unauthorizedAssertionIds: [...view.assertions.keys()]
      .filter((id) => !ownAssertions.has(id))
      .sort(),
    forbiddenSurfaced: forbidden.filter((id) => view.currentItemRefs.has(id)).sort(),
    emptinessViolated: isEmptinessProbe && view.assertions.size > 0,
    unavailable: view.unavailable,
  };
}

/** Run the frozen corpus through the shipped `memory_graph` context path and score it. */
export function runGraphCorpusEvaluation(opts: {
  workDir: string;
  /** The installed launch embedder; absent runs the lexical channels only and says so. */
  embedder?: Embedder;
  /** A question set other than the frozen v1 questions (a held-out split over the same universe). */
  questions?: (corpus: GraphCorpus) => { version: number; questions: GraphQuestion[] };
}): GraphEvalReport {
  const corpus = buildGraphCorpus();
  const now = '2026-09-16T00:00:00.000Z';
  const env = {
    ...process.env,
    KCRIB_MEMORY_DIR: join(opts.workDir, 'home'),
    KCRIB_EMBED_HOME: join(opts.workDir, 'embed'),
  };
  const servers = [corpus.repoIds.ledger, corpus.repoIds.checkout].map((repoId) =>
    openServer(opts.workDir, repoId, env, now),
  );
  const global = MemoryStore.global({ env, now: () => now });
  const previousPrincipal = process.env.KCRIB_PRINCIPAL_ID;
  const previousHome = process.env.KCRIB_MEMORY_DIR;
  try {
    process.env.KCRIB_MEMORY_DIR = env.KCRIB_MEMORY_DIR;
    const { ownAssertions } = seedUniverse(corpus, servers, global, now);
    const conflictMembers = new Map<
      string,
      { predicate: string; subject: string; object: string }
    >();
    for (const store of [...servers.map((s) => s.local), global]) {
      for (const entry of store.readCollection('graph').entries as GraphAssertion[]) {
        if (typeof entry.predicate === 'string') conflictMembers.set(entry.id, entry);
      }
    }
    const verbsFor = new Map(
      servers.map((s) => [
        s.repoId,
        new Verbs({
          soul: s.soul,
          index: s.index,
          repoRoot: join(opts.workDir, 'repos', s.repoId),
          memory: {
            local: s.local,
            global,
            ...(opts.embedder !== undefined ? { embedder: opts.embedder } : {}),
          },
        }),
      ]),
    );

    const questionSet = opts.questions
      ? opts.questions(corpus)
      : { version: GRAPH_CORPUS_VERSION, questions: corpus.questions };
    const results = questionSet.questions.map((question) => {
      process.env.KCRIB_PRINCIPAL_ID = question.principal;
      const views: ContextView[] = [];
      if (question.scope.global === true) {
        views.push(askContext(verbsFor.get(corpus.repoIds.ledger) as Verbs, question, 'global'));
      } else if (question.scope.repoId !== undefined) {
        views.push(askContext(verbsFor.get(question.scope.repoId) as Verbs, question, 'repo'));
      } else {
        // An unplaced question spans every repository the principal can be served from.
        for (const verbs of verbsFor.values()) views.push(askContext(verbs, question, 'repo'));
      }
      return scoreQuestion(
        question,
        mergeViews(views),
        conflictMembers,
        ownAssertions.get(question.principal) ?? new Set(),
      );
    });
    return summarize(results, questionSet.version, opts.embedder?.id ?? null);
  } finally {
    if (previousPrincipal === undefined) Reflect.deleteProperty(process.env, 'KCRIB_PRINCIPAL_ID');
    else process.env.KCRIB_PRINCIPAL_ID = previousPrincipal;
    if (previousHome === undefined) Reflect.deleteProperty(process.env, 'KCRIB_MEMORY_DIR');
    else process.env.KCRIB_MEMORY_DIR = previousHome;
    for (const s of servers) s.index.close();
  }
}

function summarize(
  results: GraphEvalQuestionResult[],
  corpusVersion: number,
  embedderId: string | null,
): GraphEvalReport {
  const multiHop = results.filter((r) => r.expectedHops >= 2);
  const mean = (rs: GraphEvalQuestionResult[]): number =>
    rs.length === 0 ? 0 : rs.reduce((t, r) => t + r.recall, 0) / rs.length;
  const byFamily: GraphEvalReport['byFamily'] = {};
  for (const family of [...new Set(results.map((r) => r.family))].sort()) {
    const rs = results.filter((r) => r.family === family);
    byFamily[family] = { questions: rs.length, meanRecall: mean(rs) };
  }
  return {
    harnessVersion: GRAPH_EVAL_HARNESS_VERSION,
    corpusVersion,
    seedScorer: GRAPH_SEED_SCORER_VERSION,
    embedderId,
    questions: results.length,
    multiHopQuestions: multiHop.length,
    evidencePathRecall: mean(multiHop),
    fullyRecalledMultiHop: multiHop.filter((r) => r.recall === 1).length,
    unauthorizedPaths: results.reduce((t, r) => t + r.unauthorizedAssertionIds.length, 0),
    forbiddenViolations: results.reduce((t, r) => t + r.forbiddenSurfaced.length, 0),
    emptinessViolations: results.filter((r) => r.emptinessViolated).length,
    unavailableAnswers: results.filter((r) => r.unavailable).length,
    byFamily,
    results,
  };
}
