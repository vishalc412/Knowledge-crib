/**
 * Strict append-only merge for memory JSONL chunks (W0 / PRD §2 + §3 W0).
 *
 * Memory is NOT the soul. Soul chunks are regenerated from source and merged with
 * edit/modify/delete semantics (see {@link mergeThreeWay}). Memory records and decision
 * events are **immutable, append-only, content-addressed claims** — they are never edited
 * or deleted at the storage layer. A record's lifecycle (active / superseded / retracted)
 * is changed only by appending a *decision event*, never by mutating or removing a line.
 *
 * The merge is therefore a **union by content id**, with four rules from the Wayfinder plan:
 *   1. Union immutable records/events by content id. A record present on either side (or in
 *      base) survives — line-level "deletions" are NOT honored, because a committed claim can
 *      only be retired by a `retract`/`supersede` decision event, not by erasing its line.
 *   2. Same id with different content → **hard conflict** (the driver exits non-zero and writes
 *      conflict markers; a content-addressed id must never collide with different content).
 *   3. Concurrent `supersede` + `retract` events for the same subject (one on ours, one on
 *      theirs, both new since base) → **both survive** and a logical-conflict warning is
 *      surfaced for human review. Storage stays complete; the contradiction is a read-layer
 *      concern, not a dropped line.
 *   4. A malformed line (not valid JSON, or missing a string `id`) → **fail the merge**. Unlike
 *      {@link parseChunk}, malformed memory is never silently skipped — a silent skip could
 *      erase a committed claim or hide a corrupted shard.
 *
 * This module is pure (no fs); {@link mergeDriverFiles} in `hooks.ts` does the file I/O and
 * dispatches soul chunks to `mergeThreeWay` and memory chunks to `mergeMemoryChunk`.
 */
import type { MemoryDecisionKind } from './memory-kinds.js';

/** A memory line is any JSON object carrying a string `id`; the rest is opaque to the merger. */
export interface MemoryRecord {
  id: string;
  [k: string]: unknown;
}

/** Decision kinds that retire/replace a record — the contradictory pair the merger watches for. */
const RETIRING_KINDS = new Set<MemoryDecisionKind>(['supersede', 'retract']);

/** One side of a 3-way merge parsed into an id→record map plus any malformed-line errors. */
export interface ParsedMemoryChunk {
  records: Map<string, MemoryRecord>;
  /** `source:line: reason` for each rejected line (empty when the chunk is clean). */
  errors: string[];
}

/**
 * Parse a memory JSONL chunk strictly. Blank lines are ignored; every non-blank line MUST be a
 * JSON object with a string `id`. Any other line is recorded as an error rather than skipped,
 * so the caller can fail the merge (rule 4). `source` labels the lines for diagnostics.
 */
export function parseMemoryChunk(text: string, source: string): ParsedMemoryChunk {
  const records = new Map<string, MemoryRecord>();
  const errors: string[] = [];
  const lines = text.length === 0 ? [] : text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as unknown;
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        errors.push(`${source}:${i + 1}: not a JSON object`);
        continue;
      }
      const obj = rec as Record<string, unknown>;
      if (typeof obj.id !== 'string' || obj.id.length === 0) {
        errors.push(`${source}:${i + 1}: missing or non-string 'id'`);
        continue;
      }
      records.set(obj.id, obj as MemoryRecord);
    } catch (err) {
      const reason = (err as Error).message ?? 'invalid JSON';
      errors.push(`${source}:${i + 1}: ${reason}`);
    }
  }
  return { records, errors };
}

export interface MemoryMergeResult {
  /** id → record union (id-sorted on serialization). Conflicting ids are excluded. */
  merged: Map<string, MemoryRecord>;
  /** Logical-conflict warnings (supersede+retract on the same subject, both sides). */
  warnings: string[];
  /** True on a hard conflict (same id, different content) OR a malformed line. */
  conflicts: boolean;
  /** ids that hard-conflicted (same id, different content) — for conflict-marker emission. */
  conflictIds: string[];
  /** `source:line: reason` entries for every malformed input line (rule 4). */
  errors: string[];
}

/** Structural equality via key-sorted JSON serialization (matches `merge.ts`). */
function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/** Is `rec` a decision event that retires/replaces a record (carries `kind` + `subject`)? */
function isRetiringDecision(rec: MemoryRecord): rec is MemoryRecord & {
  kind: MemoryDecisionKind;
  subject: string;
} {
  return (
    typeof rec.kind === 'string' &&
    typeof rec.subject === 'string' &&
    (RETIRING_KINDS as Set<string>).has(rec.kind)
  );
}

/**
 * Three-way union merge of memory chunks. Pure; never touches the filesystem.
 *
 * @param base the merge base (committed ancestor) — its records always survive (immutability).
 * @param ours our side (also the merge output target).
 * @param theirs their side.
 */
export function mergeMemoryChunk(
  base: ParsedMemoryChunk,
  ours: ParsedMemoryChunk,
  theirs: ParsedMemoryChunk,
): MemoryMergeResult {
  // Rule 4: any malformed line in ANY input fails the merge — do not silently skip.
  const errors = [...base.errors, ...ours.errors, ...theirs.errors];

  const merged = new Map<string, MemoryRecord>();
  const conflictIds: string[] = [];
  const warnings: string[] = [];

  // Rule 1 + 2: union by id; same id with different content is a hard conflict.
  const ids = new Set<string>([
    ...base.records.keys(),
    ...ours.records.keys(),
    ...theirs.records.keys(),
  ]);
  for (const id of ids) {
    const b = base.records.get(id);
    const o = ours.records.get(id);
    const t = theirs.records.get(id);
    const present = [b, o, t].filter((r): r is MemoryRecord => r !== undefined);
    if (present.length === 0) continue;

    const first = present[0];
    if (!first) continue;
    const allSame = present.every((r) => stable(r) === stable(first));
    if (allSame) {
      merged.set(id, first);
    } else {
      conflictIds.push(id);
    }
  }

  // A hard conflict (same id, different content) OR a malformed line makes the merge fail.
  const conflicts = errors.length > 0 || conflictIds.length > 0;

  // Rule 3: concurrent supersede + retract for the same subject (one ours, one theirs, both new
  // since base) both survive (they have distinct content ids so both are in `merged` already) and
  // surface as a logical conflict for human review. Supersede-vs-supersede with different content
  // for the same subject is also a logical conflict (two branches picked different successors).
  if (conflictIds.length === 0 && errors.length === 0) {
    const oursNew = new Map<string, MemoryRecord>();
    for (const [id, rec] of ours.records)
      if (!base.records.has(id) && isRetiringDecision(rec)) oursNew.set(id, rec);
    const theirsNew = new Map<string, MemoryRecord>();
    for (const [id, rec] of theirs.records)
      if (!base.records.has(id) && isRetiringDecision(rec)) theirsNew.set(id, rec);

    // group retiring decisions added on each side by subject
    const bySubject = (side: Map<string, MemoryRecord>): Map<string, Set<MemoryDecisionKind>> => {
      const m = new Map<string, Set<MemoryDecisionKind>>();
      for (const rec of side.values()) {
        if (!isRetiringDecision(rec)) continue;
        const set = m.get(rec.subject) ?? new Set<MemoryDecisionKind>();
        set.add(rec.kind);
        m.set(rec.subject, set);
      }
      return m;
    };
    const oBySubj = bySubject(oursNew);
    const tBySubj = bySubject(theirsNew);
    const subjects = new Set<string>([...oBySubj.keys(), ...tBySubj.keys()]);
    for (const subject of subjects) {
      const oKinds = oBySubj.get(subject) ?? new Set<MemoryDecisionKind>();
      const tKinds = tBySubj.get(subject) ?? new Set<MemoryDecisionKind>();
      const contradicts =
        (oKinds.has('supersede') && tKinds.has('retract')) ||
        (oKinds.has('retract') && tKinds.has('supersede')) ||
        (oKinds.has('supersede') && tKinds.has('supersede'));
      if (contradicts) {
        warnings.push(
          `logical conflict: concurrent lifecycle events for subject ${subject} on both branches (ours=[${[...oKinds].join(',')}] theirs=[${[tKinds].join(',')}]) — both retained, review`,
        );
      }
    }
  }

  return { merged, warnings, conflicts, conflictIds, errors };
}

/** Serialize an id→record map to id-sorted JSONL (trailing newline); empty map → empty string. */
export function serializeMemoryChunk(map: Map<string, MemoryRecord>): string {
  const lines = [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, rec]) => JSON.stringify(rec));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Render a hard-conflict chunk as git-style conflict markers around each colliding id, with the
 * non-conflicting union records emitted normally. Written to `%A` by the driver when a content
 * collision cannot be auto-resolved, so `git status` shows the path as conflicted and a human can
 * resolve the markers. Malformed-input failures render a header noting the rejected lines instead.
 */
export function renderMemoryConflict(
  base: ParsedMemoryChunk,
  ours: ParsedMemoryChunk,
  theirs: ParsedMemoryChunk,
  result: MemoryMergeResult,
): string {
  const out: string[] = [];
  if (result.errors.length > 0) {
    out.push('<<<<<<< memory-merge: malformed input (merge FAILED)');
    for (const e of result.errors) out.push(`# rejected: ${e}`);
    out.push('=======');
    out.push('# merge aborted: fix malformed memory lines and re-merge.');
    out.push('>>>>>>> memory-merge');
    return `${out.join('\n')}\n`;
  }
  // emit the clean union in id order, inserting conflict markers around colliding ids
  const ids = [...result.merged.keys(), ...result.conflictIds].sort();
  for (const id of ids) {
    if (result.merged.has(id)) {
      out.push(JSON.stringify(result.merged.get(id)));
      continue;
    }
    const o = ours.records.get(id);
    const t = theirs.records.get(id);
    const b = base.records.get(id);
    out.push(`<<<<<<< ours (${id})`);
    if (o) out.push(JSON.stringify(o));
    else if (b) out.push(JSON.stringify(b));
    out.push('=======');
    if (t) out.push(JSON.stringify(t));
    else if (b) out.push(JSON.stringify(b));
    out.push(`>>>>>>> theirs (${id})`);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
