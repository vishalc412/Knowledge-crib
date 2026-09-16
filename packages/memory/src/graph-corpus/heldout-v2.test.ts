/**
 * Pins for the held-out v2 graph question set. Like the v1 corpus pins, these are construction
 * invariants, not retrieval tests: determinism, size, hop membership in the corpus's expected
 * relationships, and the authorization, temporal, and scope laws — all computed from the built
 * corpus rather than from listed ids, so a question that violates a law fails here.
 */

import { describe, expect, it } from 'vitest';
import { GRAPH_PREDICATES, type GraphQuestion, buildGraphCorpus } from './corpus.js';
import { GRAPH_HELDOUT_CORPUS_VERSION, buildHeldOutGraphQuestions } from './heldout-v2.js';

const corpus = buildGraphCorpus();
const questions = buildHeldOutGraphQuestions(corpus);

const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const intakeById = new Map(corpus.intakes.map((i) => [i.id, i]));
const decisionById = new Map(corpus.decisions.map((d) => [d.id, d]));
const entityById = new Map(corpus.entities.map((e) => [e.id, e]));
const decoyIds = new Set(corpus.globalDecoys.map((r) => r.id));
const supersededIds = new Set(
  corpus.decisions.filter((d) => d.kind === 'supersede').map((d) => d.subject),
);

/** v1 registers every entity under alpha's namespace (the backfill entity table is alpha-owned),
 *  so part-of edges are only answerable for alpha. */
const entityOwner = (_entityId: string): string => corpus.principals.alpha;

/** Owning principal of a record, intake, or decision (a decision is owned via its subject). */
function ownerOf(id: string): string | undefined {
  const record = recordById.get(id);
  if (record) return record.namespace.principalId;
  const intake = intakeById.get(id);
  if (intake) return intake.namespace.principalId;
  const decision = decisionById.get(id);
  if (decision) return recordById.get(decision.subject)?.namespace.principalId;
  return undefined;
}

/** Transaction time at which a record, intake, or decision entered memory. */
function recordedAtOf(id: string): string | undefined {
  return (
    recordById.get(id)?.transactionTime.recordedAt ??
    intakeById.get(id)?.createdAt ??
    decisionById.get(id)?.ts
  );
}

function terminalAtOf(intakeId: string): string | undefined {
  return corpus.checkpoints.find(
    (c) => c.intakeId === intakeId && (c.kind === 'completed' || c.kind === 'cancelled'),
  )?.recordedAt;
}

function inScope(q: GraphQuestion, id: string): boolean {
  const projectId =
    recordById.get(id)?.namespace.projectId ?? intakeById.get(id)?.namespace.projectId;
  if (q.scope.repoId !== undefined) return projectId === q.scope.repoId;
  if (q.scope.global) return projectId === undefined;
  return true;
}

const isMemoryNode = (id: string): boolean => recordById.has(id) || intakeById.has(id);

function relationshipFor(hop: GraphQuestion['expected']['hops'][number]) {
  return corpus.expectedRelationships.find(
    (rel) => rel.predicate === hop.predicate && rel.from === hop.from && rel.to === hop.to,
  );
}

describe('held-out v2 determinism and size', () => {
  it('builds JSON-identically twice', () => {
    const first = JSON.stringify(buildHeldOutGraphQuestions(buildGraphCorpus()));
    const second = JSON.stringify(buildHeldOutGraphQuestions(buildGraphCorpus()));
    expect(second).toBe(first);
    expect(GRAPH_HELDOUT_CORPUS_VERSION).toBe(2);
  });

  it('has >= 110 multi-hop questions, 6..12 emptiness probes, and unique h2- ids', () => {
    const multiHop = questions.filter((q) => q.expected.hops.length >= 2);
    expect(multiHop.length).toBeGreaterThanOrEqual(110);
    const emptiness = questions.filter((q) => q.expected.hops.length === 0);
    expect(emptiness.length).toBeGreaterThanOrEqual(6);
    expect(emptiness.length).toBeLessThanOrEqual(12);
    // Nothing in between: a question is either multi-hop or an emptiness probe.
    expect(multiHop.length + emptiness.length).toBe(questions.length);
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^h2-/);
  });

  it('covers every family and all three variants', () => {
    const families = new Set(questions.map((q) => q.family));
    expect(families).toEqual(
      new Set([
        'current',
        'historical',
        'conflict',
        'isolation',
        'rename',
        'work',
        'cross-repo',
        'decoy',
      ]),
    );
    expect(new Set(questions.map((q) => q.variant))).toEqual(
      new Set(['exact', 'paraphrase', 'context']),
    );
  });
});

describe('held-out v2 independence from v1', () => {
  it('shares no question text with the v1 set, in either containment direction', () => {
    const v1Texts = corpus.questions.map((q) => q.question.toLowerCase());
    for (const q of questions) {
      const text = q.question.toLowerCase();
      for (const v1 of v1Texts) {
        expect(text === v1, `${q.id} equals a v1 question`).toBe(false);
        expect(text.includes(v1), `${q.id} contains a v1 question`).toBe(false);
        expect(v1.includes(text), `${q.id} is contained in a v1 question`).toBe(false);
      }
    }
  });

  it('never stuffs corpus ids or record claim text into question text', () => {
    const ids = [
      ...corpus.records.map((r) => r.id),
      ...corpus.intakes.map((i) => i.id),
      ...corpus.symbols,
      ...corpus.topics,
      ...corpus.entities.map((e) => e.id),
      ...corpus.anchors,
    ];
    const claims = corpus.records.map((r) => r.claim.toLowerCase());
    for (const q of questions) {
      for (const id of ids) expect(q.question.includes(id), `${q.id}: ${id}`).toBe(false);
      for (const claim of claims) {
        expect(q.question.toLowerCase().includes(claim), `${q.id}: claim text`).toBe(false);
      }
    }
  });
});

describe('held-out v2 evidence paths', () => {
  it('uses only hops present in corpus.expectedRelationships', () => {
    for (const q of questions) {
      for (const hop of q.expected.hops) {
        expect(GRAPH_PREDICATES.includes(hop.predicate)).toBe(true);
        expect(
          relationshipFor(hop),
          `${q.id}: ${hop.predicate} ${hop.from} -> ${hop.to}`,
        ).toBeDefined();
      }
    }
  });

  it('traverses every expected claim, intake, symbol, and entity inside its own hops', () => {
    for (const q of questions) {
      const endpoints = new Set(q.expected.hops.flatMap((hop) => [hop.from, hop.to]));
      for (const id of [
        ...q.expected.claimIds,
        ...(q.expected.intakeIds ?? []),
        ...(q.expected.symbolIds ?? []),
        ...(q.expected.entityIds ?? []),
      ]) {
        expect(endpoints.has(id), `${q.id}: ${id}`).toBe(true);
      }
    }
  });

  it('shapes emptiness probes and presence demands honestly', () => {
    for (const q of questions) {
      const expectedIds = new Set([
        ...q.expected.claimIds,
        ...(q.expected.symbolIds ?? []),
        ...(q.expected.entityIds ?? []),
        ...(q.expected.intakeIds ?? []),
      ]);
      for (const forbidden of q.expected.forbiddenIds ?? []) {
        expect(
          expectedIds.has(forbidden),
          `${q.id}: ${forbidden} both expected and forbidden`,
        ).toBe(false);
      }
      if (q.expected.hops.length === 0) {
        expect(expectedIds.size, q.id).toBe(0);
        expect(q.expected.forbiddenIds?.length ?? 0, q.id).toBeGreaterThan(0);
      } else if (q.expected.claimIds.length === 0) {
        expect(q.expected.intakeIds?.length ?? 0, q.id).toBeGreaterThan(0);
      }
    }
  });
});

describe('held-out v2 authorization law', () => {
  it('expects only claims and intakes owned by the asking principal', () => {
    for (const q of questions) {
      for (const id of [...q.expected.claimIds, ...(q.expected.intakeIds ?? [])]) {
        expect(ownerOf(id), `${q.id}: ${id}`).toBe(q.principal);
      }
    }
  });

  it('answers a hop only when the principal owns a supporter (and the entity, for part-of)', () => {
    for (const q of questions) {
      for (const hop of q.expected.hops) {
        const rel = relationshipFor(hop)!;
        const owned = rel.supportedBy.some((supporter) => ownerOf(supporter) === q.principal);
        expect(owned, `${q.id}: ${hop.predicate} ${hop.from} unsupported for ${q.principal}`).toBe(
          true,
        );
        if (hop.predicate === 'part-of') {
          expect(entityById.has(hop.to), `${q.id}: ${hop.to}`).toBe(true);
          expect(entityOwner(hop.to), `${q.id}: part-of ${hop.to}`).toBe(q.principal);
        }
        for (const endpoint of [hop.from, hop.to]) {
          if (isMemoryNode(endpoint)) {
            expect(ownerOf(endpoint), `${q.id}: endpoint ${endpoint}`).toBe(q.principal);
          }
        }
      }
    }
  });
});

describe('held-out v2 temporal and scope laws', () => {
  it('keeps every knownAt hop supported and anchored by then', () => {
    for (const q of questions) {
      if (q.knownAt === undefined) continue;
      expect(q.knownAt).toMatch(/^2026-09-\d{2}T\d{2}:00:00\.000Z$/);
      const knownAt = q.knownAt;
      for (const hop of q.expected.hops) {
        for (const supporter of relationshipFor(hop)!.supportedBy) {
          const recorded = recordedAtOf(supporter);
          expect(recorded, `${q.id}: supporter ${supporter}`).toBeDefined();
          expect(recorded! <= knownAt, `${q.id}: supporter ${supporter} after knownAt`).toBe(true);
        }
        for (const endpoint of [hop.from, hop.to]) {
          if (isMemoryNode(endpoint)) {
            expect(recordedAtOf(endpoint)! <= knownAt, `${q.id}: endpoint ${endpoint}`).toBe(true);
          }
        }
      }
      for (const id of [...q.expected.claimIds, ...(q.expected.intakeIds ?? [])]) {
        expect(recordedAtOf(id)! <= knownAt, `${q.id}: ${id} after knownAt`).toBe(true);
      }
    }
  });

  it('keeps superseded and expired claims out of current (no-knownAt) expectations', () => {
    for (const q of questions) {
      if (q.knownAt !== undefined) continue;
      for (const id of q.expected.claimIds) {
        expect(supersededIds.has(id), `${q.id}: superseded ${id}`).toBe(false);
        expect(recordById.get(id)?.validTime.to, `${q.id}: expired ${id}`).toBeUndefined();
      }
    }
  });

  it('justifies every forbidden id: foreign, not yet recorded, superseded, decoy, out of scope, or closed', () => {
    for (const q of questions) {
      for (const id of q.expected.forbiddenIds ?? []) {
        const entity = entityById.get(id);
        if (entity) {
          expect(
            q.scope.repoId !== undefined && entity.repoId !== q.scope.repoId,
            `${q.id}: forbidden entity ${id}`,
          ).toBe(true);
          continue;
        }
        expect(isMemoryNode(id), `${q.id}: forbidden ${id} is not a memory node`).toBe(true);
        const recorded = recordedAtOf(id)!;
        const terminal = intakeById.has(id) ? terminalAtOf(id) : undefined;
        const justified =
          ownerOf(id) !== q.principal ||
          (q.knownAt !== undefined && recorded > q.knownAt) ||
          (q.knownAt === undefined && supersededIds.has(id)) ||
          decoyIds.has(id) ||
          !inScope(q, id) ||
          (terminal !== undefined && (q.knownAt === undefined || terminal <= q.knownAt));
        expect(justified, `${q.id}: forbidden ${id} has no justification`).toBe(true);
      }
    }
  });

  it('keeps expected claims, intakes, and memory-node hop endpoints inside the question scope', () => {
    for (const q of questions) {
      const ids = [
        ...q.expected.claimIds,
        ...(q.expected.intakeIds ?? []),
        ...q.expected.hops.flatMap((hop) => [hop.from, hop.to]).filter(isMemoryNode),
      ];
      for (const id of ids) expect(inScope(q, id), `${q.id}: ${id} out of scope`).toBe(true);
      if (Object.keys(q.scope).length === 0) {
        // `{}` is reserved for questions that genuinely span both repositories (or repo + global).
        const projects = new Set(
          q.expected.claimIds.map((id) => recordById.get(id)?.namespace.projectId ?? 'global'),
        );
        expect(projects.size, `${q.id}: {} scope spans one project`).toBeGreaterThan(1);
      }
    }
  });
});
