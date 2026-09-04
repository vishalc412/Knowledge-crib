import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type CaptureOutboxEntry,
  type MemoryCandidate,
  MemoryStore,
  buildCaptureOutboxEntry,
  captureRetryCount,
  memoryCandidateId,
  pendingCaptures,
  readCaptureOutboxEntry,
  stageCaptureOutboxEntry,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * G2.3 — `crib memory distill --provider <name>` end-to-end. Drives the BUILT `dist/cli.js` as a
 * subprocess against a temp repo with a bootstrapped soul + repo.id, so the real arg parsing →
 * provider resolution → `runProviderBatch` with the distill verify callback → the crib-locked
 * apply phase (durable result FIRST, outbox done LAST) runs for real.
 *
 * The fixture provider branches on the capture claim: an "unverifiable" capture gets a CONFLICT
 * decision with NO citation (rejected by verification as a per-item failure — a retry append,
 * never an application), everything else gets an ADD (verified → staged as an untrusted
 * candidate). This is the drain loop's resumability contract, asserted at the same boundary the
 * enrich loop's e2e uses: a per-item failure does NOT abort the batch (the good entry still
 * applies in the same batch), the failed entry stays pending and re-offered, and the zero-progress
 * marker stops a re-offer of the SAME unchanged queue BEFORE any provider exec or retry churn
 * (the marker persists by design — the within-run stuck-loop guard, cross-run).
 *
 * Providers come ONLY from a temp `--providers-file` and the memory stores are relocated via
 * KCRIB_MEMORY_DIR into a temp home — neither `~/.crib/providers.json` nor the real `~/.crib`
 * is ever touched.
 *
 * NOTE: requires the BUILT `@knowledge-crib/memory` + `@knowledge-crib/mcp` + cli dists (the CLI
 * imports the compiled packages). Rebuild before running this file alone: `pnpm -r run build`.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-distill-e2e';

const GOOD_CLAIM = 'the deploy cache is enabled for the release pipeline';
const BAD_CLAIM = 'an unverifiable capture the provider cannot cite anything against';

/**
 * A provider that ADDs every capture EXCEPT the unverifiable one, which it CONFLICTs WITHOUT a
 * citation — the exact shape the verifier must reject (an uncited conflict is never applied).
 */
const MIXED_FIXTURE = `let buf = '';
process.stdin.on('data', (c) => { buf += c.toString(); });
process.stdin.on('end', () => {
  let item;
  try { item = JSON.parse(buf); } catch { process.exit(3); }
  const tid = item.targetId;
  const claim = item.seed.capture.claim;
  if (claim.includes('unverifiable')) {
    process.stdout.write(JSON.stringify({ targetId: tid, decision: { decision: 'CONFLICT', rationale: 'no citation offered' } }));
    return;
  }
  process.stdout.write(JSON.stringify({ targetId: tid, decision: { decision: 'ADD', rationale: 'a new observation worth staging' } }));
});
`;

let repo: string;
let home: string;
let cribDir: string;
let providersFile: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-distill-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memory-distill-home-'));
  cribDir = join(repo, '.crib');
  // bootstrap .crib: persist a soul (graph/manifest.json) so the CLI's openSoul resolves, then the
  // locator crib.json with a stable repo.id (same fixture shape as memory-recall.test.ts — the
  // distill loop needs the soul root + repoId, not the graph content).
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  soul.commit(NOW);
  writeFileSync(cribJson(), `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`);

  const providerPath = join(repo, 'mixed.mjs');
  writeFileSync(providerPath, MIXED_FIXTURE);
  providersFile = join(repo, 'providers.json');
  writeFileSync(
    providersFile,
    JSON.stringify({ providers: { mixed: { command: [process.execPath, providerPath] } } }),
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function cribJson(): string {
  return join(cribDir, 'crib.json');
}

function env(): NodeJS.ProcessEnv {
  return { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO_ID, { repoRoot: repo, env: env() });
}

/** Stage a pending capture into the local outbox (the queue row the distill loop drains). */
function seedCapture(claim: string): CaptureOutboxEntry {
  const entry = buildEntry(claim);
  stageCaptureOutboxEntry(localStore(), entry);
  return entry;
}

function buildEntry(claim: string): CaptureOutboxEntry {
  return buildCaptureOutboxEntry(
    {
      kind: 'fact',
      subject: 'topic:distill-e2e',
      claim,
      scope: { boundary: 'repo', repoId: REPO_ID },
      appliesTo: [],
      evidence: [],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
      origin: 'observe',
      idempotencyKey: `k-${claim}`,
    },
    NOW,
  );
}

function runDistill(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, 'memory', 'distill', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: env(),
    });
    return { status: 0, stdout: out.trim(), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
    };
  }
}

describe('crib memory distill — arg surface', () => {
  it('refuses to run without --provider', () => {
    const r = runDistill([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--provider');
  });
});

describe('crib memory distill — the drain loop', () => {
  it('applies the verified ADD and records the unverifiable CONFLICT as a per-item failure in ONE batch', () => {
    const good = seedCapture(GOOD_CLAIM);
    const bad = seedCapture(BAD_CLAIM);

    const r = runDistill(['--provider', 'mixed', '--providers-file', providersFile]);
    // The per-item failure did NOT abort the run: the batch applied the good entry and moved on.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('applied=1 failed=1');
    expect(r.stdout).toContain(`distill: ${good.id} → add`);

    const store = localStore();
    // The verified ADD staged an untrusted candidate whose id is the content id of the claim…
    const candidates = store.readCollection('candidates').entries as MemoryCandidate[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(
      memoryCandidateId({
        kind: 'fact',
        subject: 'topic:distill-e2e',
        claim: GOOD_CLAIM,
        scope: { boundary: 'repo', repoId: REPO_ID },
        appliesTo: [],
        evidence: [],
        authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
      }),
    );
    expect(candidates[0]?.meta?.distilledFrom).toBe(good.id);
    // …and the good entry is done AFTER that durable write (apply ordering), with its decision.
    const doneGood = readCaptureOutboxEntry(store, good.id);
    expect(doneGood?.status).toBe('done');
    expect(doneGood?.meta?.distillVerified).toBe(true);
    // The uncited CONFLICT was never applied: no second candidate, the entry stayed pending, and
    // exactly one retry was appended (dead-letter is B's limit, not this failure's).
    expect(readCaptureOutboxEntry(store, bad.id)?.status).toBe('pending');
    expect(captureRetryCount(store, bad.id)).toBe(1);
    expect(pendingCaptures(store).map((e) => e.id)).toEqual([bad.id]);
  });

  it('re-offers the failed entry on the next run (one more retry), then the zero-progress marker stops the churn', () => {
    seedCapture(BAD_CLAIM);

    // Run 1: the single entry fails → nothing lands → the marker records this exact queue state.
    const first = runDistill(['--provider', 'mixed', '--providers-file', providersFile]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('applied=0 failed=1');

    // Run 2: the SAME queue state is stopped BEFORE the provider is re-executed — no retry churn.
    const second = runDistill(['--provider', 'mixed', '--providers-file', providersFile]);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('zero-progress');
    const store = localStore();
    expect(captureRetryCount(store, seedCapture(BAD_CLAIM).id)).toBe(1);
    expect(readCaptureOutboxEntry(store, seedCapture(BAD_CLAIM).id)?.status).toBe('pending');
  });

  it('a redrain of a drained outbox is a no-op with a stable candidate id (idempotent by content)', () => {
    const entry = seedCapture(GOOD_CLAIM);
    const store = localStore();

    const first = runDistill(['--provider', 'mixed', '--providers-file', providersFile]);
    expect(first.status).toBe(0);
    const candidates = store.readCollection('candidates').entries as MemoryCandidate[];
    const candidateId = candidates[0]?.id;
    expect(candidateId).toBeDefined();

    // Re-staging the SAME capture content re-derives the same cap: id — but the entry is already
    // done, so the durable enqueue is a no-op (a terminal entry is never rewound to pending).
    const restaged = stageCaptureOutboxEntry(store, buildEntry(GOOD_CLAIM));
    expect(restaged.status).toBe('done');

    const second = runDistill(['--provider', 'mixed', '--providers-file', providersFile]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('capture outbox empty');
    const after = store.readCollection('candidates').entries as MemoryCandidate[];
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(candidateId);
    expect(readCaptureOutboxEntry(store, entry.id)?.status).toBe('done');
  });
});
