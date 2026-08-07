/**
 * W7 — external enrichment provider execution (PRD line 383, exit gate 392).
 *
 * Covers the hardened provider contract: definitions come ONLY from a user-owned providers file
 * (never the repo), programs run with `shell:false`, strict JSON over stdin/stdout, bounded
 * concurrency (max 4), per-item timeout kills the child, and provider failure is NON-fatal — a
 * failed item records a `!ok` outcome instead of throwing so the queue keeps going and the target
 * stays pending/resumable.
 *
 * The fixture is a single temp ESM script that branches on the work item's `targetId` to exercise
 * each failure mode (non-zero exit, non-JSON stdout, wrong targetId, slow/timeout) plus the happy
 * path. Run with `shell:false` via `process.execPath` — no shell interpolation of the payload.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnrichWorkItem } from '@knowledge-crib/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PROVIDER_CONCURRENCY,
  type ProviderDef,
  ProviderItemError,
  type ProviderItemOutcome,
  loadProviders,
  providerConcurrency,
  resolveProvider,
  runProviderBatch,
  runProviderOnce,
  validateSaveItemShape,
} from './enrich-provider.js';

let dir: string;
let fixturePath: string;
// Assigned in beforeEach (after the fixture script is written). Definite-assignment asserts that
// to TS so the test callbacks can reference it without a "used before assigned" error.
let def!: ProviderDef;

/** A minimal work item — only `targetId` is consumed by the fixture; the rest satisfies the type. */
function workItem(targetId: string): EnrichWorkItem {
  return {
    targetId,
    seed: {},
    lowerLayer: {},
    outputSchema: {},
    instructions: '',
    suggestedTier: 'fast',
  };
}

/** The canonical valid response the fixture echoes for the happy path. */
function validResponse(targetId: string) {
  return {
    targetId,
    model: 'fixture-provider',
    analysis: { purpose: 'fixture analysis', confidence: 0.9 },
    graph: { nodes: [], edges: [] },
    evidence: [{ soulId: targetId, why: 'fixture evidence' }],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-provider-'));
  // One fixture, branching on targetId so every code path is exercised through `shell:false`.
  // NOTE: success/json/wrong-id paths do NOT call process.exit(0) — Node keeps the event loop alive
  // until the stdout pipe drains, so the parent never sees a truncated response. Only the
  // intentional failure path exits non-zero.
  fixturePath = join(dir, 'fixture.mjs');
  writeFileSync(
    fixturePath,
    `import { setTimeout as sleep } from 'node:timers/promises';
let buf = '';
process.stdin.on('data', (c) => { buf += c.toString(); });
process.stdin.on('end', async () => {
  let item;
  try { item = JSON.parse(buf); } catch { process.exit(3); }
  const tid = item.targetId;
  if (tid === 'fail-exit') { process.stderr.write('boom'); process.exit(1); return; }
  if (tid === 'fail-json') { process.stdout.write('not json at all'); return; }
  if (tid === 'wrong-id') {
    process.stdout.write(JSON.stringify({ targetId: 'other', analysis: {}, graph: { nodes: [], edges: [] }, evidence: [] }));
    return;
  }
  if (tid === 'slow') { await sleep(1000); }
  process.stdout.write(JSON.stringify({
    targetId: tid, model: 'fixture-provider',
    analysis: { purpose: 'fixture analysis', confidence: 0.9 },
    graph: { nodes: [], edges: [] },
    evidence: [{ soulId: tid, why: 'fixture evidence' }],
  }));
});
`,
  );
  def = { command: [process.execPath, fixturePath] };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('W7 loadProviders — structurally validate the user-owned providers file', () => {
  it('returns an empty map when the file is absent (resolveProvider then errors with guidance)', () => {
    const { providers, path } = loadProviders(join(dir, 'missing.json'));
    expect(providers).toEqual({});
    expect(path).toBe(join(dir, 'missing.json'));
  });

  it('throws a readable error on malformed JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(() => loadProviders(p)).toThrow(/not valid JSON/);
  });

  it('throws when the `providers` map is missing or not an object', () => {
    const p = join(dir, 'no-map.json');
    writeFileSync(p, JSON.stringify({ foo: 'bar' }));
    expect(() => loadProviders(p)).toThrow(/must be \{ "providers"/);
  });

  it('throws when a provider lacks a non-empty string[] command', () => {
    const p = join(dir, 'bad-cmd.json');
    writeFileSync(p, JSON.stringify({ providers: { p1: { command: [] } } }));
    expect(() => loadProviders(p)).toThrow(/non-empty string\[\] "command"/);
  });

  it('loads a well-formed file', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ providers: { fixture: def } }));
    const { providers } = loadProviders(p);
    expect(providers.fixture).toBeDefined();
    expect(providers.fixture!.command).toEqual([process.execPath, fixturePath]);
  });
});

describe('W7 resolveProvider — guidance error when a name is absent', () => {
  it('throws with the available provider list when the file has providers', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ providers: { fixture: def, other: { command: ['x'] } } }));
    expect(() => resolveProvider('nope', p)).toThrow(
      /no provider named "nope".*available: fixture, other/,
    );
  });

  it('throws with a define-one hint when the file is empty/missing', () => {
    expect(() => resolveProvider('nope', join(dir, 'missing.json'))).toThrow(
      /define one as \{ "providers"/,
    );
  });

  it('resolves the def when present', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ providers: { fixture: def } }));
    expect(resolveProvider('fixture', p).def).toEqual(def);
  });
});

describe('W7 providerConcurrency — default 1, clamped to [1, MAX]', () => {
  it('defaults to 1', () => {
    expect(providerConcurrency({ command: ['x'] })).toBe(1);
  });
  it('clamps to MAX_PROVIDER_CONCURRENCY', () => {
    expect(providerConcurrency({ command: ['x'], concurrency: 99 })).toBe(MAX_PROVIDER_CONCURRENCY);
  });
  it('clamps non-integer / sub-1 to 1', () => {
    expect(providerConcurrency({ command: ['x'], concurrency: 0 })).toBe(1);
    expect(providerConcurrency({ command: ['x'], concurrency: 2.5 })).toBe(1);
  });
});

describe('W7 validateSaveItemShape — minimal contract a provider must honor', () => {
  it('accepts a well-formed item and echoes it', () => {
    const item = validateSaveItemShape(validResponse('t1'), 't1');
    expect(item.targetId).toBe('t1');
    expect(item.analysis).toEqual({ purpose: 'fixture analysis', confidence: 0.9 });
    expect(item.graph).toEqual({ nodes: [], edges: [] });
    expect(item.evidence).toHaveLength(1);
  });
  it('rejects a non-object', () => {
    expect(() => validateSaveItemShape('x', 't1')).toThrow(ProviderItemError);
    expect(() => validateSaveItemShape(null, 't1')).toThrow(ProviderItemError);
  });
  it('rejects a missing targetId', () => {
    expect(() =>
      validateSaveItemShape({ analysis: {}, graph: { nodes: [], edges: [] }, evidence: [] }, 't1'),
    ).toThrow(/missing string "targetId"/);
  });
  it('rejects a targetId mismatch', () => {
    expect(() => validateSaveItemShape(validResponse('other'), 't1')).toThrow(/does not match/);
  });
  it('rejects a bad graph shape', () => {
    expect(() =>
      validateSaveItemShape({ targetId: 't1', analysis: {}, graph: {}, evidence: [] }, 't1'),
    ).toThrow(/"graph" must be/);
  });
  it('rejects non-array evidence', () => {
    expect(() =>
      validateSaveItemShape(
        { targetId: 't1', analysis: {}, graph: { nodes: [], edges: [] }, evidence: 'no' },
        't1',
      ),
    ).toThrow(/"evidence" must be an array/);
  });
});

describe('W7 runProviderOnce — shell:false, strict JSON, per-item outcomes', () => {
  it('echoes a valid save item on the happy path', async () => {
    const item = await runProviderOnce(def, workItem('ok-1'));
    expect(item.targetId).toBe('ok-1');
    expect(item.model).toBe('fixture-provider');
  });

  it('rejects with ProviderItemError on non-zero exit', async () => {
    await expect(runProviderOnce(def, workItem('fail-exit'))).rejects.toThrow(/exited with code 1/);
    await expect(runProviderOnce(def, workItem('fail-exit'))).rejects.toBeInstanceOf(
      ProviderItemError,
    );
  });

  it('rejects on non-strict-JSON stdout', async () => {
    await expect(runProviderOnce(def, workItem('fail-json'))).rejects.toThrow(/not strict JSON/);
  });

  it('rejects on a targetId mismatch in the response', async () => {
    await expect(runProviderOnce(def, workItem('wrong-id'))).rejects.toThrow(/does not match/);
  });

  it('kills a hung provider on timeout and rejects', async () => {
    const start = Date.now();
    await expect(runProviderOnce(def, workItem('slow'), { timeoutMs: 100 })).rejects.toThrow(
      /timed out after 100ms/,
    );
    const elapsed = Date.now() - start;
    // Should return well under the fixture's 1s sleep — proving the child was killed, not waited on.
    expect(elapsed).toBeLessThan(700);
  });

  it('rejects when the command is empty (no spawn)', async () => {
    await expect(runProviderOnce({ command: [] }, workItem('x'))).rejects.toThrow(
      /command is empty/,
    );
  });
});

describe('W7 runProviderBatch — bounded concurrency, failures never abort the batch', () => {
  it('returns ok outcomes in the SAME order as the input for all-success', async () => {
    const ids = ['a', 'b', 'c'];
    const outcomes = await runProviderBatch(def, ids.map(workItem));
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.targetId)).toEqual(ids);
    expect(outcomes.every((o) => o.ok === true)).toBe(true);
  });

  it('records a !ok outcome for the failed item without aborting the batch', async () => {
    const ids = ['a', 'fail-exit', 'c'];
    const outcomes = await runProviderBatch(def, ids.map(workItem));
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.targetId)).toEqual(ids);
    const failed = outcomes[1] as Extract<ProviderItemOutcome, { ok: false }>;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/exited with code 1/);
    expect((outcomes[0] as { ok: true }).ok).toBe(true);
    expect((outcomes[2] as { ok: true }).ok).toBe(true);
  });

  it('respects concurrency=4 — runs items in parallel (wall-clock under the serial sum)', async () => {
    // The slow fixture sleeps 1s; with concurrency 1, three slow items take ~3s. With concurrency 4
    // they overlap, so three 1s items finish in ~1s.
    const parallelDef: ProviderDef = { ...def, concurrency: 4 };
    const ids = ['slow', 'slow', 'slow'];
    const start = Date.now();
    const outcomes = await runProviderBatch(parallelDef, ids.map(workItem), { timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    expect(outcomes.every((o) => o.ok === true)).toBe(true);
    // Serial would be ~3s; parallel ~1s. Assert < 2.5s to prove overlap without being flaky on slow CI.
    expect(elapsed).toBeLessThan(2500);
  });

  it('default concurrency is 1 — items run serially', async () => {
    // Two slow items with default concurrency (1) take ~2s serial. Use a timeout > the 1s sleep so
    // both succeed, then assert elapsed reflects serialization (> 1.5s, i.e. not overlapped).
    const ids = ['slow', 'slow'];
    const start = Date.now();
    const outcomes = await runProviderBatch(def, ids.map(workItem), { timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    expect(outcomes.every((o) => o.ok === true)).toBe(true);
    expect(elapsed).toBeGreaterThan(1500); // serial: 1s + 1s, not overlapped
  });
});
