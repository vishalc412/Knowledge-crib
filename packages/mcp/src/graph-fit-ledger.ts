/**
 * The S5 fit ledger — an exact, ledger-local mirror of the serialized context pack.
 *
 * fitGraphContext must decide, per candidate, whether an append or a relation citation fits the
 * budget. The round-0 implementation answered by rebuilding the WHOLE pack per candidate per
 * fixed-point pass — O(projection) each — which is the WP2 round-0 p95 regression (context
 * assembly measured ~3.5s against a 500ms gate). This module answers without touching the
 * projection again: it scans `current`, `historical` and `conflicts` once at construction, then
 * keeps the pack's citation state as small sets (kept items, path ids, relations, conflict
 * groups, history, citations) and re-serializes from those sets alone — a fitted pack carries a
 * few dozen cited assertions, so one measure is O(kept + cited) string work, not a projection walk.
 *
 * The mirror is EXACT, not approximate. `serialize` returns byte-identical JSON to
 * `JSON.stringify({ context: buildGraphContextPack(projection, prefix, traversal, opts),
 * budgetExhausted: true })` — same field order, same sorted assertions, same producer
 * first-cited assignment, same conflict-group order. graph-fit-ledger.test.ts locks the equality
 * on fixtures, because a drifted ledger is a wrong budget decision, and a wrong budget decision
 * is a silently-trimmed answer.
 */
import type {
  GraphAssertion,
  GraphExpansion,
  GraphProjection,
  GraphTraversalReport,
} from '@knowledge-crib/memory';
import { estimateTokens } from './token-budget.js';

export interface GraphFitLedgerOpts {
  /** The budget every measure is taken against — also recorded on the pack the mirror imitates. */
  budgetTokens: number;
  /** S3 defense-in-depth: the item set the pack builder filters pack items by. Mirror, don't guess. */
  itemEligible?: ReadonlySet<string>;
}

/** One placement the S5 completion queue considers for a reached-but-trimmed partner. */
export type GraphCompletionCandidate =
  /** Cite one CURRENT assertion whose other endpoint is kept — the connection, not the item. */
  | {
      kind: 'cite';
      partner: GraphExpansion;
      assertion: GraphAssertion;
      /** The ordering recency — for a citation, the knownAt of the assertion it would state. */
      recency: string;
      /** The trim's nearest misses first: the partner's own expansion rank, descending. */
      partnerRank: number;
      /** The assertion's predicate — the ontology's own order breaks later ties (appends: ''). */
      predicate: string;
    }
  /** Append the partner itself — item, path, history and relations: everything it would state. */
  | {
      kind: 'append';
      partner: GraphExpansion;
      /** The ordering recency — for an append, the newest assertion on its own path. */
      recency: string;
      /** The trim's nearest misses first: the partner's own expansion rank, descending. */
      partnerRank: number;
      /** Appends carry no predicate of their own; citations win this tie before it is reached. */
      predicate: string;
    };

interface ConflictMeta {
  /** The group verbatim — the pack's `conflicts` entries are the projection's own objects. */
  group: GraphProjection['conflicts'][number];
  /** The group's assertion ids as a set — the pack includes a group when ANY path cites a member. */
  ids: Set<string>;
  /** Canonical subject — the pack's other inclusion test is membership among the kept items. */
  subject: string;
  /** Canonical objects — same test from the object side. */
  objects: string[];
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;

export class GraphFitLedger {
  private readonly projection: GraphProjection;
  private readonly canonicalOf: (ref: string) => string;
  private readonly currentById: Map<string, GraphAssertion>;
  private readonly historicalById: Map<string, GraphAssertion>;
  private readonly byEndpoint = new Map<string, GraphAssertion[]>();
  private readonly historicalTouching = new Map<string, GraphAssertion[]>();
  private readonly historicalRefs: Set<string>;
  private readonly conflictsMeta: ConflictMeta[];
  private readonly conflictsByNode = new Map<string, number[]>();
  private readonly conflictsByAssertion = new Map<string, number[]>();
  private readonly traversalJson: string;
  private readonly degradedJson: string;
  private readonly budgetTokens: number;
  private readonly itemEligible?: ReadonlySet<string>;

  /** The kept expansions, in fit order — appends append, displacement removes, nothing reorders. */
  private kept: GraphExpansion[] = [];
  private keptSet = new Set<string>();
  private keptRank = new Map<string, number>();
  private readonly pathIds = new Set<string>();
  private readonly relations = new Set<string>();
  private readonly relationsAt = new Map<string, Set<string>>();
  private readonly conflictsIncluded = new Set<number>();
  private readonly historicalCited = new Set<string>();
  private readonly historicalAt = new Map<string, Set<string>>();
  private readonly citedIds = new Set<string>();

  constructor(
    projection: GraphProjection,
    traversal: GraphTraversalReport,
    opts: GraphFitLedgerOpts,
  ) {
    this.projection = projection;
    this.canonicalOf = (ref) => projection.aliases.canonical[ref] ?? ref;
    this.currentById = new Map(projection.current.map((a) => [a.id, a]));
    this.historicalById = new Map(projection.historical.map((a) => [a.id, a]));
    this.historicalRefs = new Set(projection.historicalRefs);
    for (const assertion of projection.current) {
      this.addEndpointEdge(this.byEndpoint, this.canonicalOf(assertion.subject), assertion);
      if (this.canonicalOf(assertion.object) !== this.canonicalOf(assertion.subject)) {
        this.addEndpointEdge(this.byEndpoint, this.canonicalOf(assertion.object), assertion);
      }
    }
    for (const assertion of projection.historical) {
      this.addEndpointEdge(this.historicalTouching, this.canonicalOf(assertion.subject), assertion);
      if (this.canonicalOf(assertion.object) !== this.canonicalOf(assertion.subject)) {
        this.addEndpointEdge(
          this.historicalTouching,
          this.canonicalOf(assertion.object),
          assertion,
        );
      }
    }
    this.conflictsMeta = projection.conflicts.map((group) => {
      const meta: ConflictMeta = {
        group,
        ids: new Set(group.assertionIds),
        subject: this.canonicalOf(group.subject),
        objects: group.objects.map((object) => this.canonicalOf(object)),
      };
      return meta;
    });
    this.conflictsMeta.forEach((meta, index) => {
      this.addConflictIndex(this.conflictsByNode, meta.subject, index);
      for (const object of meta.objects) this.addConflictIndex(this.conflictsByNode, object, index);
      for (const id of meta.ids) this.addConflictIndex(this.conflictsByAssertion, id, index);
    });
    this.traversalJson = JSON.stringify(traversal);
    this.degradedJson = JSON.stringify([]);
    this.budgetTokens = opts.budgetTokens;
    this.itemEligible = opts.itemEligible;
  }

  private addEndpointEdge(
    index: Map<string, GraphAssertion[]>,
    node: string,
    assertion: GraphAssertion,
  ): void {
    const bucket = index.get(node);
    if (bucket === undefined) index.set(node, [assertion]);
    else bucket.push(assertion);
  }

  private addConflictIndex(index: Map<string, number[]>, key: string, group: number): void {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [group]);
    else bucket.push(group);
  }

  // ── state transitions ─────────────────────────────────────────────────────

  /** Reset the ledger to a prefix, mirroring `buildGraphContextPack(projection, prefix, …)` exactly. */
  rebuild(prefix: readonly GraphExpansion[]): void {
    this.kept = [];
    this.keptSet = new Set();
    this.keptRank = new Map();
    this.pathIds.clear();
    this.relations.clear();
    this.relationsAt.clear();
    this.conflictsIncluded.clear();
    this.historicalCited.clear();
    this.historicalAt.clear();
    this.citedIds.clear();
    for (const expansion of prefix) this.add(expansion);
  }

  /** Whether the expansion is a pack item under the S3 filter the builder applies. */
  eligibleItem(ref: string): boolean {
    return this.itemEligible === undefined || this.itemEligible.has(ref);
  }

  /** Keep one expansion, updating every citation set it feeds. Idempotent per ref. */
  add(expansion: GraphExpansion): void {
    // Ineligible expansions never enter keptSet, so the ref check must cover them too — a double
    // add of the same ineligible ref would otherwise appear twice in `kept` (and in the pack).
    if (this.kept.some((e) => e.ref === expansion.ref)) return;
    if (!this.eligibleItem(expansion.ref)) {
      // The builder filters ineligible expansions out before deriving anything — such an expansion
      // contributes NOTHING to the pack, so the ledger keeps it in `kept` (the caller's fit list)
      // but out of every citation set.
      this.kept.push(expansion);
      return;
    }
    this.kept.push(expansion);
    this.keptSet.add(expansion.ref);
    this.keptRank.set(expansion.ref, expansion.rank);
    for (const step of expansion.path) this.pathIds.add(step.assertionId);
    this.relationsAt.set(expansion.ref, new Set());
    for (const assertion of this.byEndpoint.get(expansion.ref) ?? []) {
      const other = this.otherEndpointOf(assertion, expansion.ref);
      if (other === null || !this.keptSet.has(other)) continue;
      this.relations.add(assertion.id);
      this.relationsAt.get(expansion.ref)?.add(assertion.id);
      this.relationsAt.get(other)?.add(assertion.id);
    }
    for (const index of this.groupsTouching(expansion)) {
      if (this.groupIncluded(index)) this.conflictsIncluded.add(index);
    }
    const historical = new Set((this.historicalTouching.get(expansion.ref) ?? []).map((a) => a.id));
    this.historicalAt.set(expansion.ref, historical);
    for (const id of historical) this.historicalCited.add(id);
  }

  /** Drop one kept expansion, retracting every citation that only it supported. */
  remove(ref: string): void {
    this.removeCollecting(ref);
  }

  /**
   * `remove` that reports what it took: every id the removal retracts from the pack's citation
   * state — path steps no other kept item carries, relations the item anchored, historical
   * entries only it touched, and the bodies of conflict groups that die with it. Ids another
   * channel still cites (a completion cite, a surviving path) are excluded: they are not lost.
   * The round-2 tail displacement feeds the returned ids to its restoration channel, so a
   * stripped trial can put the reader's assertions back instead of trading them away.
   */
  removeCollecting(ref: string): string[] {
    const expansion = this.kept.find((e) => e.ref === ref);
    if (expansion === undefined) return [];
    const retracted: string[] = [];
    this.kept = this.kept.filter((e) => e.ref !== ref);
    if (!this.keptSet.has(ref)) return retracted;
    this.keptSet.delete(ref);
    this.keptRank.delete(ref);
    for (const step of expansion.path) {
      if (!this.kept.some((e) => e.path.some((s) => s.assertionId === step.assertionId))) {
        this.pathIds.delete(step.assertionId);
        retracted.push(step.assertionId);
      }
    }
    // Every relation touching the removed ref dies with it — the builder only lists relations whose
    // BOTH canonical endpoints are kept items, and this ref's canonical form is one of them.
    for (const id of this.relationsAt.get(ref) ?? []) {
      this.relations.delete(id);
      retracted.push(id);
      const assertion = this.currentById.get(id);
      const other = assertion === undefined ? null : this.otherEndpointOf(assertion, ref);
      if (other !== null && other !== ref) this.relationsAt.get(other)?.delete(id);
    }
    this.relationsAt.delete(ref);
    for (const index of this.groupsTouching(expansion)) {
      if (!this.groupIncluded(index)) {
        if (this.conflictsIncluded.delete(index)) {
          for (const id of this.conflictsMeta[index]?.ids ?? []) retracted.push(id);
        }
      }
    }
    for (const id of this.historicalAt.get(ref) ?? []) {
      let stillTouched = false;
      for (const keptRef of this.keptSet) {
        if ((this.historicalTouching.get(keptRef) ?? []).some((a) => a.id === id)) {
          stillTouched = true;
          break;
        }
      }
      if (!stillTouched) {
        this.historicalCited.delete(id);
        retracted.push(id);
      }
    }
    this.historicalAt.delete(ref);
    const unique = [...new Set(retracted)];
    // An id another channel still serves is not lost — only the truly dropped citations restore.
    return unique.filter((id) => !this.isCited(id));
  }

  private groupsTouching(expansion: GraphExpansion): number[] {
    const indices = new Set<number>(this.conflictsByNode.get(expansion.ref) ?? []);
    for (const step of expansion.path) {
      for (const index of this.conflictsByAssertion.get(step.assertionId) ?? []) {
        indices.add(index);
      }
    }
    return [...indices];
  }

  /** The pack's own conflict-inclusion predicate, read against the LIVE ledger state. */
  private groupIncluded(index: number): boolean {
    const meta = this.conflictsMeta[index];
    if (meta === undefined) return false;
    if (this.keptSet.has(meta.subject)) return true;
    if (meta.objects.some((object) => this.keptSet.has(object))) return true;
    for (const id of meta.ids) if (this.pathIds.has(id)) return true;
    return false;
  }

  /** Cite an assertion id (S5 completion) — it is stated even though no kept item cites it alone. */
  cite(id: string): void {
    this.citedIds.add(id);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  isKept(ref: string): boolean {
    return this.keptSet.has(ref);
  }

  /** The kept list in fit order — appends at the end, never reordered. */
  keptList(): GraphExpansion[] {
    return [...this.kept];
  }

  /** The kept list ordered by rank ascending (stable — fit order breaks ties). */
  keptByRankAsc(): GraphExpansion[] {
    return [...this.kept].sort((a, b) => a.rank - b.rank);
  }

  keptRankOf(ref: string): number | undefined {
    return this.keptRank.get(ref);
  }

  /** The citation ids the completion placed, sorted — the pack builder's `citedAssertionIds`. */
  completionCitations(): string[] {
    return [...this.citedIds].sort();
  }

  /** The other canonical endpoint of an assertion from `ref`, or null when ref is not an endpoint. */
  otherEndpointOf(assertion: GraphAssertion, ref: string): string | null {
    const subject = this.canonicalOf(assertion.subject);
    const object = this.canonicalOf(assertion.object);
    if (subject === ref) return object;
    if (object === ref) return subject;
    return null;
  }

  /** An assertion by id, current view first — completion cite-backs order by its fields. */
  assertionOf(id: string): GraphAssertion | undefined {
    return this.currentById.get(id) ?? this.historicalById.get(id);
  }

  /**
   * How many distinct assertion ids any pack channel cites in the CURRENT state — path steps,
   * relations, disagreement groups, history and completion citations. The round-2 tail
   * displacement trial commits ONLY when a stripped trial pack states STRICTLY more than this.
   */
  citedCount(): number {
    return this.allCitedIds().size;
  }

  /**
   * The ids `other` cites that this state does not — the citations a displacement trial would
   * DROP relative to the primary it forked from. The trial commits only when this list is empty
   * AND it cites strictly more overall: a displacement may extend what the primary states, but
   * never trade one of its assertions away for a different one.
   */
  droppedCitationsFrom(other: GraphFitLedger): string[] {
    const mine = this.allCitedIds();
    return [...other.allCitedIds()].filter((id) => !mine.has(id));
  }

  /**
   * A trial copy for tail displacement (round 2): the immutable indexes are shared — a fork never
   * re-scans the projection — while every mutable set is cloned, so the trial's removals and
   * cite-backs can be measured and, when they do not pay for themselves, discarded wholesale.
   * `cite()` is not reversible, so a trial that loses the value test is simply dropped: the
   * primary ledger is never mutated.
   */
  fork(): GraphFitLedger {
    const trial = Object.create(GraphFitLedger.prototype) as GraphFitLedger;
    // A widened view because the fields are private and most are readonly: the constructor is
    // the only legal writer of the readonly ones, and a copy-constructor IS this fork — the
    // assignments below are that constructor's body, one level down the type chain.
    const copy = trial as unknown as Record<string, unknown>;
    // The readonly index fields are shared by reference — a fork never re-scans the projection.
    copy.projection = this.projection;
    copy.canonicalOf = this.canonicalOf;
    copy.currentById = this.currentById;
    copy.historicalById = this.historicalById;
    copy.byEndpoint = this.byEndpoint;
    copy.historicalTouching = this.historicalTouching;
    copy.historicalRefs = this.historicalRefs;
    copy.conflictsMeta = this.conflictsMeta;
    copy.conflictsByNode = this.conflictsByNode;
    copy.conflictsByAssertion = this.conflictsByAssertion;
    copy.traversalJson = this.traversalJson;
    copy.degradedJson = this.degradedJson;
    copy.budgetTokens = this.budgetTokens;
    copy.itemEligible = this.itemEligible;
    // The mutable pack state is deep-copied at citation granularity — the trial's removals and
    // cite-backs never leak back unless the caller adopts the trial as the winner.
    copy.kept = [...this.kept];
    copy.keptSet = new Set(this.keptSet);
    copy.keptRank = new Map(this.keptRank);
    copy.pathIds = new Set(this.pathIds);
    copy.relations = new Set(this.relations);
    copy.relationsAt = new Map([...this.relationsAt].map(([ref, ids]) => [ref, new Set(ids)]));
    copy.conflictsIncluded = new Set(this.conflictsIncluded);
    copy.historicalCited = new Set(this.historicalCited);
    copy.historicalAt = new Map([...this.historicalAt].map(([ref, ids]) => [ref, new Set(ids)]));
    copy.citedIds = new Set(this.citedIds);
    return trial;
  }

  /** Current assertions at a canonical ref, in projection order. */
  currentEdgesOf(ref: string): GraphAssertion[] {
    return [...(this.byEndpoint.get(ref) ?? [])];
  }

  /** The knownAt of an assertion by id, current view first — the completion orders candidates by it. */
  knownAtOf(id: string): string | undefined {
    return this.currentById.get(id)?.knownAt ?? this.historicalById.get(id)?.knownAt;
  }

  /** Every id any pack channel cites in the CURRENT state. */
  private allCitedIds(): Set<string> {
    const cited = new Set<string>(this.pathIds);
    for (const id of this.relations) cited.add(id);
    for (const index of this.conflictsIncluded) {
      for (const id of this.conflictsMeta[index]?.ids ?? []) cited.add(id);
    }
    for (const id of this.historicalCited) cited.add(id);
    for (const id of this.citedIds) cited.add(id);
    return cited;
  }

  isCited(id: string): boolean {
    return this.allCitedIds().has(id);
  }

  /**
   * The assertion entries an append of `expansion` would ADD — a current relation to a kept
   * endpoint, a historical entry it touches, a path step the pack does not already cite, or a
   * disagreement group it newly includes. Zero means the append is pure cost: it would spend
   * budget and state nothing new (WP2 round 1).
   */
  newCitationCount(expansion: GraphExpansion): number {
    if (!this.eligibleItem(expansion.ref)) return 0;
    const cited = this.allCitedIds();
    let count = 0;
    for (const assertion of this.byEndpoint.get(expansion.ref) ?? []) {
      const other = this.otherEndpointOf(assertion, expansion.ref);
      if (other !== null && this.keptSet.has(other) && !cited.has(assertion.id)) count += 1;
    }
    for (const assertion of this.historicalTouching.get(expansion.ref) ?? []) {
      if (!cited.has(assertion.id)) count += 1;
    }
    for (const step of expansion.path) {
      if (!cited.has(step.assertionId)) count += 1;
    }
    for (const index of this.conflictsByNode.get(expansion.ref) ?? []) {
      if (this.conflictsIncluded.has(index)) continue;
      count += 1; // a newly-included disagreement is stated, whatever its members cite
      for (const id of this.conflictsMeta[index]?.ids ?? []) {
        if (!cited.has(id)) count += 1;
      }
    }
    return count;
  }

  // ── measurement ────────────────────────────────────────────────────────────

  /** The exact serialized form of the pack for the CURRENT state — byte-identical to the builder's. */
  serialize(): string {
    const cited = new Map<
      string,
      { assertion: GraphAssertion; status: 'current' | 'historical' }
    >();
    const put = (id: string, status: 'current' | 'historical'): void => {
      if (cited.has(id)) return;
      const assertion =
        status === 'historical' ? this.historicalById.get(id) : this.currentById.get(id);
      if (assertion !== undefined) cited.set(id, { assertion, status });
    };
    for (const id of this.pathIds) put(id, 'current');
    for (const id of this.relations) put(id, 'current');
    for (const index of this.conflictsIncluded) {
      for (const id of this.conflictsMeta[index]?.ids ?? []) put(id, 'current');
    }
    for (const id of this.historicalCited) put(id, 'historical');
    for (const id of this.citedIds) put(id, this.currentById.has(id) ? 'current' : 'historical');

    const items = this.kept
      .filter((e) => this.eligibleItem(e.ref))
      .map((e) => ({
        ref: e.ref,
        state: this.historicalRefs.has(e.ref) ? ('historical' as const) : ('current' as const),
        distance: e.distance,
        rank: round(e.rank),
        seedScore: round(e.seedScore),
        seedChannel: e.seedChannel,
        ...(e.evidenceEligible ? {} : { evidenceEligible: false as const }),
        path: e.path.map((step) => step.assertionId),
      }));
    const producers: { principalId: string; actorId: string; clientId: string }[] = [];
    const producerIndex = new Map<string, number>();
    const assertions = [...cited.values()]
      .sort((a, b) => (a.assertion.id < b.assertion.id ? -1 : 1))
      .map(({ assertion: a, status }) => {
        const { principalId, actorId, clientId } = a.provenance;
        const key = `${principalId} ${actorId} ${clientId}`;
        let producer = producerIndex.get(key);
        if (producer === undefined) {
          producer = producers.length;
          producerIndex.set(key, producer);
          producers.push({ principalId, actorId, clientId });
        }
        return {
          id: a.id,
          predicate: a.predicate,
          subject: a.subject,
          object: a.object,
          supportedBy: [...a.supportedBy],
          validAt: a.validAt,
          knownAt: a.knownAt,
          status,
          producer,
        };
      });
    const relations = [...this.relations].sort();
    const conflicts = this.conflictsMeta
      .map((meta, index) => (this.conflictsIncluded.has(index) ? meta.group : undefined))
      .filter((group): group is GraphProjection['conflicts'][number] => group !== undefined);

    const pack = {
      items,
      assertions,
      relations,
      conflicts,
      producers,
      traversal: JSON.parse(this.traversalJson) as unknown,
      degraded: JSON.parse(this.degradedJson) as unknown,
      budgetTokens: this.budgetTokens,
    };
    return JSON.stringify({ context: pack, budgetExhausted: true });
  }

  /** Tokens of the current state under the serving estimator. */
  tokens(): number {
    return estimateTokens(this.serialize());
  }

  /** Tokens with `expansion` appended — measured exactly, leaving the ledger state untouched. */
  tokensWith(expansion: GraphExpansion): number {
    this.add(expansion);
    const tokens = this.tokens();
    this.remove(expansion.ref);
    return tokens;
  }

  /** Tokens with `id` cited — measured exactly, leaving the ledger state untouched. */
  tokensWithCitation(id: string): number {
    if (this.citedIds.has(id)) return this.tokens();
    this.citedIds.add(id);
    const tokens = this.tokens();
    this.citedIds.delete(id);
    return tokens;
  }
}
