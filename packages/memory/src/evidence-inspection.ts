/**
 * Evidence inspection — the display-safe explanation of ONE evidence item on a memory record, for
 * the viz inspector (UI remediation Phase 4). PURE over its ports: the caller supplies node and
 * receipt lookups, so this module never touches a store, a file, or a path the browser chose.
 *
 * Redaction boundary (never crossed):
 *   - receipts are summarized to id, run time, HEAD, exit code, output DIGEST and the allowlisted
 *     named assertions — never executable/argv, the worktree digest, raw output, or `meta`;
 *   - a source location is an indexed node id plus the file/span the index recorded for it; the
 *     excerpt itself is read by the serving layer through its guarded node-id reader;
 *   - a saved quote is labelled as SAVED — currentness comes from the live index, and a quote whose
 *     node moved, changed, or vanished says so instead of passing for current source.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import type { EvidenceKind, EvidenceVerdict } from './enums.js';
import { type LedgerAnchorState, correlateAnchor } from './ledger.js';
import type { GateReceipt, MemoryEvidence } from './types.js';

/** A sanitized receipt: enough to explain a gate run, nothing that could carry its output. */
export interface ReceiptSummary {
  id: string;
  ranAt: string;
  head: string;
  exitCode: number;
  outputDigest: string;
  assertions: readonly { name: string; passed: boolean }[];
}

/** Where an anchored item points in the CURRENT index, and whether that is still what was checked. */
export interface EvidenceLocation {
  /** the node id the evidence recorded. */
  ref: string;
  state: LedgerAnchorState;
  /** the node to read now: `ref` when current, the reattached node when moved; absent otherwise. */
  readableNodeId?: string;
  file?: string;
  span?: { start: number; end: number };
  /** true when the indexed node's hash differs from the hash the check recorded. */
  changedSinceCheck?: boolean;
}

export type EvidenceDetail =
  | {
      kind: 'source-quote';
      savedQuote?: string;
      savedStartLine?: number;
      location: EvidenceLocation | null;
    }
  | {
      kind: 'execution-assertion';
      assertion?: string;
      receiptId?: string;
      receipt: ReceiptSummary | null;
      /** the named assertion's outcome in the receipt; `not-recorded` when the receipt lacks it. */
      outcome: 'passed' | 'failed' | 'not-recorded';
    }
  | {
      kind: 'committed-policy';
      artifactId?: string;
      anchor?: string;
      location: EvidenceLocation | null;
    }
  | {
      kind: 'human-attestation';
      attestedBy?: string;
      attestedAt?: string;
      attestationId?: string;
      /** recorded from an interactive terminal (`tty`), rather than supplied programmatically. */
      interactive: boolean;
    }
  | {
      kind: 'receipt-pair';
      failingReceiptId?: string;
      passingReceiptId?: string;
      failing: ReceiptSummary | null;
      passing: ReceiptSummary | null;
      /** failing ran strictly before passing; null when either receipt is missing. */
      ordered: boolean | null;
    };

export interface EvidenceInspection {
  recordId: string;
  index: number;
  total: number;
  kind: EvidenceKind;
  verdict: EvidenceVerdict;
  checkedAt: string;
  reason?: string;
  detail: EvidenceDetail;
}

export type EvidenceInspectionResult = ({ found: true } & EvidenceInspection) | { found: false };

/** The lookups inspection needs; all are read-only and resolved by the caller's authority. */
export interface EvidenceInspectionPorts {
  byId: ReadonlyMap<string, Node>;
  nodes: readonly Node[];
  findReceipt(id: string): GateReceipt | undefined;
}

export function summarizeReceipt(receipt: GateReceipt): ReceiptSummary {
  return {
    id: receipt.id,
    ranAt: receipt.ts,
    head: receipt.head,
    exitCode: receipt.exitCode,
    outputDigest: receipt.outputDigest,
    assertions: receipt.assertions.map((a) => ({
      name: String(a.name),
      passed: a.passed === true,
    })),
  };
}

function locate(
  ref: string | undefined,
  targetHash: string | undefined,
  ports: EvidenceInspectionPorts,
): EvidenceLocation | null {
  if (!ref) return null;
  const anchor = correlateAnchor(ref, ports.byId, ports.nodes);
  const readable =
    anchor.state === 'current' ? ref : anchor.state === 'moved' ? anchor.nowAt : undefined;
  const node = readable ? ports.byId.get(readable) : undefined;
  return {
    ref,
    state: anchor.state,
    ...(readable ? { readableNodeId: readable } : {}),
    ...(node?.file ? { file: node.file } : {}),
    ...(node?.span ? { span: { start: node.span.start, end: node.span.end } } : {}),
    ...(node && targetHash && node.hash ? { changedSinceCheck: node.hash !== targetHash } : {}),
  };
}

function receiptOf(id: string | undefined, ports: EvidenceInspectionPorts): ReceiptSummary | null {
  if (!id) return null;
  const receipt = ports.findReceipt(id);
  return receipt ? summarizeReceipt(receipt) : null;
}

/** Explain one evidence item (see the module doc for what is and is not disclosed). PURE. */
export function inspectEvidenceItem(
  ev: MemoryEvidence,
  ports: EvidenceInspectionPorts,
): EvidenceDetail {
  switch (ev.kind) {
    case 'source-quote':
      return {
        kind: 'source-quote',
        ...(typeof ev.quote === 'string' ? { savedQuote: ev.quote } : {}),
        ...(typeof ev.startLine === 'number' ? { savedStartLine: ev.startLine } : {}),
        location: locate(ev.soulId, ev.targetHash, ports),
      };
    case 'execution-assertion': {
      const receipt = receiptOf(ev.receiptId, ports);
      const named = receipt?.assertions.find((a) => a.name === ev.assertion);
      return {
        kind: 'execution-assertion',
        ...(ev.assertion ? { assertion: ev.assertion } : {}),
        ...(ev.receiptId ? { receiptId: ev.receiptId } : {}),
        receipt,
        outcome: named ? (named.passed ? 'passed' : 'failed') : 'not-recorded',
      };
    }
    case 'committed-policy':
      return {
        kind: 'committed-policy',
        ...(ev.artifactId ? { artifactId: ev.artifactId } : {}),
        ...(ev.anchor ? { anchor: ev.anchor } : {}),
        location: locate(ev.artifactId, ev.targetHash, ports),
      };
    case 'human-attestation':
      return {
        kind: 'human-attestation',
        ...(ev.actor ? { attestedBy: ev.actor } : {}),
        ...(ev.attestedAt ? { attestedAt: ev.attestedAt } : {}),
        ...(ev.attestationId ? { attestationId: ev.attestationId } : {}),
        interactive: ev.tty === true,
      };
    case 'receipt-pair': {
      const failing = receiptOf(ev.failingReceiptId, ports);
      const passing = receiptOf(ev.passingReceiptId, ports);
      return {
        kind: 'receipt-pair',
        ...(ev.failingReceiptId ? { failingReceiptId: ev.failingReceiptId } : {}),
        ...(ev.passingReceiptId ? { passingReceiptId: ev.passingReceiptId } : {}),
        failing,
        passing,
        ordered: failing && passing ? Date.parse(failing.ranAt) < Date.parse(passing.ranAt) : null,
      };
    }
  }
}
