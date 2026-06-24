/**
 * BLAKE3 hashing, pure-JS (no native bindings) via @noble/hashes.
 * Chosen over the native `blake3` binding to honor the "zero native-binding risk" stance and keep
 * `npx knowledge-crib` portable. Audited, MIT-licensed.
 *
 * All hashes are exposed as "blake3:<hex>" strings to match the spec's on-disk form.
 */
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

/** Hex digest length we keep (32 bytes = 64 hex chars). Full digest; sharding slices a prefix. */
const DIGEST_BYTES = 32;

/** Raw 64-char hex of blake3(input), no prefix. */
export function blake3Hex(input: string): string {
  const bytes = blake3(input, { dkLen: DIGEST_BYTES });
  return bytesToHex(bytes);
}

/** Prefixed content hash: "blake3:<hex>". Stored on Node.hash. */
export function contentHash(input: string): string {
  return `blake3:${blake3Hex(input)}`;
}

/**
 * Shard key for a source path: first `digits` hex chars of blake3(path).
 * Spec: shard = blake3(sourcePath)[:shardHexDigits]; one file's records → one shard → small diffs.
 */
export function shardFor(sourcePath: string, digits = 2): string {
  return blake3Hex(sourcePath).slice(0, digits);
}

/** Short fingerprint for ids/logs (first 8 hex chars), useful for stable-but-compact labels. */
export function shortHash(input: string): string {
  return blake3Hex(input).slice(0, 8);
}
