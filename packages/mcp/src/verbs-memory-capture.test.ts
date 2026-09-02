/**
 * P0.2 — `memory{op:'capture'}`: automatic episodic capture to the candidate tier.
 *
 * The fixture mirrors verbs-memory.test.ts + grounding.test.ts: a real `src/auth.ts` on disk so the
 * auto-anchor rehydrates actual span text. The `login` symbol's span (lines 10-11) rehydrates to:
 *     "  login(user, pass) {\n    return issue(user, pass);"
 * so a capture naming `login` must ground against exactly that text.
 *
 * Exit-gate invariants pinned here:
 *   • a capture writes a CANDIDATE-trust record (pending, never in normal recall);
 *   • `includePending` is the only surface that shares it (stamped untrusted);
 *   • the auto-anchored source-quote evidence carries the LIVE node's targetHash;
 *   • authorship.actor/.tool are recorded from day one (per-agent filtering);
 *   • an unresolvable or ambiguous symbol never fails the capture — anchorStatus reports it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryCandidate,
  MemoryStore,
  __resetMemoryLockGuardForTest,
} from '@knowledge-crib/memory';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryDeps } from './verbs.js';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-verbs-cap';

const loginId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.login',
  startLine: 10,
});
const loginHash = contentHash('AuthService.login');
/** The rehydrated login span, trimmed — exactly what the auto-anchor must lift as its quote. */
const LOGIN_SPAN = 'login(user, pass) {\n    return issue(user, pass);';

let repo: string;
let home: string;
let regDir: string;
let env: NodeJS.ProcessEnv;
let soul: SoulStore;
let index: SqliteIndexStore;
let local: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-cap-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // lines 1-8 blank, line 9 `class AuthService {`, lines 10-11 the login body, line 12 `  }`, line 13 `}`.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
}
`,
  );
  home = mkdtempSync(join(tmpdir(), 'mem-cap-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'mem-cap-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();

  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.putNodes([
    {
      id: idFor({ kind: 'file', path: 'src/auth.ts' }),
      kind: 'file',
      file: 'src/auth.ts',
      hash: contentHash('src/auth.ts'),
    },
    {
      id: loginId,
      kind: 'symbol',
      type: 'method',
      name: 'login',
      qualifiedName: 'AuthService.login',
      file: 'src/auth.ts',
      span: { start: 10, end: 11 },
      lang: 'typescript',
      hash: loginHash,
    },
  ]);
  soul.commit(NOW);
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: repo });
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
});

function verbs(): Verbs {
  const mem: MemoryDeps = { local };
  return new Verbs({ soul, index, repoRoot: repo, memory: mem });
}

function candidates(): MemoryCandidate[] {
  return local.readCollection('candidates').entries as MemoryCandidate[];
}

describe('memoryCapture', () => {
  it('writes a candidate-trust record (pending, kind defaults to fact)', () => {
    const res = verbs().memoryCapture({
      subject: 'sym:src/auth.ts#AuthService.login',
      observation: 'attempted the login retry fix; it went fine',
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(res.status).toBe('pending');
    expect(res.origin).toBe('observe');
    expect(typeof res.id).toBe('string');
    expect((res.id as string).startsWith('cand:')).toBe(true);
    // no symbols/files supplied → nothing to anchor, but the write still happened
    expect(res.anchorStatus).toBe('unanchored');
    const [cand] = candidates();
    expect(cand?.id).toBe(res.id);
    expect(cand?.kind).toBe('fact');
    expect(cand?.claim).toBe('attempted the login retry fix; it went fine');
    expect(cand?.origin).toBe('observe');
  });

  it('is idempotent by content id: a repeat capture upserts the same cand: id', () => {
    const v = verbs();
    const a = v.memoryCapture({
      subject: 'topic:login-retry',
      observation: 'the login retry fix went fine',
      actor: 'claude-code',
    }) as Record<string, unknown>;
    const b = v.memoryCapture({
      subject: 'topic:login-retry',
      observation: 'the login retry fix went fine',
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(b.id).toBe(a.id);
    expect(candidates()).toHaveLength(1);
  });

  it('captured records do NOT surface in normal recall but DO appear with includePending', () => {
    const v = verbs();
    v.memoryCapture({
      subject: 'topic:login-retry',
      observation: 'the login retry backoff went fine',
      actor: 'claude-code',
    });
    // normal recall: no trusted records exist, and the candidate must not leak into `memories`
    const normal = v.memoryRecall({ q: 'login retry backoff' }) as Record<string, unknown>;
    expect(normal.memories).toHaveLength(0);
    expect(normal.pending).toBeUndefined();
    // includePending: the shared working set, in its own untrusted group
    const withPending = v.memoryRecall({
      q: 'login retry backoff',
      includePending: true,
    }) as Record<string, unknown>;
    expect(withPending.memories).toHaveLength(0);
    const pending = withPending.pending as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.trust).toBe('untrusted');
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.claim).toBe('the login retry backoff went fine');
  });

  it('auto-anchors a resolvable symbol to a source-quote evidence item with the live targetHash', () => {
    const res = verbs().memoryCapture({
      subject: 'topic:login-retry',
      observation: 'changed the login signature handling',
      symbols: ['login'],
      files: ['src/auth.ts'],
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(res.anchorStatus).toBe('anchored');
    // symbols resolve first, then files — both resolved ids are reported as anchors
    expect(res.anchors).toEqual([loginId, idFor({ kind: 'file', path: 'src/auth.ts' })]);
    expect(res.evidenceAttached).toBe(true);
    const [cand] = candidates();
    // the resolved soul ids are the claim's reattachment targets
    expect(cand?.appliesTo).toContain(loginId);
    expect(cand?.appliesTo).toContain(idFor({ kind: 'file', path: 'src/auth.ts' }));
    const ev = cand?.evidence[0] as Record<string, unknown>;
    expect(ev.kind).toBe('source-quote');
    expect(ev.verdict).toBe('valid');
    expect(ev.soulId).toBe(loginId);
    // the quote was lifted verbatim from the rehydrated span…
    expect(ev.quote).toBe(LOGIN_SPAN);
    // …and the anchor carries the LIVE node hash, so revalidation can detect drift
    expect(ev.targetHash).toBe(loginHash);
    expect(ev.startLine).toBe(10);
  });

  it('records authorship.actor and authorship.tool so per-agent filtering works from day one', () => {
    verbs().memoryCapture({
      subject: 'topic:login-retry',
      observation: 'the login retry backoff went fine',
      actor: 'claude-code',
      tool: 'claude-code',
    });
    const [cand] = candidates();
    expect(cand?.authorship.actor).toBe('claude-code');
    expect(cand?.authorship.tool).toBe('claude-code');
    expect(cand?.authorship.kind).toBe('agent');
    // and the pending-recall view attributes the observation to that actor
    const v = verbs();
    const withPending = v.memoryRecall({ q: 'login retry', includePending: true }) as Record<
      string,
      unknown
    >;
    const pending = withPending.pending as Array<{ actor?: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.actor).toBe('claude-code');
  });

  it('capture with an unresolvable symbol still succeeds, reporting anchorStatus unresolvable', () => {
    const res = verbs().memoryCapture({
      subject: 'topic:login-retry',
      observation: 'tried to touch NoSuchSymbol but it is gone',
      symbols: ['NoSuchSymbol'],
      files: ['src/missing.ts'],
      actor: 'codex',
    }) as Record<string, unknown>;
    expect(res.status).toBe('pending');
    expect(res.anchorStatus).toBe('unresolvable');
    expect(res.evidenceAttached).toBe(false);
    expect(res.unresolvable).toEqual(['NoSuchSymbol', 'src/missing.ts']);
    // the candidate is still written, with the raw refs as its best-available pointers
    const [cand] = candidates();
    expect(cand?.appliesTo).toEqual(['NoSuchSymbol', 'src/missing.ts']);
    expect(cand?.evidence).toHaveLength(0);
    expect((cand?.meta as { anchorStatus?: string })?.anchorStatus).toBe('unresolvable');
  });

  it('an ambiguous symbol (several simple-name matches) is reported, never guessed', () => {
    soul.putNodes([
      {
        id: idFor({ kind: 'symbol', path: 'src/a.ts', qualifiedName: 'A.retry', startLine: 1 }),
        kind: 'symbol',
        type: 'method',
        name: 'retry',
        qualifiedName: 'A.retry',
        file: 'src/a.ts',
        span: { start: 1, end: 1 },
        lang: 'typescript',
        hash: contentHash('A.retry'),
      },
      {
        id: idFor({ kind: 'symbol', path: 'src/b.ts', qualifiedName: 'B.retry', startLine: 1 }),
        kind: 'symbol',
        type: 'method',
        name: 'retry',
        qualifiedName: 'B.retry',
        file: 'src/b.ts',
        span: { start: 1, end: 1 },
        lang: 'typescript',
        hash: contentHash('B.retry'),
      },
    ]);
    soul.commit(NOW);
    const res = verbs().memoryCapture({
      subject: 'topic:retry',
      observation: 'looked at retry, could not tell which one',
      symbols: ['retry'],
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(res.status).toBe('pending');
    expect(res.anchorStatus).toBe('ambiguous');
    expect(res.ambiguous).toEqual(['retry']);
    expect(res.anchors).toBeUndefined();
    // nothing was guessed: no anchor id and no evidence from either candidate node
    expect(res.evidenceAttached).toBe(false);
    const [cand] = candidates();
    expect(cand?.appliesTo).toEqual([]);
    expect(cand?.evidence).toHaveLength(0);
  });

  it('degrades to { memory: "not configured" } when no local store is wired', () => {
    const v = new Verbs({ soul, index, repoRoot: repo });
    const res = v.memoryCapture({
      subject: 'topic:x',
      observation: 'loose observation',
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(res.memory).toBe('not configured');
  });

  it('refuses an invalid kind, a missing observation, and a missing actor (validation mirrors observe)', () => {
    const v = verbs();
    const badKind = v.memoryCapture({
      subject: 'topic:x',
      observation: 'o',
      kind: 'rumor',
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(badKind.ok).toBe(false);
    expect(typeof badKind.error).toBe('string');
    // the missing-field cases are runtime-validation paths — the typed signature requires the
    // field, so the deliberately-under-specified calls go through a cast (the verb re-checks).
    const loose = (a: Record<string, unknown>) =>
      v.memoryCapture(a as Parameters<Verbs['memoryCapture']>[0]) as Record<string, unknown>;
    const noObservation = loose({ subject: 'topic:x', actor: 'claude-code' });
    expect(noObservation.ok).toBe(false);
    expect(noObservation.error).toBe('observation is required');
    const noActor = loose({ subject: 'topic:x', observation: 'o' });
    expect(noActor.ok).toBe(false);
    expect(noActor.error).toBe('actor is required');
    expect(candidates()).toHaveLength(0);
  });
});
