/**
 * ADR-003 (Gate 4) D6 — the {@link SyncObjectStore} port: memory stays pure and the driver is
 * injected (mirroring `MemorySoulPort`). v1 backends:
 *
 *   - `file` — a user-owned directory / mounted volume. `putObject` is temp→rename atomic; keys map
 *     to relative paths (posix separators) under the root.
 *   - `http` — a GENERIC blob contract: PUT/GET/DELETE per key + `GET <base>?list&prefix=` returning
 *     `{ keys, nextAfter }`. S3/R2 ListObjectsV2 and WebDAV PROPFIND map onto it; sigv4 in-process
 *     signing is a deferred follow-on (a user-side proxy covers day one, per D6). Credentials are
 *     read at CALL time from `process.env[authEnvName]` as the raw `Authorization` header value —
 *     never stored, never logged.
 *
 * `git-shard` is deliberately deferred (D6): it must run plaintext to stay PR-reviewable, which is
 * its own admission class through the filter and the merge driver.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** The probe result: reachability + writability of the backend, with a human-readable detail. */
export interface ProbeResult {
  ok: boolean;
  backend: 'file' | 'http';
  message?: string;
}

/** The remote object-store port (D6). Every method is idempotent unless noted; keys are opaque
 *  relative paths (`ev/<hex>`, `b/<batchId>.json`, `manifest.json`). */
export interface SyncObjectStore {
  kind: 'file' | 'http';
  probe(): Promise<ProbeResult>;
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | undefined>;
  listObjects(
    prefix: string,
    opts?: { after?: string; limit?: number },
  ): Promise<{ keys: string[]; nextAfter?: string }>;
  deleteObject(key: string): Promise<void>;
}

/** Thrown on a backend error (transport/status). Never carries credential material. */
export class SyncObjectStoreError extends Error {
  constructor(
    readonly op: string,
    readonly key: string,
    readonly status: number,
    message: string,
  ) {
    super(`${op} ${key} failed with ${status}: ${message}`);
    this.name = 'SyncObjectStoreError';
  }
}

// ─── the file backend ─────────────────────────────────────────────────────────

/**
 * A user-owned directory (or mounted volume). `putObject` writes `<key>.tmp` and renames over the
 * target (atomic on local filesystems); `listObjects` walks the root recursively, returns
 * posix-style relative keys sorted, and pages lexically via `after` (the same ordering the sorting
 * produces, so paging is stable across calls).
 */
export class FileSyncObjectStore implements SyncObjectStore {
  readonly kind = 'file' as const;

  constructor(private readonly rootDir: string) {}

  async probe(): Promise<ProbeResult> {
    const probePath = `${this.rootDir}/.sync-probe`;
    try {
      mkdirSync(this.rootDir, { recursive: true });
      writeFileSync(probePath, 'probe', 'utf8');
      rmSync(probePath, { force: true });
      return { ok: true, backend: 'file', message: `writable ${this.rootDir}` };
    } catch (err) {
      return {
        ok: false,
        backend: 'file',
        message: `not writable: ${(err as Error).message}`,
      };
    }
  }

  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    mkdirSync(dirname(this.pathFor(key)), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }

  async getObject(key: string): Promise<Uint8Array | undefined> {
    const target = this.pathFor(key);
    try {
      if (statSync(target).isFile()) return new Uint8Array(readFileSync(target));
    } catch {
      return undefined; // absent — the caller's contract for "not there yet"
    }
    return undefined;
  }

  async listObjects(
    prefix: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<{ keys: string[]; nextAfter?: string }> {
    const keys: string[] = [];
    this.walk(this.rootDir, '', keys);
    keys.sort();
    const after = opts.after ?? '';
    const filtered = keys.filter((k) => k.startsWith(prefix) && k > after);
    if (opts.limit !== undefined && filtered.length > opts.limit) {
      const page = filtered.slice(0, opts.limit);
      const nextAfter = page[page.length - 1];
      return { keys: page, ...(nextAfter !== undefined ? { nextAfter } : {}) };
    }
    return { keys: filtered };
  }

  async deleteObject(key: string): Promise<void> {
    rmSync(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    // join() normalizes; a leading '/' would escape the root, so strip it defensively. A `..`
    // segment anywhere in the key would TOO (join keeps it and resolves it against the root), so
    // the resolved target must stay inside the root — fail closed, never write outside the store.
    const target = resolve(join(this.rootDir, key.replace(/^\/+/, '')));
    if (!target.startsWith(resolve(this.rootDir) + sep)) {
      throw new Error(`object key escapes the backend root: ${key}`);
    }
    return target;
  }

  /** Depth-first walk collecting every FILE as a posix-style relative key (sorted by readdir + the
   *  final sort in listObjects). Missing root → no keys. */
  private walk(dir: string, rel: string, keys: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return; // absent root = empty listing, not an error
    }
    for (const name of entries) {
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) this.walk(full, relPath, keys);
      else keys.push(relPath);
    }
  }
}

// ─── the http backend ─────────────────────────────────────────────────────────

/** Trim the trailing slash so key joins never double-slash. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/** Read the auth header value at CALL time (D6/D7): never stored on the instance, never logged. */
function authHeader(envName: string | undefined): Record<string, string> {
  if (envName === undefined) return {};
  const value = process.env[envName];
  return value !== undefined && value.length > 0 ? { Authorization: value } : {};
}

/**
 * A generic blob HTTP backend. Contract (D6):
 *   - `PUT   <base>/<key>`  (octet-stream; any 2xx = stored)
 *   - `GET   <base>/<key>`  (404 = absent; any 2xx = bytes; else error)
 *   - `GET   <base>?list&prefix=<p>` → JSON `{ keys: string[], nextAfter?: string }`
 *   - `DELETE <base>/<key>` (404 treated as success — deletes are idempotent)
 *   - `probe` = `GET <base>` returning any non-5xx
 *
 * No sigv4 (D6: a user-side proxy covers day one). The `Authorization` header value is read from
 * `process.env[authEnvName]` at call time and is NEVER echoed in an error.
 */
export class HttpSyncObjectStore implements SyncObjectStore {
  readonly kind = 'http' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly opts: { authEnvName?: string } = {},
  ) {}

  async probe(): Promise<ProbeResult> {
    try {
      const res = await fetch(normalizeBase(this.baseUrl), { headers: this.headers() });
      return res.status < 500
        ? { ok: true, backend: 'http', message: `reachable (${res.status})` }
        : {
            ok: false,
            backend: 'http',
            message: `storage host unhealthy (${res.status})`,
          };
    } catch (err) {
      return { ok: false, backend: 'http', message: `unreachable: ${(err as Error).message}` };
    }
  }

  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    const res = await fetch(this.urlFor(key), {
      method: 'PUT',
      body: Buffer.from(bytes),
      headers: { 'content-type': 'application/octet-stream', ...this.headers() },
    });
    if (!res.ok) {
      throw new SyncObjectStoreError('PUT', key, res.status, await statusText(res));
    }
  }

  async getObject(key: string): Promise<Uint8Array | undefined> {
    const res = await fetch(this.urlFor(key), { headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new SyncObjectStoreError('GET', key, res.status, await statusText(res));
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async listObjects(
    prefix: string,
    _opts: { after?: string; limit?: number } = {},
  ): Promise<{ keys: string[]; nextAfter?: string }> {
    const url = `${normalizeBase(this.baseUrl)}?list&prefix=${encodeURIComponent(prefix)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new SyncObjectStoreError('LIST', prefix, res.status, await statusText(res));
    }
    const parsed = (await res.json()) as { keys?: unknown; nextAfter?: unknown };
    if (!Array.isArray(parsed.keys) || parsed.keys.some((k) => typeof k !== 'string')) {
      throw new SyncObjectStoreError(
        'LIST',
        prefix,
        res.status,
        'list response must carry keys: string[]',
      );
    }
    const out: { keys: string[]; nextAfter?: string } = { keys: parsed.keys as string[] };
    if (typeof parsed.nextAfter === 'string') out.nextAfter = parsed.nextAfter;
    return out;
  }

  async deleteObject(key: string): Promise<void> {
    const res = await fetch(this.urlFor(key), { method: 'DELETE', headers: this.headers() });
    if (!res.ok && res.status !== 404) {
      throw new SyncObjectStoreError('DELETE', key, res.status, await statusText(res));
    }
  }

  private headers(): Record<string, string> {
    return authHeader(this.opts.authEnvName);
  }

  private urlFor(key: string): string {
    return `${normalizeBase(this.baseUrl)}/${key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')}`;
  }
}

/** The response body as a bounded status detail (never the auth header). */
async function statusText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || res.statusText;
}
