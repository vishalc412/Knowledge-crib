import { describe, expect, it } from 'vitest';
import { Stats, trackCall } from './stats.js';

describe('Stats (M3.3 observability)', () => {
  it('snapshot has the live-numbers shape with empty counters initially', () => {
    const s = new Stats();
    const snap = s.snapshot();
    expect(snap.verbs).toEqual({});
    expect(snap.cache).toEqual({ hits: 0, misses: 0, hitRate: 0 });
    expect(snap.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(snap.totalCalls).toBe(0);
  });

  it('record accumulates count + latency bounds per verb', () => {
    const s = new Stats();
    s.record('context', 1.5, false);
    s.record('context', 3.0, false);
    s.record('impact', 0.5, false);
    const snap = s.snapshot();
    expect(snap.verbs.context!.count).toBe(2);
    expect(snap.verbs.context!.totalMs).toBeCloseTo(4.5);
    expect(snap.verbs.context!.minMs).toBeCloseTo(1.5);
    expect(snap.verbs.context!.maxMs).toBeCloseTo(3.0);
    expect(snap.verbs.impact!.count).toBe(1);
    expect(snap.totalCalls).toBe(3);
  });

  it('record flags errors without losing the count', () => {
    const s = new Stats();
    s.record('context', 1, false);
    s.record('context', 2, true);
    const v = s.snapshot().verbs.context!;
    expect(v.count).toBe(2);
    expect(v.errors).toBe(1);
  });

  it('recordCacheHit + hitRate (0 when no probes, ratio otherwise)', () => {
    const s = new Stats();
    expect(s.snapshot().cache.hitRate).toBe(0); // no probes → 0, not NaN
    s.recordCacheHit(true);
    s.recordCacheHit(true);
    s.recordCacheHit(false);
    const c = s.snapshot().cache;
    expect(c.hits).toBe(2);
    expect(c.misses).toBe(1);
    expect(c.hitRate).toBeCloseTo(2 / 3);
  });

  it('trackCall times a sync fn, records success, returns the value verbatim', () => {
    const s = new Stats();
    const r = trackCall(s, 'context', () => 42);
    expect(r).toBe(42);
    expect(s.snapshot().verbs.context!.count).toBe(1);
    expect(s.snapshot().verbs.context!.errors).toBe(0);
  });

  it('trackCall re-throws a sync error AND records it', () => {
    const s = new Stats();
    expect(() =>
      trackCall(s, 'boom', () => {
        throw new Error('nope');
      }),
    ).toThrowError('nope');
    const v = s.snapshot().verbs.boom!;
    expect(v.count).toBe(1);
    expect(v.errors).toBe(1);
  });

  it('trackCall times an async fn, records success, preserves the resolved value', async () => {
    const s = new Stats();
    const r = await trackCall(s, 'query', async () => 'hello');
    expect(r).toBe('hello');
    const v = s.snapshot().verbs.query!;
    expect(v.count).toBe(1);
    expect(v.errors).toBe(0);
    expect(v.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('trackCall records an async rejection AND re-throws it', async () => {
    const s = new Stats();
    await expect(
      trackCall(s, 'boom', async () => {
        throw new Error('async-nope');
      }),
    ).rejects.toThrow('async-nope');
    const v = s.snapshot().verbs.boom!;
    expect(v.count).toBe(1);
    expect(v.errors).toBe(1);
  });

  it('is silent on stderr by default; emits one structured JSON line per record when KCRIB_LOG=1', () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // Cast to a capture sink — restored in finally so a failure can't poison the runner's stderr.
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env.KCRIB_LOG = undefined;
      const s1 = new Stats();
      s1.record('context', 1.2, false);
      expect(lines.length).toBe(0); // default: NO stderr (determinism — no clock drift on stderr)

      process.env.KCRIB_LOG = '1';
      s1.record('context', 3.4, false);
      s1.record('impact', 0.7, true);
      expect(lines.length).toBe(2); // one JSON line per recorded call
      const a = JSON.parse(lines[0]!);
      const b = JSON.parse(lines[1]!);
      expect(a.verb).toBe('context');
      expect(a.error).toBe(false);
      expect(typeof a.ts).toBe('number'); // the only non-deterministic field, opt-in only
      expect(typeof a.ms).toBe('number');
      expect(b.verb).toBe('impact');
      expect(b.error).toBe(true);
    } finally {
      process.stderr.write = orig;
      process.env.KCRIB_LOG = undefined;
    }
  });
});
