import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetMemoryLockGuardForTest } from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGraphCorpusEvaluation } from './graph-eval.js';

/**
 * The harness itself is pinned here — shape, determinism, and the isolation invariants that must
 * hold at ANY retrieval quality. The ≥90% evidence-path threshold is NOT asserted: it is a launch
 * gate applied to a receipt by the launch decision, and a unit test that asserted it would turn a
 * measured negative result into a red build instead of a recorded NO-GO.
 */
let workA: string;
let workB: string;

beforeEach(() => {
  __resetMemoryLockGuardForTest();
  workA = mkdtempSync(join(tmpdir(), 'crib-graph-eval-a-'));
  workB = mkdtempSync(join(tmpdir(), 'crib-graph-eval-b-'));
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(workA, { recursive: true, force: true });
  rmSync(workB, { recursive: true, force: true });
});

describe('runGraphCorpusEvaluation', () => {
  it('measures the frozen corpus with zero foreign disclosure, deterministically', async () => {
    const first = runGraphCorpusEvaluation({ workDir: workA });
    // Each run is one long synchronous block. Yield between them: vitest's worker RPC times out
    // ("Timeout calling onTaskUpdate") when its reply cannot be read for 60s, which two back-to-back
    // runs reached on slow Windows runners although every assertion passed.
    await new Promise((resolve) => setImmediate(resolve));
    __resetMemoryLockGuardForTest();
    const second = runGraphCorpusEvaluation({ workDir: workB });

    expect(first.corpusVersion).toBe(1);
    expect(first.questions).toBe(129);
    expect(first.multiHopQuestions).toBe(117);
    expect(first.unauthorizedPaths).toBe(0);
    expect(first.unavailableAnswers).toBe(0);
    expect(first.byFamily.isolation?.meanRecall).toBe(1);
    expect(first.evidencePathRecall).toBeGreaterThan(0);
    expect(first.evidencePathRecall).toBeLessThanOrEqual(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 60_000);
});
