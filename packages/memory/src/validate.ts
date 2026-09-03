import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import {
  ALIAS_SCHEMA,
  ATTEMPT_SCHEMA,
  CANDIDATE_SCHEMA,
  CAPTURE_SCHEMA,
  DECISION_SCHEMA,
  FEEDBACK_SCHEMA,
  MEMORY_MANIFEST_SCHEMA,
  RECEIPT_SCHEMA,
  RECORD_SCHEMA,
  RECORD_V2_SCHEMA,
} from './schemas.js';
/**
 * Record validation against the vendored memory-1 JSON Schemas (mirrors `core/validate.ts`).
 * Compiled once, reused per record. Closed enums for kind/verdict/evidence-kind/signal/phase/
 * runner mean an unknown value fails validation — the W2 exit gate "unknown schemas fail closed"
 * starts here. The id-prefix `pattern` anchors in each schema additionally enforce the
 * content-addressed id grammar (`mem:`/`cand:`/`cap:`/`att:`/`rcpt:`/`dec:`/`fb:` + hex).
 */
import type {
  AttemptEvent,
  CaptureOutboxEntry,
  GateReceipt,
  MemoryAlias,
  MemoryCandidate,
  MemoryDecision,
  MemoryFeedback,
  MemoryManifest,
  MemoryRecord,
  MemoryRecordV2,
} from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const validateRecordFn: ValidateFunction = ajv.compile(RECORD_SCHEMA);
const validateRecordV2Fn: ValidateFunction = ajv.compile(RECORD_V2_SCHEMA);
const validateCandidateFn: ValidateFunction = ajv.compile(CANDIDATE_SCHEMA);
const validateCaptureFn: ValidateFunction = ajv.compile(CAPTURE_SCHEMA);
const validateAttemptFn: ValidateFunction = ajv.compile(ATTEMPT_SCHEMA);
const validateReceiptFn: ValidateFunction = ajv.compile(RECEIPT_SCHEMA);
const validateDecisionFn: ValidateFunction = ajv.compile(DECISION_SCHEMA);
const validateFeedbackFn: ValidateFunction = ajv.compile(FEEDBACK_SCHEMA);
const validateManifestFn: ValidateFunction = ajv.compile(MEMORY_MANIFEST_SCHEMA);
const validateAliasFn: ValidateFunction = ajv.compile(ALIAS_SCHEMA);

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

/** Thrown-path twin of {@link assertValidMemoryRecord} for the memory-2 envelope (G1.1). */
export function assertValidMemoryRecordV2(record: MemoryRecordV2): void {
  const ok: boolean = validateRecordV2Fn(record);
  if (!ok) throw new MemorySchemaError('record-v2', validateRecordV2Fn.errors, record.id);
  assertValidV2ValidTime(record);
}

/**
 * The validTime half-open-window check the draft-07 schema cannot express on its own (finding: the
 * schema accepted `to <= from` and any non-empty string as a date): `from` and `to` (when present)
 * must be parseable date-times, and `to` must be STRICTLY after `from` — the interval is
 * `[from, to)`, so an inverted or empty window is not a validity interval at all. PURE string
 * parsing (Date.parse, never the clock). Enforced on every memory-2 write AND read (the loader
 * validates through {@link assertValidMemoryEntry}).
 */
function assertValidV2ValidTime(record: MemoryRecordV2): void {
  const { from, to } = record.validTime;
  const fromMs = Date.parse(from);
  if (Number.isNaN(fromMs)) {
    throw new MemorySchemaError('record-v2', [{ invalidDateTime: from }], record.id);
  }
  if (to === undefined) return; // open-ended: still true from `from` onwards
  const toMs = Date.parse(to);
  if (Number.isNaN(toMs)) {
    throw new MemorySchemaError('record-v2', [{ invalidDateTime: to }], record.id);
  }
  if (!(toMs > fromMs)) {
    throw new MemorySchemaError(
      'record-v2',
      [{ validTimeWindow: 'to must be strictly after from (half-open [from,to))' }],
      record.id,
    );
  }
}

export function assertValidMemoryCandidate(candidate: MemoryCandidate): void {
  const ok: boolean = validateCandidateFn(candidate);
  if (!ok) throw new MemorySchemaError('candidate', validateCandidateFn.errors, candidate.id);
}

export function assertValidCaptureOutboxEntry(entry: CaptureOutboxEntry): void {
  const ok: boolean = validateCaptureFn(entry);
  if (!ok) throw new MemorySchemaError('capture-outbox', validateCaptureFn.errors, entry.id);
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

/** Thrown-path twin of the per-kind validators for a legacy-ID alias (G1.2 alias map). */
export function assertValidMemoryAlias(alias: MemoryAlias): void {
  const ok: boolean = validateAliasFn(alias);
  if (!ok) throw new MemorySchemaError('alias', validateAliasFn.errors, alias.id);
}

/** The id-prefix → validator dispatch table. `assertValidMemoryEntry` picks the validator by the
 *  entry's id prefix so a store can validate a mixed-kind shard line with one call. `mem:` is
 *  deliberately ABSENT: memory-1 and memory-2 records share the `mem:` prefix, so the record
 *  validator is picked by the entry's declared `schemaVersion` instead (see RECORD_VALIDATORS). */
const ENTRY_VALIDATORS: Record<string, { validate: ValidateFunction; label: string }> = {
  cand: { validate: validateCandidateFn, label: 'candidate' },
  cap: { validate: validateCaptureFn, label: 'capture-outbox' },
  att: { validate: validateAttemptFn, label: 'attempt' },
  rcpt: { validate: validateReceiptFn, label: 'receipt' },
  dec: { validate: validateDecisionFn, label: 'decision' },
  fb: { validate: validateFeedbackFn, label: 'feedback' },
  alias: { validate: validateAliasFn, label: 'alias' },
};

/** schemaVersion → record validator. The `mem:` prefix is shared by memory-1 and memory-2 records,
 *  so the record schema is dispatched on the DECLARED version — a `mem:` id with an unknown or
 *  missing `schemaVersion` fails closed here (never coerced to the latest version). */
const RECORD_VALIDATORS: Record<string, { validate: ValidateFunction; label: string }> = {
  '1': { validate: validateRecordFn, label: 'record' },
  '2': { validate: validateRecordV2Fn, label: 'record-v2' },
};

/** Validate any memory entry by its id prefix (records: by id prefix + declared schemaVersion).
 *  Throws `MemorySchemaError` on failure; throws a plain Error if the id prefix is unknown (an
 *  unrecognized record kind fails closed). */
export function assertValidMemoryEntry(entry: { id: string } & Record<string, unknown>): void {
  const colon = entry.id.indexOf(':');
  const prefix = colon > 0 ? entry.id.slice(0, colon) : '';
  if (prefix === 'mem') {
    const version = entry.schemaVersion;
    const v =
      typeof version === 'string'
        ? RECORD_VALIDATORS[version] // undefined → fail closed below
        : undefined;
    if (!v) {
      throw new MemorySchemaError(
        'record',
        [{ unknownSchemaVersion: typeof version === 'string' ? version : null }],
        entry.id,
      );
    }
    const ok: boolean = v.validate(entry);
    if (!ok) throw new MemorySchemaError(v.label, v.validate.errors, entry.id);
    if (version === '2') assertValidV2ValidTime(entry as unknown as MemoryRecordV2);
    return;
  }
  const v = ENTRY_VALIDATORS[prefix];
  if (!v) throw new MemorySchemaError('entry', [{ unknownIdPrefix: prefix }], entry.id);
  const ok: boolean = v.validate(entry);
  if (!ok) throw new MemorySchemaError(v.label, v.validate.errors, entry.id);
}
