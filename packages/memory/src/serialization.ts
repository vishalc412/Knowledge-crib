/**
 * Canonical memory serialization (mirrors `memory-merge.ts`'s `serializeMemoryChunk` +
 * `merge.ts`'s `serializeChunk`). Key-sorted JSON per line + id-sorted shard ordering → a re-emitted
 * shard is byte-identical regardless of insertion order, so two independent writes of the same
 * claims produce the same bytes (the W1 byte-stability discipline, applied to memory).
 */
import type { MemoryEntry } from './types.js';

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

/** Canonical key-sorted JSON for one entry (byte-stable across writers). */
export function canonicalMemoryJson(entry: MemoryEntry): string {
  return JSON.stringify(sortKeys(entry));
}

/**
 * Serialize a collection of memory entries to id-sorted, canonical JSONL with a trailing newline.
 * Empty input → empty string (matches `serializeMemoryChunk`). The caller is responsible for
 * validating entries before serialization (the store calls `assertValidMemoryEntry` on write).
 */
export function serializeMemoryShard(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => canonicalMemoryJson(e));
  return `${lines.join('\n')}\n`;
}
