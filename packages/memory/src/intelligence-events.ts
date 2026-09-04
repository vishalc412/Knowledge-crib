import { createHash } from 'node:crypto';
/**
 * The shared intelligence event plane.
 *
 * This journal is deliberately separate from memory claims: a claim is an enduring, evidence-led
 * belief, while an intelligence event is an immutable statement that something happened. Projectors
 * can replay this journal into claims, freshness state, code indexes, or an operational UI without
 * changing the content address or history of existing memory-1/2 records.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryNamespace, MemorySensitivity } from './types.js';

/** The event families shared by memory, code intelligence, sync, and client integrations. */
export type IntelligenceEventKind =
  | 'agent.lifecycle'
  | 'memory.observed'
  | 'file.changed'
  | 'git.transition'
  | 'sync.applied'
  | 'connector.updated';

/**
 * Server-resolved ownership context. Client/vendor agent IDs belong in source provenance; they
 * cannot become an authorization boundary. An agent profile is a durable preference/working-style
 * namespace associated with a principal, not a credential.
 */
export type IdentityContext = MemoryNamespace;

/**
 * Resolve ownership from the hosting process, never from an MCP request. This keeps vendor/client
 * IDs in provenance and makes the namespace an authorization-ready server-side decision. Hosts
 * may leave optional scopes unset during local-only use; blank values are intentionally ignored.
 */
export function resolveServerIdentity(env: NodeJS.ProcessEnv): IdentityContext {
  const value = (key: keyof NodeJS.ProcessEnv): string | undefined => {
    const raw = env[key];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  };
  return {
    principalId: value('KCRIB_PRINCIPAL_ID') ?? 'principal:local',
    ...(value('KCRIB_WORKSPACE_ID') ? { workspaceId: value('KCRIB_WORKSPACE_ID') } : {}),
    ...(value('KCRIB_PROJECT_ID') ? { projectId: value('KCRIB_PROJECT_ID') } : {}),
    ...(value('KCRIB_AGENT_PROFILE_ID') ? { agentProfileId: value('KCRIB_AGENT_PROFILE_ID') } : {}),
  };
}

/** Where an event came from; offsets make client retries deterministic. */
export interface IntelligenceEventSource {
  clientId: string;
  sessionId?: string;
  eventOffset?: number;
}

/** Retention governs the live view; the append-only audit journal is never rewritten. */
export interface IntelligenceEventRetention {
  expiresAfterDays: number;
  pinned: boolean;
}

/** The append-only, replayable event envelope. */
export interface IntelligenceEventV1 {
  id: string;
  schemaVersion: '1';
  kind: IntelligenceEventKind;
  idempotencyKey: string;
  source: IntelligenceEventSource;
  identity: IdentityContext;
  payload?: Record<string, unknown>;
  evidenceRefs: string[];
  sensitivity?: MemorySensitivity;
  retention: IntelligenceEventRetention;
  occurredAt: string;
  recordedAt: string;
}

export interface AppendIntelligenceEventInput {
  kind: IntelligenceEventKind;
  idempotencyKey: string;
  source: IntelligenceEventSource;
  identity: IdentityContext;
  payload?: Record<string, unknown>;
  evidenceRefs?: readonly string[];
  sensitivity?: MemorySensitivity;
  retention?: Partial<IntelligenceEventRetention>;
  occurredAt: string;
}

export interface IntelligenceEventJournalOptions {
  rootDir: string;
  now?: () => string;
}

export interface ReadIntelligenceEventsOptions {
  /** ISO-8601 time used to calculate the live retention view. Defaults to the journal clock. */
  now?: string;
  /** Include expired entries for audit/export/replay. Defaults to false. */
  includeExpired?: boolean;
}

/** Safe default for structured, replayable operational events. */
export const DEFAULT_EVENT_RETENTION_DAYS = 30;

const EVENT_LOG = 'intelligence-events.jsonl';
const FORBIDDEN_PAYLOAD_KEY =
  /(?:^|[_-])(?:full[_-]?)?transcript$|chain[_-]?of[_-]?thought|raw[_-]?command[_-]?output|claim(?:[_-]?(?:body|text))?$|(?:api[_-]?)?key|secret|token|password/i;

/** Explicit write/read error — malformed persisted journal data must not be silently invented. */
export class IntelligenceEventJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntelligenceEventJournalError';
  }
}

/**
 * Local, append-only JSONL event journal. One complete line is one committed event, so an
 * interrupted append can only leave an incomplete final line; all earlier history remains usable.
 * A later projector can safely deduplicate on the idempotency key without changing event history.
 */
export class IntelligenceEventJournal {
  private readonly rootDir: string;
  private readonly nowFn: () => string;

  constructor(options: IntelligenceEventJournalOptions) {
    this.rootDir = options.rootDir;
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  append(input: AppendIntelligenceEventInput): { event: IntelligenceEventV1; duplicate: boolean } {
    validateInput(input);
    const existing = this.read({ includeExpired: true }).find(
      (event) => event.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { event: existing, duplicate: true };

    const retention: IntelligenceEventRetention = {
      expiresAfterDays: input.retention?.expiresAfterDays ?? DEFAULT_EVENT_RETENTION_DAYS,
      pinned: input.retention?.pinned ?? false,
    };
    if (!Number.isInteger(retention.expiresAfterDays) || retention.expiresAfterDays < 0) {
      throw new IntelligenceEventJournalError(
        'retention.expiresAfterDays must be a non-negative integer',
      );
    }
    const payload = input.payload === undefined ? undefined : sanitizePayload(input.payload);
    const event: IntelligenceEventV1 = {
      id: eventId(input),
      schemaVersion: '1',
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      source: { ...input.source },
      identity: { ...input.identity },
      ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
      evidenceRefs: [...(input.evidenceRefs ?? [])],
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      retention,
      occurredAt: input.occurredAt,
      recordedAt: this.nowFn(),
    };
    mkdirSync(this.rootDir, { recursive: true });
    appendFileSync(this.path(), `${JSON.stringify(event)}\n`, 'utf8');
    return { event, duplicate: false };
  }

  read(options: ReadIntelligenceEventsOptions = {}): IntelligenceEventV1[] {
    const now = options.now ?? this.nowFn();
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new IntelligenceEventJournalError('read now must be ISO-8601');
    return this.readAll().filter((event) => options.includeExpired || !isExpired(event, nowMs));
  }

  private path(): string {
    return join(this.rootDir, EVENT_LOG);
  }

  private readAll(): IntelligenceEventV1[] {
    if (!existsSync(this.path())) return [];
    const lines = readFileSync(this.path(), 'utf8').split('\n');
    const events: IntelligenceEventV1[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        assertStoredEvent(parsed);
        events.push(parsed);
      } catch (error) {
        // Only an incomplete trailing write is recoverable. Any earlier malformed line is evidence
        // of journal corruption and must surface to the operator rather than silently losing events.
        if (index === lines.length - 1 && !readFileSync(this.path(), 'utf8').endsWith('\n')) break;
        const message = error instanceof Error ? error.message : String(error);
        throw new IntelligenceEventJournalError(
          `invalid intelligence event at line ${index + 1}: ${message}`,
        );
      }
    }
    return events;
  }
}

function validateInput(input: AppendIntelligenceEventInput): void {
  if (input.idempotencyKey.trim().length === 0) {
    throw new IntelligenceEventJournalError('idempotencyKey is required');
  }
  if (input.source.clientId.trim().length === 0) {
    throw new IntelligenceEventJournalError('source.clientId is required');
  }
  if (input.identity.principalId.trim().length === 0) {
    throw new IntelligenceEventJournalError('identity.principalId is required');
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) {
    throw new IntelligenceEventJournalError('occurredAt must be ISO-8601');
  }
}

function eventId(input: AppendIntelligenceEventInput): string {
  const stable = JSON.stringify({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    principalId: input.identity.principalId,
  });
  return `iev:${createHash('sha256').update(stable).digest('hex')}`;
}

function sanitizePayload(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeValue(value);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map(sanitizeValue).filter((item) => item !== undefined);
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) continue;
    const child = sanitizeValue(value[key]);
    if (child !== undefined) out[key] = child;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExpired(event: IntelligenceEventV1, nowMs: number): boolean {
  if (event.retention.pinned) return false;
  const occurredAt = Date.parse(event.occurredAt);
  return (
    Number.isNaN(occurredAt) || occurredAt + event.retention.expiresAfterDays * 86_400_000 <= nowMs
  );
}

function assertStoredEvent(value: unknown): asserts value is IntelligenceEventV1 {
  if (!isPlainObject(value) || value.schemaVersion !== '1' || typeof value.id !== 'string') {
    throw new Error('unsupported event envelope');
  }
  if (typeof value.idempotencyKey !== 'string' || !isPlainObject(value.identity)) {
    throw new Error('missing event identity');
  }
  if (typeof value.identity.principalId !== 'string' || !isPlainObject(value.retention)) {
    throw new Error('missing principal or retention policy');
  }
  if (
    typeof value.retention.expiresAfterDays !== 'number' ||
    typeof value.retention.pinned !== 'boolean' ||
    typeof value.occurredAt !== 'string' ||
    typeof value.recordedAt !== 'string'
  ) {
    throw new Error('invalid event retention or timestamps');
  }
}
