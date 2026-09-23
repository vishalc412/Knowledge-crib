import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
/**
 * WP5 §7.1 — T13 / T13b: the opt-in fresh evaluation on the read folds.
 *
 * WHY THESE TWO TESTS EXIST, AND WHY THEY ARE ONE FILE. §7.1 landed a change that is NOT a
 * display-only addition: `effectiveVerdicts` consults a supplied evaluation FIRST for
 * `evidence`/`applicability` (both branches, `evaluator.ts`), so a fresh evaluation REPLACES the
 * stamped verdict rather than decorating it. A record whose quote no longer grounds moves from
 * `valid` to `invalid` and, by `isRecallEligible`, leaves normal recall.
 *
 * That is the right answer — evidence validity is a property of the world now — but it means the
 * change cannot be switched on by default without silently changing what recall returns. So:
 *
 *   - **T13** pins the DEFAULT-OFF path as byte-identical to an API with no evaluator wired at all.
 *     This is the regression that a future "just make it default on" edit would break, and it is
 *     asserted against a second API instance rather than a stored fixture, so it cannot drift.
 *   - **T13b** pins the ONE re-decision the opt-in produces, with its mechanism, so the behaviour
 *     change is a recorded decision rather than a surprise the first time an operator flips it.
 *
 * Both tests also pin an asymmetry that a first draft of §7.1 got WRONG: the re-decision does NOT
 * move the ledger row's group. `ledgerGroupOf` is anchor-derived and consults verdicts only for
 * lifecycle/quarantine, so a row reads `current` while its evidence is `invalid` and it is excluded
 * from recall. `reasons` is the only field where that shows — which is why the row needed one.
 *
 * The fixture is deliberately the smallest one that produces the flip: one record, one evidence item,
 * a node that exists but no longer contains the quoted text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MemoryAnchorPort,
  MemoryApi,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryRecord,
  type MemorySoulPort,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  memoryRecordId,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-revalidate';
const ANCHOR_ID = 'sym:src/a.ts#A.b@L10';
/** The quote the record cites. The live node will NOT contain it — that is the whole fixture. */
const CITED_QUOTE = 'does the thing';

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-revalidate-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

/** A symbol node that EXISTS (so the anchor is not "gone") but whose hash has moved. */
function driftedNode(): Node {
  return {
    id: ANCHOR_ID,
    kind: 'symbol',
    name: 'b',
    qualifiedName: 'A.b',
    file: 'src/a.ts',
    span: { start: 10, end: 40 },
    lang: 'typescript',
    hash: 'blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  } as unknown as Node;
}

/**
 * The soul port the evaluator revalidates against. `rehydrate` returns text that does NOT contain
 * {@link CITED_QUOTE}, which is what drives the record's evidence from `valid` to `invalid`
 * (`quote-not-found`) once an evaluation is actually supplied.
 */
function soulPort(): MemoryAnchorPort & MemorySoulPort {
  return {
    getNode: (id: string) => (id === ANCHOR_ID ? driftedNode() : undefined),
    allNodes: () => [driftedNode()],
    rehydrate: () => ({
      text: 'this function does something else entirely',
      truncated: false,
      totalLines: 1,
      startLine: 10,
    }),
    findByLocator: () => [],
  } as unknown as MemoryAnchorPort & MemorySoulPort;
}

/** The node that exists and whose rehydrated text CONTAINS {@link CITED_QUOTE} — a clean grounding. */
function groundingSoulPort(): MemoryAnchorPort & MemorySoulPort {
  const node = {
    ...driftedNode(),
    hash: 'blake3:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  } as unknown as Node;
  return {
    getNode: (id: string) => (id === ANCHOR_ID ? node : undefined),
    allNodes: () => [node],
    rehydrate: () => ({
      text: `function b() { ${CITED_QUOTE} }`,
      truncated: false,
      totalLines: 1,
      startLine: 10,
    }),
    findByLocator: () => [],
  } as unknown as MemoryAnchorPort & MemorySoulPort;
}

function citedEvidence(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId: ANCHOR_ID,
    quote: CITED_QUOTE,
    // Differs from the live node's hash → drift, not a clean grounding.
    targetHash: 'blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}

function record(): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: ANCHOR_ID,
    claim: 'A.b does the thing',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [ANCHOR_ID],
    evidence: [citedEvidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    // Stamped as healthy — which is exactly the claim a fresh evaluation is allowed to overturn.
    verdicts: {
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: T0,
  };
}

/** Seed one record, and return an API built either WITH the revalidation ports or without them. */
function world(opts: { ports: boolean }) {
  const local = MemoryStore.local(REPO, { env, now: () => T0 });
  const r = record();
  local.upsertEntries('active', [r]);
  const api = new MemoryApi({
    stores: { local },
    env,
    now: () => T0,
    soul: soulPort(),
    ...(opts.ports ? { evaluator: new MemoryEvaluator(), evalCtx: { soul: soulPort() } } : {}),
  });
  return { api, recordId: r.id };
}

describe('WP5 T13 — the opt-in is OFF by default and changes nothing', () => {
  it('every default read path is byte-identical to an API with no evaluator wired at all', () => {
    const wired = world({ ports: true });
    const bare = world({ ports: false });

    // The strongest available statement of "nothing changed": the whole serialized response of the
    // API that HAS the ports but does not opt in must equal the one that has no ports to opt into.
    // A stored fixture would only prove the response matched what someone once captured; this proves
    // it matches the incumbent behaviour by construction.
    expect(JSON.stringify(wired.api.ledger())).toBe(JSON.stringify(bare.api.ledger()));
    expect(JSON.stringify(wired.api.ledger({ revalidate: false }))).toBe(
      JSON.stringify(bare.api.ledger()),
    );
    expect(JSON.stringify(wired.api.get(wired.recordId))).toBe(
      JSON.stringify(bare.api.get(bare.recordId)),
    );
    expect(JSON.stringify(wired.api.audit(wired.recordId))).toBe(
      JSON.stringify(bare.api.audit(bare.recordId)),
    );
    expect(JSON.stringify(wired.api.handoff())).toBe(JSON.stringify(bare.api.handoff()));

    // And the concrete thing that opt-in buys, absent: no row carries a reason.
    const row = wired.api.ledger().rows[0]!;
    expect(row.reasons).toEqual([]);
    // The stamped verdict survives untouched — this is the record that T13b shows CAN be overturned.
    expect(row.evidenceVerdict).toBe('valid');
    expect(row.applicability).toBe('current');
    expect(row.group).toBe('current');
    expect(row.eligible).toBe(true);
  });

  it('a lone evaluator with no eval context cannot revalidate, even with the opt-in set', () => {
    // Both ports or neither: a lone evaluator has nothing to check evidence against, so opting in
    // must be inert rather than half-applied. The rule is the one `search` already documents.
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    local.upsertEntries('active', [record()]);
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: soulPort(),
      evaluator: new MemoryEvaluator(),
      // no evalCtx
    });
    expect(api.ledger({ revalidate: true }).rows[0]!.reasons).toEqual([]);
    expect(api.ledger({ revalidate: true }).rows[0]!.group).toBe('current');
  });
});

describe('WP5 T13b — the opt-in re-decides the verdict, and the re-decision is the documented one', () => {
  it('replaces the stamped verdict, carries the reason, and drops the row out of recall', () => {
    const { api, recordId } = world({ ports: true });
    const before = api.ledger().rows[0]!;
    const after = api.ledger({ revalidate: true }).rows[0]!;

    // The mechanism, named. The node EXISTS but its hash has moved, and the rehydrated span no
    // longer grounds the quote, so source-quote revalidation lands on `hash-drift` → evidence
    // `invalid`. Note the reason is `hash-drift` and NOT `quote-not-found`: the evaluator reports
    // the drift first, and only distinguishes a missing quote on the hash-MATCHING branch — which
    // short-circuits to `ok` before it can ever run (`evaluator.ts`). The assertion is on the
    // mechanism that actually fires, not the one the fixture's comment first assumed.
    expect(after.reasons).toContain('hash-drift');
    expect(after.evidenceVerdict).toBe('invalid');

    // The consequence that makes this a BEHAVIOUR change and not a display addition: the stamped
    // `valid` is gone and, by `isRecallEligible`, the record leaves normal recall.
    expect(before.evidenceVerdict).toBe('valid');
    expect(before.eligible).toBe(true);
    expect(after.eligible).toBe(false);

    // And the consequence it does NOT have, asserted rather than left implicit because an earlier
    // draft of the spec claimed the opposite: the row's GROUP does not move. `ledgerGroupOf`
    // derives the group from the ANCHOR correlation and consults verdicts only for
    // lifecycle/quarantine, so a record can sit in `current` while its evidence is `invalid` and it
    // is excluded from recall. Pinning this is the point — it is the asymmetry that makes
    // `reasons` load-bearing rather than decorative.
    expect(before.group).toBe('current');
    expect(after.group).toBe('current');
    expect(api.ledger({ revalidate: true }).counts.current).toBe(1);

    // The row is the SAME record — the change is a re-decision, not a different row.
    expect(after.id).toBe(before.id);
    expect(after.id).toBe(recordId);
  });

  it('carries the reason on get(), audit() and handoff() when each is asked explicitly', () => {
    const { api, recordId } = world({ ports: true });

    expect(api.get(recordId).verdicts?.reasons).toEqual([]);
    expect(api.get(recordId, { revalidate: true }).verdicts?.reasons).toContain('hash-drift');

    expect(api.audit(recordId).records[0]!.verdicts.reasons).toEqual([]);
    expect(api.audit(recordId, { revalidate: true }).records[0]!.verdicts.reasons).toContain(
      'hash-drift',
    );

    // `handoff` has no `records` field — the folded verdicts surface through `needsAttention`
    // (degraded axes) and `recent` (healthy ones). This record is `invalid`/`orphaned`, so a
    // revalidated read puts it in `needsAttention`, and that row is the one that must carry the
    // reason: it is where an operator asks "why is this here".
    expect(api.handoff().needsAttention).toHaveLength(0);
    const attention = api.handoff({ revalidate: true }).needsAttention[0]!;
    expect(attention.id).toBe(recordId);
    expect(attention.reasons).toContain('hash-drift');
    // `recent` is the still-good list and this record is not in it — which is also what makes the
    // absent `reasons` field on `HandoffRecent` a proof rather than an omission (see its docstring).
    expect(api.handoff({ revalidate: true }).recent).toHaveLength(0);
  });
});

/**
 * WP5 §7.1/§7.4 — the `revalidated` flag (spec §10 dated note, 2026-09-23).
 *
 * A row's `reasons` is empty in two situations that mean OPPOSITE things: the read re-checked the
 * claim and nothing failed, or the read never re-checked it. `collectReasons` filters `'ok'` and
 * `'ignored'`, so a healthy revalidated row serializes exactly `[]` — the same bytes as a row nobody
 * looked at. Without this flag a surface must render one sentence for both, and the sentence it
 * would render ("this read did not re-check the claim") is FALSE on the revalidated path.
 */
describe('WP5 §7.4 — `revalidated` distinguishes the two empty-`reasons` states', () => {
  it('is false on every default path, so an empty `reasons` is never read as a clean re-check', () => {
    const { api } = world({ ports: true });
    expect(api.ledger().revalidated).toBe(false);
    expect(api.ledger({ revalidate: false }).revalidated).toBe(false);
    // The ambiguity, stated as an assertion: this row's `reasons` is `[]` and it was NOT looked at.
    const row = api.ledger().rows[0]!;
    expect(row.reasons).toEqual([]);
    expect(row.evidenceVerdict).toBe('valid');
  });

  it('is true only when the caller asked AND both ports are wired', () => {
    expect(world({ ports: true }).api.ledger({ revalidate: true }).revalidated).toBe(true);
    // Asked, but only one port present: a revalidation that COULD NOT run is not one that did, so
    // the flag reports what happened rather than what was requested.
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    local.upsertEntries('active', [record()]);
    const loneEvaluator = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: soulPort(),
      evaluator: new MemoryEvaluator(),
    });
    expect(loneEvaluator.ledger({ revalidate: true }).revalidated).toBe(false);
    expect(world({ ports: false }).api.ledger({ revalidate: true }).revalidated).toBe(false);
  });

  it('separates "re-checked, the ground is elsewhere" from "re-checked, the evidence failed"', () => {
    // Case 1 — excluded, re-checked, and the evidence IS the ground: `reasons` is populated.
    const { api } = world({ ports: true });
    const evidenced = api.ledger({ revalidate: true });
    expect(evidenced.revalidated).toBe(true);
    expect(evidenced.rows[0]!.evidenceVerdict).toBe('invalid');
    expect(evidenced.rows[0]!.reasons).toContain('hash-drift');

    // Case 2 — excluded, re-checked, and the evidence is FINE: `reasons` is `[]` while the row is
    // still not recalled, because the clause that holds it out is the admission axis, which the
    // evaluator does not touch. This is the state that was indistinguishable from "not re-checked"
    // before this flag, and the reason the surface can now say which read it is looking at.
    //
    // The evidence has to genuinely PASS for this to be the state under test, so it is a different
    // fixture from `record()`: no `targetHash` (so the quote is re-checked against the rehydrated
    // text on every call rather than short-circuiting on a hash match) and a soul port whose text
    // CONTAINS the quote.
    const staged = MemoryStore.local(REPO, { env, now: () => T0 });
    const cited: MemoryEvidence = {
      kind: 'source-quote',
      verdict: 'valid',
      checkedAt: T0,
      soulId: ANCHOR_ID,
      quote: CITED_QUOTE,
    };
    const base = record();
    const held = {
      ...base,
      evidence: [cited],
      verdicts: { ...base.verdicts, trust: 'candidate' as const },
    };
    staged.upsertEntries('active', [held]);
    const heldApi = new MemoryApi({
      stores: { local: staged },
      env,
      now: () => T0,
      soul: groundingSoulPort(),
      evaluator: new MemoryEvaluator(),
      evalCtx: { soul: groundingSoulPort() },
    });
    const heldRead = heldApi.ledger({ revalidate: true });
    expect(heldRead.revalidated).toBe(true);
    expect(heldRead.rows[0]!.eligible).toBe(false);
    expect(heldRead.rows[0]!.excludedBy).toBe('standing');
    // `[]` — and now honestly so: the read DID look, and found the evidence sound.
    expect(heldRead.rows[0]!.reasons).toEqual([]);
    expect(heldRead.rows[0]!.evidenceVerdict).toBe('valid');
    expect(heldRead.rows[0]!.applicability).toBe('current');
  });
});
