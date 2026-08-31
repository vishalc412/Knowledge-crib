/**
 * P0 bench corpus — deterministic scenario builders. NO randomness: every record, node, and query
 * is derived from an index with fixed content, so two runs of the same scale produce byte-identical
 * ids and labels (the benchmark must satisfy the determinism discipline it benchmarks).
 *
 * The fake soul mirrors the `evaluator.test.ts` port shape (in-memory node map + per-node rehydrate
 * text) but ALSO wires `findByLocator` through the real `bestLocatorMatches`, so the refactor-survival
 * scenario exercises the actual reattachment scoring, not a stub.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type { MemoryRecordKind } from '../enums.js';
import type { MemoryEvalContext, MemorySoulPort } from '../evaluator.js';
import { memoryCandidateId, memoryRecordId } from '../ids.js';
import { type StableLocator, bestLocatorMatches } from '../locator.js';
import type { MemoryCandidate, MemoryEvidence, MemoryRecord } from '../types.js';

/** A schema-valid `blake3:<hex>` content hash derived deterministically from a bench tag. The
 *  memory-1 record schema enforces `^blake3:[0-9a-f]+$`, so fixtures cannot hand-wave hashes. */
export function benchHash(tag: string): string {
  return `blake3:${blake3Hex(`bench:${tag}`)}`;
}

// ─── a fake-but-faithful soul port ───────────────────────────────────────────

/** Build a soul-schema `Node` with the defaults the bench relies on (file + span + hash). */
export function benchNode(partial: Partial<Node> & { id: string; kind: string }): Node {
  return {
    hash: benchHash('live'),
    file: 'src/a.ts',
    span: { start: 1, end: 100 },
    ...partial,
  } as Node;
}

/**
 * An in-memory {@link MemorySoulPort} over a node array. `findByLocator` runs the REAL
 * {@link bestLocatorMatches} over the full node list — the same O(n) scan `SoulStoreSoulPort` does
 * via `soul.iterate()` — so scenario (e)'s latency numbers include real reattachment cost.
 */
export class FakeSoulPort implements MemorySoulPort {
  private nodes: readonly Node[];
  private readonly byId: Map<string, Node>;
  private texts: ReadonlyMap<string, string>;

  constructor(nodes: readonly Node[], texts: ReadonlyMap<string, string> = new Map()) {
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.texts = texts;
  }

  /** Replace the node set + texts in place (the scenario-b "evolve the soul" step). */
  setNodes(nodes: readonly Node[], texts: ReadonlyMap<string, string>): void {
    this.nodes = nodes;
    this.byId.clear();
    for (const n of nodes) this.byId.set(n.id, n);
    this.texts = texts;
  }

  getNode(id: string): Node | undefined {
    return this.byId.get(id);
  }

  rehydrate(node: Node) {
    const text = this.texts.get(node.id) ?? node.name ?? '';
    return {
      text,
      truncated: false,
      totalLines: text.split('\n').length,
      startLine: node.span?.start ?? 1,
    };
  }

  findByLocator(locator: StableLocator): Node[] {
    return bestLocatorMatches(this.nodes, locator);
  }
}

/** An evaluation context over a {@link FakeSoulPort} (no receipts / policy — the recall-common case). */
export function fakeEvalCtx(soul: MemorySoulPort): MemoryEvalContext {
  return { soul };
}

// ─── record + candidate builders (mirror evaluator.test.ts's builders) ──────

const BENCH_NOW = '2026-06-01T00:00:00.000Z';
const BENCH_REPO = 'bench-repo';
const BENCH_ACTOR = 'bench-agent';

/** Source-quote evidence item anchored to a soul node (the self-verifying default). */
export function quoteEvidence(soulId: string, quote: string, targetHash: string): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: BENCH_NOW,
    soulId,
    quote,
    targetHash,
  };
}

export interface BenchRecordOpts {
  kind?: MemoryRecordKind;
  subject: string;
  claim: string;
  appliesTo?: string[];
  evidence?: MemoryEvidence[];
  repoId?: string;
  trust?: MemoryRecord['verdicts']['trust'];
  createdAt?: string;
  actor?: string;
}

/**
 * Build a schema-valid, content-addressed {@link MemoryRecord}. Verdicts are stamped optimistic
 * (`valid/current/active`) exactly like promotion stamps them; the evaluator recomputes at read
 * time. Named `buildBenchRecord` (vs promotion's `buildRecord`) because both export from the
 * package barrel.
 */
export function buildBenchRecord(opts: BenchRecordOpts): MemoryRecord {
  const subject = opts.subject;
  const evidence = opts.evidence ?? [quoteEvidence(subject, opts.claim, benchHash('bench'))];
  const input = {
    kind: opts.kind ?? ('fact' as const),
    subject,
    claim: opts.claim,
    scope: { boundary: 'repo' as const, repoId: opts.repoId ?? BENCH_REPO },
    appliesTo: opts.appliesTo ?? [subject],
    evidence,
    authorship: { actor: opts.actor ?? BENCH_ACTOR, kind: 'agent' as const },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: opts.trust ?? 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: opts.createdAt ?? BENCH_NOW,
  };
}

export interface BenchCandidateOpts extends Omit<BenchRecordOpts, 'trust' | 'createdAt'> {}

/** Build a schema-valid {@link MemoryCandidate} for the trust-gradient scenarios. */
export function buildBenchCandidate(opts: BenchCandidateOpts): MemoryCandidate {
  const input = {
    kind: opts.kind ?? ('fact' as const),
    subject: opts.subject,
    claim: opts.claim,
    scope: { boundary: 'repo' as const, repoId: opts.repoId ?? BENCH_REPO },
    appliesTo: opts.appliesTo ?? [opts.subject],
    evidence: opts.evidence ?? [],
    authorship: { actor: opts.actor ?? BENCH_ACTOR, kind: 'agent' as const },
  };
  return {
    id: memoryCandidateId(input),
    schemaVersion: '1',
    ...input,
    origin: 'observe',
    proposedAt: BENCH_NOW,
  };
}
