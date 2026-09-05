/**
 * Recall must never go SILENT about staged memory.
 *
 * Reported from real use: a developer told their agent to remember a working convention. The agent
 * called `memory_observe`, got `ok: true`, and reported success. Every later `brief` and
 * `memory_recall` for that exact convention came back with an empty `memories` list — so the
 * developer concluded, reasonably, that crib's memory does not work.
 *
 * Nothing was lost. `memory_observe` stages an UNTRUSTED candidate and normal recall excludes
 * untrusted claims by design — that gate is correct and stays. The defect was that recall reported
 * the exclusion as an absence: no count, no reason, no next step. A trust gate the user cannot see
 * is indistinguishable from a broken store.
 *
 * These tests pin the honesty, not the gate: the claim's CONTENT still never leaks into `memories`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { MemoryStore, __resetMemoryLockGuardForTest } from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-pending-notice';

let repo: string;
let home: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let local: MemoryStore;
let verbs: Verbs;

const CLAIM = 'Consult Knowledge Crib before answering repository questions';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-pending-'));
  home = mkdtempSync(join(tmpdir(), 'crib-pending-home-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const value = 1;\n');
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.commit(NOW);
  writeFileSync(
    join(repo, '.crib', 'crib.json'),
    JSON.stringify({ repo: { id: REPO_ID, root: '.' } }),
  );
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  local = MemoryStore.local(REPO_ID, {
    repoRoot: repo,
    env: { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home },
    now: () => NOW,
  });
  __resetMemoryLockGuardForTest();
  verbs = new Verbs({ soul, index, repoRoot: repo, memory: { local } });
});
afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Stage one candidate through the same verb an agent would call. */
function observe(): Record<string, unknown> {
  return verbs.memoryObserve({
    kind: 'convention',
    subject: 'topic:crib-first',
    claim: CLAIM,
    evidence: [
      // An agent RELAYING what the user said. It has no terminal, so it supplies no `tty` —
      // crib stamps the attestation itself at `crib memory admit`, from the real terminal.
      { kind: 'human-attestation', quote: 'The user asked for this policy directly.' },
    ],
    actor: 'user',
    authorKind: 'human',
    tool: 'test',
    scopeBoundary: 'repo',
  });
}

describe('staged-candidate visibility', () => {
  it('memory_observe says the claim is NOT yet recallable and names the next step', () => {
    const ack = observe();
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('pending');
    // The acknowledgement an agent relays to a human must not imply retrievability.
    expect(ack.recallable).toBe(false);
    expect(String(ack.nextAction)).toMatch(/crib memory activate/);
  });

  it('memory_recall reports the staged count instead of an unexplained empty result', () => {
    observe();
    const result = verbs.memoryRecall({ q: 'Knowledge Crib repository questions' });
    // The gate holds: the untrusted claim is NOT in the trusted group.
    expect(result.memories).toEqual([]);
    const notice = result.pendingNotice as { count: number; nextAction: string } | undefined;
    expect(notice, 'an empty recall over staged memory must explain itself').toBeDefined();
    expect(notice?.count).toBeGreaterThan(0);
    expect(notice?.nextAction).toMatch(/includePending|activate/);
  });

  it('brief — the first call the protocol prescribes — carries the same notice', () => {
    observe();
    const result = verbs.brief({ q: 'Knowledge Crib repository questions' });
    expect(result.memories).toEqual([]);
    expect((result.pendingNotice as { count: number } | undefined)?.count).toBeGreaterThan(0);
  });

  it('leaks no claim CONTENT through the notice — it is a count and a next step', () => {
    observe();
    const result = verbs.memoryRecall({ q: 'Knowledge Crib repository questions' });
    expect(JSON.stringify(result.pendingNotice)).not.toContain(CLAIM);
  });

  it('still returns the content on explicit includePending, unchanged', () => {
    observe();
    const result = verbs.memoryRecall({
      q: 'Knowledge Crib repository questions',
      includePending: true,
    });
    expect(result.memories).toEqual([]);
    expect(JSON.stringify(result.pending)).toContain('Knowledge Crib');
    // The opt-in path returns the candidates themselves, so the notice would be noise.
    expect(result.pendingNotice).toBeUndefined();
  });

  it('adds nothing to the response when nothing is staged', () => {
    const result = verbs.memoryRecall({ q: 'a query matching no staged candidate' });
    expect(result.pendingNotice).toBeUndefined();
    expect(
      verbs.brief({ q: 'a query matching no staged candidate' }).pendingNotice,
    ).toBeUndefined();
  });
});
