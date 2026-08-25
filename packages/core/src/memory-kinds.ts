/**
 * Memory record + decision kinds (PRD §2 "Memory records").
 *
 * Memory uses its OWN schema (`memory-1`) and lifecycle, deliberately outside the soul's closed
 * `NodeKind` enum (PRD boundary #2). This module holds only the kind enumerations the W0 merge
 * driver and the W2 schema both need; the full `MemoryRecord` / `MemoryCandidate` / `GateReceipt`
 * validators land in W2.
 */

/** A claim's semantic kind. One claim per record. */
export type MemoryRecordKind = 'fact' | 'procedure' | 'decision' | 'pitfall' | 'convention';

export const MEMORY_RECORD_KINDS: readonly MemoryRecordKind[] = [
  'fact',
  'procedure',
  'decision',
  'pitfall',
  'convention',
];

/**
 * A lifecycle decision event applied to a record. `supersede` and `retract` retire a record;
 * the W0 merge driver treats a concurrent `supersede`+`retract` on the same subject (one per
 * branch) as a logical conflict that both survive.
 */
export type MemoryDecisionKind = 'activate' | 'accept' | 'supersede' | 'retract' | 'quarantine';

export const MEMORY_DECISION_KINDS: readonly MemoryDecisionKind[] = [
  'activate',
  'accept',
  'supersede',
  'retract',
  'quarantine',
];

export function isMemoryRecordKind(v: unknown): v is MemoryRecordKind {
  return typeof v === 'string' && (MEMORY_RECORD_KINDS as readonly string[]).includes(v);
}

export function isMemoryDecisionKind(v: unknown): v is MemoryDecisionKind {
  return typeof v === 'string' && (MEMORY_DECISION_KINDS as readonly string[]).includes(v);
}
