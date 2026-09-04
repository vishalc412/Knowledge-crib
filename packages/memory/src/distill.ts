/**
 * The distillation engine (G2.3) — turns pending capture-outbox entries into provider work items
 * and applies the provider's decision ONLY after crib has verified it deterministically. The
 * division of authority is the whole point: **the provider proposes, crib disposes.** A provider
 * (the host agent, driven through the enrich-provider mechanism — crib never calls a model) sees
 * the capture plus the existing same-subject records and returns a structured decision; every
 * decision is then checked against the store with pure, deterministic rules before anything is
 * written. An unverifiable decision is a per-item failure (a retry append, dead-lettering at B's
 * limit) — it is NEVER applied on the provider's authority.
 *
 * The four decisions and their verification contracts:
 *   - `ADD`       — a new structured claim → staged as an untrusted candidate (the candidate tier's
 *                   trust law is untouched by distillation: distilled content stays untrusted until
 *                   promotion). If the content id already exists the decision is RECLASSIFIED to a
 *                   NOOP (at-least-once delivery + content addressing make this the same fact).
 *   - `SUPERSEDE` — requires a cited existing record id that resolves in the LOCAL store; applied
 *                   through `MemoryApi.supersede`'s payload path (v2 successor + decision event).
 *   - `CONFLICT`  — ONLY when the cited record shares the new claim's propositionKey AND the claims
 *                   are deterministic negations (`negatesClaim`). Complementary claims under the
 *                   same subject are ADD, never CONFLICT — the pinned regression in distill.test.ts.
 *                   An applied conflict stages an ADD candidate carrying `meta.contradicts`
 *                   provenance; it never rewrites the cited record (append-only) and never writes a
 *                   trusted record directly. Honesty limit: only explicit-negation contradictions
 *                   are deterministically verifiable; subtler conflicts ride ADD and surface later
 *                   through the same-propositionKey conflict projection at trust-tier resolution.
 *   - `NOOP`      — requires a cited duplicate id that resolves locally AND a normalized-claim
 *                   equality; a NOOP without a citation is unverifiable (it would let a lazy
 *                   provider silently drop captures).
 *
 * Store discipline: this module touches ONLY the local store. Verification only accepts local ids
 * (a capture lane must never write or key on team memory — the no-poison rule), and the single-store
 * discipline keeps the process-global no-cross-store-nesting lock guard uncrossed.
 *
 * No wall-clock read anywhere: `now` is always a caller-supplied port, and nothing here feeds an id
 * except pure content seeds.
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { MemoryApi } from './api.js';
import { checkCapturePolicy } from './capture-policy.js';
import { type MemoryRecordKind, isMemoryRecordKind } from './enums.js';
import { derivePropositionKey, memoryCandidateId, normalizeClaim } from './ids.js';
import {
  captureRetryCount,
  deadLetterCapture,
  markCaptureDone,
  recordCaptureRetry,
  shouldDeadLetterCapture,
} from './outbox.js';
import type { CapturePolicySection } from './policy.js';
import { scanSecrets } from './secrets.js';
import type { MemoryStore } from './store.js';
import type {
  Authorship,
  CaptureOutboxEntry,
  MemoryCandidate,
  MemoryEvidence,
  MemoryRecord,
  MemoryRecordV2,
} from './types.js';

// ─── the decision vocabulary ─────────────────────────────────────────────────

/** What a provider may propose for a capture. Anything else is a per-item failure. */
export type DistillDecisionKind = 'ADD' | 'SUPERSEDE' | 'CONFLICT' | 'NOOP';

export const DISTILL_DECISION_KINDS: readonly DistillDecisionKind[] = [
  'ADD',
  'SUPERSEDE',
  'CONFLICT',
  'NOOP',
];

/**
 * The provider's decision. Every field beyond `decision` + `rationale` is a CITATION the verifier
 * demands per decision kind — an uncited claim is unverifiable and fails closed.
 */
export interface DistillDecision {
  decision: DistillDecisionKind;
  /** WHY (static prose — secret-scanned before it may enter any persisted meta). */
  rationale: string;
  /** refined claim text (ADD/SUPERSEDE/CONFLICT); defaults to the capture's claim. */
  claim?: string;
  /** refined subject (ADD/SUPERSEDE/CONFLICT); defaults to the capture's subject. */
  subject?: string;
  /** refined kind (ADD/SUPERSEDE/CONFLICT); defaults to the capture's kind. */
  kind?: string;
  /** SUPERSEDE: the record this decision retires. Required — uncited supersede fails. */
  supersedesRecordId?: string;
  /** CONFLICT: the record the new claim materially contradicts. Required. */
  contradictsRecordId?: string;
  /** CONFLICT (optional pin): the proposition key the provider asserts for the new claim. */
  propositionKey?: string;
  /** NOOP: the existing candidate/record this capture duplicates. Required. */
  duplicateOfId?: string;
}

/** A same-subject record shown to the provider (with its propositionKey, the real conflict key). */
export interface DistillExistingRecord {
  id: string;
  kind: string;
  subject: string;
  propositionKey: string;
  claim: string;
}

/** A provider work item — structurally the enrich envelope (`EnrichWorkItem`) so the CLI can feed
 *  it to `runProviderBatch` unchanged; `packages/memory` cannot import the mcp types (cycle). */
export interface DistillWorkItem {
  targetId: string;
  seed: {
    capture: {
      id: string;
      kind: string;
      subject: string;
      claim: string;
      evidenceKinds: string[];
    };
    existing: DistillExistingRecord[];
  };
  outputSchema: Record<string, unknown>;
  instructions: string;
}

/** The provider's response for one capture: which target, and the decision for it. */
export interface DistillResponse {
  targetId: string;
  decision: DistillDecision;
}

/** What a verified decision carries into the apply step. */
export interface VerifiedDistillDecision {
  response: DistillResponse;
  /** the effective claim/subject/kind after defaults (what ADD/CONFLICT will stage). */
  effective: { kind: MemoryRecordKind; subject: string; claim: string };
  /** ADD reclassified to NOOP because the content id already exists (at-least-once dedupe). */
  reclassifiedToNoop: boolean;
}

// ─── the work item + batch identity ──────────────────────────────────────────

/** Same-subject records shown to the provider per capture (bounded — a work item is a prompt, not a dump). */
export const DISTILL_EXISTING_CAP = 20;

export const DISTILL_INSTRUCTIONS = [
  'Decide what to do with the captured observation in `seed.capture`.',
  'Existing records about the same subject are in `seed.existing` (with their propositionKey).',
  'Return strict JSON: {"targetId": <the capture id>, "decision": {',
  '  "decision": "ADD" | "SUPERSEDE" | "CONFLICT" | "NOOP",',
  '  "rationale": <one short sentence>,',
  '  "claim": <refined claim text for ADD/SUPERSEDE/CONFLICT, omitted to keep the capture claim>,',
  '  "supersedesRecordId": <required for SUPERSEDE>,',
  '  "contradictsRecordId": <required for CONFLICT — only for claims that directly NEGATE an',
  '    existing record; complementary facts about the same subject are ADD, never CONFLICT>,',
  '  "duplicateOfId": <required for NOOP>',
  '}}.',
  'Every citation must be an id from `seed.existing` or an already-known record id — an',
  'uncited decision is rejected. If the capture merely restates existing content, answer NOOP.',
].join('\n');

/** The strict output schema handed to the provider (validatable, not enforced by trust). */
export const DISTILL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['targetId', 'decision'],
  properties: {
    targetId: { type: 'string' },
    decision: {
      type: 'object',
      required: ['decision', 'rationale'],
      properties: {
        decision: { type: 'string', enum: [...DISTILL_DECISION_KINDS] },
        rationale: { type: 'string' },
        claim: { type: 'string' },
        subject: { type: 'string' },
        kind: { type: 'string' },
        supersedesRecordId: { type: 'string' },
        contradictsRecordId: { type: 'string' },
        propositionKey: { type: 'string' },
        duplicateOfId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** Wrap one pending capture as a provider work item. PURE. */
export function buildDistillWorkItem(
  entry: CaptureOutboxEntry,
  existing: DistillExistingRecord[],
): DistillWorkItem {
  return {
    targetId: entry.id,
    seed: {
      capture: {
        id: entry.id,
        kind: entry.kind,
        subject: entry.subject,
        claim: entry.claim,
        evidenceKinds: entry.evidence.map((e) => e.kind),
      },
      existing,
    },
    outputSchema: DISTILL_OUTPUT_SCHEMA,
    instructions: DISTILL_INSTRUCTIONS,
  };
}

/**
 * The drain batch's deterministic identity: blake3 over the sorted pending ids — wall-clock-free,
 * so a redrain of the same queue state derives the same batch id and the zero-progress marker can
 * detect "the provider saw this exact queue and wrote nothing" across runs.
 */
export function distillBatchId(pendingIds: readonly string[]): string {
  return `distill:${blake3Hex(JSON.stringify([...pendingIds].sort()))}`;
}

/**
 * The existing same-subject records in the LOCAL store, with their propositionKeys (the real
 * conflict key). Subject identity is normalized-claim equality; v1 records derive their key from
 * the subject exactly as `derivePropositionKey` does. Lock-free reads, sorted by id, capped.
 */
export function sameSubjectRecords(
  store: MemoryStore,
  subject: string,
  cap: number = DISTILL_EXISTING_CAP,
): DistillExistingRecord[] {
  const key = derivePropositionKey({ subject });
  const out: DistillExistingRecord[] = [];
  for (const entry of store.readCollection('active').entries) {
    if (typeof (entry as { id?: unknown }).id !== 'string') continue;
    const record = entry as unknown as MemoryRecord | MemoryRecordV2;
    if (record.subject === undefined) continue;
    const recordKey = isV2(record)
      ? record.propositionKey
      : derivePropositionKey({ subject: record.subject });
    // A match is the same proposition: v1 keys derive from the normalized subject; a v2 record's
    // key IS what the claim is about (derived or explicitly overridden — the override wins).
    if (recordKey !== key) continue;
    out.push({
      id: record.id,
      kind: record.kind,
      subject: record.subject,
      propositionKey: recordKey,
      claim: record.claim,
    });
    if (out.length >= cap) break;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function isV2(record: MemoryRecord | MemoryRecordV2): record is MemoryRecordV2 {
  return record.schemaVersion === '2';
}

// ─── the deterministic contradiction check ───────────────────────────────────

/**
 * Negation handling, in two passes so the VERB survives the strip: contractions and fused forms
 * expand to "<verb> not" first, then the bare negation tokens strip whole-word. Stripping whole
 * phrases like "is not" would eat the verb with the negation ("caching is not enabled" would
 * reduce to "caching enabled" and never match "caching is enabled"), which would make the doc's
 * flagship negation pair unverifiable — the opposite of this check's purpose.
 */
const NEGATION_EXPANSIONS: ReadonlyArray<readonly [string, string]> = [
  ["isn't", 'is not'],
  ["aren't", 'are not'],
  ["doesn't", 'does not'],
  ["don't", 'do not'],
  ["mustn't", 'must not'],
  ["won't", 'will not'],
  ["can't", 'can not'],
  ['cannot', 'can not'],
];
const NEGATION_TOKENS = ['not', 'no', 'never'];

function replaceWholeWord(text: string, token: string, replacement: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), replacement);
}

function stripNegations(claim: string): string {
  let out = normalizeClaim(claim);
  for (const [contraction, expanded] of NEGATION_EXPANSIONS) {
    out = replaceWholeWord(out, contraction, expanded);
  }
  for (const token of NEGATION_TOKENS) {
    out = replaceWholeWord(out, token, ' ');
  }
  return normalizeClaim(out);
}

/**
 * Whether two claims are DETERMINISTIC negations of each other: identical after stripping negation
 * tokens (from both sides), while the raw claims differ. This is the honesty boundary of conflict
 * verification — "caching is enabled" vs "caching is not enabled" verifies; subtler contradictions
 * ("uses pnpm" vs "uses npm") do NOT, and must ride ADD. Pure, no model, no wall clock. Honesty
 * limit: verb morphology is out of scope ("X works" vs "X does not work" stays unverifiable and
 * rides ADD — fails closed, never fabricates a conflict).
 */
export function negatesClaim(a: string, b: string): boolean {
  const na = normalizeClaim(a);
  const nb = normalizeClaim(b);
  if (na === nb || na.length === 0 || nb.length === 0) return false;
  const sa = stripNegations(na);
  const sb = stripNegations(nb);
  return sa.length > 0 && sb.length > 0 && sa === sb;
}

// ─── verification (provider proposes, crib disposes) ─────────────────────────

/** Everything the verifier needs: the local store (the ONLY store it will read), the entry being
 *  distilled, and the capture-tightening policy the staged result must pass. */
export interface DistillVerifyContext {
  local: MemoryStore;
  entry: CaptureOutboxEntry;
  policy?: CapturePolicySection;
}

export type DistillVerifyResult =
  | { ok: true; verified: VerifiedDistillDecision }
  | { ok: false; reason: string };

/**
 * Parse + verify a provider response for one capture. Every rejection reason is STATIC (it never
 * echoes the refused content — the same discipline as the capture policy). A response whose
 * `targetId` does not match the work item fails immediately (misaddressed output).
 */
export function verifyDistillDecision(
  raw: unknown,
  expectedTargetId: string,
  ctx: DistillVerifyContext,
): DistillVerifyResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'distill response is not a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.targetId !== expectedTargetId) {
    return { ok: false, reason: 'distill response targetId does not match the work item' };
  }
  const d = obj.decision;
  if (typeof d !== 'object' || d === null) {
    return { ok: false, reason: 'distill response carries no decision object' };
  }
  const dec = d as Record<string, unknown>;
  if (
    typeof dec.decision !== 'string' ||
    !(DISTILL_DECISION_KINDS as readonly string[]).includes(dec.decision)
  ) {
    return { ok: false, reason: 'distill decision is not one of ADD, SUPERSEDE, CONFLICT, NOOP' };
  }
  if (typeof dec.rationale !== 'string' || dec.rationale.trim().length === 0) {
    return { ok: false, reason: 'distill decision carries no rationale' };
  }
  if (scanSecrets(dec.rationale).length > 0) {
    return { ok: false, reason: 'distill rationale refused: secret-credential pattern' };
  }
  for (const key of [
    'claim',
    'subject',
    'kind',
    'supersedesRecordId',
    'contradictsRecordId',
    'propositionKey',
    'duplicateOfId',
  ] as const) {
    const v = dec[key];
    if (v !== undefined && (typeof v !== 'string' || v.trim().length === 0)) {
      return { ok: false, reason: `distill decision field '${key}' must be a non-empty string` };
    }
  }

  const mutable: Record<string, unknown> = {
    decision: dec.decision,
    rationale: dec.rationale,
  };
  // Field-by-field attach (after the loop above each is a non-empty string or absent) — a cast-free
  // build keeps the decision's shape honest at the type level too.
  const stringFields = [
    'claim',
    'subject',
    'kind',
    'supersedesRecordId',
    'contradictsRecordId',
    'propositionKey',
    'duplicateOfId',
  ] as const;
  for (const key of stringFields) {
    const v = dec[key];
    if (typeof v === 'string') {
      mutable[key] = v;
    }
  }
  const decision = mutable as unknown as DistillDecision;

  // The effective claim the decision would stage (defaults inherit the capture verbatim).
  const kind = decision.kind ?? ctx.entry.kind;
  if (!isMemoryRecordKind(kind)) {
    return { ok: false, reason: `distill decision kind '${kind}' is not a memory record kind` };
  }
  const subject = decision.subject ?? ctx.entry.subject;
  const claim = decision.claim ?? ctx.entry.claim;
  const effective = { kind, subject, claim };
  const policyVerdict = checkCapturePolicy(
    { kind, subject, claim, boundary: ctx.entry.scope.boundary },
    ctx.policy,
  );
  if (!policyVerdict.ok) {
    return { ok: false, reason: 'distilled claim refused by the capture policy' };
  }

  switch (decision.decision) {
    case 'ADD': {
      // Reclassify to NOOP when the content id is already present (at-least-once redelivery):
      // the staged candidate and its promoted `mem:` twin share one seed body, so either presence
      // proves the content already landed.
      const contentId = distillContentId(
        ctx.entry,
        effective,
        ctx.entry.evidence,
        ctx.entry.authorship,
      );
      const present =
        holdsLocal(ctx.local, contentId, 'candidates') ||
        holdsLocal(ctx.local, `mem:${contentId.slice(5)}`, 'active');
      if (present) {
        return {
          ok: true,
          verified: {
            response: { targetId: expectedTargetId, decision },
            effective,
            reclassifiedToNoop: true,
          },
        };
      }
      return {
        ok: true,
        verified: {
          response: { targetId: expectedTargetId, decision },
          effective,
          reclassifiedToNoop: false,
        },
      };
    }
    case 'SUPERSEDE': {
      if (decision.supersedesRecordId === undefined) {
        return { ok: false, reason: 'unsupported SUPERSEDE: no record id cited' };
      }
      const record = localRecord(ctx.local, decision.supersedesRecordId);
      if (record === undefined) {
        return {
          ok: false,
          reason: `unsupported SUPERSEDE: no local record '${decision.supersedesRecordId}'`,
        };
      }
      return {
        ok: true,
        verified: {
          response: { targetId: expectedTargetId, decision },
          effective,
          reclassifiedToNoop: false,
        },
      };
    }
    case 'CONFLICT': {
      if (decision.contradictsRecordId === undefined) {
        return { ok: false, reason: 'unsupported CONFLICT: no record id cited' };
      }
      const record = localRecord(ctx.local, decision.contradictsRecordId);
      if (record === undefined) {
        return {
          ok: false,
          reason: `unsupported CONFLICT: no local record '${decision.contradictsRecordId}'`,
        };
      }
      // The cited record must be ABOUT the same proposition as the new claim — a conflict across
      // propositionKeys is not a conflict, it is two facts.
      const recordKey = isV2(record)
        ? record.propositionKey
        : derivePropositionKey({ subject: record.subject });
      const newKey =
        decision.propositionKey !== undefined && decision.propositionKey.trim().length > 0
          ? decision.propositionKey.trim()
          : derivePropositionKey({ subject });
      if (recordKey !== newKey) {
        return {
          ok: false,
          reason: 'unsupported CONFLICT: the cited record carries a different propositionKey',
        };
      }
      // The pinned red line: COMPLEMENTARY claims under the same subject are ADD, never CONFLICT.
      // Only a deterministic negation of the cited record's claim verifies as a conflict.
      if (!negatesClaim(claim, record.claim)) {
        return {
          ok: false,
          reason:
            'unsupported CONFLICT: the claims are not deterministic negations (complementary same-subject claims classify as ADD)',
        };
      }
      return {
        ok: true,
        verified: {
          response: { targetId: expectedTargetId, decision },
          effective,
          reclassifiedToNoop: false,
        },
      };
    }
    case 'NOOP': {
      if (decision.duplicateOfId === undefined) {
        return { ok: false, reason: 'unsupported NOOP: no duplicate id cited' };
      }
      const duplicate =
        localEntryOf(ctx.local, 'candidates', decision.duplicateOfId) ??
        localRecord(ctx.local, decision.duplicateOfId);
      if (duplicate === undefined) {
        return {
          ok: false,
          reason: `unsupported NOOP: no local candidate or record '${decision.duplicateOfId}'`,
        };
      }
      if (normalizeClaim(duplicate.claim) !== normalizeClaim(claim)) {
        return { ok: false, reason: 'unsupported NOOP: the cited entry carries a different claim' };
      }
      return {
        ok: true,
        verified: {
          response: { targetId: expectedTargetId, decision },
          effective,
          reclassifiedToNoop: false,
        },
      };
    }
  }
}

/** The `cand:` content id the distilled claim would stage under (mirrors `stageCandidate`'s seed). */
function distillContentId(
  entry: CaptureOutboxEntry,
  effective: { kind: string; subject: string; claim: string },
  evidence: MemoryEvidence[],
  authorship: Authorship,
): string {
  return memoryCandidateId({
    kind: effective.kind as MemoryCandidate['kind'],
    subject: effective.subject,
    claim: effective.claim,
    scope: entry.scope,
    appliesTo: entry.appliesTo,
    evidence,
    authorship,
  });
}

// ─── local-store reads (the ONLY store the distiller touches) ────────────────

/** Direct-or-alias presence of an id in a local collection (no team/global store is ever consulted). */
function holdsLocal(store: MemoryStore, id: string, collection: 'candidates' | 'active'): boolean {
  return store.findEntry(collection, id) !== undefined;
}

function localEntryOf(
  store: MemoryStore,
  collection: 'candidates' | 'active',
  id: string,
): (MemoryCandidate | MemoryRecord | MemoryRecordV2) | undefined {
  return store.findEntry(collection, id) as
    | MemoryCandidate
    | MemoryRecord
    | MemoryRecordV2
    | undefined;
}

/** Resolve a record id in the LOCAL store (alias-following), `mem:`-prefixed only. */
function localRecord(store: MemoryStore, id: string): (MemoryRecord | MemoryRecordV2) | undefined {
  const entry = store.findEntry('active', id) as (MemoryRecord | MemoryRecordV2) | undefined;
  return entry !== undefined && typeof entry.id === 'string' && entry.id.startsWith('mem:')
    ? entry
    : undefined;
}

// ─── apply (activateLocal ordering: durable result FIRST, queue bookkeeping LAST) ──

export type DistillApplyResult =
  | {
      ok: true;
      decision: DistillDecisionKind;
      candidateId?: string;
      successorId?: string;
      reclassifiedToNoop: boolean;
    }
  | { ok: false; error: string };

/**
 * Apply a VERIFIED decision. Ordering mirrors `activateLocal` / the capture funnel: the durable
 * result (the staging candidate / the supersede successor + decision) is written FIRST, then the
 * outbox entry is meta-stamped and marked done LAST — every crash window between the two heals as
 * an idempotent no-op (at-least-once redelivery re-derives the same content ids; the ADD
 * reclassification to NOOP is exactly that healing). A CONFLICT never rewrites the cited record:
 * it stages an ADD candidate carrying `meta.contradicts` provenance, and trust stays with the
 * promotion gate.
 */
export function applyVerifiedDecision(
  ctx: DistillVerifyContext,
  verified: VerifiedDistillDecision,
  ports: { env: NodeJS.ProcessEnv; now: () => string },
): DistillApplyResult {
  const { local, entry } = ctx;
  const decision = verified.response.decision;
  const meta = {
    distillDecision: decision.decision,
    distillRationale: decision.rationale,
    distillVerified: true,
    ...(decision.contradictsRecordId !== undefined
      ? { contradictsRecordId: decision.contradictsRecordId }
      : {}),
    ...(decision.supersedesRecordId !== undefined
      ? { supersedesRecordId: decision.supersedesRecordId }
      : {}),
    ...(decision.duplicateOfId !== undefined ? { duplicateOfId: decision.duplicateOfId } : {}),
  };

  // The durable result first.
  let candidateId: string | undefined;
  let successorId: string | undefined;
  if (!verified.reclassifiedToNoop && decision.decision !== 'NOOP') {
    if (decision.decision === 'SUPERSEDE') {
      const api = new MemoryApi({
        stores: { local }, // ONLY local — the no-poison rule + the single-store lock discipline
        env: ports.env,
        now: ports.now,
      });
      const result = api.supersede(
        decision.supersedesRecordId as string,
        {
          claim: verified.effective.claim,
          ...(decision.subject !== undefined ? { subject: decision.subject } : {}),
          ...(decision.kind !== undefined ? { kind: decision.kind as MemoryRecordKind } : {}),
          evidence: entry.evidence,
        },
        {
          actor: entry.authorship.actor,
          reason: decision.rationale,
          ...(entry.authorship.tool !== undefined ? { tool: entry.authorship.tool } : {}),
        },
      );
      if (!result.ok) return { ok: false, error: `supersede failed: ${result.error}` };
      successorId = result.successorId;
    } else {
      // ADD / CONFLICT → an untrusted staging candidate (never a record; promotion stays the gate).
      const candidate: MemoryCandidate = {
        id: distillContentId(entry, verified.effective, entry.evidence, entry.authorship),
        schemaVersion: '1',
        kind: verified.effective.kind,
        subject: verified.effective.subject,
        claim: verified.effective.claim,
        scope: entry.scope,
        appliesTo: entry.appliesTo,
        evidence: entry.evidence,
        authorship: entry.authorship,
        origin: 'attempt',
        attemptId: entry.id,
        proposedAt: ports.now(),
        meta: {
          distilledFrom: entry.id,
          ...(decision.decision === 'CONFLICT'
            ? { contradicts: decision.contradictsRecordId }
            : {}),
        },
      };
      // Idempotent re-distill: if the content id already landed (crash between this write and the
      // done-mark), skip the write — a byte-stable no-op.
      if (!holdsLocal(local, candidate.id, 'candidates')) {
        local.upsertEntry('candidates', candidate); // write gate: validate + secret-scan
      }
      candidateId = candidate.id;
    }
  }

  // Then the queue-lifecycle bookkeeping: meta stamp + done, under one same-store lock hold.
  const done = local.withLock(() => {
    const stamped: CaptureOutboxEntry = {
      ...entry,
      meta: { ...entry.meta, ...meta },
    };
    local.upsertEntry('outbox', stamped);
    return markCaptureDone(local, entry.id, {
      ...(candidateId !== undefined ? { candidateId } : {}),
    });
  });
  return {
    ok: true,
    decision: verified.reclassifiedToNoop ? 'NOOP' : decision.decision,
    ...(candidateId !== undefined ? { candidateId } : {}),
    ...(successorId !== undefined ? { successorId } : {}),
    reclassifiedToNoop: verified.reclassifiedToNoop,
  };
}

/**
 * Record one failed distillation (an unverifiable or errored provider decision) and dead-letter at
 * the outbox's retry limit — B's lifecycle, honored here, never re-implemented: the attempt append
 * is `recordCaptureRetry`'s content-addressed event, and the terminal transition is
 * `deadLetterCapture`'s dead-first-then-dequeue ordering.
 */
export function failDistillItem(
  store: MemoryStore,
  entry: CaptureOutboxEntry,
  reason: string,
  now: () => string,
): { attempt: number; deadLettered: boolean } {
  const attempt = captureRetryCount(store, entry.id) + 1;
  recordCaptureRetry(store, entry, attempt, reason, now());
  const deadLettered = shouldDeadLetterCapture(attempt)
    ? deadLetterCapture(store, entry.id, reason).deadLettered
    : false;
  return { attempt, deadLettered };
}
