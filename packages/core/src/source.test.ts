/**
 * Source redaction policy — Foundation Task 6.
 *
 * A source node may carry `meta.sourcePolicy` controlling how its on-disk text is surfaced and
 * indexed. The two redaction modes keep the graph useful (keys/searchable structure survive) while
 * guaranteeing a secret VALUE can never be returned by `rehydrate`/`rehydrateBody` nor matched by
 * the FTS body. `deny` blocks the disk read entirely (encrypted/secure property files + key/trust
 * stores): nothing is surfaced or indexed. These tests assert the guarantee end-to-end.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  redactMuleSecretAttributes,
  redactPropertyText,
  rehydrate,
  rehydrateBody,
  sourcePolicy,
} from './source.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-src-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function node(
  file: string,
  span: { start: number; end: number },
  meta: Record<string, unknown>,
): Node {
  return {
    id: idFor({ kind: 'file', path: file }),
    kind: 'file',
    file,
    span,
    hash: contentHash(file),
    meta,
  };
}

describe('source redaction — pure helpers', () => {
  it('sourcePolicy reads meta.sourcePolicy and falls back to type=property', () => {
    expect(sourcePolicy(node('a.properties', { start: 1, end: 1 }, { sourcePolicy: 'deny' }))).toBe(
      'deny',
    );
    expect(
      sourcePolicy(
        node('a.properties', { start: 1, end: 1 }, { sourcePolicy: 'redact-properties' }),
      ),
    ).toBe('redact-properties');
    expect(
      sourcePolicy(node('a.xml', { start: 1, end: 1 }, { sourcePolicy: 'redact-mule-secrets' })),
    ).toBe('redact-mule-secrets');
    expect(sourcePolicy(node('a.ts', { start: 1, end: 1 }, {}))).toBe('allow');
    expect(sourcePolicy(undefined)).toBe('allow');
  });

  it('redactPropertyText keeps keys + comments, redacts every value', () => {
    const text = [
      '# a comment',
      '! a bang comment',
      'db.user=alice',
      'db.password=swordfish',
      'blank.line',
    ].join('\n');
    const out = redactPropertyText(text).split('\n');
    expect(out).toEqual(['db.user=<redacted>', 'db.password=<redacted>', 'blank.line=<redacted>']);
    // comments are dropped entirely (never indexed)
    expect(out.join('\n')).not.toContain('comment');
    expect(out.join('\n')).not.toContain('swordfish');
    expect(out.join('\n')).not.toContain('alice');
  });

  it('redactMuleSecretAttributes redacts secret values but keeps placeholder references', () => {
    const text = '<http:request password="xml-canary" token="${api.token}" path="/x"/>';
    const out = redactMuleSecretAttributes(text);
    expect(out).not.toContain('xml-canary'); // secret VALUE gone
    expect(out).toContain('${api.token}'); // placeholder key kept (searchable)
    expect(out).toContain('path="/x"'); // non-secret attribute untouched
  });
});

describe('source redaction — rehydrate / rehydrateBody', () => {
  it('renders property keys but never values', () => {
    writeFileSync(join(root, 'secure.properties'), 'db.user=alice\ndb.password=swordfish');
    const n = node(
      'secure.properties',
      { start: 1, end: 2 },
      { sourcePolicy: 'redact-properties' },
    );
    expect(rehydrateBody(root, n).text).toBe('db.user=<redacted>\ndb.password=<redacted>');
    expect(rehydrate(root, n)).toBe('db.user=<redacted>');
  });

  it('redacts Mule XML secret attributes while keeping placeholder keys', () => {
    writeFileSync(
      join(root, 'http.xml'),
      '<http:request password="xml-canary" token="${api.token}"/>',
    );
    const n = node('http.xml', { start: 1, end: 1 }, { sourcePolicy: 'redact-mule-secrets' });
    const body = rehydrateBody(root, n).text;
    expect(body).not.toContain('xml-canary');
    expect(body).toContain('${api.token}');
    // the first-line snippet must also be redacted
    expect(rehydrate(root, n)).not.toContain('xml-canary');
  });

  it('deny blocks the disk read entirely — empty text, never the secret', () => {
    writeFileSync(join(root, 'secure-keystore.jks'), 'RAW-KEYSTORE-BYTES-SECRET');
    const n = node('secure-keystore.jks', { start: 1, end: 1 }, { sourcePolicy: 'deny' });
    expect(rehydrateBody(root, n).text).toBe('');
    expect(rehydrate(root, n)).toBe('');
  });
});

/**
 * The `type: 'property'` heuristic vs the explicit `meta.valueRedacted` signal.
 *
 * A config extractor (MuleExtractor) stamps `meta.valueRedacted = true` on every property key whose
 * value must never be surfaced. TypeScriptExtractor independently gives every class FIELD
 * `type: 'property'` — so inferring redaction from `type` alone ran key=value redaction over
 * ordinary TypeScript, corrupting both surfaced snippets and the FTS body that makes those symbols
 * searchable. These tests pin both directions: real config values stay redacted, TS fields do not.
 */
describe('source redaction — property redaction is driven by the explicit signal', () => {
  function symbol(file: string, type: string, meta: Record<string, unknown> = {}): Node {
    return {
      id: idFor({ kind: 'symbol', path: file, qualifiedName: 'X.y', startLine: 1 }),
      kind: 'symbol',
      type,
      name: 'y',
      qualifiedName: 'X.y',
      file,
      span: { start: 1, end: 1 },
      hash: contentHash(`${file}#X.y`),
      meta,
    } as Node;
  }

  it('a config property flagged valueRedacted still hides its value', () => {
    writeFileSync(join(root, 'app.properties'), 'db.password=swordfish');
    const n = symbol('app.properties', 'property', { valueRedacted: true });
    expect(sourcePolicy(n)).toBe('redact-properties');
    const snippet = rehydrate(root, n);
    expect(snippet).not.toContain('swordfish');
    expect(snippet).toContain('<redacted>');
  });

  it('an unflagged TypeScript class field is surfaced verbatim, not mangled as key=value', () => {
    writeFileSync(join(root, 'store.ts'), '  private importanceCache = new Map();');
    const n = symbol('store.ts', 'property');
    expect(sourcePolicy(n)).toBe('allow');
    expect(rehydrate(root, n)).toBe('private importanceCache = new Map();');
  });

  it('an explicit meta.sourcePolicy still wins over any inference', () => {
    writeFileSync(join(root, 'store.ts'), 'const token = "canary";');
    const n = symbol('store.ts', 'property', { sourcePolicy: 'deny' });
    expect(sourcePolicy(n)).toBe('deny');
    expect(rehydrate(root, n)).toBe('');
  });
});
