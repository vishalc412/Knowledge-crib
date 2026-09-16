/**
 * Held-out graph evaluation questions, version 2.
 *
 * An INDEPENDENT question set over the frozen v1 fixture universe (`buildGraphCorpus`). It was
 * authored without access to any retrieval code, evaluation harness, or prior gate results, so a
 * configuration tuned against the v1 questions cannot have been selected on these. The fixture
 * universe is reused unchanged; only the questions are new. Each question carries exactly one
 * phrasing variant — terse developer shorthand (`exact`), different vocabulary (`paraphrase`), or a
 * task framing (`context`) — rather than three renderings of one seed.
 *
 * Ids are never hardcoded: every record, intake, symbol, topic, entity, and anchor is taken from
 * the built corpus, and every hop is checked against `corpus.expectedRelationships` at build time,
 * so a hop the corpus does not hold fails the build rather than the evaluation.
 */

import type {
  GraphCorpus,
  GraphHop,
  GraphPredicate,
  GraphQuestion,
  GraphQuestionFamily,
} from './corpus.js';

/** Version of this held-out question set. Bump on any question change — never edit in place. */
export const GRAPH_HELDOUT_CORPUS_VERSION = 2;

/** Same literal-clock format as the v1 corpus: `2026-09-<dd>T<hh>:00:00.000Z`. */
const at = (day: number, hour = 0): string =>
  `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

/** Take exactly `count` items from a frozen corpus list, failing loudly if the universe drifted. */
function exactly<T>(items: readonly T[], count: number, label: string): T[] {
  if (items.length !== count) {
    throw new Error(`held-out v2: expected ${count} ${label}, corpus has ${items.length}`);
  }
  return [...items];
}

function byId<T extends { id: string }>(items: readonly T[], id: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`held-out v2: missing ${id}`);
  return found;
}

interface QuestionSpec {
  knownAt?: string;
  claims?: string[];
  symbols?: string[];
  entities?: string[];
  intakes?: string[];
  forbidden?: string[];
  hops: GraphHop[];
}

export function buildHeldOutGraphQuestions(corpus: GraphCorpus): GraphQuestion[] {
  const [d1, d2, a3, a4, a5, a6, a7, a8, a9, a11] = exactly(
    corpus.recordsByRole.alphaLedger,
    10,
    'alpha ledger records',
  ).map((r) => r.id) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const [g1] = exactly(corpus.recordsByRole.alphaGlobal, 1, 'alpha global records').map(
    (r) => r.id,
  ) as [string];
  const [a10] = exactly(corpus.recordsByRole.alphaCrossRepo, 1, 'alpha cross-repo records').map(
    (r) => r.id,
  ) as [string];
  const [b1, b2] = exactly(corpus.recordsByRole.betaCheckout, 2, 'beta checkout records').map(
    (r) => r.id,
  ) as [string, string];
  const [gd1] = exactly(corpus.globalDecoys, 1, 'global decoys').map((r) => r.id) as [string];

  const [CHARGE, SETTLE, LEDGER_OS, JOURNAL, CHECKOUT_OS, CART] = exactly(
    corpus.symbols,
    6,
    'symbols',
  ) as [string, string, string, string, string, string];
  const [T_IDEM, T_WINDOW, T_RELEASE, T_LOCK, T_GUEST, T_TOOLING] = exactly(
    corpus.topics,
    7,
    'topics',
  ) as [string, string, string, string, string, string, string];
  const [ART_RETRIES, ART_RELEASE, ART_TOOLING, ATT_ALPHA, ATT_BETA, RCPT_FAIL, RCPT_PASS] =
    exactly(corpus.anchors, 7, 'anchors') as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
  const [E_LEDGER, E_CHECKOUT, E_OS_LEDGER, E_OS_CHECKOUT, E_JOURNAL] = exactly(
    corpus.entities,
    5,
    'entities',
  ).map((e) => e.id) as [string, string, string, string, string];

  const I_DONE = byId(corpus.intakes, corpus.intakeIds.alphaDone).id;
  const I_OPEN = byId(corpus.intakes, corpus.intakeIds.alphaOpen).id;
  const I_BETA = byId(corpus.intakes, corpus.intakeIds.betaOpen).id;

  const ALPHA = corpus.principals.alpha;
  const BETA = corpus.principals.beta;
  const L = { repoId: corpus.repoIds.ledger };
  const C = { repoId: corpus.repoIds.checkout };
  const G = { global: true };
  const X = {};

  /** A hop the corpus actually holds — anything else is an authoring defect caught at build. */
  const e = (predicate: GraphPredicate, from: string, to: string): GraphHop => {
    const held = corpus.expectedRelationships.some(
      (rel) => rel.predicate === predicate && rel.from === from && rel.to === to,
    );
    if (!held) throw new Error(`held-out v2: ${predicate} ${from} -> ${to} is not in the corpus`);
    return { predicate, from, to };
  };

  // Named hops (alpha).
  const d1About = e('about', d1, T_IDEM);
  const d2About = e('about', d2, T_IDEM);
  const d2Supersedes = e('supersedes', d2, d1);
  const d1Doc = e('supported-by', d1, ART_RETRIES);
  const d1Att = e('supported-by', d1, ATT_ALPHA);
  const d2Doc = e('supported-by', d2, ART_RETRIES);
  const d2Att = e('supported-by', d2, ATT_ALPHA);
  const idemSettle = e('affects', T_IDEM, SETTLE);
  const idemCharge = e('affects', T_IDEM, CHARGE);
  const a3About = e('about', a3, CHARGE);
  const a4About = e('about', a4, SETTLE);
  const a4Derived = e('derived-from', a4, a3);
  const a5About = e('about', a5, T_WINDOW);
  const a6About = e('about', a6, T_WINDOW);
  const a5Src = e('supported-by', a5, JOURNAL);
  const a6Src = e('supported-by', a6, JOURNAL);
  const a5Applies = e('applies-to', a5, JOURNAL);
  const a6Applies = e('applies-to', a6, JOURNAL);
  const a7Applies = e('applies-to', a7, JOURNAL);
  const a5Contra = e('contradicts', a5, a6);
  const a6Contra = e('contradicts', a6, a5);
  const a7About = e('about', a7, T_RELEASE);
  const a7Doc = e('supported-by', a7, ART_RELEASE);
  const a8About = e('about', a8, T_LOCK);
  const a8Fail = e('supported-by', a8, RCPT_FAIL);
  const a8Pass = e('supported-by', a8, RCPT_PASS);
  const a9About = e('about', a9, LEDGER_OS);
  const a10About = e('about', a10, CART);
  const a11About = e('about', a11, JOURNAL);
  const g1About = e('about', g1, T_TOOLING);
  const g1Doc = e('supported-by', g1, ART_TOOLING);
  const chargePart = e('part-of', CHARGE, E_LEDGER);
  const settlePart = e('part-of', SETTLE, E_LEDGER);
  const ledgerOsPart = e('part-of', LEDGER_OS, E_OS_LEDGER);
  const journalPart = e('part-of', JOURNAL, E_JOURNAL);
  const cartPart = e('part-of', CART, E_CHECKOUT);
  const doneAbout = e('about', I_DONE, T_IDEM);
  const openAbout = e('about', I_OPEN, T_IDEM);
  // Named hops (beta).
  const b1About = e('about', b1, T_GUEST);
  const b1Att = e('supported-by', b1, ATT_BETA);
  const guestAffects = e('affects', T_GUEST, CHECKOUT_OS);
  const b2About = e('about', b2, CHECKOUT_OS);
  const betaAbout = e('about', I_BETA, T_GUEST);

  const questions: GraphQuestion[] = [];
  const q = (
    id: string,
    variant: GraphQuestion['variant'],
    family: GraphQuestionFamily,
    principal: string,
    scope: GraphQuestion['scope'],
    question: string,
    spec: QuestionSpec,
  ): void => {
    const expected: GraphQuestion['expected'] = { claimIds: spec.claims ?? [], hops: spec.hops };
    if (spec.symbols) expected.symbolIds = spec.symbols;
    if (spec.entities) expected.entityIds = spec.entities;
    if (spec.intakes) expected.intakeIds = spec.intakes;
    if (spec.forbidden) expected.forbiddenIds = spec.forbidden;
    const built: GraphQuestion = {
      id: `h2-${id}`,
      question,
      variant,
      family,
      principal,
      scope,
      expected,
    };
    if (spec.knownAt !== undefined) built.knownAt = spec.knownAt;
    questions.push(built);
  };

  // ── current ────────────────────────────────────────────────────────────────
  q(
    'cur-retry-key-now',
    'exact',
    'current',
    ALPHA,
    L,
    'ledger retry dedupe key: current rule and the function enforcing it?',
    {
      claims: [d2],
      symbols: [SETTLE],
      forbidden: [d1],
      hops: [d2About, idemSettle],
    },
  );
  q(
    'cur-retry-key-replay',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'How do we presently stop a replayed ledger request from being applied twice, and which code carries that?',
    {
      claims: [d2],
      symbols: [SETTLE],
      forbidden: [d1],
      hops: [d2About, idemSettle, d2Supersedes],
    },
  );
  q(
    'cur-retry-key-edit-settle',
    'context',
    'current',
    ALPHA,
    L,
    "I'm about to touch the retry handling in settleOrder. Which standing decision constrains me, and what did it replace?",
    {
      claims: [d2],
      symbols: [SETTLE],
      forbidden: [d1],
      hops: [idemSettle, d2About, d2Supersedes],
    },
  );
  q(
    'cur-retry-key-sources',
    'exact',
    'current',
    ALPHA,
    L,
    'current retry-key decision: runbook section + attestation behind it',
    {
      claims: [d2],
      forbidden: [d1],
      hops: [d2About, d2Doc, d2Att],
    },
  );
  q(
    'cur-retry-key-signoff',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'Who signed off on the way repeated ledger attempts are keyed, and which document records it?',
    {
      claims: [d2],
      forbidden: [d1],
      hops: [d2Doc, d2Att],
    },
  );
  q(
    'cur-runbook-edit',
    'context',
    'current',
    ALPHA,
    L,
    'Before I edit the retries section of the ledger runbook: which live decision cites it and who vouched for it?',
    {
      claims: [d2],
      forbidden: [d1],
      hops: [d2Doc, d2Att, d2About],
    },
  );
  q(
    'cur-settle-origin',
    'exact',
    'current',
    ALPHA,
    L,
    'settleOrder contract + the claim it derives from',
    {
      claims: [a4],
      symbols: [SETTLE],
      hops: [a4About, a4Derived],
    },
  );
  q(
    'cur-settle-repo',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'Which repository houses the settlement function, and what do my notes say it promises?',
    {
      claims: [a4],
      symbols: [SETTLE],
      entities: [E_LEDGER],
      hops: [a4About, settlePart],
    },
  );
  q(
    'cur-settle-refactor',
    'context',
    'current',
    ALPHA,
    L,
    "I'm refactoring settleOrder. What behaviour must survive, and what rule governs its retries?",
    {
      claims: [a4, d2],
      symbols: [SETTLE],
      forbidden: [d1],
      hops: [a4About, idemSettle, d2About],
    },
  );
  q('cur-ledger-os', 'exact', 'current', ALPHA, L, 'ledger OrderService: responsibility + entity', {
    claims: [a9],
    symbols: [LEDGER_OS],
    entities: [E_OS_LEDGER],
    forbidden: [b2],
    hops: [a9About, ledgerOsPart],
  });
  q(
    'cur-ledger-os-job',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'What is the order service in the ledger codebase responsible for, and which component record does it map to?',
    {
      claims: [a9],
      symbols: [LEDGER_OS],
      entities: [E_OS_LEDGER],
      forbidden: [b2],
      hops: [a9About, ledgerOsPart],
    },
  );
  q(
    'cur-ledger-os-change',
    'context',
    'current',
    ALPHA,
    L,
    'Planning a change to the ledger OrderService replay path. What should I know first, and which entity will the change land in?',
    {
      claims: [a9],
      symbols: [LEDGER_OS],
      entities: [E_OS_LEDGER],
      forbidden: [b2],
      hops: [ledgerOsPart, a9About],
    },
  );
  q(
    'cur-journal-appends',
    'exact',
    'current',
    ALPHA,
    L,
    'LedgerJournal append ordering: claim + owning entity',
    {
      claims: [a11],
      symbols: [JOURNAL],
      entities: [E_JOURNAL],
      hops: [a11About, journalPart],
    },
  );
  q(
    'cur-journal-interleave',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'What keeps writes to the journal from interleaving, and what kind of component is the journal registered as?',
    {
      claims: [a11],
      symbols: [JOURNAL],
      entities: [E_JOURNAL],
      hops: [a11About, journalPart],
    },
  );
  q(
    'cur-journal-concurrent',
    'context',
    'current',
    ALPHA,
    L,
    'I want to let journal appends run concurrently. What recorded knowledge pushes back, and which entity would I be changing?',
    {
      claims: [a11],
      symbols: [JOURNAL],
      entities: [E_JOURNAL],
      hops: [journalPart, a11About],
    },
  );
  q('cur-journal-all', 'exact', 'current', ALPHA, L, 'everything that applies to LedgerJournal', {
    claims: [a5, a6, a7, a11],
    symbols: [JOURNAL],
    hops: [a5Applies, a6Applies, a7Applies, a11About],
  });
  q(
    'cur-release-gate',
    'exact',
    'current',
    ALPHA,
    L,
    'ledger pre-release gate + the doc mandating it',
    {
      claims: [a7],
      hops: [a7About, a7Doc],
    },
  );
  q(
    'cur-release-ship',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'What has to happen before we ship a new ledger version, where is it written down, and what code does it cover?',
    {
      claims: [a7],
      symbols: [JOURNAL],
      hops: [a7About, a7Doc, a7Applies],
    },
  );
  q(
    'cur-release-tomorrow',
    'context',
    'current',
    ALPHA,
    L,
    "I'm cutting a ledger release tomorrow. Which checklist step applies, and what part of the code does it guard?",
    {
      claims: [a7],
      symbols: [JOURNAL],
      hops: [a7About, a7Applies, a7Doc],
    },
  );
  q('cur-lock-pitfall', 'exact', 'current', ALPHA, L, 'ledger lock race pitfall + receipts', {
    claims: [a8],
    hops: [a8About, a8Fail, a8Pass],
  });
  q(
    'cur-lock-two-writers',
    'paraphrase',
    'current',
    ALPHA,
    L,
    'Were we ever bitten by two writers grabbing the ledger lock at once, and what shows the fix held?',
    {
      claims: [a8],
      hops: [a8About, a8Fail, a8Pass],
    },
  );
  q(
    'cur-lock-rewrite',
    'context',
    'current',
    ALPHA,
    L,
    'About to rewrite how the ledger acquires its lock. Is there a past incident I should read, with its before-and-after runs?',
    {
      claims: [a8],
      hops: [a8Fail, a8Pass, a8About],
    },
  );
  q(
    'cur-pnpm-global',
    'exact',
    'current',
    ALPHA,
    G,
    'global package-manager convention + its source file',
    {
      claims: [g1],
      forbidden: [gd1],
      hops: [g1About, g1Doc],
    },
  );
  q(
    'cur-installer-rule',
    'paraphrase',
    'current',
    ALPHA,
    G,
    'Which installer am I required to use across all my projects, and what file says so?',
    {
      claims: [g1],
      hops: [g1About, g1Doc],
    },
  );
  q(
    'cur-fresh-workspace',
    'context',
    'current',
    ALPHA,
    G,
    'Setting up a fresh workspace install. Is there a standing rule about dependency tooling I must follow, and where does it come from?',
    {
      claims: [g1],
      hops: [g1Doc, g1About],
    },
  );
  q(
    'cur-cart-lock',
    'exact',
    'current',
    ALPHA,
    C,
    'checkout Cart locking behaviour + repo entity',
    {
      claims: [a10],
      symbols: [CART],
      entities: [E_CHECKOUT],
      forbidden: [b1, b2],
      hops: [a10About, cartPart],
    },
  );
  q(
    'cur-cart-auth-change',
    'context',
    'current',
    ALPHA,
    C,
    "I'm changing how Cart behaves while a payment authorization is pending. What do I already know, and which repository owns it?",
    {
      claims: [a10],
      symbols: [CART],
      entities: [E_CHECKOUT],
      forbidden: [b1, b2],
      hops: [cartPart, a10About],
    },
  );
  q(
    'cur-guest-retention',
    'exact',
    'current',
    BETA,
    C,
    'guest card retention decision + affected code',
    {
      claims: [b1],
      symbols: [CHECKOUT_OS],
      forbidden: [a10],
      hops: [b1About, guestAffects],
    },
  );
  q(
    'cur-guest-hold-card',
    'paraphrase',
    'current',
    BETA,
    C,
    "How long may we hold on to a guest shopper's card details, and which service does that rule reach?",
    {
      claims: [b1],
      symbols: [CHECKOUT_OS],
      forbidden: [a10],
      hops: [b1About, guestAffects],
    },
  );
  q(
    'cur-guest-new-field',
    'context',
    'current',
    BETA,
    C,
    "I'm adding a persisted field to the checkout OrderService. Which retention rule could that break, and who attested it?",
    {
      claims: [b1],
      symbols: [CHECKOUT_OS],
      hops: [guestAffects, b1About, b1Att],
    },
  );
  q('cur-guest-attested', 'exact', 'current', BETA, C, 'guest retention decision: attestation', {
    claims: [b1],
    hops: [b1About, b1Att],
  });
  q(
    'cur-checkout-os-all',
    'exact',
    'current',
    BETA,
    C,
    'checkout OrderService: facts + constraints on it',
    {
      claims: [b1, b2],
      symbols: [CHECKOUT_OS],
      forbidden: [a9],
      hops: [b2About, guestAffects, b1About],
    },
  );
  q(
    'cur-checkout-os-stock',
    'paraphrase',
    'current',
    BETA,
    C,
    'Does the order service in checkout add up the basket before holding stock, and does any card-data rule touch it?',
    {
      claims: [b1, b2],
      symbols: [CHECKOUT_OS],
      forbidden: [a9],
      hops: [b2About, guestAffects, b1About],
    },
  );
  q(
    'cur-retry-evidence-review',
    'context',
    'current',
    ALPHA,
    L,
    "I'm reviewing a PR that changes the ledger's duplicate-request key. What is the governing decision, what backs it, and which function is in play?",
    {
      claims: [d2],
      symbols: [SETTLE],
      forbidden: [d1],
      hops: [d2About, d2Doc, idemSettle],
    },
  );

  // ── historical ─────────────────────────────────────────────────────────────
  q(
    'hist-key-sep9',
    'exact',
    'historical',
    ALPHA,
    L,
    'retry key rule as of Sep 9 + the function it targeted',
    {
      knownAt: at(9),
      claims: [d1],
      symbols: [CHARGE],
      forbidden: [d2, a4],
      hops: [d1About, idemCharge],
    },
  );
  q(
    'hist-key-fifth-signoff',
    'paraphrase',
    'historical',
    ALPHA,
    L,
    'Back on the fifth, how were duplicate ledger attempts recognised, and who had approved that approach?',
    {
      knownAt: at(5),
      claims: [d1],
      forbidden: [d2],
      hops: [d1About, d1Att, d1Doc],
    },
  );
  q(
    'hist-incident-eighth',
    'context',
    'historical',
    ALPHA,
    L,
    'Reconstructing an incident from the 8th: which dedupe rule was in force for ledger charges then, and what did the charging code promise?',
    {
      knownAt: at(8),
      claims: [d1, a3],
      symbols: [CHARGE],
      forbidden: [d2, a4],
      hops: [d1About, idemCharge, a3About],
    },
  );
  q('hist-key-lineage', 'exact', 'historical', ALPHA, L, 'retry key decision lineage by the 15th', {
    knownAt: at(15),
    claims: [d2, d1],
    hops: [d2Supersedes, d1About, d2About],
  });
  q(
    'hist-key-replaced-11',
    'paraphrase',
    'historical',
    ALPHA,
    L,
    'By the eleventh, had the original dedupe rule been swapped out? Show the old one and its replacement.',
    {
      knownAt: at(11),
      claims: [d1, d2],
      forbidden: [a4],
      hops: [d2Supersedes, d2About, d1About],
    },
  );
  q(
    'hist-postmortem-13',
    'context',
    'historical',
    ALPHA,
    L,
    'Writing a postmortem on duplicate settlements as of the 13th: what did the keying rule look like before and after the switch, and which function does it reach now?',
    {
      knownAt: at(13),
      claims: [d1, d2],
      symbols: [SETTLE],
      hops: [d2Supersedes, d2About, idemSettle],
    },
  );
  q(
    'hist-supersede-hour',
    'exact',
    'historical',
    ALPHA,
    L,
    'retry key decisions at the hour the replacement was recorded',
    {
      knownAt: at(10, 1),
      claims: [d1, d2],
      forbidden: [a4],
      hops: [d2Supersedes, d2About, d1About],
    },
  );
  q(
    'hist-window-4th',
    'exact',
    'historical',
    ALPHA,
    L,
    'retry window as of the 4th + where it is quoted',
    {
      knownAt: at(4),
      claims: [a5],
      symbols: [JOURNAL],
      forbidden: [a6],
      hops: [a5About, a5Src],
    },
  );
  q(
    'hist-window-fifth-seconds',
    'paraphrase',
    'historical',
    ALPHA,
    L,
    'On the fifth, how long did we believe the ledger paused before trying again, and which code did that apply to?',
    {
      knownAt: at(5),
      claims: [a5],
      symbols: [JOURNAL],
      forbidden: [a6],
      hops: [a5About, a5Applies],
    },
  );
  q('hist-window-7th', 'exact', 'historical', ALPHA, L, 'retry window claims recorded by the 7th', {
    knownAt: at(7),
    claims: [a5, a6],
    hops: [a5About, a6About, a5Contra],
  });
  q(
    'hist-timeout-6th',
    'context',
    'historical',
    ALPHA,
    L,
    'Debugging a timeout from the 6th: which retry-delay beliefs were on record then, and did they disagree?',
    {
      knownAt: at(6),
      claims: [a5, a6],
      hops: [a5Contra, a6Contra, a5About],
    },
  );
  q('hist-ledger-3rd', 'exact', 'historical', ALPHA, L, 'ledger memory recorded by the 3rd', {
    knownAt: at(3),
    claims: [d1, a3, a5],
    symbols: [CHARGE],
    forbidden: [a7, a8, a6, d2],
    hops: [d1About, idemCharge, a3About, a5About],
  });
  q(
    'hist-charges-second',
    'paraphrase',
    'historical',
    ALPHA,
    L,
    'As of the second, what did I know about how ledger charges avoid being processed twice?',
    {
      knownAt: at(2),
      claims: [d1, a3],
      symbols: [CHARGE],
      forbidden: [a5, d2],
      hops: [a3About, idemCharge, d1About],
    },
  );
  q(
    'hist-ledger-os-7th',
    'exact',
    'historical',
    ALPHA,
    L,
    'ledger OrderService knowledge on the 7th',
    {
      knownAt: at(7),
      claims: [a9],
      symbols: [LEDGER_OS],
      entities: [E_OS_LEDGER],
      forbidden: [a11],
      hops: [a9About, ledgerOsPart],
    },
  );
  q(
    'hist-journal-7th',
    'exact',
    'historical',
    ALPHA,
    L,
    'LedgerJournal-related claims as of the 7th',
    {
      knownAt: at(7),
      claims: [a5, a6, a7],
      symbols: [JOURNAL],
      forbidden: [a11],
      hops: [a5Applies, a6Applies, a7Applies],
    },
  );
  q(
    'hist-journal-ninth',
    'paraphrase',
    'historical',
    ALPHA,
    L,
    'As of the ninth, what was on file about how the journal serializes writes, and what component is it?',
    {
      knownAt: at(9),
      claims: [a11],
      symbols: [JOURNAL],
      entities: [E_JOURNAL],
      forbidden: [a4],
      hops: [a11About, journalPart],
    },
  );
  q('hist-release-4th', 'exact', 'historical', ALPHA, L, 'release checklist on the 4th', {
    knownAt: at(4),
    claims: [a7],
    forbidden: [a8],
    hops: [a7About, a7Doc],
  });
  q(
    'hist-shipped-4th',
    'context',
    'historical',
    ALPHA,
    L,
    'We shipped a ledger build on the 4th. Was the harness step already a rule by then, and which code did it cover?',
    {
      knownAt: at(4),
      claims: [a7],
      symbols: [JOURNAL],
      hops: [a7About, a7Applies],
    },
  );
  q(
    'hist-lock-fifth',
    'paraphrase',
    'historical',
    ALPHA,
    L,
    'Was the two-writer lock bug already captured in memory by the fifth, along with its proof runs?',
    {
      knownAt: at(5),
      claims: [a8],
      forbidden: [a6],
      hops: [a8About, a8Fail, a8Pass],
    },
  );
  q('hist-cart-9th', 'exact', 'historical', ALPHA, C, 'cart lock claim as of the 9th + repo', {
    knownAt: at(9),
    claims: [a10],
    symbols: [CART],
    entities: [E_CHECKOUT],
    forbidden: [b1, b2],
    hops: [a10About, cartPart],
  });
  q(
    'hist-guest-4th',
    'exact',
    'historical',
    BETA,
    C,
    'guest retention decision on the 4th + attestation',
    {
      knownAt: at(4),
      claims: [b1],
      forbidden: [b2],
      hops: [b1About, b1Att],
    },
  );
  q(
    'hist-guest-fifth',
    'paraphrase',
    'historical',
    BETA,
    C,
    'By the fifth, what did I have on file about keeping guest card data, and about the order service it reaches?',
    {
      knownAt: at(5),
      claims: [b1, b2],
      symbols: [CHECKOUT_OS],
      hops: [b1About, guestAffects, b2About],
    },
  );
  q(
    'hist-checkout-review-4th',
    'context',
    'historical',
    BETA,
    C,
    'Reviewing checkout as it stood on the 4th: which retention decision existed and which code did it bind, before any order-service note was written?',
    {
      knownAt: at(4),
      claims: [b1],
      symbols: [CHECKOUT_OS],
      forbidden: [b2],
      hops: [b1About, guestAffects],
    },
  );
  q('hist-global-2nd', 'exact', 'historical', ALPHA, G, 'global conventions recorded by the 2nd', {
    knownAt: at(2),
    claims: [g1],
    forbidden: [gd1],
    hops: [g1About, g1Doc],
  });

  // ── rename ─────────────────────────────────────────────────────────────────
  q(
    'ren-old-name',
    'exact',
    'rename',
    ALPHA,
    L,
    'settleOrder: previous name + how its contract carried over',
    {
      knownAt: at(15),
      claims: [a4, a3],
      symbols: [SETTLE, CHARGE],
      hops: [a4About, a4Derived, a3About],
    },
  );
  q(
    'ren-called-before',
    'paraphrase',
    'rename',
    ALPHA,
    L,
    'What was the settlement function called before, and how did its guarantee move across?',
    {
      knownAt: at(13),
      claims: [a4, a3],
      symbols: [SETTLE, CHARGE],
      hops: [a4About, a4Derived, a3About],
    },
  );
  q(
    'ren-stale-script',
    'context',
    'rename',
    ALPHA,
    L,
    'I found a stale reference to chargeOrder in a script. What is that function called now, and does the same retry rule still apply to it?',
    {
      knownAt: at(15),
      claims: [a3, a4, d2],
      symbols: [CHARGE, SETTLE],
      hops: [a3About, a4Derived, a4About, idemSettle, d2About],
    },
  );
  q('ren-charge-pre', 'exact', 'rename', ALPHA, L, 'chargeOrder contract before the rename', {
    knownAt: at(11),
    claims: [a3],
    symbols: [CHARGE],
    forbidden: [a4],
    hops: [a3About, idemCharge],
  });
  q(
    'ren-charge-repo-10th',
    'paraphrase',
    'rename',
    ALPHA,
    L,
    'Before the rename landed, which function did the dedupe rule target, and which repository held it?',
    {
      knownAt: at(10),
      claims: [a3],
      symbols: [CHARGE],
      entities: [E_LEDGER],
      forbidden: [a4],
      hops: [a3About, chargePart],
    },
  );
  q(
    'ren-both-names-repo',
    'exact',
    'rename',
    ALPHA,
    L,
    'chargeOrder + settleOrder -> owning repo entity',
    {
      knownAt: at(15),
      claims: [a3, a4],
      symbols: [CHARGE, SETTLE],
      entities: [E_LEDGER],
      hops: [chargePart, settlePart, a4Derived],
    },
  );
  q(
    'ren-blame',
    'context',
    'rename',
    ALPHA,
    L,
    "I'm reading blame across the charge-to-settle rename. Which claims tie the two names together, and which retry decisions pointed at each name?",
    {
      knownAt: at(13),
      claims: [a3, a4, d1, d2],
      symbols: [CHARGE, SETTLE],
      hops: [a4Derived, idemCharge, idemSettle, d2Supersedes],
    },
  );
  q('ren-settle-chain', 'exact', 'rename', ALPHA, L, 'settleOrder derived-from chain', {
    claims: [a4],
    symbols: [SETTLE],
    hops: [a4About, a4Derived],
  });
  q(
    'ren-day-of',
    'paraphrase',
    'rename',
    ALPHA,
    L,
    'On the day the function was renamed, did memory already know the new name and what it grew out of?',
    {
      knownAt: at(12),
      claims: [a4, a3],
      symbols: [SETTLE],
      hops: [a4About, a4Derived],
    },
  );
  q(
    'ren-old-branch',
    'context',
    'rename',
    ALPHA,
    L,
    "I'm on an old branch as of the 9th. Is there any settlement-function knowledge I can trust yet, and which repo is it in?",
    {
      knownAt: at(9),
      claims: [a3],
      symbols: [CHARGE],
      entities: [E_LEDGER],
      forbidden: [a4],
      hops: [a3About, chargePart],
    },
  );
  q('ren-rule-target-now', 'exact', 'rename', ALPHA, L, 'retry rule code target after the rename', {
    claims: [d2, a4],
    symbols: [SETTLE],
    forbidden: [d1],
    hops: [idemSettle, a4About, d2About],
  });

  // ── conflict ───────────────────────────────────────────────────────────────
  q(
    'conf-window-values',
    'exact',
    'conflict',
    ALPHA,
    L,
    'ledger retry window: conflicting values?',
    {
      claims: [a5, a6],
      hops: [a5About, a6About, a5Contra],
    },
  );
  q(
    'conf-notes-agree',
    'paraphrase',
    'conflict',
    ALPHA,
    L,
    'Do my notes agree on how long the ledger pauses before re-attempting?',
    {
      claims: [a5, a6],
      hops: [a5Contra, a6Contra],
    },
  );
  q(
    'conf-hardcode-delay',
    'context',
    'conflict',
    ALPHA,
    L,
    "I'm about to hardcode the ledger's retry delay. Is the value actually settled, and what code does each version point at?",
    {
      claims: [a5, a6],
      symbols: [JOURNAL],
      hops: [a5Applies, a6Applies, a5Contra],
    },
  );
  q(
    'conf-window-anchors',
    'exact',
    'conflict',
    ALPHA,
    L,
    'retry window dispute: journal anchor for each side',
    {
      claims: [a5, a6],
      symbols: [JOURNAL],
      hops: [a5Src, a6Src, a6Contra],
    },
  );
  q(
    'conf-source-lines',
    'paraphrase',
    'conflict',
    ALPHA,
    L,
    'Which source quote backs each of the competing retry delay figures?',
    {
      claims: [a5, a6],
      symbols: [JOURNAL],
      hops: [a5Src, a6Src, a5Contra],
    },
  );
  q(
    'conf-tuning',
    'context',
    'conflict',
    ALPHA,
    L,
    'Tuning journal retries: show me both disputed delay claims and how they point at each other.',
    {
      claims: [a5, a6],
      hops: [a6Contra, a5Contra, a5About, a6About],
    },
  );
  q(
    'conf-window-15th',
    'exact',
    'conflict',
    ALPHA,
    L,
    'retry window dispute as recorded by the 15th',
    {
      knownAt: at(15),
      claims: [a5, a6],
      hops: [a5About, a6Contra],
    },
  );
  q(
    'conf-journal-all',
    'exact',
    'conflict',
    ALPHA,
    L,
    'contradictions touching LedgerJournal + its concurrency claim',
    {
      claims: [a5, a6, a11],
      symbols: [JOURNAL],
      hops: [a5Applies, a6Applies, a5Contra, a11About],
    },
  );
  q(
    'conf-journal-contradictory',
    'paraphrase',
    'conflict',
    ALPHA,
    L,
    'Is anything contradictory recorded about the journal component, and which entity is it?',
    {
      claims: [a5, a6],
      symbols: [JOURNAL],
      entities: [E_JOURNAL],
      hops: [a6Applies, a5Contra, journalPart],
    },
  );
  q(
    'conf-timeline-fifth',
    'context',
    'conflict',
    ALPHA,
    L,
    'Replaying the timeline: on the fifth, was the retry delay already in dispute, or was there a single value?',
    {
      knownAt: at(5),
      claims: [a5],
      forbidden: [a6],
      hops: [a5About, a5Src],
    },
  );

  // ── work ───────────────────────────────────────────────────────────────────
  q('work-open-target', 'exact', 'work', ALPHA, L, 'open ledger intake: topic + code target', {
    intakes: [I_OPEN],
    symbols: [SETTLE],
    forbidden: [I_DONE],
    hops: [openAbout, idemSettle],
  });
  q(
    'work-unfinished-function',
    'paraphrase',
    'work',
    ALPHA,
    L,
    'What unfinished job do I have on ledger retries, and which function is it aimed at?',
    {
      intakes: [I_OPEN],
      symbols: [SETTLE],
      forbidden: [I_DONE],
      hops: [openAbout, idemSettle],
    },
  );
  q(
    'work-pick-up',
    'context',
    'work',
    ALPHA,
    L,
    "Picking the ledger work back up after a break. What's still open, which decision frames it, and what code does it touch?",
    {
      claims: [d2],
      intakes: [I_OPEN],
      symbols: [SETTLE],
      forbidden: [I_DONE, d1],
      hops: [openAbout, d2About, idemSettle],
    },
  );
  q(
    'work-done-produced',
    'exact',
    'work',
    ALPHA,
    L,
    'completed ledger intake -> decision it produced',
    {
      claims: [d2],
      intakes: [I_DONE],
      hops: [doneAbout, d2About, d2Supersedes],
    },
  );
  q(
    'work-finished-task',
    'paraphrase',
    'work',
    ALPHA,
    L,
    'Which finished task settled the question of how retries are keyed, and which rule came out of it?',
    {
      claims: [d2],
      intakes: [I_DONE],
      forbidden: [d1],
      hops: [doneAbout, d2About],
    },
  );
  q('work-intakes-9th', 'exact', 'work', ALPHA, L, 'ledger intakes as of the 9th', {
    knownAt: at(9),
    claims: [d1],
    intakes: [I_DONE, I_OPEN],
    forbidden: [d2],
    hops: [doneAbout, openAbout, d1About],
  });
  q(
    'work-fifth-midstream',
    'context',
    'work',
    ALPHA,
    L,
    'On the fifth, what retry work was I in the middle of, which rule had it produced, and which function did that rule cover?',
    {
      knownAt: at(5),
      claims: [d1],
      intakes: [I_DONE],
      symbols: [CHARGE],
      forbidden: [I_OPEN, d2],
      hops: [doneAbout, d1About, idemCharge],
    },
  );
  q('work-resumable-12th', 'exact', 'work', ALPHA, L, 'resumable ledger intakes on the 12th', {
    knownAt: at(12),
    claims: [d2],
    intakes: [I_OPEN],
    forbidden: [I_DONE],
    hops: [openAbout, d2About],
  });
  q('work-beta-open', 'exact', 'work', BETA, C, 'my open checkout intake + affected code', {
    intakes: [I_BETA],
    symbols: [CHECKOUT_OS],
    forbidden: [I_OPEN],
    hops: [betaAbout, guestAffects],
  });
  q(
    'work-beta-revolves',
    'paraphrase',
    'work',
    BETA,
    C,
    'Which checkout job is still open for me, and which decision does it revolve around?',
    {
      claims: [b1],
      intakes: [I_BETA],
      forbidden: [I_OPEN, I_DONE],
      hops: [betaAbout, b1About],
    },
  );
  q(
    'work-beta-resume-audit',
    'context',
    'work',
    BETA,
    C,
    'Resuming my retention audit: which rule am I checking against, who attested it, and where in the code does it apply?',
    {
      claims: [b1],
      intakes: [I_BETA],
      symbols: [CHECKOUT_OS],
      hops: [betaAbout, b1About, b1Att, guestAffects],
    },
  );
  q('work-beta-5th', 'exact', 'work', BETA, C, 'my checkout intakes + related claims by the 5th', {
    knownAt: at(5),
    claims: [b1, b2],
    intakes: [I_BETA],
    symbols: [CHECKOUT_OS],
    hops: [betaAbout, b1About, guestAffects, b2About],
  });
  q(
    'work-close-out',
    'context',
    'work',
    ALPHA,
    L,
    "I've been asked to close out the ledger retry work. Is anything still open on that topic, and what does the current rule rest on?",
    {
      claims: [d2],
      intakes: [I_OPEN],
      forbidden: [I_DONE, d1],
      hops: [openAbout, d2About, d2Doc],
    },
  );
  q(
    'work-same-topic',
    'paraphrase',
    'work',
    ALPHA,
    L,
    'Were both of my ledger retry tasks aimed at the same subject?',
    {
      intakes: [I_DONE, I_OPEN],
      hops: [doneAbout, openAbout],
    },
  );

  // ── isolation ──────────────────────────────────────────────────────────────
  q('iso-alpha-checkout', 'exact', 'isolation', ALPHA, C, 'my own checkout claims', {
    claims: [a10],
    symbols: [CART],
    entities: [E_CHECKOUT],
    forbidden: [b1, b2, I_BETA],
    hops: [a10About, cartPart],
  });
  q(
    'iso-alpha-personal',
    'paraphrase',
    'isolation',
    ALPHA,
    C,
    "In the checkout project, what have I personally recorded, leaving out anyone else's notes?",
    {
      claims: [a10],
      symbols: [CART],
      entities: [E_CHECKOUT],
      forbidden: [b1, b2, I_BETA],
      hops: [a10About, cartPart],
    },
  );
  q(
    'iso-alpha-new-to-checkout',
    'context',
    'isolation',
    ALPHA,
    C,
    "I'm new to the checkout code and only want my own notes. What do I have there, and which repo entity does it hang off?",
    {
      claims: [a10],
      symbols: [CART],
      entities: [E_CHECKOUT],
      forbidden: [b1, b2, I_BETA],
      hops: [cartPart, a10About],
    },
  );
  q('iso-beta-checkout', 'exact', 'isolation', BETA, C, 'my checkout claims + how they link', {
    claims: [b1, b2],
    symbols: [CHECKOUT_OS],
    forbidden: [a10, I_OPEN],
    hops: [b1About, guestAffects, b2About],
  });
  q(
    'iso-beta-handover',
    'context',
    'isolation',
    BETA,
    C,
    'Handing checkout to a teammate. Summarise only what I hold there, how it connects, and who vouched for it.',
    {
      claims: [b1, b2],
      symbols: [CHECKOUT_OS],
      forbidden: [a10],
      hops: [b1About, b1Att, guestAffects, b2About],
    },
  );
  q(
    'iso-beta-os-mine',
    'paraphrase',
    'isolation',
    BETA,
    C,
    "Which order-service facts in checkout are mine, as opposed to a colleague's ledger notes?",
    {
      claims: [b2],
      symbols: [CHECKOUT_OS],
      forbidden: [a9],
      hops: [b2About, guestAffects],
    },
  );
  q('iso-alpha-ledger-os', 'exact', 'isolation', ALPHA, L, 'my ledger OrderService notes only', {
    claims: [a9],
    symbols: [LEDGER_OS],
    entities: [E_OS_LEDGER],
    forbidden: [b2],
    hops: [a9About, ledgerOsPart],
  });
  // Emptiness probes — beta can see none of alpha's memory.
  q(
    'iso-beta-ledger-retries-empty',
    'exact',
    'isolation',
    BETA,
    L,
    'ledger retry notes visible to me',
    {
      forbidden: [d1, d2, a3, a4],
      hops: [],
    },
  );
  q(
    'iso-beta-installer-empty',
    'paraphrase',
    'isolation',
    BETA,
    G,
    'Do I hold any cross-project rules about which installer to use?',
    {
      forbidden: [g1],
      hops: [],
    },
  );
  q(
    'iso-beta-release-empty',
    'context',
    'isolation',
    BETA,
    L,
    "I've been asked to review the ledger release process. Is there anything in my memory about it?",
    {
      forbidden: [a7, a8],
      hops: [],
    },
  );
  q('iso-beta-journal-empty', 'exact', 'isolation', BETA, L, 'ledger journal locking knowledge', {
    forbidden: [a11, a8, a5, a6],
    hops: [],
  });
  q(
    'iso-beta-ledger-tasks-empty',
    'paraphrase',
    'isolation',
    BETA,
    L,
    'Are there any ledger tasks I could resume?',
    {
      forbidden: [I_OPEN, I_DONE],
      hops: [],
    },
  );
  q(
    'iso-beta-global-idem-empty',
    'exact',
    'isolation',
    BETA,
    G,
    'generic idempotency notes in my global memory',
    {
      forbidden: [gd1],
      hops: [],
    },
  );

  // ── cross-repo ─────────────────────────────────────────────────────────────
  q(
    'xr-code-and-repos',
    'exact',
    'cross-repo',
    ALPHA,
    X,
    'my claims spanning ledger + checkout: code + repo entities',
    {
      claims: [a4, a10],
      symbols: [SETTLE, CART],
      entities: [E_LEDGER, E_CHECKOUT],
      forbidden: [b1, b2],
      hops: [a4About, settlePart, a10About, cartPart],
    },
  );
  q(
    'xr-functions-where',
    'paraphrase',
    'cross-repo',
    ALPHA,
    X,
    'Across both of my projects, which code units have recorded behaviour, and which component does each belong to?',
    {
      claims: [a4, a9, a10],
      symbols: [SETTLE, LEDGER_OS, CART],
      entities: [E_LEDGER, E_OS_LEDGER, E_CHECKOUT],
      forbidden: [b2],
      hops: [a4About, settlePart, a9About, ledgerOsPart, a10About, cartPart],
    },
  );
  q(
    'xr-unify-locking',
    'context',
    'cross-repo',
    ALPHA,
    X,
    "I'm unifying locking between ledger and checkout. What do I already know about locks in each place?",
    {
      claims: [a8, a10, a11],
      symbols: [CART, JOURNAL],
      forbidden: [b1, b2],
      hops: [a8About, a10About, a11About],
    },
  );
  q(
    'xr-os-same-name',
    'exact',
    'cross-repo',
    ALPHA,
    L,
    'ledger OrderService vs other same-named services',
    {
      claims: [a9],
      symbols: [LEDGER_OS],
      entities: [E_OS_LEDGER],
      forbidden: [b2, E_OS_CHECKOUT],
      hops: [a9About, ledgerOsPart],
    },
  );
  q(
    'xr-checkout-own',
    'paraphrase',
    'cross-repo',
    ALPHA,
    C,
    'Do I own any order-service knowledge in checkout, or only the basket code?',
    {
      claims: [a10],
      symbols: [CART],
      entities: [E_CHECKOUT],
      forbidden: [b2],
      hops: [a10About, cartPart],
    },
  );
  q(
    'xr-beta-confusable',
    'context',
    'cross-repo',
    BETA,
    C,
    'Before relying on my checkout OrderService note: could it be mixed up with the ledger service of the same name, and what rule touches mine?',
    {
      claims: [b2],
      symbols: [CHECKOUT_OS],
      forbidden: [a9],
      hops: [b2About, guestAffects],
    },
  );
  q(
    'xr-idem-and-tooling',
    'exact',
    'cross-repo',
    ALPHA,
    X,
    'retry decision + tooling convention across my repos',
    {
      claims: [d2, g1],
      symbols: [SETTLE],
      forbidden: [gd1, d1],
      hops: [d2About, idemSettle, g1About],
    },
  );
  q(
    'xr-onboarding',
    'context',
    'cross-repo',
    ALPHA,
    X,
    "I'm onboarding myself onto all my repos. List the decisions, procedures and conventions I hold, and where each one applies.",
    {
      claims: [d2, a7, g1, a10],
      symbols: [SETTLE, JOURNAL, CART],
      forbidden: [d1, b1],
      hops: [idemSettle, d2About, a7Applies, a7About, g1About, a10About],
    },
  );
  q(
    'xr-journal-cart-repos',
    'paraphrase',
    'cross-repo',
    ALPHA,
    X,
    'Which component does the ledger journal belong to, and which repository owns the shopping basket?',
    {
      claims: [a11, a10],
      symbols: [JOURNAL, CART],
      entities: [E_JOURNAL, E_CHECKOUT],
      hops: [a11About, journalPart, a10About, cartPart],
    },
  );
  q('xr-by-9th', 'exact', 'cross-repo', ALPHA, X, 'cross-repo claims recorded by the 9th', {
    knownAt: at(9),
    claims: [a10, a9],
    symbols: [CART, LEDGER_OS],
    entities: [E_CHECKOUT],
    forbidden: [a4, d2],
    hops: [a10About, a9About, cartPart],
  });

  // ── decoy ──────────────────────────────────────────────────────────────────
  q(
    'decoy-not-http',
    'exact',
    'decoy',
    ALPHA,
    L,
    'ledger retry idempotency (not HTTP method semantics)',
    {
      claims: [d2],
      symbols: [SETTLE],
      forbidden: [gd1, d1],
      hops: [d2About, idemSettle],
    },
  );
  q(
    'decoy-textbook-rest',
    'paraphrase',
    'decoy',
    ALPHA,
    L,
    'Setting aside textbook REST advice, what does my ledger actually do to deduplicate retried charges?',
    {
      claims: [d2, a4],
      symbols: [SETTLE],
      forbidden: [gd1],
      hops: [d2About, idemSettle, a4About],
    },
  );
  q(
    'decoy-switch-to-put',
    'context',
    'decoy',
    ALPHA,
    L,
    'Someone suggested moving ledger retries onto PUT to get idempotency for free. What does our own record say instead, and what backs it?',
    {
      claims: [d2],
      forbidden: [gd1, d1],
      hops: [d2About, d2Doc, d2Att],
    },
  );
  q(
    'decoy-global-key-empty',
    'exact',
    'decoy',
    ALPHA,
    G,
    'ledger dedupe key rule in global memory?',
    {
      forbidden: [d2, gd1],
      hops: [],
    },
  );
  q(
    'decoy-global-wait-empty',
    'paraphrase',
    'decoy',
    ALPHA,
    G,
    'Is there a cross-project rule for how long to wait before retrying?',
    {
      forbidden: [a5, a6, gd1],
      hops: [],
    },
  );
  q(
    'decoy-journal-timing',
    'context',
    'decoy',
    ALPHA,
    L,
    'Writing retry code for the journal and ignoring generic web advice: what do my ledger notes say about timing?',
    {
      claims: [a5, a6],
      symbols: [JOURNAL],
      forbidden: [gd1],
      hops: [a5Applies, a6Applies, a5Contra],
    },
  );
  q(
    'decoy-global-conventions',
    'exact',
    'decoy',
    ALPHA,
    G,
    'global conventions only, excluding generic idempotency lore',
    {
      claims: [g1],
      forbidden: [gd1],
      hops: [g1About, g1Doc],
    },
  );
  q(
    'decoy-own-records',
    'paraphrase',
    'decoy',
    ALPHA,
    L,
    'Which of my own ledger records define duplicate-request handling, as opposed to general protocol trivia?',
    {
      claims: [d2],
      symbols: [SETTLE],
      forbidden: [gd1],
      hops: [d2About, d2Supersedes, idemSettle],
    },
  );
  q('decoy-checkout-idem-empty', 'exact', 'decoy', ALPHA, C, 'checkout idempotency rules', {
    forbidden: [gd1, b1],
    hops: [],
  });

  return questions;
}
