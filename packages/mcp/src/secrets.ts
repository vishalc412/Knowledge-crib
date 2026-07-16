/**
 * Secret-pattern scanner (M1.4 — the persist-time guard).
 *
 * Semantic layer (`.crib/graph/semantic/`) is committed, and LLM-authored evidence `quote` lifts
 * verbatim source text. If a secret lives in the indexed source, a model could copy it into a quote
 * or an analysis field — and the artifact would be committed to git. This scanner runs at
 * `enrich_save` time over every string the model authored and rejects the whole item on any hit, so
 * a planted canary secret can never reach a committed artifact.
 *
 * Two detection families, both conservative (favor false-negatives over false-positives — a
 * false-positive would block legitimate code, a false-negative only risks a real secret the model
 * happened not to quote):
 *   1. Well-known credential formats (AWS, GitHub, Slack, OpenAI/Anthropic `sk-`, Google API, JWT,
 *      PEM private-key blocks) — matched by anchored regex.
 *   2. High-entropy runs — long base64/hex-ish tokens with Shannon entropy ≥ {@link ENTROPY_THRESHOLD}
 *      and length ≥ {@link MIN_ENTROPY_LEN}. Catches generic API keys not matching a known prefix.
 *
 * PURE, dependency-free.
 */

/** A single secret match in a string. */
export interface SecretHit {
  /** stable detector id, e.g. `aws-access-key-id`, `pem-private-key`, `high-entropy` */
  pattern: string;
  /** 0-based offset of the match in the scanned text */
  start: number;
  /** 0-based exclusive end offset of the match */
  end: number;
}

/** Well-known credential formats. Anchored to avoid matching inside long base64 blobs by accident. */
const KEY_PATTERNS: Array<{ pattern: string; re: RegExp }> = [
  { pattern: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { pattern: 'aws-secret', re: /aws_secret_access_key["']?\s*[:=]\s*["'][A-Za-z0-9/+=]{40}["']/i },
  { pattern: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { pattern: 'slack-token', re: /xox[abp]-[A-Za-z0-9-]{10,}/ },
  { pattern: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { pattern: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { pattern: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { pattern: 'stripe-key', re: /sk_(live|test)_[A-Za-z0-9]{24,}/ },
  { pattern: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    pattern: 'pem-private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    pattern: 'generic-password-assign',
    re: /(?:password|passwd|pwd|secret|api_key|apikey|access_token|token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
];

/** Minimum run length before an entropy check is even attempted. */
const MIN_ENTROPY_LEN = 32;
/** Shannon entropy (base-2) a run must meet to count as a secret. Real tokens ≈ 4.5–5.5. */
const ENTROPY_THRESHOLD = 4.2;
/** A candidate secret run: base64 alphabet (with - _ + / =) or hex, no spaces. */
const ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Scan a single string for secret patterns. Returns every hit (known-prefix first, then
 * high-entropy runs). PURE. `""` and non-string inputs return `[]`.
 */
export function scanSecrets(text: string): SecretHit[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits: SecretHit[] = [];
  for (const { pattern, re } of KEY_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m.index === undefined || m[0] === undefined) continue;
      hits.push({ pattern, start: m.index, end: m.index + m[0].length });
      if (re.global) {
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loop
      } else {
        break; // non-global regexes match once
      }
    }
  }
  // high-entropy runs: only flag if not already covered by a known-prefix hit
  ENTROPY_RUN.lastIndex = 0;
  for (let m = ENTROPY_RUN.exec(text); m !== null; m = ENTROPY_RUN.exec(text)) {
    if (m.index === undefined || m[0] === undefined) continue;
    const run = m[0];
    if (run.length < MIN_ENTROPY_LEN) continue;
    if (shannonEntropy(run) < ENTROPY_THRESHOLD) continue;
    const start = m.index;
    const end = start + run.length;
    // skip if a known-prefix hit already covers this run (avoid double-reporting a JWT as both jwt + entropy)
    if (hits.some((h) => h.start >= start - 1 && h.end <= end + 1)) continue;
    hits.push({ pattern: 'high-entropy', start, end });
  }
  return hits;
}

/** True iff the string contains at least one secret-pattern hit. */
export function hasSecret(text: string): boolean {
  return scanSecrets(text).length > 0;
}

/**
 * Walk a value and collect every string it contains, with a dotted path. Used by `enrich_save` to
 * scan every field a model authored (analysis, graph, evidence) without hard-coding the schema.
 * Returns `[]` for non-string scalars and empty strings.
 */
export interface StringField {
  path: string;
  value: string;
}
export function collectStrings(value: unknown, base = ''): StringField[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [{ path: base || '<root>', value }] : [];
  }
  if (Array.isArray(value)) {
    const out: StringField[] = [];
    for (const [i, v] of value.entries()) out.push(...collectStrings(v, `${base}[${i}]`));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: StringField[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(...collectStrings(v, base ? `${base}.${k}` : k));
    }
    return out;
  }
  return [];
}

/** Mask every secret hit in a string with `[REDACTED:<pattern>]`. Used by `crib export --redact`. */
export function redactSecrets(text: string): string {
  const hits = scanSecrets(text);
  if (hits.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.start);
    out += `[REDACTED:${hit.pattern}]`;
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return out;
}
