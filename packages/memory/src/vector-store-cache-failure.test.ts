/**
 * WP1 defect D1-i — the vector cache failed in complete silence.
 *
 * `MemoryVectorStore` is fail-OPEN by design, and that design is right: it is a derived read model,
 * so a broken cache must cost time and never correctness. The defect was not the fail-open — it was
 * that NOTHING could tell a working cache from one that had stopped working. Three separate paths
 * swallowed their error outright:
 *
 *   1. the read path's catch → `return this.embedAll(...)`;
 *   2. the write-back's catch → `try { ROLLBACK } catch {}`, where the inner catch hid even the
 *      failure of the undo it claimed to attempt, so `COMMIT`, a failed `COMMIT`, and "BEGIN never
 *      ran" were indistinguishable to every caller;
 *   3. `size()` and `pruneOrphans()` → `return 0`, which reads as "the cache is empty"/"nothing to
 *      prune" when the truth is "the cache is unreadable".
 *
 * The cost of that silence is measured, not theoretical: this cache exists because embedding the
 * 307-record ledger with `multilingual-e5-large` costs 4,896 ms (see the module doc). A cache that
 * has silently died re-pays that on EVERY recall, for the life of the process, while the ledger
 * still answers correctly — so no assertion anywhere else in the suite would ever go red.
 *
 * WHAT THIS FILE ASSERTS. That every failure is (a) still fail-open for the caller, and (b) reported
 * — through {@link MemoryVectorStore.cacheFailures} and the `onCacheFailure` observer — with a phase
 * naming WHICH step failed, because "the file is corrupt", "the read failed", "the insert failed"
 * and "the commit failed" have four different fixes.
 *
 * WHY THIS TEST INSTRUMENTS `node:sqlite`. The distinction being asserted is invisible after the
 * call returns: a failed `COMMIT` and a successful one both leave `vectorsFor` returning the same
 * complete map. The only place the difference exists is in the statements the store issued, so the
 * `DatabaseSync` constructor is wrapped to (a) record every statement and (b) fail exactly the ones
 * a test names. The wrapper holds a REAL `:memory:` database and delegates everything else
 * unchanged, so the schema, the statements, the rows and the transaction semantics are all real —
 * only the one faulted step is simulated.
 *
 * DISCRIMINATION. Against the pre-fix bodies these tests go red on the assertions that matter: the
 * silent write-back catch yields `cacheFailures() === 0` and an empty observer log (verified by
 * restoring that body; see docs/program/evidence-register.md row WP1-D1i).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The faults to inject, and every statement the store issued while they were armed. */
const trace = vi.hoisted(() => ({
  /** Statement texts (upper-cased) that `exec` must throw on, e.g. `['COMMIT']`. */
  failExec: [] as string[],
  /** When true, every prepared statement's `get` throws. */
  failGet: false,
  /** When true, every prepared statement's `all` throws (the path `pruneOrphans` reads through). */
  failAll: false,
  /** When true, every prepared statement's `run` throws. */
  failRun: false,
  /** Every `exec` the store issued, in order — so the ORDER of BEGIN/COMMIT is assertable. */
  statements: [] as string[],
}));

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();

  /** A real `:memory:` database that can be told to fail one named step. */
  class FaultInjectingDatabase {
    private readonly inner: InstanceType<typeof actual.DatabaseSync>;

    constructor(path: string) {
      this.inner = new actual.DatabaseSync(path);
    }

    exec(sql: string): void {
      const upper = sql.trim().toUpperCase();
      trace.statements.push(upper);
      if (trace.failExec.includes(upper)) throw new Error(`EIO: simulated ${upper} failure`);
      this.inner.exec(sql);
    }

    prepare(sql: string): StatementSync {
      const stmt = this.inner.prepare(sql);
      return {
        get: (...args: unknown[]): unknown => {
          if (trace.failGet) throw new Error('EIO: simulated read failure');
          return (stmt.get as (...a: unknown[]) => unknown)(...args);
        },
        all: (...args: unknown[]): unknown => {
          if (trace.failAll) throw new Error('EIO: simulated scan failure');
          return (stmt.all as (...a: unknown[]) => unknown)(...args);
        },
        run: (...args: unknown[]): unknown => {
          if (trace.failRun) throw new Error('EIO: simulated write failure');
          return (stmt.run as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as StatementSync;
    }

    close(): void {
      this.inner.close();
    }
  }

  return {
    ...actual,
    DatabaseSync: FaultInjectingDatabase as unknown as typeof actual.DatabaseSync,
  };
});

// Imported AFTER the mock declaration (vitest hoists the factory above every import).
const { CharNgramEmbedder } = await import('@knowledge-crib/core');
const { MemoryVectorStore } = await import('./vector-store.js');

const DIM = 32;
const EMBEDDER_ID = 'char-ngram-test';
const TEXT_VERSION = 'record-semantic-text-v1';

/** A tiny real embedder: deterministic, dependency-free, and no model call to wait on. */
const embedder = new CharNgramEmbedder({ dim: DIM });

const TARGETS = [
  { id: 'mem:aaa', text: 'the recall path prefers evidence over recency' },
  { id: 'mem:bbb', text: 'a durable write flushes before it renames' },
];

let root = '';
/** Every failure the store reported through `onCacheFailure`, in order. */
let observed: Array<{ phase: string; error: unknown; attempted: number }> = [];

function newStore(dbPath: string): InstanceType<typeof MemoryVectorStore> {
  return new MemoryVectorStore({
    dbPath,
    embedderId: EMBEDDER_ID,
    textVersion: TEXT_VERSION,
    dim: DIM,
    onCacheFailure: (failure) => observed.push(failure),
  });
}

/** A store backed by a real file, so its rows genuinely outlive one call. */
function fileStore(): InstanceType<typeof MemoryVectorStore> {
  return newStore(join(root, 'vectors', 'memory-vectors.sqlite'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-vector-cache-'));
  observed = [];
  trace.failExec.length = 0;
  trace.failGet = false;
  trace.failAll = false;
  trace.failRun = false;
  trace.statements.length = 0;
});

afterEach(() => {
  trace.failGet = false;
  trace.failAll = false;
  trace.failRun = false;
  rmSync(root, { recursive: true, force: true });
});

/** Assert the caller got every vector, i.e. the read stayed fail-open. */
function expectComplete(out: Map<string, Float32Array>): void {
  expect([...out.keys()].sort()).toEqual(['mem:aaa', 'mem:bbb']);
  for (const vec of out.values()) expect(vec).toHaveLength(DIM);
}

describe('vector cache failures are reported, never silent', () => {
  it('reports a failed COMMIT, and the caller would otherwise have taken a false success', () => {
    const store = fileStore();
    trace.failExec.push('COMMIT');

    const out = store.vectorsFor(TARGETS, embedder);

    // Fail-open is intact: the read is correct even though the cache did not keep the result.
    expectComplete(out);
    // …but the failure is now visible, and names the step.
    expect(store.cacheFailures()).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.phase).toBe('commit');
    expect(observed[0]?.attempted).toBe(2);
    // The proof that "success" would have been a lie: nothing was persisted, so the NEXT call pays
    // the model again. Pre-fix this whole test was unreachable — there was nothing to assert on.
    expect(store.size()).toBe(0);
    // The undo really ran, in order: BEGIN, COMMIT (failed), ROLLBACK.
    expect(trace.statements).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT', 'ROLLBACK']));
  });

  it('distinguishes a failed ROLLBACK from a clean one — the outcome a caller most needs to hear', () => {
    const store = fileStore();
    trace.failExec.push('COMMIT', 'ROLLBACK');

    const out = store.vectorsFor(TARGETS, embedder);

    expectComplete(out);
    expect(observed).toHaveLength(1);
    // Not 'commit': the write failed AND the undo failed, which leaves the store in the state the
    // transaction was meant to clear. Reporting 'commit' here would understate it.
    expect(observed[0]?.phase).toBe('rollback');
  });

  it('reports a failed insert as `write`, with how many rows it got through first', () => {
    const store = fileStore();
    trace.failRun = true;

    const out = store.vectorsFor(TARGETS, embedder);

    expectComplete(out);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.phase).toBe('write');
    expect(observed[0]?.attempted).toBe(1); // the first insert threw; the second never ran
    expect(store.size()).toBe(0);
  });

  it('reports a cache that cannot be OPENED, rather than passing for an empty one', () => {
    // A regular file where the directory should be: `mkdirSync` fails, so `handle()` never returns.
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const store = newStore(join(blocker, 'vectors', 'memory-vectors.sqlite'));

    const out = store.vectorsFor(TARGETS, embedder);

    expectComplete(out); // still fail-open
    expect(observed).toHaveLength(1);
    // 'open', not 'read': nothing was ever prepared, and that is the difference between a corrupt
    // file (delete it) and a bad query (fix the code).
    expect(observed[0]?.phase).toBe('open');
    expect(observed[0]?.attempted).toBe(0);
    expect(store.cacheFailures()).toBe(1);
  });

  it('reports a failed read on a cache that DID open as `read`', () => {
    const store = fileStore();
    store.vectorsFor(TARGETS, embedder); // warm: opens the handle, persists both rows
    expect(store.cacheFailures()).toBe(0);
    expect(store.size()).toBe(2);

    trace.failGet = true;
    const out = store.vectorsFor(TARGETS, embedder);

    expectComplete(out);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.phase).toBe('read'); // the handle exists, so this is not an open failure
  });

  it('does not report a healthy cache — the signal is not simply always on', () => {
    const store = fileStore();

    const first = store.vectorsFor(TARGETS, embedder);
    const second = store.vectorsFor(TARGETS, embedder); // all hits; no write-back attempted

    expectComplete(first);
    expectComplete(second);
    expect(store.cacheFailures()).toBe(0);
    expect(observed).toEqual([]);
    expect(store.size()).toBe(2);
  });

  it('counts the two zero-returning paths as failures, not as "empty" and "nothing to prune"', () => {
    const store = fileStore();
    store.vectorsFor(TARGETS, embedder);
    expect(store.size()).toBe(2);
    trace.failGet = true; // the path `size()` reads through
    trace.failAll = true; // …and the one `pruneOrphans` reads through

    // Every id is dead, so a WORKING cache would return 2 here. `0` is truthful about rows removed
    // and silent about the reason — which was the whole defect.
    expect(store.pruneOrphans(new Set<string>())).toBe(0);
    expect(store.size()).toBe(0);

    expect(store.cacheFailures()).toBe(2);
    expect(observed.map((f) => f.phase)).toEqual(['read', 'read']);
  });

  it('cannot be broken by an observer that throws — the read it observes is unaffected', () => {
    const store = new MemoryVectorStore({
      dbPath: ':memory:',
      embedderId: EMBEDDER_ID,
      textVersion: TEXT_VERSION,
      dim: DIM,
      onCacheFailure: () => {
        throw new Error('observer is broken');
      },
    });
    trace.failExec.push('COMMIT');

    const out = store.vectorsFor(TARGETS, embedder);

    expectComplete(out);
    expect(store.cacheFailures()).toBe(1); // counted BEFORE the observer was handed the failure
  });
});
