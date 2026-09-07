import type { EvalReceipt, MemoryEvaluator, RecordEvaluation } from './evaluator.js';
import type { MemoryReceiptPort, MemorySoulPort } from './evaluator.js';
import type { MemoryPolicyPort } from './evaluator.js';
/**
 * The evaluation → activation → proposal pipeline (PRD W4 lines 340–350).
 *
 * Promotion is the ONLY path from an untrusted {@link MemoryCandidate} to a trusted {@link
 * MemoryRecord}, and it is **idempotent by content id** (PRD line 347): a candidate and its record
 * share the `claimBody` hash (`cand:<h>` ↔ `mem:<h>`), so re-evaluating an identical claim reproduces
 * the same ids and every write is a no-op upsert. Crash recovery (PRD line 348): if a crash lands the
 * shared write (record + receipt) but not the local cleanup (candidate removal), the next run
 * re-evaluates — the upserts are deduped, the candidate removal completes — and the result is the
 * same as if the crash had not happened.
 *
 * The pipeline is staged so the caller (the CLI / CI runner) owns locks + git, per PRD line 277
 * (snapshot → execute → reacquire → verify):
 *
 *   1. {@link evaluateCandidate} — run the gate (caller calls {@link runGate}), then run the
 *      independent admissibility evaluator over the candidate's evidence with the receipt + policy
 *      ports wired. Produces a stamped {@link MemoryRecord} (trust `candidate` until activated) +
 *      the {@link RecordEvaluation}. NEVER promotes on invalid evidence.
 *   2. {@link activateLocal} — durably write the record to local `active` + the receipt to local
 *      `receipts`, THEN remove the candidate from local `candidates`. Idempotent + crash-safe.
 *   3. {@link proposeTeam} — write the team record (trust `team`) + an `accept` decision + the
 *      receipt to the team store. Refuses invalid-evidence proposals (PRD line 346: "team proposals
 *      to include admissible evidence and the required receipt IDs"). Idempotent by content id.
 *
 * The MCP server NEVER calls this — `memory_observe` only writes a candidate (Slice 2); only the CLI
 * and CI runner evaluate + promote (PRD line 68: "only the CLI and CI runner can produce evaluation
 * receipts").
 */
import { decisionId } from './ids.js';
import { memoryRecordId } from './ids.js';
import type { MemoryStore } from './store.js';
import type { GateReceipt, MemoryCandidate, MemoryDecision, MemoryRecord } from './types.js';

// ─── receipt view + ports ────────────────────────────────────────────────────

/** View a {@link GateReceipt} as the {@link EvalReceipt} subset the evaluator reads. */
export function receiptView(r: GateReceipt): EvalReceipt {
  return {
    id: r.id,
    policyHash: r.policyHash,
    profileHash: r.profileHash,
    exitCode: r.exitCode,
    assertions: r.assertions,
    runner: r.runner,
    ts: r.ts,
  };
}

/** A receipts port over an in-memory map (the just-produced receipt + any prior receipts). */
export function receiptPortFrom(get: (id: string) => EvalReceipt | undefined): MemoryReceiptPort {
  return { getReceipt: get };
}

/** A policy port pinned to the policy/profile hashes the gate ran against (drift = a different run). */
export function policyPortFromReceipt(receipt: GateReceipt): MemoryPolicyPort {
  return {
    policyHash: () => receipt.policyHash,
    profileHash: () => receipt.profileHash,
  };
}

// ─── record construction ─────────────────────────────────────────────────────

/** Build a {@link MemoryRecord} from a candidate + the final verdicts (content-addressed → idempotent). */
export function buildRecord(
  candidate: MemoryCandidate,
  verdicts: MemoryRecord['verdicts'],
  evidence: MemoryRecord['evidence'],
  createdAt: string,
): MemoryRecord {
  const input = {
    kind: candidate.kind,
    subject: candidate.subject,
    claim: candidate.claim,
    scope: candidate.scope,
    appliesTo: candidate.appliesTo,
    evidence,
    authorship: candidate.authorship,
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts,
    createdAt,
  };
}

// ─── evaluation ──────────────────────────────────────────────────────────────

export interface EvaluateCandidateOpts {
  evaluator: MemoryEvaluator;
  soul: MemorySoulPort;
  /** the gate receipt the candidate is being evaluated against (wraps the receipts + policy ports). */
  receipt: GateReceipt;
  /** additional prior receipts reachable by id (for receipt-pair evidence over earlier runs). */
  priorReceipts?: Map<string, EvalReceipt>;
  /** fixed clock for `checkedAt`/`createdAt` stamps. */
  now: () => string;
}

/** The evaluation outcome: a stamped record (trust `candidate`) + the per-item detail. */
export interface CandidateEvaluation {
  record: MemoryRecord;
  evaluation: RecordEvaluation;
}

/**
 * Run the admissibility evaluator over a candidate's evidence with the gate receipt wired in, and
 * stamp the final evidence + applicability verdicts onto a fresh {@link MemoryRecord}. Trust stays
 * `candidate` — activation / proposal are separate steps that set `local` / `team`. The record's
 * `evidence` items are stamped with their per-item verdict + `checkedAt` + `reason`.
 */
export function evaluateCandidate(
  candidate: MemoryCandidate,
  opts: EvaluateCandidateOpts,
): CandidateEvaluation {
  const { evaluator, soul, receipt, now } = opts;
  const prior = opts.priorReceipts ?? new Map<string, EvalReceipt>();
  const receiptPort = receiptPortFrom((id) =>
    id === receipt.id ? receiptView(receipt) : prior.get(id),
  );
  const policyPort = policyPortFromReceipt(receipt);
  // Provisional record: verdicts placeholder — the evaluator recomputes evidence + applicability;
  // trust is `candidate` until activate/propose; lifecycle is `active` (no decision event yet).
  const provisional = buildRecord(
    candidate,
    { trust: 'candidate', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    candidate.evidence,
    now(),
  );
  const evaluation = evaluator.evaluate(provisional, {
    soul,
    receipts: receiptPort,
    policy: policyPort,
  });

  // Stamp each evidence item with its revalidation verdict (+ reason + checkedAt). 'ignored' items
  // (a kind valid but not admissible for this claim kind) land as 'invalid' — they are not evidence.
  const stampedEvidence = provisional.evidence.map((ev, i) => {
    const item = evaluation.items[i];
    if (!item) return ev;
    const verdict = item.evidence === 'ignored' ? 'invalid' : item.evidence;
    return { ...ev, verdict, checkedAt: now(), reason: item.reason };
  });

  const record = buildRecord(
    candidate,
    {
      trust: 'candidate',
      evidence: evaluation.evidence,
      applicability: evaluation.applicability,
      lifecycle: 'active',
    },
    stampedEvidence,
    now(),
  );
  return { record, evaluation };
}

// ─── snapshot verification (PRD line 277) ────────────────────────────────────

/** The snapshot the promotion orchestrator takes before running the gate (no lock held while running). */
export interface PromotionSnapshot {
  policyHash: string;
  head: string;
  worktreeDigest: string;
  /** the candidate content id (must be unchanged — a concurrent edit invalidates the run). */
  candidateId: string;
}

/**
 * Verify a post-run snapshot matches the pre-run snapshot (PRD line 277: "verify that candidate,
 * policy, HEAD, and worktree digest are unchanged"). A mismatch means the gate ran against state that
 * has since drifted → the receipt MUST NOT be trusted and promotion MUST be aborted.
 */
export function verifySnapshot(before: PromotionSnapshot, after: PromotionSnapshot): boolean {
  return (
    before.policyHash === after.policyHash &&
    before.head === after.head &&
    before.worktreeDigest === after.worktreeDigest &&
    before.candidateId === after.candidateId
  );
}

// ─── local activation ────────────────────────────────────────────────────────

/** A local activation result: what was written + whether cleanup ran (crash-recovery signal). */
export interface ActivationResult {
  recordId: string;
  receiptId: string;
  /** the activated record (trust `local`, evidence/applicability from the evaluation). */
  record: MemoryRecord;
  /** true iff a candidate was removed (false on a crash-recovery re-run where it was already gone). */
  cleanedUp: boolean;
}

/**
 * Activate a candidate's evaluated record LOCALLY (trust `local`). Idempotent + crash-safe
 * (PRD line 348): writes the record to `active` + the receipt to `receipts` (both upserts — no-ops on
 * a re-run), THEN removes the candidate from `candidates`. A crash between the writes and the remove
 * leaves a candidate that the next re-run dedupes (same ids → no-op upserts) + re-cleans.
 */
export function activateLocal(
  local: MemoryStore,
  candidate: MemoryCandidate,
  evaluation: CandidateEvaluation,
  receipt: GateReceipt,
  /** optional mutable meta stamped onto the local record (e.g. the gating receipt id, for `propose`
   *  to recover). Meta is EXCLUDED from the content id, so this does not change the record id. */
  recordMeta?: Record<string, unknown>,
): ActivationResult {
  // Trust `local`: a fresh copy of the evaluated record with the trust verdict promoted.
  const localRecord: MemoryRecord = {
    ...evaluation.record,
    verdicts: { ...evaluation.record.verdicts, trust: 'local' },
    ...(recordMeta || evaluation.record.meta
      ? { meta: { ...evaluation.record.meta, ...recordMeta } }
      : {}),
  };
  local.upsertEntry('active', localRecord);
  local.upsertEntry('receipts', receipt);
  const cleanedUp = local.removeEntry('candidates', candidate.id);
  return {
    recordId: localRecord.id,
    receiptId: receipt.id,
    record: localRecord,
    cleanedUp,
  };
}

// ─── team proposal ───────────────────────────────────────────────────────────

/** Thrown when a team proposal is refused (invalid evidence — PRD line 346). */
export class ProposalRefusedError extends Error {
  constructor(
    readonly reason: string,
    readonly recordId: string,
  ) {
    super(`team proposal refused for ${recordId}: ${reason}`);
    this.name = 'ProposalRefusedError';
  }
}

/** A team proposal result: the promoted record id + the accept-decision id (both idempotent). */
export interface ProposalResult {
  recordId: string;
  receiptId: string;
  decisionId: string;
  /** the team record (trust `team`). */
  record: MemoryRecord;
}

/**
 * Propose a record for team trust (PRD line 346). Writes the team record (trust `team`) + an `accept`
 * decision + the receipt to the team store. Refuses when the evaluated evidence is `invalid` (the
 * claim is not admissible — it cannot become team-trusted). Idempotent by content id: re-proposing the
 * same claim reproduces identical `mem:`/`dec:`/`rcpt:` ids, so every write is a no-op upsert and the
 * team ledger converges without a cloud service (PRD exit gate line 350).
 */
export function proposeTeam(
  team: MemoryStore,
  evaluation: CandidateEvaluation,
  receipt: GateReceipt,
  actor: string,
  now: () => string,
): ProposalResult {
  if (evaluation.evaluation.evidence === 'invalid') {
    throw new ProposalRefusedError(
      'evidence verdict is invalid — team proposals require admissible evidence',
      evaluation.record.id,
    );
  }
  // D10 (prophylactic): private never enters git. The promoted record is TYPED as the memory-1
  // envelope today, so the check reads the runtime shape instead of the static type — if the
  // pipeline ever starts carrying memory-2 records (or a cast hides one), the proposal gate fails
  // loudly too, not only the store's write gate.
  const promoted = evaluation.record as unknown as {
    id: string;
    schemaVersion?: string;
    visibility?: string;
  };
  if (promoted.schemaVersion === '2' && promoted.visibility === 'private') {
    throw new ProposalRefusedError(
      "record projects visibility 'private' — private never enters git (D10)",
      promoted.id,
    );
  }
  const teamRecord: MemoryRecord = {
    ...evaluation.record,
    verdicts: { ...evaluation.record.verdicts, trust: 'team' },
  };
  const decision: MemoryDecision = {
    id: decisionId({
      kind: 'accept',
      subject: teamRecord.id,
      actor,
      reason: 'team proposal accepted (idempotent by content id)',
    }),
    schemaVersion: '1',
    kind: 'accept',
    subject: teamRecord.id,
    actor,
    reason: 'team proposal accepted (idempotent by content id)',
    ts: now(),
  };
  team.upsertEntry('records', teamRecord);
  team.upsertEntry('decisions', decision);
  team.upsertEntry('receipts', receipt);
  return {
    recordId: teamRecord.id,
    receiptId: receipt.id,
    decisionId: decision.id,
    record: teamRecord,
  };
}

// ─── propose an already-activated record (the `crib memory propose <mem-id>` path) ───────────

/**
 * Propose an ALREADY-ACTIVATED local record for team trust (PRD line 257: `crib memory propose
 * <memory-id>`). Unlike {@link proposeTeam} — which takes a freshly-evaluated {@link
 * CandidateEvaluation} — this wraps the activated record's stamped verdicts as the evaluation so the
 * admissibility guard runs against the verdicts the gate stamped at activation time. The receipt
 * pinned the gate run; the record's `verdicts.evidence` is the admissibility result. Refuses an
 * invalid-evidence record (PRD line 346) and is idempotent by content id (re-proposing reproduces
 * identical `mem:`/`dec:`/`rcpt:` ids → no-op upserts).
 */
export function proposeExisting(
  team: MemoryStore,
  record: MemoryRecord,
  receipt: GateReceipt,
  actor: string,
  now: () => string,
): ProposalResult {
  const evaluation: CandidateEvaluation = {
    record,
    evaluation: {
      evidence: record.verdicts.evidence,
      applicability: record.verdicts.applicability,
      items: [],
      reattached: false,
      reasons: [],
    },
  };
  return proposeTeam(team, evaluation, receipt, actor, now);
}

// ─── receipt-free admission for human-attested claims ────────────────────────

/** Why an attested admission was refused. `ok: false` is always explained. */
export type AttestedAdmission =
  | { ok: true; record: MemoryRecord; cleanedUp: boolean }
  | { ok: false; error: string };

/**
 * Admit a HUMAN-ATTESTED claim to local trust WITHOUT a gate receipt.
 *
 * WHY A RECEIPT IS THE WRONG GATE HERE
 * `activateLocal` requires a {@link GateReceipt} bound to HEAD plus a worktree digest, because the
 * claims it was built for assert something about CODE and a receipt is what proves that assertion
 * still holds. A `convention` or `decision` admits only `human-attestation` and `committed-policy`
 * (the PRD admissibility matrix) — there is no execution to gate and no code anchor to drift. So
 * demanding a receipt demanded proof of something the claim never asserted, and the practical
 * effect was that "remember my working preference" required `crib memory evaluate --profile …`
 * followed by `crib memory activate …`. Users reasonably concluded memory did not work.
 *
 * WHAT KEEPS THIS FROM BEING A TRUST HOLE
 * The caller must supply an attestation that already carries `tty`/`actor`/`attestedAt`, and crib
 * only ever stamps those from a REAL terminal it observed itself — `memory_observe` refuses a
 * caller-supplied `tty`, because an agent speaking over stdio has not witnessed one. So the
 * admission is grounded in a signal the agent cannot mint. LOCAL trust only: team trust still
 * requires CI plus a trusted ref, and nothing here touches that path.
 */
export function admitAttested(
  local: MemoryStore,
  candidate: MemoryCandidate,
  opts: {
    evaluator: MemoryEvaluator;
    soul: MemorySoulPort;
    now: () => string;
    /**
     * The human doing the admitting, supplied ONLY by a call site that has verified
     * `process.stdin.isTTY`. Its presence is what stamps `tty`/`actor`/`attestedAt` onto the
     * attestation — so the attestation is minted by crib at the moment a human confirms, never
     * carried in from an agent that merely claimed one.
     */
    attestedBy?: string;
  },
): AttestedAdmission {
  if (candidate.kind !== 'convention' && candidate.kind !== 'decision') {
    return {
      ok: false,
      error: `receipt-free admission covers 'convention' and 'decision' claims (this is '${candidate.kind}'), because those are the kinds whose evidence makes no assertion about code. Run \`crib memory evaluate\` then \`crib memory activate\` for the rest.`,
    };
  }
  if (candidate.evidence.length === 0) {
    return { ok: false, error: 'no evidence — a claim with nothing behind it is not admissible' };
  }
  const nonAttested = candidate.evidence.filter((e) => e.kind !== 'human-attestation');
  if (nonAttested.length > 0) {
    return {
      ok: false,
      error: `receipt-free admission requires every evidence item to be a human-attestation; found ${nonAttested
        .map((e) => `'${e.kind}'`)
        .join(', ')}. Evidence that references code must be gated by a receipt.`,
    };
  }
  // STAMP THE ATTESTATION HERE. A staged candidate carries the claim; this call — reached only
  // from a terminal — supplies the proof that a human confirmed it. Doing it here rather than
  // trusting caller-supplied fields is the whole security property: an agent never gets to assert
  // `tty`, so it cannot manufacture the signal that grants local trust.
  const attestedAt = opts.now();
  const evidence = opts.attestedBy
    ? candidate.evidence.map((ev) =>
        ev.kind === 'human-attestation'
          ? ({ ...ev, tty: true, actor: opts.attestedBy, attestedAt } as typeof ev)
          : ev,
      )
    : candidate.evidence;
  // Evaluate for real. `revalidateHumanAttestation` consults neither the receipt port nor the soul,
  // so the evaluation is complete without a receipt — but it still ENFORCES the attestation fields,
  // which is what stops a hollow attestation from being waved through when no human stamped one.
  const provisional = buildRecord(
    candidate,
    { trust: 'candidate', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    evidence,
    attestedAt,
  );
  const evaluation = opts.evaluator.evaluate(provisional, { soul: opts.soul });
  if (evaluation.evidence !== 'valid' && evaluation.evidence !== 'degraded') {
    return {
      ok: false,
      error: `attestation did not validate (${evaluation.evidence}): ${evaluation.reasons.join(', ') || 'no reason reported'}`,
    };
  }
  // Stamp each evidence item with its revalidation verdict, exactly as `evaluateCandidate` does —
  // `verdict` and `checkedAt` are REQUIRED by the record schema, and a record built from raw
  // candidate evidence fails validation on write.
  const stampedAt = opts.now();
  const stampedEvidence = provisional.evidence.map((ev, i) => {
    const item = evaluation.items[i];
    if (!item) return ev;
    return {
      ...ev,
      verdict: item.evidence === 'ignored' ? ('invalid' as const) : item.evidence,
      checkedAt: stampedAt,
      reason: item.reason,
    };
  });
  const record = buildRecord(
    candidate,
    {
      trust: 'local',
      evidence: evaluation.evidence,
      applicability: evaluation.applicability,
      lifecycle: 'active',
    },
    stampedEvidence,
    stampedAt,
  );
  local.upsertEntry('active', record);
  const cleanedUp = local.removeEntry('candidates', candidate.id);
  return { ok: true, record, cleanedUp };
}
