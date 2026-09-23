import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WP1 item 4's CALL-SITE half — the half that no test covered, found while taking the item's
 * discrimination credit (register row WP1-D10, B4).
 *
 * WHY THIS FILE EXISTS. Item 4 closes D1-b: the two append-only lanes — the intelligence-event
 * journal and the sync outbox — used to make **no flush claim at all**, so a line an operator had
 * been told was recorded could sit in the page cache. `atomic-write.test.ts` discriminates the
 * MECHANISM (`appendLineDurable` really flushes, and flushes the directory only on create), but
 * nothing asserted that the lanes *call* it. A lane reverting to `appendFileSync` would therefore
 * pass every existing suite unobserved — which is D1-b itself, reintroduced at the call site rather
 * than the helper. The mechanism can be right while the wiring is wrong; only this file can tell.
 *
 * HOW IT DISCRIMINATES. The `atomic` module is wrapped so `appendLineDurable` records every call and
 * then delegates to the real implementation. A revert to `appendFileSync` bypasses the wrapper
 * entirely, so the spy records nothing and the test fails — while the on-disk assertions below prove
 * the wrapper still writes for real, i.e. that the delegation is genuine and the test is not merely
 * asserting its own mock.
 */

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ path: string; line: string }> }));

vi.mock('./atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic.js')>();
  return {
    ...actual,
    appendLineDurable: (path: string, line: string) => {
      calls.push({ path, line });
      return actual.appendLineDurable(path, line);
    },
  };
});

import { IntelligenceEventJournal } from './intelligence-events.js';
import { SYNC_OUTBOX_FILE, stageOutboundEvent } from './sync/queue.js';
import { eventFor, v1Record } from './sync/sync-test-fixtures.js';

const T0 = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  calls.length = 0;
});

describe('the durable lanes append THROUGH appendLineDurable (WP1 item 4, D1-b)', () => {
  it('the intelligence-event journal routes its line through the durable helper', () => {
    const root = tmpRoot('crib-lane-events-');
    const events = new IntelligenceEventJournal({ rootDir: root, now: () => T0 });

    const { event } = events.append({
      kind: 'file.changed',
      idempotencyKey: 'watcher:1',
      source: { clientId: 'watcher' },
      identity: { principalId: 'principal:alice' },
      payload: { path: 'packages/memory/src/api.ts' },
      occurredAt: T0,
    });

    // the wiring claim: exactly one durable append, on the journal's own path, carrying this event
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(join(root, 'intelligence-events.jsonl'));
    expect(JSON.parse((calls[0]?.line ?? '').trim()).id).toBe(event.id);

    // …and the delegation is real, not the mock talking to itself: the bytes are on disk
    const onDisk = readFileSync(join(root, 'intelligence-events.jsonl'), 'utf8');
    expect(JSON.parse(onDisk.trim()).id).toBe(event.id);
  });

  it('the sync outbox routes its staged envelope through the durable helper', () => {
    const root = tmpRoot('crib-lane-outbox-');
    const evt = eventFor(v1Record());

    const res = stageOutboundEvent(evt, root);
    expect(res).toEqual({ id: evt.id, staged: true, idempotent: false });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(join(root, SYNC_OUTBOX_FILE));
    expect(JSON.parse((calls[0]?.line ?? '').trim()).id).toBe(evt.id);
    expect(existsSync(join(root, SYNC_OUTBOX_FILE))).toBe(true);
  });

  it('an idempotent re-stage appends NOTHING — the durable path is not reached twice', () => {
    const root = tmpRoot('crib-lane-idempotent-');
    const evt = eventFor(v1Record());
    stageOutboundEvent(evt, root);
    calls.length = 0;

    expect(stageOutboundEvent(evt, root)).toEqual({ id: evt.id, staged: false, idempotent: true });
    // a re-stage that wrote would be a duplicate line in an append-only lane, not merely extra work
    expect(calls).toHaveLength(0);
  });
});
