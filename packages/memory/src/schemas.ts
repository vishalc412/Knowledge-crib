/**
 * The vendored memory-1 JSON Schemas as plain objects, so `core`/`cli`/consumers can hand them to
 * Ajv without filesystem lookups, and so a memory store is self-describing (mirrors soul-schema's
 * `VENDORED_SCHEMAS`). Imported with `with { type: 'json' }` (TS 5 JSON modules).
 */
import attemptSchema from './schema/attempt.schema.json' with { type: 'json' };
import candidateSchema from './schema/candidate.schema.json' with { type: 'json' };
import decisionSchema from './schema/decision.schema.json' with { type: 'json' };
import feedbackSchema from './schema/feedback.schema.json' with { type: 'json' };
import manifestSchema from './schema/manifest.schema.json' with { type: 'json' };
import receiptSchema from './schema/receipt.schema.json' with { type: 'json' };
import recordSchema from './schema/record.schema.json' with { type: 'json' };

export const RECORD_SCHEMA = recordSchema as Record<string, unknown>;
export const CANDIDATE_SCHEMA = candidateSchema as Record<string, unknown>;
export const ATTEMPT_SCHEMA = attemptSchema as Record<string, unknown>;
export const RECEIPT_SCHEMA = receiptSchema as Record<string, unknown>;
export const DECISION_SCHEMA = decisionSchema as Record<string, unknown>;
export const FEEDBACK_SCHEMA = feedbackSchema as Record<string, unknown>;
export const MEMORY_MANIFEST_SCHEMA = manifestSchema as Record<string, unknown>;

/** file-name → schema object, for writing a self-describing `.crib/memory/schema/` directory. */
export const VENDORED_MEMORY_SCHEMAS: Record<string, Record<string, unknown>> = {
  'record.schema.json': RECORD_SCHEMA,
  'candidate.schema.json': CANDIDATE_SCHEMA,
  'attempt.schema.json': ATTEMPT_SCHEMA,
  'receipt.schema.json': RECEIPT_SCHEMA,
  'decision.schema.json': DECISION_SCHEMA,
  'feedback.schema.json': FEEDBACK_SCHEMA,
  'manifest.schema.json': MEMORY_MANIFEST_SCHEMA,
};
