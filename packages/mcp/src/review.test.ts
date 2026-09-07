/**
 * `review` — the one call a code review needs.
 *
 * Reported from real use: "I gave something to review, and my model read ten lines and predicted
 * what was happening." Measured on this repository, that behaviour is rational — reading the files
 * a commit touches costs ~165k tokens, so the honest version of the task does not fit and the model
 * does the dishonest version instead. Composing the answer from the graph costs ~2k.
 *
 * The tests below pin the three things that made the first two drafts of this verb useless or
 * misleading, each of which was found by running it rather than by reasoning about it:
 *   - it returned 5,156 "changed symbols" for a six-file change, because every assignment and
 *     statement in a touched file is a node;
 *   - it ranked a trivial local helper called `flag` first, because documentation sections that
 *     merely mention a word are incoming edges too;
 *   - an empty caller list must never read as "unused".
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import type { Edge, Rel } from '@knowledge-crib/soul-schema';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;

/** A vcs adapter reporting a fixed change set — no git process, no wall-clock dependence. */
function vcsReporting(uncommitted: string[], head = 'a'.repeat(40)) {
  return {
    currentHead: () => head,
    changedFilesSince: () => [],
    uncommittedChanges: () => uncommitted,
  };
}

const FILE = 'src/billing.ts';
const symId = (name: string, line: number) =>
  idFor({ kind: 'symbol', path: FILE, qualifiedName: name, startLine: line });
const CHARGE = symId('charge', 1);
const INVOICE = symId('invoice', 6);
const REFUND = symId('refund', 7);
const ORPHAN = symId('orphan', 8);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-review-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, FILE),
    [
      'export function charge(amount) { return amount * 1.1; }',
      '',
      '',
      '',
      '',
      'export function invoice(a) { return charge(a); }',
      'export function refund(a) { return charge(a) * -1; }',
      'export function orphan() { return 0; }',
      '',
    ].join('\n'),
  );
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  const sym = (id: string, name: string, start: number) => ({
    id,
    kind: 'symbol' as const,
    type: 'function',
    name,
    qualifiedName: name,
    file: FILE,
    span: { start, end: start },
    lang: 'typescript',
    hash: contentHash(name),
  });
  soul.putNodes([
    { id: idFor({ kind: 'file', path: FILE }), kind: 'file', file: FILE, hash: contentHash(FILE) },
    sym(CHARGE, 'charge', 1),
    sym(INVOICE, 'invoice', 6),
    sym(REFUND, 'refund', 7),
    sym(ORPHAN, 'orphan', 8),
    // A behaviour node inside `charge` — the kind that flooded the first draft of this verb.
    {
      id: `assign:${FILE}@L1`,
      kind: 'assignment' as const,
      file: FILE,
      span: { start: 1, end: 1 },
      hash: contentHash('assign1'),
    },
    // A doc section that merely MENTIONS charge — an incoming edge that is not a caller.
    {
      id: 'doc:README.md#billing',
      kind: 'doc-section' as const,
      file: 'README.md',
      hash: contentHash('doc'),
    },
  ]);
  const edge = (src: string, dst: string, rel: Rel): Edge => ({
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
  });
  soul.putEdges([
    edge(INVOICE, CHARGE, 'calls'),
    edge(REFUND, CHARGE, 'calls'),
    edge('doc:README.md#billing', CHARGE, 'describes'),
  ]);
  soul.setVcsHead('a'.repeat(40));
  soul.commit(NOW);
  writeFileSync(
    join(repo, '.crib', 'crib.json'),
    JSON.stringify({ repo: { id: 'r-review', root: '.' } }),
  );
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
});
afterEach(() => {
  index.close();
  rmSync(repo, { recursive: true, force: true });
});

const reviewOf = (uncommitted: string[], args: Record<string, unknown> = {}) =>
  new Verbs({ soul, index, repoRoot: repo, vcs: vcsReporting(uncommitted) }).review(args);

describe('review', () => {
  it('expands DECLARATIONS, never the assignments and statements inside them', () => {
    // The defect that made the first draft unusable: `changedSymbols` counts every node in a
    // touched file, so the whole budget went on `assign:…@L1009` entries.
    const out = reviewOf([FILE]);
    const symbols = out.symbols as Array<{ id: string; kind: string }>;
    expect(symbols.length).toBeGreaterThan(0);
    for (const s of symbols) expect(s.kind).toBe('symbol');
    expect(symbols.some((s) => s.id.startsWith('assign:'))).toBe(false);
    // Both counts are reported, because they answer different questions.
    expect(out.changedNodeCount as number).toBeGreaterThan(out.changedSymbolCount as number);
  });

  it('names the callers a diff cannot show', () => {
    const symbols = reviewOf([FILE]).symbols as Array<{
      name?: string;
      callers: { id: string }[];
    }>;
    const charge = symbols.find((s) => s.name === 'charge');
    expect(charge, 'the changed function should be reviewed').toBeDefined();
    const callerIds = (charge?.callers ?? []).map((c) => c.id).join(' ');
    expect(callerIds).toContain('invoice');
    expect(callerIds).toContain('refund');
  });

  it('LABELS an empty caller list instead of implying the symbol is unused', () => {
    // Dynamic dispatch, property access and cross-language calls all produce this same emptiness.
    // Presenting it as "unused" is how a reviewer talks themselves into deleting live code.
    const symbols = reviewOf([FILE]).symbols as Array<{
      name?: string;
      callers: unknown[];
      callersNote?: string;
    }>;
    const orphan = symbols.find((s) => s.name === 'orphan');
    expect(orphan?.callers).toEqual([]);
    expect(orphan?.callersNote).toMatch(/NOT evidence the symbol is unused/);
  });

  it('ranks the most-depended-upon symbol first — that is where a mistake propagates', () => {
    const symbols = reviewOf([FILE], { limit: 2 }).symbols as Array<{ name?: string }>;
    expect(symbols[0]?.name).toBe('charge');
  });

  it('reports truncation rather than presenting a page as the whole change', () => {
    const out = reviewOf([FILE], { limit: 1 });
    expect((out.symbols as unknown[]).length).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it('propagates a degraded change set verbatim — an empty result with a note is not "clean"', () => {
    const verbs = new Verbs({ soul, index, repoRoot: repo }); // no vcs adapter at all
    const out = verbs.review({});
    expect(out.note).toBe('vcs adapter not configured');
    expect(out.symbols).toEqual([]);
  });

  it('is deterministic — the same inputs produce the same response', () => {
    // No wall clock may enter the payload, or `ifHash` could never collapse a repeat call.
    expect(JSON.stringify(reviewOf([FILE]))).toBe(JSON.stringify(reviewOf([FILE])));
  });
});
