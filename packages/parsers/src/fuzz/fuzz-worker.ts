/**
 * M3.5 parser fuzzing — WORKER entry. Runs in a `worker_threads` isolate spawned by the fuzz
 * harness (extractor-fuzz.ts). One worker handles many inputs over its lifetime for one extractor.
 *
 * WHY A WORKER (not Promise.all / in-process) — the load-bearing reason for M3.5. A sync parse hang
 * (the PL/SQL `recover()` infinite-loop class) BLOCKS the event loop: a `Promise.race` timeout
 * can't fire, `fast-check`'s `interruptAfterTimeLimit` can't fire, the whole fuzz run just stops.
 * The ONLY way to catch a per-input hang is a separate OS thread whose `terminate()` the main thread
 * fires on a `setTimeout` budget. So each extract runs here; if it hangs, the main thread terminates
 * this worker, records the hang WITH the exact triggering input, respawns, and continues. This is the
 * "terminates in budget" gate with real teeth — the property the plan row names.
 *
 * Protocol:
 *   in  {kind:'init',   extractorName}          → build the extractor by name, post {kind:'ready'}
 *   in  {kind:'extract', idx, text}             → run extract + validate, post {kind:'result',...}
 *   in  {kind:'shutdown'}                       → close + exit
 *
 * The worker resolves `extractorName` against the 9 shipped extractors PLUS three TEST-ONLY fakes
 * (hang / throw / invalid) so the detector's regression test can prove the harness catches each
 * failure class. Production fuzz-check never sends a fake name.
 *
 * DETERMINISM — the worker is pure: it builds a fresh extractor + fuzz ctx per input, runs extract,
 * validates the returned nodes/edges, and posts the outcome. It never touches the soul or the
 * filesystem. Random inputs are generated on the MAIN thread (deterministic seeded fast-check) and
 * sent in, so a hang reproducer is an exact (extractorName, text) pair the main thread records.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { Node } from '@knowledge-crib/soul-schema';
import type { ExtractResult, Extractor, FileMeta } from '../types.js';
import { makeFuzzCtx } from './fuzz-ctx.js';
import { FUZZ_EXTRACTORS } from './fuzz-extractors.js';
import { validateFuzzResult } from './fuzz-validate.js';

// --- TEST-ONLY fake extractors — prove the harness detects each failure class. ----------------
// Reachable only by explicit name ('__fuzz_fake_hang' etc.); never shipped to production fuzz.
class HangExtractor implements Extractor {
  name = '__fuzz_fake_hang';
  supports() {
    return true;
  }
  // Catastrophic infinite loop — the recover() class. Never returns; the main thread must terminate.
  async extract(): Promise<ExtractResult> {
    // eslint-disable-next-line no-constant-binary-expression
    while (true) {
      // spin — a sync hang the event loop cannot interrupt
    }
  }
}
class ThrowExtractor implements Extractor {
  name = '__fuzz_fake_throw';
  supports() {
    return true;
  }
  async extract(): Promise<ExtractResult> {
    throw new Error('fuzz fake: extractor threw (contract violation — must degrade, not throw)');
  }
}
class InvalidExtractor implements Extractor {
  name = '__fuzz_fake_invalid';
  supports() {
    return true;
  }
  async extract(): Promise<ExtractResult> {
    // Malformed node: kind not in NodeKind → the validator must flag it 'invalid'.
    const bad = { id: '', kind: 'not-a-real-kind', hash: '' } as unknown as Node;
    return { nodes: [bad], edges: [] };
  }
}

const FAKES: Record<string, () => Extractor> = {
  __fuzz_fake_hang: () => new HangExtractor(),
  __fuzz_fake_throw: () => new ThrowExtractor(),
  __fuzz_fake_invalid: () => new InvalidExtractor(),
};

function buildExtractor(name: string): Extractor | null {
  const fake = FAKES[name];
  if (fake) return fake();
  const spec = FUZZ_EXTRACTORS.find((s) => s.name === name);
  return spec ? new spec.ctor() : null;
}

function extFor(name: string): string {
  const spec = FUZZ_EXTRACTORS.find((s) => s.name === name);
  return spec?.ext ?? '.fuzz';
}

type InMsg =
  | { kind: 'init'; extractorName: string }
  | { kind: 'extract'; idx: number; text: string }
  | { kind: 'shutdown' };

let extractor: Extractor | null = null;
let ext = '.fuzz';

if (parentPort) {
  parentPort.on('message', async (msg: InMsg) => {
    if (msg.kind === 'init') {
      extractor = buildExtractor(msg.extractorName);
      ext = extFor(msg.extractorName);
      if (!extractor) {
        parentPort!.postMessage({
          kind: 'error',
          message: `unknown extractor: ${msg.extractorName}`,
        });
        return;
      }
      parentPort!.postMessage({ kind: 'ready' });
      return;
    }
    if (msg.kind === 'extract') {
      if (!extractor) {
        parentPort!.postMessage({
          kind: 'result',
          idx: msg.idx,
          outcome: 'throw',
          reason: 'no extractor',
        });
        return;
      }
      const file: FileMeta = { path: `fuzz${msg.idx}${ext}`, bytes: msg.text.length, mtime: 0 };
      const ctx = makeFuzzCtx(msg.text);
      try {
        const res = await extractor.extract(file, ctx);
        const v = validateFuzzResult(res);
        parentPort!.postMessage(
          v.ok
            ? { kind: 'result', idx: msg.idx, outcome: 'ok' }
            : { kind: 'result', idx: msg.idx, outcome: 'invalid', reason: v.reason },
        );
      } catch (err) {
        // Contract violation: extract() must degrade to empty, never throw. Record it.
        const reason = err instanceof Error ? err.message : String(err);
        parentPort!.postMessage({ kind: 'result', idx: msg.idx, outcome: 'throw', reason });
      }
      return;
    }
    if (msg.kind === 'shutdown') {
      parentPort!.close();
      process.exit(0);
    }
  });
}

// `workerData` unused but referenced to keep the worker_threads import stable across build configs.
void workerData;
