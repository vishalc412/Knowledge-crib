/**
 * D7 crypto tests: round-trip, tamper-evidence (header/AAD + wrong key), fail-closed key
 * resolution, and the routing-key derivation. Randomness is only asserted to be NON-CE-reused
 * across two encryptions (nonce never feeds an id/hash — the frozen-seed law).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryHome } from '../paths.js';
import {
  BLOB_MAGIC,
  SyncCryptoError,
  SyncKeyError,
  decryptEvent,
  encryptEvent,
  genSyncKey,
  keyFingerprint,
  resolveSyncKey,
  routeKeyFor,
} from './crypto.js';
import { KEY_HEX, eventFor, v1Record } from './sync-test-fixtures.js';

let home = '';

afterEach(() => {
  if (home !== '' && existsSync(home)) rmSync(home, { recursive: true, force: true });
  home = '';
});

describe('key resolution (D7, fail closed)', () => {
  it('accepts 64-hex env and 44-char base64 env', () => {
    expect(resolveSyncKey({ env: { KCRIB_SYNC_KEY: KEY_HEX } }).source).toBe('env');
    // 32 arbitrary bytes encoded as 44-char base64 with '=' padding
    const base64 = Buffer.from(Buffer.from(KEY_HEX, 'hex')).toString('base64');
    expect(base64).toHaveLength(44);
    expect(resolveSyncKey({ env: { KCRIB_SYNC_KEY: base64 } }).source).toBe('env');
  });

  it('rejects short/wrong-encoding env material naming the source, never the bytes', () => {
    expect(() => resolveSyncKey({ env: { KCRIB_SYNC_KEY: 'abcd' } })).toThrow(SyncKeyError);
    try {
      resolveSyncKey({ env: { KCRIB_SYNC_KEY: 'zz'.repeat(32) } });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('env KCRIB_SYNC_KEY');
      expect((err as Error).message).not.toContain('zz');
    }
  });

  it('falls back to a 0600 keyfile under the memory home', () => {
    home = mkdtempSync(join(tmpdir(), 'sync-crypto-'));
    const env = { KCRIB_MEMORY_DIR: home };
    expect(memoryHome(env)).toBe(home);
    const keyFile = join(home, 'sync-key');
    writeFileSync(keyFile, `${KEY_HEX}\n`, { mode: 0o600 });
    const resolved = resolveSyncKey({ env });
    expect(resolved.source).toBe('keyfile');
    expect(resolved.key.toString('hex')).toBe(KEY_HEX);
  });

  it('refuses an over-open keyfile (chmod 0644 is a refusal, not a warning)', () => {
    home = mkdtempSync(join(tmpdir(), 'sync-crypto-'));
    const env = { KCRIB_MEMORY_DIR: home };
    const keyFile = join(home, 'sync-key');
    writeFileSync(keyFile, KEY_HEX, { mode: 0o644 });
    expect(() => resolveSyncKey({ env })).toThrow(/0600/);
    // an explicit keyFile path is checked the same way
    expect(() => resolveSyncKey({ keyFile, env })).toThrow(SyncKeyError);
  });

  it('throws SyncKeyError when no key exists anywhere', () => {
    home = mkdtempSync(join(tmpdir(), 'sync-crypto-'));
    expect(() => resolveSyncKey({ env: { KCRIB_MEMORY_DIR: home } })).toThrow(SyncKeyError);
  });

  it('genSyncKey mints 64-hex fresh keys', () => {
    const a = genSyncKey();
    const b = genSyncKey();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('blob encryption (D7)', () => {
  const key = Buffer.from(KEY_HEX, 'hex');
  const evt = eventFor(v1Record());

  it('round-trips', () => {
    expect(decryptEvent(encryptEvent(evt, key), key)).toEqual(evt);
  });

  it('stamps the magic + a fresh nonce per blob (plaintext never at rest)', () => {
    const blob = Buffer.from(encryptEvent(evt, key));
    expect(blob.subarray(0, BLOB_MAGIC.length).toString('utf8')).toBe('crsy1');
    const blob2 = Buffer.from(encryptEvent(evt, key));
    const n1 = blob.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + 12);
    const n2 = blob2.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + 12);
    expect(n1.equals(n2)).toBe(false);
    // neither the raw nor the canonical (key-sorted) plaintext survives in the bytes
    const text = blob.toString('utf8');
    expect(text.includes(JSON.stringify(evt))).toBe(false);
    expect(text.includes((evt.payload as { claim: string }).claim)).toBe(false);
  });

  it('fails closed on a wrong key', () => {
    const other = Buffer.from('cd'.repeat(32), 'hex');
    expect(() => decryptEvent(encryptEvent(evt, key), other)).toThrow(SyncCryptoError);
  });

  it('fails closed on a tampered header (AAD) and on a tampered ciphertext', () => {
    const blob = Buffer.from(encryptEvent(evt, key));
    const headerStart = BLOB_MAGIC.length + 12 + 2;
    const headerLen = blob.readUInt16BE(BLOB_MAGIC.length + 12);
    const tamperedHeader = Buffer.from(blob);
    const hi = headerStart + headerLen - 1;
    tamperedHeader[hi] = (tamperedHeader[hi] ?? 0) ^ 1;
    expect(() => decryptEvent(tamperedHeader, key)).toThrow(SyncCryptoError);
    const tamperedCt = Buffer.from(blob);
    const ci = tamperedCt.length - 1;
    tamperedCt[ci] = (tamperedCt[ci] ?? 0) ^ 1;
    expect(() => decryptEvent(tamperedCt, key)).toThrow(SyncCryptoError);
  });

  it('fails closed on a bad magic / truncated blob', () => {
    expect(() => decryptEvent(new Uint8Array([1, 2, 3]), key)).toThrow(SyncCryptoError);
    const blob = Buffer.from(encryptEvent(evt, key));
    expect(() => decryptEvent(blob.subarray(0, 30), key)).toThrow(SyncCryptoError);
  });
});

describe('routing + fingerprint', () => {
  const key = Buffer.from(KEY_HEX, 'hex');

  it('routeKeyFor is deterministic per (key, evtId) and differs per key', () => {
    const route = routeKeyFor('evt:abc', key);
    expect(route).toMatch(/^ev\/[0-9a-f]{64}$/);
    expect(routeKeyFor('evt:abc', key)).toBe(route);
    expect(routeKeyFor('evt:abc', Buffer.from('cd'.repeat(32), 'hex'))).not.toBe(route);
    expect(routeKeyFor('evt:def', key)).not.toBe(route);
  });

  it('keyFingerprint is stable and differs per key', () => {
    expect(keyFingerprint(key)).toBe(keyFingerprint(Buffer.from(KEY_HEX, 'hex')));
    expect(keyFingerprint(key)).not.toBe(keyFingerprint(Buffer.from('cd'.repeat(32), 'hex')));
  });

  it('routeKeyFor matches the header route embedded in the blob', () => {
    const evt = eventFor(v1Record());
    const blob = Buffer.from(encryptEvent(evt, key));
    const headerLen = blob.readUInt16BE(BLOB_MAGIC.length + 12);
    const header = JSON.parse(
      blob
        .subarray(BLOB_MAGIC.length + 12 + 2, BLOB_MAGIC.length + 12 + 2 + headerLen)
        .toString('utf8'),
    ) as { route: string; alg: string };
    expect(header.route).toBe(routeKeyFor(evt.id, key));
    expect(header.alg).toBe('aes-256-gcm');
  });
});
