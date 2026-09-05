/**
 * F02 (docs/audits/2026-09-05) — the freshness queue must not lose ACKNOWLEDGED work.
 *
 * The audit forked 8 post-commit writers against one registry and found that most calls returned
 * successfully while their queue entry had vanished: `enqueueFreshness` performed an unlocked
 * read-modify-write of the whole queue, so concurrent producers clobbered each other. The repair is
 * a lock around the complete read-modify-write; the underlying mutual-exclusion defect lived in
 * `CribLock` itself (see packages/core/src/lock-concurrency.test.ts).
 *
 * "Acknowledged" is the contract under test: a call that RETURNS has committed durable state. Every
 * project key here is distinct, so nothing may be explained away as intended coalescing — a
 * shortfall is lost work. The children import the compiled `dist` build (`pretest` produces it).
 */
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFreshnessQueue } from './freshness.js';

const PRODUCERS = 8;
const TASKS_PER_PRODUCER = 25;
const EXPECTED_TOTAL = PRODUCERS * TASKS_PER_PRODUCER;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(packageRoot, 'dist', 'freshness.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-freshness-conc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One post-commit producer: enqueue TASKS_PER_PRODUCER distinct projects, report what returned. */
function producerSource(): string {
  return `
import { enqueueFreshness } from ${JSON.stringify(pathToFileURL(distEntry).href)};
const [registry, prefix] = process.argv.slice(2);
process.send('ready');
process.on('message', () => {
  const acknowledged = [];
  const errors = [];
  for (let i = 0; i < ${TASKS_PER_PRODUCER}; i += 1) {
    const root = prefix + '-' + i;
    try {
      enqueueFreshness(root, 'head-' + i, { KCRIB_REGISTRY_DIR: registry });
      acknowledged.push(root);
    } catch (error) {
      errors.push(String(error && (error.code || error.message)));
    }
  }
  process.send({ acknowledged, errors });
  process.exit(0);
});
`;
}

interface ProducerOutcome {
  acknowledged: string[];
  errors: string[];
}

describe('freshness queue under concurrent producers', () => {
  it('retains every acknowledged enqueue across 8 concurrent post-commit writers', async () => {
    expect(existsSync(distEntry), `build ${distEntry} before running this test`).toBe(true);

    const registry = join(dir, 'registry');
    const producerFile = join(dir, 'producer.mjs');
    writeFileSync(producerFile, producerSource());

    const children = Array.from({ length: PRODUCERS }, (_, i) =>
      fork(producerFile, [registry, `/test/project-${i}`], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    let outcomes: ProducerOutcome[];
    try {
      // Release the producers only once all of them are listening, so the enqueues genuinely
      // overlap rather than serializing behind process startup.
      await Promise.all(
        children.map((c) => new Promise<void>((resolve) => c.once('message', () => resolve()))),
      );
      const settled = children.map(
        (c) =>
          new Promise<ProducerOutcome>((resolve) =>
            c.once('message', (m) => resolve(m as ProducerOutcome)),
          ),
      );
      for (const c of children) c.send('go');
      outcomes = await Promise.all(settled);
    } finally {
      for (const c of children) if (c.exitCode === null) c.kill();
    }

    const acknowledged = outcomes.flatMap((o) => o.acknowledged);
    const errors = outcomes.flatMap((o) => o.errors);
    // A contended enqueue may legitimately fail, but it must then NOT report success. Both halves
    // of the contract are asserted: nothing fails, and nothing acknowledged goes missing.
    expect(errors).toEqual([]);
    expect(acknowledged).toHaveLength(EXPECTED_TOTAL);

    const retained = readFreshnessQueue({ KCRIB_REGISTRY_DIR: registry }).pending;
    const retainedRoots = new Set(retained.map((t) => t.projectRoot));
    const missing = acknowledged.filter((root) => !retainedRoots.has(root));
    expect(missing).toEqual([]);
    expect(retained).toHaveLength(EXPECTED_TOTAL);
  }, 60_000);
});
