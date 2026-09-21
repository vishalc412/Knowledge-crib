/** Produce a deliberately small, auditable developer-launch decision from release evidence. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_RECEIPT_FORMAT_VERSION,
  SUPPORTED_ACCEPTANCE_FORMAT_VERSIONS,
  acceptanceReceiptProblems,
  nodeMajorOf,
} from './acceptance-receipt.mjs';
import {
  CERTIFICATION_EVIDENCE_FORMAT_VERSION,
  CertificationEvidenceError,
  SUPPORTED_CERTIFICATION_FORMAT_VERSIONS,
  bindingProblems,
  certifyClientCell,
  loadClientCertificationReceipts,
} from './client-certification-evidence.mjs';
import {
  evaluateGate,
  loadLaunchPolicy,
  policyClientCells,
  policyFuzzRequirements,
  policyGateIds,
  policyGlobalReceiptTypes,
  policyOsNodeCells,
} from './launch-policy.mjs';
import { ReleaseEvidenceError, validateReleaseEvidence } from './release-evidence.mjs';

/**
 * Recompute launch eligibility from the frozen policy and the manifest's VALIDATED measurements.
 *
 * The audit's A01 finding was that this function read the manifest's own conclusions —
 * `acceptance.pass`, `requiredFailures`, a precomputed missing-cell list, and a
 * `certification.required` switch the evidence itself set. Ordinary non-certifying verification
 * therefore printed GO, and so did a manifest with an empty gate array, a dirty tree, or no model
 * proof. Nothing in an artifact may now select or satisfy its own requirements: the policy says
 * what is required, the manifest supplies measurements, and this function does the judging.
 *
 * Every unknown is a blocker. Absent, skipped, not-run, invalid, mismatched and stale evidence all
 * produce NO-GO with a named reason — silence is never consent.
 *
 * Client certification is CANDIDATE-scoped: the 21 vendor-runtime cells describe the build, not any
 * one OS/Node cell. So it is judged from raw receipts the caller supplies
 * (`options.certificationReceipts`) and NEVER from the summary a manifest copied in — a per-platform
 * manifest that claims a runtime pass the raw receipts do not support is a tampering signal, not
 * coverage. `options.certificationReceipts === null` means "judged at another scope" (the aggregate
 * evaluates it once); `undefined` means "required but never supplied", which is a blocker.
 *
 * @param options.policy       parsed launch policy (defaults to the committed one)
 * @param options.policySha256 the hash the evidence must have been collected under
 * @param options.candidate    {commit, packageSha256} the build being decided
 * @param options.certificationReceipts raw 21-cell receipts, or null to defer to the aggregate
 * @param options.globalReceipts        raw candidate-wide receipts (fuzz-deep), or null to defer
 */
export function evaluateLaunchDecision(evidence, options = {}) {
  const blockers = [];
  const add = (reason) => void blockers.push(reason);

  const loaded = options.policy
    ? { policy: options.policy, sha256: options.policySha256 }
    : loadLaunchPolicy(options.policyPath);
  const policy = loaded.policy;
  const policySha256 = options.policySha256 ?? loaded.sha256;

  if (!evidence || typeof evidence !== 'object') {
    return { decision: 'NO-GO', blockers: ['evidence-missing'], certifying: false };
  }

  // ── the policy's receipt-schema contract agrees with the validators ──────────
  // Version 4 names the receipt schemas that may certify a cell, and the validators this decision
  // loads receipts through are the other half of that contract. A policy that disagrees with them
  // has selected requirements to fit the evidence it can already read — the A02 shape — so the
  // disagreement itself is a blocker, by kind, before any evidence is judged.
  for (const [kind, declared, required] of [
    [
      'acceptance',
      policy.receiptSchemas?.acceptance,
      {
        format: 'knowledge-crib-acceptance-receipt',
        requiredFormatVersion: ACCEPTANCE_RECEIPT_FORMAT_VERSION,
        readableFormatVersions: SUPPORTED_ACCEPTANCE_FORMAT_VERSIONS,
      },
    ],
    [
      'clientCertification',
      policy.receiptSchemas?.clientCertification,
      {
        format: 'knowledge-crib-client-certification',
        requiredFormatVersion: CERTIFICATION_EVIDENCE_FORMAT_VERSION,
        readableFormatVersions: SUPPORTED_CERTIFICATION_FORMAT_VERSIONS,
      },
    ],
  ]) {
    // Field-by-field, not JSON.stringify of the whole object: the policy file is JSON hand-maintained
    // under a frozen byte-hash, and a semantically identical policy whose keys were written in a
    // different order must not read as a contract change. Only the three fields that define the
    // contract are compared — anything else on the object is the policy's own prose.
    const agrees =
      declared?.format === required.format &&
      declared?.requiredFormatVersion === required.requiredFormatVersion &&
      JSON.stringify(declared?.readableFormatVersions) ===
        JSON.stringify(required.readableFormatVersions);
    if (!agrees) add(`policy-receipt-schema-mismatch:${kind}`);
  }

  // Schema 1 predates candidate identity, typed receipts and recorded measurements. It stays
  // readable for diagnostics — an honest historical failure should not become unreadable — but it
  // cannot certify, because the facts a decision must check are not expressible in it.
  const certifying = evidence.formatVersion >= 2;
  if (!certifying) add(`evidence-schema-non-certifying:${evidence.formatVersion ?? 'unknown'}`);

  // ── candidate identity ──────────────────────────────────────────────────────
  const candidate = evidence.candidate ?? {};
  if (candidate.dirty !== false) add('candidate-dirty-or-unknown');
  if (typeof candidate.commit !== 'string' || !candidate.commit) add('candidate-commit-missing');
  if (typeof candidate.packageSha256 !== 'string' || !candidate.packageSha256)
    add('candidate-package-missing');
  if (options.candidate?.commit && candidate.commit !== options.candidate.commit)
    add(`candidate-commit-mismatch:${candidate.commit ?? 'none'}`);
  if (
    options.candidate?.packageSha256 &&
    candidate.packageSha256 !== options.candidate.packageSha256
  )
    add(`candidate-package-mismatch:${candidate.packageSha256 ?? 'none'}`);
  if (policySha256 && candidate.policySha256 !== policySha256)
    add(`policy-mismatch:${candidate.policySha256 ?? 'none'}`);

  // ── the run itself completed ────────────────────────────────────────────────
  if (certifying && evidence.run?.exitCode !== 0)
    add(`run-exit-code:${evidence.run?.exitCode ?? 'unknown'}`);

  // ── semantic model + scorer ─────────────────────────────────────────────────
  const model = evidence.retrieval?.model ?? {};
  if (!model.id || !model.version || !model.manifestSha256) add('semantic-model-proof-missing');
  const supported = policy.semanticModel.supportedScorers;
  if (supported.length > 0 && !supported.includes(evidence.retrieval?.scorer))
    add(`scorer-unsupported:${evidence.retrieval?.scorer ?? 'unknown'}`);

  // ── gates: the EXACT frozen set, re-judged against the policy's own numbers ──
  const gates = Array.isArray(evidence.gates) ? evidence.gates : [];
  const byId = new Map();
  for (const gate of gates) {
    if (byId.has(gate.id)) add(`gate-duplicate:${gate.id}`);
    byId.set(gate.id, gate);
  }
  for (const id of byId.keys()) {
    if (!policyGateIds(policy).includes(id)) add(`gate-unknown:${id}`);
  }
  for (const policyGate of policy.gates) {
    const gate = byId.get(policyGate.id);
    if (!gate) {
      add(`gate-missing:${policyGate.id}`);
      continue;
    }
    // A manifest may not restate the requirement more leniently than the policy froze it.
    if (gate.threshold !== undefined && gate.threshold !== policyGate.threshold)
      add(`gate-threshold-altered:${policyGate.id}`);
    if (gate.comparison !== undefined && gate.comparison !== policyGate.direction)
      add(`gate-direction-altered:${policyGate.id}`);
    const verdict = evaluateGate(policyGate, gate.measured, policy.gateEpsilon);
    if (!verdict.pass) add(`gate-failed:${policyGate.id}:${verdict.reason}`);
    // A pass flag that disagrees with the recomputation is a tampering signal, reported as such
    // even when the recomputation itself passes.
    if (typeof gate.pass === 'boolean' && gate.pass !== verdict.pass)
      add(`gate-contradiction:${policyGate.id}`);
  }

  // ── typed receipts: one shared validator, so every consumer checks every fact ──
  //
  // This loop used to check status, an artifacts array, and — only when present — the commit. It
  // never checked the package identity, the policy digest, the run identity, the actual command
  // exit codes, or the artifact BYTES, and it never checked that the receipt's platform matches the
  // cell it is offered to. All of that now lives in one shared validator
  // (scripts/acceptance-receipt.mjs) so the decision and the evidence reader cannot drift; this
  // loop keeps only the fact the validator cannot know: whether the policy-required type exists.
  const receipts = evidence.receipts ?? {};
  const cellPlatform = evidence.reproducibility?.platform;
  const cell = { os: cellPlatform?.os, nodeMajor: nodeMajorOf(cellPlatform?.node) };
  for (const type of policy.receiptTypes) {
    const receipt = receipts[type];
    if (!receipt) {
      add(`receipt-missing:${type}`);
      continue;
    }
    for (const problem of acceptanceReceiptProblems(receipt, {
      type,
      candidate,
      policySha256,
      policy,
      cell,
      evidenceRoot: options.receiptsEvidenceRoot,
    })) {
      add(problem);
    }
  }

  // ── every advertised client/platform cell, bound to THIS candidate ──────────
  //
  // From RAW receipts, never from `evidence.certification.receipts`. That summary is a manifest
  // restating its own conclusions — the A01 defect — so it is compared against the raw coverage
  // below rather than trusted, and a summary claim the receipts do not support names the cell.
  const rawCertification = options.certificationReceipts;
  if (rawCertification === null) {
    // Candidate-scoped, and this call is a per-OS/Node-cell evaluation: the aggregate owns it so
    // one uncertified client is reported once rather than repeated into all six cell manifests.
  } else if (Array.isArray(rawCertification)) {
    blockers.push(
      ...uncertifiedClientCells(rawCertification, {
        policy,
        policySha256,
        candidate: {
          commit: candidate.commit,
          packageSha256: candidate.packageSha256,
        },
      }),
    );
    const covered = new Set(
      rawCertification.filter((receipt) => certifyClientCell(receipt).ok).map(certificationCellOf),
    );
    for (const claim of evidence.certification?.receipts ?? []) {
      const cell = `${claim?.client?.id}/${claim?.platform?.os}`;
      if (claim?.runtimeStatus === 'pass' && !covered.has(cell)) {
        add(`certification-summary-unsupported:${cell}`);
      }
    }
  } else if (certifying) {
    add('certification-receipts-not-loaded');
  }

  // ── candidate-wide receipts the policy requires (the deep sweep) ────────────
  const rawGlobal = options.globalReceipts;
  if (rawGlobal === null) {
    // Deferred to the aggregate, same as certification.
  } else if (Array.isArray(rawGlobal)) {
    blockers.push(
      ...judgeGlobalReceipts(rawGlobal, {
        policy,
        policySha256,
        candidate: {
          commit: candidate.commit,
          packageSha256: candidate.packageSha256,
        },
        evidenceRoot: options.globalReceiptsRoot,
      }),
    );
  } else if (certifying) {
    add('global-receipts-not-loaded');
  }

  // ── the manifest's own conclusion is compared, never trusted ────────────────
  const recomputedPass = blockers.length === 0;
  if (evidence.acceptance?.pass === true && !recomputedPass) add('acceptance-contradiction');

  return {
    decision: blockers.length === 0 ? 'GO' : 'NO-GO',
    blockers: [...new Set(blockers)],
    certifying,
  };
}

/**
 * The client/platform cells the policy advertises that this candidate cannot show a genuine vendor
 * runtime for — the A02 repair.
 *
 * Coverage comes from `certifyClientCell`, so a receipt only covers a cell when the CURRENT
 * certifying schema produced it, for this exact commit, this exact package, under this policy, at a
 * client version at or above that CELL's floor, carrying all eight legs including a vendor-client
 * handshake, on a native (non-WSL) platform with its transcript still on disk. Anything else leaves
 * the cell open by name.
 *
 * Two kinds of name are produced, because they answer different questions.
 *
 * A BINDING failure is reported whatever else the set contains (`client-receipt-foreign-commit:…`):
 * the receipt is about ANOTHER build, and a reader has to be told that the set they were handed is
 * not the candidate they asked about — even when every policy cell happens to be covered by the
 * receipts that remain.
 *
 * Any other failure is a statement about COVERAGE, and coverage is settled per CELL. A cell another
 * receipt certifies is certified: an extra run for that same cell — a WSL sanity check, an
 * interrupted attempt, a test-client protocol probe — is not part of the promise and must not sink a
 * release that satisfies it. Reporting it anyway would make the decision disagree with the public
 * matrix, which reads this same fact the same way, and would let a diagnostic run permanently block
 * a launch. So the finding is emitted only while its cell is actually open, and then as
 * `client-cell-not-certifying:<cell>:<why>` — never as an absence a reader has to interpret.
 */
export function uncertifiedClientCells(receipts, { policy, policySha256, candidate }) {
  const options = { policy, policySha256, candidate };
  const covered = new Set();
  const uncertified = [];
  for (const receipt of receipts ?? []) {
    const verdict = certifyClientCell(receipt, options);
    if (verdict.ok) covered.add(verdict.cell);
    else uncertified.push({ receipt, verdict });
  }
  const problems = [];
  for (const { receipt, verdict } of uncertified) {
    // One producer for "is this receipt about another build", so the unconditional cases here and
    // the ones `certifyClientCell` refuses can never drift apart.
    if (bindingProblems(receipt, options).length > 0) {
      problems.push(`${verdict.problem}:${verdict.cell}:${verdict.detail ?? 'unknown'}`);
      continue;
    }
    if (covered.has(verdict.cell)) continue;
    problems.push(`client-cell-not-certifying:${verdict.cell}:${verdict.detail ?? 'unknown'}`);
  }
  const missing = policyClientCells(policy)
    .filter((cell) => !covered.has(cell))
    .map((cell) => `client-cell-uncertified:${cell}`);
  return [...new Set([...problems, ...missing])];
}

/** The `client/os` cell a raw receipt speaks for. */
function certificationCellOf(receipt) {
  return `${receipt?.client?.id}/${receipt?.platform?.os}`;
}

/**
 * Candidate-wide receipts the policy requires but that are not produced once per OS/Node cell —
 * today the deep fuzz sweep. `fuzz-deep` is the receipt that says a million seeded inputs per
 * extractor ran against THIS package, so it binds to the candidate exactly as a client receipt does,
 * and its own numbers (workload, seed, iterations, fleet size, failures) are re-judged against the
 * policy rather than read as a verdict.
 */
export function judgeGlobalReceipts(receipts, { policy, policySha256, candidate, evidenceRoot }) {
  const blockers = [];
  const required = policyGlobalReceiptTypes(policy);
  const byType = new Map();
  for (const receipt of receipts ?? []) {
    if (typeof receipt?.type !== 'string') continue;
    // Two receipts of one type used to be last-wins here, which let a stale fuzz-deep from a
    // previous pass silently overwrite the fresh one. A duplicate is named as such and the FIRST
    // one is still judged below — a blocker on the judged receipt is what the operator needs, not
    // a fresh-looking verdict produced by an overwrite.
    if (byType.has(receipt.type)) {
      blockers.push(`global-receipt-duplicate:${receipt.type}`);
      continue;
    }
    byType.set(receipt.type, receipt);
  }
  for (const type of required) {
    const receipt = byType.get(type);
    if (!receipt) {
      blockers.push(`global-receipt-missing:${type}`);
      continue;
    }
    if (receipt.status !== 'pass') {
      blockers.push(`global-receipt-not-passing:${type}:${receipt.status ?? 'unknown'}`);
      continue;
    }
    if (
      candidate.commit &&
      receipt.candidateCommit !== undefined &&
      receipt.candidateCommit !== candidate.commit
    ) {
      blockers.push(`global-receipt-foreign-commit:${type}`);
      continue;
    }
    if (!receipt.candidateCommit) blockers.push(`global-receipt-foreign-commit:${type}`);
    if (
      candidate.packageSha256 &&
      receipt.candidatePackageSha256 !== undefined &&
      receipt.candidatePackageSha256 !== candidate.packageSha256
    ) {
      blockers.push(`global-receipt-foreign-package:${type}`);
      continue;
    }
    if (!receipt.candidatePackageSha256) blockers.push(`global-receipt-foreign-package:${type}`);
    if (policySha256 && receipt.policySha256 !== policySha256) {
      blockers.push(`global-receipt-foreign-policy:${type}`);
      continue;
    }
    const artifacts = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
    if (artifacts.length === 0) {
      blockers.push(`global-receipt-artifact-missing:${type}`);
    } else if (typeof evidenceRoot === 'string' && evidenceRoot.trim()) {
      for (const artifact of artifacts) {
        if (!artifactDigestMatches(resolve(evidenceRoot), artifact)) {
          blockers.push(`global-receipt-artifact-digest:${type}:${artifact?.path ?? 'unknown'}`);
        }
      }
    } else {
      // A receipt whose evidence cannot be located is a claim, not a proof. The receipts directory
      // is what makes the transcript checkable, so its absence is named rather than skipped.
      blockers.push(`global-receipt-artifact-unverifiable:${type}`);
    }
    if (type === 'fuzz-deep') blockers.push(...judgeFuzzWorkload(receipt, policy));
  }
  return blockers;
}

/**
 * Re-judge the sweep's own reported numbers against the frozen policy. A deep receipt is refused by
 * the harness when it is too shallow, but the harness is not the authority on what a launch needs —
 * the policy is, and it is the thing this function reads. The iteration count is compared with the
 * policy's own figure so the number lives in exactly one place.
 */
function judgeFuzzWorkload(receipt, policy) {
  const blockers = [];
  const requirements = policyFuzzRequirements(policy);
  const details = receipt.details ?? {};
  if (details.workload !== requirements.workload) {
    blockers.push(`fuzz-receipt-workload-mismatch:${details.workload ?? 'unknown'}`);
  }
  if (details.seed !== requirements.seed) {
    blockers.push(`fuzz-receipt-seed-mismatch:${details.seed ?? 'unknown'}`);
  }
  if (
    typeof details.iterations !== 'number' ||
    !Number.isFinite(details.iterations) ||
    details.iterations < requirements.requiredIterations
  ) {
    blockers.push(`fuzz-receipt-iterations-below-floor:${details.iterations ?? 'unknown'}`);
  }
  if (
    typeof details.extractorCount !== 'number' ||
    details.extractorCount < requirements.minimumExtractors
  ) {
    blockers.push(`fuzz-receipt-extractors-below-floor:${details.extractorCount ?? 'unknown'}`);
  }
  const failures = Array.isArray(details.failures) ? details.failures : [];
  if (failures.length > 0) blockers.push(`fuzz-receipt-failures:${failures.length}`);
  // The candidate binding (Task 9): a deep receipt must prove WHICH packaged parser bytes
  // executed — details.candidate with the verified parsers package, worker and grammar hashes.
  // Without this backstop, a receipt whose sweep actually ran the checkout build (the harness's
  // binding block deleted or reordered behind the import) could still satisfy every floor above,
  // because candidatePackageSha256 is the hash of the --package tarball bytes on disk regardless
  // of what the sweep imported.
  const candidate = details.candidate;
  if (
    !candidate ||
    typeof candidate.parsersPackageSha256 !== 'string' ||
    typeof candidate.worker?.sha256 !== 'string' ||
    !Array.isArray(candidate.grammars) ||
    candidate.grammars.length === 0 ||
    candidate.isolatedPrefix !== true
  ) {
    blockers.push('fuzz-receipt-unbound-candidate');
  }
  return blockers;
}

/**
 * Verify one archived artifact's digest.
 *
 * A path recorded by the producing run is normally relative to the receipts directory it sits in;
 * an absolute path is honoured as recorded, because the receipt is the producer's statement of where
 * its own evidence is. Either way the file must exist AND hash to what the receipt claimed — that
 * is the property that makes "altering a transcript after receipt generation invalidates the cell"
 * true rather than aspirational.
 */
function artifactDigestMatches(root, artifact) {
  if (typeof artifact?.path !== 'string' || typeof artifact?.sha256 !== 'string') return false;
  const path = resolve(root, artifact.path);
  if (!existsSync(path)) return false;
  const digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  return artifact.sha256 === digest;
}

/** Load the raw certification receipts a decision must judge; a throw is reported, never fatal. */
export function loadCertificationReceiptsOrReport(directory) {
  try {
    return { receipts: loadClientCertificationReceipts(directory) };
  } catch (error) {
    if (error instanceof CertificationEvidenceError) {
      return { receipts: [], blocker: `certification-receipts-unreadable:${error.message}` };
    }
    throw error;
  }
}

/**
 * WP9.1 — load one evidence file through structural validation BEFORE the decision reads
 * acceptance.pass / requiredFailures verbatim. A tampered or omission-ridden manifest throws
 * (ReleaseEvidenceError naming the offending field) instead of yielding a fabricated GO.
 */
export function loadReleaseEvidence(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ReleaseEvidenceError(`unreadable release evidence ${path}: ${error.message}`);
  }
  return validateReleaseEvidence(parsed);
}

/**
 * WP9.4 (aggregation half) — GO only when EVERY cell is GO. A cell whose manifest is missing
 * (null) or fails structural validation blocks the aggregate under a cell-tagged blocker; one
 * green cell never carries a red one. An empty cell set is NO-GO, not a vacuous GO.
 */
/**
 * Partition blockers into the ones that stop a RELEASE and the ones that only stop CERTIFICATION.
 *
 * F17 (decided 2026-09-21): the twenty-one-cell bar stays exactly as frozen, and stays the definition
 * of "certified" — nothing here weakens it. What it stops doing is gating the release, because as
 * written it cannot ever go green: a cell needs a signed-in vendor client on a native host of each
 * platform, and a policy that can only be satisfied by hardware the project does not have is not a
 * quality instrument, it is an indefinite hold. So `GO`/`NO-GO` keeps its exact meaning (fully
 * certified) and a second, weaker verdict is added beside it, rather than redefining the first.
 *
 * The partition is deliberately narrow, and the line is between an ABSENCE and a FALSEHOOD:
 *
 *   • `client-cell-uncertified:<cell>` is release-permissible. It means no receipt exists for that
 *     cell — an honest gap, and one a per-cell support table can state plainly.
 *   • EVERYTHING else still blocks, including `certification-summary-unsupported:<cell>`. That one
 *     looks adjacent and is categorically different: the manifest CLAIMED a runtime pass the receipts
 *     do not support. A release may ship with a cell uncertified; it may never ship with a manifest
 *     that lies about one.
 *
 * Every gate failure, stale or foreign receipt, dirty tree, missing model, absent global receipt and
 * acceptance contradiction therefore still blocks a release, unchanged.
 */
export function partitionBlockers(blockers) {
  const certificationOnly = [];
  const release = [];
  for (const blocker of blockers) {
    if (typeof blocker === 'string' && blocker.startsWith('client-cell-uncertified:')) {
      certificationOnly.push(blocker);
    } else {
      release.push(blocker);
    }
  }
  return { release, certificationOnly };
}

export function aggregateLaunchDecisions(cells, options = {}) {
  const loaded = options.policy
    ? { policy: options.policy, sha256: options.policySha256 }
    : loadLaunchPolicy(options.policyPath);
  const policy = loaded.policy;
  const policySha256 = options.policySha256 ?? loaded.sha256;
  const rows = [];
  const blockers = [];
  const seen = new Set();

  // Every cell is judged against ONE candidate. Which one is either supplied by the caller (a tag
  // build knows what it is publishing) or taken from the first manifest — after which any cell
  // disagreeing about the commit, the package or the policy is a mixed-candidate aggregate, not a
  // green one (A03: a one-cell green fixture used to produce aggregate GO).
  let candidate = options.candidate;

  for (const entry of cells ?? []) {
    const row = { cell: entry?.cell, decision: 'NO-GO', blockers: [] };
    if (seen.has(row.cell)) row.blockers.push(`duplicate-cell:${row.cell}`);
    seen.add(row.cell);

    if (!entry?.manifest) {
      row.blockers.push(`missing-evidence:${row.cell}`);
    } else {
      try {
        validateReleaseEvidence(entry.manifest);
      } catch (error) {
        row.blockers.push(`invalid-evidence:${row.cell}:${error.message}`);
      }
      if (row.blockers.length === 0) {
        // The caller pins what it KNOWS (a tag build knows its commit); the rest is discovered from
        // the first valid manifest and then enforced on every other cell. Leaving a field undefined
        // would publish an empty digest downstream, so the resolved candidate is always complete
        // before any cell is judged against it.
        candidate = {
          commit: candidate?.commit ?? entry.manifest.candidate?.commit,
          packageSha256: candidate?.packageSha256 ?? entry.manifest.candidate?.packageSha256,
        };
        const decision = evaluateLaunchDecision(entry.manifest, {
          policy,
          policySha256,
          candidate,
          // Candidate-scoped, and judged once below. Passing it into each cell would repeat the
          // same 21 findings into all six manifests, which reads as six problems instead of one.
          certificationReceipts: null,
          globalReceipts: null,
          // The directory the manifest's acceptance-receipt artifacts resolve against: the cell's
          // OWN directory when the caller knows it (the workflow layout gives every cell its own
          // receipts and logs), falling back to a single caller-declared root. Absent entirely
          // means the bytes cannot be located, which the validator names per receipt.
          receiptsEvidenceRoot: entry.evidenceRoot ?? options.receiptsEvidenceRoot,
        });
        row.decision = decision.decision;
        row.blockers = decision.blockers.map((blocker) => `${row.cell}:${blocker}`);
      }
    }
    rows.push(row);
    blockers.push(...row.blockers);
  }

  // The expected set is the POLICY's, not "whatever files happened to be downloaded". A workflow
  // that silently uploads five of six OS/Node manifests must not aggregate to GO.
  const expected = options.expectedCells ?? policyOsNodeCells(policy);
  for (const cell of expected) {
    if (!seen.has(cell)) {
      const row = { cell, decision: 'NO-GO', blockers: [`missing-evidence:${cell}`] };
      rows.push(row);
      blockers.push(...row.blockers);
    }
  }

  // A cell set that is empty by construction says nothing about certification; naming "no-evidence"
  // is the actionable finding, and expanding it into 21 cell names would bury it.
  if (rows.length === 0) {
    return {
      decision: 'NO-GO',
      blockers: ['no-evidence'],
      cells: rows,
      candidate: candidate ?? null,
    };
  }

  // ── the candidate-wide facts, judged ONCE ───────────────────────────────────
  //
  // These are not per-OS/Node-cell questions, so they are asked here rather than in each cell: is
  // this BUILD certified for all 21 advertised vendor-runtime cells, and did the policy's deep sweep
  // actually run against this package? Both read RAW receipts. A summary inside a manifest is not
  // consulted — a manifest cannot certify itself.
  const resolvedCandidate = candidate ?? null;
  if (options.certificationReceipts === undefined) {
    // Absent is not "not required": the policy advertises 21 cells, so a decision that never looked
    // at them says so by name rather than passing silently.
    for (const cell of policyClientCells(policy)) blockers.push(`client-cell-uncertified:${cell}`);
    blockers.push('certification-receipts-not-loaded');
  } else {
    blockers.push(
      ...uncertifiedClientCells(options.certificationReceipts, {
        policy,
        policySha256,
        candidate: resolvedCandidate ?? {},
      }),
    );
  }
  if (options.globalReceipts === undefined) {
    for (const type of policyGlobalReceiptTypes(policy)) {
      blockers.push(`global-receipt-missing:${type}`);
    }
    blockers.push('global-receipts-not-loaded');
  } else {
    blockers.push(
      ...judgeGlobalReceipts(options.globalReceipts, {
        policy,
        policySha256,
        candidate: resolvedCandidate ?? {},
        evidenceRoot: options.globalReceiptsRoot,
      }),
    );
  }

  const unique = [...new Set(blockers)];
  const cellsGo = rows.every((row) => row.decision === 'GO');
  const { release: releaseBlockers, certificationOnly } = partitionBlockers(unique);
  // A cell row's own NO-GO is a release blocker too: it carries gate/model/tree failures, not merely
  // an absent client receipt. Only the candidate-wide client-cell absences are set aside.
  const releasable = cellsGo && releaseBlockers.length === 0;

  return {
    // UNCHANGED MEANING: GO iff the candidate is fully certified across all advertised cells.
    decision: cellsGo && unique.length === 0 ? 'GO' : 'NO-GO',
    blockers: unique,
    cells: rows,
    // F17 — the release verdict, separate from certification. RELEASABLE means every gate, receipt,
    // model and tree check passed and the ONLY outstanding items are client cells with no receipt.
    // Such a release must publish the per-cell support table; `client-certification-matrix.mjs`
    // generates it, and it reads `not certified` for exactly the cells named below.
    release: releasable ? 'RELEASABLE' : 'BLOCKED',
    releaseBlockers,
    // The cells that are uncertified but do not block a release — the support table's content.
    uncertifiedCells: certificationOnly,
    // The digest a publication step is allowed to ship — on a GO, or on a RELEASABLE that ships the
    // support table stating what is not certified.
    candidate: resolvedCandidate,
    policySha256,
  };
}

/**
 * Collect the POLICY-DECLARED cell locations — and nothing else.
 *
 * The old discovery walked the --cells directory recursively and treated every *.json it met as a
 * cell manifest, so any receipt the workflow downloaded into that directory became a bogus OS/Node
 * cell: a green client certification receipt read as a seventh cell named after its file. Cell ids
 * are policy facts, not filesystem facts: for each declared `<os>/<node>` id exactly one manifest
 * is read, at `<cells>/<os>/<node>/manifest.json`, and every other file under the root is simply
 * never interpreted. A cell whose manifest is absent yields a `null` manifest, which the aggregate
 * reports as `missing-evidence:<cell>` — the same named refusal the re-run of a failed cell must
 * produce. Each entry also carries its own `evidenceRoot` (the cell directory), so the manifest's
 * typed-receipt artifacts resolve against the directory that actually contains them.
 */
function collectDeclaredCells(directory, extraCells, policy) {
  const declared = [...new Set([...policyOsNodeCells(policy), ...(extraCells ?? [])])];
  return declared.map((cell) => {
    const cellDir = join(directory, ...cell.split('/'));
    return { cell, manifestPath: join(cellDir, 'manifest.json'), evidenceRoot: cellDir };
  });
}

/** Expected cell ids come from repeatable --expect name[,name...] flags. */
function expectedCells(argv) {
  const expected = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--expect') continue;
    for (const name of (argv[++i] ?? '').split(',')) {
      if (name.trim()) expected.push(name.trim());
    }
  }
  return expected;
}

/**
 * `--certification-receipts <dir>` — the 21 raw vendor-runtime receipts, loaded and validated here
 * rather than summarized by a manifest.
 *
 * A load failure is REPORTED, not thrown: an unreadable or malformed receipt directory is a named
 * blocker alongside the cell names it leaves open, so a reader sees both the cause and its
 * consequence. Throwing would print one line and hide which cells the failure actually costs.
 */
function certificationReceiptsFromArgv(argv) {
  const index = argv.indexOf('--certification-receipts');
  if (index < 0) return undefined;
  const directory = resolve(argv[index + 1] ?? '.');
  const loaded = loadCertificationReceiptsOrReport(directory);
  return { receipts: loaded.receipts, blocker: loaded.blocker };
}

/** `--global-receipts <dir>` — candidate-wide receipts (the deep sweep), loaded as raw JSON. */
function globalReceiptsFromArgv(argv) {
  const index = argv.indexOf('--global-receipts');
  if (index < 0) return undefined;
  const directory = resolve(argv[index + 1] ?? '.');
  if (!existsSync(directory)) {
    return { receipts: [], blocker: `global-receipts-unreadable:${directory} does not exist` };
  }
  const receipts = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      receipts.push(JSON.parse(readFileSync(join(directory, name), 'utf8')));
    } catch (error) {
      return { receipts: [], blocker: `global-receipts-unreadable:${name}:${error.message}` };
    }
  }
  return { receipts, root: directory };
}

/** `--receipts-root <dir>` — the evidence root the typed receipts' artifacts resolve against. */
function receiptsRootFromArgv(argv) {
  const index = argv.indexOf('--receipts-root');
  if (index < 0) return undefined;
  return resolve(argv[index + 1] ?? '.');
}

/**
 * `--json-out <file>` — the aggregate as PURE JSON, in its own file.
 *
 * Stdout is for the operator: per-cell rows and blocker lines come BEFORE the aggregate JSON, so a
 * caller that scrapes stdout has to guess where the JSON starts — and a blocker line can itself
 * carry a brace (an unreadable receipt reports the JSON.parse failure, which quotes the offending
 * text), which makes "everything from the first `{`" a parser that works only until the first
 * corrupt file. This file is the machine contract: exactly the aggregate, byte for byte, with no
 * human output in front of it. Nothing is written on the --json-out-absent path — the stdout
 * aggregate stays exactly what it always was.
 */
function writeJsonOut(argv, aggregate) {
  const index = argv.indexOf('--json-out');
  if (index < 0) return;
  const path = resolve(argv[index + 1] ?? 'launch-decision.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(aggregate, null, 2)}\n`);
}

function mainCells(argv, cellsIndex) {
  const directory = resolve(argv[cellsIndex + 1] ?? '.');
  // --expect NARROWS nothing: the policy's cell set is always required. Explicit flags may only
  // ADD cells a caller knows about beyond the policy.
  const declared = expectedCells(argv);
  const policy = loadLaunchPolicy().policy;
  const found = collectDeclaredCells(directory, declared, policy);
  const cells = found.map((entry) => {
    let manifest;
    if (existsSync(entry.manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(entry.manifestPath, 'utf8'));
      } catch (error) {
        // Unreadable JSON fails structural validation below -> invalid-evidence:<cell>. The parse
        // failure itself is kept as the format a reader sees: a manifest that failed to PARSE is
        // residue from an interrupted pass, and `format: undefined` would hide that behind a
        // message that reads like a version problem.
        manifest = { format: `unreadable manifest JSON (${error.message})` };
      }
    }
    // A missing manifest stays `undefined`: the aggregate reports it as missing-evidence:<cell>
    // rather than validating an invented one.
    return {
      cell: entry.cell,
      ...(manifest !== undefined ? { manifest } : {}),
      evidenceRoot: entry.evidenceRoot,
    };
  });
  const certification = certificationReceiptsFromArgv(argv);
  const global = globalReceiptsFromArgv(argv);
  const aggregate = aggregateLaunchDecisions(cells, {
    ...(declared.length > 0
      ? {
          expectedCells: [...new Set([...policyOsNodeCells(policy), ...declared])],
        }
      : {}),
    ...(candidateFromArgv(argv) ? { candidate: candidateFromArgv(argv) } : {}),
    ...(certification ? { certificationReceipts: certification.receipts } : {}),
    ...(global ? { globalReceipts: global.receipts, globalReceiptsRoot: global.root } : {}),
    ...(receiptsRootFromArgv(argv) ? { receiptsEvidenceRoot: receiptsRootFromArgv(argv) } : {}),
  });
  for (const row of aggregate.cells) {
    process.stdout.write(`${row.cell}  ${row.decision}\n`);
    for (const blocker of row.blockers) process.stdout.write(`  - ${blocker}\n`);
  }
  for (const blocker of [certification?.blocker, global?.blocker].filter(Boolean)) {
    process.stdout.write(`  - ${blocker}\n`);
    aggregate.blockers.push(blocker);
    aggregate.decision = 'NO-GO';
    // A loader blocker is never a mere client-cell absence, so it downgrades the RELEASE verdict too.
    // Re-deriving both from the mutated list keeps the two verdicts from disagreeing after this loop.
    aggregate.releaseBlockers.push(blocker);
    aggregate.release = 'BLOCKED';
  }
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
  writeJsonOut(argv, aggregate);
  // Exit status still tracks CERTIFICATION, so every existing caller of this script keeps its
  // contract. F17's split is expressed in the payload (`release` / `releaseBlockers` /
  // `uncertifiedCells`), not by loosening the exit code — a release process that wants the weaker
  // verdict reads it explicitly, which is harder to do by accident than inheriting a 0.
  if (aggregate.decision !== 'GO') process.exitCode = 1;
  if (aggregate.decision !== 'GO' && aggregate.release === 'RELEASABLE') {
    process.stdout.write(
      `\nNOT CERTIFIED, but RELEASABLE: every gate, receipt, model and tree check passed and the only outstanding items are ${aggregate.uncertifiedCells.length} client cell(s) with no vendor receipt.\n` +
        'A release on this basis MUST publish the per-cell support table\n' +
        '(`node scripts/client-certification-matrix.mjs --receipts <dir> --stdout`), which reads\n' +
        '"not certified" for exactly those cells. Certification itself is unchanged and still NO-GO.\n',
    );
  }
}

/** `--candidate-commit <sha> --candidate-package sha256:<hex>` — what a tag build is publishing. */
function candidateFromArgv(argv) {
  const commitIdx = argv.indexOf('--candidate-commit');
  const packageIdx = argv.indexOf('--candidate-package');
  if (commitIdx < 0 && packageIdx < 0) return undefined;
  return {
    ...(commitIdx >= 0 ? { commit: argv[commitIdx + 1] } : {}),
    ...(packageIdx >= 0 ? { packageSha256: argv[packageIdx + 1] } : {}),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const cellsIndex = argv.indexOf('--cells');
  if (cellsIndex >= 0) {
    mainCells(argv, cellsIndex);
    return;
  }
  const index = argv.indexOf('--evidence');
  const path = resolve(
    index >= 0 ? (argv[index + 1] ?? 'release-evidence.json') : 'release-evidence.json',
  );
  try {
    const evidence = loadReleaseEvidence(path);
    const certification = certificationReceiptsFromArgv(argv);
    const global = globalReceiptsFromArgv(argv);
    const decision = evaluateLaunchDecision(evidence, {
      ...(candidateFromArgv(argv) ? { candidate: candidateFromArgv(argv) } : {}),
      ...(certification ? { certificationReceipts: certification.receipts } : {}),
      ...(global ? { globalReceipts: global.receipts, globalReceiptsRoot: global.root } : {}),
      ...(receiptsRootFromArgv(argv) ? { receiptsEvidenceRoot: receiptsRootFromArgv(argv) } : {}),
    });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    writeJsonOut(argv, decision);
    if (decision.decision !== 'GO') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
