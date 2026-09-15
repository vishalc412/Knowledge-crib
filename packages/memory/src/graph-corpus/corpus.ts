/**
 * The connected-memory-graph acceptance corpus (WP-G0 of the developer-launch graph plan).
 *
 * FROZEN BEFORE TUNING. This module is the versioned graph acceptance corpus the plan's §4 gates
 * are measured against: an isolated fixture universe (two principals, two repositories, local and
 * global memory, decisions with supersession, contradictory claims, renamed code, and
 * unfinished/completed intakes) plus the evaluation questions and their EXPECTED EVIDENCE PATHS,
 * frozen before any retrieval tuning so a configuration found by sweeping against these questions
 * would be selection on the test set — the same discipline `bench/launch-corpus.ts` established for
 * plain recall. Everything is deterministic: fixed literal clocks (no `Date.now()`, no randomness),
 * content-addressed ids through the REAL builders, and schema validation on every fixture at build
 * time, so a malformed fixture fails the build rather than the evaluation.
 *
 * The corpus does NOT presuppose the graph record schemas (those land in WP-G1 with their own
 * versioning). Questions express expected paths over the bounded predicate vocabulary the plan
 * fixes (`about`, `applies-to`, `supported-by`, `derived-from`, `supersedes`, `contradicts`,
 * `part-of`, `affects`) between universe nodes — memory record ids, code symbol ids, topic ids,
 * entity ids, evidence anchors, and intake ids — so WP-G1's backfill and WP-G5's connected
 * retrieval are judged against paths stated in terms of what the fixtures actually contain.
 */

import { blake3Hex } from '@knowledge-crib/soul-schema';
import { decisionId, derivePropositionKey, memoryRecordV3Id } from '../ids.js';
import { createIntakeCheckpoint, createIntakeRequirement } from '../intake.js';
import type {
  IntakeCheckpoint,
  IntakeRequirement,
  MemoryDecision,
  MemoryEvidence,
  MemoryRecordV3,
} from '../types.js';
import {
  assertValidIntakeCheckpoint,
  assertValidIntakeRequirement,
  assertValidMemoryDecision,
  assertValidMemoryRecordV3,
} from '../validate.js';

/** The corpus's own version. Bump when the fixture universe or question set changes — never edit
 *  a frozen corpus in place without a version change and a re-run of the pre-registered gates. */
export const GRAPH_CORPUS_VERSION = 1;

/** The bounded relation vocabulary the launch plan fixes (§2 "Domain model"). No other predicate
 *  may appear in an expected evidence path. */
export const GRAPH_PREDICATES = [
  'about',
  'applies-to',
  'supported-by',
  'derived-from',
  'supersedes',
  'contradicts',
  'part-of',
  'affects',
] as const;
export type GraphPredicate = (typeof GRAPH_PREDICATES)[number];

export type GraphQuestionFamily =
  | 'current'
  | 'historical'
  | 'conflict'
  | 'isolation'
  | 'rename'
  | 'work'
  | 'cross-repo'
  | 'decoy';

/** One labeled edge of an expected evidence path, between universe node ids. */
export interface GraphHop {
  predicate: GraphPredicate;
  from: string;
  to: string;
}

/** A frozen evaluation question. `knownAt` pins the temporal read point for historical questions;
 *  absent means the current eligible projection. `forbiddenIds` must not surface as CURRENT
 *  eligible claims in the answer — a superseded record may still appear as history. */
export interface GraphQuestion {
  id: string;
  question: string;
  variant: 'exact' | 'paraphrase' | 'context';
  family: GraphQuestionFamily;
  principal: string;
  scope: { repoId?: string; global?: boolean };
  knownAt?: string;
  expected: {
    claimIds: string[];
    symbolIds?: string[];
    entityIds?: string[];
    intakeIds?: string[];
    forbiddenIds?: string[];
    hops: GraphHop[];
  };
}

export interface GraphEntityFixture {
  id: string;
  name: string;
  repoId: string;
  type: 'repository' | 'service' | 'concept' | 'artifact';
}

export interface GraphCodeRevisionFixture {
  head: string;
  symbols: string[];
}

/** The rename scenario: one symbol renamed across two source revisions, so temporal questions can
 *  demand the pre-rename claim as history and the post-rename claim as current. */
export interface GraphRenamedCodeFixture {
  oldSymbolId: string;
  newSymbolId: string;
  revisionBefore: GraphCodeRevisionFixture;
  revisionAfter: GraphCodeRevisionFixture;
}

export interface GraphExpectedRelationship {
  predicate: GraphPredicate;
  from: string;
  to: string;
  /** Records whose content supports this edge. Which work package may derive it is
   *  predicate-determined — see the backfill/capture split pre-registered in
   *  docs/bench/graph-gates.md §2. */
  supportedBy: string[];
}

export interface GraphCorpus {
  version: number;
  principals: { alpha: string; beta: string };
  repoIds: { ledger: string; checkout: string };
  symbols: string[];
  topics: string[];
  entities: GraphEntityFixture[];
  anchors: string[];
  records: MemoryRecordV3[];
  recordsByRole: {
    alphaLedger: MemoryRecordV3[];
    alphaGlobal: MemoryRecordV3[];
    alphaCrossRepo: MemoryRecordV3[];
    betaCheckout: MemoryRecordV3[];
  };
  globalDecoys: MemoryRecordV3[];
  decisions: MemoryDecision[];
  intakes: IntakeRequirement[];
  checkpoints: IntakeCheckpoint[];
  intakeIds: { alphaDone: string; alphaOpen: string; betaOpen: string };
  renamedCode: GraphRenamedCodeFixture;
  expectedRelationships: GraphExpectedRelationship[];
  questions: GraphQuestion[];
  questionCounts: Record<GraphQuestionFamily, number>;
}

// ─── fixed identities ─────────────────────────────────────────────────────────

const PRINCIPAL_ALPHA = 'principal:alpha';
const PRINCIPAL_BETA = 'principal:beta';
const REPO_LEDGER = 'graph-corpus-ledger';
const REPO_CHECKOUT = 'graph-corpus-checkout';
const WORKSPACE = 'workspace:graph-corpus';
const AGENT_PROFILE = 'agent-profile:graph-corpus';

const CHARGE_ORDER = 'sym:packages/demo/ledger/src/charge.ts#chargeOrder';
const SETTLE_ORDER = 'sym:packages/demo/ledger/src/charge.ts#settleOrder';
const LEDGER_ORDER_SERVICE = 'sym:packages/demo/ledger/src/order.ts#OrderService';
const LEDGER_JOURNAL = 'sym:packages/demo/ledger/src/ledger.ts#LedgerJournal';
const CHECKOUT_ORDER_SERVICE = 'sym:packages/demo/checkout/src/order.ts#OrderService';
const CHECKOUT_CART = 'sym:packages/demo/checkout/src/cart.ts#Cart';

const T_RETRY_IDEM = 'topic:ledger-retry-idempotency';
const T_RETRY_WINDOW = 'topic:ledger-retry-window';
const T_RELEASE = 'topic:ledger-release-checklist';
const T_LOCK_RACE = 'topic:ledger-lock-race';
const T_GUEST = 'topic:checkout-guest-payments';
const T_TOOLING = 'topic:crib-monorepo-tooling';
const T_DECOY = 'topic:idempotency-general';

const E_LEDGER = 'entity:graph-corpus-ledger';
const E_CHECKOUT = 'entity:graph-corpus-checkout';
const E_OS_LEDGER = 'entity:graph-corpus-ledger/OrderService';
const E_OS_CHECKOUT = 'entity:graph-corpus-checkout/OrderService';
const E_JOURNAL = 'entity:graph-corpus-ledger/LedgerJournal';

const ARTIFACT_RETRIES = 'artifact:docs/ledger-runbook.md#retries';
const ARTIFACT_RELEASE = 'artifact:docs/ledger-runbook.md#release';
const ARTIFACT_TOOLING = 'artifact:CLAUDE.md#tooling';
const ATT_ALPHA = 'attestation:operator:alpha#retry-key';
const ATT_BETA = 'attestation:operator:beta#card-retention';
const RCPT_FAIL = 'rcpt:graph-corpus-lock-race-fail';
const RCPT_PASS = 'rcpt:graph-corpus-lock-race-pass';

/** Fixed literal clocks only — `2026-09-<dd>T<hh>:00:00.000Z`. No `Date.now()` anywhere near an id
 *  or a frozen seed (the sync-fixture law, restated for this corpus). */
const at = (day: number, hour = 0): string =>
  `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const hashOf = (tag: string): string => `blake3:${blake3Hex(`graph-corpus:${tag}`)}`;

// ─── fixture builders (real ids, real validators) ─────────────────────────────

interface V3Opts {
  kind: MemoryRecordV3['kind'];
  subject: string;
  claim: string;
  evidence: MemoryEvidence[];
  principal: string;
  projectId?: string;
  validFrom: string;
  validTo?: string;
  recordedAt?: string;
  lineage?: MemoryRecordV3['lineage'];
}

function v3(opts: V3Opts): MemoryRecordV3 {
  const namespace: MemoryRecordV3['namespace'] = opts.projectId
    ? {
        principalId: opts.principal,
        workspaceId: WORKSPACE,
        projectId: opts.projectId,
        agentProfileId: AGENT_PROFILE,
      }
    : { principalId: opts.principal, workspaceId: WORKSPACE, agentProfileId: AGENT_PROFILE };
  const core = {
    kind: opts.kind,
    subject: opts.subject,
    propositionKey: derivePropositionKey({ subject: opts.subject }),
    claim: opts.claim,
    evidence: opts.evidence,
    namespace,
  };
  const recordedAt = opts.recordedAt ?? opts.validFrom;
  const record: MemoryRecordV3 = {
    id: memoryRecordV3Id(core),
    schemaVersion: '3',
    visibility: 'workspace',
    ...core,
    validTime: opts.validTo ? { from: opts.validFrom, to: opts.validTo } : { from: opts.validFrom },
    transactionTime: { observedAt: recordedAt, recordedAt },
    provenance: {
      principalId: opts.principal,
      deviceId: 'device:graph-corpus',
      actorId: 'agent:graph-corpus',
      clientId: 'vitest',
    },
    lineage: opts.lineage ?? {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
  };
  assertValidMemoryRecordV3(record);
  return record;
}

const sourceQuote = (soulId: string, quote: string, tag: string, day: number): MemoryEvidence => ({
  kind: 'source-quote',
  verdict: 'valid',
  checkedAt: at(day),
  soulId,
  quote,
  targetHash: hashOf(tag),
});

const committedPolicy = (artifactId: string, anchor: string, day: number): MemoryEvidence => ({
  kind: 'committed-policy',
  verdict: 'valid',
  checkedAt: at(day),
  artifactId,
  anchor,
});

const humanAttestation = (attestId: string, actor: string, day: number): MemoryEvidence => ({
  kind: 'human-attestation',
  verdict: 'valid',
  checkedAt: at(day),
  attestationId: attestId,
  actor,
  tty: true,
  attestedAt: at(day),
});

const receiptPair = (
  failingReceiptId: string,
  passingReceiptId: string,
  day: number,
): MemoryEvidence => ({
  kind: 'receipt-pair',
  verdict: 'valid',
  checkedAt: at(day),
  failingReceiptId,
  passingReceiptId,
});

// ─── question seeds ────────────────────────────────────────────────────────────

interface GraphSeed {
  base: string;
  family: GraphQuestionFamily;
  principal: string;
  scope: { repoId?: string; global?: boolean };
  question: string;
  paraphrase: string;
  knownAt?: string;
  claimIds?: string[];
  symbolIds?: string[];
  entityIds?: string[];
  intakeIds?: string[];
  forbiddenIds?: string[];
  hops: GraphHop[];
}

const h = (predicate: GraphPredicate, from: string, to: string): GraphHop => ({
  predicate,
  from,
  to,
});

/** Every seed emits three frozen variants — `search` exact, `search` paraphrase, and the
 *  `context`-pack framing of the same expected evidence path — because the memory_graph contract
 *  exposes both operations and both must satisfy the same frozen paths. */
const VARIANTS: Array<{ suffix: string; variant: GraphQuestion['variant'] }> = [
  { suffix: 'e', variant: 'exact' },
  { suffix: 'p', variant: 'paraphrase' },
  { suffix: 'c', variant: 'context' },
];

function seedsToQuestions(seeds: GraphSeed[]): GraphQuestion[] {
  const questions: GraphQuestion[] = [];
  for (const seed of seeds) {
    for (const v of VARIANTS) {
      questions.push({
        id: `${seed.base}-${v.suffix}`,
        question:
          v.variant === 'exact'
            ? seed.question
            : v.variant === 'paraphrase'
              ? seed.paraphrase
              : `Assemble the connected context to answer: ${seed.question}`,
        variant: v.variant,
        family: seed.family,
        principal: seed.principal,
        scope: seed.scope,
        knownAt: seed.knownAt,
        expected: {
          claimIds: seed.claimIds ?? [],
          symbolIds: seed.symbolIds,
          entityIds: seed.entityIds,
          intakeIds: seed.intakeIds,
          forbiddenIds: seed.forbiddenIds,
          hops: seed.hops,
        },
      });
    }
  }
  return questions;
}

// ─── the corpus ────────────────────────────────────────────────────────────────

export function buildGraphCorpus(): GraphCorpus {
  // Records — built in dependency order (lineage references earlier ids).
  const d1 = v3({
    kind: 'decision',
    subject: T_RETRY_IDEM,
    claim: 'Ledger retries are idempotent keyed on the request hash alone.',
    evidence: [
      committedPolicy(ARTIFACT_RETRIES, 'docs/ledger-runbook.md#retries', 1),
      humanAttestation(ATT_ALPHA, 'operator:alpha', 1),
    ],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(1),
    recordedAt: at(1, 2),
  });
  const d2 = v3({
    kind: 'decision',
    subject: T_RETRY_IDEM,
    claim: 'Ledger retries are idempotent keyed on the request hash and the attempt number.',
    evidence: [
      committedPolicy(ARTIFACT_RETRIES, 'docs/ledger-runbook.md#retries', 10),
      humanAttestation(ATT_ALPHA, 'operator:alpha', 10),
    ],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(10),
    recordedAt: at(10, 1),
    lineage: { supersedes: [d1.id] },
  });
  const a3 = v3({
    kind: 'fact',
    subject: CHARGE_ORDER,
    claim: 'chargeOrder settles a charge exactly once per request hash.',
    evidence: [sourceQuote(CHARGE_ORDER, 'exactly once per request hash', 'charge-once', 2)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    // The claim stops being current when the rename lands — a closed half-open window.
    validFrom: at(2),
    validTo: at(12),
  });
  const a4 = v3({
    kind: 'fact',
    subject: SETTLE_ORDER,
    claim: 'settleOrder is chargeOrder renamed; it keeps the same idempotency contract.',
    evidence: [
      sourceQuote(SETTLE_ORDER, 'keeps the same idempotency contract', 'settle-contract', 12),
    ],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(12),
    lineage: { derivedFrom: [a3.id] },
  });
  const a5core = v3({
    kind: 'fact',
    subject: T_RETRY_WINDOW,
    claim: 'The ledger retry window is 30 seconds.',
    evidence: [sourceQuote(LEDGER_JOURNAL, 'retry window is 30 seconds', 'window-30', 3)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(3),
  });
  const a6 = v3({
    kind: 'fact',
    subject: T_RETRY_WINDOW,
    claim: 'The ledger retry window is 60 seconds.',
    evidence: [sourceQuote(LEDGER_JOURNAL, 'retry window is 60 seconds', 'window-60', 6)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(6),
    lineage: { contradicts: [a5core.id] },
  });
  // Re-stamp a5 with the mutual contradicts lineage — same id, because lineage is excluded from the
  // v3 content seed (mutable relationship state, by design).
  const a5 = v3({
    kind: 'fact',
    subject: T_RETRY_WINDOW,
    claim: 'The ledger retry window is 30 seconds.',
    evidence: [sourceQuote(LEDGER_JOURNAL, 'retry window is 30 seconds', 'window-30', 3)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(3),
    lineage: { contradicts: [a6.id] },
  });
  const a7 = v3({
    kind: 'procedure',
    subject: T_RELEASE,
    claim: 'Run the ledger acceptance harness before every release.',
    evidence: [committedPolicy(ARTIFACT_RELEASE, 'docs/ledger-runbook.md#release', 4)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(4),
  });
  const a8 = v3({
    kind: 'pitfall',
    subject: T_LOCK_RACE,
    claim:
      'A vanished-steal lock race once let two ledger writers in; O_EXCL discipline closed it.',
    evidence: [receiptPair(RCPT_FAIL, RCPT_PASS, 5)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(5),
  });
  const a9 = v3({
    kind: 'fact',
    subject: LEDGER_ORDER_SERVICE,
    claim: 'OrderService in the ledger repo projects replay totals from the journal.',
    evidence: [sourceQuote(LEDGER_ORDER_SERVICE, 'projects replay totals', 'os-ledger', 7)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(7),
  });
  const a10 = v3({
    kind: 'fact',
    subject: CHECKOUT_CART,
    claim: 'Cart locks line items while authorization is in flight.',
    evidence: [sourceQuote(CHECKOUT_CART, 'locks line items', 'cart-lock', 9)],
    principal: PRINCIPAL_ALPHA,
    // Same principal, DIFFERENT repository: alpha spans repos, so cross-repo questions have a
    // legitimate connected answer, while beta stays the isolation probe.
    projectId: REPO_CHECKOUT,
    validFrom: at(9),
  });
  const a11 = v3({
    kind: 'fact',
    subject: LEDGER_JOURNAL,
    claim: 'LedgerJournal appends are serialized under the store lock.',
    evidence: [sourceQuote(LEDGER_JOURNAL, 'serialized under the store lock', 'journal-lock', 8)],
    principal: PRINCIPAL_ALPHA,
    projectId: REPO_LEDGER,
    validFrom: at(8),
  });
  const g1 = v3({
    kind: 'convention',
    subject: T_TOOLING,
    claim: 'This monorepo uses pnpm; npm and yarn are refused.',
    evidence: [committedPolicy(ARTIFACT_TOOLING, 'CLAUDE.md#tooling', 1)],
    principal: PRINCIPAL_ALPHA,
    validFrom: at(1),
  });
  const b1 = v3({
    kind: 'decision',
    subject: T_GUEST,
    claim: 'Guest checkout must not persist card data beyond the authorization window.',
    evidence: [humanAttestation(ATT_BETA, 'operator:beta', 4)],
    principal: PRINCIPAL_BETA,
    projectId: REPO_CHECKOUT,
    validFrom: at(4),
  });
  const b2 = v3({
    kind: 'fact',
    subject: CHECKOUT_ORDER_SERVICE,
    claim: 'OrderService in the checkout repo totals a cart before reserving inventory.',
    evidence: [
      sourceQuote(CHECKOUT_ORDER_SERVICE, 'totals a cart before reserving', 'os-checkout', 5),
    ],
    principal: PRINCIPAL_BETA,
    projectId: REPO_CHECKOUT,
    validFrom: at(5),
  });
  const gd1 = v3({
    kind: 'fact',
    subject: T_DECOY,
    claim: 'HTTP PUT makes retries idempotent by specification semantics.',
    evidence: [
      sourceQuote(LEDGER_JOURNAL, 'idempotent by specification semantics', 'decoy-put', 3),
    ],
    principal: PRINCIPAL_ALPHA,
    validFrom: at(3),
  });

  const recordsByRole: GraphCorpus['recordsByRole'] = {
    alphaLedger: [d1, d2, a3, a4, a5, a6, a7, a8, a9, a11],
    alphaGlobal: [g1],
    alphaCrossRepo: [a10],
    betaCheckout: [b1, b2],
  };

  // The supersession lifecycle event — append-only, never a rewrite of d1.
  const supersedeDecision: MemoryDecision = {
    id: decisionId({
      kind: 'supersede',
      subject: d1.id,
      successor: d2.id,
      actor: 'operator:alpha',
      reason: 'The hash-only key collapsed legitimate retries.',
    }),
    schemaVersion: '1',
    kind: 'supersede',
    subject: d1.id,
    successor: d2.id,
    actor: 'operator:alpha',
    reason: 'The hash-only key collapsed legitimate retries.',
    ts: at(10, 1),
  };
  assertValidMemoryDecision(supersedeDecision);

  // Intakes — one completed, two open (one per principal), built through the real factories so
  // normalization and the nextSafeAction law are exercised on the fixtures themselves.
  const intakeAlphaDone = createIntakeRequirement({
    namespace: { principalId: PRINCIPAL_ALPHA, workspaceId: WORKSPACE, projectId: REPO_LEDGER },
    original: 'Decide the ledger retry idempotency key.',
    interpretation: {
      outcome: 'Record a durable idempotency decision for ledger retries',
      scope: ['packages/demo/ledger'],
      constraints: ['Keep the public charge API stable'],
      acceptanceCriteria: ['The ledger acceptance harness passes'],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
    provenance: {
      principalId: PRINCIPAL_ALPHA,
      deviceId: 'device:graph-corpus',
      actorId: 'claude-code',
      clientId: 'vitest',
    },
    createdAt: at(1),
  });
  const checkpointAlphaDoneProgress = createIntakeCheckpoint({
    intakeId: intakeAlphaDone.id,
    kind: 'progress',
    phase: 'executing',
    nextSafeAction: 'Widen the key if retries collapse',
    summary: 'First key recorded; hash only',
    repository: { head: hashOf('ledger:rev1'), branch: 'debug/auditMaster', dirty: false },
    actor: 'claude-code',
    recordedAt: at(2),
  });
  const checkpointAlphaDone = createIntakeCheckpoint({
    intakeId: intakeAlphaDone.id,
    kind: 'completed',
    phase: 'complete',
    summary: 'Superseded key recorded with the attempt number',
    completedStepIds: ['step:decide-key', 'step:supersede-key'],
    repository: { head: hashOf('ledger:rev2'), branch: 'debug/auditMaster', dirty: false },
    actor: 'claude-code',
    recordedAt: at(11),
  });
  const intakeAlphaOpen = createIntakeRequirement({
    namespace: { principalId: PRINCIPAL_ALPHA, workspaceId: WORKSPACE, projectId: REPO_LEDGER },
    original: 'Harden the ledger retry path against duplicate submissions.',
    interpretation: {
      outcome: 'Ship idempotent ledger retries with no duplicate settlements',
      scope: ['packages/demo/ledger'],
      constraints: ['Keep the public charge API stable'],
      acceptanceCriteria: ['Ledger acceptance harness passes twice in a row'],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
    provenance: {
      principalId: PRINCIPAL_ALPHA,
      deviceId: 'device:graph-corpus',
      actorId: 'claude-code',
      clientId: 'vitest',
    },
    createdAt: at(9),
  });
  const checkpointAlphaOpen = createIntakeCheckpoint({
    intakeId: intakeAlphaOpen.id,
    kind: 'progress',
    phase: 'executing',
    nextSafeAction: 'Re-run the ledger acceptance harness on the renamed symbol',
    summary: 'Key widened to include the attempt number; rename landed',
    repository: { head: hashOf('ledger:rev2'), branch: 'debug/auditMaster', dirty: false },
    actor: 'claude-code',
    recordedAt: at(10),
  });
  const intakeBetaOpen = createIntakeRequirement({
    namespace: { principalId: PRINCIPAL_BETA, workspaceId: WORKSPACE, projectId: REPO_CHECKOUT },
    original: 'Audit the guest checkout card retention window.',
    interpretation: {
      outcome: 'Confirm card data retention stays inside authorization',
      scope: ['packages/demo/checkout'],
      constraints: ['No new persisted fields'],
      acceptanceCriteria: ['Checkout retention audit passes'],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
    provenance: {
      principalId: PRINCIPAL_BETA,
      deviceId: 'device:graph-corpus',
      actorId: 'claude-code',
      clientId: 'vitest',
    },
    createdAt: at(4),
  });
  const checkpointBetaOpen = createIntakeCheckpoint({
    intakeId: intakeBetaOpen.id,
    kind: 'progress',
    phase: 'executing',
    nextSafeAction: 'Audit the authorization window sweep',
    summary: 'Retention audit started',
    repository: { head: hashOf('checkout:rev1'), branch: 'debug/auditMaster', dirty: false },
    actor: 'claude-code',
    recordedAt: at(5),
  });
  for (const intake of [intakeAlphaDone, intakeAlphaOpen, intakeBetaOpen]) {
    assertValidIntakeRequirement(intake);
  }
  for (const cp of [
    checkpointAlphaDoneProgress,
    checkpointAlphaDone,
    checkpointAlphaOpen,
    checkpointBetaOpen,
  ]) {
    assertValidIntakeCheckpoint(cp);
  }

  const renamedCode: GraphRenamedCodeFixture = {
    oldSymbolId: CHARGE_ORDER,
    newSymbolId: SETTLE_ORDER,
    revisionBefore: {
      head: hashOf('ledger:rev1'),
      symbols: [CHARGE_ORDER, LEDGER_ORDER_SERVICE, LEDGER_JOURNAL],
    },
    revisionAfter: {
      head: hashOf('ledger:rev2'),
      symbols: [SETTLE_ORDER, LEDGER_ORDER_SERVICE, LEDGER_JOURNAL],
    },
  };

  const entities: GraphEntityFixture[] = [
    { id: E_LEDGER, name: 'graph-corpus-ledger', repoId: REPO_LEDGER, type: 'repository' },
    { id: E_CHECKOUT, name: 'graph-corpus-checkout', repoId: REPO_CHECKOUT, type: 'repository' },
    { id: E_OS_LEDGER, name: 'OrderService', repoId: REPO_LEDGER, type: 'service' },
    { id: E_OS_CHECKOUT, name: 'OrderService', repoId: REPO_CHECKOUT, type: 'service' },
    { id: E_JOURNAL, name: 'LedgerJournal', repoId: REPO_LEDGER, type: 'artifact' },
  ];

  // Expected relationships — the edges the graph SHOULD hold. Scope is NOT uniform, per the
  // pre-registration (docs/bench/graph-gates.md §2): 35 backfill-scope edges are derivable from
  // record structure (WP-G1), and 9 capture-scope edges — `affects`, `applies-to`, and the intake
  // `about` edges — must arrive through authorized proposals (WP-G4), never through backfill.
  const expectedRelationships: GraphExpectedRelationship[] = [
    { predicate: 'about', from: d1.id, to: T_RETRY_IDEM, supportedBy: [d1.id] },
    { predicate: 'about', from: d2.id, to: T_RETRY_IDEM, supportedBy: [d2.id] },
    { predicate: 'supersedes', from: d2.id, to: d1.id, supportedBy: [supersedeDecision.id] },
    { predicate: 'supported-by', from: d1.id, to: ARTIFACT_RETRIES, supportedBy: [d1.id] },
    { predicate: 'supported-by', from: d1.id, to: ATT_ALPHA, supportedBy: [d1.id] },
    { predicate: 'supported-by', from: d2.id, to: ARTIFACT_RETRIES, supportedBy: [d2.id] },
    { predicate: 'supported-by', from: d2.id, to: ATT_ALPHA, supportedBy: [d2.id] },
    { predicate: 'affects', from: T_RETRY_IDEM, to: SETTLE_ORDER, supportedBy: [a4.id, d2.id] },
    { predicate: 'affects', from: T_RETRY_IDEM, to: CHARGE_ORDER, supportedBy: [a3.id, d1.id] },
    { predicate: 'about', from: a3.id, to: CHARGE_ORDER, supportedBy: [a3.id] },
    { predicate: 'about', from: a4.id, to: SETTLE_ORDER, supportedBy: [a4.id] },
    { predicate: 'derived-from', from: a4.id, to: a3.id, supportedBy: [a4.id] },
    { predicate: 'about', from: a5.id, to: T_RETRY_WINDOW, supportedBy: [a5.id] },
    { predicate: 'about', from: a6.id, to: T_RETRY_WINDOW, supportedBy: [a6.id] },
    { predicate: 'supported-by', from: a5.id, to: LEDGER_JOURNAL, supportedBy: [a5.id] },
    { predicate: 'supported-by', from: a6.id, to: LEDGER_JOURNAL, supportedBy: [a6.id] },
    { predicate: 'applies-to', from: a5.id, to: LEDGER_JOURNAL, supportedBy: [a5.id] },
    { predicate: 'applies-to', from: a6.id, to: LEDGER_JOURNAL, supportedBy: [a6.id] },
    { predicate: 'applies-to', from: a7.id, to: LEDGER_JOURNAL, supportedBy: [a7.id] },
    { predicate: 'contradicts', from: a5.id, to: a6.id, supportedBy: [a5.id, a6.id] },
    { predicate: 'contradicts', from: a6.id, to: a5.id, supportedBy: [a6.id, a5.id] },
    { predicate: 'about', from: a7.id, to: T_RELEASE, supportedBy: [a7.id] },
    { predicate: 'supported-by', from: a7.id, to: ARTIFACT_RELEASE, supportedBy: [a7.id] },
    { predicate: 'about', from: a8.id, to: T_LOCK_RACE, supportedBy: [a8.id] },
    { predicate: 'supported-by', from: a8.id, to: RCPT_FAIL, supportedBy: [a8.id] },
    { predicate: 'supported-by', from: a8.id, to: RCPT_PASS, supportedBy: [a8.id] },
    { predicate: 'about', from: a9.id, to: LEDGER_ORDER_SERVICE, supportedBy: [a9.id] },
    { predicate: 'about', from: a10.id, to: CHECKOUT_CART, supportedBy: [a10.id] },
    { predicate: 'about', from: a11.id, to: LEDGER_JOURNAL, supportedBy: [a11.id] },
    { predicate: 'about', from: g1.id, to: T_TOOLING, supportedBy: [g1.id] },
    { predicate: 'supported-by', from: g1.id, to: ARTIFACT_TOOLING, supportedBy: [g1.id] },
    { predicate: 'about', from: b1.id, to: T_GUEST, supportedBy: [b1.id] },
    { predicate: 'supported-by', from: b1.id, to: ATT_BETA, supportedBy: [b1.id] },
    { predicate: 'affects', from: T_GUEST, to: CHECKOUT_ORDER_SERVICE, supportedBy: [b1.id] },
    { predicate: 'about', from: b2.id, to: CHECKOUT_ORDER_SERVICE, supportedBy: [b2.id] },
    { predicate: 'part-of', from: CHARGE_ORDER, to: E_LEDGER, supportedBy: [a3.id] },
    { predicate: 'part-of', from: SETTLE_ORDER, to: E_LEDGER, supportedBy: [a4.id] },
    { predicate: 'part-of', from: LEDGER_ORDER_SERVICE, to: E_OS_LEDGER, supportedBy: [a9.id] },
    { predicate: 'part-of', from: LEDGER_JOURNAL, to: E_JOURNAL, supportedBy: [a11.id] },
    { predicate: 'part-of', from: CHECKOUT_ORDER_SERVICE, to: E_OS_CHECKOUT, supportedBy: [b2.id] },
    { predicate: 'part-of', from: CHECKOUT_CART, to: E_CHECKOUT, supportedBy: [a10.id] },
    {
      predicate: 'about',
      from: intakeAlphaDone.id,
      to: T_RETRY_IDEM,
      supportedBy: [intakeAlphaDone.id],
    },
    {
      predicate: 'about',
      from: intakeAlphaOpen.id,
      to: T_RETRY_IDEM,
      supportedBy: [intakeAlphaOpen.id],
    },
    { predicate: 'about', from: intakeBetaOpen.id, to: T_GUEST, supportedBy: [intakeBetaOpen.id] },
  ];

  const alphaAll = [
    ...recordsByRole.alphaLedger,
    ...recordsByRole.alphaGlobal,
    ...recordsByRole.alphaCrossRepo,
  ];
  const betaAll = [...recordsByRole.betaCheckout];
  const led = { repoId: REPO_LEDGER };
  const chk = { repoId: REPO_CHECKOUT };
  const glb = { global: true };

  const seeds: GraphSeed[] = [
    // ── current ── the default eligible projection, after supersession and rename.
    {
      base: 'q-cur-idem-governs',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question:
        'Which decision currently governs ledger retry idempotency, and which code does it affect?',
      paraphrase:
        'What is the current rule for making ledger retries idempotent, and where in the code does it apply?',
      claimIds: [d2.id],
      symbolIds: [SETTLE_ORDER],
      forbiddenIds: [d1.id],
      hops: [
        h('about', d2.id, T_RETRY_IDEM),
        h('affects', T_RETRY_IDEM, SETTLE_ORDER),
        h('supersedes', d2.id, d1.id),
      ],
    },
    {
      base: 'q-cur-idem-evidence',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'Which policy and attestation anchor the current ledger retry decision?',
      paraphrase: 'What evidence backs the key decision that governs ledger retries today?',
      claimIds: [d2.id],
      hops: [
        h('about', d2.id, T_RETRY_IDEM),
        h('supported-by', d2.id, ARTIFACT_RETRIES),
        h('supported-by', d2.id, ATT_ALPHA),
      ],
    },
    {
      base: 'q-cur-settle-guarantee',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'What does settleOrder guarantee, and where did that contract come from?',
      paraphrase:
        'Which claim describes the settleOrder behaviour, and which earlier claim did it grow out of?',
      claimIds: [a4.id],
      symbolIds: [SETTLE_ORDER],
      hops: [h('about', a4.id, SETTLE_ORDER), h('derived-from', a4.id, a3.id)],
    },
    {
      base: 'q-cur-os-ledger',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'What does the ledger OrderService project, and which entity owns it?',
      paraphrase:
        'Which claim covers the ledger OrderService, and what entity does the symbol belong to?',
      claimIds: [a9.id],
      symbolIds: [LEDGER_ORDER_SERVICE],
      entityIds: [E_OS_LEDGER],
      hops: [
        h('about', a9.id, LEDGER_ORDER_SERVICE),
        h('part-of', LEDGER_ORDER_SERVICE, E_OS_LEDGER),
      ],
    },
    {
      base: 'q-cur-journal-concurrency',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'Which claim explains LedgerJournal concurrency, and which entity owns it?',
      paraphrase:
        'What do we know about how LedgerJournal serializes appends, and what entity is it?',
      claimIds: [a11.id],
      symbolIds: [LEDGER_JOURNAL],
      entityIds: [E_JOURNAL],
      hops: [h('about', a11.id, LEDGER_JOURNAL), h('part-of', LEDGER_JOURNAL, E_JOURNAL)],
    },
    {
      base: 'q-cur-cart-lock',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: chk,
      question:
        'What locks cart line items during authorization, and which repository owns the cart?',
      paraphrase: 'Which claim explains the checkout cart locking, and what repo does it live in?',
      claimIds: [a10.id],
      symbolIds: [CHECKOUT_CART],
      entityIds: [E_CHECKOUT],
      forbiddenIds: [b1.id, b2.id],
      hops: [h('about', a10.id, CHECKOUT_CART), h('part-of', CHECKOUT_CART, E_CHECKOUT)],
    },
    {
      base: 'q-cur-release-checklist',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'What must run before every ledger release, and which code does it govern?',
      paraphrase: 'Which procedure guards ledger releases, and what code does it apply to?',
      claimIds: [a7.id],
      symbolIds: [LEDGER_JOURNAL],
      hops: [
        h('about', a7.id, T_RELEASE),
        h('supported-by', a7.id, ARTIFACT_RELEASE),
        h('applies-to', a7.id, LEDGER_JOURNAL),
      ],
    },
    {
      base: 'q-cur-lock-race-pitfall',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question:
        'Which failure taught the ledger lock discipline, and which receipts prove the fix?',
      paraphrase:
        'What pitfall shaped how the ledger takes locks, and what evidence shows it was fixed?',
      claimIds: [a8.id],
      hops: [
        h('about', a8.id, T_LOCK_RACE),
        h('supported-by', a8.id, RCPT_FAIL),
        h('supported-by', a8.id, RCPT_PASS),
      ],
    },
    {
      base: 'q-cur-tooling-convention',
      family: 'current',
      principal: PRINCIPAL_ALPHA,
      scope: glb,
      question: 'Which convention governs monorepo tooling across repositories?',
      paraphrase: 'What does my global memory say about which package manager this monorepo uses?',
      claimIds: [g1.id],
      hops: [h('about', g1.id, T_TOOLING), h('supported-by', g1.id, ARTIFACT_TOOLING)],
    },
    {
      base: 'q-cur-guest-decision',
      family: 'current',
      principal: PRINCIPAL_BETA,
      scope: chk,
      question:
        'Which decision governs guest checkout card retention, and which code does it affect?',
      paraphrase:
        'What is the current rule for keeping guest card data, and where does it bite in the code?',
      claimIds: [b1.id],
      symbolIds: [CHECKOUT_ORDER_SERVICE],
      forbiddenIds: [a10.id],
      hops: [h('about', b1.id, T_GUEST), h('affects', T_GUEST, CHECKOUT_ORDER_SERVICE)],
    },
    {
      base: 'q-cur-os-checkout',
      family: 'current',
      principal: PRINCIPAL_BETA,
      scope: chk,
      question: 'Which claim describes the checkout OrderService, and which entity owns it?',
      paraphrase: 'What do I know about the checkout OrderService symbol and its owning entity?',
      claimIds: [b2.id],
      symbolIds: [CHECKOUT_ORDER_SERVICE],
      entityIds: [E_OS_CHECKOUT],
      forbiddenIds: [a9.id],
      hops: [
        h('about', b2.id, CHECKOUT_ORDER_SERVICE),
        h('part-of', CHECKOUT_ORDER_SERVICE, E_OS_CHECKOUT),
      ],
    },
    {
      base: 'q-cur-guest-connect',
      family: 'current',
      principal: PRINCIPAL_BETA,
      scope: chk,
      question: 'How do my guest checkout decision and my OrderService fact connect?',
      paraphrase:
        'Which of my checkout claims touch guest payments, and where do they meet in code?',
      claimIds: [b1.id, b2.id],
      symbolIds: [CHECKOUT_ORDER_SERVICE],
      forbiddenIds: [a10.id],
      hops: [
        h('about', b1.id, T_GUEST),
        h('affects', T_GUEST, CHECKOUT_ORDER_SERVICE),
        h('about', b2.id, CHECKOUT_ORDER_SERVICE),
      ],
    },

    // ── historical ── bi-temporal reads at fixed knownAt points.
    {
      base: 'q-hist-idem-before',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(9),
      question: 'What decision governed ledger retries as recorded before the tenth?',
      paraphrase: 'As of the ninth, which key made ledger retries idempotent?',
      claimIds: [d1.id],
      symbolIds: [CHARGE_ORDER],
      forbiddenIds: [d2.id],
      hops: [h('about', d1.id, T_RETRY_IDEM), h('affects', T_RETRY_IDEM, CHARGE_ORDER)],
    },
    {
      base: 'q-hist-idem-after',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question: 'How did the ledger retry decision change, and what does it affect now?',
      paraphrase: 'Walk the history of the ledger retry decision and name its current code target.',
      claimIds: [d2.id, d1.id],
      symbolIds: [SETTLE_ORDER],
      hops: [
        h('supersedes', d2.id, d1.id),
        h('about', d2.id, T_RETRY_IDEM),
        h('affects', T_RETRY_IDEM, SETTLE_ORDER),
      ],
    },
    {
      base: 'q-hist-idem-both',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question: 'Explain both the current and the superseded ledger retry decisions.',
      paraphrase: 'Show me the ledger retry decision history, old key and new key together.',
      claimIds: [d2.id, d1.id],
      hops: [
        h('supersedes', d2.id, d1.id),
        h('about', d2.id, T_RETRY_IDEM),
        h('about', d1.id, T_RETRY_IDEM),
      ],
    },
    {
      base: 'q-hist-charge-before-rename',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(11),
      question: 'Before the rename, which symbol carried the idempotency contract?',
      paraphrase: 'As of the eleventh, what did the code that settled charges guarantee?',
      claimIds: [a3.id],
      symbolIds: [CHARGE_ORDER],
      forbiddenIds: [a4.id],
      hops: [h('about', a3.id, CHARGE_ORDER), h('affects', T_RETRY_IDEM, CHARGE_ORDER)],
    },
    {
      base: 'q-hist-charge-ever',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question: 'Was chargeOrder ever covered by an idempotency claim, and what replaced it?',
      paraphrase:
        'Does the history connect the old charge symbol to the claim that replaced its coverage?',
      claimIds: [a3.id, a4.id],
      symbolIds: [CHARGE_ORDER, SETTLE_ORDER],
      hops: [
        h('about', a3.id, CHARGE_ORDER),
        h('derived-from', a4.id, a3.id),
        h('about', a4.id, SETTLE_ORDER),
      ],
    },
    {
      base: 'q-hist-settle-full',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question: 'What is the full history of the charge idempotency claim across the rename?',
      paraphrase: 'Trace the once-per-request-hash guarantee from chargeOrder to settleOrder.',
      claimIds: [a3.id, a4.id],
      symbolIds: [CHARGE_ORDER, SETTLE_ORDER],
      hops: [
        h('about', a3.id, CHARGE_ORDER),
        h('derived-from', a4.id, a3.id),
        h('about', a4.id, SETTLE_ORDER),
      ],
    },
    {
      base: 'q-hist-window-at-five',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(5),
      question:
        'What was the recorded ledger retry window as of the fifth, and which code anchors it?',
      paraphrase:
        'As of the fifth, how long did the ledger wait between retries, and where is that written?',
      claimIds: [a5.id],
      symbolIds: [LEDGER_JOURNAL],
      forbiddenIds: [a6.id],
      hops: [h('about', a5.id, T_RETRY_WINDOW), h('supported-by', a5.id, LEDGER_JOURNAL)],
    },
    {
      base: 'q-hist-window-at-fifteen',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question:
        'What did we believe about the retry window by the fifteenth, and how did it change?',
      paraphrase: 'Show the retry window claims recorded by the fifteenth, in order.',
      claimIds: [a5.id, a6.id],
      hops: [
        h('about', a5.id, T_RETRY_WINDOW),
        h('about', a6.id, T_RETRY_WINDOW),
        h('contradicts', a6.id, a5.id),
      ],
    },
    {
      base: 'q-hist-guest-after',
      family: 'historical',
      principal: PRINCIPAL_BETA,
      scope: chk,
      knownAt: at(15),
      question: 'How did the guest checkout picture come together, decision and code claims?',
      paraphrase: 'By the fifteenth, what did I hold about guest checkout retention and its code?',
      claimIds: [b1.id, b2.id],
      symbolIds: [CHECKOUT_ORDER_SERVICE],
      hops: [
        h('about', b1.id, T_GUEST),
        h('affects', T_GUEST, CHECKOUT_ORDER_SERVICE),
        h('about', b2.id, CHECKOUT_ORDER_SERVICE),
      ],
    },
    {
      base: 'q-hist-work-first-decision',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(9),
      question: 'Which piece of work produced the first ledger retry decision?',
      paraphrase: 'As of the ninth, what work item led to the original retry key decision?',
      claimIds: [d1.id],
      intakeIds: [intakeAlphaDone.id],
      hops: [h('about', intakeAlphaDone.id, T_RETRY_IDEM), h('about', d1.id, T_RETRY_IDEM)],
    },
    {
      base: 'q-hist-os-ledger-at-seven',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(7),
      question: 'Which OrderService claims were recorded by the seventh?',
      paraphrase: 'As of the seventh, what did I know about any OrderService symbol?',
      claimIds: [a9.id],
      symbolIds: [LEDGER_ORDER_SERVICE],
      forbiddenIds: [b2.id],
      hops: [
        h('about', a9.id, LEDGER_ORDER_SERVICE),
        h('part-of', LEDGER_ORDER_SERVICE, E_OS_LEDGER),
      ],
    },
    {
      base: 'q-hist-idem-sweep-thirteen',
      family: 'historical',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(13),
      question: 'What was known about ledger retries by the thirteenth?',
      paraphrase: 'By the thirteenth, which retry claims and their history were recorded?',
      claimIds: [d1.id, d2.id, a3.id, a4.id, a5.id, a6.id],
      symbolIds: [CHARGE_ORDER, SETTLE_ORDER],
      forbiddenIds: [gd1.id],
      hops: [
        h('supersedes', d2.id, d1.id),
        h('about', d2.id, T_RETRY_IDEM),
        h('affects', T_RETRY_IDEM, SETTLE_ORDER),
        h('about', a3.id, CHARGE_ORDER),
        h('contradicts', a5.id, a6.id),
      ],
    },

    // ── conflict ── both contradictory claims travel together; never last-write-wins.
    {
      base: 'q-conf-window-both',
      family: 'conflict',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'What retry window does the ledger use?',
      paraphrase: 'How long does the ledger wait between retries?',
      claimIds: [a5.id, a6.id],
      hops: [h('about', a5.id, T_RETRY_WINDOW), h('contradicts', a5.id, a6.id)],
    },
    {
      base: 'q-conf-window-both-directions',
      family: 'conflict',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'Which claims disagree about the ledger retry window, and from which side?',
      paraphrase: 'Show the contradicting retry window pair and how each contradicts the other.',
      claimIds: [a5.id, a6.id],
      hops: [h('contradicts', a5.id, a6.id), h('contradicts', a6.id, a5.id)],
    },
    {
      base: 'q-conf-window-support',
      family: 'conflict',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'What evidence supports each side of the retry window disagreement?',
      paraphrase: 'For each conflicting retry window claim, which code anchor backs it?',
      claimIds: [a5.id, a6.id],
      hops: [
        h('about', a5.id, T_RETRY_WINDOW),
        h('contradicts', a5.id, a6.id),
        h('about', a6.id, T_RETRY_WINDOW),
      ],
    },

    // ── rename ── pre/post revision semantics.
    {
      base: 'q-ren-after-owner',
      family: 'rename',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question:
        'After the rename, which symbol owns the idempotency contract, and what was it called before?',
      paraphrase:
        'Since the rename, what carries the once-per-hash guarantee, and under what old name?',
      claimIds: [a4.id, a3.id],
      symbolIds: [SETTLE_ORDER, CHARGE_ORDER],
      hops: [
        h('about', a4.id, SETTLE_ORDER),
        h('derived-from', a4.id, a3.id),
        h('about', a3.id, CHARGE_ORDER),
      ],
    },
    {
      base: 'q-ren-before-owner',
      family: 'rename',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(11),
      question: 'Before the rename, which claim and symbol owned the settlement contract?',
      paraphrase: 'Prior to the rename, what guaranteed single settlement, and where?',
      claimIds: [a3.id],
      symbolIds: [CHARGE_ORDER],
      forbiddenIds: [a4.id],
      hops: [h('about', a3.id, CHARGE_ORDER), h('affects', T_RETRY_IDEM, CHARGE_ORDER)],
    },
    {
      base: 'q-ren-connection',
      family: 'rename',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      knownAt: at(15),
      question: 'Which claims connect chargeOrder to settleOrder across the rename?',
      paraphrase: 'What links the old settlement symbol to the new one in my memory?',
      claimIds: [a3.id, a4.id],
      symbolIds: [CHARGE_ORDER, SETTLE_ORDER],
      hops: [
        h('derived-from', a4.id, a3.id),
        h('about', a3.id, CHARGE_ORDER),
        h('about', a4.id, SETTLE_ORDER),
      ],
    },

    // ── work ── intakes as authorized work references.
    {
      base: 'q-work-produced-by',
      family: 'work',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question:
        'Which piece of work produced the current ledger retry decision, and is it finished?',
      paraphrase: 'What work item led to the current retry key decision, and did it complete?',
      claimIds: [d2.id],
      intakeIds: [intakeAlphaDone.id],
      hops: [
        h('about', intakeAlphaDone.id, T_RETRY_IDEM),
        h('about', d2.id, T_RETRY_IDEM),
        h('affects', T_RETRY_IDEM, SETTLE_ORDER),
      ],
    },
    {
      base: 'q-work-unfinished-next',
      family: 'work',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question:
        'What work on the ledger retry path is unfinished, and what is the next safe action?',
      paraphrase: 'Which ledger retry work is still resumable, and what should it do next?',
      intakeIds: [intakeAlphaOpen.id],
      forbiddenIds: [intakeAlphaDone.id],
      hops: [
        h('about', intakeAlphaOpen.id, T_RETRY_IDEM),
        h('affects', T_RETRY_IDEM, SETTLE_ORDER),
      ],
    },
    {
      base: 'q-work-completed-excluded',
      family: 'work',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'Which ledger work remains resumable, excluding completed work?',
      paraphrase: 'Of my ledger intakes, what is still open and safe to resume?',
      claimIds: [d2.id],
      intakeIds: [intakeAlphaOpen.id],
      forbiddenIds: [intakeAlphaDone.id],
      hops: [h('about', intakeAlphaOpen.id, T_RETRY_IDEM), h('supersedes', d2.id, d1.id)],
    },
    {
      base: 'q-work-beta-own',
      family: 'work',
      principal: PRINCIPAL_BETA,
      scope: chk,
      question: 'What checkout work is in flight, and what is its next safe action?',
      paraphrase: 'Which of my checkout intakes is unfinished, and what comes next on it?',
      intakeIds: [intakeBetaOpen.id],
      forbiddenIds: [intakeAlphaOpen.id, intakeAlphaDone.id],
      hops: [h('about', intakeBetaOpen.id, T_GUEST), h('affects', T_GUEST, CHECKOUT_ORDER_SERVICE)],
    },

    // ── isolation ── foreign-principal exclusion probes (emptiness is the expected answer).
    {
      base: 'q-iso-alpha-checkout-view',
      family: 'isolation',
      principal: PRINCIPAL_ALPHA,
      scope: chk,
      question: 'What do I know about checkout code?',
      paraphrase: 'Which of my claims touch the checkout repository?',
      claimIds: [a10.id],
      symbolIds: [CHECKOUT_CART],
      forbiddenIds: [b1.id, b2.id, intakeBetaOpen.id],
      hops: [h('about', a10.id, CHECKOUT_CART), h('part-of', CHECKOUT_CART, E_CHECKOUT)],
    },
    {
      base: 'q-iso-beta-own-view',
      family: 'isolation',
      principal: PRINCIPAL_BETA,
      scope: chk,
      question: 'Which of my own claims do I hold in checkout?',
      paraphrase: 'What do I currently own in the checkout repository?',
      claimIds: [b1.id, b2.id],
      symbolIds: [CHECKOUT_ORDER_SERVICE],
      forbiddenIds: [g1.id, a7.id, a10.id],
      hops: [
        h('about', b1.id, T_GUEST),
        h('affects', T_GUEST, CHECKOUT_ORDER_SERVICE),
        h('about', b2.id, CHECKOUT_ORDER_SERVICE),
      ],
    },
    {
      base: 'q-iso-beta-retry-emptiness',
      family: 'isolation',
      principal: PRINCIPAL_BETA,
      scope: led,
      question: 'Show me everything about ledger retry idempotency.',
      paraphrase: 'What is known about making ledger retries idempotent?',
      claimIds: [],
      forbiddenIds: [d1.id, d2.id, a3.id, a4.id, a5.id, a6.id],
      hops: [],
    },
    {
      base: 'q-iso-beta-global-emptiness',
      family: 'isolation',
      principal: PRINCIPAL_BETA,
      scope: glb,
      question: 'What tooling conventions do I hold in global memory?',
      paraphrase: 'Which of my global claims constrain monorepo tooling?',
      claimIds: [],
      forbiddenIds: [g1.id, gd1.id],
      hops: [],
    },
    {
      base: 'q-iso-beta-work-emptiness',
      family: 'isolation',
      principal: PRINCIPAL_BETA,
      scope: led,
      question: 'What ledger work exists that I can see?',
      paraphrase: 'Which ledger intakes are visible to me?',
      claimIds: [],
      forbiddenIds: [intakeAlphaOpen.id, intakeAlphaDone.id],
      hops: [],
    },

    // ── cross-repo ── same names, different identities; one principal spanning repositories.
    {
      base: 'q-xr-os-no-merge',
      family: 'cross-repo',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'Is my OrderService the same entity as any other OrderService?',
      paraphrase: 'Does my OrderService claim conflate the ledger symbol with a checkout one?',
      claimIds: [a9.id],
      symbolIds: [LEDGER_ORDER_SERVICE],
      entityIds: [E_OS_LEDGER],
      forbiddenIds: [b2.id, E_OS_CHECKOUT],
      hops: [
        h('about', a9.id, LEDGER_ORDER_SERVICE),
        h('part-of', LEDGER_ORDER_SERVICE, E_OS_LEDGER),
      ],
    },
    {
      base: 'q-xr-alpha-span',
      family: 'cross-repo',
      principal: PRINCIPAL_ALPHA,
      scope: {},
      question: 'Which repositories do my connected claims touch?',
      paraphrase: 'Across repos, which of my claims link decisions and code together?',
      claimIds: [d2.id, a10.id],
      symbolIds: [SETTLE_ORDER, CHECKOUT_CART],
      forbiddenIds: [b1.id, b2.id],
      hops: [
        h('about', d2.id, T_RETRY_IDEM),
        h('affects', T_RETRY_IDEM, SETTLE_ORDER),
        h('about', a10.id, CHECKOUT_CART),
        h('part-of', CHECKOUT_CART, E_CHECKOUT),
      ],
    },

    // ── decoy ── confusable global content must never hijack a labeled question.
    {
      base: 'q-decoy-put-vs-ledger',
      family: 'decoy',
      principal: PRINCIPAL_ALPHA,
      scope: led,
      question: 'Which claims answer the ledger retry idempotency question from my own records?',
      paraphrase:
        'What in my memory actually governs ledger retries — not generic idempotency lore?',
      claimIds: [d2.id],
      symbolIds: [SETTLE_ORDER],
      forbiddenIds: [gd1.id],
      hops: [h('about', d2.id, T_RETRY_IDEM), h('affects', T_RETRY_IDEM, SETTLE_ORDER)],
    },
    {
      base: 'q-decoy-window-emptiness',
      family: 'decoy',
      principal: PRINCIPAL_ALPHA,
      scope: glb,
      question: 'Does any global claim set the ledger retry window?',
      paraphrase: 'Is the ledger retry window decided anywhere in my global memory?',
      claimIds: [],
      forbiddenIds: [gd1.id, g1.id],
      hops: [],
    },
  ];

  const questions = seedsToQuestions(seeds);
  const questionCounts = {} as Record<GraphQuestionFamily, number>;
  for (const family of [
    'current',
    'historical',
    'conflict',
    'isolation',
    'rename',
    'work',
    'cross-repo',
    'decoy',
  ] as GraphQuestionFamily[]) {
    questionCounts[family] = questions.filter((q) => q.family === family).length;
  }

  return {
    version: GRAPH_CORPUS_VERSION,
    principals: { alpha: PRINCIPAL_ALPHA, beta: PRINCIPAL_BETA },
    repoIds: { ledger: REPO_LEDGER, checkout: REPO_CHECKOUT },
    symbols: [
      CHARGE_ORDER,
      SETTLE_ORDER,
      LEDGER_ORDER_SERVICE,
      LEDGER_JOURNAL,
      CHECKOUT_ORDER_SERVICE,
      CHECKOUT_CART,
    ],
    topics: [T_RETRY_IDEM, T_RETRY_WINDOW, T_RELEASE, T_LOCK_RACE, T_GUEST, T_TOOLING, T_DECOY],
    entities,
    anchors: [
      ARTIFACT_RETRIES,
      ARTIFACT_RELEASE,
      ARTIFACT_TOOLING,
      ATT_ALPHA,
      ATT_BETA,
      RCPT_FAIL,
      RCPT_PASS,
    ],
    records: [...alphaAll, ...betaAll, gd1],
    recordsByRole,
    globalDecoys: [gd1],
    decisions: [supersedeDecision],
    intakes: [intakeAlphaDone, intakeAlphaOpen, intakeBetaOpen],
    checkpoints: [
      checkpointAlphaDoneProgress,
      checkpointAlphaDone,
      checkpointAlphaOpen,
      checkpointBetaOpen,
    ],
    intakeIds: {
      alphaDone: intakeAlphaDone.id,
      alphaOpen: intakeAlphaOpen.id,
      betaOpen: intakeBetaOpen.id,
    },
    renamedCode,
    expectedRelationships,
    questions,
    questionCounts,
  };
}
