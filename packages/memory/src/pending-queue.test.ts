/**
 * WP6.1/WP6.2 — the pending-queue projection tests, one per contract clause:
 *
 *   - the two honest SECTIONS: raw captures (outbox pending, dead-lettered excluded) vs staged
 *     claims (admission queue) — never one blended list;
 *   - provider consent is PRESERVED structurally: a capture row carries the distill COMMAND, and
 *     nothing in the projection ever names, calls, or configures a provider;
 *   - the three-way classification reuses the evaluator's own pre-flight: `ready` (browser can
 *     complete through the same domain services as `crib memory evaluate`), `terminal` (unstamped
 *     human attestation — `tty` is minted only where a real terminal was observed), `blocked`
 *     (structural problems: missing required fields, empty evidence, pitfall combo unmet);
 *   - the pitfall cross-item combo rule (receipt-pair alone, or source-quote + attestation
 *     together) — a `ready` verdict can never disagree with the admission gate;
 *   - pagination caps, section filtering, deterministic sort, claim capping;
 *   - the Gate-0 user-facing vocabulary law: NO internal admission-vocabulary word anywhere in the
 *     serialized response — commands included (they are positional, exactly as the CLI parses).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CaptureOutboxEntry,
  type MemoryCandidate,
  type MemoryEvidence,
  type MemoryRecordKind,
  type MemoryScope,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  buildCaptureOutboxEntry,
  memoryCandidateId,
  pendingCaptures,
  projectPendingQueue,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const REPO = 'r-pending-queue';
const SCOPE: MemoryScope = { boundary: 'repo', repoId: REPO };
const SOUL_ID = 'sym:src/a.ts#A.b@L10';

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-pending-queue-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

/** A staged claim fixture — real content-addressed id, upserted through the write gate. */
function candidate(over: {
  kind?: MemoryRecordKind;
  evidence?: MemoryEvidence[];
  proposedAt?: string;
  claim?: string;
}): MemoryCandidate {
  const seed = {
    kind: over.kind ?? 'fact',
    subject: SOUL_ID,
    claim: over.claim ?? 'A.b normalizes input before hashing',
    scope: SCOPE,
    appliesTo: [SOUL_ID],
    evidence: over.evidence ?? [],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
    origin: 'observe' as const,
  };
  const c: MemoryCandidate = {
    ...seed,
    id: memoryCandidateId(seed),
    schemaVersion: '1',
    proposedAt: over.proposedAt ?? T0,
  };
  MemoryStore.local(REPO, { env, now: () => T0 }).upsertEntry('candidates', c);
  return c;
}

/** A durable capture-outbox fixture — the raw material of the `captures` section. */
function capture(
  over: { status?: 'pending' | 'done'; proposedAt?: string; claim?: string } = {},
): CaptureOutboxEntry {
  const entry = buildCaptureOutboxEntry(
    {
      kind: 'fact',
      subject: SOUL_ID,
      claim: over.claim ?? 'A.b normalizes input before hashing',
      scope: SCOPE,
      appliesTo: [SOUL_ID],
      evidence: [],
      authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
      origin: 'observe' as const,
    },
    over.proposedAt ?? T0,
  );
  if (over.status === 'done') entry.status = 'done';
  MemoryStore.local(REPO, { env, now: () => T0 }).upsertEntry('outbox', entry);
  return entry;
}

const store = () => MemoryStore.local(REPO, { env, now: () => T0 });

// ─── the sections ─────────────────────────────────────────────────────────────

describe('projectPendingQueue sections', () => {
  it('separates raw captures from staged claims and excludes done/dead outbox entries', () => {
    const pending = capture({ proposedAt: T0 });
    capture({ status: 'done', proposedAt: T0, claim: 'A.b was distilled already' });
    candidate({ evidence: [sourceQuote()] });

    const q = projectPendingQueue(store());
    expect(q.configured).toBe(true);
    expect(q.counts.captures).toBe(1);
    expect(q.counts.staged).toBe(1);
    expect(q.captures?.rows.map((r) => r.id)).toEqual([pending.id]);
    // the raw capture carries the distill COMMAND — consent stays the operator's, never the browser's
    expect(q.captures?.rows[0]?.command).toBe('crib memory distill --provider <name>');
    expect(q.captures?.rows[0]?.section).toBe('captures');
    expect(q.staged?.rows).toHaveLength(1);
    expect(q.staged?.rows[0]?.section).toBe('staged');
    // nothing in the projection names a configured provider (consent is structural, not a value)
    expect(JSON.stringify(q)).not.toMatch(/providers?\.json/);
  });

  it('dead-lettered captures never resurface as work to do (dead wins over outbox)', () => {
    const entry = capture();
    const dead = { ...entry, status: 'dead' as const };
    store().upsertEntry('dead', dead);
    expect(pendingCaptures(store())).toHaveLength(0);
    const q = projectPendingQueue(store());
    expect(q.counts.captures).toBe(0);
  });

  it('filters by section without hiding whole-queue counts, and paginates deterministically', () => {
    capture({ proposedAt: T0 });
    candidate({ evidence: [sourceQuote()], proposedAt: T0 });
    candidate({ evidence: [attestation({ tty: true })], kind: 'convention', proposedAt: T1 });

    const capturesOnly = projectPendingQueue(store(), { section: 'captures' });
    expect(capturesOnly.captures).toBeDefined();
    expect(capturesOnly.staged).toBeUndefined();
    expect(capturesOnly.counts.staged).toBe(2); // counts always cover the WHOLE queue

    const stagedPage = projectPendingQueue(store(), { section: 'staged', offset: 1, limit: 1 });
    expect(stagedPage.captures).toBeUndefined();
    expect(stagedPage.staged?.rows).toHaveLength(1);
    expect(stagedPage.staged?.offset).toBe(1);
    expect(stagedPage.staged?.total).toBe(2);

    const capped = projectPendingQueue(store(), { limit: 5000 });
    expect(capped.captures?.limit).toBe(200); // MAX_PENDING_PAGE — payload cannot be inflated
  });

  it('sorts deterministically (proposedAt desc, then id) and caps long claims', () => {
    const long = 'x'.repeat(300);
    capture({ proposedAt: T0, claim: long });
    const a = candidate({ evidence: [sourceQuote()], proposedAt: T0 });
    const b = candidate({
      evidence: [sourceQuote({ soulId: 'sym:src/b.ts#B.c@L1' })],
      proposedAt: T1,
      claim: long,
    });

    const q = projectPendingQueue(store(), { section: 'staged' });
    expect(q.staged?.rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(q.staged?.rows[0]?.claim.length).toBe(241); // 240 + the cap ellipsis
    const capRow = projectPendingQueue(store(), { section: 'captures' }).captures?.rows[0];
    expect(capRow?.claim.length).toBe(241);
  });
});

// ─── the three-way staged classification ──────────────────────────────────────

describe('staged classification', () => {
  it('ready: supported evidence, no structural problems → the browser CAN complete, CLI equivalent shown', () => {
    const c = candidate({ evidence: [sourceQuote()] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('ready');
    expect(row.browserAdmissible).toBe(true);
    expect(row.blockers).toEqual([]);
    expect(row.command).toBe(`crib memory evaluate ${c.id} --profile <name>`);
    expect(row.evidence[0]).toMatchObject({
      kind: 'source-quote',
      admissible: true,
      browserSupported: true,
    });
  });

  it('terminal: unstamped human attestation → never a browser path, the admit command is shown', () => {
    const c = candidate({ kind: 'decision', evidence: [attestation({ tty: undefined })] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('terminal');
    expect(row.browserAdmissible).toBe(false);
    // the tty/actor/attestedAt trio is the terminal-only marker — NOT a blocker
    expect(row.blockers).toEqual([]);
    expect(row.command).toBe(`crib memory admit ${c.id}`);
    expect(row.evidence[0]).toMatchObject({ admissible: true, browserSupported: false });
  });

  it('ready: a tty-stamped attestation (minted by a real terminal) can be completed in the browser', () => {
    candidate({ kind: 'convention', evidence: [attestation({ tty: true })] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('ready');
    expect(row.browserAdmissible).toBe(true);
  });

  it('blocked: missing required fields are blockers, not terminal markers', () => {
    candidate({ evidence: [sourceQuote({ soulId: undefined })] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('blocked');
    expect(row.browserAdmissible).toBe(false);
    expect(row.blockers.length).toBe(1);
    expect(row.blockers[0]).toContain('soulId');
  });

  it('blocked: empty evidence names the distill path (the episodic capture path stages evidence later)', () => {
    candidate({ evidence: [] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('blocked');
    expect(row.blockers.join(' ')).toContain('no evidence attached');
  });

  it('wrong-kind evidence is a NOTE (ignored at admission), never a blocker that empties a ready row', () => {
    candidate({ kind: 'fact', evidence: [sourceQuote(), attestation({ tty: true })] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('ready');
    expect(row.blockers).toEqual([]);
    expect(row.notes.join(' ')).toContain('ignored');
    // the ignored item is visible with admissible: false — never silently dropped
    expect(row.evidence.some((e) => e.kind === 'human-attestation' && e.admissible === false)).toBe(
      true,
    );
  });

  it('unrecognized evidence kind is a structural blocker (the most common authoring mistake)', () => {
    candidate({
      evidence: [{ kind: 'mystery' as MemoryEvidence['kind'], verdict: 'valid', checkedAt: T0 }],
    });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('blocked');
    expect(row.blockers[0]).toContain('no recognised `kind`');
  });
});

// ─── the pitfall cross-item combo rule ────────────────────────────────────────

describe('pitfall combo rule', () => {
  it('receipt-pair alone → ready', () => {
    candidate({
      kind: 'pitfall',
      evidence: [
        {
          kind: 'receipt-pair',
          verdict: 'valid',
          checkedAt: T0,
          failingReceiptId: 'rcp:fail',
          passingReceiptId: 'rcp:pass',
        },
      ],
    });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('ready');
  });

  it('source-quote + stamped attestation (a reproduction) → ready', () => {
    candidate({ kind: 'pitfall', evidence: [sourceQuote(), attestation({ tty: true })] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('ready');
  });

  it('source-quote + UNstamped attestation → terminal (the reproduction needs the terminal step)', () => {
    const c = candidate({
      kind: 'pitfall',
      evidence: [sourceQuote(), attestation({ tty: undefined })],
    });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('terminal');
    expect(row.command).toBe(`crib memory admit ${c.id}`);
  });

  it('source-quote alone → blocked with the combo named, so ready never disagrees with the gate', () => {
    candidate({ kind: 'pitfall', evidence: [sourceQuote()] });
    const row = projectPendingQueue(store(), { section: 'staged' }).staged?.rows[0]!;
    expect(row.standing).toBe('blocked');
    expect(row.blockers.join(' ')).toContain('receipt-pair');
    expect(row.browserAdmissible).toBe(false);
  });
});

// ─── the Gate-0 user-facing vocabulary law ─────────────────────────────────────

describe('user-facing vocabulary', () => {
  it('no internal admission-vocabulary word survives into the serialized response', () => {
    capture({ proposedAt: T0 });
    candidate({ evidence: [sourceQuote()] });
    candidate({ kind: 'decision', evidence: [attestation({ tty: undefined })] });
    const q = projectPendingQueue(store());
    expect(JSON.stringify(q)).not.toMatch(/candidate|trust/i);
    // and the commands are exactly what the CLI parses (positional ids, no banned flag names)
    const commands = [
      ...q.captures!.rows.map((r) => r.command),
      ...q.staged!.rows.map((r) => r.command),
    ];
    for (const cmd of commands) expect(cmd).toMatch(/^crib memory (admit|evaluate|distill) /);
  });
});

// ─── evidence fixtures ────────────────────────────────────────────────────────

function sourceQuote(over: Record<string, unknown> = {}): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId: SOUL_ID,
    quote: 'normalizes input',
    targetHash: 'blake3:abc',
    ...over,
  } as MemoryEvidence;
}

function attestation(over: Record<string, unknown> = {}): MemoryEvidence {
  return {
    kind: 'human-attestation',
    verdict: 'valid',
    checkedAt: T0,
    actor: 'user',
    attestedAt: T0,
    ...over,
  } as MemoryEvidence;
}
