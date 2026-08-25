/**
 * The memory secret scanner (PRD §2: "all authored prose is secret-scanned" + "command output is
 * never persisted verbatim"). Mirrors the `mcp/secrets.ts` contract the pattern report describes
 * (`collectStrings(item) → scanSecrets(value)` per field, reject on any hit) but is self-contained
 * so the memory package does not depend on `mcp`. A secret hit is a hard REJECT — "a secret must
 * never persist regardless of grounding" — so the store calls {@link assertNoMemorySecrets} before
 * validating + writing any entry.
 *
 * Patterns are tuned for HIGH PRECISION: structural values (blake3 digests, content-addressed ids,
 * ISO timestamps, enum tokens) are skipped before scanning, so a `targetHash` or `mem:` id never
 * false-positives as a "long high-entropy string".
 */
import type { MemoryEntry } from './types.js';

export interface SecretHit {
  /** which pattern fired. */
  name: string;
  /** the matching substring (truncated for a safe error message). */
  match: string;
}

/** Known credential/token shapes. Order: most-specific prefixes first. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  {
    name: 'secret-assignment',
    // a secret-keyword-adjacent assignment with a long opaque value
    re: /(?:secret|token|key|password|passwd|credential|api[_-]?key|auth|bearer)["']?\s*[:=]\s*["']([A-Za-z0-9_+/=-]{12,})["']/i,
  },
];

/** Structural values that are never "authored prose" — skip before scanning. */
const STRUCTURAL = [
  /^blake3:[0-9a-f]+$/, // content hashes
  /^(mem|cand|att|attgrp|rcpt|dec|fb):[0-9a-f]+$/, // content-addressed ids
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO timestamps
  /^(fact|procedure|decision|pitfall|convention|activate|accept|supersede|retract|quarantine|useful|unhelpful|contradicted|candidate|local|team|valid|degraded|invalid|current|needs-review|orphaned|active|superseded|retracted|start|observation|action|outcome|evaluation|promotion|compaction|cli|ci|repo|global|agent|human|observe|attempt|success|failure|partial)$/, // enum tokens
  /^(source-quote|execution-assertion|committed-policy|human-attestation|receipt-pair)$/, // evidence kinds
];

function isStructural(s: string): boolean {
  return STRUCTURAL.some((re) => re.test(s));
}

/** Recursively collect every string value in a record (not keys), for scanning. */
export function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        walk((v as Record<string, unknown>)[k]);
      }
    }
  };
  walk(value);
  return out;
}

/** Scan one string for secret patterns. Structural values (hashes/ids/timestamps/enums) are skipped. */
export function scanSecrets(text: string): SecretHit[] {
  if (text.length === 0 || isStructural(text)) return [];
  const hits: SecretHit[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const match = m[1] ?? m[0] ?? '';
      hits.push({ name, match: match.slice(0, 24) });
    }
  }
  return hits;
}

/** Scan every string value in an entry; return all hits across all fields. */
export function scanEntrySecrets(entry: MemoryEntry): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const s of collectStrings(entry)) {
    hits.push(...scanSecrets(s));
  }
  return hits;
}

/** Thrown when an entry carries a secret pattern (the persist-time hard reject). */
export class MemorySecretError extends Error {
  constructor(public readonly hits: SecretHit[]) {
    const where = hits.map((h) => `${h.name}:${h.match}`).join(', ');
    super(`secret pattern detected in memory entry (${where}) — redact before persisting`);
    this.name = 'MemorySecretError';
  }
}

/** Hard-reject an entry that carries any secret pattern. The store calls this BEFORE validation. */
export function assertNoMemorySecrets(entry: MemoryEntry): void {
  const hits = scanEntrySecrets(entry);
  if (hits.length > 0) throw new MemorySecretError(hits);
}
