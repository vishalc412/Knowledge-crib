/**
 * D3-c — the authorization surfaces that had NO adversarial evidence.
 *
 * §8.5 of the WP1 implementation spec audited the read surfaces one by one and found the filter
 * applied everywhere, with adversarial proof for only three of them: plain search (unit-level,
 * `recall.test.ts`), the connected graph (`verbs-memory-graph.test.ts`), and durable intakes
 * (`intake-isolation.test.ts`). Five surfaces were "filter applied, no test found":
 *
 *   | surface              | filter point                                    |
 *   | counts / stats       | `api.ts` ledger() — counts computed from rows   |
 *   | pagination / cursors | `api.ts` ledger() — filter precedes `slice`     |
 *   | history / bi-temporal| `api.ts` history() — matchKey over gathered      |
 *   | exports              | `api.ts` handoff() — inherits the records gather |
 *   | direct `get` by id   | `api.ts` get() — foreign id → `found: false`     |
 *
 * A filter that runs in the wrong ORDER is not a filter. Every assertion below is therefore two
 * things at once: (a) no foreign row is disclosed, and (b) the caller's OWN row IS disclosed by the
 * very same call — because an empty response, or a total of zero, also "discloses no foreign
 * record". (b) is what separates "scoped" from "blackholed", and it is the half a leak-hunting test
 * usually forgets. Where a surface reports a NUMBER (counts, totals, page lengths), the test goes
 * further and pins that a foreign record does not move it: a filter that ran after the count would
 * leak the foreign record's existence through arithmetic while disclosing none of its content.
 *
 * Scope note, deliberately: the CLI's diagnostics/doctor surface is NOT covered here. Its one live
 * disclosure (`countUnstampedRecords` publishing a count of unattributed records) is a named,
 * low-severity residual recorded in the spec as D-6 and pinned by its own CLI tests — it is not a
 * foreign-principal leak, so a foreign-principal fixture cannot assert anything about it. `audit()`
 * IS covered below, since it is the same gather with a different projection.
 *
 * The boundary is engaged through `KCRIB_STRICT_PRINCIPAL` (WP1 item 13), resolved from the API's
 * own env. `resolveStrictPrincipal` records the measurement that makes the shipped default OFF:
 * local admission mints memory-1, which carries no ownership column, so a strict gather refuses
 * every record the device itself wrote. That is why every "engaged" assertion has a paired
 * "default" assertion — the default's behaviour is a pinned fact here, not a described intention.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryApi,
  type MemoryEvidence,
  type MemoryRecord,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  memoryRecordId,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-authz-surfaces';
const SUBJECT = 'sym:src/a.ts#A.b';
const CALLER = 'principal:A';
const OTHER = 'principal:B';
/** Three distinct subjects so a foreign row is identifiable by subject alone, never by position. */
const OWN_SUBJECT = 'sym:src/own.ts#own';
const OTHER_SUBJECT = 'sym:src/other.ts#other';
const OTHER_LEGACY_SUBJECT = 'sym:src/other.ts#otherLegacy';

function evidence(soulId: string): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId,
    quote: 'does the thing',
    targetHash: 'blake3:abcd1234',
  } as MemoryEvidence;
}

/** A trusted memory-1 record — what admission itself writes, and the only shape the boundary acts on. */
function v1Record(subject: string): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject,
    claim: `${subject} does the thing`,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: [evidence(subject)],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: T0,
  } as MemoryRecord;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-authz-'));
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

/**
 * One store holding the caller's record, another principal's record, and another principal's
 * UNSTAMPED memory-1 record — the last being the only one the boundary can act on, since a record
 * STAMPED with someone else is refused by the ownership comparison whether or not it is engaged.
 *
 * Each world gets its own directory because the fixture is not idempotent over a populated store:
 * re-upserting a memory-1 record whose migrated twin already exists adds a fresh `mem:` line, and
 * the next migration pass then stamps that line under whichever principal is current.
 *
 * `foreign` adds N records owned by OTHER, and nothing else — which is what makes it usable as the
 * "does a foreign record move the number?" probe: two worlds built with different `foreign` values
 * but the same caller-side content must project IDENTICAL caller-visible numbers.
 */
function world(opts: { optIn: boolean; foreign?: number; label: string }) {
  const foreign = opts.foreign ?? 0;
  const dir = join(home, opts.label);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KCRIB_MEMORY_DIR: dir,
    KCRIB_REGISTRY_DIR: dir,
    KCRIB_PRINCIPAL_ID: CALLER,
    // Pinned, NOT inherited: a developer shell that exported the opt-in would make the "default"
    // half of each pair assert the engaged behaviour and pass for the wrong reason.
    KCRIB_STRICT_PRINCIPAL: opts.optIn ? '1' : undefined,
  };
  const store = MemoryStore.local(REPO, { env, now: () => T0 });
  // The caller's own record, migrated under the caller — the v2 twin's alias snapshot is what makes
  // it rankable at all (a bare memory-2 record has no `verdicts`, so the projection drops it).
  store.upsertEntry('active', v1Record(OWN_SUBJECT));
  store.migrateToV2({ provenance: { principalId: CALLER } });
  // Another principal's record, migrated under them.
  store.upsertEntry('active', v1Record(OTHER_SUBJECT));
  store.migrateToV2({ provenance: { principalId: OTHER } });
  // …and another principal's record left UNSTAMPED, the shape every unmigrated private store holds.
  store.upsertEntry('active', v1Record(OTHER_LEGACY_SUBJECT));
  for (let i = 0; i < foreign; i += 1) {
    store.upsertEntry('active', v1Record(`sym:src/extra.ts#extra${i}`));
  }
  const api = new MemoryApi({ stores: { local: store }, env, now: () => T0 });
  return { api, store, env };
}

/** The subjects the caller's own store physically holds, whatever the boundary decides about them. */
function storedSubjects(store: MemoryStore): string[] {
  return (store.readCollection('active').entries as unknown as MemoryRecord[])
    .map((e) => e.subject)
    .sort();
}

describe('D3-c — authorization surfaces: no foreign row, and the caller’s own row still there', () => {
  it('the fixture is the two-principal world it claims to be (control)', () => {
    // Without this, every assertion below could pass against a world that never held a foreign
    // record. Pinned on the STORE, which no boundary filters.
    const { store } = world({ optIn: false, label: 'control' });
    expect(storedSubjects(store)).toEqual(
      [OTHER_LEGACY_SUBJECT, OTHER_SUBJECT, OWN_SUBJECT].sort(),
    );
  });

  describe('counts / stats — ledger()', () => {
    it('counts only the caller’s rows, and a foreign record does not move the number', () => {
      const alone = world({ optIn: true, foreign: 0, label: 'counts-alone' }).api.ledger();
      const withForeign = world({ optIn: true, foreign: 3, label: 'counts-foreign' }).api.ledger();
      // (a) nothing foreign, by id or by subject
      for (const row of withForeign.rows) expect(row.subject).not.toBe(OTHER_SUBJECT);
      // (b) the caller's own row IS there — so the count is not zero-by-blackhole
      expect(withForeign.rows.some((r) => r.subject === OWN_SUBJECT)).toBe(true);
      // The arithmetic half: three extra foreign records must be invisible in the TOTAL and in
      // every per-group count. A filter applied after the count leaks existence with no content.
      expect(withForeign.total).toBe(alone.total);
      expect(withForeign.counts).toEqual(alone.counts);
    });

    it('the default (boundary not engaged) counts the unstamped foreign row — the pinned open state', () => {
      const open = world({ optIn: false, foreign: 0, label: 'counts-open' }).api.ledger();
      const engaged = world({ optIn: true, foreign: 0, label: 'counts-engaged' }).api.ledger();
      // The unstamped record passes the open gather and is refused by the engaged one, so the
      // engaged total is strictly smaller. Asserted rather than described: this IS the leak.
      expect(engaged.total).toBeLessThan(open.total);
      expect(open.rows.some((r) => r.subject === OTHER_LEGACY_SUBJECT)).toBe(true);
      expect(engaged.rows.some((r) => r.subject === OTHER_LEGACY_SUBJECT)).toBe(false);
      // …while the STAMPED foreign record is refused either way — the part of D3-a that was never
      // open, which is why the fix's absence only ever showed on unstamped data.
      expect(open.rows.some((r) => r.subject === OTHER_SUBJECT)).toBe(false);
      expect(engaged.rows.some((r) => r.subject === OTHER_SUBJECT)).toBe(false);
    });
  });

  describe('pagination / cursors — ledger() with offset + limit', () => {
    it('walks every page with no foreign row, and the walk terminates at the caller’s count', () => {
      const { api } = world({ optIn: true, foreign: 4, label: 'page' });
      const all = api.ledger();
      const seen: string[] = [];
      for (let offset = 0; offset < all.total + 4; offset += 1) {
        const page = api.ledger({ offset, limit: 1 });
        for (const row of page.rows) {
          expect(row.subject).not.toBe(OTHER_SUBJECT);
          expect(row.subject).not.toBe(OTHER_LEGACY_SUBJECT);
          seen.push(row.id);
        }
        // A page's LENGTH is a disclosure too: if the slice ran before the filter, later offsets
        // would return foreign rows and the page count would exceed the total.
        expect(page.rows.length).toBeLessThanOrEqual(1);
      }
      // (b) the caller's record is reachable by paging, and paging cannot produce more distinct
      // rows than the total claims — the two halves of "the filter precedes the slice".
      expect(seen).toContain(all.rows[0]!.id);
      expect(new Set(seen).size).toBe(all.total);
    });

    it('the declared total is a bound on what paging can return, not an estimate', () => {
      const { api } = world({ optIn: true, foreign: 0, label: 'page-bound' });
      const all = api.ledger({ limit: 1 });
      expect(all.total).toBeGreaterThanOrEqual(all.rows.length);
      const lastPage = api.ledger({ offset: all.total, limit: 1 });
      expect(lastPage.rows).toEqual([]);
    });
  });

  describe('history / bi-temporal — history()', () => {
    it('returns nothing for a foreign key, and the caller’s own trail for their own', () => {
      const { api } = world({ optIn: true, foreign: 0, label: 'history' });
      const own = api.history(OWN_SUBJECT);
      expect(own.records.map((r) => r.subject)).toEqual([OWN_SUBJECT]);
      expect(own.events.length).toBeGreaterThan(0);
      // Foreign by subject, and foreign by the OTHER principal's record id — a key that resolves to
      // a record the caller may not see must read exactly as a key that does not exist.
      for (const key of [OTHER_SUBJECT, OTHER_LEGACY_SUBJECT]) {
        const foreign = api.history(key);
        expect(foreign.records).toEqual([]);
        expect(foreign.events).toEqual([]);
      }
    });

    it('a point-in-time read (asOf) is scoped too — it cannot recover a foreign row', () => {
      const { api } = world({ optIn: true, foreign: 0, label: 'history-asof' });
      // asOf AFTER every write: the cut is a no-op, so any difference from the full read would be
      // the filter, not the time cut.
      const asOf = api.history(OTHER_SUBJECT, { asOf: '2027-01-01T00:00:00.000Z' });
      expect(asOf.records).toEqual([]);
      expect(asOf.events).toEqual([]);
      // …and asOf does not suppress the caller's own record in the same world.
      const own = api.history(OWN_SUBJECT, { asOf: '2027-01-01T00:00:00.000Z' });
      expect(own.records.map((r) => r.subject)).toEqual([OWN_SUBJECT]);
    });
  });

  describe('exports — handoff()', () => {
    it('exports the caller’s records and none of another principal’s', () => {
      const { api } = world({ optIn: true, foreign: 0, label: 'export' });
      const recent = api.handoff({ repository: { dirty: false } }).recent;
      const subjects = recent.map((r) => r.subject);
      expect(subjects).not.toContain(OTHER_SUBJECT);
      expect(subjects).not.toContain(OTHER_LEGACY_SUBJECT);
      // Non-vacuous: handoff crosses a repo/device boundary by definition, so an export that
      // returned nothing at all would "leak nothing" while being useless.
      expect(subjects).toContain(OWN_SUBJECT);
    });

    it('the default export still carries the unstamped foreign record (the pinned open state)', () => {
      const { api } = world({ optIn: false, foreign: 0, label: 'export-open' });
      const subjects = api.handoff({ repository: { dirty: false } }).recent.map((r) => r.subject);
      expect(subjects).toContain(OTHER_LEGACY_SUBJECT);
      expect(subjects).toContain(OWN_SUBJECT);
    });
  });

  describe('direct get by id — get()', () => {
    it('a subject is not a key, so asking by subject resolves nothing — for anyone', () => {
      const { api } = world({ optIn: true, foreign: 0, label: 'get' });
      // `get(idOrAlias)` resolves ids and legacy ids, never subjects. Asserting this first keeps the
      // id test below honest: without it, "a foreign id is refused" could be satisfied by `get`
      // refusing everything, including the caller's own.
      for (const subject of [OWN_SUBJECT, OTHER_SUBJECT, OTHER_LEGACY_SUBJECT]) {
        const bySubject = api.get(subject);
        expect(bySubject.found).toBe(false);
        expect(bySubject.placement).toEqual([]);
        expect(bySubject.legacyIds).toEqual([]);
      }
    });

    it('resolves the caller’s own real id and nothing through another principal’s', () => {
      const { api, store } = world({ optIn: true, foreign: 0, label: 'get-id' });
      // The real record ids, taken from the store (the boundary-free ground truth), so the probe
      // cannot pass merely by handing `get` an id that never existed.
      const bySubject = new Map(
        (store.readCollection('active').entries as unknown as MemoryRecord[]).map((e) => [
          e.subject,
          e.id,
        ]),
      );
      const own = api.get(bySubject.get(OWN_SUBJECT)!);
      expect(own.found).toBe(true);
      expect(own.record?.subject).toBe(OWN_SUBJECT);
      // FOREIGN_LEGACY is unstamped: the only one the boundary has a choice about. A foreign id must
      // read exactly as an id that was never written — including `placement`, which would otherwise
      // disclose WHICH store physically holds it.
      for (const key of [bySubject.get(OTHER_SUBJECT)!, bySubject.get(OTHER_LEGACY_SUBJECT)!]) {
        const foreign = api.get(key);
        expect(foreign.found).toBe(false);
        expect(foreign.placement).toEqual([]);
        expect(foreign.legacyIds).toEqual([]);
      }
    });
  });

  describe('audit — the same gather, a different projection', () => {
    it('reports found:false for a foreign key rather than an empty-but-present trail', () => {
      const { api } = world({ optIn: true, foreign: 0, label: 'audit' });
      const own = api.audit(OWN_SUBJECT);
      expect(own.found).toBe(true);
      expect(own.records.map((r) => r.record.subject)).toEqual([OWN_SUBJECT]);
      // `found: false` and not `found: true, records: []`: audit reports on decisions gathered from
      // EVERY store, so a present-but-empty answer would disclose that the id exists somewhere.
      for (const key of [OTHER_SUBJECT, OTHER_LEGACY_SUBJECT]) {
        const foreign = api.audit(key);
        expect(foreign.found).toBe(false);
        expect(foreign.records).toEqual([]);
      }
    });
  });
});
