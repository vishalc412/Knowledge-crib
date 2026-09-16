import { createGraphAssertion, isGraphRef, isGraphSegment } from './graph.js';
import type { MemoryGraphPredicate } from './graph.js';
/**
 * WP-G1 backfill — the PURE derivation from existing structured record fields to graph
 * assertions (the plan's WP-G1 items 6–7):
 *
 *   "Backfill only relationships directly supported by existing structured fields.
 *    Report unresolved subjects and missing evidence anchors instead of inventing links.
 *    Do not rewrite existing memory IDs during backfill."
 *
 * Every law below is a direct reading of that text:
 *
 *  - `about`        — record → `record.subject`, when the subject is a well-formed traversal
 *                     ref (`isGraphRef`). A subject the graph universe cannot name is REPORTED
 *                     (`unresolvedSubjects`), never linked.
 *  - `supported-by` — record → each `valid`-verdict evidence anchor (soul / artifact /
 *                     attestation / receipt ids). An anchor equal to the record's own subject
 *                     is omitted (a self-edge carries no traversal information — the claim
 *                     already says it), and a non-ref anchor is REPORTED (`missingAnchors`),
 *                     never linked. An `invalid`/`degraded` item contributes nothing: its own
 *                     check did not pass, so asserting the support would be an invented link.
 *                     A `valid` item naming NO anchor is REPORTED too — a check that passed
 *                     but links the record to nothing the graph can address is a missing
 *                     evidence anchor, not a silent drop.
 *  - `derived-from` / `supersedes` / `contradicts` — record → each lineage ref that names a
 *                     record PRESENT in the input set. A lineage ref outside the set is
 *                     REPORTED (`missingAnchors`) — a dangling relationship is a report, not
 *                     a guess — and a ref naming the record ITSELF is omitted like any other
 *                     self-edge.
 *  - `part-of`      — entity member → `entity.ref`, from the entity table's `members` (the
 *                     only structured field that states symbol ownership). A malformed
 *                     member is REPORTED, never linked; a member equal to the entity's own
 *                     ref is omitted (a self-edge).
 *
 * A record whose `namespace.projectId` is not a legal graph repoId segment cannot be placed
 * in any scope; it is REPORTED (`unplacedScopes`) and skipped — one unplaceable record never
 * aborts the rest of the run.
 *
 * Timestamps are NEVER taken from the clock: record-derived edges carry the record's
 * `validTime.from` (validAt) and `transactionTime.recordedAt` (knownAt) — immutable, so a
 * repeated backfill re-derives the same content-addressed ids and the store's submit path
 * sees a byte-identical no-op (the WP-G1 exit criterion). Structural `part-of` edges have no
 * record to stamp them, so they carry {@link GRAPH_BACKFILL_EPOCH} — a FIXED stamp, because
 * the assertion id seeds on `validAt` and a wall-clock stamp would mint a NEW id per run,
 * duplicating the same triple instead of re-addressing it.
 *
 * The function is pure: it reads records + entities, returns assertions, and never touches a
 * store, a file, or an existing memory id — the record and entity objects are not even
 * mutated. Submitting the returned assertions is the caller's explicit step
 * (`MemoryStore.submitGraphEntries`), which re-validates every one of them.
 */
import type { GraphAssertion, GraphEntity, MemoryEvidence, MemoryProvenance } from './types.js';
import type { MemoryRecordV3 } from './types.js';

/**
 * The fixed validAt/knownAt stamp for STRUCTURAL edges (`part-of`): their truth is as old as
 * the entity table itself, and the stamp must never move — see the module doc.
 */
export const GRAPH_BACKFILL_EPOCH = '1970-01-01T00:00:00.000Z';

/** A record whose subject the graph universe cannot name — reported, never linked. */
export interface GraphBackfillUnresolvedSubject {
  recordId: string;
  subject: string;
}

/** A record whose namespace.projectId is not a legal graph repoId segment — its scope cannot
 * be placed, so none of its edges are derived. Reported, never linked (and never thrown: one
 * unplaceable record must not abort the whole backfill run). */
export interface GraphBackfillUnplacedScope {
  recordId: string;
  projectId: string;
}

/** A structured reference the backfill could not confirm — reported, never linked. */
export interface GraphBackfillMissingAnchor {
  /** The record (or entity) whose structured field carried the dangling reference. */
  ownerId: string;
  /** Which derivation law refused it. */
  relation: 'supported-by' | 'derived-from' | 'supersedes' | 'contradicts' | 'part-of';
  /** The unresolvable reference, exactly as the structured field stated it. */
  ref: string;
}

/** Per-law counts, so a backfill run can be diffed and audited without re-deriving. */
export interface GraphBackfillStats {
  recordsConsidered: number;
  entitiesConsidered: number;
  derived: number;
  about: number;
  supportedBy: number;
  derivedFrom: number;
  supersedes: number;
  contradicts: number;
  partOf: number;
  /** Self-edges omitted: an evidence anchor equal to the record's own subject, a lineage ref
   * equal to the record's own id, an entity member equal to the entity's own ref — a self-edge
   * carries no traversal information, so it is never linked, in any derivation law. */
  skippedSelfAnchors: number;
  /** Evidence items whose own verdict is not `valid` — no anchor may be asserted from them. */
  skippedInvalidEvidence: number;
  unresolvedSubjects: number;
  missingAnchors: number;
  unplacedScopes: number;
}

export interface GraphBackfillReport {
  /** Validated assertions, sorted by id and unique by id — deterministic for the same inputs. */
  assertions: GraphAssertion[];
  unresolvedSubjects: GraphBackfillUnresolvedSubject[];
  missingAnchors: GraphBackfillMissingAnchor[];
  unplacedScopes: GraphBackfillUnplacedScope[];
  stats: GraphBackfillStats;
}

/** The `(predicate, subject, object)` identity of an assertion — the corpus's edge shape. */
export function graphAssertionTriple(a: GraphAssertion): {
  predicate: MemoryGraphPredicate;
  subject: string;
  object: string;
} {
  // `GraphAssertion.predicate` is typed `string` (the runtime schema is the authority); every
  // assertion reaching here passed createGraphAssertion, so the predicate IS in the union.
  return { predicate: a.predicate as MemoryGraphPredicate, subject: a.subject, object: a.object };
}

/**
 * The evidence anchors one `valid` evidence item states — each kind's structured id fields,
 * nothing else. Non-string or empty values yield nothing; a `valid` item ALL of whose anchor
 * fields are absent is the caller's report to make (see the anchorless law in the derivation).
 */
function evidenceAnchors(item: MemoryEvidence): string[] {
  const anchors: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) anchors.push(value);
  };
  push(item.soulId); // source-quote
  push(item.artifactId); // committed-policy
  push(item.attestationId); // human-attestation
  push(item.receiptId); // execution-assertion
  push(item.failingReceiptId); // receipt-pair (both halves of the pair)
  push(item.passingReceiptId);
  return anchors;
}

/** The store placement a record's namespace states: projectId → repo scope, absent → global. */
function scopeForRecord(
  record: MemoryRecordV3,
): { boundary: 'repo'; repoId: string } | { boundary: 'global' } {
  const projectId = record.namespace.projectId;
  return typeof projectId === 'string' && projectId.length > 0
    ? { boundary: 'repo', repoId: projectId }
    : { boundary: 'global' };
}

/**
 * Derive graph assertions from existing structured fields — see the module doc for the laws.
 * Pure and total: it throws only if a derived entry fails the graph schema (an upstream
 * contract break worth failing loudly on, not a per-record condition), and it never mutates
 * its inputs. Records are memory-3 envelopes only — a v2 record carries no namespace, so it
 * has no scope to derive from; migrate it first (migrations.ts) and backfill the v3 form.
 */
export function deriveAssertionsFromRecords(
  records: readonly MemoryRecordV3[],
  entities: readonly GraphEntity[],
  provenance: MemoryProvenance,
): GraphBackfillReport {
  const assertions: GraphAssertion[] = [];
  const unresolvedSubjects: GraphBackfillUnresolvedSubject[] = [];
  const missingAnchors: GraphBackfillMissingAnchor[] = [];
  const unplacedScopes: GraphBackfillUnplacedScope[] = [];
  let skippedSelfAnchors = 0;
  let skippedInvalidEvidence = 0;

  const recordIds = new Set(records.map((r) => r.id));

  for (const record of records) {
    const scope = scopeForRecord(record);
    // A repo scope the graph cannot place — record-v3 allows any non-empty projectId, the
    // graph SEGMENT grammar does not. One unplaceable record is a REPORT, never a throw that
    // would silently lose every other record's edges.
    if (scope.boundary === 'repo' && !isGraphSegment(scope.repoId)) {
      unplacedScopes.push({ recordId: record.id, projectId: scope.repoId });
      continue;
    }
    const meta = { origin: 'backfill', source: record.id };
    // The graph law pins `namespace.principalId === provenance.principalId`, and ONE backfill
    // call spans records from multiple principals — so the principal is stamped per-record from
    // the record's own namespace, while the caller's session metadata (device, actor, client)
    // rides along unchanged. Provenance is excluded from the grel id seed, so determinism holds.
    const recordProvenance: MemoryProvenance = {
      ...provenance,
      principalId: record.namespace.principalId,
    };

    // about — the subject must be a ref the universe can name.
    if (isGraphRef(record.subject)) {
      assertions.push(
        createGraphAssertion({
          predicate: 'about',
          subject: record.id,
          object: record.subject,
          namespace: record.namespace,
          scope,
          validAt: record.validTime.from,
          knownAt: record.transactionTime.recordedAt,
          supportedBy: [record.id],
          provenance: recordProvenance,
          meta,
        }),
      );
    } else {
      unresolvedSubjects.push({ recordId: record.id, subject: record.subject });
    }

    // supported-by — anchors from valid evidence, minus the subject self-edge.
    for (const item of record.evidence) {
      if (item.verdict !== 'valid') {
        skippedInvalidEvidence += 1;
        continue;
      }
      const anchors = evidenceAnchors(item);
      if (anchors.length === 0) {
        // A `valid` item naming NO anchor — its check passed, but it links the record to
        // nothing the graph can address. The plan's item 7 makes this a report, not a
        // silent drop.
        missingAnchors.push({
          ownerId: record.id,
          relation: 'supported-by',
          ref: `<absent-anchor:${item.kind}>`,
        });
        continue;
      }
      for (const anchor of anchors) {
        if (anchor === record.subject) {
          skippedSelfAnchors += 1;
          continue; // the claim's own subject — no traversal information
        }
        if (!isGraphRef(anchor)) {
          missingAnchors.push({ ownerId: record.id, relation: 'supported-by', ref: anchor });
          continue; // an anchor the universe cannot name is a report, not a link
        }
        assertions.push(
          createGraphAssertion({
            predicate: 'supported-by',
            subject: record.id,
            object: anchor,
            namespace: record.namespace,
            scope,
            validAt: record.validTime.from,
            knownAt: record.transactionTime.recordedAt,
            supportedBy: [record.id],
            provenance: recordProvenance,
            meta,
          }),
        );
      }
    }

    // lineage — append-only relationships to records PRESENT in the input set.
    const lineage: { predicate: 'derived-from' | 'supersedes' | 'contradicts'; refs: string[] }[] =
      [
        { predicate: 'derived-from', refs: record.lineage.derivedFrom ?? [] },
        { predicate: 'supersedes', refs: record.lineage.supersedes ?? [] },
        { predicate: 'contradicts', refs: record.lineage.contradicts ?? [] },
      ];
    for (const { predicate, refs } of lineage) {
      for (const ref of refs) {
        if (ref === record.id) {
          skippedSelfAnchors += 1;
          continue; // a record naming itself — no traversal information
        }
        if (!isGraphRef(ref) || !recordIds.has(ref)) {
          missingAnchors.push({ ownerId: record.id, relation: predicate, ref });
          continue; // dangling lineage — a report, never a guess
        }
        assertions.push(
          createGraphAssertion({
            predicate,
            subject: record.id,
            object: ref,
            namespace: record.namespace,
            scope,
            validAt: record.validTime.from,
            knownAt: record.transactionTime.recordedAt,
            supportedBy: [record.id],
            provenance: recordProvenance,
            meta,
          }),
        );
      }
    }
  }

  // part-of — the entity table's members, stamped at the fixed structural epoch.
  for (const entity of entities) {
    const members = new Set(entity.members ?? []);
    // The same graph law as records: the principal comes from the entry's own namespace.
    const entityProvenance: MemoryProvenance = {
      ...provenance,
      principalId: entity.namespace.principalId,
    };
    for (const member of members) {
      if (member === entity.ref) {
        skippedSelfAnchors += 1;
        continue; // the entity owning itself — no traversal information
      }
      if (!isGraphRef(member)) {
        missingAnchors.push({ ownerId: entity.id, relation: 'part-of', ref: member });
        continue;
      }
      assertions.push(
        createGraphAssertion({
          predicate: 'part-of',
          subject: member,
          object: entity.ref,
          namespace: entity.namespace,
          scope: entity.scope,
          validAt: GRAPH_BACKFILL_EPOCH,
          knownAt: GRAPH_BACKFILL_EPOCH,
          supportedBy: [entity.ref], // the entity's own registration vouches for the membership
          provenance: entityProvenance,
          meta: { origin: 'backfill', source: entity.id },
        }),
      );
    }
  }

  // Deterministic output: unique by id, sorted by id — the byte-level no-op property holds
  // across runs. Duplicates arise WITHIN one derivation (a repeated lineage ref, two valid
  // evidence items naming the same anchor, two same-ref entities sharing a member): the grel
  // id seeds exactly the triple + principal + scope + validAt, so the repeated inputs mint
  // the identical id twice. Collapse by id — the objects are content-identical by
  // construction — so the report's uniqueness contract and the per-law stats hold.
  const uniqueById = new Map<string, GraphAssertion>();
  for (const a of assertions) if (!uniqueById.has(a.id)) uniqueById.set(a.id, a);
  const deduped = [...uniqueById.values()];
  deduped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const count = (predicate: MemoryGraphPredicate): number =>
    deduped.reduce((n, a) => (a.predicate === predicate ? n + 1 : n), 0);

  return {
    assertions: deduped,
    unresolvedSubjects,
    missingAnchors,
    unplacedScopes,
    stats: {
      recordsConsidered: records.length,
      entitiesConsidered: entities.length,
      derived: deduped.length,
      about: count('about'),
      supportedBy: count('supported-by'),
      derivedFrom: count('derived-from'),
      supersedes: count('supersedes'),
      contradicts: count('contradicts'),
      partOf: count('part-of'),
      skippedSelfAnchors,
      skippedInvalidEvidence,
      unresolvedSubjects: unresolvedSubjects.length,
      missingAnchors: missingAnchors.length,
      unplacedScopes: unplacedScopes.length,
    },
  };
}
