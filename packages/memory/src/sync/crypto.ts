/**
 * ADR-003 (Gate 4) D7 — event-blob encryption: AES-256-GCM per event, one symmetric key, fail-closed
 * key resolution. No new dependencies; randomness (`randomBytes`) feeds only the per-blob nonce,
 * never an id or hash (the frozen-seed law).
 *
 * Wire shape (one blob per event, one per remote object key):
 *
 *   magic `crsy1` | nonce (12) | headerLen (u16be) | header | tag (16) | ciphertext
 *
 * The header is the canonical JSON of `{ v, alg, route }` and is the AES-GCM **AAD** — so a
 * tampered header breaks the auth tag. It travels INSIDE the blob because the tag can only bind
 * bytes the receiver can reconstruct before decrypting, and `route` is derived from the event id,
 * which is only known after decryption — the deviation from a bare `magic+nonce+tag+ciphertext`
 * layout is deliberate and is what makes "tampering with the header breaks the tag" achievable at
 * all (the ciphertext itself is still the canonical event JSON).
 *
 * Remote layout (D6): objects are routed to `ev/<hex(HMAC-SHA-256(syncKey, evtId))>` so push/pull
 * agree WITHOUT decrypting and no plaintext id/claim ever sits on the wire (a plaintext blake3 id
 * would be a claim-confirmation oracle).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { memoryHome } from '../paths.js';
import { type SyncEvent, parseSyncEvent, serializeSyncEvent } from './event.js';

/** The blob magic (`crsy1` = 5 bytes, per D7). */
export const BLOB_MAGIC = Buffer.from('crsy1', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 2;

/** Thrown when no sync key can be resolved (D7: fail closed). NEVER carries key material. */
export class SyncKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncKeyError';
  }
}

/** Thrown when a blob cannot be decrypted/authenticated. NEVER carries key material. */
export class SyncCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncCryptoError';
  }
}

// ─── key material parsing (hex | base64 → 32 bytes) ───────────────────────────

/** Decode key material in either accepted encoding (D7): 64 hex chars, or 44-char base64 — both are
 *  exactly 32 bytes. Anything else fails closed; the message names the SOURCE, never the bytes. */
function decodeSyncKeyMaterial(text: string, source: string): Buffer {
  const trimmed = text.trim();
  const asHex = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : undefined;
  const asBase64 =
    trimmed.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(trimmed)
      ? Buffer.from(trimmed, 'base64')
      : undefined;
  const key = asHex ?? asBase64;
  if (key === undefined || key.length !== 32) {
    throw new SyncKeyError(
      `${source} must be 64 hex chars or 44-char base64 (32 bytes) — refusing`,
    );
  }
  return key;
}

/** Resolve the sync key, fail closed (D7): `KCRIB_SYNC_KEY` env first (64 hex or 44-char base64),
 *  then the keyfile `<memoryHome>/sync-key` (chmod 0600 expected — a wider mode is a refusal, not a
 *  warning). No key anywhere → `SyncKeyError`. Errors name the SOURCE, never the bytes. */
export function resolveSyncKey(
  opts: {
    keyEnv?: string;
    keyFile?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): { key: Buffer; source: 'env' | 'keyfile' } {
  const envName = opts.keyEnv ?? 'KCRIB_SYNC_KEY';
  const env = opts.env ?? process.env;
  const raw = env[envName];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { key: decodeSyncKeyMaterial(raw, `env ${envName}`), source: 'env' };
  }
  const keyFile = opts.keyFile ?? join(memoryHome(env), 'sync-key');
  if (existsSync(keyFile)) {
    const mode = statSync(keyFile).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new SyncKeyError(
        `${keyFile} has mode 0${mode.toString(8)} — chmod 0600 expected; refusing to use an open keyfile`,
      );
    }
    return {
      key: decodeSyncKeyMaterial(readFileSync(keyFile, 'utf8'), keyFile),
      source: 'keyfile',
    };
  }
  throw new SyncKeyError(
    `no sync key resolved (set ${envName} or a 0600 keyfile at ${keyFile}) — sync fails closed`,
  );
}

/** Mint a fresh key: 32 random bytes as hex (`--gen-key`). Randomness never feeds an id or hash. */
export function genSyncKey(): string {
  return randomBytes(32).toString('hex');
}

/** The routing key for one event: `ev/<hex(HMAC-SHA-256(key, evtId))>` (D6). Derived from the shared
 *  key so push/pull agree WITHOUT decrypting, and no plaintext id/claim is on the wire. Deterministic. */
export function routeKeyFor(evtId: string, key: Uint8Array): string {
  return `ev/${createHmac('sha256', Buffer.from(key)).update(evtId, 'utf8').digest('hex')}`;
}

/** `blake3` over the canonical (hex) form of the key — the manifest's `keyFingerprint` (D7). */
export function keyFingerprint(key: Uint8Array): string {
  return blake3Hex(Buffer.from(key).toString('hex'));
}

/** The AAD/header bytes for one event: the canonical JSON of `{ v, alg, route }`. */
function headerFor(evtId: string, key: Uint8Array): Buffer {
  return Buffer.from(
    JSON.stringify({ v: '1', alg: 'aes-256-gcm', route: routeKeyFor(evtId, key) }),
    'utf8',
  );
}

/** Encrypt one event (D7). Fresh 12-byte random nonce per blob; AAD = the canonical plaintext
 *  header bytes, so tampering with the header breaks the auth tag. Returns the full blob. */
export function encryptEvent(evt: SyncEvent, key: Uint8Array): Uint8Array {
  const header = headerFor(evt.id, key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([
    cipher.update(serializeSyncEvent(evt), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const len = Buffer.alloc(2);
  len.writeUInt16BE(header.length, 0);
  return Buffer.concat([BLOB_MAGIC, nonce, len, header, tag, ciphertext]);
}

/** Decrypt one event blob (D7): the header is read from the blob, used as the AAD, and then
 *  re-derived from the DECRYPTED event's id — a header whose route does not match the plaintext
 *  event (or a broken auth tag, or a wrong key) throws `SyncCryptoError`. Errors never carry key
 *  material or plaintext. */
export function decryptEvent(blob: Uint8Array, key: Uint8Array): SyncEvent {
  const bytes = Buffer.from(blob);
  const min = BLOB_MAGIC.length + NONCE_BYTES + HEADER_BYTES + TAG_BYTES + 1;
  if (bytes.length < min || !bytes.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
    throw new SyncCryptoError('not a sync event blob (bad magic or truncated)');
  }
  const offset = BLOB_MAGIC.length + NONCE_BYTES;
  const headerLen = bytes.readUInt16BE(offset);
  const endHeader = offset + HEADER_BYTES + headerLen;
  if (bytes.length < endHeader + TAG_BYTES + 1) {
    throw new SyncCryptoError('not a sync event blob (truncated)');
  }
  const header = bytes.subarray(offset + HEADER_BYTES, endHeader);
  const tag = bytes.subarray(endHeader, endHeader + TAG_BYTES);
  const ciphertext = bytes.subarray(endHeader + TAG_BYTES);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key),
    bytes.subarray(BLOB_MAGIC.length, offset),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SyncCryptoError('authentication failed — wrong key or tampered blob');
  }
  const evt = parseSyncEvent(plaintext);
  // The tag already binds the header bytes; this final check pins the header to the event it wraps
  // (a re-rolled header under a DIFFERENT event id cannot decrypt to a matching route anyway).
  if (routeKeyFor(evt.id, key) !== JSON.parse(header.toString('utf8')).route) {
    throw new SyncCryptoError('header route does not match the decrypted event');
  }
  return evt;
}
