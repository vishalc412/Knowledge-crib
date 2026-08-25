import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import {
  ATTEMPT_SCHEMA,
  CANDIDATE_SCHEMA,
  DECISION_SCHEMA,
  FEEDBACK_SCHEMA,
  MEMORY_MANIFEST_SCHEMA,
  RECEIPT_SCHEMA,
  RECORD_SCHEMA,
} from './schemas.js';
/**
 * Record validation against the vendored memory-1 JSON Schemas (mirrors `core/validate.ts`).
 * Compiled once, reused per record. Closed enums for kind/verdict/evidence-kind/signal/phase/
 * runner mean an unknown value fails validation — the W2 exit gate "unknown schemas fail closed"
 * starts here. The id-prefix `pattern` anchors in each schema additionally enforce the
 * content-addressed id grammar (`mem:`/`cand:`/`att:`/`rcpt:`/`dec:`/`fb:` + hex).
 */
import type {
  AttemptEvent,
  GateReceipt,
  MemoryCandidate,
  MemoryDecision,
  MemoryFeedback,
  MemoryManifest,
  MemoryRecord,
} from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const validateRecordFn: ValidateFunction = ajv.compile(RECORD_SCHEMA);
const validateCandidateFn: ValidateFunction = ajv.compile(CANDIDATE_SCHEMA);
const validateAttemptFn: ValidateFunction = ajv.compile(ATTEMPT_SCHEMA);
const validateReceiptFn: ValidateFunction = ajv.compile(RECEIPT_SCHEMA);
const validateDecisionFn: ValidateFunction = ajv.compile(DECISION_SCHEMA);
const validateFeedbackFn: ValidateFunction = ajv.compile(FEEDBACK_SCHEMA);
const validateManifestFn: ValidateFunction = ajv.compile(MEMORY_MANIFEST_SCHEMA);

/** Thrown when a memory record fails schema validation before a write. */
export class MemorySchemaError extends Error {
  constructor(
    kind: string,
    public readonly errors: unknown,
    id?: string,
  ) {
    super(`${kind} schema validation failed${id ? ` for ${id}` : ''}: ${JSON.stringify(errors)}`);
    this.name = 'MemorySchemaError';
  }
}

export function assertValidMemoryRecord(record: MemoryRecord): void {
  const ok: boolean = validateRecordFn(record);
  if (!ok) throw new MemorySchemaError('record', validateRecordFn.errors, record.id);
}

export function assertValidMemoryCandidate(candidate: MemoryCandidate): void {
  const ok: boolean = validateCandidateFn(candidate);
  if (!ok) throw new MemorySchemaError('candidate', validateCandidateFn.errors, candidate.id);
}

export function assertValidAttemptEvent(event: AttemptEvent): void {
  const ok: boolean = validateAttemptFn(event);
  if (!ok) throw new MemorySchemaError('attempt', validateAttemptFn.errors, event.id);
}

export function assertValidGateReceipt(receipt: GateReceipt): void {
  const ok: boolean = validateReceiptFn(receipt);
  if (!ok) throw new MemorySchemaError('receipt', validateReceiptFn.errors, receipt.id);
}

export function assertValidMemoryDecision(decision: MemoryDecision): void {
  const ok: boolean = validateDecisionFn(decision);
  if (!ok) throw new MemorySchemaError('decision', validateDecisionFn.errors, decision.id);
}

export function assertValidMemoryFeedback(feedback: MemoryFeedback): void {
  const ok: boolean = validateFeedbackFn(feedback);
  if (!ok) throw new MemorySchemaError('feedback', validateFeedbackFn.errors, feedback.id);
}

export function assertValidMemoryManifest(manifest: MemoryManifest): void {
  const ok: boolean = validateManifestFn(manifest);
  if (!ok) throw new MemorySchemaError('manifest', validateManifestFn.errors);
}

/** The id-prefix → validator dispatch table. `assertValidMemoryEntry` picks the validator by the
 *  entry's id prefix so a store can validate a mixed-kind shard line with one call. */
const ENTRY_VALIDATORS: Record<string, { validate: ValidateFunction; label: string }> = {
  mem: { validate: validateRecordFn, label: 'record' },
  cand: { validate: validateCandidateFn, label: 'candidate' },
  att: { validate: validateAttemptFn, label: 'attempt' },
  rcpt: { validate: validateReceiptFn, label: 'receipt' },
  dec: { validate: validateDecisionFn, label: 'decision' },
  fb: { validate: validateFeedbackFn, label: 'feedback' },
};

/** Validate any memory entry by its id prefix. Throws `MemorySchemaError` on failure; throws a
 *  plain Error if the id prefix is unknown (an unrecognized record kind fails closed). */
export function assertValidMemoryEntry(entry: { id: string } & Record<string, unknown>): void {
  const colon = entry.id.indexOf(':');
  const prefix = colon > 0 ? entry.id.slice(0, colon) : '';
  const v = ENTRY_VALIDATORS[prefix];
  if (!v) throw new MemorySchemaError('entry', [{ unknownIdPrefix: prefix }], entry.id);
  const ok: boolean = v.validate(entry);
  if (!ok) throw new MemorySchemaError(v.label, v.validate.errors, entry.id);
}
