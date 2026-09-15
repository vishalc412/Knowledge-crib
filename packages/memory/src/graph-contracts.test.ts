/**
 * Contract pins for the WP-G1 connected-memory-graph domain: the bounded predicate vocabulary,
 * the content-addressed graph id seeds, the entity `ref` convention, and the strict validation
 * laws (unknown-version fail-closed, admission const, ref grammar, namespace ownership,
 * self-alias refusal). These tests freeze the CONTRACTS the storage (commit 2) and backfill
 * (commit 3) work packages build on — a broken pin means the graph domain drifted, not that the
 * test should be relaxed.
 */

import { describe, expect, it } from 'vitest';
import { GRAPH_PREDICATES, buildGraphCorpus } from './graph-corpus/corpus.js';
import {
  GRAPH_REF_PREFIXES,
  MEMORY_GRAPH_PREDICATES,
  createGraphAssertion,
  createGraphEntity,
  createGraphResolutionDecision,
  isGraphRef,
  isMemoryGraphPredicate,
  isWellFormedGraphScope,
} from './graph.js';
import { graphAssertionId, graphEntityId, graphResolutionId } from './ids.js';
import { GRAPH_ASSERTION_SCHEMA } from './schemas.js';
import type { MemoryNamespace, MemoryProvenance } from './types.js';
import {
  MemorySchemaError,
  assertValidGraphAssertion,
  assertValidGraphEntity,
  assertValidGraphResolutionDecision,
  assertValidMemoryEntry,
} from './validate.js';

const corpus = buildGraphCorpus();

// ─── fixtures ─────────────────────────────────────────────────────────────────

const NAMESPACE: MemoryNamespace = {
  principalId: corpus.principals.alpha,
  workspaceId: 'workspace:graph-contracts',
};
const OTHER_NAMESPACE: MemoryNamespace = {
  principalId: corpus.principals.beta,
  workspaceId: 'workspace:graph-contracts',
};
const PROVENANCE: MemoryProvenance = {
  principalId: corpus.principals.alpha,
  deviceId: 'device:graph-contracts',
  actorId: 'agent:graph-contracts',
  clientId: 'vitest',
};
const REPO_SCOPE = { boundary: 'repo', repoId: corpus.repoIds.ledger } as const;
const GLOBAL_SCOPE = { boundary: 'global' } as const;
const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';

const entityInput = {
  kind: 'service',
  name: 'OrderService',
  namespace: NAMESPACE,
  scope: REPO_SCOPE,
  provenance: PROVENANCE,
} as const;

const assertionInput = {
  predicate: 'about',
  subject: 'mem:0123456789abcdef',
  object: 'topic:ledger-retry-idempotency',
  namespace: NAMESPACE,
  scope: REPO_SCOPE,
  validAt: T0,
  knownAt: T1,
  supportedBy: ['mem:0123456789abcdef'],
  provenance: PROVENANCE,
} as const;

// ─── the bounded predicate vocabulary ─────────────────────────────────────────

describe('graph predicate vocabulary', () => {
  it('pins the domain vocabulary equal to the frozen corpus vocabulary', () => {
    // The corpus (WP-G0, frozen) and the domain (WP-G1, production) each declare the eight
    // predicates independently — the domain must not import the corpus fixture module, so this
    // pin is what guarantees they never drift apart.
    expect([...MEMORY_GRAPH_PREDICATES].sort()).toEqual([...GRAPH_PREDICATES].sort());
    expect(MEMORY_GRAPH_PREDICATES).toHaveLength(8);
  });

  it('recognizes exactly the eight bounded predicates', () => {
    for (const predicate of GRAPH_PREDICATES) {
      expect(isMemoryGraphPredicate(predicate)).toBe(true);
    }
    expect(isMemoryGraphPredicate('relates-to')).toBe(false);
    expect(isMemoryGraphPredicate('')).toBe(false);
  });
});

// ─── content-addressed graph ids ──────────────────────────────────────────────

describe('graph entity ids', () => {
  it('derives the same id from the same identity seed', () => {
    expect(graphEntityId(entityInput)).toBe(graphEntityId(entityInput));
    expect(graphEntityId(entityInput)).toMatch(/^gent:[0-9a-f]+$/);
  });

  it('excludes editable metadata (members, labels) from the id seed', () => {
    // Re-registering an entity with grown membership must derive the SAME id — membership is
    // upserted, never re-addressed (the plan's idempotent-submission law).
    expect(graphEntityId({ ...entityInput, members: ['sym:a', 'sym:b'] })).toBe(
      graphEntityId(entityInput),
    );
    expect(graphEntityId({ ...entityInput, labels: ['payment'] })).toBe(graphEntityId(entityInput));
  });

  it('excludes meta, workspace, and provenance churn from the id seed', () => {
    // The seed is {kind, name, namespace.principalId, scopeHash} ONLY: re-importing the same
    // entity after a workspace move, an agent re-run (new session/provenance), or a metadata
    // edit must derive the SAME id — anything else fragments one entity into many.
    expect(graphEntityId({ ...entityInput, meta: { tier: 'gold' } })).toBe(
      graphEntityId(entityInput),
    );
    expect(
      graphEntityId({
        ...entityInput,
        namespace: { ...NAMESPACE, workspaceId: 'workspace:other' },
      }),
    ).toBe(graphEntityId(entityInput));
    expect(
      graphEntityId({
        ...entityInput,
        provenance: { ...PROVENANCE, sessionId: 'session:re-run', tool: 'cli' },
      }),
    ).toBe(graphEntityId(entityInput));
  });

  it('re-addresses for a different principal, scope, kind, or name', () => {
    expect(graphEntityId({ ...entityInput, namespace: OTHER_NAMESPACE })).not.toBe(
      graphEntityId(entityInput),
    );
    expect(graphEntityId({ ...entityInput, scope: GLOBAL_SCOPE })).not.toBe(
      graphEntityId(entityInput),
    );
    expect(graphEntityId({ ...entityInput, kind: 'concept' })).not.toBe(graphEntityId(entityInput));
    expect(graphEntityId({ ...entityInput, name: 'PaymentService' })).not.toBe(
      graphEntityId(entityInput),
    );
  });
});

describe('graph assertion ids', () => {
  it('is deterministic and scoped by content identity', () => {
    expect(graphAssertionId(assertionInput)).toBe(graphAssertionId(assertionInput));
    expect(graphAssertionId(assertionInput)).toMatch(/^grel:[0-9a-f]+$/);
    expect(graphAssertionId({ ...assertionInput, namespace: OTHER_NAMESPACE })).not.toBe(
      graphAssertionId(assertionInput),
    );
    expect(graphAssertionId({ ...assertionInput, scope: GLOBAL_SCOPE })).not.toBe(
      graphAssertionId(assertionInput),
    );
    expect(graphAssertionId({ ...assertionInput, validAt: T1 })).not.toBe(
      graphAssertionId(assertionInput),
    );
  });

  it('excludes knownAt and supportedBy from the seed (repeat imports collapse)', () => {
    // knownAt is transaction time — the same assertion learned at a different moment must keep
    // its id; supporters are merged at submit time, never part of identity.
    expect(graphAssertionId({ ...assertionInput, knownAt: T0 })).toBe(
      graphAssertionId(assertionInput),
    );
    expect(graphAssertionId({ ...assertionInput, supportedBy: ['mem:other'] })).toBe(
      graphAssertionId(assertionInput),
    );
  });

  it('re-addresses for a different predicate, subject, or object', () => {
    // The seed is {predicate, subject, object, namespace.principalId, scopeHash, validAt}; each
    // leg of the triple must move the id, or two DIFFERENT claims collapse onto one storage row
    // and the second write silently overwrites the first.
    expect(graphAssertionId({ ...assertionInput, predicate: 'applies-to' })).not.toBe(
      graphAssertionId(assertionInput),
    );
    expect(graphAssertionId({ ...assertionInput, subject: 'mem:fedcba9876543210' })).not.toBe(
      graphAssertionId(assertionInput),
    );
    expect(
      graphAssertionId({ ...assertionInput, object: 'topic:checkout-retry-idempotency' }),
    ).not.toBe(graphAssertionId(assertionInput));
  });

  it('excludes meta, workspace, and provenance churn from the seed (as entities do)', () => {
    expect(graphAssertionId({ ...assertionInput, meta: { confidence: 0.9 } })).toBe(
      graphAssertionId(assertionInput),
    );
    expect(
      graphAssertionId({
        ...assertionInput,
        namespace: { ...NAMESPACE, workspaceId: 'workspace:other' },
      }),
    ).toBe(graphAssertionId(assertionInput));
    expect(
      graphAssertionId({
        ...assertionInput,
        provenance: { ...PROVENANCE, sessionId: 'session:re-run', tool: 'cli' },
      }),
    ).toBe(graphAssertionId(assertionInput));
  });
});

describe('graph resolution-decision ids', () => {
  it('seeds {kind, entityA, entityB} only', () => {
    const input = {
      kind: 'establish',
      entityA: 'entity:graph-corpus-ledger/OrderService',
      entityB: 'entity:ledger/OrderService',
    } as const;
    expect(graphResolutionId(input)).toBe(graphResolutionId(input));
    expect(graphResolutionId(input)).toMatch(/^gres:[0-9a-f]+$/);
    expect(graphResolutionId({ ...input, kind: 'reverse' })).not.toBe(graphResolutionId(input));
    expect(graphResolutionId({ ...input, entityA: 'entity:other/OrderService' })).not.toBe(
      graphResolutionId(input),
    );
    expect(graphResolutionId({ ...input, entityB: 'entity:other/OrderService' })).not.toBe(
      graphResolutionId(input),
    );
  });
});

// ─── the entity ref convention (corpus pin) ──────────────────────────────────

describe('graph entity refs', () => {
  it('derives the corpus entity id for every corpus fixture (pin)', () => {
    // The corpus freezes traversal node ids like `entity:<repoId>` and
    // `entity:<repoId>/<name>`; the domain's `ref` must reproduce them exactly, or WP-G5
    // retrieval cannot be judged against the corpus universe.
    for (const fixture of corpus.entities) {
      const entity = createGraphEntity({
        kind: fixture.type,
        name: fixture.name,
        namespace: NAMESPACE,
        scope: { boundary: 'repo', repoId: fixture.repoId },
        provenance: PROVENANCE,
      });
      expect(entity.ref, fixture.id).toBe(fixture.id);
    }
  });

  it('addresses same-named services in different repos to different refs', () => {
    const ledger = createGraphEntity(entityInput);
    const checkout = createGraphEntity({
      ...entityInput,
      scope: { boundary: 'repo', repoId: corpus.repoIds.checkout },
    });
    expect(ledger.ref).not.toBe(checkout.ref);
    expect(checkout.ref).toBe(`entity:${corpus.repoIds.checkout}/OrderService`);
  });

  it('addresses repository-kind entities as the repo itself and global entities by name', () => {
    const repo = createGraphEntity({
      kind: 'repository',
      name: 'graph-corpus-ledger',
      namespace: NAMESPACE,
      scope: REPO_SCOPE,
      provenance: PROVENANCE,
    });
    expect(repo.ref).toBe(`entity:${corpus.repoIds.ledger}`);
    const concept = createGraphEntity({
      kind: 'concept',
      name: 'idempotency',
      namespace: NAMESPACE,
      scope: GLOBAL_SCOPE,
      provenance: PROVENANCE,
    });
    expect(concept.ref).toBe('entity:idempotency');
  });
});

// ─── the traversal-ref grammar and the scope law ──────────────────────────────

describe('graph ref grammar and scope law', () => {
  it('pins the schema subject/object pattern to GRAPH_REF_PREFIXES exactly', () => {
    // The endpoint grammar is DECLARED TWICE: once as GRAPH_REF_PREFIXES in the domain (what
    // runtime guards check) and once as the regex alternation inside graph-assertion.schema.json
    // (what validation enforces). This pin derives the regex from the domain list and demands
    // byte-equality with the schema — a drift on either side fails here instead of silently
    // accepting (or rejecting) a ref kind the other side never heard of.
    const expected = `^(${GRAPH_REF_PREFIXES.join('|')}):.+$`;
    const schema = GRAPH_ASSERTION_SCHEMA as {
      properties: { subject: { pattern: string }; object: { pattern: string } };
    };
    expect(schema.properties.subject.pattern).toBe(expected);
    expect(schema.properties.object.pattern).toBe(expected);
  });

  it('recognizes exactly the eight ref prefixes through isGraphRef', () => {
    for (const prefix of GRAPH_REF_PREFIXES) {
      expect(isGraphRef(`${prefix}:x`), prefix).toBe(true);
    }
    // Unknown prefix, empty local part, and a bare prefix-less string all fail closed.
    expect(isGraphRef('relates-to:x')).toBe(false);
    expect(isGraphRef('mem:')).toBe(false);
    expect(isGraphRef('topic')).toBe(false);
    expect(isGraphRef('')).toBe(false);
  });

  it('enforces the placement law through isWellFormedGraphScope', () => {
    expect(isWellFormedGraphScope({ boundary: 'repo', repoId: 'graph-corpus-ledger' })).toBe(true);
    expect(isWellFormedGraphScope({ boundary: 'repo' })).toBe(false);
    expect(isWellFormedGraphScope({ boundary: 'repo', repoId: '' })).toBe(false);
    expect(isWellFormedGraphScope({ boundary: 'global' })).toBe(true);
    // A global entry carrying a repoId would leak into repo-scoped projections.
    expect(isWellFormedGraphScope({ boundary: 'global', repoId: 'graph-corpus-ledger' })).toBe(
      false,
    );
  });
});

// ─── review-fix regression pins ──────────────────────────────────────────────

describe('graph review-fix regressions', () => {
  it('rejects a non-array supportedBy before the spread launders it (finding 1)', () => {
    // A dynamic caller bypassing the TS type with a string would spread per-character — each
    // single char passes the schema's `items: {minLength: 1}`. The factory must fail closed
    // BEFORE the spread, not rely on the schema to catch it afterwards.
    expect(() =>
      createGraphAssertion({ ...assertionInput, supportedBy: 'mem:single' as never }),
    ).toThrow(MemorySchemaError);
    try {
      createGraphAssertion({ ...assertionInput, supportedBy: 'mem:single' as never });
    } catch (error) {
      expect((error as MemorySchemaError).errors).toEqual([{ supportedByNotAnArray: true }]);
    }
  });

  it('rejects slashes in entity names and repoIds — the ref-injectivity law (findings 2+8)', () => {
    // `entity:<repoId>/<name>` is injective ONLY while name and repoId stay single-segment; a
    // global `entity:r1/OrderService` would collide with repo r1's `entity:r1/OrderService`.
    expect(() =>
      createGraphEntity({
        ...entityInput,
        name: 'r1/OrderService',
        scope: GLOBAL_SCOPE,
      }),
    ).toThrow(MemorySchemaError);
    expect(() =>
      createGraphEntity({
        ...entityInput,
        scope: { boundary: 'repo', repoId: 'ledger/OrderService' },
      }),
    ).toThrow(MemorySchemaError);
    expect(() =>
      createGraphAssertion({
        ...assertionInput,
        scope: { boundary: 'repo', repoId: 'a/b' },
      }),
    ).toThrow(MemorySchemaError);
  });

  it('fails closed on prototype-chain id prefixes, not into a TypeError (finding 3)', () => {
    // The dispatch tables are plain object literals; a crafted prefix would otherwise walk
    // Object.prototype. `hasOwnProperty:` used to throw a raw TypeError, and `toString:` used
    // to misreport `{unknownSchemaVersion}` — both must be a clean unknownIdPrefix refusal.
    for (const id of ['hasOwnProperty:deadbeef', 'toString:deadbeef']) {
      try {
        assertValidMemoryEntry({ id, schemaVersion: '1' });
        expect.unreachable(`expected ${id} to fail validation`);
      } catch (error) {
        expect(error, id).toBeInstanceOf(MemorySchemaError);
        expect((error as MemorySchemaError).message, id).toMatch(/unknownIdPrefix/);
      }
    }
  });
});

// ─── strict validation ────────────────────────────────────────────────────────

describe('graph entry validation', () => {
  it('validates factory-built entity, assertion, and resolution through the real validators', () => {
    expect(() =>
      assertValidGraphEntity(
        createGraphEntity({ ...entityInput, members: ['sym:x'], labels: ['core'] }),
      ),
    ).not.toThrow();
    expect(() => assertValidGraphAssertion(createGraphAssertion(assertionInput))).not.toThrow();
    expect(() =>
      assertValidGraphResolutionDecision(
        createGraphResolutionDecision({
          kind: 'establish',
          entityA: 'entity:graph-corpus-ledger/OrderService',
          entityB: 'entity:ledger/OrderService',
          actor: 'operator:alpha',
          ts: T0,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects unknown schema versions fail-closed (never coerced to the latest)', () => {
    for (const [entry, label] of [
      [{ ...createGraphEntity(entityInput), schemaVersion: '2' }, 'gent'],
      [{ ...createGraphAssertion(assertionInput), schemaVersion: '9' }, 'grel'],
      [
        {
          ...createGraphResolutionDecision({
            kind: 'establish',
            entityA: 'entity:a',
            entityB: 'entity:b',
            actor: 'operator:alpha',
            ts: T0,
          }),
          schemaVersion: '2',
        },
        'gres',
      ],
    ] as const) {
      expect(() => assertValidMemoryEntry(entry), label).toThrow(MemorySchemaError);
      try {
        assertValidMemoryEntry(entry);
      } catch (error) {
        expect(error).toBeInstanceOf(MemorySchemaError);
        const detail = (error as MemorySchemaError).errors as { unknownSchemaVersion?: unknown }[];
        expect(detail[0]?.unknownSchemaVersion, label).toBeDefined();
      }
    }
  });

  it('rejects predicates outside the vocabulary', () => {
    expect(() =>
      assertValidGraphAssertion(
        createGraphAssertion({ ...assertionInput, predicate: 'relates-to' as never }),
      ),
    ).toThrow(/schema validation failed/);
  });

  it('rejects a caller-supplied admission other than proposed', () => {
    const smuggled = {
      ...createGraphAssertion(assertionInput),
      admission: 'trusted',
    } as Record<string, unknown>;
    expect(() => assertValidMemoryEntry(smuggled as never)).toThrow(MemorySchemaError);
  });

  it('rejects assertion endpoints outside the ref grammar', () => {
    for (const bad of ['ledger-retry', 'xss:<script>', 'mem:', '']) {
      expect(
        () => assertValidGraphAssertion(createGraphAssertion({ ...assertionInput, subject: bad })),
        bad,
      ).toThrow(MemorySchemaError);
    }
  });

  it('rejects an empty supportedBy list', () => {
    expect(() =>
      assertValidGraphAssertion(createGraphAssertion({ ...assertionInput, supportedBy: [] })),
    ).toThrow(/schema validation failed/);
  });

  it('rejects a namespace that does not own the provenance', () => {
    const foreign = {
      ...assertionInput,
      provenance: { ...PROVENANCE, principalId: 'principal:x' },
    };
    expect(() => assertValidGraphAssertion(createGraphAssertion(foreign))).toThrow(
      /namespacePrincipalMismatch/,
    );
    expect(() =>
      assertValidGraphEntity(
        createGraphEntity({
          ...entityInput,
          provenance: { ...PROVENANCE, principalId: 'principal:x' },
        }),
      ),
    ).toThrow(/namespacePrincipalMismatch/);
  });

  it('rejects repo scope without a repoId and global scope carrying one', () => {
    expect(() =>
      assertValidGraphAssertion(
        createGraphAssertion({ ...assertionInput, scope: { boundary: 'repo' } }),
      ),
    ).toThrow(MemorySchemaError);
    expect(() =>
      assertValidGraphAssertion(
        createGraphAssertion({ ...assertionInput, scope: { boundary: 'global', repoId: 'r' } }),
      ),
    ).toThrow(MemorySchemaError);
  });

  it('rejects self-alias resolution decisions', () => {
    const self = {
      kind: 'establish',
      entityA: 'entity:graph-corpus-ledger/OrderService',
      entityB: 'entity:graph-corpus-ledger/OrderService',
      actor: 'operator:alpha',
      ts: T0,
    } as const;
    expect(() => assertValidGraphResolutionDecision(createGraphResolutionDecision(self))).toThrow(
      /selfAlias/,
    );
  });

  it('dispatches gent/grel/gres through assertValidMemoryEntry and fails closed on unknown prefixes', () => {
    const entity = createGraphEntity(entityInput);
    const assertion = createGraphAssertion(assertionInput);
    const resolution = createGraphResolutionDecision({
      kind: 'establish',
      entityA: 'entity:graph-corpus-ledger/OrderService',
      entityB: 'entity:ledger/OrderService',
      actor: 'operator:alpha',
      ts: T0,
    });
    // Spread: assertValidMemoryEntry takes the anonymous-entry shape (`{id} & Record<string,
    // unknown>`); a spread literal widens the interface into an anonymous object type.
    expect(() => assertValidMemoryEntry({ ...entity })).not.toThrow();
    expect(() => assertValidMemoryEntry({ ...assertion })).not.toThrow();
    expect(() => assertValidMemoryEntry({ ...resolution })).not.toThrow();

    const unknown = { id: 'grl:0123456789abcdef', schemaVersion: '1' };
    expect(() => assertValidMemoryEntry(unknown as never)).toThrow(/unknownIdPrefix/);
  });
});

// ─── factory laws ────────────────────────────────────────────────────────────

describe('graph factories', () => {
  it('always stamps admission proposed — the producer may never mint trust', () => {
    // Mirrors the tty:true minting refusal in observe(): admission state is assigned by the
    // pipeline (a later authorized WP), never accepted from the caller.
    const assertion = createGraphAssertion(assertionInput);
    expect(assertion.admission).toBe('proposed');
    expect(() =>
      assertValidMemoryEntry({ ...assertion, admission: 'proposed' } as never),
    ).not.toThrow();
  });

  it('builds entities and assertions that round-trip through assertValidMemoryEntry', () => {
    const entity = createGraphEntity({ ...entityInput, members: ['sym:packages/demo/ledger'] });
    const assertion = createGraphAssertion(assertionInput);
    expect(entity.id).toBe(graphEntityId(entityInput));
    expect(assertion.id).toBe(graphAssertionId(assertionInput));
    expect(assertion.knownAt).toBe(T1);
    expect(assertion.validAt).toBe(T0);
  });
});
