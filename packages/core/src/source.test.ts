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
