/**
 * Unit tests for the leak classifier.
 *
 * The module's docstring claimed these existed ("Pure — unit-tested over synthetic series in
 * leak-check.test.mjs") while the file did not, and the untested rule turned out to be unable to
 * detect the very shape it was written for: a steady per-cycle leak. Synthetic series are the whole
 * point here — a leak gate that can only be exercised by running a real workload is a gate whose
 * logic nobody has ever actually checked.
 */
import assert from 'node:assert/strict';
import {
  LEAK_MULTIPLE,
  LEAK_NOISE_FLOOR_BYTES,
  LEAK_RISING_FRACTION,
  classifyLeakSeries,
  gcAvailable,
} from './leak-check.mjs';

const MB = 1024 * 1024;
const series = (n, start, perCycle) => [...Array(n)].map((_, i) => start * MB + i * perCycle * MB);

// ─── the shape the gate exists to catch ──────────────────────────────────────
{
  // A textbook leak: constant retention every cycle. Under the previous rule this scored 90 MB
  // against a threshold of 10 × its own first delta (100 MB) and passed — for ANY rate, because
  // linear growth over N samples is (N−1)·d and the bar was N·d.
  const linear = series(10, 100, 10);
  const verdict = classifyLeakSeries(linear);
  assert.equal(verdict.verdict, 'fail');
  assert.equal(verdict.growthBytes, 90 * MB);
  assert.equal(verdict.risingFraction, 1);
  // The tolerance no longer scales with the leak's own rate, so a faster leak cannot hide better.
  assert.equal(verdict.thresholdBytes, LEAK_MULTIPLE * LEAK_NOISE_FLOOR_BYTES);
  const faster = classifyLeakSeries(series(10, 100, 40));
  assert.equal(faster.verdict, 'fail');
  assert.equal(faster.thresholdBytes, verdict.thresholdBytes);
}

// ─── the shapes that must NOT fire ───────────────────────────────────────────
{
  // One-time retention then flat: bounded, so not a leak however large the step.
  const step = [100, 100, 100, 100, 100, 190, 190, 190, 190, 190].map((x) => x * MB);
  const oneStep = classifyLeakSeries(step);
  assert.equal(oneStep.verdict, 'pass');
  assert.equal(oneStep.growthBytes, 90 * MB, 'the growth is real; it is the trend that is absent');
  assert.ok(oneStep.risingFraction < LEAK_RISING_FRACTION);

  // GC/scheduler noise that happens to end high. This is the shape that turned a launch cell red:
  // 50 MB of "growth" with no trend behind it.
  const noise = [100, 140, 90, 150, 85, 130, 95, 145, 88, 150].map((x) => x * MB);
  assert.equal(classifyLeakSeries(noise).verdict, 'pass');

  // Flat, and shrinking, and small drift under the floor.
  assert.equal(classifyLeakSeries(series(10, 100, 0)).verdict, 'pass');
  assert.equal(classifyLeakSeries(series(10, 200, -5)).verdict, 'pass');
  assert.equal(classifyLeakSeries(series(10, 100, 1)).verdict, 'pass', 'sustained but under floor');
}

// ─── boundaries ──────────────────────────────────────────────────────────────
{
  assert.equal(classifyLeakSeries([]).verdict, 'insufficient');
  assert.equal(classifyLeakSeries([1, 2]).verdict, 'insufficient');
  assert.equal(classifyLeakSeries('nope').verdict, 'insufficient');
  // A shrinking series reports no threshold at all rather than a bar it was never measured against.
  assert.equal(classifyLeakSeries(series(5, 200, -10)).thresholdBytes, 0);
  // Exactly at the tolerance is a pass; one byte over, with the trend, is a fail.
  const floor = LEAK_MULTIPLE * LEAK_NOISE_FLOOR_BYTES;
  const atFloor = [0, floor / 3, (floor * 2) / 3, floor];
  assert.equal(classifyLeakSeries(atFloor).verdict, 'pass');
  assert.equal(classifyLeakSeries([...atFloor.slice(0, 3), floor + 1]).verdict, 'fail');
  // Options are honoured, so a caller can tighten the gate without editing the module.
  assert.equal(
    classifyLeakSeries(series(10, 100, 1), { noiseFloorBytes: 0.5 * MB }).verdict,
    'fail',
  );
}

// ─── the measurement must know whether it can trust itself ───────────────────
// The samples are only retention if something collected first. This was the actual production bug:
// `global.gc?.()` under a plain `node` invocation was a permanent no-op, so every sample carried
// uncollected garbage and two runs of the same work reported -63 MB and +59 MB.
assert.equal(gcAvailable(), true, 'a collector must be reachable without a CLI flag');

process.stdout.write('leak-check tests ok\n');
