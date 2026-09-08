import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import type { ReaderFreshness } from '@knowledge-crib/mcp';
import {
  type AuditResult,
  DEFAULT_LEDGER_PAGE,
  DEFAULT_PENDING_PAGE,
  type GetResult,
  type IntakeCheckpoint,
  type IntakeRequirement,
  LEDGER_GROUPS,
  type LedgerGroup,
  type LedgerResult,
  MAX_LEDGER_PAGE,
  MAX_PENDING_PAGE,
  type MemoryApi,
  type PendingQueueResult,
  type ResumeBrief,
} from '@knowledge-crib/memory';

const MAX_SOURCE_LINES = 200;
const MAX_SOURCE_CHARS = 64 * 1024;

/**
 * Loopback hosts the viz server is allowed to serve. The server binds to
 * 127.0.0.1, so any request whose Host header is not a loopback variant is a
 * DNS-rebinding attempt (an attacker-controlled domain that resolves to
 * 127.0.0.1, letting a victim browser reach the local server "cross-origin")
 * and must be rejected before any source or asset is read.
 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Strip the port from a Host header, handling bracketed IPv6, then allowlist-check. */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  let h = host.toLowerCase();
  if (h.startsWith('[')) {
    // bracketed IPv6: [::1] or [::1]:port
    const end = h.indexOf(']');
    if (end === -1) return false;
    h = h.slice(0, end + 1);
  } else {
    // host or host:port — split on the last ':' only when it is not the only token
    const colon = h.lastIndexOf(':');
    if (colon > 0) h = h.slice(0, colon);
  }
  return ALLOWED_HOSTS.has(h);
}

export class VizHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface VizSourceResponse {
  nodeId: string;
  file: string;
  span: { start: number; end: number };
  excerpt: { start: number; end: number; text: string; truncated: boolean };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Read source only through an indexed node id. Raw client paths are never accepted. */
export async function readVizNodeSource(
  soul: SoulStore,
  repoRoot: string,
  nodeId: string,
): Promise<VizSourceResponse> {
  const node = soul.getNode(nodeId);
  if (!node) throw new VizHttpError(404, `unknown node: ${nodeId}`);
  if (!node.file || !node.span)
    throw new VizHttpError(422, `source location unavailable: ${nodeId}`);

  let rootReal: string;
  let sourceReal: string;
  try {
    rootReal = await realpath(repoRoot);
    sourceReal = await realpath(resolve(rootReal, node.file));
  } catch {
    throw new VizHttpError(404, `source file not found: ${node.file}`);
  }
  if (!isInside(rootReal, sourceReal)) {
    throw new VizHttpError(403, 'source path escapes repository root');
  }

  const source = await readFile(sourceReal, 'utf8');
  const lines = source.split(/\r?\n/);
  const requestedStart = Math.max(1, Math.trunc(node.span.start));
  const requestedEnd = Math.max(requestedStart, Math.trunc(node.span.end));
  const start = Math.min(requestedStart, Math.max(1, lines.length));
  const lineCappedEnd = Math.min(requestedEnd, start + MAX_SOURCE_LINES - 1, lines.length);
  let text = lines.slice(start - 1, lineCappedEnd).join('\n');
  let truncated = lineCappedEnd < requestedEnd;
  if (text.length > MAX_SOURCE_CHARS) {
    text = text.slice(0, MAX_SOURCE_CHARS);
    truncated = true;
  }

  return {
    nodeId,
    file: node.file,
    span: { ...node.span },
    excerpt: { start, end: lineCappedEnd, text, truncated },
  };
}

/** Resolve static viz assets with traversal and symlink containment checks. */
export async function resolveVizAsset(assetsRoot: string, pathname: string): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new VizHttpError(400, 'malformed asset path');
  }
  const rel = decoded.replace(/^\/+/, '') || 'index.html';
  let rootReal: string;
  let assetReal: string;
  try {
    rootReal = await realpath(assetsRoot);
    assetReal = await realpath(resolve(rootReal, rel));
  } catch {
    throw new VizHttpError(404, 'asset not found');
  }
  if (!isInside(rootReal, assetReal)) throw new VizHttpError(403, 'asset path escapes viz root');
  return assetReal;
}

// ─── memory ledger endpoints (G5.4) ──────────────────────────────────────────
//
// The ledger view is a READ-ONLY projection the viz server exposes so the UI can inspect the
// memory ledger next to the code graph. It owns NO projections of its own: every field comes from
// the same {@link MemoryApi} ops the MCP verbs and CLI subcommands use (`ledger`, `get`, `audit`),
// so the UI can never drift from backend truth. The server's only jobs are query validation,
// pagination capping, and the honest `configured: false` shape when a repo has no memory stores.

/** The validated ledger query — the ONLY params `/memory.json` accepts. */
export interface VizLedgerQuery {
  offset: number;
  limit: number;
  group?: LedgerGroup;
}

/**
 * Parse and cap the ledger query. Bad values fail with 400 (never silently clamped — a typo'd
 * `group=stael` should be visible, not mistaken for an empty ledger); `limit` is hard-capped at
 * {@link MAX_LEDGER_PAGE} so a browser request cannot inflate the payload.
 */
export function parseMemoryLedgerQuery(params: URLSearchParams): VizLedgerQuery {
  const parseCount = (name: string, raw: string | null): number => {
    if (raw === null) return name === 'offset' ? 0 : DEFAULT_LEDGER_PAGE;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new VizHttpError(400, `invalid ${name}: ${raw}`);
    return n;
  };
  let group: LedgerGroup | undefined;
  const rawGroup = params.get('group');
  if (rawGroup !== null) {
    if (!(LEDGER_GROUPS as readonly string[]).includes(rawGroup)) {
      throw new VizHttpError(400, `unknown group: ${rawGroup}`);
    }
    group = rawGroup as LedgerGroup;
  }
  return {
    offset: parseCount('offset', params.get('offset')),
    limit: Math.min(MAX_LEDGER_PAGE, parseCount('limit', params.get('limit'))),
    ...(group !== undefined ? { group } : {}),
  };
}

/** The `/memory.json` body: the paginated ledger, or the not-wired shape a fresh repo gets. */
export type VizLedgerResponse = LedgerResult | { configured: false };

/** Serve the ledger through the API's own projection (no memory wired → honest empty shape). */
export function readMemoryLedger(
  api: MemoryApi | undefined,
  query: VizLedgerQuery,
): VizLedgerResponse {
  if (!api) return { configured: false };
  return api.ledger(query);
}

export interface VizMemoryHomeOperations {
  retrieval?: {
    mode: 'on-device-semantic' | 'lexical-fallback';
    modelId?: string;
    reason?: string;
  };
  capture?: { lastSuccessfulAt?: string; pending?: number; dead?: number };
  codeIndex?: { lastSuccessfulAt?: string; behindHead?: boolean; workerRunning?: boolean };
  sync?: { configured: boolean; lastSuccessfulAt?: string; pending?: number; dead?: number };
  /** WP4.7 — this viz process's reader freshness (cold shape: the viz server has no refresh loop). */
  readerFreshness?: ReaderFreshness;
}

/**
 * The memory home is the session-facing projection over the same API that powers the ledger.
 * It intentionally returns counts plus small preview lists; full history and record detail stay on
 * their paginated endpoints.
 */
export function readMemoryHome(
  api: MemoryApi | undefined,
  health: VizMemoryHomeOperations,
  repository: { head?: string; branch?: string; dirty: boolean; dirtyPathsDigest?: string } = {
    dirty: false,
  },
) {
  if (!api) {
    return {
      configured: false as const,
      nextAction: 'Run `crib memory init` to configure memory for this repository.',
    };
  }
  const handoff = api.handoff({
    repository,
    limits: { openWork: 10, pending: 10, attention: 10, recent: 10 },
  });
  const ledger = api.ledger({ offset: 0, limit: 1 });
  // Resumable only: `count` is the full history including completed and cancelled intakes, and a
  // "work to resume" tile that counts finished work is simply lying to the operator.
  const resumeCount = handoff.counts.openWork + handoff.intakes.resumableCount;
  const nextAction = handoff.intakes.primary?.nextSafeAction
    ? handoff.intakes.primary.nextSafeAction
    : handoff.counts.pendingCaptures > 0
      ? 'Run `crib memory distill --provider <name>` to review pending outcomes.'
      : handoff.counts.needsAttention > 0
        ? 'Open Needs review and inspect the evidence or supersede the stale claim.'
        : 'Capture a structured outcome at the end of meaningful work so another agent can resume.';
  return {
    configured: true as const,
    sections: {
      active: { count: handoff.counts.active, preview: handoff.recent },
      pending: { count: handoff.counts.pendingCaptures, preview: handoff.pendingCaptures },
      needsReview: { count: handoff.counts.needsAttention, preview: handoff.needsAttention },
      history: { count: ledger.total, groups: ledger.counts },
      resume: {
        count: resumeCount,
        primary: handoff.intakes.primary,
        choices: handoff.intakes.choices,
        openWork: handoff.openWork,
      },
    },
    health,
    // WP3.8 — an unreadable journal must not read as "no previous work existed". The home view
    // reports the marker so the operator sees the read failed, rather than trusting an empty page.
    degraded: handoff.degraded,
    nextAction,
  };
}

/** The `/memory/record.json` body: the full `get` projection plus the record's audit trail. */
export type VizLedgerDetailResponse = GetResult & { audit: AuditResult };

/**
 * Lazy per-record detail: the full claim, validity window, lineage, evidence and decision
 * transitions — composed from the API's own `get` + `audit` ops. Unknown id → 404, mirroring
 * `/source`'s unknown-node behavior.
 */
export function readMemoryLedgerDetail(api: MemoryApi, id: string): VizLedgerDetailResponse {
  const got = api.get(id);
  if (!got.found) throw new VizHttpError(404, `unknown memory record: ${id}`);
  return { ...got, audit: api.audit(got.id ?? id) };
}

// ─── pending queue + intake detail endpoints (WP6.1–WP6.4) ─────────────────────
//
// The same law as the ledger endpoints above: the server owns ONLY query validation, pagination
// capping, and the honest `configured: false` shape. Every row, classification, and command string
// comes from the MemoryApi's own `pending`/`getIntake`/`listIntakes` ops, so the UI can never drift
// from backend truth — and the browser never gains a capability the CLI admission paths do not
// have (the terminal-only paths stay terminal-only; the projection says so, the server never
// routes around it).

/** The validated pending-queue query — the ONLY params `/memory/pending.json` accepts. */
export interface VizPendingQuery {
  section?: 'captures' | 'staged';
  offset: number;
  limit: number;
}

/** The `/memory/pending.json` body: the classified queue, or the not-wired shape. */
export type VizPendingResponse = PendingQueueResult | { configured: false };

/**
 * Parse and cap the pending-queue query, with the ledger's own discipline: bad values fail with
 * 400 (a typo'd `section=stagged` must be visible, not mistaken for an empty queue) and `limit`
 * is hard-capped at {@link MAX_PENDING_PAGE} so a browser request cannot inflate the payload.
 */
export function parseMemoryPendingQuery(params: URLSearchParams): VizPendingQuery {
  const parseCount = (name: string, raw: string | null): number => {
    if (raw === null) return name === 'offset' ? 0 : DEFAULT_PENDING_PAGE;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new VizHttpError(400, `invalid ${name}: ${raw}`);
    return n;
  };
  let section: VizPendingQuery['section'];
  const rawSection = params.get('section');
  if (rawSection !== null) {
    if (rawSection !== 'captures' && rawSection !== 'staged') {
      throw new VizHttpError(400, `unknown section: ${rawSection}`);
    }
    section = rawSection;
  }
  return {
    offset: parseCount('offset', params.get('offset')),
    limit: Math.min(MAX_PENDING_PAGE, parseCount('limit', params.get('limit'))),
    ...(section !== undefined ? { section } : {}),
  };
}

/** Serve the pending queue through the API's own projection (no memory wired → honest empty shape). */
export function readMemoryPending(
  api: MemoryApi | undefined,
  query: VizPendingQuery,
): VizPendingResponse {
  if (!api) return { configured: false };
  return api.pending(query);
}

/** The `/memory/intake.json` body: the requirement, its checkpoint history, and the resume brief. */
export interface VizIntakeDetailResponse {
  requirement: IntakeRequirement;
  checkpoints: IntakeCheckpoint[];
  /** the projection's own folded state (phase/status/blockers/drift) — never re-derived here. */
  brief: ResumeBrief;
  /** false for `completed`/`cancelled` — the UI offers resume actions ONLY when this is true. */
  resumable: boolean;
}

/**
 * WP6.4 — intake detail: the durable requirement plus its full checkpoint history, with the
 * projection's own folded brief so the surface can show WHY a memory is missing (blockers) and
 * what drift happened, without executing any of the work. Unknown id → 404, mirroring
 * `/memory/record.json`.
 */
export function readMemoryIntakeDetail(
  api: MemoryApi,
  intakeId: string,
  repository: IntakeCheckpoint['repository'] = { dirty: false },
): VizIntakeDetailResponse {
  const got = api.getIntake(intakeId);
  if (!got) throw new VizHttpError(404, `unknown intake: ${intakeId}`);
  const brief = api.listIntakes(repository).choices.find((c) => c.intakeId === intakeId);
  // choices is built from EVERY requirement, so a missing brief is an internal inconsistency —
  // reported loudly, never papered over with a half-empty response.
  if (!brief) throw new VizHttpError(500, `intake projection missing: ${intakeId}`);
  return {
    requirement: got.requirement,
    checkpoints: got.checkpoints,
    brief,
    resumable: brief.status !== 'completed' && brief.status !== 'cancelled',
  };
}

// ─── WP6.3/WP6.5 — the local mutation boundary ───────────────────────────────

/**
 * The header a mutation POST must present (WP6.5). A header, never a query parameter: the token
 * must not appear in URLs, logs, or browser history. The token itself is delivered same-origin by
 * `/memory/mutation-grant.json`, which a cross-origin page cannot read (no CORS headers are ever
 * sent), and the DNS-rebinding Host guard already runs before any route.
 */
export const CSRF_HEADER = 'x-crib-csrf';

/** Mutation bodies are small ids and strings; anything larger is a mistake or an abuse. */
const MAX_MUTATION_BODY_BYTES = 64 * 1024;

/** A mutation body field is an id or a one-line action — 2k is generous, 64k is a hard stop. */
const MAX_MUTATION_FIELD = 2048;

/** A structured mutation failure: on the wire it is `{error: {code, message}}`, never bare text. */
export class VizMutationError extends VizHttpError {
  constructor(
    readonly code: string,
    status: number,
    message: string,
  ) {
    super(status, message);
  }
}

/** Mint the per-server CSRF token — one per `crib viz` run, rotated when the server restarts. */
export function createCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Strict Origin validation for mutations (WP6.5): the Origin header must be exactly this server's
 * own loopback origin (derived from the Host the allowlist guard already accepted). Browsers send
 * Origin on every cross-origin POST and on same-origin fetch POSTs alike, so a missing or foreign
 * Origin is refused — a malicious page cannot drive the local API even with the token guessed.
 */
export function validateMutationOrigin(headers: {
  host: string;
  origin?: string | undefined;
}): void {
  if (headers.origin !== `http://${headers.host}`) {
    throw new VizMutationError('unauthorized', 403, 'origin not allowed');
  }
}

/** Require the per-server CSRF token on a mutation (WP6.5) — absent or wrong → 403. */
export function requireCsrfToken(token: string | undefined, expected: string): void {
  if (token === undefined || token === '') {
    throw new VizMutationError('unauthorized', 403, 'missing CSRF token');
  }
  // constant-shape failure message: the token value itself never appears in a response or log
  if (token !== expected) {
    throw new VizMutationError('unauthorized', 403, 'invalid CSRF token');
  }
}

/**
 * The minimal request-stream surface {@link readMutationBody} needs — an `IncomingMessage` in
 * production, structurally satisfied by any readable stream in tests.
 */
export interface MutationRequestStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  destroy(): unknown;
}

/** Read one bounded JSON request body: oversize → 413, non-JSON → 400 — never a silent truncation. */
export function readMutationBody(req: MutationRequestStream): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_MUTATION_BODY_BYTES) {
        settled = true;
        reject(new VizMutationError('payload-too-large', 413, 'mutation body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        reject(new VizMutationError('bad-request', 400, 'empty body'));
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch {
        reject(new VizMutationError('bad-request', 400, 'invalid JSON body'));
      }
    });
    req.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function requireString(v: unknown, field: string, opts: { allowEmpty?: boolean } = {}): string {
  const empty = v === undefined || v === null || v === '';
  if (empty && opts.allowEmpty) return '';
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_MUTATION_FIELD) {
    throw new VizMutationError('bad-request', 400, `invalid ${field}`);
  }
  return v;
}

function requireObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new VizMutationError('bad-request', 400, 'expected a JSON object');
  }
  return v as Record<string, unknown>;
}

/** The admission POST body: the content-addressed staged id (also the revision token) + gate profile. */
export interface VizAdmissionBody {
  /** `cand:<content-addressed>` — the id IS the revision precondition: content-addressed, so a
   * re-admission attempt that carries a different id is a different claim, not a stale write. */
  id: string;
  /** the gate profile the OPERATOR chose in the UI — resolved server-side, never guessed. */
  profile: string;
}

export function parseAdmissionBody(v: unknown): VizAdmissionBody {
  const o = requireObject(v);
  const id = requireString(o.id, 'id');
  if (!id.startsWith('cand:')) {
    throw new VizMutationError('bad-request', 400, 'not a staged claim id');
  }
  return { id, profile: requireString(o.profile, 'profile') };
}

/**
 * The resume POST body. `expectedCheckpointId` is the revision precondition (WP6.5): the id of the
 * latest checkpoint the surface saw. An intake that was never checkpointed has no revision token
 * yet — the surface passes the empty string for that state.
 */
export interface VizResumeBody {
  intakeId: string;
  /** what resuming MEANS — required when the intake has no recorded next action (refuse, never invent). */
  next?: string;
  expectedCheckpointId: string;
}

export function parseResumeBody(v: unknown): VizResumeBody {
  const o = requireObject(v);
  const next = requireString(o.next, 'next', { allowEmpty: true });
  return {
    intakeId: requireString(o.intakeId, 'intakeId'),
    ...(next !== '' ? { next } : {}),
    expectedCheckpointId: requireString(o.expectedCheckpointId, 'expectedCheckpointId', {
      allowEmpty: true,
    }),
  };
}

/**
 * The structured error wire shape for mutation routes (WP6.5): unauthorized / stale /
 * invalid-evidence / unavailable-service each carry a code, never just prose. Non-mutation errors
 * reaching a mutation route collapse to `internal` — the message stays, the shape never varies.
 */
export function mutationErrorPayload(e: VizHttpError): {
  error: { code: string; message: string };
} {
  return {
    error: {
      code: e instanceof VizMutationError ? e.code : 'internal',
      message: e.message,
    },
  };
}
