import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SoulStore } from '@knowledge-crib/core';
import {
  type AuditResult,
  DEFAULT_LEDGER_PAGE,
  type GetResult,
  LEDGER_GROUPS,
  type LedgerGroup,
  type LedgerResult,
  MAX_LEDGER_PAGE,
  type MemoryApi,
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
