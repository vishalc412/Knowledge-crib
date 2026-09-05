import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type CaptureOutboxEntry,
  IntelligenceEventJournal,
  type MemoryCandidate,
  MemoryStore,
  pendingCaptures,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * G2.1 lane 2 — `crib memory capture-hook --event <event>` end-to-end. Drives the BUILT
 * `dist/cli.js` as a subprocess against a temp repo with a bootstrapped soul + repo.id, so the
 * real command the hook writer installs (adapters.ts `captureHookCommand`, pinned by
 * adapters.test.ts) runs: stdin payload → bounded provenance extraction → `MemoryApi.capture`
 * through the same policy-gated stageCandidate funnel every capture lane uses.
 *
 * The contract under test is FAIL-OPEN: a hook fires inside a live coding session and must never
 * block it, so EVERY runtime failure (missing/unknown --event, unparseable payload, unindexed
 * repo) exits 0 with a stderr note — never Claude Code's blocking exit 2. What IS asserted as
 * positive: the staged candidate id (`cand:`), the durable outbox entry (`cap:`), byte-identical
 * idempotent replay (same payload → same ids, one entry), and the raw-transcripts-off law — only
 * session_id and tool_name ever reach storage; transcript paths and tool input are discarded
 * before any capture.
 *
 * The memory stores are relocated via KCRIB_MEMORY_DIR into a temp home — the real `~/.crib` is
 * never touched.
 *
 * NOTE: requires the BUILT `@knowledge-crib/memory` + `@knowledge-crib/mcp` + cli dists (the CLI
 * imports the compiled packages). Rebuild before running this file alone: `pnpm -r run build`.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-capture-hook-e2e';
const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

let repo: string;
let home: string;
let cribDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-capture-hook-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memory-capture-hook-home-'));
  cribDir = join(repo, '.crib');
  // bootstrap .crib: persist a soul (graph/manifest.json) so the CLI's openSoul resolves, then the
  // locator crib.json with a stable repo.id (same fixture shape as memory-distill.test.ts).
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  soul.commit(NOW);
  writeFileSync(cribJson(), `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`);
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

function candidates(): MemoryCandidate[] {
  return localStore().readCollection('candidates').entries as MemoryCandidate[];
}

function outboxEntries(): CaptureOutboxEntry[] {
  return localStore().readCollection('outbox').entries as CaptureOutboxEntry[];
}

function lifecycleEvents() {
  return new IntelligenceEventJournal({ rootDir: join(cribDir, 'intelligence') }).read({
    includeExpired: true,
  });
}

function runHook(
  event: string | undefined,
  stdin: string | undefined,
): { status: number; stdout: string; stderr: string } {
  const args = ['memory', 'capture-hook', ...(event !== undefined ? ['--event', event] : [])];
  // spawnSync (not execFileSync): the fail-open contract exits 0 WITH a stderr note on the
  // diagnostic paths, and execFileSync hides stderr on a successful exit.
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    // stdin: 'pipe' + input drives the real hook wire (Claude Code posts the payload as JSON on
    // stdin); `undefined` input closes stdin empty — a hook that sent nothing.
    input: stdin ?? '',
    maxBuffer: 32 * 1024 * 1024,
    env: env(),
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '')
      .split('\n')
      .filter((l) => !l.includes('ExperimentalWarning') && !l.includes('trace-warnings'))
      .join('\n')
      .trim(),
  };
}

function parseAck(stdout: string): {
  ok: boolean;
  event: string;
  captureId: string;
  status: string;
} {
  return JSON.parse(stdout.split('\n').at(-1) ?? '') as {
    ok: boolean;
    event: string;
    captureId: string;
    status: string;
  };
}

describe('crib memory capture-hook — the fail-open contract', () => {
  it('missing --event, unknown event, and unparseable stdin all exit 0 (never the blocking exit 2)', () => {
    expect(runHook(undefined, undefined)).toMatchObject({ status: 0 });
    expect(runHook('not-an-event', '{}')).toMatchObject({ status: 0 });
    expect(runHook('turn-end', 'not json {')).toMatchObject({ status: 0 });
    // None of them staged anything.
    expect(candidates()).toHaveLength(0);
    expect(outboxEntries()).toHaveLength(0);
  });

  // S6 (docs/bench/security-battery.md) — "byte caps enforced (64KB hook stdin), fail-open contract
  // holds, only whitelisted fields cross into storage". This is the vector with no coverage before
  // the launch audit; it pins the cap's ACTUAL behaviour rather than its intent.
  it('S6: an oversized stdin payload is dropped fail-open, and nothing oversized reaches storage', () => {
    // A payload whose *valid* JSON exceeds CAPTURE_HOOK_STDIN_MAX_CHARS (65536). The command slices
    // to the cap BEFORE JSON.parse, so the slice truncates mid-string and parse throws → the payload
    // degrades to {} → no session provenance, nothing staged. Exit stays 0: a hook never blocks.
    const huge = JSON.stringify({ session_id: SESSION_ID, filler: 'x'.repeat(200_000) });
    expect(huge.length).toBeGreaterThan(65_536);
    const r = runHook('turn-end', huge);
    expect(r.status).toBe(0);
    // the truncated-and-unparseable payload stages nothing — an oversized transcript never lands
    expect(candidates()).toHaveLength(0);
    expect(outboxEntries()).toHaveLength(0);
  });

  it('S6: a payload just under the cap creates only a checkpoint request without an outcome', () => {
    const big = JSON.stringify({ session_id: SESSION_ID, filler: 'x'.repeat(30_000) });
    expect(big.length).toBeLessThan(65_536);
    const r = runHook('turn-end', big);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      event: 'turn-end',
      status: 'checkpoint-requested',
      captured: false,
    });
    const staged = candidates();
    expect(staged).toHaveLength(0);
    expect(outboxEntries()).toHaveLength(0);
    expect(lifecycleEvents()).toHaveLength(1);
    // raw-transcripts-off law: the 30KB filler never reaches storage, only bounded provenance
    expect(JSON.stringify(lifecycleEvents())).not.toContain('xxxxxxxxxx');
  });

  it('an unindexed repo exits 0 with a stderr note (a hook must not block an unindexed session)', () => {
    // Not just crib.json — readRepoId falls back to the soul manifest, so the honest unindexed
    // fixture is a repo with no .crib at all (readRepoId: soul manifest → registry).
    rmSync(cribDir, { recursive: true, force: true });
    const r = runHook('turn-end', JSON.stringify({ session_id: SESSION_ID }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('repoId');
  });
});

describe('crib memory capture-hook — structured outcomes', () => {
  it('turn-end without an outcome records a checkpoint request, never a pseudo-fact', () => {
    const payload = {
      session_id: SESSION_ID,
      transcript_path: '/Users/x/.claude/projects/p/transcript.jsonl',
      hook_event_name: 'Stop',
      cwd: '/Users/x/secret-project',
    };
    const r = runHook('turn-end', JSON.stringify(payload));
    expect(r.status).toBe(0);

    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'checkpoint-requested', captured: false });
    expect(candidates()).toHaveLength(0);
    expect(pendingCaptures(localStore())).toHaveLength(0);
    expect(lifecycleEvents()[0]).toMatchObject({
      kind: 'agent.lifecycle',
      payload: { event: 'turn-end', action: 'checkpoint-requested', hasOutcome: false },
    });
    expect(JSON.stringify(lifecycleEvents())).not.toContain('transcript_path');
  });

  it('captures a client-neutral structured outcome with offsets and artifact references', () => {
    const r = runHook(
      'turn-end',
      JSON.stringify({
        session_id: SESSION_ID,
        client_id: 'codex',
        agent_id: 'principal-engineer',
        event_offset: 42,
        transcript_path: '/private/transcript.jsonl',
        knowledge_crib_outcome: {
          subject: 'topic:freshness-service',
          kind: 'decision',
          intent: 'Keep repository context fresh after commits.',
          decision: 'Use one user-scoped supervised worker.',
          result: 'launchd service definition installed and active.',
          next_action: 'Run the reboot recovery acceptance.',
          artifacts: ['packages/cli/src/freshness-service.ts'],
        },
      }),
    );
    expect(r.status).toBe(0);
    const ack = parseAck(r.stdout);
    expect(ack.status).toBe('pending');
    const staged = candidates();
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      kind: 'decision',
      subject: 'topic:freshness-service',
      appliesTo: ['packages/cli/src/freshness-service.ts'],
    });
    expect(staged[0]?.claim).toContain('Intent: Keep repository context fresh after commits.');
    expect(staged[0]?.claim).toContain('Decision: Use one user-scoped supervised worker.');
    expect(staged[0]?.claim).toContain('Next action: Run the reboot recovery acceptance.');
    const pending = pendingCaptures(localStore());
    expect(pending[0]).toMatchObject({ sessionId: SESSION_ID, eventOffset: 42 });
    expect(JSON.stringify([staged, outboxEntries(), lifecycleEvents()])).not.toContain(
      'transcript',
    );
  });

  it('the same structured outcome and event offset are idempotent', () => {
    const payload = JSON.stringify({
      session_id: SESSION_ID,
      event_offset: 9,
      knowledge_crib_outcome: { result: 'The acceptance run passed.' },
    });
    const first = runHook('session-start', payload);
    expect(first.status).toBe(0);
    const firstAck = parseAck(first.stdout);

    const second = runHook('session-start', payload);
    expect(second.status).toBe(0);
    const secondAck = parseAck(second.stdout);

    expect(secondAck.captureId).toBe(firstAck.captureId);
    expect(candidates()).toHaveLength(1);
    expect(pendingCaptures(localStore())).toHaveLength(1);
  });

  it('different sessions retain provenance while identical outcomes dedupe by content', () => {
    const outcome = { knowledge_crib_outcome: { result: 'The acceptance run passed.' } };
    const a = parseAck(
      runHook('turn-end', JSON.stringify({ ...outcome, session_id: 'sess-a' })).stdout,
    );
    const b = parseAck(
      runHook('turn-end', JSON.stringify({ ...outcome, session_id: 'sess-b' })).stdout,
    );
    // The claim text deliberately excludes the session id, so the content-addressed candidate id
    // is the same — the observation is one fact regardless of which session observed it. The
    // session id lives in the idempotency key, so the DURABLE rows stay distinct (each keeps its
    // own session provenance for the distiller; distillation collapses them at staging).
    expect(a.captureId).toBe(b.captureId);
    const pending = pendingCaptures(localStore());
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((e) => e.id)).size).toBe(2);
    expect(candidates()).toHaveLength(1);
  });

  it('keeps the checkpoint but refuses memory when a requested receipt is not verified', () => {
    const r = runHook(
      'turn-end',
      JSON.stringify({
        session_id: SESSION_ID,
        event_offset: 77,
        knowledge_crib_outcome: {
          result: 'A claimed gate passed.',
          receipt_id: 'receipt:missing',
          assertion: 'release gate',
        },
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('checkpoint recorded, memory skipped');
    expect(candidates()).toHaveLength(0);
    expect(pendingCaptures(localStore())).toHaveLength(0);
    expect(lifecycleEvents()[0]).toMatchObject({
      kind: 'agent.lifecycle',
      payload: { event: 'turn-end', action: 'checkpoint-requested', hasOutcome: true },
    });
  });
});
