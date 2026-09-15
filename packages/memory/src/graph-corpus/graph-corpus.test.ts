/**
 * Pins for the WP-G0 graph acceptance corpus. These are not retrieval tests — they freeze the
 * corpus's construction invariants so the fixture universe cannot silently drift before the
 * WP-G5 evaluation runs against it: determinism, real-id validation, referential integrity of
 * every expected evidence path, the isolation law, and the multi-hop threshold the §4 GO gate
 * measures. If one of these fails after an edit, the corpus changed — that requires a version
 * bump and a re-run of the pre-registered gates, never an in-place patch to make the pin pass.
 */

import { describe, expect, it } from 'vitest';
import {
  assertValidIntakeCheckpoint,
  assertValidIntakeRequirement,
  assertValidMemoryDecision,
  assertValidMemoryRecordV3,
} from '../validate.js';
import {
  GRAPH_CORPUS_VERSION,
  GRAPH_PREDICATES,
  type GraphQuestion,
  buildGraphCorpus,
} from './corpus.js';

const corpus = buildGraphCorpus();

/** Every node id the corpus can name — the resolution universe for expected paths. */
function universe(): Set<string> {
  const ids = new Set<string>();
  for (const r of corpus.records) ids.add(r.id);
  for (const d of corpus.decisions) ids.add(d.id);
  for (const i of corpus.intakes) ids.add(i.id);
  for (const c of corpus.checkpoints) ids.add(c.id);
  for (const s of corpus.symbols) ids.add(s);
  for (const t of corpus.topics) ids.add(t);
  for (const e of corpus.entities) ids.add(e.id);
  for (const a of corpus.anchors) ids.add(a);
  return ids;
}

const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const intakeById = new Map(corpus.intakes.map((i) => [i.id, i]));

describe('graph corpus determinism', () => {
  it('builds byte-identically twice (frozen corpus law: no Date.now, no randomness)', () => {
    const first = JSON.stringify(buildGraphCorpus());
    const second = JSON.stringify(buildGraphCorpus());
    expect(second).toBe(first);
  });

  it('carries a version and the bounded predicate vocabulary', () => {
    expect(corpus.version).toBe(GRAPH_CORPUS_VERSION);
    expect(GRAPH_CORPUS_VERSION).toBe(1);
    expect([...GRAPH_PREDICATES]).toHaveLength(8);
  });
});

describe('graph corpus fixtures validate through the real builders', () => {
  it('every record re-validates against the memory-3 schema', () => {
    for (const record of corpus.records) {
      expect(() => assertValidMemoryRecordV3(record)).not.toThrow();
    }
  });

  it('every intake and checkpoint re-validates', () => {
    for (const intake of corpus.intakes) {
      expect(() => assertValidIntakeRequirement(intake)).not.toThrow();
    }
    for (const checkpoint of corpus.checkpoints) {
      expect(() => assertValidIntakeCheckpoint(checkpoint)).not.toThrow();
    }
  });

  it('the supersede decision re-validates', () => {
    for (const decision of corpus.decisions) {
      expect(() => assertValidMemoryDecision(decision)).not.toThrow();
    }
  });

  it('has unique record ids, intake ids, and question ids', () => {
    const recordIds = corpus.records.map((r) => r.id);
    expect(new Set(recordIds).size).toBe(recordIds.length);
    const intakeIds = corpus.intakes.map((i) => i.id);
    expect(new Set(intakeIds).size).toBe(intakeIds.length);
    const questionIds = corpus.questions.map((q) => q.id);
    expect(new Set(questionIds).size).toBe(questionIds.length);
  });
});

describe('graph corpus fixture dimensions', () => {
  it('covers two principals and two repositories', () => {
    expect(corpus.principals.alpha).not.toBe(corpus.principals.beta);
    expect(corpus.repoIds.ledger).not.toBe(corpus.repoIds.checkout);
    const principals = new Set(corpus.records.map((r) => r.namespace.principalId));
    expect(principals).toEqual(new Set([corpus.principals.alpha, corpus.principals.beta]));
  });

  it('keeps the rename fixture honest: distinct symbols, distinct revision heads, closed window', () => {
    const { renamedCode } = corpus;
    expect(renamedCode.oldSymbolId).not.toBe(renamedCode.newSymbolId);
    expect(renamedCode.revisionBefore.head).not.toBe(renamedCode.revisionAfter.head);
    expect(renamedCode.revisionBefore.symbols).toContain(renamedCode.oldSymbolId);
    expect(renamedCode.revisionAfter.symbols).toContain(renamedCode.newSymbolId);
    expect(renamedCode.revisionAfter.symbols).not.toContain(renamedCode.oldSymbolId);

    // The pre-rename claim's valid window closes exactly when the rename lands.
    const oldClaim = corpus.records.find((r) => r.subject === renamedCode.oldSymbolId);
    const newClaim = corpus.records.find((r) => r.subject === renamedCode.newSymbolId);
    expect(oldClaim?.validTime.to).toBeDefined();
    expect(newClaim?.validTime.to).toBeUndefined();
    expect(oldClaim!.validTime.to!).toBe(newClaim!.validTime.from);
    expect(newClaim!.lineage.derivedFrom).toContain(oldClaim!.id);
  });

  it('retains both sides of the contradiction, mutually linked, with the same proposition key', () => {
    const windowClaims = corpus.records.filter((r) => r.subject === 'topic:ledger-retry-window');
    expect(windowClaims).toHaveLength(2);
    const first = windowClaims[0]!;
    const second = windowClaims[1]!;
    expect(first.lineage.contradicts).toContain(second.id);
    expect(second.lineage.contradicts).toContain(first.id);
    expect(first.propositionKey).toBe(second.propositionKey);
    expect(first.claim).not.toBe(second.claim);
  });

  it('records the supersession as an append-only decision, never a rewrite', () => {
    expect(corpus.decisions).toHaveLength(1);
    const decision = corpus.decisions[0]!;
    expect(decision.kind).toBe('supersede');
    const superseded = recordById.get(decision.subject);
    const successor = recordById.get(decision.successor!);
    expect(superseded?.subject).toBe(successor?.subject);
    expect(superseded?.claim).not.toBe(successor?.claim);
    expect(successor?.lineage.supersedes).toContain(superseded!.id);
    expect(superseded?.lineage.supersedes ?? []).toHaveLength(0);
  });

  it('keeps exactly one terminal intake checkpoint, and open ones state a next safe action', () => {
    const terminal = corpus.checkpoints.filter(
      (c) => c.kind === 'completed' || c.kind === 'cancelled',
    );
    expect(terminal.map((c) => c.intakeId)).toEqual([corpus.intakeIds.alphaDone]);
    expect(terminal[0]!.phase).toBe('complete');
    for (const checkpoint of corpus.checkpoints) {
      if (checkpoint.kind !== 'completed' && checkpoint.kind !== 'cancelled') {
        expect(checkpoint.nextSafeAction, checkpoint.id).toBeTruthy();
      }
    }
    // Every checkpoint references an intake in the corpus.
    for (const checkpoint of corpus.checkpoints) {
      expect(intakeById.has(checkpoint.intakeId), checkpoint.intakeId).toBe(true);
    }
  });

  it('does not silently merge the same-named OrderService entities', () => {
    const os = corpus.entities.filter((e) => e.name === 'OrderService');
    expect(os).toHaveLength(2);
    expect(new Set(os.map((e) => e.id)).size).toBe(2);
    expect(new Set(os.map((e) => e.repoId)).size).toBe(2);
  });

  it('holds one global convention owned by alpha and one global decoy', () => {
    expect(corpus.recordsByRole.alphaGlobal).toHaveLength(1);
    expect(corpus.globalDecoys).toHaveLength(1);
    const decoy = corpus.globalDecoys[0]!;
    expect(decoy.namespace.principalId).toBe(corpus.principals.alpha);
    expect(corpus.questions.every((q) => !q.expected.claimIds.includes(decoy.id))).toBe(true);
  });
});

describe('graph corpus questions', () => {
  it('freezes the exact question-set size the pre-registration commits (129/117/12)', () => {
    const seeds = new Set(corpus.questions.map((q) => q.id.replace(/-(e|p|c)$/, '')));
    expect(seeds.size).toBe(43);
    expect(corpus.questions).toHaveLength(129);
    const multiHop = corpus.questions.filter((q) => q.expected.hops.length >= 2);
    expect(multiHop).toHaveLength(117);
    const zeroHop = corpus.questions.filter((q) => q.expected.hops.length === 0);
    expect(zeroHop).toHaveLength(12);
  });

  it('splits every seed into distinct exact, paraphrase, and context variants', () => {
    const bySeed = new Map<string, GraphQuestion[]>();
    for (const q of corpus.questions) {
      const seed = q.id.replace(/-(e|p|c)$/, '');
      const bucket = bySeed.get(seed) ?? [];
      bucket.push(q);
      bySeed.set(seed, bucket);
    }
    expect(bySeed.size).toBeGreaterThan(0);
    for (const [seed, bucket] of bySeed) {
      expect(bucket, seed).toHaveLength(3);
      const variants = new Set(bucket.map((q) => q.variant));
      expect(variants, seed).toEqual(new Set(['exact', 'paraphrase', 'context']));
      const texts = new Set(bucket.map((q) => q.question));
      expect(texts.size, seed).toBe(3);
      // All variants of a seed demand the same evidence path.
      const serialized = new Set(bucket.map((q) => JSON.stringify(q.expected)));
      expect(serialized.size, seed).toBe(1);
    }
  });

  it('counts families consistently and covers every family', () => {
    for (const [family, count] of Object.entries(corpus.questionCounts)) {
      const actual = corpus.questions.filter((q) => q.family === family).length;
      expect(actual, family).toBe(count);
      expect(count, family).toBeGreaterThan(0);
    }
  });

  it('resolves every expected id and hop endpoint inside the universe (referential integrity)', () => {
    const ids = universe();
    for (const q of corpus.questions) {
      for (const claimId of q.expected.claimIds) {
        expect(ids.has(claimId), `${q.id}: claimId ${claimId}`).toBe(true);
      }
      for (const symbolId of q.expected.symbolIds ?? []) {
        expect(ids.has(symbolId), `${q.id}: symbolId ${symbolId}`).toBe(true);
      }
      for (const entityId of q.expected.entityIds ?? []) {
        expect(ids.has(entityId), `${q.id}: entityId ${entityId}`).toBe(true);
      }
      for (const intakeId of q.expected.intakeIds ?? []) {
        expect(ids.has(intakeId), `${q.id}: intakeId ${intakeId}`).toBe(true);
      }
      for (const forbidden of q.expected.forbiddenIds ?? []) {
        expect(ids.has(forbidden), `${q.id}: forbiddenId ${forbidden}`).toBe(true);
      }
      for (const hop of q.expected.hops) {
        expect(ids.has(hop.from), `${q.id}: hop from ${hop.from}`).toBe(true);
        expect(ids.has(hop.to), `${q.id}: hop to ${hop.to}`).toBe(true);
        expect(
          GRAPH_PREDICATES.includes(hop.predicate),
          `${q.id}: predicate ${hop.predicate}`,
        ).toBe(true);
      }
      expect(
        [corpus.principals.alpha, corpus.principals.beta].includes(q.principal),
        `${q.id}: principal`,
      ).toBe(true);
    }
  });

  it('upholds the isolation law: every expected claim belongs to the asking principal', () => {
    for (const q of corpus.questions) {
      for (const claimId of q.expected.claimIds) {
        const record = recordById.get(claimId);
        expect(record, `${q.id}: ${claimId}`).toBeDefined();
        expect(record!.namespace.principalId, `${q.id}: ${claimId}`).toBe(q.principal);
      }
    }
    // The emptiness probes are the doc's ZERO-HOP questions: empty expected claims, no hops,
    // and forbiddenIds naming the leak. Exactly twelve, as pre-registered (§3).
    const emptiness = corpus.questions.filter((q) => q.expected.hops.length === 0);
    expect(emptiness).toHaveLength(12);
    for (const q of emptiness) {
      expect(q.expected.claimIds, q.id).toHaveLength(0);
      expect(q.expected.forbiddenIds?.length, q.id).toBeGreaterThan(0);
    }
    // Empty claimIds WITH hops are presence demands (the work family) — they must expect
    // intakes, or an empty answer would satisfy them.
    const presence = corpus.questions.filter(
      (q) => q.expected.claimIds.length === 0 && q.expected.hops.length > 0,
    );
    expect(presence).toHaveLength(6);
    for (const q of presence) {
      expect(q.expected.intakeIds?.length, q.id).toBeGreaterThan(0);
    }
  });

  it('keeps every expected id owned by, or visible through, the asking principal', () => {
    // Which principals can see a symbol/entity: any expected relationship touching it whose
    // supporters include one of that principal's records. This is the law that makes a
    // beta-side question expecting an alpha-only symbol a build-time defect, not a WP-G5 miss.
    const ownersOf = new Map<string, Set<string>>();
    for (const rel of corpus.expectedRelationships) {
      for (const supporter of rel.supportedBy) {
        const principal = recordById.get(supporter)?.namespace.principalId;
        if (!principal) continue;
        for (const endpoint of [rel.from, rel.to]) {
          if (recordById.has(endpoint) || intakeById.has(endpoint)) continue;
          const owners = ownersOf.get(endpoint) ?? new Set<string>();
          owners.add(principal);
          ownersOf.set(endpoint, owners);
        }
      }
    }
    for (const q of corpus.questions) {
      for (const intakeId of q.expected.intakeIds ?? []) {
        expect(intakeById.get(intakeId)?.namespace.principalId, `${q.id}: ${intakeId}`).toBe(
          q.principal,
        );
      }
      for (const id of [...(q.expected.symbolIds ?? []), ...(q.expected.entityIds ?? [])]) {
        expect(ownersOf.get(id)?.has(q.principal), `${q.id}: ${id}`).toBe(true);
      }
      // Expected and forbidden never overlap — an id cannot be both the answer and the leak.
      const expected = new Set([
        ...q.expected.claimIds,
        ...(q.expected.symbolIds ?? []),
        ...(q.expected.entityIds ?? []),
        ...(q.expected.intakeIds ?? []),
      ]);
      for (const forbidden of q.expected.forbiddenIds ?? []) {
        expect(expected.has(forbidden), `${q.id}: ${forbidden}`).toBe(false);
      }
    }
  });

  it('traverses every expected symbol and entity inside the question’s own hops', () => {
    for (const q of corpus.questions) {
      const endpoints = new Set(q.expected.hops.flatMap((hop) => [hop.from, hop.to]));
      for (const id of [...(q.expected.symbolIds ?? []), ...(q.expected.entityIds ?? [])]) {
        expect(endpoints.has(id), `${q.id}: ${id}`).toBe(true);
      }
    }
  });

  it('keeps temporal questions pinned to a fixed knownAt read point', () => {
    const historical = corpus.questions.filter((q) => q.family === 'historical');
    expect(historical.length).toBeGreaterThan(0);
    for (const q of historical) {
      expect(q.knownAt, q.id).toMatch(/^2026-09-\d{2}T\d{2}:00:00\.000Z$/);
    }
    for (const q of corpus.questions) {
      if (q.knownAt !== undefined) {
        expect(q.knownAt).toMatch(/^2026-09-\d{2}T\d{2}:00:00\.000Z$/);
      }
    }
  });
});

describe('graph corpus expected relationships', () => {
  it('keeps every relationship inside the predicate vocabulary and the universe', () => {
    const ids = universe();
    for (const rel of corpus.expectedRelationships) {
      expect(GRAPH_PREDICATES.includes(rel.predicate), rel.predicate).toBe(true);
      expect(ids.has(rel.from), `from ${rel.from}`).toBe(true);
      expect(ids.has(rel.to), `to ${rel.to}`).toBe(true);
      expect(rel.supportedBy.length, `${rel.predicate} ${rel.from}`).toBeGreaterThan(0);
      for (const supporter of rel.supportedBy) {
        expect(ids.has(supporter), `supportedBy ${supporter}`).toBe(true);
      }
    }
    // The mutual contradiction is expressed in both directions.
    const contradicts = corpus.expectedRelationships.filter((r) => r.predicate === 'contradicts');
    expect(contradicts).toHaveLength(2);
  });

  it('records the supersede edge, the derived-from edge, and evidence anchors', () => {
    const predicates = new Set(corpus.expectedRelationships.map((r) => r.predicate));
    expect(predicates).toEqual(new Set([...GRAPH_PREDICATES]));
  });

  it('splits the 44 edges into backfill and capture scope exactly as pre-registered (§2)', () => {
    expect(corpus.expectedRelationships).toHaveLength(44);
    const capture = corpus.expectedRelationships.filter(
      (r) =>
        r.predicate === 'affects' ||
        r.predicate === 'applies-to' ||
        (r.predicate === 'about' && r.from.startsWith('intake:')),
    );
    expect(capture).toHaveLength(9);
    // Every capture-scope edge names its supporter — but its supporter never makes it
    // backfill-derivable; WP-G4 must propose it, WP-G1 must not invent it.
    for (const rel of capture) {
      expect(rel.supportedBy.length, `${rel.predicate} ${rel.from}`).toBeGreaterThan(0);
    }
  });
});
